import { Hono } from "hono";
import { admin } from "./admin";
import { v1, cleanup } from "./routes";

export type Env = {
  DB: D1Database;
  ADMIN_TOKEN: string;
  OTP_PEPPER: string;
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
  c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  c.header("Cache-Control", "no-store");
  c.header("Server-Timing", `total;dur=${Date.now() - t0}`, { append: true });
});

app.get("/health", (c) => c.json({ ok: true }));
app.route("/admin", admin);
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
