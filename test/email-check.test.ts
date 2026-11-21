import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { checkEmail, clearMxCache, isDisposableDomain } from "../src/email-check";
import { app } from "../src/app";
import { clearAuthCache } from "../src/auth";
import { newApiKey, randomString, sha256Hex } from "../src/crypto";

const doh = (answers: Record<string, { Status: number; Answer?: { type: number; data: string }[] }>) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
    const name = new URL(String(input)).searchParams.get("name")!;
    return new Response(JSON.stringify(answers[name] ?? { Status: 3 }), { headers: { "content-type": "application/dns-json" } });
  });
const MX = (...hosts: string[]) => ({ Status: 0, Answer: hosts.map((h, i) => ({ type: 15, data: `${10 * (i + 1)} ${h}.` })) });

beforeEach(() => clearMxCache());
afterEach(() => vi.restoreAllMocks());

describe("disposable blocklist", () => {
  it("blocks well-known temp-mail providers and their sub-domains", () => {
    for (const d of ["mailinator.com", "10minutemail.com", "guerrillamail.com", "yopmail.com", "temp-mail.org", "x.y.mailinator.com"])
      expect(isDisposableDomain(d), d).toBe(true);
  });
  it("allows real providers", () => {
    for (const d of ["gmail.com", "yahoo.com", "outlook.com", "icloud.com", "klausum.study", "ug.edu.gh", "knust.edu.gh"])
      expect(isDisposableDomain(d), d).toBe(false);
  });
});

describe("mailbox (MX) check", () => {
  it("accepts a domain with real MX records", async () => {
    doh({ "gmail.com": MX("gmail-smtp-in.l.google.com") });
    expect(await checkEmail("a@gmail.com", { dns: true })).toEqual({ ok: true });
  });
  it("refuses domains that don't exist, have no MX, or a null MX", async () => {
    doh({ "nomx.example": { Status: 0 }, "nullmx.example": MX(".") });
    expect(await checkEmail("a@doesnotexist-xyz.example", { dns: true })).toEqual({ ok: false, reason: "no_mailbox" });
    expect(await checkEmail("a@nomx.example", { dns: true })).toEqual({ ok: false, reason: "no_mailbox" });
    expect(await checkEmail("a@nullmx.example", { dns: true })).toEqual({ ok: false, reason: "no_mailbox" });
  });
  it("refuses a fresh domain whose mail servers belong to a disposable provider", async () => {
    doh({ "brand-new-temp.example": MX("mx1.mailinator.com") });
    expect(await checkEmail("a@brand-new-temp.example", { dns: true })).toEqual({ ok: false, reason: "disposable" });
  });
  it("fails open (blocklist still applies) if the DNS resolver is down", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    expect(await checkEmail("a@somewhere-real.example", { dns: true })).toEqual({ ok: true });
    expect(await checkEmail("a@yopmail.com", { dns: true })).toEqual({ ok: false, reason: "disposable" });
  });
});

describe("API refuses fake emails", () => {
  it("returns 400 email_not_allowed for disposable send and fallback addresses", async () => {
    clearAuthCache();
    await env.DB.exec("DELETE FROM rate_counters");
    const key = newApiKey();
    await env.DB.prepare("INSERT INTO apps (id,name,api_key_hash,api_key_prefix,created_at) VALUES (?,?,?,?,0)")
      .bind(`app_${randomString(20)}`, `ec-${randomString(6).toLowerCase()}`, await sha256Hex(key), key.slice(0, 14)).run();
    const send = async (body: unknown) => {
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request("https://otp.test/v1/otp/send", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env, ctx);
      await waitOnExecutionContext(ctx);
      return { status: res.status, json: (await res.json()) as any };
    };
    expect(await send({ channel: "email", to: "x@mailinator.com" })).toEqual({ status: 400, json: { error: "email_not_allowed", reason: "disposable" } });
    expect((await send({ channel: "sms", to: "0241234560", fallback_email: "x@yopmail.com" })).json.error).toBe("email_not_allowed");
    expect((await send({ channel: "email", to: "fine@gmail.com" })).status).toBe(202);
  });
});
