import type { MiddlewareHandler } from "hono";
import type { Env } from "./index";
import { sha256Hex } from "./crypto";

export type AppRow = {
  id: string; name: string; allowed_origins: string[]; daily_cap: number;
  otp_ttl_seconds: number; sms_app_hash: string | null; status: string; display_name: string | null;
};
export type Vars = { app: AppRow };

// Small per-isolate cache: saves a D1 read (and ~5–20 ms) on most requests.
// Trade-off: pausing an app or revoking a key takes up to 60 s to apply everywhere.
const CACHE_MS = 60_000;
const cache = new Map<string, { app: AppRow | null; until: number }>();
export const clearAuthCache = () => cache.clear();

export const requireApiKey: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  const m = /^Bearer (kotp_(?:live|test)_[A-Za-z0-9]{32})$/.exec(c.req.header("Authorization") ?? "");
  if (!m) return c.json({ error: "unauthorized" }, 401);
  const hash = await sha256Hex(m[1]);

  let hitc = cache.get(hash);
  if (!hitc || hitc.until < Date.now()) {
    const row = await c.env.DB.prepare(
      "SELECT id,name,display_name,allowed_origins,daily_cap,otp_ttl_seconds,sms_app_hash,status FROM apps WHERE api_key_hash=?",
    ).bind(hash).first<Omit<AppRow, "allowed_origins"> & { allowed_origins: string }>();
    hitc = { app: row ? { ...row, allowed_origins: JSON.parse(row.allowed_origins) } : null, until: Date.now() + CACHE_MS };
    cache.set(hash, hitc);
  }
  const app = hitc.app;
  if (!app || app.status !== "active") return c.json({ error: "unauthorized" }, 401);

  // CORS: browser calls must come from an origin this app allows.
  const origin = c.req.header("Origin");
  if (origin) {
    if (!app.allowed_origins.includes(origin)) return c.json({ error: "origin_not_allowed" }, 403);
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
  }
  c.set("app", app);
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
