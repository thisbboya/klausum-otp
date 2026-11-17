# Secret and key rotation

**When:** every 6 months (put a reminder in your calendar), and **immediately** after any leak
(a secret pasted in chat, a screenshot, a lost laptop, a public commit).
Local copies of every secret live in `.secrets.local` (git-ignored). Update it each time.

Generate a new random secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

| Secret | What it protects | Rotating it… | How |
|---|---|---|---|
| `ADMIN_TOKEN` | admin API, CLI, signs control-room sessions | logs everyone out of the control room | `npx wrangler secret put ADMIN_TOKEN`, update `.secrets.local` |
| App API keys | each app's access | zero downtime (24 h overlap) | `npm run admin -- keys:rotate <app>`, update the app's secret, redeploy it |
| `RESEND_API_KEY` | sending email | none if you add the new key first | resend.com → API keys → create (Sending access) → `npx wrangler secret put RESEND_API_KEY` → delete the old key in Resend |
| `AHASEND_API_KEY` | fallback email | none | AhaSend → Credentials → new API key → `npx wrangler secret put AHASEND_API_KEY` → revoke old |
| `TEXTBEE_API_KEY` | SMS | phone must reconnect | textbee dashboard → new key → re-register the phone with it → `wrangler secret put TEXTBEE_API_KEY` → revoke old |
| `TELEGRAM_BOT_TOKEN` | alerts | none | BotFather → `/revoke` → `npx wrangler secret put TELEGRAM_BOT_TOKEN` |
| Cloudflare API token (GitHub) | CI deploys | none | Cloudflare → My Profile → API Tokens → **Roll** → `gh secret set CLOUDFLARE_API_TOKEN -R thisbboya/klausum-otp` |
| `BACKUP_PASSPHRASE` | backup files | old backups need the OLD passphrase | `gh secret set BACKUP_PASSPHRASE …`; keep the old one until those backups expire (90 days) |
| `OTP_PEPPER` | code hashes, recipient hashes/encryption, blocklist hashes | see below | see below |
| `TOTP_KEY` | encrypts authenticator secrets | see below | see below |

## `OTP_PEPPER`
Everything keyed by the pepper is short-lived **except** the blocklist and per-person rate counters:
- live codes (5 min) become unverifiable → users just ask for a new code;
- encrypted recipients (≤ 24 h) can't be decrypted → "resend" fails for codes issued before the switch;
- **blocklist entries for phones/emails/IPs stop matching** (domains keep working).

Low-impact procedure:
1. Pick a quiet hour (codes live ≤ 5 min).
2. `npm run admin -- block:list` and note the phone/email/IP entries' labels — you'll need the real values to re-add them.
3. `npx wrangler secret put OTP_PEPPER` (new value).
4. Wait 10 minutes, re-add the blocked phones/emails/IPs with `block:add`.

(A dual-pepper verify window is not implemented: codes only live 5 minutes, so the cost of a clean switch is
"a few users tap *send a new code*".)

## `TOTP_KEY`
Authenticator secrets are encrypted with it. Changing it without re-encrypting **breaks every enrolled
authenticator, including your own control-room login**. Procedure:
1. Keep the old key. Set the new one as `TOTP_KEY_NEW` is **not** supported yet — so instead:
2. Ask users of TOTP to re-enrol after the switch (apps call `/v1/totp/enroll` again; confirmed enrolments must be deleted first:
   `npx wrangler d1 execute klausum-otp --remote --command "DELETE FROM totp_secrets WHERE app_id='<app>'"`).
3. `npx wrangler secret put TOTP_KEY`, then `npm run admin -- admin:totp-setup --reset` and scan the new QR for the control room.
Only rotate `TOTP_KEY` after a real leak.

## Reminder
The daily Telegram summary is a good place to look; set a calendar reminder for **every 6 months** (next: 2027-05-17).
