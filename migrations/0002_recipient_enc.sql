-- The recipient is needed to deliver (in the background) and to resend, but we never
-- store it in plain text: AES-GCM encrypted with a key derived from OTP_PEPPER.
-- Wiped by the cleanup cron 24 h after creation.
ALTER TABLE otp_requests ADD COLUMN recipient_enc TEXT;
ALTER TABLE otp_requests ADD COLUMN purpose TEXT NOT NULL DEFAULT 'login';
