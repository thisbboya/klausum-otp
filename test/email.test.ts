import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { deliver, type Message } from "../src/delivery";
import { otpEmail } from "../src/email";
import { randomString } from "../src/crypto";

const live = { ...env, DELIVERY_MODE: undefined, RESEND_API_KEY: "re_test", AHASEND_API_KEY: "aha_test", AHASEND_ACCOUNT_ID: "acc_1" };
type Call = { url: string; body: any };
let calls: Call[];

function mockFetch(handlers: Record<string, () => Response>) {
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    const key = url.includes("resend") ? "resend" : "ahasend";
    return handlers[key]();
  });
}

async function newRequest(): Promise<Message> {
  const id = `otp_${randomString(24)}`;
  await env.DB.prepare("INSERT OR IGNORE INTO apps (id,name,api_key_hash,api_key_prefix,created_at) VALUES ('app_e','email-test','h','p',0)").run();
  await env.DB.prepare("INSERT INTO otp_requests (id,app_id,recipient_hash,channel,code_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(id, "app_e", "rh", "email", "ch", 9e9, 0).run();
  return { requestId: id, appName: "Klausum", channel: "email", to: "sadick@gmail.com", code: "482913", ttl: 300, smsAppHash: null };
}
const row = (id: string) => env.DB.prepare("SELECT status, provider FROM otp_requests WHERE id=?").bind(id).first();
const logs = (id: string) => env.DB.prepare("SELECT provider, status, error FROM delivery_logs WHERE otp_request_id=? ORDER BY rowid").bind(id).all().then((r) => r.results);
const ok = () => new Response(JSON.stringify({ id: "x" }), { status: 200 });

beforeEach(() => env.DB.exec("DELETE FROM settings"));
afterEach(() => vi.restoreAllMocks());

describe("email template", () => {
  it("puts the code in the subject, text and html; no images; escapes the app name", () => {
    const e = otpEmail("Klausum", "482913", 300);
    expect(e.subject).toBe("Your Klausum code: 482913");
    expect(e.text).toContain("482913");
    expect(e.text).toContain("expires in 5 minutes");
    expect(e.text).toContain("If you didn't ask for this, ignore this email.");
    expect(e.html).toContain("482913");
    expect(e.html).not.toMatch(/<img|background-image|url\(/i);
    expect(otpEmail("<b>x</b>", "1", 300).html).not.toContain("<b>x</b>");
  });
});

describe("email delivery", () => {
  it("uses Resend first", async () => {
    mockFetch({ resend: ok, ahasend: ok });
    const m = await newRequest();
    await deliver(live as any, m);
    expect(calls.map((c) => c.url)).toEqual(["https://api.resend.com/emails"]);
    expect(calls[0].body).toMatchObject({ from: "Klausum <otp@mail.klausum.study>", to: ["sadick@gmail.com"], subject: "Your Klausum code: 482913" });
    expect(await row(m.requestId)).toEqual({ status: "sent", provider: "resend" });
  });

  it("falls back to AhaSend when Resend errors, and logs both attempts", async () => {
    mockFetch({ resend: () => new Response("boom", { status: 500 }), ahasend: ok });
    const m = await newRequest();
    await deliver(live as any, m);
    expect(calls[1].url).toBe("https://api.ahasend.com/v2/accounts/acc_1/messages");
    expect(calls[1].body).toMatchObject({ from: { name: "Klausum", email: "otp@mail.klausum.study" }, recipients: [{ email: "sadick@gmail.com" }] });
    expect(await row(m.requestId)).toEqual({ status: "sent", provider: "ahasend" });
    const l = await logs(m.requestId);
    expect(l.map((x: any) => [x.provider, x.status])).toEqual([["resend", "failed"], ["ahasend", "sent"]]);
    expect((l[0] as any).error).toContain("500");
  });

  it("remembers 'Resend exhausted today' on a quota error and skips it next time", async () => {
    mockFetch({ resend: () => new Response(JSON.stringify({ name: "daily_quota_exceeded" }), { status: 429 }), ahasend: ok });
    await deliver(live as any, await newRequest());
    const s = await env.DB.prepare("SELECT value FROM settings WHERE key='exhausted:resend'").first<{ value: string }>();
    expect(s!.value).toBe(new Date().toISOString().slice(0, 10));

    mockFetch({ resend: ok, ahasend: ok });
    const m = await newRequest();
    await deliver(live as any, m);
    expect(calls.map((c) => c.url)).toEqual(["https://api.ahasend.com/v2/accounts/acc_1/messages"]);
  });

  it("an exhausted mark from a previous day is ignored", async () => {
    await env.DB.prepare("INSERT INTO settings (key,value,updated_at) VALUES ('exhausted:resend','2000-01-01',0)").run();
    mockFetch({ resend: ok, ahasend: ok });
    await deliver(live as any, await newRequest());
    expect(calls[0].url).toContain("resend");
  });

  it("marks the request failed when every provider fails (incl. network errors)", async () => {
    calls = [];
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const m = await newRequest();
    await deliver(live as any, m);
    expect((await row(m.requestId) as any).status).toBe("failed");
    expect((await logs(m.requestId)).length).toBe(2);
  });

  it("never sends codes to logs in production mode", async () => {
    mockFetch({ resend: ok, ahasend: ok });
    const spy = vi.spyOn(console, "log");
    await deliver(live as any, await newRequest());
    expect(spy.mock.calls.flat().join(" ")).not.toContain("482913");
  });
});
