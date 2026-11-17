import type { Env } from "./index";
import type { SendResult } from "./email";

const MAX_BYTES = 140; // SMS Retriever limit (also keeps us inside one 160-char GSM-7 SMS)

/**
 * Android SMS Retriever format: code + the app's 11-char hash, ≤ 140 bytes.
 * Google's current docs don't require the old "<#>" prefix; we keep it because older
 * Play-services builds needed it and it costs 4 bytes. Without an app hash we send a
 * plain message (no "<#>").
 */
export function smsText(appName: string, code: string, ttlSeconds: number, appHash: string | null): string {
  const mins = Math.round(ttlSeconds / 60);
  const body = `Your ${appName} code is ${code}. Expires in ${mins} min.`;
  let text = appHash ? `<#> ${body}\n${appHash}` : body;
  if (new TextEncoder().encode(text).length > MAX_BYTES) {
    // Very long app names: fall back to the shortest form that still works.
    const short = `Code ${code}. Expires in ${mins} min.`;
    text = appHash ? `<#> ${short}\n${appHash}` : short;
  }
  return text;
}

export async function sendTextbee(env: Env, to: string, text: string): Promise<SendResult> {
  if (!env.TEXTBEE_API_KEY) return { ok: false, quota: false, error: "textbee not configured" };
  const r = await fetch("https://api.textbee.dev/api/v1/gateway/send-sms", {
    method: "POST",
    headers: {
      "x-api-key": env.TEXTBEE_API_KEY,
      "Content-Type": "application/json",
      "User-Agent": "klausum-otp/1.0", // textbee blocks some default user agents
    },
    body: JSON.stringify({ recipients: [to], message: text, ...(env.TEXTBEE_DEVICE_ID ? { deviceId: env.TEXTBEE_DEVICE_ID } : {}) }),
  });
  const body = (await r.text().catch(() => "")).slice(0, 300);
  // 200 = queued for the phone (not yet delivered). 429 = daily/monthly plan limit.
  if (r.ok && !/"success"\s*:\s*false/.test(body)) return { ok: true };
  return { ok: false, quota: r.status === 429, error: `textbee ${r.status}: ${body}` };
}
