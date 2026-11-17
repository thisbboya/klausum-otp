import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { sha256Hex } from "../src/crypto";

const call = (body: unknown, token = "test-admin-token") =>
  SELF.fetch("https://otp.test/admin/apps", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /admin/apps", () => {
  it("rejects a wrong or missing admin token", async () => {
    expect((await call({ name: "x1" }, "wrong")).status).toBe(401);
    const r = await SELF.fetch("https://otp.test/admin/apps", { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
  });

  it("creates an app, returns the key once, stores only its SHA-256 hash", async () => {
    const res = await call({ name: "klausum-web", allowed_origins: ["https://klausum.study"] });
    expect(res.status).toBe(201);
    const body = await res.json<{ id: string; api_key: string }>();
    expect(body.api_key).toMatch(/^kotp_live_[A-Za-z0-9]{32}$/);

    const row = await env.DB.prepare("SELECT * FROM apps WHERE id=?").bind(body.id).first<Record<string, string>>();
    expect(row!.api_key_hash).toBe(await sha256Hex(body.api_key));
    expect(JSON.stringify(row)).not.toContain(body.api_key); // plain key never stored

    const list = await SELF.fetch("https://otp.test/admin/apps", { headers: { Authorization: "Bearer test-admin-token" } });
    expect(JSON.stringify(await list.json())).not.toContain(body.api_key); // never shown again
  });

  it("rejects duplicate names with 409", async () => {
    expect((await call({ name: "dup-app" })).status).toBe(201);
    expect((await call({ name: "dup-app" })).status).toBe(409);
  });

  it("validates input with 400 (unknown fields, bad TTL, bad origin)", async () => {
    expect((await call({ name: "a1", evil: true })).status).toBe(400);
    expect((await call({ name: "a2", otp_ttl_seconds: 900 })).status).toBe(400);
    expect((await call({ name: "a3", allowed_origins: ["https://x.com/path"] })).status).toBe(400);
    expect((await call("not json")).status).toBe(400);
  });
});
