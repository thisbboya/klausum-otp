-- When each secret was last set, for the "older than 180 days" reminder.
-- Values: unix seconds. Updated with `npm run admin -- secret:rotated <NAME>` after a rotation.
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('secret:ADMIN_TOKEN',        '1794888000', strftime('%s','now')),  -- 2026-11-17
  ('secret:OTP_PEPPER',         '1794888000', strftime('%s','now')),
  ('secret:TOTP_KEY',           '1794888000', strftime('%s','now')),
  ('secret:RESEND_API_KEY',     '1794888000', strftime('%s','now')),
  ('secret:AHASEND_API_KEY',    '1794888000', strftime('%s','now')),
  ('secret:TELEGRAM_BOT_TOKEN', '1794888000', strftime('%s','now')),
  ('secret:CLOUDFLARE_API_TOKEN (GitHub)', '1794888000', strftime('%s','now')),
  ('secret:BACKUP_PASSPHRASE (GitHub)',    '1794888000', strftime('%s','now'));
