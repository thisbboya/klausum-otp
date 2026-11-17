import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { findAlerts, selfCheck, dailySummary } from "../src/monitor";
import { statStmt, utcDay } from "../src/stats";

const t = () => Math.floor(Date.now() / 1000);
const live = { ...env, ADMIN_EMAIL: "owner@klausum.test", RESEND_API_KEY: "re_x", AHASEND_API_KEY: "aha_x", AHASEND_ACCOUNT_ID: "a", TELEGRAM_BOT_TOKEN: "tg", TELEGRAM_CHAT_ID: "42" } as any;
let sent: { url: string; body: any }[];
function mockNet(opts: { resendValid?: boolean } = {}) {
  sent = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/domains")) return new Response(JSON.stringify({ name: opts.resendValid === false ? "validation_error" : "restricted_api_key" }), { status: opts.resendValid === false ? 400 : 401 });
    if (url.endsWith("/v2/ping")) return new Response("{}", { status: 200 });
    sent.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return new Response("{}", { status: 200 });
  });
}
async function log(provider: string, status: string, ago = 60) {
  await env.DB.prepare("INSERT INTO delivery_logs (id,otp_request_id,provider,status,created_at) VALUES (?,?,?,?,?)")
    .bind(crypto.randomUUID(), "otp_x", provider, status, t() - ago).run();
}
beforeEach(() => env.DB.exec("DELETE FROM delivery_logs; DELETE FROM settings; DELETE FROM stats_daily; DELETE FROM otp_requests"));
afterEach(() => vi.restoreAllMocks());

describe("self-check", () => {
  it("is quiet when everything is fine", async () => {
    expect(await findAlerts(env as any)).toEqual([]);
  });

  it("flags a provider that failed 3 times in a row, but not after a success", async () => {
    await log("resend", "failed", 30); await log("resend", "failed", 20); await log("resend", "failed", 10);
    expect((await findAlerts(env as any)).map((a) => a.key)).toContain("streak:resend");
    await log("resend", "sent", 5);
    expect((await findAlerts(env as any)).map((a) => a.key)).not.toContain("streak:resend");
  });

  it("flags quotas at 80 %", async () => {
    const day = utcDay();
    await env.DB.batch(Array.from({ length: 81 }, () => statStmt(env.DB, "provider:resend:sent", 0, day)));
    expect((await findAlerts(env as any)).map((a) => a.key)).toContain("quota:resend");
  });

  it("flags error rate > 5 % and 5× spikes in the last hour", async () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      env.DB.prepare("INSERT INTO otp_requests (id,app_id,recipient_hash,channel,code_hash,expires_at,status,provider,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(`otp_spike${i}`, "app_x", "rh", "email", "ch", 9e9, i < 4 ? "failed" : "sent", "resend", t() - 100));
    await env.DB.exec("INSERT OR IGNORE INTO apps (id,name,api_key_hash,api_key_prefix,created_at) VALUES ('app_x','mon-x','unused:mx','p',0)");
    await env.DB.batch(rows);
    const keys = (await findAlerts(env as any)).map((a) => a.key);
    expect(keys).toContain("errors"); // 4/40 = 10 %
    expect(keys).toContain("spike");  // 40 in an hour vs ~0 normal
  });

  it("alerts once per problem (not every 15 min), says when it clears, and checks keys", async () => {
    mockNet({ resendValid: false });
    const r1 = await selfCheck(live);
    expect(r1.sent).toEqual(["key:resend"]);
    expect(sent.some((s) => s.url.includes("api.telegram.org") && s.body.chat_id === "42")).toBe(true);
    expect(sent.some((s) => s.url.includes("api.resend.com/emails") && s.body.to[0] === "owner@klausum.test")).toBe(true);
    mockNet({ resendValid: false });
    expect((await selfCheck(live)).sent).toEqual([]); // de-duplicated
    mockNet({ resendValid: true });
    const r3 = await selfCheck(live);
    expect(r3.cleared).toEqual(["key:resend"]);
    expect(JSON.stringify(sent)).toContain("back to normal");
  });
});

describe("daily summary", () => {
  it("reports yesterday's numbers and quota left", async () => {
    mockNet();
    const now = Date.UTC(2026, 10, 18, 8);
    await env.DB.batch([statStmt(env.DB, "send:email", 0, "2026-11-17"), statStmt(env.DB, "send:email", 0, "2026-11-17"), statStmt(env.DB, "failed:email", 0, "2026-11-17"), statStmt(env.DB, "verify:ok", 0, "2026-11-17")]);
    await dailySummary(live, now);
    const tg = sent.find((s) => s.url.includes("telegram"))!.body.text as string;
    expect(tg).toContain("Yesterday (2026-11-17)");
    expect(tg).toContain("Codes sent: 2");
    expect(tg).toContain("Failed: 1 (50 %)");
    expect(tg).toContain("Resend:");
  });
});
