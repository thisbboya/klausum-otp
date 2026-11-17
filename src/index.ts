import { Hono } from "hono";
import { admin } from "./admin";
import { v1, cleanup } from "./routes";
import { totp } from "./totp-routes";
import { DASHBOARD_CSS, DASHBOARD_HTML, DASHBOARD_JS } from "./dashboard";

export type Env = {
  DB: D1Database;
  ADMIN_TOKEN: string;
  OTP_PEPPER: string;
  TOTP_KEY: string;
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

// Admin dashboard page (data comes from /admin/stats, which needs the admin token).
const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
app.get("/dashboard", (c) => { c.header("Content-Security-Policy", PAGE_CSP); return c.html(DASHBOARD_HTML); });
app.get("/dashboard.js", (c) => c.body(DASHBOARD_JS, 200, { "Content-Type": "text/javascript; charset=utf-8", "Content-Security-Policy": PAGE_CSP }));
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
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(cleanup(env));
  },
} satisfies ExportedHandler<Env>;
