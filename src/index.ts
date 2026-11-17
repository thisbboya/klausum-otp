import { Hono } from "hono";
import { admin } from "./admin";
import { v1, cleanup } from "./routes";
import { totp } from "./totp-routes";
import { adminLogin } from "./admin-login";
import { STATUS_CSS, STATUS_HTML, STATUS_JS, statusData } from "./status";
import { dailySummary, selfCheck } from "./monitor";

// Must match wrangler.jsonc "triggers.crons" (3 of the 5 free Cron Triggers).
export const CRON_SELF_CHECK = "*/15 * * * *";
export const CRON_DAILY = "0 8 * * *"; // 08:00 UTC = 08:00 Ghana

export type Env = {
  DB: D1Database;
  ASSETS?: Fetcher;         // web/dist (website + control room), Workers Static Assets
  ADMIN_TOKEN: string;
  OTP_PEPPER: string;
  TOTP_KEY: string;
  ADMIN_EMAIL?: string;     // secret: where control-room login codes and alerts go
  TELEGRAM_BOT_TOKEN?: string; // secret: alerts + daily summary bot
  TELEGRAM_CHAT_ID?: string;   // secret: your chat with that bot
  GEMINI_API_KEY?: string;     // secret: control-room assistant (free tier)
  GEMINI_MODEL?: string;       // optional override, default gemini-flash-latest
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
// "/" on status.* is the status page; everywhere else the website (static asset) answers — see default export.
app.get("/", (c) => (isStatusHost(c.req.url) ? statusPage(c) : c.json({ service: "Klausum OTP", docs: "https://github.com/thisbboya/klausum-otp", status: "https://status.klausum.study" })));
app.get("/status", statusPage);
app.get("/status.json", async (c) => { c.header("Access-Control-Allow-Origin", "*"); return c.json(await statusData(c.env)); });
app.get("/status.css", (c) => c.body(STATUS_CSS, 200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=300" }));
app.get("/status.js", (c) => c.body(STATUS_JS, 200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=300" }));

// The old hand-written pages moved into the React control room (web/admin.html at /admin).
app.get("/dashboard", (c) => c.redirect("/admin", 301));
app.route("/auth/admin", adminLogin);
app.route("/admin", admin);
app.route("/v1/totp", totp);
app.route("/v1", v1);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  console.error(err); // Workers Logs only — never leaked to the client
  return c.json({ error: "internal_error" }, 500);
});

const isStatusHost = (url: string) => new URL(url).hostname.startsWith("status.");

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
