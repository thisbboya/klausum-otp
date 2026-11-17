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

## Still to verify (in the phase that needs them)
- ⏳ textbee send-SMS endpoint + auth header (Phase 5)
- ⏳ Android SMS Retriever message format (Phase 5)
- ⏳ RFC 6238 / 4226 details (Phase 6)
- ⏳ OWASP MFA cheat sheet (Phase 3 / Phase 7)
