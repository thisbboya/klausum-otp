# Phone check — Telegram and WhatsApp (free, no SMS)

Proves a person owns a phone number without sending an SMS.

| | Telegram | WhatsApp |
|---|---|---|
| What the user does | opens our bot, taps **Share my number** | sends a pre-filled message with a 6-digit code |
| How we know it's theirs | Telegram gives us the account's own number (it checked it by SMS at sign-up); we refuse forwarded contacts | Meta tells us which number sent the message |
| Cost | free | free (messages users send in; we never reply) |
| Status | **live** | built and tested, waits on Meta setup |

## How an app uses it

From your **server** (the API key is secret):

```ts
const otp = createOtpClient({ apiKey: process.env.KLAUSUM_OTP_API_KEY! });
const { requestId, link, code } = await otp.startPhoneCheck({ method: "telegram" }); // or "whatsapp"
// open `link` for the user (new tab); for WhatsApp also show `code` as a backup
// then every 3 s:
const r = await otp.getPhoneCheck(requestId); // { status: "pending" | "expired" } | { status: "verified", phone: "+233…" }
```

Tie `requestId` to the signed-in user before polling (Klausum signs `user|requestId` with an HMAC), so nobody can
claim someone else's check. Checks expire after 10 minutes and are deleted after a day.

## Telegram setup (done for otp.klausum.study)

1. Bot from @BotFather → `TELEGRAM_BOT_TOKEN` (secret) and its name in `vars.TELEGRAM_BOT_USERNAME`.
2. `TELEGRAM_WEBHOOK_SECRET` (secret): any long random string.
3. Point the bot at us (run once, and again after changing the secret):

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d url=https://otp.klausum.study/hooks/telegram \
  -d secret_token="$TELEGRAM_WEBHOOK_SECRET" \
  -d 'allowed_updates=["message"]'
```

The same bot still sends your alerts; alerts don't use the webhook.

## WhatsApp setup (to do)

1. developers.facebook.com → create an app → use case **Connect with customers through WhatsApp** (needs a business
   portfolio; brand-new Facebook accounts must wait before they can make one).
2. Add a phone number that isn't already on WhatsApp (a spare SIM), or use Meta's test number to try it.
3. Secrets: `WHATSAPP_APP_SECRET` (App settings → Basic → App secret) and `WHATSAPP_VERIFY_TOKEN` (any random string).
   Var: `WHATSAPP_NUMBER` (digits only, e.g. `233201234567`) in `wrangler.jsonc`.
4. WhatsApp → Configuration → Webhook: URL `https://otp.klausum.study/hooks/whatsapp`, verify token = `WHATSAPP_VERIFY_TOKEN`,
   then subscribe to **messages**.
5. Test: Klausum → Settings → Reminders → **Verify with WhatsApp**.

Until step 3 is done, `/v1/phone/start {method:"whatsapp"}` answers `400 method_unavailable` and Klausum says
"WhatsApp isn't available right now. Try the other one."
