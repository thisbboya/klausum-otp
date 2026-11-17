import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env, SELF } from "cloudflare:test";
import { chat, decide, redact } from "../src/assistant";

const live = { ...env, GEMINI_API_KEY: "g_test", ADMIN_EMAIL: undefined } as any;
let geminiBodies: any[];

/** Each queued reply is one Gemini turn: text and/or function calls. */
function mockGemini(...turns: { text?: string; calls?: { name: string; args?: Record<string, unknown> }[] }[]) {
  geminiBodies = [];
  const q = [...turns];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = String(input);
    if (!url.includes("generativelanguage.googleapis.com")) return new Response("{}", { status: 200 }); // telegram/email
    geminiBodies.push(JSON.parse(init.body));
    const t = q.shift() ?? { text: "ok" };
    const parts = [...(t.text ? [{ text: t.text }] : []), ...(t.calls ?? []).map((c) => ({ functionCall: { name: c.name, args: c.args ?? {} } }))];
    return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts } }] }), { status: 200 });
  });
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM ai_actions; DELETE FROM blocklist; DELETE FROM settings; DELETE FROM delivery_logs");
  await env.DB.exec("INSERT OR IGNORE INTO apps (id,name,api_key_hash,api_key_prefix,created_at) VALUES ('app_ai','ai-app','unused:ai','p',0)");
  await env.DB.exec("UPDATE apps SET status='active' WHERE id='app_ai'");
});
afterEach(() => vi.restoreAllMocks());

describe("assistant", () => {
  it("without a Gemini key it explains how to switch on, and calls nothing", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const r = await chat({ ...env, GEMINI_API_KEY: undefined } as any, [{ role: "user", text: "hi" }]);
    expect(r.reply).toContain("GEMINI_API_KEY");
    expect(spy).not.toHaveBeenCalled();
  });

  it("runs a safe action (block an IP) on its own and logs it", async () => {
    mockGemini({ calls: [{ name: "block_add", args: { kind: "ip", value: "198.51.100.9" } }] }, { text: "Blocked that IP." });
    const r = await chat(live, [{ role: "user", text: "someone at 198.51.100.9 is spamming" }]);
    expect(r.reply).toBe("Blocked that IP.");
    expect(r.actions).toMatchObject([{ tool: "block_add", status: "done" }]);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM blocklist WHERE kind='ip'").first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare("SELECT status FROM ai_actions").first<{ status: string }>())!.status).toBe("done");
  });

  it("never runs a risky action itself: revoking keys waits for approval, then runs on Approve", async () => {
    mockGemini({ calls: [{ name: "key_revoke", args: { app: "ai-app" } }] }, { text: "I've proposed revoking the keys — tap Approve." });
    const r = await chat(live, [{ role: "user", text: "the ai-app key leaked" }]);
    expect(r.actions).toMatchObject([{ tool: "key_revoke", status: "pending_approval" }]);
    expect((await env.DB.prepare("SELECT status FROM apps WHERE id='app_ai'").first<{ status: string }>())!.status).toBe("active");
    const d = await decide(live, r.actions[0].id, true);
    expect(d).toMatchObject({ status: "approved" });
    expect((await decide(live, r.actions[0].id, true))).toEqual({ error: "not_pending" }); // can't approve twice
  });

  it("cancel leaves everything as it was", async () => {
    mockGemini({ calls: [{ name: "app_pause", args: { app: "ai-app" } }] }, { text: "Proposed." });
    const r = await chat(live, [{ role: "user", text: "pause ai-app" }]);
    expect(await decide(live, r.actions[0].id, false)).toEqual({ status: "cancelled" });
    expect((await env.DB.prepare("SELECT status FROM apps WHERE id='app_ai'").first<{ status: string }>())!.status).toBe("active");
  });

  it("ignores tools that don't exist", async () => {
    mockGemini({ calls: [{ name: "drop_database" }] }, { text: "That isn't something I can do." });
    const r = await chat(live, [{ role: "user", text: "delete everything" }]);
    expect(r.actions).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM ai_actions").first<{ n: number }>())!.n).toBe(0);
  });

  it("never sends email addresses or phone numbers to Gemini", async () => {
    await env.DB.prepare("INSERT INTO delivery_logs (id,otp_request_id,provider,status,error,created_at) VALUES ('d1','otp_x','resend','failed','Invalid to: victim@example.com +233241234567',?)").bind(Math.floor(Date.now() / 1000)).run();
    mockGemini({ calls: [{ name: "get_logs", args: { status: "failed" } }] }, { text: "Resend rejected one address." });
    await chat(live, [{ role: "user", text: "why did it fail?" }]);
    const sent = JSON.stringify(geminiBodies);
    expect(sent).not.toContain("victim@example.com");
    expect(sent).not.toContain("233241234567");
    expect(redact({ e: "a@b.co kotp_live_ABCDEFGHIJKLMNOP" })).toEqual({ e: "[email] [api key]" });
  });

  it("is reachable only for the owner", async () => {
    const r = await SELF.fetch("https://otp.test/admin/assistant", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.55.0.1" }, body: JSON.stringify({ messages: [{ role: "user", text: "hi" }] }) });
    expect(r.status).toBe(401);
  });
});
