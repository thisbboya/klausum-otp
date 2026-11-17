import type { Env } from "./index";
import { mask } from "./otp";
import { newId } from "./crypto";
import { EMAIL_PROVIDERS, otpEmail, type SendResult } from "./email";
import { sendTextbee, smsText } from "./sms";
import { statStmt } from "./stats";
import { DEFAULT_PROVIDERS, type ProviderSettings } from "./admin";

export type Message = {
  requestId: string; appId?: string; appName: string; channel: "email" | "sms"; to: string;
  code: string; ttl: number; smsAppHash: string | null;
  /** SMS only: if every SMS provider fails, send the code here instead. */
  fallbackEmail?: string | null;
};

/** In-memory outbox used by tests (same isolate). Only filled in "console" mode. */
export const testOutbox: Message[] = [];

const today = () => new Date().toISOString().slice(0, 10); // UTC date

type Attempt = { provider: string; ok: boolean; error: string | null; ms: number };
type Provider = { name: string; send: () => Promise<SendResult> };

/**
 * Try providers in order; first success wins. A provider that reports a quota error
 * is remembered in `settings` as exhausted until midnight UTC and skipped.
 */
async function tryProviders(env: Env, providers: Provider[], attempts: Attempt[]): Promise<string | null> {
  // One read: which providers are used up today + the admin's on/off switches and order.
  const keys = [...providers.map((p) => `exhausted:${p.name}`), "providers"];
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM settings WHERE key IN (${keys.map(() => "?").join(",")})`,
  ).bind(...keys).all<{ key: string; value: string }>();
  const exhausted = new Set(results.filter((r) => r.key.startsWith("exhausted:") && r.value === today()).map((r) => r.key.slice(10)));
  const cfgRow = results.find((r) => r.key === "providers");
  const cfg: ProviderSettings = cfgRow ? JSON.parse(cfgRow.value) : DEFAULT_PROVIDERS;
  const rank = (n: string) => { const i = (cfg.email_order as string[]).indexOf(n); return i < 0 ? 99 : i; };
  const ordered = [...providers].sort((a, b) => rank(a.name) - rank(b.name));

  for (const p of ordered) {
    if (cfg.disabled.includes(p.name)) {
      attempts.push({ provider: p.name, ok: false, error: "skipped: turned off in the dashboard", ms: 0 });
      continue;
    }
    if (exhausted.has(p.name)) {
      attempts.push({ provider: p.name, ok: false, error: "skipped: quota used up today", ms: 0 });
      continue;
    }
    const t0 = Date.now();
    let res: SendResult;
    try { res = await p.send(); }
    catch (e) { res = { ok: false, quota: false, error: `${p.name} network: ${String(e).slice(0, 200)}` }; }
    attempts.push({ provider: p.name, ok: res.ok, error: res.ok ? null : res.error, ms: Date.now() - t0 });
    if (res.ok) return p.name;
    if (res.quota) {
      await env.DB.prepare(
        "INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
      ).bind(`exhausted:${p.name}`, today(), Math.floor(Date.now() / 1000)).run();
    }
  }
  return null;
}

function emailProviders(env: Env, to: string, m: Message): Provider[] {
  const mail = { to, ...otpEmail(m.appName, m.code, m.ttl) };
  return (["resend", "ahasend"] as const).map((name) => ({ name, send: () => EMAIL_PROVIDERS[name](env, mail) }));
}

export async function deliver(env: Env, m: Message): Promise<void> {
  const attempts: Attempt[] = [];
  let provider: string | null = null;

  if (env.DELIVERY_MODE === "console") {
    // Tests / local dev only: never deployed (it would put codes in logs — OWASP says no).
    testOutbox.push(m);
    if (testOutbox.length > 100) testOutbox.shift();
    console.log(`[console-provider] ${m.channel} to ${mask(m.to)}: code ${m.code} (request ${m.requestId})`);
    attempts.push({ provider: "console", ok: true, error: null, ms: 0 });
    provider = "console";
  } else if (m.channel === "email") {
    provider = await tryProviders(env, emailProviders(env, m.to, m), attempts);
  } else {
    const text = smsText(m.appName, m.code, m.ttl, m.smsAppHash);
    provider = await tryProviders(env, [{ name: "textbee", send: () => sendTextbee(env, m.to, text) }], attempts);
    if (!provider && m.fallbackEmail) {
      const p = await tryProviders(env, emailProviders(env, m.fallbackEmail, m), attempts);
      if (p) provider = `${p} (sms fallback)`;
    }
  }

  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("UPDATE otp_requests SET status=?, provider=? WHERE id=? AND status='queued'")
      .bind(provider ? "sent" : "failed", provider ?? attempts.at(-1)?.provider ?? null, m.requestId),
    ...attempts.map((a) =>
      env.DB.prepare("INSERT INTO delivery_logs (id,otp_request_id,app_id,channel,provider,status,error,latency_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(newId("dlv"), m.requestId, m.appId ?? null, m.channel, a.provider, a.ok ? "sent" : "failed", a.error, a.ms, now)),
    // Lasting daily counters for the dashboard / quota meters (rows above are cleaned up).
    statStmt(env.DB, `send:${m.channel}`),
    statStmt(env.DB, `${provider ? "sent" : "failed"}:${m.channel}`),
    ...attempts.filter((a) => !a.error?.startsWith("skipped")).map((a) =>
      statStmt(env.DB, `provider:${a.provider.split(" ")[0]}:${a.ok ? "sent" : "failed"}`, a.ms)),
  ]);
  if (!provider) console.error(`delivery failed for ${m.requestId} (${mask(m.to)}):`, attempts.map((a) => a.error).join(" | "));
}
