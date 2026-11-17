import { describe, it, expect, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import { HANDBOOK, entryFor } from "../src/handbook";
import { SAFE_TOOLS } from "../src/assistant-tools";

const ALERT_KEYS = ["d1", "streak:resend", "streak:ahasend", "quota:ahasend", "quota:resend", "errors", "spike", "secrets", "key:resend", "key:ahasend", "textbee:silent", "streak:textbee", "quota:textbee"];
let ip = 0;
const A = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://otp.test/admin${path}`, { ...init, headers: { Authorization: "Bearer test-admin-token", "Content-Type": "application/json", "CF-Connecting-IP": `10.66.0.${++ip % 250}`, ...(init.headers ?? {}) } });

beforeEach(() => env.DB.exec("DELETE FROM settings"));

describe("handbook", () => {
  it("every alert the self-check can raise matches exactly one entry, with at least one fix", () => {
    for (const k of ALERT_KEYS) {
      expect(HANDBOOK.filter((h) => h.match(k)).length, k).toBe(1);
      expect(entryFor(k)!.actions.length, k).toBeGreaterThan(0);
    }
  });

  it("only safe tools are marked safe", () => {
    for (const h of HANDBOOK) for (const a of h.actions) if (a.safe) expect(SAFE_TOOLS.has(a.tool), `${h.id}/${a.id}`).toBe(true);
  });

  it("fills the provider name into actions", () => {
    expect(entryFor("streak:resend")!.actions[0].args).toEqual({ later: "resend" });
  });
});

describe("Fixes API", () => {
  it("lists open alerts with their handbook entry; empty when none", async () => {
    expect(((await (await A("/fixes")).json()) as any).fixes).toEqual([]);
    await env.DB.prepare("INSERT INTO settings (key,value,updated_at) VALUES ('alert:streak:resend','1000',0), ('ai_diagnosis:streak:resend','Resend key looks revoked.',0)").run();
    const f = ((await (await A("/fixes")).json()) as any).fixes;
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ alertKey: "streak:resend", since: 1000, aiDiagnosis: "Resend key looks revoked." });
    expect(f[0].entry.title).toBe("An email provider keeps failing");
  });

  it("runs a fix action for the owner, and rejects unknown tools", async () => {
    const r = await A("/actions/run", { method: "POST", body: JSON.stringify({ tool: "provider_order", args: { later: "resend" } }) });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).result.email_order).toEqual(["ahasend", "resend"]);
    expect((await A("/actions/run", { method: "POST", body: JSON.stringify({ tool: "drop_tables", args: {} }) })).status).toBe(400);
  });
});
