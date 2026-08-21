-- RANNZ UNLOCK — initial schema
-- Run with: wrangler d1 execute rannz-unlock-db --local --file=./migrations/001_init.sql

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,          -- session token hash (sha-256 hex)
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS download_history (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  file_name  TEXT,
  file_type  TEXT,
  file_size  INTEGER,
  status     TEXT NOT NULL,             -- 'success' | 'failed'
  reason     TEXT,                      -- failure reason, if any
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_history_user_id ON download_history (user_id);
CREATE INDEX IF NOT EXISTS idx_history_created_at ON download_history (created_at);

-- Simple sliding-window rate limiter backed by D1.
-- Not as fast as Durable Objects/KV, but requires no extra bindings.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key TEXT NOT NULL,             -- e.g. "auth:1.2.3.4" or "resolve:1.2.3.4"
  window_start INTEGER NOT NULL,        -- unix seconds, floored to the window
  request_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (bucket_key, window_start)
);
