// db.js — SQLite-Datenschicht. Nutzt Node's eingebautes node:sqlite-Modul,
// damit keine externen npm-Pakete installiert werden müssen.
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "erledigedas.db");
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    address TEXT NOT NULL,
    city TEXT,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    fuzzy_lat REAL NOT NULL,
    fuzzy_lng REAL NOT NULL,
    reward REAL NOT NULL,
    platform_fee REAL NOT NULL,
    payout_method TEXT NOT NULL,
    deadline_hours REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'offen',
    poster_id INTEGER NOT NULL,
    accepted_by_id INTEGER,
    accepted_at TEXT,
    deadline_at TEXT,
    proof_photo TEXT,
    voucher_code TEXT,
    payout_rate REAL,
    net_payout REAL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (poster_id) REFERENCES users(id),
    FOREIGN KEY (accepted_by_id) REFERENCES users(id)
  );
`);

module.exports = { db };
