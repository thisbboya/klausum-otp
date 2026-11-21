-- Free phone-number checks through Telegram (shared contact) and WhatsApp (user sends us a code).
-- No SMS is sent. Rows are deleted a day after they are made.
CREATE TABLE phone_checks (
  id          TEXT PRIMARY KEY,               -- pc_…
  app_id      TEXT NOT NULL REFERENCES apps(id),
  method      TEXT NOT NULL CHECK (method IN ('telegram','whatsapp')),
  secret_hash TEXT NOT NULL,                  -- sha256 of the Telegram start token / WhatsApp code
  chat_id     TEXT,                           -- Telegram chat that opened the link
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified')),
  phone       TEXT,                           -- E.164, only once verified
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  verified_at INTEGER
);
CREATE UNIQUE INDEX phone_checks_secret ON phone_checks (method, secret_hash);
CREATE INDEX phone_checks_chat ON phone_checks (chat_id);
CREATE INDEX phone_checks_created ON phone_checks (created_at);
