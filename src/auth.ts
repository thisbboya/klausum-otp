import type { MiddlewareHandler } from "hono";
import type { Env } from "./index";
import { sha256Hex } from "./crypto";

export type AppRow = {
  id: string; name: string; allowed_origins: string[]; daily_cap: number;
  otp_ttl_seconds: number; sms_app_hash: string | null; status: string; display_name: string | null;
};
/** testMode: key is kotp_test_… — everything runs, but nothing is delivered. */
export type Vars = { app: AppRow; testMode: boolean };

// Small per-isolate cache: saves a D1 read (and ~5–20 ms) on most requests.
// Trade-off: pausing an app or revoking a key takes up to 10 s to apply everywhere.
const CACHE_MS = 10_000;
type Cached = { app: AppRow | null; keyId: string | null; expiresAt: number | null; until: number };
const cache = new Map<string, Cached>();
export const clearAuthCache = () => cache.clear();
const lastUsedWritten = new Map<string, number>();

export const requireApiKey: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  const m = /^Bearer (kotp_(?:live|test)_[A-Za-z0-9]{32})$/.exec(c.req.header("Authorization") ?? "");
  if (!m) return c.json({ error: "unauthorized" }, 401);
  const hash = await sha256Hex(m[1]);
  const nowS = Math.floor(Date.now() / 1000);

  let hitc = cache.get(hash);
  if (!hitc || hitc.until < Date.now()) {
    const row = await c.env.DB.prepare(
      `SELECT a.id,a.name,a.display_name,a.allowed_origins,a.daily_cap,a.otp_ttl_seconds,a.sms_app_hash,a.status,
              k.id AS key_id, k.expires_at
       FROM api_keys k JOIN apps a ON a.id = k.app_id
       WHERE k.key_hash=? AND k.revoked_at IS NULL`,
    ).bind(hash).first<Omit<AppRow, "allowed_origins"> & { allowed_origins: string; key_id: string; expires_at: number | null }>();
    hitc = row
      ? { app: { id: row.id, name: row.name, display_name: row.display_name, allowed_origins: JSON.parse(row.allowed_origins), daily_cap: row.daily_cap, otp_ttl_seconds: row.otp_ttl_seconds, sms_app_hash: row.sms_app_hash, status: row.status }, keyId: row.key_id, expiresAt: row.expires_at, until: Date.now() + CACHE_MS }
      : { app: null, keyId: null, expiresAt: null, until: Date.now() + CACHE_MS };
    cache.set(hash, hitc);
  }
  const app = hitc.app;
  if (!app || app.status !== "active" || (hitc.expiresAt !== null && hitc.expiresAt <= nowS)) return c.json({ error: "unauthorized" }, 401);

  // "Last used" for the dashboard: written at most once an hour per key, after responding.
  if (hitc.keyId && (lastUsedWritten.get(hitc.keyId) ?? 0) < nowS - 3600) {
    lastUsedWritten.set(hitc.keyId, nowS);
    c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE api_keys SET last_used_at=? WHERE id=?").bind(nowS, hitc.keyId).run().catch(() => {}));
  }

  // CORS: browser calls must come from an origin this app allows.
  const origin = c.req.header("Origin");
  if (origin) {
    if (!app.allowed_origins.includes(origin)) return c.json({ error: "origin_not_allowed" }, 403);
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
  }
  c.set("app", app);
  c.set("testMode", m[1].startsWith("kotp_test_"));
  await next();
};

/** Preflight: answer only for origins that at least one app allows. */
export const preflight: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (c.req.method !== "OPTIONS") return next();
  const origin = c.req.header("Origin") ?? "";
  const ok = origin && (await c.env.DB.prepare(
    "SELECT 1 FROM apps, json_each(apps.allowed_origins) j WHERE j.value=? AND apps.status='active' LIMIT 1",
  ).bind(origin).first());
  if (!ok) return c.body(null, 403);
  c.header("Access-Control-Allow-Origin", origin);
  c.header("Access-Control-Allow-Methods", "GET, POST");
  c.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  c.header("Access-Control-Max-Age", "600");
  c.header("Vary", "Origin");
  return c.body(null, 204);
};
