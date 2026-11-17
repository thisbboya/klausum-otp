# Research notes — free-tier limits & APIs

Checked: 2026-11-17. Re-check monthly (see MAINTENANCE.md, later phase).
Legend: ✅ verified from official page today · ⏳ not yet verified (will verify in the phase that uses it)

## Cloudflare Workers (free) — https://developers.cloudflare.com/workers/platform/limits/
- ✅ 100,000 requests/day, reset midnight UTC
- ✅ **10 ms CPU per request** — tight. Matters for HMAC/AES-GCM/QR work; Web Crypto is native so should be fine, but we must measure.
- ✅ 50 subrequests per request (email/SMS provider calls count)
- ✅ 5 Cron Triggers per account → cleanup cron + 15-min self-check + daily summary fit (3 of 5).

## Cloudflare D1 (free) — https://developers.cloudflare.com/d1/platform/limits/
- ✅ 10 databases, 500 MB max per DB, 5 GB per account
- ✅ 50 queries per Worker invocation
- ✅ Time Travel (point-in-time restore): 7 days on free
- ⏳ Daily rows read/written (expected 5M reads / 100k writes per day) — limits page doesn't list it; check /d1/platform/pricing/ in Phase 2.
  **Implication:** 100k writes/day is our real ceiling; each send ≈ 3–5 writes → design rate counters carefully.

## Workers Rate Limiting binding — https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- ✅ Periods only 10 s or 60 s → **cannot** express our 10-min / 1-hour / daily windows.
- ⏳ Free-plan availability not stated on the page.
- **Decision:** use our own fixed-window counters in D1 (`rate_counters`) as the spec already says. May add the binding later as a cheap first-line IP flood guard.

## Resend — https://resend.com/pricing
- ✅ Free: 3,000/month, 100/day, **3 domains** (spec said 1 — it's more generous now)
- ⏳ API shape — Phase 4

## Email (checked 2026-11-17, Phase 4)
- ✅ **Cloudflare Email Sending**: beta; sending to *arbitrary* recipients requires **Workers Paid** — https://developers.cloudflare.com/email-service/ → not usable for us. (Email Routing for inbound forwarding is free and is used for support@ / dmarc@.)
- ✅ **Resend**: `POST https://api.resend.com/emails`, `Authorization: Bearer re_…`. Quota errors are HTTP 429 with `daily_quota_exceeded` / `monthly_quota_exceeded` (reset midnight UTC) — https://resend.com/docs/api-reference/errors
- ✅ **AhaSend**: free 1,000/month, no card, EU-hosted. API v2 `POST https://api.ahasend.com/v2/accounts/{account_id}/messages`, Bearer key, body `{from:{email,name}, recipients:[{email}], subject, text_content, html_content}` — https://ahasend.com/docs/send-api/send-email.md . Signup rejects free (Gmail) addresses → registered with support@klausum.study (forwards to Gmail).
- ✅ Deliverability: mail-tester.com score **9.3/10** on first Resend send (SPF+DKIM aligned, DMARC p=none).

## SMS (checked 2026-11-17, Phase 5 — code built, go-live postponed)
- ✅ **textbee** free: 1 device, **50 SMS/day, 300/month** (sent+received count). `POST https://api.textbee.dev/api/v1/gateway/send-sms`, header `x-api-key`, body `{recipients:[...], message, deviceId?}`. 200 = queued (not delivered); 429 = plan limit. Keys are full-access (no send-only scope). Phone heartbeat every 30 min by default — https://textbee.dev/llms-full.txt
- ✅ **SMS Retriever**: message ≤ **140 bytes**, must contain the code and the app's 11-char hash; current docs no longer require `<#>` (we keep it for old devices) — https://developers.google.com/identity/sms-retriever/verify

## TOTP (checked 2026-11-17, Phase 6)
- ✅ RFC 6238: 30 s step, allow at most 1 step of drift; SHA-1 test vectors (seed `12345678901234567890`) pass in `test/totp.test.ts`, as do RFC 4226 HOTP vectors.
- ✅ QR: **uqr** 0.1.3 (MIT, zero deps, ESM, `renderSVG`) — works in Workers. Note: bundle grew to ~887 KB (152 KB gzip), well under the 3 MB free limit.

## Speed (checked 2026-11-17, Phase 7)
- Worker runs at the **Accra (ACC)** edge; D1 primary is in **WEUR**. One ACC↔WEUR D1 round trip ≈ **120–130 ms** — that is the floor.
- ✅ **Smart Placement / Placement Hints** are free on all plans — https://developers.cloudflare.com/workers/configuration/placement/ . Tested `azure:westeurope`: server time fell to ~30 ms but Ghana round trips got *slower* (send p50 158→190 ms) because of the extra edge→Azure hop. Not used.
- ✅ **D1 read replication**: no Africa replicas (ENAM/WNAM/WEUR/EEUR/APAC/OC) and writes always go to the primary — https://developers.cloudflare.com/d1/best-practices/read-replication/ . Not useful here (every OTP call writes).
- ✅ **Durable Objects** (free: SQLite-backed, 100k req/day, 100k rows written/day): `afr` location hint exists but "Durable Objects don't currently spawn in Africa" — falls back nearby — https://developers.cloudflare.com/durable-objects/reference/data-location/ . No gain.
- **Conclusion:** with free Cloudflare storage, Ghana→service latency can't go below ~1 Europe round trip. We made every endpoint exactly **one** D1 round trip (TOTP verify: two, because it must decrypt the secret before the atomic replay check).

## Still to verify (in the phase that needs them)
- ✅ OWASP MFA cheat sheet — see docs/SECURITY.md
