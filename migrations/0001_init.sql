-- Klausum OTP initial schema. Times are unix seconds (INTEGER).
CREATE TABLE apps (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  api_key_hash     TEXT NOT NULL UNIQUE,
  api_key_prefix   TEXT NOT NULL,
  allowed_origins  TEXT NOT NULL DEFAULT '[]',
  daily_cap        INTEGER NOT NULL DEFAULT 300,
  otp_ttl_seconds  INTEGER NOT NULL DEFAULT 300 CHECK (otp_ttl_seconds BETWEEN 60 AND 600),
  sms_app_hash     TEXT,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  key_last_used_at INTEGER,
  created_at       INTEGER NOT NULL
);

CREATE TABLE otp_requests (
  id             TEXT PRIMARY KEY,
  app_id         TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  recipient_hash TEXT NOT NULL,
  channel        TEXT NOT NULL CHECK (channel IN ('email','sms')),
  code_hash      TEXT NOT NULL,
  expires_at     INTEGER NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  used_at        INTEGER,
  status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','failed','invalidated')),
  provider       TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_otp_recipient ON otp_requests(app_id, recipient_hash, created_at);
CREATE INDEX idx_otp_expires   ON otp_requests(expires_at);

CREATE TABLE rate_counters (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

CREATE TABLE totp_secrets (
  app_id           TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_ref         TEXT NOT NULL,
  secret_encrypted TEXT NOT NULL,
  last_used_step   INTEGER,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (app_id, user_ref)
);

CREATE TABLE delivery_logs (
  id             TEXT PRIMARY KEY,
  otp_request_id TEXT NOT NULL,
  provider       TEXT NOT NULL,
  status         TEXT NOT NULL,
  error          TEXT,
  latency_ms     INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_logs_request ON delivery_logs(otp_request_id);
CREATE INDEX idx_logs_created ON delivery_logs(created_at);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
