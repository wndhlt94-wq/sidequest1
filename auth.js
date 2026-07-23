// auth.js — Passwort-Hashing (scrypt, eingebaut in Node) und einfache Bearer-Token-Sessions.
const crypto = require("node:crypto");
const { db } = require("./db");

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expectedHash));
}

function createSession(userId) {
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare(
    "INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)"
  ).run(token, userId, new Date().toISOString());
  return token;
}

function getUserByToken(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT users.* FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.token = ?`
    )
    .get(token);
  return row || null;
}

module.exports = { hashPassword, verifyPassword, createSession, getUserByToken };
