import { describe, it, expect, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import { publicIncident, recordStatus, statusData } from "../src/status";

beforeEach(() => env.DB.exec("DELETE FROM incidents; DELETE FROM stats_daily"));

describe("status page", () => {
  it("only user-facing problems become public incidents", () => {
    expect(publicIncident("d1")!.component).toBe("api");
    expect(publicIncident("streak:resend")!.component).toBe("email");
    for (const k of ["quota:resend", "spike", "secrets", "textbee:silent"]) expect(publicIncident(k)).toBeNull();
  });

  it("opens an incident, keeps it open while the problem lasts, and resolves it", async () => {
    await recordStatus(env as any, ["streak:resend", "quota:resend"]);
    await recordStatus(env as any, ["streak:resend"]);
    let s = await statusData(env as any);
    expect(s.overall).toBe("degraded");
    expect(s.incidents).toHaveLength(1);
    expect(s.components.find((c) => c.id === "email")!.status).toBe("degraded");
    await recordStatus(env as any, []);
    s = await statusData(env as any);
    expect(s.overall).toBe("operational");
    expect(s.incidents[0].resolved_at).not.toBeNull();
    expect(s.uptime90).toBeCloseTo(1 / 3); // 2 degraded checks + 1 ok today
    expect(JSON.stringify(s)).not.toMatch(/resend|quota/); // no internal names leak
  });

  it("serves the page on status.* and the JSON publicly", async () => {
    const page = await SELF.fetch("https://status.klausum.study/");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('src="/status.js"');
    const site = await SELF.fetch("https://otp.klausum.study/"); // the website (static asset), not the status page
    expect(site.status).toBe(200);
    expect(await site.text()).not.toContain('src="/status.js"');
    expect((await SELF.fetch("https://otp.klausum.study/status.json")).status).toBe(200);
  });
});
