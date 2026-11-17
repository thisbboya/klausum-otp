import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { newApiKey, newId, sha256Hex, timingSafeEqual } from "./crypto";

export const admin = new Hono<{ Bindings: Env }>();

// Admin auth: "Authorization: Bearer <ADMIN_TOKEN>", compared in constant time.
admin.use("*", async (c, next) => {
  const got = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const want = c.env.ADMIN_TOKEN ?? "";
  if (!want || !timingSafeEqual(got, want)) return c.json({ error: "unauthorized" }, 401);
  await next();
});

const origin = z.string().regex(/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i, "must be an origin like https://klausum.study");
const createApp = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, "lowercase letters, digits, dashes"),
    display_name: z.string().min(1).max(40).optional(),
    allowed_origins: z.array(origin).max(20).default([]),
    daily_cap: z.number().int().min(1).max(10000).default(300),
    otp_ttl_seconds: z.number().int().min(60).max(600).default(300),
    sms_app_hash: z.string().regex(/^[A-Za-z0-9+/]{11}$/).optional(),
  })
  .strict();

admin.post("/apps", async (c) => {
  const parsed = createApp.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid_request", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
  }
  const a = parsed.data;
  const id = newId("app");
  const key = newApiKey("live");
  const now = Math.floor(Date.now() / 1000);
  try {
    await c.env.DB.prepare(
      `INSERT INTO apps (id,name,display_name,api_key_hash,api_key_prefix,allowed_origins,daily_cap,otp_ttl_seconds,sms_app_hash,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(id, a.name, a.display_name ?? null, await sha256Hex(key), key.slice(0, 14), JSON.stringify(a.allowed_origins),
            a.daily_cap, a.otp_ttl_seconds, a.sms_app_hash ?? null, now)
      .run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) return c.json({ error: "name_taken" }, 409);
    throw e;
  }
  return c.json({ id, name: a.name, api_key: key, note: "Store this key now. It will never be shown again." }, 201);
});

admin.get("/apps", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id,name,api_key_prefix,allowed_origins,daily_cap,otp_ttl_seconds,sms_app_hash,status,key_last_used_at,created_at
     FROM apps ORDER BY created_at`
  ).all<Record<string, unknown> & { allowed_origins: string }>();
  return c.json({ apps: results.map((r) => ({ ...r, allowed_origins: JSON.parse(r.allowed_origins) })) });
});
