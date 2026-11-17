-- Several keys per app, so a key can be rotated with a 24 h overlap and revoked instantly.
CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,                 -- key_xxxxxxxx
  app_id       TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  key_hash     TEXT NOT NULL UNIQUE,             -- SHA-256 hex of the full key
  prefix       TEXT NOT NULL,                    -- first 14 chars, for display
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,                          -- set on rotation: old key dies 24 h later
  revoked_at   INTEGER,
  last_used_at INTEGER
);
CREATE INDEX idx_keys_app ON api_keys(app_id);

-- Existing keys move over (apps.api_key_hash is no longer read).
INSERT INTO api_keys (id, app_id, key_hash, prefix, created_at, last_used_at)
  SELECT 'key_' || substr(id, 5), id, api_key_hash, api_key_prefix, created_at, key_last_used_at FROM apps;

-- Abuse blocklist. Phones, emails and IPs are stored as HMAC hashes (privacy); domains in clear.
CREATE TABLE blocklist (
  kind       TEXT NOT NULL CHECK (kind IN ('phone','email','domain','ip')),
  value      TEXT NOT NULL,                      -- hash for phone/email/ip, lower-case domain
  label      TEXT NOT NULL,                      -- masked form for display (+23324****567, s***@gmail.com)
  note       TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, value)
);

-- Logs outlive otp_requests (30 days vs 24 h), so they carry their own app and channel.
ALTER TABLE delivery_logs ADD COLUMN app_id TEXT;
ALTER TABLE delivery_logs ADD COLUMN channel TEXT;
UPDATE delivery_logs SET app_id = (SELECT app_id FROM otp_requests r WHERE r.id = otp_request_id),
                         channel = (SELECT channel FROM otp_requests r WHERE r.id = otp_request_id);
CREATE INDEX idx_logs_app ON delivery_logs(app_id, created_at);
