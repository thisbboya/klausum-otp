import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { newApiKey, newId, sha256Hex, timingSafeEqual } from "./crypto";
import { hit } from "./ratelimit";
import { buildStats } from "./stats";
import { hmacHex, mask, normaliseEmail, normalisePhone } from "./otp";
import { clearAuthCache } from "./auth";
import { readSession } from "./session";
import { enrollTotpCore } from "./cores";
import { dailySummary, notify, selfCheck } from "./monitor";
import { OWNER_REF, SYSTEM_APP } from "./admin-login";

export const admin = new Hono<{ Bindings: Env }>();
const nowS = () => Math.floor(Date.now() / 1000);

// Admin auth: either "Authorization: Bearer <ADMIN_TOKEN>" (CLI, scripts) compared in constant
// time, or a control-room session cookie (email code + authenticator login, see session.ts).
// Brute-force guard: 10 failed token attempts per IP per hour, then locked out for the hour.
admin.use("*", async (c, next) => {
  if (await readSession(c)) return next();
  const ip = (await sha256Hex(`adminip:${c.req.header("CF-Connecting-IP") ?? "unknown"}`)).slice(0, 32);
  const key = `adm1h:${ip}`;
  const now = nowS();
  const locked = await c.env.DB.prepare("SELECT count, window_start FROM rate_counters WHERE key=?")
    .bind(key).first<{ count: number; window_start: number }>();
  if (locked && locked.count >= 10 && now < locked.window_start + 3600) {
    c.header("Retry-After", String(locked.window_start + 3600 - now));
    return c.json({ error: "rate_limited" }, 429);
  }
  const got = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const want = c.env.ADMIN_TOKEN ?? "";
  if (!want || !timingSafeEqual(got, want)) {
    await hit(c.env.DB, [{ key, limit: 10, window: 3600 }], now);
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

const bad = (issues: z.ZodIssue[]) => ({ error: "invalid_request", issues: issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
const body = async (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => null);

// ---- apps ------------------------------------------------------------------
const origin = z.string().regex(/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i, "must be an origin like https://klausum.study");
const appFields = {
  display_name: z.string().min(1).max(40),
  allowed_origins: z.array(origin).max(20),
  daily_cap: z.number().int().min(1).max(10000),
  otp_ttl_seconds: z.number().int().min(60).max(600),
  sms_app_hash: z.string().regex(/^[A-Za-z0-9+/]{11}$/).nullable(),
};
const createApp = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, "lowercase letters, digits, dashes"),
  display_name: appFields.display_name.optional(),
  allowed_origins: appFields.allowed_origins.default([]),
  daily_cap: appFields.daily_cap.default(300),
  otp_ttl_seconds: appFields.otp_ttl_seconds.default(300),
  sms_app_hash: appFields.sms_app_hash.optional(),
  /** "test": key is kotp_test_…; codes are never delivered (for development and benchmarks). */
  mode: z.enum(["live", "test"]).default("live"),
}).strict();
const updateApp = z.object({ ...Object.fromEntries(Object.entries(appFields).map(([k, v]) => [k, v.optional()])), status: z.enum(["active", "paused"]).optional() }).strict();

async function insertKey(db: D1Database, appId: string, mode: "live" | "test") {
  const key = newApiKey(mode);
  const id = newId("key");
  return { key, id, stmt: db.prepare("INSERT INTO api_keys (id,app_id,key_hash,prefix,created_at) VALUES (?,?,?,?,?)").bind(id, appId, await sha256Hex(key), key.slice(0, 14), nowS()) };
}

admin.post("/apps", async (c) => {
  const p = createApp.safeParse(await body(c));
  if (!p.success) return c.json(bad(p.error.issues), 400);
  const a = p.data;
  const id = newId("app");
  const k = await insertKey(c.env.DB, id, a.mode);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO apps (id,name,display_name,api_key_hash,api_key_prefix,allowed_origins,daily_cap,otp_ttl_seconds,sms_app_hash,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).bind(id, a.name, a.display_name ?? null, `unused:${k.id}`, k.key.slice(0, 14), JSON.stringify(a.allowed_origins),
             a.daily_cap, a.otp_ttl_seconds, a.sms_app_hash ?? null, nowS()),
      k.stmt,
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) return c.json({ error: "name_taken" }, 409);
    throw e;
  }
  return c.json({ id, name: a.name, api_key: k.key, note: "Store this key now. It will never be shown again." }, 201);
});

admin.get("/apps", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT a.id,a.name,a.display_name,a.allowed_origins,a.daily_cap,a.otp_ttl_seconds,a.sms_app_hash,a.status,a.created_at,
            (SELECT MAX(last_used_at) FROM api_keys k WHERE k.app_id=a.id) AS key_last_used_at,
            (SELECT COUNT(*) FROM api_keys k WHERE k.app_id=a.id AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?)) AS active_keys
     FROM apps a WHERE a.id != 'app_system_admin' ORDER BY a.created_at`,
  ).bind(nowS()).all<Record<string, unknown> & { allowed_origins: string }>();
  return c.json({ apps: results.map((r) => ({ ...r, allowed_origins: JSON.parse(r.allowed_origins) })) });
});

admin.patch("/apps/:id", async (c) => {
  const p = updateApp.safeParse(await body(c));
  if (!p.success) return c.json(bad(p.error.issues), 400);
  const fields = Object.entries(p.data).filter(([, v]) => v !== undefined);
  if (!fields.length) return c.json({ error: "invalid_request", issues: ["nothing to change"] }, 400);
  const sets = fields.map(([k]) => `${k}=?`).join(", ");
  const vals = fields.map(([k, v]) => (k === "allowed_origins" ? JSON.stringify(v) : v));
  const r = await c.env.DB.prepare(`UPDATE apps SET ${sets} WHERE id=?`).bind(...vals, c.req.param("id")).run();
  if (!r.meta.changes) return c.json({ error: "not_found" }, 404);
  clearAuthCache();
  return c.json({ ok: true });
});

admin.delete("/apps/:id", async (c) => {
  const id = c.req.param("id");
  if (c.req.query("confirm") !== id) return c.json({ error: "confirm_required", hint: `add ?confirm=${id}` }, 400);
  const r = await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM otp_requests WHERE app_id=?").bind(id),
    c.env.DB.prepare("DELETE FROM totp_secrets WHERE app_id=?").bind(id),
    c.env.DB.prepare("DELETE FROM api_keys WHERE app_id=?").bind(id),
    c.env.DB.prepare("DELETE FROM apps WHERE id=?").bind(id),
  ]);
  if (!r[3].meta.changes) return c.json({ error: "not_found" }, 404);
  clearAuthCache();
  return c.json({ ok: true });
});

// ---- API keys --------------------------------------------------------------
admin.get("/apps/:id/keys", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id,prefix,created_at,expires_at,revoked_at,last_used_at FROM api_keys WHERE app_id=? ORDER BY created_at DESC",
  ).bind(c.req.param("id")).all();
  return c.json({ keys: results });
});

/** New key works immediately; every older active key keeps working for 24 h, then dies. */
admin.post("/apps/:id/keys/rotate", async (c) => {
  const id = c.req.param("id");
  const app = await c.env.DB.prepare("SELECT id FROM apps WHERE id=?").bind(id).first();
  if (!app) return c.json({ error: "not_found" }, 404);
  const mode = (await c.req.json().catch(() => ({})) as { mode?: string }).mode === "test" ? "test" : "live";
  const k = await insertKey(c.env.DB, id, mode);
  const graceUntil = nowS() + 86400;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE api_keys SET expires_at=? WHERE app_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)").bind(graceUntil, id, graceUntil),
    k.stmt,
  ]);
  clearAuthCache();
  return c.json({ api_key: k.key, key_id: k.id, old_keys_expire_at: graceUntil, note: "Store this key now. Old keys stop working in 24 hours." }, 201);
});

/** Revoke now: one key (body {key_id}) or every key of the app. Takes effect within 10 s everywhere. */
admin.post("/apps/:id/keys/revoke", async (c) => {
  const { key_id } = (await c.req.json().catch(() => ({}))) as { key_id?: string };
  const q = key_id
    ? c.env.DB.prepare("UPDATE api_keys SET revoked_at=? WHERE app_id=? AND id=? AND revoked_at IS NULL").bind(nowS(), c.req.param("id"), key_id)
    : c.env.DB.prepare("UPDATE api_keys SET revoked_at=? WHERE app_id=? AND revoked_at IS NULL").bind(nowS(), c.req.param("id"));
  const r = await q.run();
  clearAuthCache();
  return c.json({ revoked: r.meta.changes });
});

// ---- providers -------------------------------------------------------------
export type ProviderSettings = { email_order: ("resend" | "ahasend")[]; disabled: string[] };
export const DEFAULT_PROVIDERS: ProviderSettings = { email_order: ["resend", "ahasend"], disabled: [] };
const providerSchema = z.object({
  email_order: z.array(z.enum(["resend", "ahasend"])).min(1).max(2).refine((a) => new Set(a).size === a.length, "no duplicates"),
  disabled: z.array(z.enum(["resend", "ahasend", "textbee"])).max(3),
}).strict();

admin.get("/providers", async (c) => {
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key='providers'").first<{ value: string }>();
  return c.json(row ? JSON.parse(row.value) : DEFAULT_PROVIDERS);
});
admin.put("/providers", async (c) => {
  const p = providerSchema.safeParse(await body(c));
  if (!p.success) return c.json(bad(p.error.issues), 400);
  await c.env.DB.prepare("INSERT INTO settings (key,value,updated_at) VALUES ('providers',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .bind(JSON.stringify(p.data), nowS()).run();
  return c.json(p.data);
});

// ---- blocklist -------------------------------------------------------------
/** Hash used for blocked phones/emails/IPs — must match the one send() computes. */
export const blockHash = (pepper: string, kind: "phone" | "email" | "ip", value: string) => hmacHex(pepper, `block:${kind}:${value}`);

const blockSchema = z.object({ kind: z.enum(["phone", "email", "domain", "ip"]), value: z.string().min(2).max(254), note: z.string().max(200).optional() }).strict();

async function normaliseBlock(pepper: string, kind: string, raw: string): Promise<{ value: string; label: string } | null> {
  if (kind === "domain") {
    const d = raw.trim().toLowerCase().replace(/^@/, "");
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? { value: d, label: d } : null;
  }
  if (kind === "email") { const e = normaliseEmail(raw); return e ? { value: await blockHash(pepper, "email", e), label: mask(e) } : null; }
  if (kind === "phone") { const p = normalisePhone(raw); return p ? { value: await blockHash(pepper, "phone", p), label: mask(p) } : null; }
  const ip = raw.trim();
  return /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{2,39})$/i.test(ip) ? { value: await blockHash(pepper, "ip", ip), label: ip.replace(/[\d]+$/, "x").replace(/:[0-9a-f]+$/i, ":x") } : null;
}

admin.get("/blocklist", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT kind,value,label,note,created_at FROM blocklist ORDER BY created_at DESC").all();
  return c.json({ entries: results });
});
admin.post("/blocklist", async (c) => {
  const p = blockSchema.safeParse(await body(c));
  if (!p.success) return c.json(bad(p.error.issues), 400);
  const n = await normaliseBlock(c.env.OTP_PEPPER, p.data.kind, p.data.value);
  if (!n) return c.json({ error: "invalid_request", issues: [`value: not a valid ${p.data.kind}`] }, 400);
  await c.env.DB.prepare("INSERT INTO blocklist (kind,value,label,note,created_at) VALUES (?,?,?,?,?) ON CONFLICT(kind,value) DO UPDATE SET note=excluded.note")
    .bind(p.data.kind, n.value, n.label, p.data.note ?? null, nowS()).run();
  return c.json({ kind: p.data.kind, value: n.value, label: n.label }, 201);
});
admin.delete("/blocklist/:kind/:value", async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM blocklist WHERE kind=? AND value=?").bind(c.req.param("kind"), c.req.param("value")).run();
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

// ---- logs ------------------------------------------------------------------
const logQuery = z.object({
  request_id: z.string().regex(/^otp_[A-Za-z0-9]{24}$/).optional(),
  app: z.string().max(64).optional(),
  channel: z.enum(["email", "sms"]).optional(),
  status: z.enum(["sent", "failed"]).optional(),
  provider: z.string().regex(/^[a-z]{2,20}$/).optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
admin.get("/logs", async (c) => {
  const p = logQuery.safeParse(c.req.query());
  if (!p.success) return c.json(bad(p.error.issues), 400);
  const q = p.data, where: string[] = [], binds: (string | number)[] = [];
  if (q.request_id) { where.push("l.otp_request_id=?"); binds.push(q.request_id); }
  if (q.app) { where.push("(a.id=? OR a.name=?)"); binds.push(q.app, q.app); }
  if (q.channel) { where.push("l.channel=?"); binds.push(q.channel); }
  if (q.status) { where.push("l.status=?"); binds.push(q.status); }
  if (q.provider) { where.push("l.provider=?"); binds.push(q.provider); }
  if (q.from) { where.push("l.created_at>=?"); binds.push(q.from); }
  if (q.to) { where.push("l.created_at<=?"); binds.push(q.to); }
  const { results } = await c.env.DB.prepare(
    `SELECT l.created_at,l.otp_request_id AS request_id,a.name AS app,l.channel,l.provider,l.status,l.error,l.latency_ms
     FROM delivery_logs l LEFT JOIN apps a ON a.id=l.app_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY l.created_at DESC LIMIT ?`,
  ).bind(...binds, q.limit).all();
  return c.json({ logs: results }); // recipients are never in logs
});

admin.get("/stats", async (c) => c.json(await buildStats(c.env.DB)));

// ---- owner authenticator (control-room 2nd factor) ---------------------------
// Needs the ADMIN_TOKEN itself (a control-room session is NOT enough), so a stolen
// session can never swap in the attacker's own authenticator. {reset:true} replaces a lost one.
admin.post("/owner-totp/enroll", async (c) => {
  if (!(c.req.header("Authorization") ?? "").startsWith("Bearer ")) return c.json({ error: "token_required" }, 403);
  const { reset } = (await c.req.json().catch(() => ({}))) as { reset?: boolean };
  if (reset) await c.env.DB.prepare("DELETE FROM totp_secrets WHERE app_id=? AND user_ref=?").bind(SYSTEM_APP, OWNER_REF).run();
  const r = await enrollTotpCore(c.env, SYSTEM_APP, OWNER_REF, "Klausum OTP admin");
  if ("alreadyEnrolled" in r) return c.json({ error: "already_enrolled", hint: "send {\"reset\":true} to replace it" }, 409);
  return c.json({ otpauth_url: r.otpauthUrl, qr_svg: r.qrSvg, secret: r.secret }, 201);
});

// ---- monitoring (run on demand from the control room / CLI) --------------------
admin.post("/monitor/check", async (c) => c.json(await selfCheck(c.env)));
admin.post("/monitor/test-alert", async (c) => c.json(await notify(c.env, "Klausum OTP: test alert", "If you can read this, alerts reach you. ✅")));
admin.post("/monitor/daily-summary", async (c) => c.json(await dailySummary(c.env)));

// ---- secret ages -----------------------------------------------------------------
/** Record that a secret was just rotated (resets its 180-day clock). */
admin.post("/secrets/rotated", async (c) => {
  const p = z.object({ name: z.string().regex(/^[A-Z0-9_]{3,40}( \(GitHub\))?$/) }).strict().safeParse(await body(c));
  if (!p.success) return c.json(bad(p.error.issues), 400);
  const now = nowS();
  await c.env.DB.prepare("INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .bind(`secret:${p.data.name}`, String(now), now).run();
  return c.json({ name: p.data.name, setAt: now });
});
