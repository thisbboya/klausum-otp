import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { preflight, requireApiKey, type AppRow, type Vars } from "./auth";
import { randomString } from "./crypto";
import { counterStatements, evaluate, withinLimitsSql } from "./ratelimit";
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
  /** SMS only: where to send the code if SMS delivery fails (e.g. textbee phone offline). */
  fallback_email: z.string().max(254).optional(),
}).strict();

/** Shared by /send and /resend. Rate limit → invalidate old → insert → respond; deliver in background. */
async function issue(c: C, app: AppRow, channel: "email" | "sms", to: string, purpose: string, fallbackEmail: string | null = null) {
  const pepper = c.env.OTP_PEPPER;
  const now = nowS();
  const rh = await recipientHash(pepper, app.id, to);
  const ipHash = (await hmacHex(pepper, `ip:${c.req.header("CF-Connecting-IP") ?? "unknown"}`)).slice(0, 32);

  const rules = [
    { key: `r30:${rh}`, limit: 1, window: 30 },
    { key: `r600:${rh}`, limit: 3, window: 600 },
    { key: `r1d:${rh}`, limit: 10, window: 86400 },
    // Test keys can't deliver anything, so they skip the per-IP limit (lets us benchmark).
    ...(c.get("testMode") ? [] : [{ key: `ip1h:${ipHash}`, limit: 20, window: 3600 }]),
    { key: `app1d:${app.id}`, limit: app.daily_cap, window: 86400 },
  ];
  // Prepare everything first (cheap, local), then ONE D1 round trip:
  // counters → (if within limits) invalidate old codes → (if within limits) insert new code.
  const code = generateCode();
  const id = `otp_${randomString(24)}`;
  const ttl = app.otp_ttl_seconds;
  const [enc, ch] = await Promise.all([
    encryptRecipient(pepper, fallbackEmail ? `${to}\n${fallbackEmail}` : to),
    codeHash(pepper, app.id, id, code),
  ]);
  const ok = withinLimitsSql(rules);
  const t0 = Date.now();
  const res = await c.env.DB.batch([
    ...counterStatements(c.env.DB, rules, now),
    // Rule 7: a new code kills every older live code for this recipient.
    c.env.DB.prepare(
      `UPDATE otp_requests SET status='invalidated'
       WHERE app_id=? AND recipient_hash=? AND used_at IS NULL AND status IN ('queued','sent','delivered') AND ${ok.sql}`,
    ).bind(app.id, rh, ...ok.binds),
    c.env.DB.prepare(
      `INSERT INTO otp_requests (id,app_id,recipient_hash,recipient_enc,channel,code_hash,expires_at,purpose,created_at)
       SELECT ?,?,?,?,?,?,?,?,? WHERE ${ok.sql}`,
    ).bind(id, app.id, rh, enc, channel, ch, now + ttl, purpose, now, ...ok.binds),
  ]);
  c.header("Server-Timing", `db;dur=${Date.now() - t0}`, { append: true });
  const rl = evaluate(rules, res, now);
  if (!rl.ok) return limited(c, rl.retryAfter);

  // Respond now; deliver after the response is sent.
  c.executionCtx.waitUntil(
    (c.get("testMode") ? markTest(c.env, id) : deliver(c.env, { requestId: id, appName: app.display_name ?? app.name, channel, to, code, ttl, smsAppHash: app.sms_app_hash, fallbackEmail }))
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
  let fallback: string | null = null;
  if (p.data.fallback_email !== undefined) {
    if (channel !== "sms") return bad(c);
    fallback = normaliseEmail(p.data.fallback_email);
    if (!fallback) return bad(c);
  }
  return issue(c, c.get("app"), channel, to, purpose, fallback);
});

/** Test-key requests: record a fake successful delivery, send nothing. */
const markTest = (env: Env, id: string) =>
  env.DB.prepare("UPDATE otp_requests SET status='sent', provider='test' WHERE id=? AND status='queued'").bind(id).run();

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
  const now = nowS();
  // The code hash binds app + request + code, so we can compute the expected hash
  // BEFORE reading anything and do the whole verify in ONE D1 round trip:
  //   1. bump the per-recipient verify counter
  //   2. if code matches (and live, unused, within limits) → mark used          (single use)
  //   3. if code doesn't match (and live, within limits)  → attempts + 1        (attempt limit)
  //   4. read the row's final state to pick the answer
  // Statements run in order inside one transaction, so two concurrent verifies of the same
  // code can't both succeed. The hash comparison happens in SQL; the values are HMACs the
  // caller can't steer byte-by-byte, so equality timing reveals nothing useful.
  const expected = await codeHash(c.env.OTP_PEPPER, app.id, p.data.request_id, p.data.code);
  const live = `id=?1 AND app_id=?2 AND used_at IS NULL AND status!='invalidated' AND attempts < ${MAX_ATTEMPTS} AND expires_at > ?3
    AND (SELECT count FROM rate_counters WHERE key = 'v600:' || otp_requests.recipient_hash) <= 10`;
  const t0 = Date.now();
  const [counter, ok, bump, state] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO rate_counters (key, count, window_start)
         VALUES ('v600:' || COALESCE((SELECT recipient_hash FROM otp_requests WHERE id=?1 AND app_id=?2), 'unknown'), 1, ?3)
       ON CONFLICT(key) DO UPDATE SET
         count        = CASE WHEN ?3 < rate_counters.window_start + 600 THEN rate_counters.count + 1 ELSE 1 END,
         window_start = CASE WHEN ?3 < rate_counters.window_start + 600 THEN rate_counters.window_start ELSE ?3 END
       RETURNING count, window_start`,
    ).bind(p.data.request_id, app.id, now),
    c.env.DB.prepare(`UPDATE otp_requests SET used_at=?3, recipient_enc=NULL WHERE ${live} AND code_hash=?4 RETURNING 1 AS ok`)
      .bind(p.data.request_id, app.id, now, expected),
    c.env.DB.prepare(`UPDATE otp_requests SET attempts=attempts+1 WHERE ${live} AND code_hash!=?4 RETURNING attempts`)
      .bind(p.data.request_id, app.id, now, expected),
    c.env.DB.prepare("SELECT used_at, status, attempts, expires_at FROM otp_requests WHERE id=? AND app_id=?")
      .bind(p.data.request_id, app.id),
  ]);
  c.header("Server-Timing", `db;dur=${Date.now() - t0}`, { append: true });

  if (ok.results.length === 1) return c.json({ valid: true });
  const row = state.results[0] as Pick<OtpRow, "used_at" | "status" | "attempts" | "expires_at"> | undefined;
  // Unknown / other app's / used / replaced → same answer, reveals nothing.
  if (!row || row.used_at !== null || row.status === "invalidated") return fail(c, "invalid_code");
  const rl = evaluate([{ key: "", limit: 10, window: 600 }], [counter], now);
  if (!rl.ok) return limited(c, rl.retryAfter);
  const bumped = bump.results[0] as { attempts: number } | undefined;
  if (bumped) {
    const left = Math.max(0, MAX_ATTEMPTS - bumped.attempts);
    return left === 0 ? fail(c, "too_many_attempts", 0) : fail(c, "invalid_code", left);
  }
  if (row.attempts >= MAX_ATTEMPTS) return fail(c, "too_many_attempts", 0);
  if (row.expires_at <= now) return fail(c, "expired");
  return fail(c, "invalid_code");
});

// ---------------------------------------------------------------------------
v1.post("/otp/resend", async (c) => {
  const p = await body(c, z.object({ request_id: reqId }).strict());
  if (!p.success) return bad(c);
  const row = await load(c, p.data.request_id);
  if (!row || row.used_at !== null || !row.recipient_enc) return c.json({ error: "not_found" }, 404);
  const [to, fallback] = (await decryptRecipient(c.env.OTP_PEPPER, row.recipient_enc)).split("\n");
  return issue(c, c.get("app"), row.channel, to, row.purpose, fallback || null);
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
