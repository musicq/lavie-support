-- Who may read statements, and how much each person has spent.

-- One-time values the app signs, so a recorded request can't be replayed.
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  expires INTEGER NOT NULL
);

-- App Attest keys: one per install of the genuine app.
CREATE TABLE IF NOT EXISTS app_keys (
  key_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL,
  environment TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

-- People who read statements. id is "tx:<originalTransactionId>" for Lavie Plus (the same on
-- every device with that Apple ID), "key:<App Attest key>" for a free try, "ip:<daily hash>" otherwise.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tier TEXT NOT NULL,
  product TEXT,
  environment TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  imports INTEGER NOT NULL DEFAULT 0,
  chunks INTEGER NOT NULL DEFAULT 0,
  cost_micro INTEGER NOT NULL DEFAULT 0
);

-- AI cost per person per day, in millionths of a dollar.
CREATE TABLE IF NOT EXISTS usage_daily (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  cost_micro INTEGER NOT NULL DEFAULT 0,
  chunks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- One import: what was checked, who it is, and what it may still spend.
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  expires INTEGER NOT NULL,
  budget_micro INTEGER NOT NULL,
  spent_micro INTEGER NOT NULL DEFAULT 0,
  chunks INTEGER NOT NULL DEFAULT 0,
  device_token TEXT,
  sandbox INTEGER NOT NULL DEFAULT 0,
  trial_marked INTEGER NOT NULL DEFAULT 0,
  checks TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires);
