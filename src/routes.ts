import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { preflight, requireApiKey, type AppRow, type Vars } from "./auth";
import { randomString } from "./crypto";
import { counterStatements, evaluate, withinLimitsSql } from "./ratelimit";
import { deliver } from "./delivery";
import { checkEmail } from "./email-check";
import { statStmt } from "./stats";
import { verifyOtpCore } from "./cores";
import { blockHash } from "./admin";
import {
  MAX_ATTEMPTS, codeHash, decryptRecipient, encryptRecipient, generateCode, hmacHex,
  normaliseEmail, normalisePhone, recipientHash,
} from "./otp";

type C = Context<{ Bindings: Env; Variables: Vars }>;
export const v1 = new Hono<{ Bindings: Env; Variables: Vars }>();
v1.use("*", preflight);
v1.use("*", requireApiKey);

const RESEND_AFTER = 30;

/**
 * The person's IP for the per-IP limit. Apps that call us from their own server (as they
 * should) pass their user's IP in X-End-User-IP; otherwise every user of that app would
 * share the server's IP and hit the limit together. Only well-formed IPs are accepted.
 * (A misbehaving app could vary it, but it's still bound by recipient + app daily caps.)
 */
const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{2,39})$/i;
function rawIp(c: C): string {
  const fwd = c.req.header("X-End-User-IP")?.trim();
  return fwd && IP_RE.test(fwd) ? fwd : c.req.header("CF-Connecting-IP") ?? "unknown";
}
function endUserIp(c: C): string {
  const fwd = c.req.header("X-End-User-IP")?.trim();
  return fwd && IP_RE.test(fwd) ? `user:${fwd}` : c.req.header("CF-Connecting-IP") ?? "unknown";
}
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
  const ipHash = (await hmacHex(pepper, `ip:${endUserIp(c)}`)).slice(0, 32);

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
  // Blocklist (admin-managed): this person, their email domain (and parent domains), their IP.
  const domains = channel === "email" ? to.slice(to.indexOf("@") + 1).split(".").map((_, i, a) => a.slice(i).join(".")).filter((d) => d.includes(".")) : [];
  const [bRcpt, bIp] = await Promise.all([blockHash(pepper, channel === "email" ? "email" : "phone", to), blockHash(pepper, "ip", rawIp(c))]);
  const blockedSql = `EXISTS (SELECT 1 FROM blocklist WHERE (kind=? AND value=?) OR (kind='ip' AND value=?)${domains.length ? ` OR (kind='domain' AND value IN (${domains.map(() => "?").join(",")}))` : ""})`;
  const blockedBinds = [channel === "email" ? "email" : "phone", bRcpt, bIp, ...domains];
  const lim = withinLimitsSql(rules);
  const ok = { sql: `${lim.sql} AND NOT ${blockedSql}`, binds: [...lim.binds, ...blockedBinds] };
  const t0 = Date.now();
  const res = await c.env.DB.batch([
    ...counterStatements(c.env.DB, rules, now),
    c.env.DB.prepare(`SELECT ${blockedSql} AS blocked`).bind(...blockedBinds),
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
  if ((res[rules.length].results[0] as { blocked: number }).blocked) return c.json({ error: "blocked" }, 403);
  const rl = evaluate(rules, res, now);
  if (!rl.ok) return limited(c, rl.retryAfter);

  // Respond now; deliver after the response is sent.
  c.executionCtx.waitUntil(
    (c.get("testMode") ? markTest(c.env, id) : deliver(c.env, { requestId: id, appId: app.id, appName: app.display_name ?? app.name, channel, to, code, ttl, smsAppHash: app.sms_app_hash, fallbackEmail }))
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
  // Only real mailboxes: no disposable/temporary providers, and the domain must receive mail.
  // (Test keys skip only the DNS part, so benchmarks can use made-up domains.)
  const dns = c.env.EMAIL_DNS_CHECK !== "off" && !c.get("testMode");
  for (const addr of [channel === "email" ? to : null, fallback]) {
    if (!addr) continue;
    const v = await checkEmail(addr, { dns });
    if (!v.ok) return c.json({ error: "email_not_allowed", reason: v.reason }, 400);
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
  const t0 = Date.now();
  const v = await verifyOtpCore(c.env, c.get("app").id, p.data.request_id, p.data.code); // ONE D1 round trip
  c.header("Server-Timing", `db;dur=${Date.now() - t0}`, { append: true });
  if ("rateLimited" in v) return limited(c, v.retryAfter);
  // Count the outcome for the dashboard (after responding; never slows the answer).
  c.executionCtx.waitUntil(statStmt(c.env.DB, v.valid ? "verify:ok" : "verify:fail").run().catch(() => {}));
  return v.valid ? c.json({ valid: true }) : fail(c, v.reason, v.attemptsLeft);
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
