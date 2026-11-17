# Privacy — Klausum OTP

_Last updated: 2026-11-17. Contact: support@klausum.study_

Klausum OTP sends one-time codes for apps (such as Klausum and Meraaba) and checks them. We keep as
little as possible, for as short a time as possible.

## What we store, and for how long

| What | How it's stored | How long |
|---|---|---|
| The code we sent you | **Never stored.** Only a one-way keyed hash (HMAC-SHA256) | Request deleted after **24 hours** |
| Your email address or phone number | A one-way keyed hash (to apply rate limits), plus an **encrypted** copy (AES-GCM) only so the code can be delivered or re-sent | Encrypted copy wiped as soon as the code is used or expires; the request itself after **24 hours** |
| Delivery logs (which provider, success/failure, timing) | **No email address or phone number** in logs | **30 days** |
| Rate-limit counters | Keyed hashes of recipient / IP | Up to 2 days |
| Daily totals (e.g. "9 emails sent today") | Numbers only, no people | Kept for the dashboard |
| Authenticator (TOTP) secrets | Encrypted (AES-GCM) | Until the app or you remove the enrolment |
| Blocklist entries (abuse only) | Phones, emails and IPs as one-way hashes; email domains in clear | Until removed |
| Weekly backups | Encrypted copy of the database above | 90 days |

We never sell or share personal data. We don't use it for marketing or tracking.

## Who processes it (sub-processors)

- **Cloudflare** — runs the service and its database (Workers, D1; database in Western Europe).
- **Resend** (USA) and **AhaSend** (EU) — deliver emails.
- **textbee** + the operator's own Android phone and SIM — deliver SMS (when enabled).
- **GitHub** — stores encrypted backups.

They receive only what's needed to deliver a message (the address/number and the message text).

## Your choices
- You can ask the app you were signing in to (e.g. Klausum) to remove your account; our data about a
  code request disappears on its own within 24 hours.
- Questions or removal requests: **support@klausum.study**.

## Security
Codes expire in 5 minutes, work once, and lock after 5 wrong tries. Details: [docs/SECURITY.md](docs/SECURITY.md).
