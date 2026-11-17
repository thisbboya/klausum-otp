/**
 * The actions the control room and the AI assistant can take. Each maps 1:1 onto the same
 * database logic the admin API uses. SAFE_TOOLS may be run by the assistant on its own
 * (reads, plus two protective, easily undone writes); everything else needs the owner's tap.
 */
import type { Env } from "./index";
import { buildStats } from "./stats";
import { blockHash, DEFAULT_PROVIDERS, type ProviderSettings } from "./admin";
import { mask, normaliseEmail, normalisePhone } from "./otp";
import { newApiKey, newId, sha256Hex } from "./crypto";
import { clearAuthCache } from "./auth";
import { selfCheck } from "./monitor";

export const TOOL_NAMES = [
  "get_stats", "get_logs", "list_apps", "get_fixes", "run_check",
  "block_add", "block_remove", "provider_order", "provider_toggle",
  "app_pause", "app_resume", "app_cap", "key_rotate", "key_revoke",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** May run without asking: reads + blocking an abuser + moving a failing email provider later. */
export const SAFE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>(["get_stats", "get_logs", "list_apps", "get_fixes", "run_check", "block_add", "provider_order"]);
/** Writes (whether safe or not) — reported on Telegram when the assistant runs them. */
export const WRITE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>(["block_add", "block_remove", "provider_order", "provider_toggle", "app_pause", "app_resume", "app_cap", "key_rotate", "key_revoke"]);

export const isToolName = (x: unknown): x is ToolName => typeof x === "string" && (TOOL_NAMES as readonly string[]).includes(x);

const nowS = () => Math.floor(Date.now() / 1000);
const str = (v: unknown) => (typeof v === "string" ? v : "");

async function appIdOf(env: Env, ref: unknown): Promise<string> {
  const r = await env.DB.prepare("SELECT id FROM apps WHERE (id=? OR name=?) AND id != 'app_system_admin'").bind(str(ref), str(ref)).first<{ id: string }>();
  if (!r) throw new Error(`no app "${str(ref)}"`);
  return r.id;
}

async function getProviders(env: Env): Promise<ProviderSettings> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key='providers'").first<{ value: string }>();
  return row ? JSON.parse(row.value) : { ...DEFAULT_PROVIDERS };
}
async function setProviders(env: Env, p: ProviderSettings) {
  await env.DB.prepare("INSERT INTO settings (key,value,updated_at) VALUES ('providers',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .bind(JSON.stringify(p), nowS()).run();
  return p;
}

/** Run one tool. Args come from the UI or the AI, so everything is validated here. */
export async function runTool(env: Env, name: ToolName, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "get_stats": {
      const s = await buildStats(env.DB);
      return { today: s.today, week: s.week, quotas: s.quotas.map((q) => ({ provider: q.provider, usedToday: q.usedToday, usedMonth: q.usedMonth, month: q.month, day: q.day, exhaustedToday: q.exhaustedToday })), secrets: s.secrets };
    }
    case "get_logs": {
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
      const status = args.status === "failed" || args.status === "sent" ? args.status : null;
      const { results } = await env.DB.prepare(
        `SELECT l.created_at, a.name AS app, l.channel, l.provider, l.status, l.error, l.latency_ms
         FROM delivery_logs l LEFT JOIN apps a ON a.id=l.app_id ${status ? "WHERE l.status=?" : ""} ORDER BY l.created_at DESC LIMIT ?`,
      ).bind(...(status ? [status, limit] : [limit])).all();
      return results; // no recipients exist in logs
    }
    case "list_apps": {
      const { results } = await env.DB.prepare("SELECT name, display_name, status, daily_cap, otp_ttl_seconds FROM apps WHERE id != 'app_system_admin' ORDER BY created_at").all();
      return results;
    }
    case "get_fixes": {
      const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'alert:%'").all<{ key: string; value: string }>();
      return results.map((r) => ({ alertKey: r.key.slice(6), since: Number(r.value) }));
    }
    case "run_check":
      return selfCheck(env);
    case "block_add": {
      const kind = str(args.kind);
      const value = str(args.value);
      let stored: string | null = null, label = "";
      if (kind === "domain") { const d = value.trim().toLowerCase().replace(/^@/, ""); if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) { stored = d; label = d; } }
      else if (kind === "email") { const e = normaliseEmail(value); if (e) { stored = await blockHash(env.OTP_PEPPER, "email", e); label = mask(e); } }
      else if (kind === "phone") { const p = normalisePhone(value); if (p) { stored = await blockHash(env.OTP_PEPPER, "phone", p); label = mask(p); } }
      else if (kind === "ip") { if (/^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{2,39})$/i.test(value.trim())) { stored = await blockHash(env.OTP_PEPPER, "ip", value.trim()); label = value.trim().replace(/\d+$/, "x"); } }
      if (!stored) throw new Error(`not a valid ${kind || "value"}`);
      await env.DB.prepare("INSERT INTO blocklist (kind,value,label,note,created_at) VALUES (?,?,?,?,?) ON CONFLICT(kind,value) DO NOTHING")
        .bind(kind, stored, label, str(args.note).slice(0, 200) || "blocked by assistant", nowS()).run();
      return { blocked: kind, label };
    }
    case "block_remove": {
      const r = await env.DB.prepare("DELETE FROM blocklist WHERE kind=? AND value=?").bind(str(args.kind), str(args.value)).run();
      return { removed: r.meta.changes };
    }
    case "provider_order": {
      // Move one email provider to the end (e.g. it keeps failing). Undo = move the other one.
      const p = await getProviders(env);
      const later = str(args.later);
      if (!(p.email_order as string[]).includes(later)) throw new Error(`unknown email provider "${later}"`);
      return setProviders(env, { ...p, email_order: [...p.email_order.filter((x) => x !== later), later as "resend" | "ahasend"] });
    }
    case "provider_toggle": {
      const p = await getProviders(env);
      const prov = str(args.provider);
      if (!["resend", "ahasend", "textbee"].includes(prov)) throw new Error(`unknown provider "${prov}"`);
      const disabled = new Set(p.disabled);
      args.on === false ? disabled.add(prov) : disabled.delete(prov);
      return setProviders(env, { ...p, disabled: [...disabled] });
    }
    case "app_pause":
    case "app_resume": {
      const id = await appIdOf(env, args.app);
      await env.DB.prepare("UPDATE apps SET status=? WHERE id=?").bind(name === "app_pause" ? "paused" : "active", id).run();
      clearAuthCache();
      return { app: str(args.app), status: name === "app_pause" ? "paused" : "active" };
    }
    case "app_cap": {
      const id = await appIdOf(env, args.app);
      const cap = Number(args.daily_cap);
      if (!Number.isInteger(cap) || cap < 1 || cap > 10000) throw new Error("daily_cap must be 1–10000");
      await env.DB.prepare("UPDATE apps SET daily_cap=? WHERE id=?").bind(cap, id).run();
      clearAuthCache();
      return { app: str(args.app), daily_cap: cap };
    }
    case "key_rotate": {
      const id = await appIdOf(env, args.app);
      const key = newApiKey("live");
      const grace = nowS() + 86400;
      await env.DB.batch([
        env.DB.prepare("UPDATE api_keys SET expires_at=? WHERE app_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)").bind(grace, id, grace),
        env.DB.prepare("INSERT INTO api_keys (id,app_id,key_hash,prefix,created_at) VALUES (?,?,?,?,?)").bind(newId("key"), id, await sha256Hex(key), key.slice(0, 14), nowS()),
      ]);
      clearAuthCache();
      // The new key is returned to the owner's screen only; it is never sent back to the AI.
      return { app: str(args.app), api_key: key, old_keys_expire_at: grace };
    }
    case "key_revoke": {
      const id = await appIdOf(env, args.app);
      const r = await env.DB.prepare("UPDATE api_keys SET revoked_at=? WHERE app_id=? AND revoked_at IS NULL").bind(nowS(), id).run();
      clearAuthCache();
      return { app: str(args.app), revoked: r.meta.changes };
    }
  }
}
