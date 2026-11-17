-- Public incident history for status.klausum.study. Written by the 15-minute self-check
-- when a user-facing problem starts and when it clears. Titles are public-friendly.
CREATE TABLE incidents (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL,               -- internal alert key (e.g. streak:resend)
  component   TEXT NOT NULL,               -- api | email | authenticator
  title       TEXT NOT NULL,               -- what the public sees
  started_at  INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX idx_incidents_started ON incidents(started_at);
CREATE INDEX idx_incidents_open ON incidents(key) WHERE resolved_at IS NULL;
