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

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

/**
 * SMSGate passphrase encryption (AES-256-CBC, PBKDF2-SHA1, salt doubles as IV, PKCS#7):
 * "$aes-256-cbc/pbkdf2-sha1$i=<n>$<b64 salt>$<b64 data>". The relay never sees the number or code.
 */
export async function smsGateEncryptor(passphrase: string, iterations: number) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-1", salt, iterations }, base, { name: "AES-CBC", length: 256 }, false, ["encrypt"]);
  return async (plain: string) => {
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: salt }, key, new TextEncoder().encode(plain)));
    return `$aes-256-cbc/pbkdf2-sha1$i=${iterations}$${b64(salt)}$${b64(ct)}`;
  };
}

/** SMSGate (open-source Android gateway on your own phone) via its cloud relay, end-to-end encrypted. */
export async function sendSmsGate(env: Env, to: string, text: string): Promise<SendResult> {
  if (!env.SMSGATE_USER || !env.SMSGATE_PASS || !env.SMSGATE_PASSPHRASE) return { ok: false, quota: false, error: "smsgate not configured" };
  const enc = await smsGateEncryptor(env.SMSGATE_PASSPHRASE, Number(env.SMSGATE_ITERATIONS) || 75000);
  const r = await fetch("https://api.sms-gate.app/3rdparty/v1/messages", {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${env.SMSGATE_USER}:${env.SMSGATE_PASS}`)}`, "Content-Type": "application/json", "User-Agent": "klausum-otp/1.0" },
    body: JSON.stringify({ textMessage: { text: await enc(text) }, phoneNumbers: [await enc(to)], isEncrypted: true, withDeliveryReport: true, ttl: 300 }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await r.text().catch(() => "")).slice(0, 300);
  if (r.ok && !/"state"\s*:\s*"Failed"/.test(body)) return { ok: true };
  return { ok: false, quota: r.status === 429, error: `smsgate ${r.status}: ${body}` };
}
