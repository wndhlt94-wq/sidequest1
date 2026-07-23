// server.js — ErledigeDas Backend.
// Reines Node.js (http-Modul), kein Express nötig — läuft ohne "npm install".
// Start: node server.js   (Standardport 3001, override mit PORT=xxxx)

const http = require("node:http");
const crypto = require("node:crypto");
const { db } = require("./db");
const { hashPassword, verifyPassword, createSession, getUserByToken } = require("./auth");
const { userStats, payoutRate } = require("./scoring");

const PORT = process.env.PORT || 3001;
const PLATFORM_FEE_RATE = 0.05;

const PAYOUT_METHODS = ["paypal", "stripe", "kreditkarte", "klarna", "amazon", "steam"];

// ---------- Hilfsfunktionen ----------

function jsonResponse(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 8 * 1024 * 1024) {
        reject(new Error("Payload zu groß (max 8 MB, z.B. für Fotos)"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error("Ungültiges JSON"));
      }
    });
    req.on("error", reject);
  });
}

function fuzzedCoords(lat, lng) {
  const radiusMeters = 500;
  const angle = Math.random() * 2 * Math.PI;
  const r = Math.random() * radiusMeters;
  const dLat = (r * Math.cos(angle)) / 111320;
  const dLng = (r * Math.sin(angle)) / (111320 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dLat, lng: lng + dLng };
}

function generatePayoutCode(method) {
  const rnd = () => crypto.randomBytes(2).toString("hex").toUpperCase();
  const prefixes = {
    paypal: "PP",
    stripe: "STRIPE-PAYOUT",
    kreditkarte: "KK-GUTSCHRIFT",
    klarna: "KLARNA",
    amazon: "AMZN",
    steam: "STEAM",
  };
  const prefix = prefixes[method] || "CODE";
  return `${prefix}-${rnd()}-${rnd()}`;
}

function checkExpiredJobs() {
  const nowIso = new Date().toISOString();
  db.prepare(
    `UPDATE jobs SET status = 'abgelaufen'
     WHERE status = 'angenommen' AND deadline_at IS NOT NULL AND deadline_at < ?`
  ).run(nowIso);
}

function userPublicView(userId) {
  const user = db.prepare("SELECT id, name FROM users WHERE id = ?").get(userId);
  if (!user) return null;
  return { id: user.id, name: user.name, ...userStats(user.id) };
}

// Ein Job wird abhängig vom anfragenden Nutzer serialisiert: Genaue Adresse und
// exakte Koordinaten sind nur für Auftraggeber, annehmende Person, oder nach
// Abschluss/Ablauf sichtbar — sonst nur der ungefähre 500m-Fuzz-Punkt.
function serializeJob(job, viewerId) {
  const poster = db.prepare("SELECT id, name FROM users WHERE id = ?").get(job.poster_id);
  const accepter = job.accepted_by_id
    ? db.prepare("SELECT id, name FROM users WHERE id = ?").get(job.accepted_by_id)
    : null;

  const isPoster = viewerId === job.poster_id;
  const isAccepter = viewerId === job.accepted_by_id;
  const canSeeExact = job.status !== "offen" || isPoster || isAccepter;

  return {
    id: job.id,
    title: job.title,
    description: job.description,
    city: job.city,
    address: canSeeExact ? job.address : null,
    lat: canSeeExact ? job.lat : job.fuzzy_lat,
    lng: canSeeExact ? job.lng : job.fuzzy_lng,
    approxOnly: !canSeeExact,
    reward: job.reward,
    platformFee: job.platform_fee,
    totalCharged: Math.round((job.reward + job.platform_fee) * 100) / 100,
    payoutMethod: job.payout_method,
    deadlineHours: job.deadline_hours,
    status: job.status,
    poster: poster ? { id: poster.id, name: poster.name } : null,
    acceptedBy: accepter ? { id: accepter.id, name: accepter.name } : null,
    acceptedAt: job.accepted_at,
    deadlineAt: job.deadline_at,
    hasProofPhoto: !!job.proof_photo,
    voucherCode: job.voucher_code,
    payoutRate: job.payout_rate,
    netPayout: job.net_payout,
    createdAt: job.created_at,
  };
}

// ---------- Routen ----------

async function handleRegister(req, res) {
  const body = await readJsonBody(req);
  const name = (body.name || "").trim();
  const password = body.password || "";
  if (!name || password.length < 6) {
    return jsonResponse(res, 400, { error: "Name erforderlich, Passwort mindestens 6 Zeichen" });
  }
  const existing = db.prepare("SELECT id FROM users WHERE name = ?").get(name);
  if (existing) return jsonResponse(res, 409, { error: "Name bereits vergeben" });

  const { hash, salt } = hashPassword(password);
  const info = db
    .prepare(
      "INSERT INTO users (name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?)"
    )
    .run(name, hash, salt, new Date().toISOString());
  const token = createSession(info.lastInsertRowid);
  jsonResponse(res, 201, { token, user: userPublicView(info.lastInsertRowid) });
}

async function handleLogin(req, res) {
  const body = await readJsonBody(req);
  const name = (body.name || "").trim();
  const password = body.password || "";
  const user = db.prepare("SELECT * FROM users WHERE name = ?").get(name);
  if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
    return jsonResponse(res, 401, { error: "Name oder Passwort falsch" });
  }
  const token = createSession(user.id);
  jsonResponse(res, 200, { token, user: userPublicView(user.id) });
}

function handleMe(req, res, user) {
  jsonResponse(res, 200, { user: userPublicView(user.id) });
}

function handleListJobs(req, res, user, query) {
  checkExpiredJobs();
  let rows;
  if (query.get("status")) {
    rows = db.prepare("SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC").all(query.get("status"));
  } else {
    rows = db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all();
  }
  const viewerId = user ? user.id : null;
  jsonResponse(res, 200, { jobs: rows.map((j) => serializeJob(j, viewerId)) });
}

async function handleCreateJob(req, res, user) {
  const body = await readJsonBody(req);
  const { title, description, address, city, lat, lng, reward, payoutMethod, deadlineHours } = body;

  if (!title || !address || typeof lat !== "number" || typeof lng !== "number") {
    return jsonResponse(res, 400, { error: "title, address, lat und lng sind erforderlich" });
  }
  if (!(reward > 0)) return jsonResponse(res, 400, { error: "reward muss größer als 0 sein" });
  if (!PAYOUT_METHODS.includes(payoutMethod)) {
    return jsonResponse(res, 400, { error: `payoutMethod muss einer von: ${PAYOUT_METHODS.join(", ")}` });
  }
  const hours = deadlineHours > 0 ? deadlineHours : 2;
  const fee = Math.round(reward * PLATFORM_FEE_RATE * 100) / 100;
  const fuzzy = fuzzedCoords(lat, lng);

  const info = db
    .prepare(
      `INSERT INTO jobs
        (title, description, address, city, lat, lng, fuzzy_lat, fuzzy_lng, reward, platform_fee,
         payout_method, deadline_hours, status, poster_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offen', ?, ?)`
    )
    .run(
      title,
      description || "",
      address,
      city || "",
      lat,
      lng,
      fuzzy.lat,
      fuzzy.lng,
      reward,
      fee,
      payoutMethod,
      hours,
      user.id,
      new Date().toISOString()
    );

  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(info.lastInsertRowid);
  jsonResponse(res, 201, { job: serializeJob(job, user.id) });
}

function handleAcceptJob(req, res, user, jobId) {
  checkExpiredJobs();
  const now = new Date();
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  if (!job) return jsonResponse(res, 404, { error: "Job nicht gefunden" });
  if (job.poster_id === user.id) {
    return jsonResponse(res, 400, { error: "Eigene Jobs können nicht selbst angenommen werden" });
  }

  const deadlineAt = new Date(now.getTime() + job.deadline_hours * 3600 * 1000).toISOString();

  // Atomarer Update mit WHERE status='offen' garantiert Exklusivität:
  // gewinnt nur, wer als Erste:r bei status='offen' zugreift.
  const result = db
    .prepare(
      `UPDATE jobs SET status = 'angenommen', accepted_by_id = ?, accepted_at = ?, deadline_at = ?
       WHERE id = ? AND status = 'offen'`
    )
    .run(user.id, now.toISOString(), deadlineAt, jobId);

  if (result.changes === 0) {
    return jsonResponse(res, 409, { error: "Job wurde bereits angenommen oder ist nicht mehr offen" });
  }
  const updated = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  jsonResponse(res, 200, { job: serializeJob(updated, user.id) });
}

async function handleCompleteJob(req, res, user, jobId) {
  const body = await readJsonBody(req);
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  if (!job) return jsonResponse(res, 404, { error: "Job nicht gefunden" });
  if (job.status !== "angenommen") {
    return jsonResponse(res, 400, { error: "Job ist nicht im Status 'angenommen'" });
  }
  if (job.accepted_by_id !== user.id) {
    return jsonResponse(res, 403, { error: "Nur die annehmende Person kann den Job abschließen" });
  }
  if (!body.photoBase64) {
    return jsonResponse(res, 400, { error: "Fotobeweis (photoBase64) ist erforderlich" });
  }

  const rate = payoutRate(user.id);
  const netPayout = Math.round(job.reward * rate * 100) / 100;
  const voucher = generatePayoutCode(job.payout_method);

  db.prepare(
    `UPDATE jobs SET status = 'erledigt', proof_photo = ?, voucher_code = ?, payout_rate = ?, net_payout = ?
     WHERE id = ?`
  ).run(body.photoBase64, voucher, rate, netPayout, jobId);

  const updated = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  jsonResponse(res, 200, { job: serializeJob(updated, user.id) });
}

function handleReopenJob(req, res, user, jobId) {
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  if (!job) return jsonResponse(res, 404, { error: "Job nicht gefunden" });
  if (job.poster_id !== user.id) {
    return jsonResponse(res, 403, { error: "Nur der Auftraggeber kann den Job erneut freigeben" });
  }
  if (job.status !== "abgelaufen") {
    return jsonResponse(res, 400, { error: "Nur abgelaufene Jobs können erneut freigegeben werden" });
  }
  db.prepare(
    `UPDATE jobs SET status = 'offen', accepted_by_id = NULL, accepted_at = NULL, deadline_at = NULL
     WHERE id = ?`
  ).run(jobId);
  const updated = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  jsonResponse(res, 200, { job: serializeJob(updated, user.id) });
}

function handleLeaderboardCompleted(req, res) {
  const rows = db
    .prepare(
      `SELECT users.id, users.name, COUNT(*) AS completed
       FROM jobs JOIN users ON users.id = jobs.accepted_by_id
       WHERE jobs.status = 'erledigt'
       GROUP BY users.id ORDER BY completed DESC`
    )
    .all();
  jsonResponse(res, 200, {
    leaderboard: rows.map((r) => ({ ...r, tierBadge: require("./scoring").tierBadge(r.completed) })),
  });
}

function handleLeaderboardPosters(req, res) {
  const rows = db
    .prepare(
      `SELECT users.id, users.name, COUNT(*) AS posted
       FROM jobs JOIN users ON users.id = jobs.poster_id
       GROUP BY users.id ORDER BY posted DESC`
    )
    .all();
  jsonResponse(res, 200, {
    leaderboard: rows.map((r) => ({ ...r, tierBadge: require("./scoring").tierBadge(r.posted) })),
  });
}

function handleGetPhoto(req, res, jobId) {
  const job = db.prepare("SELECT proof_photo FROM jobs WHERE id = ?").get(jobId);
  if (!job || !job.proof_photo) return jsonResponse(res, 404, { error: "Kein Foto vorhanden" });
  jsonResponse(res, 200, { photoBase64: job.proof_photo });
}

function handleGetUserStats(req, res, userId) {
  const info = userPublicView(userId);
  if (!info) return jsonResponse(res, 404, { error: "Nutzer nicht gefunden" });
  jsonResponse(res, 200, { user: info });
}

// ---------- Router ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean); // z.B. ["api","jobs","3","accept"]

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    return res.end();
  }

  try {
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const user = getUserByToken(token);

    // öffentliche Routen
    if (req.method === "POST" && url.pathname === "/api/register") return await handleRegister(req, res);
    if (req.method === "POST" && url.pathname === "/api/login") return await handleLogin(req, res);
    if (req.method === "GET" && url.pathname === "/api/jobs") return handleListJobs(req, res, user, url.searchParams);
    if (req.method === "GET" && url.pathname === "/api/leaderboard/completed") return handleLeaderboardCompleted(req, res);
    if (req.method === "GET" && url.pathname === "/api/leaderboard/posters") return handleLeaderboardPosters(req, res);
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "jobs" && parts[3] === "photo") {
      return handleGetPhoto(req, res, Number(parts[2]));
    }
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "users" && parts.length === 3) {
      return handleGetUserStats(req, res, Number(parts[2]));
    }

    // ab hier: Login erforderlich
    if (!user) return jsonResponse(res, 401, { error: "Nicht angemeldet (Authorization: Bearer <token> fehlt oder ungültig)" });

    if (req.method === "GET" && url.pathname === "/api/me") return handleMe(req, res, user);
    if (req.method === "POST" && url.pathname === "/api/jobs") return await handleCreateJob(req, res, user);
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "jobs" && parts[3] === "accept") {
      return handleAcceptJob(req, res, user, Number(parts[2]));
    }
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "jobs" && parts[3] === "complete") {
      return await handleCompleteJob(req, res, user, Number(parts[2]));
    }
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "jobs" && parts[3] === "reopen") {
      return handleReopenJob(req, res, user, Number(parts[2]));
    }

    jsonResponse(res, 404, { error: "Route nicht gefunden" });
  } catch (err) {
    jsonResponse(res, 500, { error: err.message || "Interner Serverfehler" });
  }
});

server.listen(PORT, () => {
  console.log(`ErledigeDas-Backend läuft auf http://localhost:${PORT}`);
});
