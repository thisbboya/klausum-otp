import { Hono } from "hono";

export type Env = Record<string, never>;

const app = new Hono<{ Bindings: Env }>();

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
  c.header("Server-Timing", `total;dur=${Date.now() - t0}`);
});

app.get("/health", (c) => c.json({ ok: true }));

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  console.error(err); // Workers Logs only — never leaked to the client
  return c.json({ error: "internal_error" }, 500);
});

export default app;
