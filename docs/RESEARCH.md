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

## Still to verify (in the phase that needs them)
- ⏳ Cloudflare Email Service / `send_email` to arbitrary addresses (Phase 4 — will report, not switch)
- ⏳ AhaSend free plan + API (Phase 4)
- ⏳ textbee send-SMS endpoint + auth header (Phase 5)
- ⏳ Android SMS Retriever message format (Phase 5)
- ⏳ RFC 6238 / 4226 details (Phase 6)
- ⏳ OWASP MFA cheat sheet (Phase 3 / Phase 7)
