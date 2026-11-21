import { describe, it, expect } from "vitest";
import { app } from "../src/app";

describe("GET /health", () => {
  it("returns ok and security headers", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("server-timing")).toMatch(/total;dur=/);
  });
  it("unknown route is a JSON 404", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
