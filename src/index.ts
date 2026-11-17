import { Hono } from "hono";
import { admin } from "./admin";
import { v1, cleanup } from "./routes";
import { totp } from "./totp-routes";
import { DASHBOARD_CSS, DASHBOARD_HTML, DASHBOARD_JS } from "./dashboard";
import { CONTROL_HTML, CONTROL_JS } from "./control";
import { adminLogin } from "./admin-login";
import { STATUS_CSS, STATUS_HTML, STATUS_JS, statusData } from "./status";
import { dailySummary, selfCheck } from "./monitor";

// Must match wrangler.jsonc "triggers.crons" (3 of the 5 free Cron Triggers).
export const CRON_SELF_CHECK = "*/15 * * * *";
export const CRON_DAILY = "0 8 * * *"; // 08:00 UTC = 08:00 Ghana

export type Env = {
  DB: D1Database;
  ADMIN_TOKEN: string;
  OTP_PEPPER: string;
  TOTP_KEY: string;
  ADMIN_EMAIL?: string;     // secret: where control-room login codes and alerts go
  TELEGRAM_BOT_TOKEN?: string; // secret: alerts + daily summary bot
  TELEGRAM_CHAT_ID?: string;   // secret: your chat with that bot
  EMAIL_DNS_CHECK?: string; // "off" disables the MX lookup (tests only)
  DELIVERY_MODE?: string; // "console" = tests/local only (logs codes). Never set in production.
  EMAIL_FROM: string;     // e.g. "Klausum <otp@mail.klausum.study>"
  RESEND_API_KEY?: string;
  AHASEND_API_KEY?: string;
  AHASEND_ACCOUNT_ID?: string;
  TEXTBEE_API_KEY?: string;
  TEXTBEE_DEVICE_ID?: string;
};

export const app = new Hono<{ Bindings: Env }>();

// Security headers + Server-Timing on every response
app.use("*", async (c, next) => {
  const t0 = Date.now();
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (!c.res.headers.has("Content-Security-Policy")) c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  c.header("Cache-Control", "no-store");
  c.header("Server-Timing", `total;dur=${Date.now() - t0}`, { append: true });
});

app.get("/health", (c) => c.json({ ok: true }));

// Public status page: https://status.klausum.study (or /status on any of our hostnames).
const STATUS_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";
const statusPage = (c: any) => { c.header("Content-Security-Policy", STATUS_CSP); c.header("Cache-Control", "public, max-age=60"); return c.html(STATUS_HTML); };
app.get("/", (c) => (new URL(c.req.url).hostname.startsWith("status.") ? statusPage(c) : c.json({ service: "Klausum OTP", docs: "https://github.com/thisbboya/klausum-otp", status: "https://status.klausum.study" })));
app.get("/status", statusPage);
app.get("/status.json", async (c) => { c.header("Access-Control-Allow-Origin", "*"); return c.json(await statusData(c.env)); });
app.get("/status.css", (c) => c.body(STATUS_CSS, 200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=300" }));
app.get("/status.js", (c) => c.body(STATUS_JS, 200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=300" }));

// Admin dashboard page (data comes from /admin/stats, which needs the admin token).
const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
app.get("/dashboard", (c) => { c.header("Content-Security-Policy", PAGE_CSP); return c.html(DASHBOARD_HTML); });
app.get("/dashboard.js", (c) => c.body(DASHBOARD_JS, 200, { "Content-Type": "text/javascript; charset=utf-8", "Content-Security-Policy": PAGE_CSP }));
// Control room (login: email code + authenticator). Registered BEFORE the admin API so the
// page itself loads without auth; everything it shows comes from /admin/* with the session cookie.
app.get("/admin", (c) => { c.header("Content-Security-Policy", PAGE_CSP); return c.html(CONTROL_HTML); });
app.get("/control.js", (c) => c.body(CONTROL_JS, 200, { "Content-Type": "text/javascript; charset=utf-8", "Content-Security-Policy": PAGE_CSP }));
app.route("/auth/admin", adminLogin);
app.get("/dashboard.css", (c) => c.body(DASHBOARD_CSS, 200, { "Content-Type": "text/css; charset=utf-8", "Content-Security-Policy": PAGE_CSP }));
app.route("/admin", admin);
app.route("/v1/totp", totp);
app.route("/v1", v1);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  console.error(err); // Workers Logs only — never leaked to the client
  return c.json({ error: "internal_error" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (event.cron === CRON_SELF_CHECK) ctx.waitUntil(selfCheck(env).then((r) => console.log("self-check", JSON.stringify(r))));
    else if (event.cron === CRON_DAILY) ctx.waitUntil(dailySummary(env).then((r) => console.log("daily summary", JSON.stringify(r))));
    else ctx.waitUntil(cleanup(env));
  },
} satisfies ExportedHandler<Env>;
