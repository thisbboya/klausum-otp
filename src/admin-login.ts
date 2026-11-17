/**
 * Control-room login: email code (to ADMIN_EMAIL) + authenticator code (owner's TOTP).
 * Both must be right → 12-hour HttpOnly session cookie (see session.ts).
 *
 *  POST /auth/admin/start   { email }                         → 202 { request_id } (same answer for any email)
 *  POST /auth/admin/verify  { request_id, code, totp }        → 200 + cookie, or 401 { error: "invalid" }
 *  POST /auth/admin/logout
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { randomString, timingSafeEqual } from "./crypto";
import { codeHash, encryptRecipient, generateCode, hmacHex, normaliseEmail, recipientHash } from "./otp";
import { hit } from "./ratelimit";
import { deliver } from "./delivery";
import { verifyOtpCore, verifyTotpCore } from "./cores";
import { endSession, issueSession } from "./session";

export const SYSTEM_APP = "app_system_admin";
export const OWNER_REF = "owner";
const nowS = () => Math.floor(Date.now() / 1000);

export const adminLogin = new Hono<{ Bindings: Env }>();

async function ipLimited(env: Env, ip: string, bucket: string, limit: number) {
  const key = `${bucket}:${(await hmacHex(env.OTP_PEPPER, `adminlogin:${ip}`)).slice(0, 32)}`;
  return hit(env.DB, [{ key, limit, window: 900 }]);
}

adminLogin.post("/start", async (c) => {
  const p = z.object({ email: z.string().max(254) }).strict().safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "invalid_request" }, 400);
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const rl = await ipLimited(c.env, ip, "als15", 5);
  if (!rl.ok) { c.header("Retry-After", String(rl.retryAfter)); return c.json({ error: "rate_limited" }, 429); }

  const id = `otp_${randomString(24)}`;
  const email = normaliseEmail(p.data.email);
  const owner = c.env.ADMIN_EMAIL ? normaliseEmail(c.env.ADMIN_EMAIL) : null;
  // Only the owner's address gets a code; everyone else gets an identical-looking answer.
  if (email && owner && timingSafeEqual(email, owner)) {
    const code = generateCode();
    const now = nowS();
    const rh = await recipientHash(c.env.OTP_PEPPER, SYSTEM_APP, email);
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE otp_requests SET status='invalidated' WHERE app_id=? AND recipient_hash=? AND used_at IS NULL").bind(SYSTEM_APP, rh),
      c.env.DB.prepare(`INSERT INTO otp_requests (id,app_id,recipient_hash,recipient_enc,channel,code_hash,expires_at,purpose,created_at)
                        VALUES (?,?,?,?, 'email',?,?, 'admin_login',?)`)
        .bind(id, SYSTEM_APP, rh, await encryptRecipient(c.env.OTP_PEPPER, email), await codeHash(c.env.OTP_PEPPER, SYSTEM_APP, id, code), now + 300, now),
    ]);
    c.executionCtx.waitUntil(deliver(c.env, { requestId: id, appId: SYSTEM_APP, appName: "Klausum OTP admin", channel: "email", to: email, code, ttl: 300, smsAppHash: null }).catch(() => {}));
  }
  return c.json({ request_id: id }, 202);
});

adminLogin.post("/verify", async (c) => {
  const p = z.object({
    request_id: z.string().regex(/^otp_[A-Za-z0-9]{24}$/),
    code: z.string().regex(/^\d{6}$/),
    totp: z.string().regex(/^\d{6}$/),
  }).strict().safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "invalid_request" }, 400);
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const rl = await ipLimited(c.env, ip, "alv15", 10);
  if (!rl.ok) { c.header("Retry-After", String(rl.retryAfter)); return c.json({ error: "rate_limited" }, 429); }

  // Both factors are always checked (no early exit that would hint which one was wrong).
  const [emailOk, totpOk] = await Promise.all([
    verifyOtpCore(c.env, SYSTEM_APP, p.data.request_id, p.data.code),
    verifyTotpCore(c.env, SYSTEM_APP, OWNER_REF, p.data.totp),
  ]);
  const good = "valid" in emailOk && emailOk.valid && "valid" in totpOk && totpOk.valid;
  if (!good) return c.json({ error: "invalid" }, 401);
  await issueSession(c);
  return c.json({ ok: true });
});

adminLogin.post("/logout", (c) => {
  endSession(c);
  return c.json({ ok: true });
});
