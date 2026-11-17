-- A TOTP enrolment is "pending" until the user proves they scanned it with one good code.
ALTER TABLE totp_secrets ADD COLUMN confirmed_at INTEGER;
