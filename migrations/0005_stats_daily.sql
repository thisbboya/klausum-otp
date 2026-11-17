-- Small per-day counters for the dashboard and quota meters. otp_requests rows are
-- deleted after 24 h, so monthly numbers (Resend 3,000/month, AhaSend 1,000/month,
-- textbee 300/month) need their own lasting tally. One row per (day, key).
CREATE TABLE stats_daily (
  day    TEXT NOT NULL,              -- YYYY-MM-DD (UTC)
  key    TEXT NOT NULL,              -- e.g. send:email, provider:resend:sent, verify:ok
  count  INTEGER NOT NULL DEFAULT 0,
  sum_ms INTEGER NOT NULL DEFAULT 0, -- total latency, for averages
  PRIMARY KEY (day, key)
);
