import type { Env } from "./index";
import { mask } from "./otp";
import { newId } from "./crypto";

export type Message = { requestId: string; appName: string; channel: "email" | "sms"; to: string; code: string; ttl: number; smsAppHash: string | null };

/** In-memory outbox used by tests (same isolate). Never read in production. */
export const testOutbox: Message[] = [];

/**
 * Phase 3: only the "console" provider exists. It writes the code to Workers Logs,
 * which OWASP says never to do in production — so it only runs when
 * DELIVERY_MODE === "console". Phase 4/5 replace it with Resend/AhaSend/textbee.
 */
export async function deliver(env: Env, m: Message): Promise<void> {
  const t0 = Date.now();
  let provider = "none", status = "failed", error: string | null = "no provider configured";
  if (env.DELIVERY_MODE === "console") {
    testOutbox.push(m);
    if (testOutbox.length > 100) testOutbox.shift();
    console.log(`[console-provider] ${m.channel} to ${mask(m.to)} for ${m.appName}: code ${m.code} (request ${m.requestId})`);
    provider = "console"; status = "sent"; error = null;
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("UPDATE otp_requests SET status=?, provider=? WHERE id=? AND status='queued'").bind(status, provider, m.requestId),
    env.DB.prepare("INSERT INTO delivery_logs (id,otp_request_id,provider,status,error,latency_ms,created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(newId("dlv"), m.requestId, provider, status, error, Date.now() - t0, now),
  ]);
}
