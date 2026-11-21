/**
 * The HTTP app (API + status page). Kept out of src/index.ts on purpose: the Worker's main module
 * may only export handlers — the runtime rejects plain values (constants, objects) there.
 */
import { Hono } from "hono";
import type { Env } from "./index";
import { admin } from "./admin";
import { v1 } from "./routes";
import { totp } from "./totp-routes";
import { adminLogin } from "./admin-login";
import { STATUS_CSS, STATUS_HTML, STATUS_JS, statusData } from "./status";

// Must match wrangler.jsonc "triggers.crons" (3 of the 5 free Cron Triggers).
export const CRON_SELF_CHECK = "*/15 * * * *";
export const CRON_DAILY = "0 8 * * *"; // 08:00 UTC = 08:00 Ghana

export const isStatusHost = (url: string) => new URL(url).hostname.startsWith("status.");

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


