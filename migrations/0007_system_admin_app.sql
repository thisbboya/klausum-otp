-- Internal app that owns the control-room login codes and the owner's authenticator.
-- It has no API keys, so nobody can call the public API as this app.
INSERT OR IGNORE INTO apps (id, name, display_name, api_key_hash, api_key_prefix, allowed_origins, daily_cap, otp_ttl_seconds, status, created_at)
VALUES ('app_system_admin', 'system-admin', 'Klausum OTP admin', 'unused:system', 'none', '[]', 50, 300, 'active', strftime('%s','now'));
