import { describe, it, expect, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import { buildStats, statStmt, utcDay } from "../src/stats";

beforeEach(() => env.DB.exec("DELETE FROM stats_daily"));

describe("dashboard", () => {
  it("the old /dashboard page redirects to the new control room", async () => {
    const r = await SELF.fetch("https://otp.test/dashboard", { redirect: "manual" });
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("/admin");
  });

  it("/admin/stats needs the admin token", async () => {
    expect((await SELF.fetch("https://otp.test/admin/stats", { headers: { "CF-Connecting-IP": "10.1.1.1" } })).status).toBe(401);
    const r = await SELF.fetch("https://otp.test/admin/stats", { headers: { Authorization: "Bearer test-admin-token", "CF-Connecting-IP": "10.1.1.2" } });
    expect(r.status).toBe(200);
    expect(Object.keys(await r.json())).toEqual(expect.arrayContaining(["today", "week", "days", "quotas", "apps", "recent"]));
  });

  it("counts sends, success rate, latency, verifies and quota use", async () => {
    const now = Date.UTC(2026, 10, 17, 12);
    const today = utcDay(now), earlier = "2026-11-03";
    await env.DB.batch([
      statStmt(env.DB, "send:email", 0, today), statStmt(env.DB, "send:email", 0, today), statStmt(env.DB, "send:sms", 0, today),
      statStmt(env.DB, "sent:email", 0, today), statStmt(env.DB, "failed:email", 0, today),
      statStmt(env.DB, "provider:resend:sent", 800, today), statStmt(env.DB, "provider:resend:sent", 400, earlier),
      statStmt(env.DB, "provider:resend:sent", 0, today),
      statStmt(env.DB, "verify:ok", 0, today), statStmt(env.DB, "verify:fail", 0, today), statStmt(env.DB, "verify:fail", 0, today),
    ]);
    const s = await buildStats(env.DB, now);
    expect(s.today.email).toEqual({ sends: 2, delivered: 1, failed: 1, successRate: 0.5 });
    expect(s.today.sms.sends).toBe(1);
    expect(s.today.avgDeliveryMs).toBe(400); // (800 + 0) / 2
    expect(s.today.verify).toEqual({ ok: 1, failed: 2, successRate: 1 / 3 });
    const resend = s.quotas.find((q) => q.provider === "resend")!;
    expect(resend.usedToday).toBe(2);
    expect(resend.usedMonth).toBe(3); // includes Nov 3
    expect(resend.ratio).toBeCloseTo(0.02); // 2/100 today > 3/3000 month
    expect(s.days).toHaveLength(7);
    expect(s.days.at(-1)).toEqual({ day: today, email: 2, sms: 1 });
  });
});
