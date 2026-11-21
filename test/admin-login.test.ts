import { describe, it, expect, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import { testOutbox } from "../src/delivery";
import { base32Decode, hotp, stepAt } from "../src/totp";

let ip = 0;
const H = (extra: Record<string, string> = {}) => ({ "Content-Type": "application/json", "CF-Connecting-IP": `10.77.0.${++ip % 250}`, ...extra });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(`https://otp.test${path}`, { method: "POST", headers: H(headers), body: JSON.stringify(body) });

let secret = "";
beforeEach(async () => {
  await env.DB.exec("DELETE FROM rate_counters; DELETE FROM totp_secrets WHERE app_id='app_system_admin'");
  const r = await post("/admin/owner-totp/enroll", {}, { Authorization: "Bearer test-admin-token" });
  expect(r.status).toBe(201);
  secret = ((await r.json()) as any).secret;
});
const totpNow = (offset = 0) => hotp(base32Decode(secret), stepAt(Date.now() / 1000) + offset);

async function login(): Promise<string> {
  const before = testOutbox.length;
  const s = (await (await post("/auth/admin/start", { email: "Owner@Klausum.test" })).json()) as any;
  expect(testOutbox.length).toBe(before + 1);
  const v = await post("/auth/admin/verify", { request_id: s.request_id, code: testOutbox.at(-1)!.code, totp: await totpNow() });
  expect(v.status).toBe(200);
  const cookie = v.headers.get("set-cookie")!;
  expect(cookie).toMatch(/^__Host-kotp_admin=/);
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/Secure/i);
  expect(cookie).toMatch(/SameSite=Strict/i);
  expect(cookie).toMatch(/Max-Age=43200/);
  return cookie.split(";")[0];
}

describe("control-room login", () => {
  it("email code + authenticator → session that opens the admin API", async () => {
    const cookie = await login();
    expect((await SELF.fetch("https://otp.test/admin/stats", { headers: H({ Cookie: cookie }) })).status).toBe(200);
  });

  it("a non-owner email gets the same answer but no code is sent", async () => {
    const before = testOutbox.length;
    const r = await post("/auth/admin/start", { email: "attacker@evil.test" });
    expect(r.status).toBe(202);
    expect(((await r.json()) as any).request_id).toMatch(/^otp_/);
    expect(testOutbox.length).toBe(before);
  });

  it("refuses a wrong authenticator code even with the right email code (and vice versa)", async () => {
    const s = (await (await post("/auth/admin/start", { email: "owner@klausum.test" })).json()) as any;
    const code = testOutbox.at(-1)!.code;
    const wrongT = String((Number(await totpNow()) + 1) % 1e6).padStart(6, "0");
    expect((await post("/auth/admin/verify", { request_id: s.request_id, code, totp: wrongT })).status).toBe(401);
    const s2 = (await (await post("/auth/admin/start", { email: "owner@klausum.test" })).json()) as any;
    const wrongE = String((Number(testOutbox.at(-1)!.code) + 1) % 1e6).padStart(6, "0");
    expect((await post("/auth/admin/verify", { request_id: s2.request_id, code: wrongE, totp: await totpNow(1) })).status).toBe(401);
  });

  it("CSRF: a cookie alone can't change things from another site", async () => {
    const cookie = await login();
    const body = JSON.stringify({ kind: "domain", value: "csrf.example" });
    expect((await SELF.fetch("https://otp.test/admin/blocklist", { method: "POST", headers: H({ Cookie: cookie }), body })).status).toBe(401);
    expect((await SELF.fetch("https://otp.test/admin/blocklist", { method: "POST", headers: H({ Cookie: cookie, Origin: "https://evil.example" }), body })).status).toBe(401);
    expect((await SELF.fetch("https://otp.test/admin/blocklist", { method: "POST", headers: H({ Cookie: cookie, Origin: "https://otp.test" }), body })).status).toBe(201);
  });

  it("a session can't replace the owner's authenticator (needs the admin token)", async () => {
    const cookie = await login();
    const r = await SELF.fetch("https://otp.test/admin/owner-totp/enroll", { method: "POST", headers: H({ Cookie: cookie, Origin: "https://otp.test" }), body: "{}" });
    expect(r.status).toBe(403);
  });

  it("tampered or expired cookies are rejected; logout clears it", async () => {
    const cookie = await login();
    const bad = cookie.replace(/.$/, (c) => (c === "a" ? "b" : "a"));
    expect((await SELF.fetch("https://otp.test/admin/stats", { headers: H({ Cookie: bad }) })).status).toBe(401);
    const out = await post("/auth/admin/logout", {}, { Cookie: cookie });
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });

  it("the control-room page is a static file (no auth needed to load it), the API under it still needs auth", async () => {
    expect((await SELF.fetch("https://otp.test/admin/stats")).status).toBe(401);
    const page = await SELF.fetch("https://otp.test/admin");
    expect(page.status).not.toBe(401);
  });
});
