import type { Env } from "./index";
import { mask } from "./otp";
import { newId } from "./crypto";
import { EMAIL_PROVIDERS, otpEmail, type EmailProvider } from "./email";

export type Message = {
  requestId: string; appName: string; channel: "email" | "sms"; to: string;
  code: string; ttl: number; smsAppHash: string | null;
};

/** In-memory outbox used by tests (same isolate). Only filled in "console" mode. */
export const testOutbox: Message[] = [];

const today = () => new Date().toISOString().slice(0, 10); // UTC date

type Attempt = { provider: string; ok: boolean; error: string | null; ms: number };

/**
 * Try providers in order; first success wins. A provider that reports a quota error
 * is remembered in `settings` as exhausted until midnight UTC and skipped.
 */
async function deliverEmail(env: Env, m: Message, attempts: Attempt[]): Promise<string | null> {
  const order: EmailProvider[] = ["resend", "ahasend"];
  const keys = order.map((p) => `exhausted:${p}`);
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM settings WHERE key IN (${keys.map(() => "?").join(",")})`,
  ).bind(...keys).all<{ key: string; value: string }>();
  const exhausted = new Set(results.filter((r) => r.value === today()).map((r) => r.key.slice(10)));

  const mail = { to: m.to, ...otpEmail(m.appName, m.code, m.ttl) };
  for (const p of order) {
    if (exhausted.has(p)) continue;
    const t0 = Date.now();
    let res;
    try { res = await EMAIL_PROVIDERS[p](env, mail); }
    catch (e) { res = { ok: false as const, quota: false, error: `${p} network: ${String(e).slice(0, 200)}` }; }
    attempts.push({ provider: p, ok: res.ok, error: res.ok ? null : res.error, ms: Date.now() - t0 });
    if (res.ok) return p;
    if (res.quota) {
      await env.DB.prepare(
        "INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
      ).bind(`exhausted:${p}`, today(), Math.floor(Date.now() / 1000)).run();
    }
  }
  return null;
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
    provider = await deliverEmail(env, m, attempts);
  } else {
    attempts.push({ provider: "sms", ok: false, error: "sms not available yet (Phase 5)", ms: 0 });
  }

  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("UPDATE otp_requests SET status=?, provider=? WHERE id=? AND status='queued'")
      .bind(provider ? "sent" : "failed", provider ?? attempts.at(-1)?.provider ?? null, m.requestId),
    ...attempts.map((a) =>
      env.DB.prepare("INSERT INTO delivery_logs (id,otp_request_id,provider,status,error,latency_ms,created_at) VALUES (?,?,?,?,?,?,?)")
        .bind(newId("dlv"), m.requestId, a.provider, a.ok ? "sent" : "failed", a.error, a.ms, now)),
  ]);
  if (!provider) console.error(`delivery failed for ${m.requestId} (${mask(m.to)}):`, attempts.map((a) => a.error).join(" | "));
}
