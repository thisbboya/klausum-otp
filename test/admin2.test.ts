import { describe, it, expect, beforeEach } from "vitest";
import { env, SELF, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { app } from "../src/app";
import { clearAuthCache } from "../src/auth";
import { testOutbox } from "../src/delivery";

let ipN = 0;
const A = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://otp.test/admin${path}`, { ...init, headers: { Authorization: "Bearer test-admin-token", "Content-Type": "application/json", "CF-Connecting-IP": `10.200.0.${++ipN % 250}`, ...(init.headers ?? {}) } });
const json = (r: Response) => r.json() as Promise<any>;
async function send(key: string, body: unknown, ip = "203.0.113.50") {
  const ctx = createExecutionContext();
  const r = await app.fetch(new Request("https://otp.test/v1/otp/send", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify(body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return r;
}
async function newApp(name: string) {
  const r = await json(await A("/apps", { method: "POST", body: JSON.stringify({ name, display_name: "T" }) }));
  return r as { id: string; api_key: string };
}

beforeEach(async () => { clearAuthCache(); await env.DB.exec("DELETE FROM rate_counters; DELETE FROM blocklist; DELETE FROM settings"); });

describe("API keys", () => {
  it("rotate: new key works now, old key keeps working for 24 h, then dies", async () => {
    const a = await newApp("rot-app");
    const rot = await json(await A(`/apps/${a.id}/keys/rotate`, { method: "POST", body: "{}" }));
    expect(rot.api_key).toMatch(/^kotp_live_/);
    clearAuthCache();
    expect((await send(rot.api_key, { channel: "email", to: "n1@b.co" })).status).toBe(202);
    expect((await send(a.api_key, { channel: "email", to: "n2@b.co" })).status).toBe(202); // still in grace
    await env.DB.prepare("UPDATE api_keys SET expires_at=? WHERE expires_at IS NOT NULL").bind(Math.floor(Date.now() / 1000) - 1).run();
    clearAuthCache();
    expect((await send(a.api_key, { channel: "email", to: "n3@b.co" })).status).toBe(401);
    expect((await send(rot.api_key, { channel: "email", to: "n4@b.co" })).status).toBe(202);
    const keys = await json(await A(`/apps/${a.id}/keys`));
    expect(keys.keys).toHaveLength(2);
  });

  it("revoke: all keys stop at once", async () => {
    const a = await newApp("rev-app");
    expect((await json(await A(`/apps/${a.id}/keys/revoke`, { method: "POST", body: "{}" }))).revoked).toBe(1);
    expect((await send(a.api_key, { channel: "email", to: "r@b.co" })).status).toBe(401);
  });
});

describe("apps", () => {
  it("edit, pause and delete (delete needs ?confirm=id)", async () => {
    const a = await newApp("edit-app");
    expect((await A(`/apps/${a.id}`, { method: "PATCH", body: JSON.stringify({ daily_cap: 5, display_name: "New" }) })).status).toBe(200);
    expect((await A(`/apps/${a.id}`, { method: "PATCH", body: JSON.stringify({ otp_ttl_seconds: 9999 }) })).status).toBe(400);
    expect((await A(`/apps/${a.id}`, { method: "PATCH", body: JSON.stringify({ status: "paused" }) })).status).toBe(200);
    expect((await send(a.api_key, { channel: "email", to: "p@b.co" })).status).toBe(401);
    expect((await A(`/apps/${a.id}`, { method: "DELETE" })).status).toBe(400);
    expect((await A(`/apps/${a.id}?confirm=${a.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM api_keys WHERE app_id=?").bind(a.id).first<{ n: number }>())!.n).toBe(0);
  });
});

describe("blocklist", () => {
  it("blocks a phone, an email, a whole domain and an IP — and stores hashes, not values", async () => {
    const a = await newApp("blk-app");
    for (const [kind, value] of [["phone", "0241234567"], ["email", "Bad@Example.com"], ["domain", "spam.example"], ["ip", "198.51.100.66"]])
      expect((await A("/blocklist", { method: "POST", body: JSON.stringify({ kind, value }) })).status).toBe(201);
    expect((await send(a.api_key, { channel: "sms", to: "+233 24 123 4567" })).status).toBe(403);
    expect((await send(a.api_key, { channel: "email", to: "bad@example.com" })).status).toBe(403);
    expect((await send(a.api_key, { channel: "email", to: "x@mail.spam.example" })).status).toBe(403);
    expect((await send(a.api_key, { channel: "email", to: "ok@b.co" }, "198.51.100.66")).status).toBe(403);
    expect((await send(a.api_key, { channel: "email", to: "fine@b.co" })).status).toBe(202);
    const list = await json(await A("/blocklist"));
    expect(JSON.stringify(list)).not.toContain("0241234567");
    expect(JSON.stringify(list)).not.toContain("bad@example.com");
    expect(list.entries.map((e: any) => e.label)).toContain("+23324****567");
  });
});

describe("providers", () => {
  it("validates and stores on/off and order", async () => {
    expect(await json(await A("/providers"))).toEqual({ email_order: ["resend", "ahasend"], disabled: [] });
    expect((await A("/providers", { method: "PUT", body: JSON.stringify({ email_order: ["ahasend", "ahasend"], disabled: [] }) })).status).toBe(400);
    expect((await A("/providers", { method: "PUT", body: JSON.stringify({ email_order: ["ahasend", "resend"], disabled: ["textbee"] }) })).status).toBe(200);
    expect((await json(await A("/providers"))).email_order).toEqual(["ahasend", "resend"]);
  });
});

describe("logs", () => {
  it("searches by app and request id, never shows recipients", async () => {
    const a = await newApp("log-app");
    const r = await json(await send(a.api_key, { channel: "email", to: "logme@b.co" }));
    const byReq = await json(await A(`/logs?request_id=${r.request_id}`));
    expect(byReq.logs).toHaveLength(1);
    expect(byReq.logs[0]).toMatchObject({ app: "log-app", channel: "email", provider: "console", status: "sent" });
    expect((await json(await A("/logs?app=log-app"))).logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(byReq)).not.toContain("logme");
    expect((await A("/logs?limit=999")).status).toBe(400);
  });
});
