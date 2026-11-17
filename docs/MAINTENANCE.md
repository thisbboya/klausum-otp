# My routine

Everything below is free and mostly automatic. Alerts come to Telegram (@klausum_otp_alerts_bot) and Gmail.

## Daily — 2 minutes
- Read the **08:00 Telegram summary**: codes sent, failures, top app, quota left.
- Act only if there's an alert. Steps are in [RUNBOOK.md](RUNBOOK.md).

## Weekly — 15 minutes (e.g. Monday)
- Control room **https://otp.klausum.study/admin** → Overview: quota meters and failures.
- GitHub → **Pull requests**: merge Dependabot updates whose checks are green (they're tested and deployed to staging first).
- GitHub → **Actions → Backup**: Sunday's run is green ✅.
- Glance at Logs filtered to *failed*.

## Monthly
- Re-check free-tier limits (Cloudflare Workers/D1, Resend, AhaSend, textbee) and update `docs/RESEARCH.md` if anything changed.
- Refresh the throwaway-email list: `npm run update:disposable`, run `npm test`, commit, push.
- Send a code to a fresh https://www.mail-tester.com address — aim for ≥ 9/10.
- Read the DMARC report emails in Gmail (from Google/Microsoft about `klausum.study`). Once a month of reports shows only our two senders, tighten `_dmarc` from `p=none` to `p=quarantine`.
- Review the **Blocklist** and **Apps** (remove what's no longer needed; check caps).
- SMS (once live): renew the SIM's SMS bundle; compare its size with the textbee meter.

## Every 6 months (next: 2027-05-17)
- Rotate secrets — [ROTATION.md](ROTATION.md).
- Practice a restore into staging — [RESTORE.md](RESTORE.md).
- Read [SECURITY.md](SECURITY.md) again and re-run `npm run bench`.

## Where things are
| What | Where |
|---|---|
| Live service | https://otp.klausum.study (health: `/health`) |
| Control room | https://otp.klausum.study/admin |
| Staging | https://otp-staging.klausum.study |
| Code | https://github.com/thisbboya/klausum-otp |
| Local secrets | `.secrets.local` (git-ignored — back it up privately) |
| CLI | `npm run admin -- help` |
| Live logs | `npx wrangler tail klausum-otp` |
