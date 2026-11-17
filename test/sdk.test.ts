import { describe, it, expect } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { app } from "../src/index";
import { testOutbox } from "../src/delivery";
import { clearAuthCache } from "../src/auth";
import { newApiKey, randomString, sha256Hex } from "../src/crypto";
import { createOtpClient, OtpError } from "../packages/sdk/src/index";

/** Route the SDK's fetch straight into the Worker (real code path, local D1). */
const workerFetch: typeof fetch = async (input, init) => {
  const ctx = createExecutionContext();
  const req = new Request(input as string, init);
  req.headers.set("CF-Connecting-IP", "192.0.2.77");
  const res = await app.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
};

async function newKey() {
  clearAuthCache();
  await env.DB.exec("DELETE FROM rate_counters");
  const key = newApiKey();
  await env.DB.prepare("INSERT INTO apps (id,name,api_key_hash,api_key_prefix,created_at) VALUES (?,?,?,?,0)")
    .bind(`app_${randomString(20)}`, `sdk-${randomString(6).toLowerCase()}`, await sha256Hex(key), key.slice(0, 14)).run();
  return createOtpClient({ apiKey: key, baseUrl: "https://otp.test", fetch: workerFetch });
}

describe("@klausum/otp SDK", () => {
  it("send → verify round trip with camelCase results", async () => {
    const otp = await newKey();
    const s = await otp.sendOtp({ channel: "email", to: "Ama@Example.com" });
    expect(s).toEqual({ requestId: expect.stringMatching(/^otp_/), channel: "email", expiresIn: 300, resendAfter: 30 });
    const code = testOutbox.at(-1)!.code;
    expect(await otp.verifyOtp({ requestId: s.requestId, code: "000000" === code ? "111111" : "000000" }))
      .toEqual({ valid: false, reason: "invalid_code", attemptsLeft: 4 });
    expect(await otp.verifyOtp({ requestId: s.requestId, code })).toEqual({ valid: true });
    expect((await otp.getStatus(s.requestId)).status).toBe("sent");
  });

  it("throws OtpError(rate_limited) with retryAfter", async () => {
    const otp = await newKey();
    await otp.sendOtp({ channel: "email", to: "rl@example.com" });
    const err = await otp.sendOtp({ channel: "email", to: "rl@example.com" }).catch((e) => e);
    expect(err).toBeInstanceOf(OtpError);
    expect(err.code).toBe("rate_limited");
    expect(err.retryAfter).toBeGreaterThan(0);
  });

  it("resendOtp returns a new request", async () => {
    const otp = await newKey();
    const s = await otp.sendOtp({ channel: "email", to: "rs@example.com" });
    await env.DB.exec("DELETE FROM rate_counters");
    const r = await otp.resendOtp({ requestId: s.requestId });
    expect(r.requestId).not.toBe(s.requestId);
  });

  it("maps 400/401 and network failures to OtpError codes", async () => {
    const otp = await newKey();
    expect((await otp.sendOtp({ channel: "email", to: "nope" }).catch((e) => e)).code).toBe("invalid_request");
    const bad = createOtpClient({ apiKey: newApiKey(), baseUrl: "https://otp.test", fetch: workerFetch });
    expect((await bad.sendOtp({ channel: "email", to: "a@b.co" }).catch((e) => e)).code).toBe("unauthorized");
    const down = createOtpClient({ apiKey: newApiKey(), fetch: async () => { throw new TypeError("offline"); } });
    expect((await down.sendOtp({ channel: "email", to: "a@b.co" }).catch((e) => e)).code).toBe("network");
  });

  it("refuses malformed keys, and live keys in a browser", () => {
    expect(() => createOtpClient({ apiKey: "sk_wrong" })).toThrow(/kotp_live_/);
    (globalThis as any).document = {};
    try {
      expect(() => createOtpClient({ apiKey: newApiKey("live") })).toThrow(/never be used in a browser/);
      expect(() => createOtpClient({ apiKey: newApiKey("test") })).not.toThrow();
    } finally {
      delete (globalThis as any).document;
    }
  });
});
