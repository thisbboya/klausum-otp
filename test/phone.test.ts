import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { app } from "../src/app";
import { clearAuthCache } from "../src/auth";
import { newApiKey, randomString, sha256Hex, toHex } from "../src/crypto";

const E = { ...env, TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_BOT_USERNAME: "klausum_bot", TELEGRAM_WEBHOOK_SECRET: "tg-secret",
  WHATSAPP_NUMBER: "233200000000", WHATSAPP_APP_SECRET: "wa-secret", WHATSAPP_VERIFY_TOKEN: "wa-verify" };
let key: string;
let sent: any[];

async function req(path: string, init: RequestInit = {}, e: any = E) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`https://otp.test${path}`, init), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const api = (path: string, body?: unknown, k = key) => req(path, {
  method: body ? "POST" : "GET",
  headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" },
  body: body ? JSON.stringify(body) : undefined,
});
const tgHook = (message: unknown, secret = "tg-secret") => req("/hooks/telegram", {
  method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret }, body: JSON.stringify({ message }),
});
async function waHook(body: unknown, secret = "wa-secret") {
  const raw = JSON.stringify(body);
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = `sha256=${toHex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(raw)))}`;
  return req("/hooks/whatsapp", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: raw });
}
const waMsg = (from: string, text: string) => ({ entry: [{ changes: [{ value: { messages: [{ from, type: "text", text: { body: text } }] } }] }] });

beforeEach(async () => {
  clearAuthCache();
  key = newApiKey();
  await env.DB.prepare("INSERT INTO apps (id,name,display_name,api_key_hash,api_key_prefix,created_at) VALUES (?,?,?,?,?,0)")
    .bind(`app_${randomString(20)}`, `p-${randomString(6).toLowerCase()}`, "Klausum", await sha256Hex(key), key.slice(0, 14)).run();
  sent = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_u: any, init?: any) => { sent.push(JSON.parse(init.body)); return new Response("{}"); });
});
afterEach(() => vi.restoreAllMocks());

describe("Telegram phone check", () => {
  it("start → open bot → share own contact → verified", async () => {
    const r = await (await api("/v1/phone/start", { method: "telegram" })).json() as any;
    expect(r.link).toMatch(/^https:\/\/t\.me\/klausum_bot\?start=[A-Za-z0-9]{24}$/);
    const token = r.link.split("=")[1];
    expect((await (await api(`/v1/phone/status/${r.request_id}`)).json() as any).status).toBe("pending");

    await tgHook({ chat: { id: 77, type: "private" }, from: { id: 77 }, text: `/start ${token}` });
    expect(sent.at(-1).reply_markup.keyboard[0][0].request_contact).toBe(true);

    await tgHook({ chat: { id: 77, type: "private" }, from: { id: 77 }, contact: { phone_number: "233241234567", user_id: 77 } });
    expect(await (await api(`/v1/phone/status/${r.request_id}`)).json()).toEqual({ status: "verified", phone: "+233241234567" });
  });

  it("refuses someone else's contact and a bad webhook secret", async () => {
    const r = await (await api("/v1/phone/start", { method: "telegram" })).json() as any;
    await tgHook({ chat: { id: 5, type: "private" }, from: { id: 5 }, text: `/start ${r.link.split("=")[1]}` });
    await tgHook({ chat: { id: 5, type: "private" }, from: { id: 5 }, contact: { phone_number: "233209999999", user_id: 999 } });
    expect((await (await api(`/v1/phone/status/${r.request_id}`)).json() as any).status).toBe("pending");
    expect((await tgHook({ chat: { id: 5, type: "private" } }, "wrong")).status).toBe(401);
  });
});

describe("WhatsApp phone check", () => {
  it("start → user sends the code → verified with the sender's number", async () => {
    const r = await (await api("/v1/phone/start", { method: "whatsapp" })).json() as any;
    expect(r.code).toMatch(/^\d{6}$/);
    expect(r.link).toBe(`https://wa.me/233200000000?text=${encodeURIComponent(`Klausum code ${r.code}`)}`);
    expect((await waHook(waMsg("233501112222", `Klausum code ${r.code}`))).status).toBe(200);
    expect(await (await api(`/v1/phone/status/${r.request_id}`)).json()).toEqual({ status: "verified", phone: "+233501112222" });
  });

  it("ignores unsigned calls and wrong codes; answers Meta's handshake", async () => {
    const r = await (await api("/v1/phone/start", { method: "whatsapp" })).json() as any;
    expect((await waHook(waMsg("233501112222", r.code), "forged")).status).toBe(401);
    await waHook(waMsg("233501112222", String((Number(r.code) + 1) % 1e6).padStart(6, "0")));
    expect((await (await api(`/v1/phone/status/${r.request_id}`)).json() as any).status).toBe("pending");
    expect(await (await req("/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=wa-verify&hub.challenge=42")).text()).toBe("42");
    expect((await req("/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42")).status).toBe(403);
  });
});

describe("phone check API rules", () => {
  it("needs a key, a valid method, and hides other apps' checks", async () => {
    expect((await api("/v1/phone/start", { method: "sms" })).status).toBe(400);
    const r = await (await api("/v1/phone/start", { method: "whatsapp" })).json() as any;
    const other = newApiKey();
    await env.DB.prepare("INSERT INTO apps (id,name,api_key_hash,api_key_prefix,created_at) VALUES (?,?,?,?,0)")
      .bind(`app_${randomString(20)}`, `o-${randomString(6).toLowerCase()}`, await sha256Hex(other), other.slice(0, 14)).run();
    expect((await api(`/v1/phone/status/${r.request_id}`, undefined, other)).status).toBe(404);
    expect((await req("/v1/phone/start", { method: "POST", body: "{}" })).status).toBe(401);
  });
});
