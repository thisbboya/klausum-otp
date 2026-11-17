import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { preflight, requireApiKey, type AppRow, type Vars } from "./auth";
import { randomString, timingSafeEqual } from "./crypto";
import { hit } from "./ratelimit";
import { deliver } from "./delivery";
import {
  MAX_ATTEMPTS, codeHash, decryptRecipient, encryptRecipient, generateCode, hmacHex,
  normaliseEmail, normalisePhone, recipientHash,
} from "./otp";

type C = Context<{ Bindings: Env; Variables: Vars }>;
export const v1 = new Hono<{ Bindings: Env; Variables: Vars }>();
v1.use("*", preflight);
v1.use("*", requireApiKey);

const RESEND_AFTER = 30;
const nowS = () => Math.floor(Date.now() / 1000);
const bad = (c: C) => c.json({ error: "invalid_request" }, 400);
const limited = (c: C, retryAfter: number) => {
  c.header("Retry-After", String(retryAfter));
  return c.json({ error: "rate_limited", retry_after: retryAfter }, 429);
};
const body = async <T extends z.ZodTypeAny>(c: C, schema: T) => schema.safeParse(await c.req.json().catch(() => null));

// ---------------------------------------------------------------------------
const sendSchema = z.object({
  channel: z.enum(["email", "sms"]),
  to: z.string().min(3).max(254),
  purpose: z.string().regex(/^[a-z_]{1,32}$/).default("login"),
  locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).default("en"),
}).strict();

/** Shared by /send and /resend. Rate limit → invalidate old → insert → respond; deliver in background. */
async function issue(c: C, app: AppRow, channel: "email" | "sms", to: string, purpose: string) {
  const pepper = c.env.OTP_PEPPER;
  const now = nowS();
  const rh = await recipientHash(pepper, app.id, to);
  const ipHash = (await hmacHex(pepper, `ip:${c.req.header("CF-Connecting-IP") ?? "unknown"}`)).slice(0, 32);

  const t0 = Date.now();
  const rl = await hit(c.env.DB, [
    { key: `r30:${rh}`, limit: 1, window: 30 },
    { key: `r600:${rh}`, limit: 3, window: 600 },
    { key: `r1d:${rh}`, limit: 10, window: 86400 },
    { key: `ip1h:${ipHash}`, limit: 20, window: 3600 },
    { key: `app1d:${app.id}`, limit: app.daily_cap, window: 86400 },
  ], now);
  if (!rl.ok) return limited(c, rl.retryAfter);

  const code = generateCode();
  const id = `otp_${randomString(24)}`;
  const ttl = app.otp_ttl_seconds;
  await c.env.DB.batch([
    // Rule 7: a new code kills every older live code for this recipient.
    c.env.DB.prepare(
      "UPDATE otp_requests SET status='invalidated' WHERE app_id=? AND recipient_hash=? AND used_at IS NULL AND status IN ('queued','sent','delivered')",
    ).bind(app.id, rh),
    c.env.DB.prepare(
      `INSERT INTO otp_requests (id,app_id,recipient_hash,recipient_enc,channel,code_hash,expires_at,purpose,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(id, app.id, rh, await encryptRecipient(pepper, to), channel, await codeHash(pepper, app.id, rh, code), now + ttl, purpose, now),
  ]);
  c.header("Server-Timing", `db;dur=${Date.now() - t0}`, { append: true });

  // Respond now; deliver after the response is sent.
  c.executionCtx.waitUntil(
    deliver(c.env, { requestId: id, appName: app.name, channel, to, code, ttl, smsAppHash: app.sms_app_hash })
      .catch((e) => console.error("deliver failed", id, String(e))),
  );
  return c.json({ request_id: id, channel, expires_in: ttl, resend_after: RESEND_AFTER }, 202);
}

v1.post("/otp/send", async (c) => {
  const p = await body(c, sendSchema);
  if (!p.success) return bad(c);
  const { channel, purpose } = p.data;
  const to = channel === "email" ? normaliseEmail(p.data.to) : normalisePhone(p.data.to);
  if (!to) return bad(c);
  return issue(c, c.get("app"), channel, to, purpose);
});

// ---------------------------------------------------------------------------
type OtpRow = {
  id: string; app_id: string; recipient_hash: string; recipient_enc: string | null; channel: "email" | "sms";
  code_hash: string; expires_at: number; attempts: number; used_at: number | null; status: string;
  provider: string | null; purpose: string;
};
const reqId = z.string().regex(/^otp_[A-Za-z0-9]{24}$/);
const load = (c: C, id: string) =>
  c.env.DB.prepare("SELECT * FROM otp_requests WHERE id=? AND app_id=?").bind(id, c.get("app").id).first<OtpRow>();

const verifySchema = z.object({ request_id: reqId, code: z.string().regex(/^\d{6}$/) }).strict();
const fail = (c: C, reason: "invalid_code" | "expired" | "too_many_attempts", attemptsLeft?: number) =>
  c.json({ valid: false, reason, ...(attemptsLeft !== undefined ? { attempts_left: attemptsLeft } : {}) }, 200);

v1.post("/otp/verify", async (c) => {
  const p = await body(c, verifySchema);
  if (!p.success) return bad(c);
  const app = c.get("app");
  const row = await load(c, p.data.request_id);
  // Unknown / other app's / used / replaced → same answer, reveals nothing.
  if (!row || row.used_at !== null || row.status === "invalidated") return fail(c, "invalid_code");

  const rl = await hit(c.env.DB, [{ key: `v600:${row.recipient_hash}`, limit: 10, window: 600 }]);
  if (!rl.ok) return limited(c, rl.retryAfter);

  if (row.attempts >= MAX_ATTEMPTS) return fail(c, "too_many_attempts", 0);
  if (row.expires_at <= nowS()) return fail(c, "expired");

  const expected = await codeHash(c.env.OTP_PEPPER, app.id, row.recipient_hash, p.data.code);
  if (timingSafeEqual(expected, row.code_hash)) {
    // Single use: only one concurrent verify can flip used_at.
    const r = await c.env.DB.prepare(
      "UPDATE otp_requests SET used_at=?, recipient_enc=NULL WHERE id=? AND used_at IS NULL AND attempts < ?",
    ).bind(nowS(), row.id, MAX_ATTEMPTS).run();
    return r.meta.changes === 1 ? c.json({ valid: true }) : fail(c, "invalid_code");
  }
  const upd = await c.env.DB.prepare("UPDATE otp_requests SET attempts=attempts+1 WHERE id=? RETURNING attempts")
    .bind(row.id).first<{ attempts: number }>();
  const left = Math.max(0, MAX_ATTEMPTS - (upd?.attempts ?? MAX_ATTEMPTS));
  return left === 0 ? fail(c, "too_many_attempts", 0) : fail(c, "invalid_code", left);
});

// ---------------------------------------------------------------------------
v1.post("/otp/resend", async (c) => {
  const p = await body(c, z.object({ request_id: reqId }).strict());
  if (!p.success) return bad(c);
  const row = await load(c, p.data.request_id);
  if (!row || row.used_at !== null || !row.recipient_enc) return c.json({ error: "not_found" }, 404);
  const to = await decryptRecipient(c.env.OTP_PEPPER, row.recipient_enc);
  return issue(c, c.get("app"), row.channel, to, row.purpose);
});

v1.get("/otp/status/:id", async (c) => {
  const id = reqId.safeParse(c.req.param("id"));
  if (!id.success) return bad(c);
  const row = await load(c, id.data);
  if (!row) return c.json({ error: "not_found" }, 404);
  const status = row.status === "invalidated" ? "sent" : row.status; // delivery status only
  return c.json({ request_id: row.id, channel: row.channel, status, provider: row.provider });
});

// Daily cleanup (cron). Keeps D1 small and inside free limits.
export async function cleanup(env: Env) {
  const now = nowS();
  await env.DB.batch([
    env.DB.prepare("UPDATE otp_requests SET recipient_enc=NULL WHERE recipient_enc IS NOT NULL AND expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM otp_requests WHERE created_at < ?").bind(now - 86400),
    env.DB.prepare("DELETE FROM delivery_logs WHERE created_at < ?").bind(now - 30 * 86400),
    env.DB.prepare("DELETE FROM rate_counters WHERE window_start < ?").bind(now - 2 * 86400),
  ]);
}
