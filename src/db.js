import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  display_phone TEXT,
  phone_number_id TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS logins (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  branch_id TEXT REFERENCES branches(id),   -- NULL = Admin (alle Filialen)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  akuwin_id TEXT UNIQUE,
  branch_id TEXT REFERENCES branches(id),
  salutation TEXT,
  first_name TEXT,
  last_name TEXT,
  birthday TEXT,                -- YYYY-MM-DD
  mobile_raw TEXT,
  mobile_e164 TEXT,             -- nur Ziffern, z.B. 491711234567 (= WhatsApp wa_id)
  inactive INTEGER NOT NULL DEFAULT 0,
  opt_in INTEGER NOT NULL DEFAULT 0,
  opt_in_source TEXT,
  opt_in_at TEXT,
  opted_out_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customers_mobile ON customers(mobile_e164);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY,
  akuwin_id TEXT UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  side TEXT,
  manufacturer TEXT,
  model TEXT,
  serial TEXT,
  fitted_at TEXT                -- YYYY-MM-DD
);
CREATE INDEX IF NOT EXISTS idx_devices_customer ON devices(customer_id);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  wa_id TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  profile_name TEXT,
  status TEXT NOT NULL DEFAULT 'open',      -- open | done
  unread INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  last_inbound_at TEXT,
  last_preview TEXT,
  UNIQUE(branch_id, wa_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,                  -- in | out
  type TEXT NOT NULL,                       -- text | template | image | audio | ...
  body TEXT,
  media_id TEXT,
  template_name TEXT,
  wa_message_id TEXT UNIQUE,
  status TEXT,                              -- received | sent | delivered | read | failed | dry_run
  error TEXT,
  sent_by TEXT,                             -- Kürzel Mitarbeiter oder 'automation:<regel>'
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS automation_runs (
  id INTEGER PRIMARY KEY,
  rule_id TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  ref_key TEXT NOT NULL,                    -- z.B. Jahr beim Geburtstag, Anpassdatum bei Geräten
  message_id INTEGER REFERENCES messages(id),
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(rule_id, customer_id, ref_key)
);

CREATE TABLE IF NOT EXISTS import_log (
  id INTEGER PRIMARY KEY,
  source TEXT,
  customers INTEGER,
  devices INTEGER,
  skipped INTEGER,
  warnings TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  return db;
}

export function syncBranches(db, branchesConfig) {
  const upsert = db.prepare(`INSERT INTO branches (id, name, display_phone, phone_number_id)
    VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,
    display_phone=excluded.display_phone, phone_number_id=excluded.phone_number_id`);
  for (const b of branchesConfig.branches) {
    upsert.run(b.id, b.name, b.displayPhone || null, b.phoneNumberId || null);
  }
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
