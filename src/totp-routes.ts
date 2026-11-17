import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { preflight, requireApiKey, type Vars } from "./auth";
import { enrollTotpCore, verifyTotpCore } from "./cores";

export const totp = new Hono<{ Bindings: Env; Variables: Vars }>();
totp.use("*", preflight);
totp.use("*", requireApiKey);

const userRef = z.string().regex(/^[A-Za-z0-9._:@-]{1,128}$/);
const enrollSchema = z.object({ user_ref: userRef, issuer: z.string().regex(/^[A-Za-z0-9 ._-]{1,40}$/).optional() }).strict();
const verifySchema = z.object({ user_ref: userRef, code: z.string().regex(/^\d{6}$/) }).strict();

totp.post("/enroll", async (c) => {
  const p = enrollSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "invalid_request" }, 400);
  const app = c.get("app");
  const r = await enrollTotpCore(c.env, app.id, p.data.user_ref, p.data.issuer ?? app.display_name ?? app.name);
  if ("alreadyEnrolled" in r) return c.json({ error: "already_enrolled" }, 409);
  return c.json({ secret: r.secret, otpauth_url: r.otpauthUrl, qr_svg: r.qrSvg }, 201);
});

totp.post("/verify", async (c) => {
  const p = verifySchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "invalid_request" }, 400);
  const v = await verifyTotpCore(c.env, c.get("app").id, p.data.user_ref, p.data.code);
  if ("rateLimited" in v) {
    c.header("Retry-After", String(v.retryAfter));
    return c.json({ error: "rate_limited", retry_after: v.retryAfter }, 429);
  }
  return v.valid ? c.json({ valid: true }) : c.json({ valid: false, reason: "invalid_code" });
});
