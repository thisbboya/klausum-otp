# Runbook — what to do when something breaks

Each problem: **how you notice → how to confirm → how to fix → what to tell users**.
Tools: control room **https://otp.klausum.study/admin**, CLI `npm run admin -- <command>` (run in the project folder),
live logs `npx wrangler tail klausum-otp`, Cloudflare dashboard → Workers & Pages → klausum-otp.

---

## 1. Resend quota used up (100/day or 3 000/month)
- **Notice:** Telegram/email alert "Resend free quota at 80 %+" or "resend failed 3 times in a row"; dashboard meter red / "used up today".
- **Confirm:** `npm run admin -- stats:today` · `npm run admin -- logs:tail 20 --failed` (errors say `daily_quota_exceeded`).
- **Fix:** nothing urgent — the service already skips Resend until midnight UTC and uses AhaSend (1 000/month).
  If AhaSend is also low: lower app caps (`npm run admin -- apps:cap klausum-web 100`) or pause the noisiest app.
  Daily limit resets 00:00 UTC; monthly on your Resend sign-up day.
- **Tell users:** usually nothing. If both providers are out: "Email codes are delayed today; use Google sign-in or try again after midnight."

## 2. Emails going to spam
- **Notice:** users say "no code"; logs show `sent`.
- **Confirm:** send a code to a fresh address from https://www.mail-tester.com and open the report (aim ≥ 9/10). Check DMARC reports in your Gmail (from `dmarc@klausum.study`).
- **Fix:** in Cloudflare DNS make sure these exist and are **DNS only** (grey cloud): `resend._domainkey.mail`, `send.mail` (MX + TXT), `ahasend._domainkey.mail`, `psrp.mail`, TXT `mail` (SPF), `_dmarc` and `_dmarc.mail`. Keep the email plain (no images/links). Ask a few users to mark it "Not spam".
- **Tell users:** "Check Spam/Promotions and mark our email as not spam."

## 3. textbee SMS phone offline
- **Notice:** alert "SMS phone silent for N min"; SMS logs `failed`.
- **Confirm:** textbee dashboard → Devices → last heartbeat; or open the textbee app on the phone.
- **Fix:** follow [SMS-PHONE.md](SMS-PHONE.md): charger, Wi-Fi/data, open textbee, battery optimisation off. Meanwhile SMS codes fall back to email when the app sent a `fallback_email`. To stop trying SMS: `npm run admin -- provider:disable textbee`.
- **Tell users (Meraaba):** "SMS codes are slow right now — use the email option or try again in a few minutes."

## 4. Cloudflare daily request limit hit (100 000/day)
- **Notice:** API returns errors / 1027 page; Cloudflare emails you; uptime monitor alerts.
- **Confirm:** Cloudflare dashboard → Workers & Pages → klausum-otp → Metrics (requests today).
- **Fix:** it resets at 00:00 UTC. Find the cause: `npm run admin -- logs:tail 50` and Workers Logs — usually one app or IP in a loop. Pause that app (`apps:pause <app>`) or block the IP (`block:add ip 1.2.3.4`).
- **Tell users:** "Sign-in by code is down until midnight UTC; Google sign-in still works."

## 5. Someone is spamming sends
- **Notice:** alert "Unusual spike: N codes in the last hour"; quota meters jumping.
- **Confirm:** control room → Logs (filter by app), `npm run admin -- logs:tail 50 --app klausum-web`.
- **Fix (fastest first):** block the IP / phone / email / domain (`block:add …`); lower the app's cap (`apps:cap`); pause the app (`apps:pause`) if it's being abused through its own backend. Per-person and per-IP limits already apply.
- **Tell users:** usually nothing.

## 6. A leaked API key
- **Notice:** you posted it somewhere, a laptop was lost, or sends from an app you didn't expect.
- **Sure it leaked:** `npm run admin -- keys:revoke <app>` (all keys stop within 10 s), then `npm run admin -- keys:rotate <app>`
  to make the one new working key. Put it in the app's secret store (for klausum.study:
  `npx wrangler secret put KLAUSUM_OTP_API_KEY --name klausum`) — the app is down between the two steps, so be quick.
- **Not sure:** `keys:rotate` alone — the old key keeps working 24 h, so nothing breaks while you update the app.
- **Other secrets** (pepper, admin token, provider keys): see [ROTATION.md](ROTATION.md).
- **Tell users:** nothing unless their data was exposed (it can't be from an API key alone: no codes or recipients are readable).

## 7. A bad deploy
- **Notice:** errors right after a push; GitHub Actions "Deploy production" smoke test failed; alerts.
- **Fix:** GitHub → Actions → **Rollback** → Run workflow (production, leave version empty). Or locally: `npx wrangler rollback --name klausum-otp -y`.
  **Database migrations are not undone by a rollback** — if a migration broke things, restore from D1 Time Travel ([RESTORE.md](RESTORE.md)).
- Then fix forward on a branch → pull request → it deploys to staging first.

## 8. D1 errors
- **Notice:** alert "Database (D1) is failing"; 500 `internal_error` from the API.
- **Confirm:** https://www.cloudflarestatus.com · `npx wrangler d1 execute klausum-otp --remote --command "SELECT 1"` · `npx wrangler tail klausum-otp`.
- **Fix:** if Cloudflare has an incident, wait. If we hit the free daily write limit (100 000 rows), it resets 00:00 UTC — find the cause as in §5. If data is damaged, restore ([RESTORE.md](RESTORE.md)).
- **Tell users:** "Codes are temporarily unavailable; please use Google sign-in."

## Useful commands
```bash
npm run admin -- stats:today
npm run admin -- logs:tail 30 --failed
npx wrangler tail klausum-otp                       # live logs
npx wrangler deployments list --name klausum-otp    # versions (for rollback)
curl -X POST https://otp.klausum.study/admin/monitor/check -H "Authorization: Bearer $ADMIN_TOKEN"
```
