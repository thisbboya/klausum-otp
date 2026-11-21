# Klausum OTP

Free, fast, open-source one-time codes for your app: **email codes**, **SMS codes** and
**authenticator-app (TOTP) codes**, plus **free phone-number checks through Telegram and WhatsApp**,
running entirely on free tiers (Cloudflare Workers + D1, Resend, AhaSend). MIT licensed.

Live service: **https://otp.klausum.study** · Health: [`/health`](https://otp.klausum.study/health) · Control room: [`/admin`](https://otp.klausum.study/admin)

- 6-digit codes from a CSPRNG (no modulo bias), stored only as HMAC hashes, 5-minute expiry, single use, 5 tries
- Rate limits per person, per IP, per app; verify limits; admin brute-force lock-out
- **Refuses throwaway emails** (10 000+ temp-mail domains) and domains that can't receive mail
- Email via Resend, automatic fallback to AhaSend; SMS via your own Android phone (SMSGate, end-to-end encrypted; textbee optional) with email fallback
- **Phone checks without SMS:** the user confirms their number in Telegram (shares their own contact) or WhatsApp (sends us a code) — see [docs/PHONE-CHECK.md](docs/PHONE-CHECK.md)
- **Control room** at `/admin` (Apple-style, works on a phone) with one-tap fixes and an optional AI assistant
- Android SMS Retriever format, so apps can read the code automatically
- TOTP enrolment with QR code, encrypted secrets, replay protection
- One database round trip per request · `Server-Timing` on every response
- Full test suite (`npm test`) covering every security rule — see [docs/SECURITY.md](docs/SECURITY.md)

---

## Quick start (5 minutes) — use the hosted service

**1. Get an API key.** Keys look like `kotp_live_…` (real delivery) or `kotp_test_…` (everything works, nothing is delivered — use it while developing). Ask the owner for one, or [host your own](#host-your-own-copy-for-free-15-minutes).

**2. Call it from your server** — never from a browser or mobile app; your key is a secret.

```ts
// npm package source: packages/sdk (zero dependencies, ~4 KB)
import { createOtpClient } from "@klausum/otp";

const otp = createOtpClient({ apiKey: process.env.KLAUSUM_OTP_KEY! });

// 1. send
const { requestId, resendAfter } = await otp.sendOtp({
  channel: "email",
  to: "ama@example.com",
  endUserIp: req.headers["cf-connecting-ip"], // so per-IP limits apply per person, not to your server
});

// 2. verify what the user typed
const result = await otp.verifyOtp({ requestId, code: "482913" });
if (result.valid) { /* log them in */ } else { /* result.reason, result.attemptsLeft */ }
```

Or with plain `curl`:

```bash
curl -X POST https://otp.klausum.study/v1/otp/send \
  -H "Authorization: Bearer kotp_test_YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"channel":"email","to":"ama@example.com"}'
```

**3. Tie the code to the person in your own session.** Store `requestId` server-side (or sign it together
with the email, like `src/routes/api/auth-code.ts` in Klausum does) so a code issued for one address can
never be used to sign in as another.

**4. Build the code screen.** One `<input autocomplete="one-time-code" inputmode="numeric">` (or six boxes
with paste support), a 30-second "send a new code" countdown driven by `resendAfter`, and friendly messages
for `invalid_code` / `expired` / `too_many_attempts`.

---

## Architecture

```
Your web app / mobile app
        │  (your own backend)
        │  HTTPS + Authorization: Bearer kotp_…
        ▼
Cloudflare Worker  (TypeScript, Hono, Web Crypto only)        ← runs at the edge (Accra for Ghana)
        │
        ├── Cloudflare D1 (SQLite)   hashed codes, encrypted recipients, rate counters, logs, daily stats
        ├── Email:  Resend  ──fallback──▶  AhaSend          (quota errors remembered until midnight UTC)
        ├── SMS:    SMSGate on your Android phone (encrypted) ──fallback──▶ email
        ├── Phone:  Telegram bot / WhatsApp webhooks (no SMS, free)
        ├── Web:    web/ (React + Vite) → website at / and control room at /admin
        ├── AI:     Gemini free tier, control-room assistant (optional)
        ├── TOTP:   computed locally (RFC 6238), secrets AES-GCM encrypted
        └── Cron:   cleanup 03:17 UTC · self-check every 15 min · daily summary 08:00 UTC
```

`/send` writes the request in **one** D1 batch, answers `202` immediately, and delivers in the background
(`ctx.waitUntil`). `/verify` is also **one** D1 batch. From Ghana both answer in ~150 ms; almost all of that
is one round trip to D1 in Western Europe (no free database region exists in Africa — see
[docs/RESEARCH.md](docs/RESEARCH.md)).

| Path | What |
|---|---|
| `src/routes.ts` | `/v1/otp/*` send · verify · resend · status |
| `src/totp-routes.ts`, `src/totp.ts` | `/v1/totp/*` enroll · verify |
| `src/delivery.ts`, `src/email.ts`, `src/sms.ts` | providers, fallback, templates |
| `src/email-check.ts`, `src/disposable-domains.ts` | throwaway-email and MX checks |
| `src/ratelimit.ts` | window counters |
| `src/phone.ts` | `/v1/phone/*` Telegram/WhatsApp phone checks + `/hooks/*` webhooks |
| `src/admin.ts`, `src/stats.ts`, `src/monitor.ts` | admin API, stats, alerts |
| `src/assistant.ts`, `src/assistant-tools.ts`, `src/handbook.ts` | control-room AI assistant, its tools and the fix handbook |
| `src/app.ts` / `src/index.ts` | routes / Worker entry (handlers only) |
| `web/` | website + control room (React, built to `web/dist`, served as static assets) |
| `packages/sdk` | `@klausum/otp` client |
| `migrations/` | D1 schema |

---

## API reference

All `/v1` requests: `Authorization: Bearer <api key>`, JSON body. Unknown fields → `400`.

### `POST /v1/otp/send`
```json
{ "channel": "email" | "sms", "to": "ama@example.com", "purpose": "login", "locale": "en", "fallback_email": "(sms only) ama@example.com" }
```
Optional header `X-End-User-IP: <your user's IP>`.
`202` → `{ "request_id": "otp_…", "channel": "email", "expires_in": 300, "resend_after": 30 }`
Errors: `400 invalid_request` · `400 email_not_allowed` (`reason`: `disposable` | `no_mailbox`) · `401 unauthorized` · `403 origin_not_allowed` · `429 rate_limited` (+ `Retry-After`).
Phones: local Ghana numbers are fine (`0241234567` → `+233241234567`).

### `POST /v1/otp/verify`
```json
{ "request_id": "otp_…", "code": "482913" }
```
`200` → `{ "valid": true }` or `{ "valid": false, "reason": "invalid_code" | "expired" | "too_many_attempts", "attempts_left": 3 }`. `429` after 10 tries per person per 10 minutes.

### `POST /v1/otp/resend`
`{ "request_id": "otp_…" }` → same as send (new `request_id`; the old code stops working).

### `GET /v1/otp/status/:request_id`
`{ "request_id", "channel", "status": "queued" | "sent" | "delivered" | "failed", "provider" }`

### `POST /v1/totp/enroll`
`{ "user_ref": "user-123", "issuer": "Klausum" }` → `201 { "secret", "otpauth_url", "qr_svg" }`. A user who has already confirmed an authenticator gets `409 already_enrolled`.

### `POST /v1/totp/verify`
`{ "user_ref": "user-123", "code": "123456" }` → `{ "valid": true }` / `{ "valid": false, "reason": "invalid_code" }`. ±30 s drift; a code can't be used twice.

### `POST /v1/phone/start`
`{ "method": "telegram" | "whatsapp" }` → `201 { "request_id": "pc_…", "method", "link", "expires_in": 600 }`; WhatsApp also returns `"code"` and `"message"`.
Open `link` for the user. Errors: `400 method_unavailable` (that method isn't set up) · `429 rate_limited`.

### `GET /v1/phone/status/:request_id`
`{ "status": "pending" | "expired" }` or `{ "status": "verified", "phone": "+233241234567" }`. Poll every few seconds.

### Admin (`Authorization: Bearer <ADMIN_TOKEN>`)
`POST /admin/apps` `{ "name": "my-app", "display_name": "My App", "allowed_origins": ["https://my.app"], "daily_cap": 300, "otp_ttl_seconds": 300, "sms_app_hash": "FA+9qCX9VSu", "mode": "live" | "test" }` → the key, **shown once**. `GET /admin/apps`, `GET /admin/stats`.

### Other
`GET /health` → `{ "ok": true }` · `GET /admin` → control room (email code + authenticator) · `/dashboard` redirects there.

---

## Host your own copy for free (15 minutes)

You need: Node.js 20+, a free Cloudflare account, a domain on Cloudflare DNS, and a free Resend account.

```bash
git clone <this repo> && cd klausum-otp && npm ci && npm --prefix web ci && npm run build:web
npx wrangler login
npx wrangler d1 create klausum-otp            # paste the database_id into wrangler.jsonc
npx wrangler d1 migrations apply klausum-otp --remote
```

Edit `wrangler.jsonc`: your domain in `routes`, your sender in `vars.EMAIL_FROM`. Then set secrets
(generate random ones with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`):

```bash
npx wrangler secret put OTP_PEPPER
npx wrangler secret put TOTP_KEY
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put RESEND_API_KEY      # resend.com → add your sending domain → API key (sending access)
# optional: AHASEND_API_KEY (+ AHASEND_ACCOUNT_ID in vars)
# optional SMS: SMSGATE_USER, SMSGATE_PASS, SMSGATE_PASSPHRASE (or TEXTBEE_API_KEY, TEXTBEE_DEVICE_ID)
# optional control room: ADMIN_EMAIL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GEMINI_API_KEY
# optional phone checks: TELEGRAM_WEBHOOK_SECRET (+ TELEGRAM_BOT_USERNAME in vars),
#   WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN (+ WHATSAPP_NUMBER in vars) — see docs/PHONE-CHECK.md
npx wrangler deploy
```

Create your first app and key:

```bash
curl -X POST https://YOUR-DOMAIN/admin/apps -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"my-app","display_name":"My App"}'
```

Everything stays on free tiers: Workers 100 000 requests/day, D1 100 000 row writes/day, Resend 100 emails/day
(3 000/month), AhaSend 1 000/month, Gemini free tier for the assistant. Telegram and incoming WhatsApp messages are free. Re-check these monthly — see `docs/RESEARCH.md`.

## Development

```bash
npm test                    # all tests (local D1, no network)
npm run typecheck
npm run bench               # latency benchmark with a kotp_test_ key (sends nothing)
npm run update:disposable   # refresh the throwaway-email list (monthly)
```

Secrets for local dev go in `.dev.vars` (git-ignored). Never commit keys.

## Docs
Operations: [RUNBOOK](docs/RUNBOOK.md) · [MAINTENANCE](docs/MAINTENANCE.md) · [ROTATION](docs/ROTATION.md) · [RESTORE](docs/RESTORE.md) · [SMS phone](docs/SMS-PHONE.md) · [Phone check](docs/PHONE-CHECK.md)
Reference: [SECURITY](docs/SECURITY.md) · [RESEARCH](docs/RESEARCH.md)
Policies: [TERMS](TERMS.md) · [PRIVACY](PRIVACY.md) · [ABUSE](ABUSE.md) · [LICENSE](LICENSE) (MIT)

## Control room

`https://<your domain>/admin` — sign in with an email code to `ADMIN_EMAIL` **and** your authenticator app.
Enrol the authenticator once with `POST /admin/owner-totp/enroll` (Bearer `ADMIN_TOKEN`). Works on a phone (tab bar) and desktop (sidebar), light and dark.

| Tab | What it does |
|---|---|
| Overview | codes today, delivery rate and time, free-quota meters, last 7 days |
| Fixes | problems the 15-minute self-check found, what they mean (from the handbook), one-tap fixes |
| Assistant | ask questions, get answers from live stats and the handbook; it can act (see below) |
| Apps & Keys | create apps, rotate / revoke keys, pause, set daily caps |
| Logs | every delivery attempt for 30 days (no recipients) |
| Providers | email order, turn providers on/off — applies instantly |
| Blocklist | block phones, emails, domains, IPs (stored hashed) |
| Settings | secret ages and rotation reminders, alerts |

**AI assistant (optional).** Set `GEMINI_API_KEY` (free key from aistudio.google.com). It acts **on its own only for safe
actions**: reading stats and logs, running the self-check, blocking an abuser, moving a failing email provider later.
Anything else (pausing apps, caps, keys, turning providers off) waits for your **Approve** tap. Every action is
logged and sent to Telegram. It never sees codes, recipients or secrets: emails, phone numbers and API keys are
removed before anything goes to Gemini. Busy free-tier answers are retried and fall back to lighter models.

CLI: `npm run admin -- help`.
