# Klausum OTP — security checklist

Checked against the [OWASP Multifactor Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)
and the project's own rules (master prompt §2). Last reviewed: 2026-11-17.
Every ✅ row names the test that proves it (`npm test`).

## One-time codes (email / SMS)

| # | Rule | Status | How / where | Test |
|---|------|--------|-------------|------|
| 1 | 6-digit codes from a CSPRNG, no modulo bias, never `Math.random` | ✅ | `generateCode()` → `randomIndex(10)` rejection sampling over `crypto.getRandomValues` (`src/otp.ts`, `src/crypto.ts`) | `otp.test.ts › codes are 6 digits with uniform digits`, `source never uses Math.random`, `crypto.test.ts › no modulo bias` |
| 2 | Never store the code | ✅ | Stored as `HMAC-SHA256(OTP_PEPPER, "code:" + app_id + ":" + request_id + ":" + code)`. **Change from the original spec**: bound to `request_id` (which belongs to one recipient) instead of the raw recipient — this lets `/verify` run in one DB round trip and makes a code valid only for the exact request it was issued for. | `otp.test.ts › never stores the code` |
| 3 | Expire after 5 min (per-app, max 10) | ✅ | `apps.otp_ttl_seconds` CHECK 60–600 | `otp.test.ts › expired codes are refused`, `admin.test.ts › bad TTL` |
| 4 | Single use | ✅ | `UPDATE … SET used_at … WHERE used_at IS NULL … RETURNING` inside one transaction | `single use`, `two simultaneous verifies: exactly one succeeds` |
| 5 | Max 5 wrong attempts, then dead | ✅ | `attempts < 5` guard on both the success and the failure update | `allows 5 wrong attempts, then the code is dead` |
| 6 | Constant-time comparison | ✅ | `timingSafeEqual()` (XOR every byte, no early return) for the admin token and TOTP codes. OTP hashes are compared by SQL `=`: both sides are HMAC outputs the caller cannot steer byte-by-byte, so equality timing leaks nothing useful. | `crypto.test.ts › timingSafeEqual` |
| 7 | New code invalidates the old one | ✅ | Same batch as the insert | `a new code invalidates the old one`, `resend issues a fresh code and kills the old one` |
| 8 | Rate limits: recipient 1/30 s, 3/10 min, 10/day · IP 20/h · app daily cap · verify 10/10 min | ✅ | D1 window counters; each window starts at its first hit (no boundary double-sends). Rate-limited sends write nothing and don't kill the live code. | `rate limits › …` (6 tests) |
| 9 | Normalise recipients (email lower/trim, phone E.164, Ghana default) | ✅ | `normaliseEmail`, `normalisePhone` | `normalises phones`, `normalises emails` |
| 10 | Recipients hashed in storage, masked in logs | ✅ | `recipient_hash` = HMAC; delivery copy is AES-GCM encrypted and wiped on use / after expiry; logs use `mask()` | `masks recipients`, `never stores … the recipient` |
| 11 | API keys `kotp_live_` + 32 chars, SHA-256 stored, shown once | ✅ | `admin.ts` | `admin.test.ts › stores only its SHA-256 hash` |
| 12 | Verify reveals only `invalid_code` / `expired` / `too_many_attempts` | ✅ | Unknown id, other app's id, used and replaced codes all give `invalid_code` | `another app cannot verify …; unknown ids look the same` |
| 13 | CORS: only listed origins | ✅ | Preflight + per-request origin check (`src/auth.ts`) | `CORS › …` |
| 14 | zod validation, `.strict()`, 400 on anything unexpected | ✅ | every route | `401 without a valid key, 400 on bad input`, `validates input` |
| 15 | Security headers, no stack traces | ✅ | `nosniff`, `DENY`, `no-referrer`, HSTS, CSP `default-src 'none'`, `no-store`; `onError` returns `internal_error` only | `health.test.ts` |
| — | OWASP: never log code values | ✅ | The "console" provider only runs in tests (`DELIVERY_MODE` is not set in production) | `email.test.ts › never sends codes to logs in production mode` |
| — | OWASP: SMS is a weaker factor | ⚠️ accepted | SMS is offered for farmers without email/smartphone apps. Prefer email or TOTP where possible. | — |
| — | OWASP: consider 8+ digit codes | ⚠️ accepted | 6 digits + 5 attempts + 5 min expiry + rate limits → ≤ 5 guesses per code (1 in 200 000). | — |

## Authenticator codes (TOTP)

| Rule | Status | How | Test |
|------|--------|-----|------|
| RFC 6238 / 4226 correct | ✅ | HMAC-SHA1, 30 s, 6 digits | RFC test vectors |
| ±1 step drift only | ✅ | `WINDOW = 1` | `accepts ±1 step of drift, rejects ±2` |
| Replay blocked (same or older step) | ✅ | atomic `last_used_step < ?` update | `blocks replay`, `older step is refused` |
| Secrets encrypted at rest | ✅ | AES-GCM, key from `TOTP_KEY` via HKDF; AAD = `app_id:user_ref` so ciphertext can't be moved to another user | `secret is stored encrypted` |
| Confirmed enrolment can't be silently replaced | ✅ | 409 `already_enrolled` | `a confirmed enrolment cannot be replaced` |
| Verify rate limit 10 / 10 min per user | ✅ | | `rate-limits verify` |

## Admin API

| Rule | Status | How | Test |
|------|--------|-----|------|
| Token compared in constant time | ✅ | `timingSafeEqual` | `rejects a wrong or missing admin token` |
| Brute-force guard | ✅ | 10 failures per IP per hour → locked for the rest of the hour (even with the right token) | `admin brute-force guard` |

## Secrets

| Secret | Where | Never in git |
|--------|-------|--------------|
| `OTP_PEPPER`, `TOTP_KEY`, `ADMIN_TOKEN`, `RESEND_API_KEY`, `AHASEND_API_KEY`, `TEXTBEE_API_KEY` | `wrangler secret` (Cloudflare) + local copy in `.secrets.local` (git-ignored) | `git log -p` scanned after every phase: no matches |

## Test keys

`kotp_test_…` keys run the full flow (validation, hashing, rate limits, DB) but **never deliver** anything,
and skip only the per-IP limit. Used for development and benchmarks. Test: `test keys (kotp_test_) …`.

## Known gaps / to do

- **Admin dashboard login** (email OTP + TOTP, HttpOnly session) — Phase 11.
- **Key rotation with 24 h overlap**, **blocklist**, **provider on/off switches** — Phase 11.
- **Two peppers during rotation** — Phase 11 (`docs/ROTATION.md`).
- **Delivery receipts** (textbee webhooks → `delivered`) — when SMS goes live.
