import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { deliver, type Message } from "../src/delivery";
import { smsText } from "../src/sms";
import { app } from "../src/app";
import { clearAuthCache } from "../src/auth";
import { newApiKey, randomString, sha256Hex } from "../src/crypto";

const live = {
  ...env, DELIVERY_MODE: undefined, TEXTBEE_API_KEY: "tb_test", TEXTBEE_DEVICE_ID: "dev1",
  RESEND_API_KEY: "re_test", AHASEND_API_KEY: "aha_test", AHASEND_ACCOUNT_ID: "acc_1",
};
type Call = { url: string; headers: Record<string, string>; body: any };
let calls: Call[];

function mockFetch(h: Record<"textbee" | "resend" | "ahasend", () => Response>) {
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = String(input);
    calls.push({ url, headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : null });
    return url.includes("textbee") ? h.textbee() : url.includes("resend") ? h.resend() : h.ahasend();
  });
}
const ok = () => new Response(JSON.stringify({ data: { success: true, smsBatchId: "b1" } }), { status: 200 });
const fail = (s = 500) => () => new Response("nope", { status: s });

async function newRequest(fallbackEmail: string | null = null): Promise<Message> {
  const id = `otp_${randomString(24)}`;
  await env.DB.prepare("INSERT OR IGNORE INTO apps (id,name,api_key_hash,api_key_prefix,created_at) VALUES ('app_s','sms-test','hs','p',0)").run();
  await env.DB.prepare("INSERT INTO otp_requests (id,app_id,recipient_hash,channel,code_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(id, "app_s", "rh", "sms", "ch", 9e9, 0).run();
  return { requestId: id, appName: "Meraaba", channel: "sms", to: "+233241234567", code: "482913", ttl: 300, smsAppHash: "FA+9qCX9VSu", fallbackEmail };
}
const row = (id: string) => env.DB.prepare("SELECT status, provider FROM otp_requests WHERE id=?").bind(id).first();

beforeEach(() => env.DB.exec("DELETE FROM settings"));
afterEach(() => vi.restoreAllMocks());

describe("SMS text (Android SMS Retriever format)", () => {
  it("matches the spec layout, ends with the 11-char hash, ≤140 bytes", () => {
    const t = smsText("Meraaba", "482913", 300, "FA+9qCX9VSu");
    expect(t).toBe("<#> Your Meraaba code is 482913. Expires in 5 min.\nFA+9qCX9VSu");
    expect(t.split("\n").at(-1)).toMatch(/^[A-Za-z0-9+/]{11}$/);
    expect(new TextEncoder().encode(t).length).toBeLessThanOrEqual(140);
  });

  it("stays ≤140 bytes even with a very long app name", () => {
    const t = smsText("A".repeat(200), "482913", 300, "FA+9qCX9VSu");
    expect(new TextEncoder().encode(t).length).toBeLessThanOrEqual(140);
    expect(t).toContain("482913");
    expect(t.endsWith("\nFA+9qCX9VSu")).toBe(true);
  });

  it("without an app hash sends a plain message (no <#>)", () => {
    expect(smsText("Klausum", "111222", 300, null)).toBe("Your Klausum code is 111222. Expires in 5 min.");
  });
});

describe("SMS delivery via textbee", () => {
  it("sends via textbee with x-api-key, deviceId and the formatted text", async () => {
    mockFetch({ textbee: ok, resend: ok, ahasend: ok });
    const m = await newRequest();
    await deliver(live as any, m);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.textbee.dev/api/v1/gateway/send-sms");
    expect(calls[0].headers["x-api-key"]).toBe("tb_test");
    expect(calls[0].body).toEqual({ recipients: ["+233241234567"], message: smsText("Meraaba", "482913", 300, "FA+9qCX9VSu"), deviceId: "dev1" });
    expect(await row(m.requestId)).toEqual({ status: "sent", provider: "textbee" });
  });

  it("falls back to email when textbee fails and a fallback email exists", async () => {
    mockFetch({ textbee: fail(400), resend: ok, ahasend: ok });
    const m = await newRequest("farmer@example.com");
    await deliver(live as any, m);
    expect(calls.map((c) => c.url)).toEqual(["https://api.textbee.dev/api/v1/gateway/send-sms", "https://api.resend.com/emails"]);
    expect(calls[1].body.to).toEqual(["farmer@example.com"]);
    expect(await row(m.requestId)).toEqual({ status: "sent", provider: "resend (sms fallback)" });
  });

  it("marks failed when textbee fails and there is no fallback email", async () => {
    mockFetch({ textbee: fail(400), resend: ok, ahasend: ok });
    const m = await newRequest();
    await deliver(live as any, m);
    expect(calls).toHaveLength(1);
    expect((await row(m.requestId) as any).status).toBe("failed");
  });

  it("a textbee 429 (plan limit) marks textbee exhausted for today", async () => {
    mockFetch({ textbee: fail(429), resend: ok, ahasend: ok });
    await deliver(live as any, await newRequest("f@example.com"));
    const s = await env.DB.prepare("SELECT value FROM settings WHERE key='exhausted:textbee'").first<{ value: string }>();
    expect(s!.value).toBe(new Date().toISOString().slice(0, 10));
    mockFetch({ textbee: ok, resend: ok, ahasend: ok });
    await deliver(live as any, await newRequest("f@example.com"));
    expect(calls.map((c) => c.url)).toEqual(["https://api.resend.com/emails"]);
  });

  it("treats a 200 with success:false as a failure", async () => {
    mockFetch({ textbee: () => new Response(JSON.stringify({ data: { success: false } }), { status: 200 }), resend: ok, ahasend: ok });
    const m = await newRequest();
    await deliver(live as any, m);
    expect((await row(m.requestId) as any).status).toBe("failed");
  });
});

describe("SMS delivery via SMSGate (end-to-end encrypted)", () => {
  const gate = { ...live, TEXTBEE_API_KEY: undefined, SMSGATE_USER: "u", SMSGATE_PASS: "p", SMSGATE_PASSPHRASE: "correct horse battery staple", SMSGATE_ITERATIONS: "1000" };
  async function decrypt(s: string, pass: string) {
    const [, alg, it, salt, data] = s.split("$");
    expect(alg).toBe("aes-256-cbc/pbkdf2-sha1");
    const iv = Uint8Array.from(atob(salt), (c) => c.charCodeAt(0));
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-1", salt: iv, iterations: Number(it.slice(2)) }, base, { name: "AES-CBC", length: 256 }, false, ["decrypt"]);
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, Uint8Array.from(atob(data), (c) => c.charCodeAt(0))));
  }

  it("sends only encrypted number and text, which decrypt with the passphrase", async () => {
    calls = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
      calls.push({ url: String(input), headers: init?.headers ?? {}, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: "m1", state: "Pending" }), { status: 202 });
    });
    const m = await newRequest();
    await deliver(gate as any, m);
    expect(calls[0].url).toBe("https://api.sms-gate.app/3rdparty/v1/messages");
    expect(calls[0].headers.Authorization).toBe(`Basic ${btoa("u:p")}`);
    const b = calls[0].body;
    expect(b.isEncrypted).toBe(true);
    expect(JSON.stringify(b)).not.toContain("482913");
    expect(JSON.stringify(b)).not.toContain("241234567");
    expect(await decrypt(b.phoneNumbers[0], gate.SMSGATE_PASSPHRASE)).toBe("+233241234567");
    expect(await decrypt(b.textMessage.text, gate.SMSGATE_PASSPHRASE)).toBe(smsText("Meraaba", "482913", 300, "FA+9qCX9VSu"));
    expect(await row(m.requestId)).toEqual({ status: "sent", provider: "smsgate" });
  });

  it("falls back to email when SMSGate fails", async () => {
    mockFetch({ textbee: ok, resend: ok, ahasend: ok });
    vi.mocked(globalThis.fetch).mockImplementation(async (input: any, init?: any) => {
      const url = String(input);
      calls.push({ url, headers: {}, body: null });
      return url.includes("sms-gate") ? new Response("down", { status: 502 }) : ok();
    });
    const m = await newRequest("farmer@example.com");
    await deliver(gate as any, m);
    expect(calls.map((c) => c.url)).toEqual(["https://api.sms-gate.app/3rdparty/v1/messages", "https://api.resend.com/emails"]);
    expect(await row(m.requestId)).toEqual({ status: "sent", provider: "resend (sms fallback)" });
  });
});

describe("API: fallback_email", () => {
  async function call(key: string, body: unknown) {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request("https://otp.test/v1/otp/send", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "CF-Connecting-IP": "10.9.9.9" },
      body: JSON.stringify(body),
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }
  it("is accepted for sms, rejected for email, and must be a valid email", async () => {
    clearAuthCache();
    await env.DB.exec("DELETE FROM rate_counters");
    const key = newApiKey();
    await env.DB.prepare("INSERT INTO apps (id,name,api_key_hash,api_key_prefix,created_at) VALUES (?,?,?,?,0)")
      .bind("app_fb", "fb-test", await sha256Hex(key), key.slice(0, 14)).run();
    expect((await call(key, { channel: "sms", to: "0241112223", fallback_email: "a@b.co" })).status).toBe(202);
    expect((await call(key, { channel: "email", to: "x@b.co", fallback_email: "a@b.co" })).status).toBe(400);
    expect((await call(key, { channel: "sms", to: "0241112224", fallback_email: "nope" })).status).toBe(400);
  });
});
