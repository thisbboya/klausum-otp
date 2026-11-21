# Our own SMS + phone-number sign-up for Klausum — research, build prompt and to-do list

_Written 2026-11-21. Check prices, laws and limits again before building: they change._

## 0. What we're actually solving

Many Klausum students don't have an email address. They do have a phone number. So **"sign up with your
phone number"** has to work. That needs a way to prove a person owns a number.

(Email is already solved: our own sending domain `mail.klausum.study` through Resend + AhaSend. "SMTP" is the
email protocol. What we need here is **SMS** and other phone checks, not more email.)

Constraints: free or near-free, nothing that looks like spam to the networks, nothing that breaks Ghana's rules,
and no single point of failure (if one way is down, another still works).

## 1. Research summary

### 1.1 Ways to prove a phone number

| Way | Cost to us | Cost to student | Works without data? | Status |
|---|---|---|---|---|
| **Telegram** share-contact | free | data only | no | **live** on otp.klausum.study |
| **WhatsApp** send-a-code | free (messages users send in are free) | data only | no | built; waits on Meta business portfolio |
| **Missed call** (student calls our number, we read the caller ID and reject the call) | free (a rejected, unanswered call isn't charged) | free (unanswered) | **yes** | to build (needs a GSM modem, §1.2) |
| **SMS from our own SIM** (GSM modem) | SIM bundle airtime | free | **yes** | to build (§1.2) |
| **SMS from our own Android phone** (SMSGate/textbee) | SIM airtime | free | yes | built; **blocked** by Google Play Protect on the owner's phone |
| **Licensed SMS aggregator** (Arkesel, Hubtel) | ≈ GH₵0.03–0.035 per SMS | free | yes | paid: only with the owner's OK |

Prices: [Arkesel lists phone verification at GH₵0.035](https://arkesel.com/?p=10); [Hubtel lists GH₵0.03 pay-as-you-go](https://explore.hubtel.com/?p=19).
Confirm them before spending anything.

### 1.2 "Our own SMS" = a GSM modem we control

The only way to send SMS ourselves without a paid company or an Android app is a **GSM/LTE modem with a SIM**:
- a USB dongle or a Raspberry Pi HAT (Quectel EC25, SIMCom SIM7600, Huawei E3372 in modem mode);
- plugged into a Raspberry Pi or an old laptop that stays on.

Proven open-source software for this:
- **gammu-smsd**: the classic SMS daemon, with REST wrappers ([fizcko/sms-gateway](https://hub.docker.com/r/fizcko/sms-gateway) runs on a Pi 4 with a Quectel EC25; [haschek's Pi guide](https://blog.haschek.at/smsgateway)).
- **sms-server** (Rust): HTTP and WebSocket API, webhooks and delivery tracking ([docs](https://docs.rs/crate/sms-server/2.4.1/source/README.md)).

The same modem can **see incoming calls** (AT commands `+CLIP` caller ID, `RING`, then `ATH` to reject).
That gives us **missed-call verification** for free.

Reaching the modem from Cloudflare: **Cloudflare Tunnel** (free) from the Pi to `sms.klausum.study`, with
Cloudflare Access service-token auth plus our own HMAC on every request. No open ports at home.

### 1.3 Ghana rules and network risks (read this before buying anything)

- **Grey routes and SIM boxes.** The NCA's March 2026 consultation is about managing A2P (app-to-person) traffic. It talks about SMS firewalls that block grey-route traffic, spoofed sender IDs and SIM-box bypass ([NCA consultation](https://nca.org.gh/2026/03/12/public-consultation-on-regulatory-framework-for-the-management-monitoring-and-monetisation-of-international-application-to-person-a2p-messaging-traffic-in-ghana/), [paper](https://nca.org.gh/wp-content/uploads/2026/03/Consultation-Paper-for-Industry-Sensitization-on-International-A2P-2.pdf)). That paper is aimed at *international* traffic and is still a proposal. Even so, **an app sending lots of codes from a consumer SIM looks like a SIM box**. Expect the network to throttle or block that SIM if volume grows.
- **Sender IDs.** Messages from a modem show a phone number, not "Klausum". Registered alphanumeric sender IDs go through licensed providers. Twilio says unregistered sender IDs to Ghana networks will be blocked from 8 July 2026 ([Twilio Ghana guidelines](https://www.twilio.com/en-us/guidelines/gh/sms); not confirmed against an NCA document). See also [Telerivet on NCA sender IDs and Act 843](https://www.telerivet.com/blog/ghana-sms-compliance-nca-sender-id-registration-and-act-843).
- **SIM registration.** Our modem SIM must be registered to the owner (Ghana Card), as the NCA requires ([SIM registration FAQ 2026](https://nca.org.gh/wp-content/uploads/2026/03/SIM-Reg-FAQs-2026.pdf)).
- **Data protection (Act 843):** store numbers only as needed, and hash or encrypt them as the OTP service already does.

**So:** our own modem is fine for **low volume** (a student project: tens to a few hundred codes a day, kept under
ordinary personal use). Missed-call verification is the safest part, because nothing is sent. Above that volume, or
for a "Klausum" sender name, use a licensed aggregator. Klausum already has Arkesel code waiting for a key.

### 1.4 Signing up with a phone in Supabase (Klausum's login system)

Supabase supports phone sign-in, and its **Send SMS Hook** lets us deliver the code through *our own* sender
instead of Twilio ([Send SMS Hook docs](https://supabase.com/docs/guides/auth/auth-hooks/send-sms-hook), [phone login](https://supabase.com/docs/guides/auth/phone-login)).
The hook is an HTTPS endpoint that Supabase POSTs `{ user, sms: { otp } }` to, signed with a `v1,whsec_…` secret.
For the non-SMS ways (Telegram, WhatsApp, missed call), Klausum's server proves the number first. Then it creates
or finds the user with `auth.admin.createUser({ phone, phone_confirm: true })` and starts a session.

## 2. Recommended plan

1. **Now, free:** "Sign up with phone" on Klausum using **Telegram** (live) and **WhatsApp** (after Meta). No hardware.
2. **Next, free plus one cheap device:** a GSM modem on a Pi for **missed-call verification** (works with no data and costs
   students nothing), plus **SMS from our own SIM** as a second option at low volume.
3. **Safety net, paid only with the owner's OK:** Arkesel as the last fallback, behind a daily spending cap.
4. The OTP service picks the way automatically: missed call → SMS (modem) → SMS (Arkesel, if enabled), with
   Telegram/WhatsApp buttons always offered. The control room shows each one's health.

---

## 3. Build prompt (give this to the coding agent)

> You are a senior telecom + backend engineer who has shipped OTP and SMS systems in West Africa. Work in the
> `klausum-otp` repo (Cloudflare Workers + Hono + D1, TypeScript, vitest with `@cloudflare/vitest-plugin`) and the
> `klausum` repo (TanStack Start + Supabase). Read `README.md`, `docs/SECURITY.md`, `docs/PHONE-CHECK.md`,
> `src/phone.ts`, `src/delivery.ts`, `src/sms.ts` and Klausum's `src/routes/api/auth-code.ts`,
> `src/lib/notify.functions.ts`, `src/components/auth/*` first.
>
> **Goal:** students can sign up and log in to Klausum with only a Ghana phone number. They prove it by one of:
> Telegram, WhatsApp, a missed call to our number, or an SMS code from our own GSM modem (Arkesel only if switched on).
>
> **Hard rules:**
> - Free tiers only. Ask before anything that costs money; Arkesel stays off unless the owner sets a key and a daily cap.
> - No secrets in code or git: `wrangler secret put`, `.dev.vars` (git-ignored).
> - Codes: 6 digits, CSPRNG, stored only as HMAC, 5-minute expiry, single use, 5 tries. Rate limits per number, per IP, per app.
> - Never reveal whether a number has an account before it is proven.
> - Ghana numbers only (`233[235]XXXXXXXX`). Normalise `0241234567` → `+233241234567`.
> - Respect the networks: at most 1 SMS per 6 s per SIM, at most N per day (a setting), no promotional text, no links in OTP SMS.
> - UI must match Klausum's existing auth screens (`auth-shell.tsx`, `code-input.tsx`, tokens, copy style). Mobile first.
> - Commits as `Sadick`, plain messages, no AI credit lines.
> - Write tests first for every security rule. Run all tests before saying a step is done.
>
> **Build, in order:**
> 1. *Modem gateway* (new folder `gateway/`, runs on a Raspberry Pi):
>    - a small service (Node or Rust) that talks AT commands to a SIM7600/EC25 over serial, or wraps gammu-smsd;
>    - `POST /send {to, text}` → queue → send → report state;
>    - watches incoming calls (`AT+CLIP=1`, read the number on `RING`, hang up with `ATH` within 1 s) and POSTs `{from, at}` to `https://otp.klausum.study/hooks/modem`;
>    - signs every request both ways with HMAC-SHA256 plus a timestamp (±5 min), runs behind Cloudflare Tunnel and Access, sends a heartbeat every 60 s;
>    - include a systemd unit and a setup script.
> 2. *OTP service:*
>    - provider `modem` in `src/sms.ts`, first in the SMS order, with health from the heartbeat;
>    - `POST /v1/phone/start {method:"call"}` → `{request_id, call_number, expires_in}`. The user must call from the number they typed; the `/hooks/modem` call event marks it verified when the caller ID matches a pending check for that number;
>    - `/v1/phone/start {method:"sms", phone}` → sends a code through the SMS providers, verified with `/v1/otp/verify`;
>    - control room: a "Phone gateway" card (online/offline, SIM airtime left if the modem reports it, sent today);
>    - self-check alert when the heartbeat stops.
> 3. *Klausum:*
>    - "Continue with phone" on `/signup` and `/login` (beside email and Google);
>    - choose a way: Missed call · Text me a code · Telegram · WhatsApp, showing only the ones that are up;
>    - after proof: find or create the Supabase user by phone (`phone_confirm: true`) and start a session. Either use the Supabase Send SMS Hook for the SMS path, or for the other paths use a one-time server-side sign-in;
>    - students with phone-only accounts can add an email later in Settings.
> 4. *Docs:* `docs/MODEM-GATEWAY.md` (hardware list, setup, troubleshooting), RUNBOOK and SECURITY updates.
>
> **Done means:** a student with no email can sign up on a phone in under a minute by each method; all tests pass;
> a forged modem webhook and a replayed one are refused; the gateway being off shows in the control room and falls
> back cleanly; the owner has tested each method once on a real phone.

---

## 4. To-do list

### A. Decisions only the owner can make
- [ ] OK to buy a GSM modem (USB dongle or Pi HAT) and maybe a Raspberry Pi (one-time cost, check local prices).
- [ ] Which SIM/network for the gateway (MTN has the most users; also check Telecel and AT). Register it to yourself.
- [ ] A small monthly SMS bundle for that SIM.
- [ ] Is Arkesel allowed as a paid backup? If yes, what daily cap in GH₵?
- [ ] Finish the WhatsApp setup when Meta allows (business portfolio).
- [ ] Optional: a friendlier Telegram bot name (e.g. @KlausumBot) through @BotFather.

### B. Klausum phone sign-up with what's live today (Telegram, then WhatsApp)
- [ ] "Continue with phone" on `/signup` and `/login`, styled like the existing email flow.
- [ ] Server route: prove the number (Telegram/WhatsApp check) → find or create the user by phone → session.
- [ ] Never say "account exists" before the number is proven.
- [ ] Settings: add an email to a phone-only account, and the reverse.
- [ ] Tests: wrong user's check refused, expired check refused, a number already on another account handled.

### C. Modem gateway (hardware)
- [ ] Buy and test the modem: `AT`, `AT+CSQ` (signal), `AT+CMGS` (send), `AT+CLIP=1` (caller ID).
- [ ] Gateway service: send queue, 1 SMS per 6 s, daily cap, delivery reports (`AT+CNMI`), call watch.
- [ ] Cloudflare Tunnel → `sms.klausum.study`, Access service token, HMAC both ways, heartbeat.
- [ ] Run as a systemd service; auto-restart; keep logs small.

### D. OTP service
- [ ] `modem` SMS provider (first), Arkesel provider (off unless keyed and capped), textbee/SMSGate kept optional.
- [ ] Missed-call check: `/v1/phone/start {method:"call"}`, `/hooks/modem`, matching caller ID, 2-minute window.
- [ ] Control room: gateway health card, per-method success rates, spend meter for Arkesel.
- [ ] Self-check alerts: gateway offline, SIM airtime low, network refusing sends.
- [ ] Tests for every rule (forged or replayed webhook, wrong caller, caps, fallback order).

### E. Before go-live
- [ ] Each method tested on a real phone on MTN, Telecel and AT.
- [ ] Volume watch for the first two weeks (stay under normal personal-use levels on the SIM).
- [ ] Update TERMS/PRIVACY: phone numbers, what's stored, how long.
- [ ] RUNBOOK entries: modem offline, SIM blocked, airtime finished.
