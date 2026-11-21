/**
 * Worker entry point. Exports ONLY the handler (fetch + scheduled) — the runtime rejects any other
 * value exports from the main module. The app lives in ./app.
 */
import { app, CRON_DAILY, CRON_SELF_CHECK, isStatusHost } from "./app";
import { cleanup } from "./routes";
import { dailySummary, selfCheck } from "./monitor";

export type Env = {
  DB: D1Database;
  ASSETS?: Fetcher;         // web/dist (website + control room), Workers Static Assets
  ADMIN_TOKEN: string;
  OTP_PEPPER: string;
  TOTP_KEY: string;
  ADMIN_EMAIL?: string;     // secret: where control-room login codes and alerts go
  TELEGRAM_BOT_TOKEN?: string; // secret: alerts + daily summary bot
  TELEGRAM_CHAT_ID?: string;   // secret: your chat with that bot
  TELEGRAM_BOT_USERNAME?: string;   // var: the bot's @name, for t.me links
  TELEGRAM_WEBHOOK_SECRET?: string; // secret: Telegram sends it on every webhook call
  WHATSAPP_NUMBER?: string;         // var: your WhatsApp Business number (digits)
  WHATSAPP_APP_SECRET?: string;     // secret: Meta app secret, signs webhook calls
  WHATSAPP_VERIFY_TOKEN?: string;   // secret: Meta webhook subscribe handshake
  GEMINI_API_KEY?: string;    // secret: control-room assistant (free tier)
  GEMINI_MODEL?: string;       // optional override, default gemini-flash-latest
  EMAIL_DNS_CHECK?: string; // "off" disables the MX lookup (tests only)
  DELIVERY_MODE?: string; // "console" = tests/local only (logs codes). Never set in production.
  EMAIL_FROM: string;     // e.g. "Klausum <otp@mail.klausum.study>"
  RESEND_API_KEY?: string;
  AHASEND_API_KEY?: string;
  AHASEND_ACCOUNT_ID?: string;
  SMSGATE_USER?: string;       // secret: SMSGate cloud username (shown in the app)
  SMSGATE_PASS?: string;       // secret: SMSGate cloud password
  SMSGATE_PASSPHRASE?: string; // secret: end-to-end passphrase, also entered in the app
  SMSGATE_ITERATIONS?: string; // PBKDF2 rounds, must match the app (default 75000)
  TEXTBEE_API_KEY?: string;
  TEXTBEE_DEVICE_ID?: string;
};

export default {
  // "/" is in run_worker_first (so status.* can get its own page); on every other host it is
  // handed straight to the static website without touching the API's headers or no-store cache.
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    // "/admin" (exact) is the control-room page; "/admin/*" is the admin API. Route patterns can't
    // tell those apart reliably, so the page is handed to the static files here.
    if ((url.pathname === "/" || url.pathname === "/admin") && env.ASSETS && !isStatusHost(request.url)) return env.ASSETS.fetch(request);
    return app.fetch(request, env, ctx);
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (event.cron === CRON_SELF_CHECK) ctx.waitUntil(selfCheck(env).then((r) => console.log("self-check", JSON.stringify(r))));
    else if (event.cron === CRON_DAILY) ctx.waitUntil(dailySummary(env).then((r) => console.log("daily summary", JSON.stringify(r))));
    else ctx.waitUntil(cleanup(env));
  },
} satisfies ExportedHandler<Env>;
