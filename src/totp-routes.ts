import { Hono } from "hono";
import { z } from "zod";
import { renderSVG } from "uqr";
import type { Env } from "./index";
import { preflight, requireApiKey, type Vars } from "./auth";
import { hit } from "./ratelimit";
import { hmacHex } from "./otp";
import { base32Encode, matchStep, openSecret, otpauthUrl, sealSecret } from "./totp";

export const totp = new Hono<{ Bindings: Env; Variables: Vars }>();
totp.use("*", preflight);
totp.use("*", requireApiKey);

const userRef = z.string().regex(/^[A-Za-z0-9._:@-]{1,128}$/);
const enrollSchema = z.object({ user_ref: userRef, issuer: z.string().regex(/^[A-Za-z0-9 ._-]{1,40}$/).optional() }).strict();
const verifySchema = z.object({ user_ref: userRef, code: z.string().regex(/^\d{6}$/) }).strict();
const nowS = () => Math.floor(Date.now() / 1000);
const aadFor = (appId: string, ref: string) => `${appId}:${ref}`;

totp.post("/enroll", async (c) => {
  const p = enrollSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "invalid_request" }, 400);
  const app = c.get("app");
  const issuer = p.data.issuer ?? app.display_name ?? app.name;

  // A confirmed enrolment can't be silently replaced (that would let anyone holding the
  // app key take over a user's 2FA). Remove it first via a future admin/user flow.
  const existing = await c.env.DB.prepare("SELECT confirmed_at FROM totp_secrets WHERE app_id=? AND user_ref=?")
    .bind(app.id, p.data.user_ref).first<{ confirmed_at: number | null }>();
  if (existing?.confirmed_at) return c.json({ error: "already_enrolled" }, 409);

  const raw = crypto.getRandomValues(new Uint8Array(20)); // 160-bit secret (RFC 4226 §4 recommends ≥128)
  const secret = base32Encode(raw);
  await c.env.DB.prepare(
    `INSERT INTO totp_secrets (app_id,user_ref,secret_encrypted,last_used_step,created_at,confirmed_at) VALUES (?,?,?,NULL,?,NULL)
     ON CONFLICT(app_id,user_ref) DO UPDATE SET secret_encrypted=excluded.secret_encrypted, last_used_step=NULL, created_at=excluded.created_at`,
  ).bind(app.id, p.data.user_ref, await sealSecret(c.env.TOTP_KEY, raw, aadFor(app.id, p.data.user_ref)), nowS()).run();

  const url = otpauthUrl(issuer, p.data.user_ref, secret);
  return c.json({ secret, otpauth_url: url, qr_svg: renderSVG(url, { ecc: "M", border: 2 }) }, 201);
});

totp.post("/verify", async (c) => {
  const p = verifySchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "invalid_request" }, 400);
  const app = c.get("app");

  const refHash = (await hmacHex(c.env.OTP_PEPPER, `totp:${app.id}:${p.data.user_ref}`)).slice(0, 32);
  const rl = await hit(c.env.DB, [{ key: `t600:${refHash}`, limit: 10, window: 600 }]);
  if (!rl.ok) {
    c.header("Retry-After", String(rl.retryAfter));
    return c.json({ error: "rate_limited", retry_after: rl.retryAfter }, 429);
  }

  const row = await c.env.DB.prepare("SELECT secret_encrypted,last_used_step FROM totp_secrets WHERE app_id=? AND user_ref=?")
    .bind(app.id, p.data.user_ref).first<{ secret_encrypted: string; last_used_step: number | null }>();
  if (!row) return c.json({ valid: false, reason: "invalid_code" });

  const key = await openSecret(c.env.TOTP_KEY, row.secret_encrypted, aadFor(app.id, p.data.user_ref));
  const step = await matchStep(key, p.data.code, nowS());
  if (step === null) return c.json({ valid: false, reason: "invalid_code" });

  // Replay protection: the step must be newer than the last accepted one. Atomic, so two
  // simultaneous requests with the same code can't both pass.
  const r = await c.env.DB.prepare(
    `UPDATE totp_secrets SET last_used_step=?, confirmed_at=COALESCE(confirmed_at, ?)
     WHERE app_id=? AND user_ref=? AND (last_used_step IS NULL OR last_used_step < ?)`,
  ).bind(step, nowS(), app.id, p.data.user_ref, step).run();
  return r.meta.changes === 1 ? c.json({ valid: true }) : c.json({ valid: false, reason: "invalid_code" });
});
