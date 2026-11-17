import { describe, it, expect, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { app } from "../src/index";
import { testOutbox } from "../src/delivery";
import { clearAuthCache } from "../src/auth";
import { newApiKey, sha256Hex, randomString } from "../src/crypto";
import { codeHash, generateCode, mask, normaliseEmail, normalisePhone, recipientHash } from "../src/otp";

type Json = Record<string, any>;

async function makeApp(opts: { daily_cap?: number; origins?: string[] } = {}) {
  const key = newApiKey();
  const id = `app_${randomString(20)}`;
  await env.DB.prepare(
    "INSERT INTO apps (id,name,api_key_hash,api_key_prefix,allowed_origins,daily_cap,created_at) VALUES (?,?,?,?,?,?,?)",
  ).bind(id, `t-${id.slice(4, 12).toLowerCase()}`, await sha256Hex(key), key.slice(0, 14),
         JSON.stringify(opts.origins ?? []), opts.daily_cap ?? 300, 0).run();
  return { id, key };
}

async function call(key: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`https://otp.test${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "CF-Connecting-IP": headers.ip ?? "203.0.113.1", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    env, ctx,
  );
  await waitOnExecutionContext(ctx); // let background delivery finish
  return { res, json: (await res.json().catch(() => ({}))) as Json };
}

const send = (key: string, to: string, extra: Json = {}, ip?: string) =>
  call(key, "POST", "/v1/otp/send", { channel: "email", to, ...extra }, ip ? { ip } : {});
const verify = (key: string, request_id: string, code: string) => call(key, "POST", "/v1/otp/verify", { request_id, code });
const lastCode = () => testOutbox[testOutbox.length - 1].code;
const resetLimits = () => env.DB.exec("DELETE FROM rate_counters");
const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

let A: { id: string; key: string };
beforeEach(async () => {
  clearAuthCache();
  await resetLimits();
  A = await makeApp();
});

describe("send", () => {
  it("returns 202 with the contract shape and never stores the code", async () => {
    const { res, json } = await send(A.key, "  Sadick@Gmail.com ");
    expect(res.status).toBe(202);
    expect(json).toEqual({ request_id: expect.stringMatching(/^otp_[A-Za-z0-9]{24}$/), channel: "email", expires_in: 300, resend_after: 30 });
    const code = lastCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(testOutbox.at(-1)!.to).toBe("sadick@gmail.com"); // normalised

    const row = await env.DB.prepare("SELECT * FROM otp_requests WHERE id=?").bind(json.request_id).first<Json>();
    expect(JSON.stringify(row)).not.toContain(code);
    expect(JSON.stringify(row)).not.toContain("sadick@gmail.com");
    const rh = await recipientHash(env.OTP_PEPPER, A.id, "sadick@gmail.com");
    expect(row!.recipient_hash).toBe(rh);
    expect(row!.code_hash).toBe(await codeHash(env.OTP_PEPPER, A.id, json.request_id, code));
    expect(row!.status).toBe("sent");
    expect(row!.provider).toBe("console");
  });

  it("401 without a valid key, 400 on bad input", async () => {
    expect((await send("kotp_live_" + "x".repeat(32), "a@b.co")).res.status).toBe(401);
    expect((await call("nope", "POST", "/v1/otp/send", { channel: "email", to: "a@b.co" })).res.status).toBe(401);
    expect((await send(A.key, "not-an-email")).res.status).toBe(400);
    expect((await send(A.key, "a@b.co", { extra: 1 })).res.status).toBe(400);
    expect((await call(A.key, "POST", "/v1/otp/send", { channel: "fax", to: "a@b.co" })).res.status).toBe(400);
    expect((await call(A.key, "POST", "/v1/otp/send", "{bad json")).res.status).toBe(400);
    expect((await call(A.key, "POST", "/v1/otp/send", { channel: "sms", to: "12" })).res.status).toBe(400);
  });

  it("paused apps are rejected", async () => {
    await env.DB.prepare("UPDATE apps SET status='paused' WHERE id=?").bind(A.id).run();
    expect((await send(A.key, "p@b.co")).res.status).toBe(401);
  });
});

describe("verify", () => {
  it("accepts the right code exactly once (single use)", async () => {
    const { json } = await send(A.key, "once@b.co");
    const code = lastCode();
    expect((await verify(A.key, json.request_id, code)).json).toEqual({ valid: true });
    expect((await verify(A.key, json.request_id, code)).json).toEqual({ valid: false, reason: "invalid_code" });
  });

  it("allows 5 wrong attempts, then the code is dead even if correct", async () => {
    const { json } = await send(A.key, "att@b.co");
    const code = lastCode();
    const lefts = [];
    for (let i = 0; i < 5; i++) lefts.push((await verify(A.key, json.request_id, wrong(code))).json);
    expect(lefts.map((r) => r.attempts_left)).toEqual([4, 3, 2, 1, 0]);
    expect(lefts[4].reason).toBe("too_many_attempts");
    expect((await verify(A.key, json.request_id, code)).json).toEqual({ valid: false, reason: "too_many_attempts", attempts_left: 0 });
  });

  it("expired codes are refused", async () => {
    const { json } = await send(A.key, "exp@b.co");
    await env.DB.prepare("UPDATE otp_requests SET expires_at=? WHERE id=?").bind(Math.floor(Date.now() / 1000) - 1, json.request_id).run();
    expect((await verify(A.key, json.request_id, lastCode())).json).toEqual({ valid: false, reason: "expired" });
  });

  it("a new code invalidates the old one", async () => {
    const first = await send(A.key, "new@b.co");
    const oldCode = lastCode();
    await resetLimits();
    const second = await send(A.key, "new@b.co");
    expect((await verify(A.key, first.json.request_id, oldCode)).json.reason).toBe("invalid_code");
    expect((await verify(A.key, second.json.request_id, lastCode())).json.valid).toBe(true);
  });

  it("another app cannot verify or see this request; unknown ids look the same", async () => {
    const B = await makeApp();
    const { json } = await send(A.key, "x@b.co");
    expect((await verify(B.key, json.request_id, lastCode())).json).toEqual({ valid: false, reason: "invalid_code" });
    expect((await verify(A.key, "otp_" + "A".repeat(24), "123456")).json).toEqual({ valid: false, reason: "invalid_code" });
    expect((await call(B.key, "GET", `/v1/otp/status/${json.request_id}`)).res.status).toBe(404);
  });

  it("rejects malformed codes with 400", async () => {
    const { json } = await send(A.key, "fmt@b.co");
    expect((await verify(A.key, json.request_id, "12345")).res.status).toBe(400);
    expect((await verify(A.key, json.request_id, "12345a")).res.status).toBe(400);
  });
});

describe("rate limits", () => {
  it("per recipient: 1 per 30 s, with Retry-After", async () => {
    expect((await send(A.key, "rl@b.co")).res.status).toBe(202);
    const { res, json } = await send(A.key, "rl@b.co");
    expect(res.status).toBe(429);
    expect(json.error).toBe("rate_limited");
    const ra = Number(res.headers.get("Retry-After"));
    expect(ra).toBeGreaterThan(0);
    expect(ra).toBeLessThanOrEqual(30);
  });

  it("30 s window is not clock-aligned (no double send across a boundary)", async () => {
    const { hit } = await import("../src/ratelimit");
    const rule = [{ key: "edge:test", limit: 1, window: 30 }];
    expect((await hit(env.DB, rule, 1029)).ok).toBe(true);  // :29
    const r = await hit(env.DB, rule, 1031);                 // :31 — new clock window, same 30 s
    expect(r.ok).toBe(false);
    expect(r.retryAfter).toBe(28);
    expect((await hit(env.DB, rule, 1059)).ok).toBe(true);  // 30 s after the first hit
  });

  it("a rate-limited send writes no row and does not kill the live code", async () => {
    const first = await send(A.key, "keep@b.co");
    const code = lastCode();
    const before = await env.DB.prepare("SELECT COUNT(*) n FROM otp_requests").first<{ n: number }>();
    expect((await send(A.key, "keep@b.co")).res.status).toBe(429);
    const after = await env.DB.prepare("SELECT COUNT(*) n FROM otp_requests").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
    expect((await verify(A.key, first.json.request_id, code)).json.valid).toBe(true);
  });

  it("per recipient: 3 per 10 min and 10 per day", async () => {
    for (let i = 0; i < 3; i++) {
      await env.DB.exec("DELETE FROM rate_counters WHERE key LIKE 'r30:%'");
      expect((await send(A.key, "ten@b.co")).res.status).toBe(202);
    }
    await env.DB.exec("DELETE FROM rate_counters WHERE key LIKE 'r30:%'");
    expect((await send(A.key, "ten@b.co")).res.status).toBe(429);

    // 10 per day (fresh recipient; clear the shorter windows between sends)
    const st = [];
    for (let i = 0; i < 11; i++) {
      await env.DB.exec("DELETE FROM rate_counters WHERE key LIKE 'r30:%' OR key LIKE 'r600:%'");
      st.push((await send(A.key, "day@b.co")).res.status);
    }
    expect(st.slice(0, 10).every((x) => x === 202)).toBe(true);
    expect(st[10]).toBe(429);
  });

  it("per IP: 20 per hour", async () => {
    const statuses = [];
    for (let i = 0; i < 21; i++) statuses.push((await send(A.key, `ip${i}@b.co`, {}, "198.51.100.7")).res.status);
    expect(statuses.slice(0, 20).every((s) => s === 202)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it("per app: daily cap", async () => {
    const C = await makeApp({ daily_cap: 2 });
    expect((await send(C.key, "c1@b.co", {}, "192.0.2.1")).res.status).toBe(202);
    expect((await send(C.key, "c2@b.co", {}, "192.0.2.2")).res.status).toBe(202);
    expect((await send(C.key, "c3@b.co", {}, "192.0.2.3")).res.status).toBe(429);
  });

  it("verify: 10 attempts per recipient per 10 min", async () => {
    const { json } = await send(A.key, "vr@b.co");
    const res = [];
    for (let i = 0; i < 11; i++) res.push((await verify(A.key, json.request_id, "000000")).res.status);
    expect(res.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(res[10]).toBe(429);
  });
});

describe("resend & status", () => {
  it("resend issues a fresh code and kills the old one", async () => {
    const first = await send(A.key, "rs@b.co");
    const oldCode = lastCode();
    await resetLimits();
    const r = await call(A.key, "POST", "/v1/otp/resend", { request_id: first.json.request_id });
    expect(r.res.status).toBe(202);
    expect(r.json.request_id).not.toBe(first.json.request_id);
    expect(testOutbox.at(-1)!.to).toBe("rs@b.co");
    expect((await verify(A.key, first.json.request_id, oldCode)).json.valid).toBe(false);
    expect((await verify(A.key, r.json.request_id, lastCode())).json.valid).toBe(true);
  });

  it("resend obeys rate limits", async () => {
    const first = await send(A.key, "rs2@b.co");
    expect((await call(A.key, "POST", "/v1/otp/resend", { request_id: first.json.request_id })).res.status).toBe(429);
  });

  it("status shows delivery state and provider", async () => {
    const { json } = await send(A.key, "st@b.co");
    const s = await call(A.key, "GET", `/v1/otp/status/${json.request_id}`);
    expect(s.json).toEqual({ request_id: json.request_id, channel: "email", status: "sent", provider: "console" });
  });
});

describe("CORS", () => {
  it("allows only the app's listed origins", async () => {
    const W = await makeApp({ origins: ["https://klausum.study"] });
    const ok = await send(W.key, "o1@b.co", {}, undefined);
    expect(ok.res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const good = await call(W.key, "POST", "/v1/otp/send", { channel: "email", to: "o2@b.co" }, { Origin: "https://klausum.study", ip: "10.0.0.2" });
    expect(good.res.headers.get("Access-Control-Allow-Origin")).toBe("https://klausum.study");
    const evil = await call(W.key, "POST", "/v1/otp/send", { channel: "email", to: "o3@b.co" }, { Origin: "https://evil.com", ip: "10.0.0.3" });
    expect(evil.res.status).toBe(403);
  });

  it("preflight answers only listed origins", async () => {
    await makeApp({ origins: ["https://klausum.study"] });
    const pre = (origin: string) => app.fetch(new Request("https://otp.test/v1/otp/send", { method: "OPTIONS", headers: { Origin: origin } }), env, createExecutionContext());
    expect((await pre("https://klausum.study")).status).toBe(204);
    expect((await pre("https://evil.com")).status).toBe(403);
  });
});

describe("helpers", () => {
  it("normalises phones to E.164 (Ghana default)", () => {
    expect(normalisePhone("0241234567")).toBe("+233241234567");
    expect(normalisePhone("024 123 4567")).toBe("+233241234567");
    expect(normalisePhone("233241234567")).toBe("+233241234567");
    expect(normalisePhone("+233 24-123-4567")).toBe("+233241234567");
    expect(normalisePhone("00447911123456")).toBe("+447911123456");
    expect(normalisePhone("12345")).toBeNull();
    expect(normalisePhone("+0123456789")).toBeNull();
  });

  it("normalises emails", () => {
    expect(normaliseEmail("  Sadick@GMAIL.com ")).toBe("sadick@gmail.com");
    expect(normaliseEmail("bad@")).toBeNull();
    expect(normaliseEmail("a b@c.com")).toBeNull();
  });

  it("masks recipients", () => {
    expect(mask("sadick@gmail.com")).toBe("s***@gmail.com");
    expect(mask("+233241234567")).toBe("+23324****567");
  });

  it("codes are 6 digits with uniform digits (no modulo bias)", () => {
    const counts = new Array(10).fill(0);
    const N = 20000;
    for (let i = 0; i < N; i++) for (const d of generateCode()) counts[+d]++;
    const exp = (N * 6) / 10;
    const chi = counts.reduce((s, c) => s + (c - exp) ** 2 / exp, 0);
    expect(chi).toBeLessThan(27.9); // df=9, p=0.001
  });

  it("source never uses Math.random", async () => {
    // Guard rail: the bundle that runs in the Worker must not call Math.random for secrets.
    const files = import.meta.glob("../src/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    for (const [f, src] of Object.entries(files)) expect(src, f).not.toMatch(/Math\.random\s*\(/);
  });
});

describe("test keys (kotp_test_)", () => {
  it("run the full flow but never deliver, and skip the per-IP limit", async () => {
    const key = newApiKey("test");
    await env.DB.prepare("INSERT INTO apps (id,name,api_key_hash,api_key_prefix,created_at) VALUES (?,?,?,?,0)")
      .bind(`app_${randomString(20)}`, `tk-${randomString(6).toLowerCase()}`, await sha256Hex(key), key.slice(0, 14)).run();
    const before = testOutbox.length;
    const st = [];
    for (let i = 0; i < 22; i++) st.push((await send(key, `bench${i}@b.co`, {}, "198.51.100.200")).res.status);
    expect(st.every((s) => s === 202)).toBe(true); // a live key would hit 429 at #21
    expect(testOutbox.length).toBe(before); // nothing went to any provider
    const { json } = await send(key, "status@b.co", {}, "198.51.100.200");
    expect((await call(key, "GET", `/v1/otp/status/${json.request_id}`)).json.provider).toBe("test");
  });
});

describe("verify concurrency", () => {
  it("two simultaneous verifies of the right code: exactly one succeeds", async () => {
    clearAuthCache(); await env.DB.exec("DELETE FROM rate_counters");
    const k = await makeApp();
    const { json } = await send(k.key, "race@b.co");
    const code = lastCode();
    const [a, b] = await Promise.all([verify(k.key, json.request_id, code), verify(k.key, json.request_id, code)]);
    expect([a.json.valid, b.json.valid].sort()).toEqual([false, true]);
  });
  it("a code for one request does not work on another request for the same person", async () => {
    clearAuthCache(); await env.DB.exec("DELETE FROM rate_counters");
    const k = await makeApp();
    const r1 = await send(k.key, "bind@b.co"); const c1 = lastCode();
    await env.DB.exec("DELETE FROM rate_counters");
    const r2 = await send(k.key, "bind2@b.co");
    expect((await verify(k.key, r2.json.request_id, c1)).json.valid).toBe(c1 === lastCode());
    expect((await verify(k.key, r1.json.request_id, c1)).json.valid).toBe(true);
  });
});

describe("X-End-User-IP", () => {
  it("per-IP limit follows the forwarded user IP, not the app server's IP", async () => {
    const k = await makeApp();
    const sendAs = (to: string, userIp: string) => call(k.key, "POST", "/v1/otp/send", { channel: "email", to }, { ip: "198.51.100.250", "X-End-User-IP": userIp });
    for (let i = 0; i < 20; i++) expect((await sendAs(`u${i}@b.co`, "41.66.0.1")).res.status).toBe(202);
    expect((await sendAs("u20@b.co", "41.66.0.1")).res.status).toBe(429); // same student over the limit
    expect((await sendAs("u21@b.co", "41.66.0.2")).res.status).toBe(202); // a different student is fine
    expect((await call(k.key, "POST", "/v1/otp/send", { channel: "email", to: "z@b.co" }, { ip: "198.51.100.251", "X-End-User-IP": "not-an-ip" })).res.status).toBe(202);
  });
});
