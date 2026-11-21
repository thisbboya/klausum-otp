import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { app } from "../src/app";
import { clearAuthCache } from "../src/auth";
import { newApiKey, sha256Hex, randomString } from "../src/crypto";
import { base32Decode, base32Encode, hotp, matchStep, stepAt } from "../src/totp";

const enc = new TextEncoder();
const RFC_SEED = enc.encode("12345678901234567890");

describe("RFC 4226 / 6238 maths", () => {
  it("HOTP matches RFC 4226 Appendix D", async () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    for (let i = 0; i < 10; i++) expect(await hotp(RFC_SEED, i)).toBe(expected[i]);
  });

  it("TOTP matches RFC 6238 Appendix B (SHA-1, 8 digits)", async () => {
    const vectors: [number, string][] = [
      [59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"],
      [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"],
    ];
    for (const [t, code] of vectors) expect(await hotp(RFC_SEED, stepAt(t), 8)).toBe(code);
  });

  it("base32 round-trips and matches RFC 4648 examples", () => {
    expect(base32Encode(enc.encode("foobar"))).toBe("MZXW6YTBOI");
    expect(new TextDecoder().decode(base32Decode("MZXW6YTBOI"))).toBe("foobar");
    const r = crypto.getRandomValues(new Uint8Array(20));
    expect(base32Decode(base32Encode(r))).toEqual(r);
  });

  it("accepts ±1 step of drift, rejects ±2", async () => {
    const t = 1_800_000_000;
    const s = stepAt(t);
    for (const d of [-1, 0, 1]) expect(await matchStep(RFC_SEED, await hotp(RFC_SEED, s + d), t)).toBe(s + d);
    for (const d of [-2, 2]) expect(await matchStep(RFC_SEED, await hotp(RFC_SEED, s + d), t)).toBeNull();
  });
});

describe("TOTP API", () => {
  let key: string;
  let appId: string;
  beforeEach(async () => {
    clearAuthCache();
    await env.DB.exec("DELETE FROM rate_counters");
    key = newApiKey();
    appId = `app_${randomString(20)}`;
    await env.DB.prepare("INSERT INTO apps (id,name,display_name,api_key_hash,api_key_prefix,created_at) VALUES (?,?,?,?,?,0)")
      .bind(appId, `t-${appId.slice(4, 12).toLowerCase()}`, "Klausum", await sha256Hex(key), key.slice(0, 14)).run();
  });
  afterEach(() => vi.useRealTimers());

  async function call(path: string, body: unknown, k = key) {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`https://otp.test/v1/totp/${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    return { res, json: (await res.json()) as any };
  }
  const codeFor = async (secret: string, offsetSteps = 0) => hotp(base32Decode(secret), stepAt(Date.now() / 1000) + offsetSteps);

  it("enroll returns secret, otpauth URL and an SVG QR; secret is stored encrypted", async () => {
    const { res, json } = await call("enroll", { user_ref: "klausum-user-123", issuer: "Klausum" });
    expect(res.status).toBe(201);
    expect(json.secret).toMatch(/^[A-Z2-7]{32}$/); // 20 bytes → 32 base32 chars
    expect(json.otpauth_url).toBe(`otpauth://totp/Klausum%3Aklausum-user-123?secret=${json.secret}&issuer=Klausum&algorithm=SHA1&digits=6&period=30`);
    expect(json.qr_svg).toMatch(/^<svg[\s\S]*<\/svg>$/);
    const row = await env.DB.prepare("SELECT secret_encrypted FROM totp_secrets WHERE app_id=?").bind(appId).first<{ secret_encrypted: string }>();
    expect(row!.secret_encrypted).not.toContain(json.secret);
  });

  it("verifies the current code, then blocks replay of the same step", async () => {
    const { json } = await call("enroll", { user_ref: "u1" });
    const code = await codeFor(json.secret);
    expect((await call("verify", { user_ref: "u1", code })).json).toEqual({ valid: true });
    expect((await call("verify", { user_ref: "u1", code })).json).toEqual({ valid: false, reason: "invalid_code" });
  });

  it("an older step is refused after a newer one was used", async () => {
    const { json } = await call("enroll", { user_ref: "u2" });
    expect((await call("verify", { user_ref: "u2", code: await codeFor(json.secret, 1) })).json.valid).toBe(true);
    expect((await call("verify", { user_ref: "u2", code: await codeFor(json.secret, 0) })).json.valid).toBe(false);
  });

  it("wrong codes and unknown users give the same answer", async () => {
    const { json } = await call("enroll", { user_ref: "u3" });
    const good = await codeFor(json.secret);
    const bad = String((Number(good) + 1) % 1e6).padStart(6, "0");
    expect((await call("verify", { user_ref: "u3", code: bad })).json).toEqual({ valid: false, reason: "invalid_code" });
    expect((await call("verify", { user_ref: "nobody", code: good })).json).toEqual({ valid: false, reason: "invalid_code" });
  });

  it("a confirmed enrolment cannot be replaced; an unconfirmed one can", async () => {
    const first = await call("enroll", { user_ref: "u4" });
    expect((await call("enroll", { user_ref: "u4" })).res.status).toBe(201); // not yet confirmed → re-enrol ok
    const second = (await env.DB.prepare("SELECT 1 FROM totp_secrets WHERE app_id=?").bind(appId).all()).results.length;
    expect(second).toBe(1);
    const latest = await call("enroll", { user_ref: "u4" });
    expect((await call("verify", { user_ref: "u4", code: await codeFor(latest.json.secret) })).json.valid).toBe(true);
    expect((await call("enroll", { user_ref: "u4" })).res.status).toBe(409);
    expect(first.json.secret).not.toBe(latest.json.secret);
  });

  it("another app cannot verify this app's users", async () => {
    const { json } = await call("enroll", { user_ref: "shared" });
    const other = newApiKey();
    await env.DB.prepare("INSERT INTO apps (id,name,api_key_hash,api_key_prefix,created_at) VALUES (?,?,?,?,0)")
      .bind(`app_${randomString(20)}`, `o-${randomString(6).toLowerCase()}`, await sha256Hex(other), other.slice(0, 14)).run();
    expect((await call("verify", { user_ref: "shared", code: await codeFor(json.secret) }, other)).json.valid).toBe(false);
  });

  it("rate-limits verify to 10 per user per 10 min, and validates input", async () => {
    await call("enroll", { user_ref: "u5" });
    const st = [];
    for (let i = 0; i < 11; i++) st.push((await call("verify", { user_ref: "u5", code: "000000" })).res.status);
    expect(st.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(st[10]).toBe(429);
    expect((await call("verify", { user_ref: "u5", code: "12345" })).res.status).toBe(400);
    expect((await call("enroll", { user_ref: "bad ref with spaces" })).res.status).toBe(400);
    expect((await call("enroll", { user_ref: "x", extra: 1 })).res.status).toBe(400);
  });
});
