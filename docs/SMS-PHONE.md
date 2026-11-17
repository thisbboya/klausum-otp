# Keeping the textbee SMS phone alive

SMS codes are sent by **your own spare Android phone** running the textbee app, using its SIM.
(SMS is built and tested but not switched on yet — finish setup with the steps at the bottom.)

## Checklist
- [ ] **Always charging** — a good charger and cable, phone somewhere cool (not in the sun).
- [ ] **Battery optimisation OFF for textbee**: Settings → Apps → textbee → Battery → *Unrestricted* (Samsung: also remove it from *Sleeping apps*; Tecno/Infinix/Xiaomi: allow *Auto-start* and *Run in background*).
- [ ] **Auto-start on boot** allowed (same Apps screen).
- [ ] **Wi-Fi on + mobile data on** as backup; turn off *Wi-Fi sleep*.
- [ ] Lock the textbee app in *Recent apps* (long-press its card → Lock) so cleaners don't close it.
- [ ] textbee app → Settings → Device health: everything green; heartbeat every 30 min.
- [ ] **SIM SMS bundle**: buy a bundle that covers your usage; set a monthly reminder to renew it. The dashboard's textbee meter shows SMS sent (free textbee plan: 50/day, 300/month).
- [ ] Screen lock with a PIN (the phone holds codes in its sent messages); delete old sent SMS monthly.

## If the phone dies or goes offline
- The self-check notices when the phone is silent for **30 minutes** and alerts you on Telegram and email.
- Meanwhile, SMS codes **fall back to email** for apps that send a `fallback_email`, and others show "failed".
- To stop trying SMS entirely while you fix it: `npm run admin -- provider:disable textbee`
  (and `provider:enable textbee` afterwards).

## Finishing SMS setup (when you're ready)
1. textbee.dev → sign in → **Add API key** (copy it) → install the textbee APK on the phone → scan the QR → Register.
2. Store the key and device id:
   ```bash
   npx wrangler secret put TEXTBEE_API_KEY
   npx wrangler secret put TEXTBEE_DEVICE_ID
   ```
3. Set Meraaba's Android app hash: control room → Apps → meraaba → *SMS app hash*.
4. Send a test: `curl -X POST https://otp.klausum.study/v1/otp/send -H "Authorization: Bearer <meraaba key>" -H "Content-Type: application/json" -d '{"channel":"sms","to":"024XXXXXXX"}'`
