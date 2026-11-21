/**
 * The control-room assistant. Uses Gemini (free tier) with function calling.
 *  - Knows the service from the handbook + live, privacy-safe context (no codes, recipients,
 *    key values or secrets ever leave the Worker).
 *  - May run SAFE_TOOLS on its own (reads, blocking an abuser, moving a failing email provider later).
 *  - Anything else becomes a pending action the owner approves or cancels in the control room.
 *  - Every action is written to `ai_actions`; AI-run writes are also sent to Telegram.
 */
import type { Env } from "./index";
import { handbookText } from "./handbook";
import { SAFE_TOOLS, TOOL_NAMES, WRITE_TOOLS, isToolName, runTool, type ToolName } from "./assistant-tools";
import { newId } from "./crypto";

export type ChatMessage = { role: "user" | "model"; text: string };
export type ActionView = { id: string; tool: ToolName; args: Record<string, unknown>; status: string; result?: unknown };

const nowS = () => Math.floor(Date.now() / 1000);
const MAX_ROUNDS = 4;

/** Strip anything that could identify a person before it goes to the AI. */
export function redact(v: unknown): unknown {
  // Only text values are cleaned; numbers (timestamps, ratios) pass through untouched.
  if (typeof v === "string") return v
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\+?\d[\d\s-]{7,}\d/g, "[number]")
    .replace(/kotp_(live|test)_[A-Za-z0-9]{8,}/g, "[api key]");
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x)]));
  return v ?? null;
}

const S = { type: "STRING" } as const;
const N = { type: "NUMBER" } as const;
const B = { type: "BOOLEAN" } as const;
const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "OBJECT", properties, required });

const DECLS: Record<ToolName, { description: string; parameters: ReturnType<typeof obj> }> = {
  get_stats: { description: "Today's and this week's numbers, free-quota use, and secret ages.", parameters: obj() },
  get_logs: { description: "Recent deliveries (no recipients). status='failed' to see only failures.", parameters: obj({ status: S, limit: N }) },
  list_apps: { description: "The apps using the service, with status and daily caps.", parameters: obj() },
  get_fixes: { description: "Problems currently open (alert keys) found by the self-check.", parameters: obj() },
  run_check: { description: "Run the self-check now and return what it finds.", parameters: obj() },
  block_add: { description: "Block an abuser. kind: ip | phone | email | domain. SAFE: runs immediately.", parameters: obj({ kind: S, value: S, note: S }, ["kind", "value"]) },
  block_remove: { description: "Unblock an entry (needs owner approval).", parameters: obj({ kind: S, value: S }, ["kind", "value"]) },
  provider_order: { description: "Move an email provider (resend|ahasend) to be tried LAST. SAFE: runs immediately.", parameters: obj({ later: S }, ["later"]) },
  provider_toggle: { description: "Turn a provider (resend|ahasend|textbee) on or off (needs approval).", parameters: obj({ provider: S, on: B }, ["provider", "on"]) },
  app_pause: { description: "Pause an app by name (needs approval).", parameters: obj({ app: S }, ["app"]) },
  app_resume: { description: "Resume a paused app (needs approval).", parameters: obj({ app: S }, ["app"]) },
  app_cap: { description: "Set an app's daily send cap (needs approval).", parameters: obj({ app: S, daily_cap: N }, ["app", "daily_cap"]) },
  key_rotate: { description: "Make a new API key for an app; old keys work 24 h more (needs approval).", parameters: obj({ app: S }, ["app"]) },
  key_revoke: { description: "Stop all keys of an app immediately (needs approval).", parameters: obj({ app: S }, ["app"]) },
};

async function context(env: Env) {
  const [stats, fixes, apps] = await Promise.all([runTool(env, "get_stats", {}), runTool(env, "get_fixes", {}), runTool(env, "list_apps", {})]);
  return redact({ stats, openProblems: fixes, apps });
}

function systemPrompt(ctx: unknown) {
  return `You are the operations assistant inside the control room of "Klausum OTP", a one-time-code service (email + authenticator codes) run by Sadick for his own projects on Cloudflare Workers + D1, with Resend (primary) and AhaSend (backup) for email.

How you work:
- Be brief, plain and friendly. Lead with what matters. Use short paragraphs or bullets.
- Diagnose from the live context and tools; follow the handbook below. Never invent numbers.
- You may run on your own ONLY: get_stats, get_logs, list_apps, get_fixes, run_check, block_add, provider_order.
- Every other tool (pause/resume apps, caps, key rotate/revoke, unblock, provider on/off) only PROPOSES the action: it waits for Sadick to tap Approve. Say clearly that it needs his approval.
- You never see codes, email addresses, phone numbers, API keys or secrets, and must never ask for them.
- For secrets (provider keys, pepper, admin token) explain the steps from the handbook; you can't change them.

Handbook:
${handbookText()}

Live context (privacy-safe):
${JSON.stringify(ctx)}`;
}

type GeminiPart = { text?: string; functionCall?: { name: string; args?: Record<string, unknown> }; functionResponse?: unknown };
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

async function gemini(env: Env, system: string, contents: GeminiContent[], withTools: boolean): Promise<GeminiPart[]> {
  const model = env.GEMINI_MODEL || "gemini-flash-latest";
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY! },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      ...(withTools ? { tools: [{ functionDeclarations: TOOL_NAMES.map((name) => ({ name, ...DECLS[name] })) }] } : {}),
      generationConfig: { temperature: 0.2, maxOutputTokens: 900 },
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { candidates?: { content?: { parts?: GeminiPart[] } }[] };
  return j.candidates?.[0]?.content?.parts ?? [];
}

async function audit(env: Env, tool: ToolName, args: Record<string, unknown>, status: string, result: unknown, source: string) {
  const id = newId("act");
  await env.DB.prepare("INSERT INTO ai_actions (id,created_at,tool,args_json,status,result_json,source) VALUES (?,?,?,?,?,?,?)")
    .bind(id, nowS(), tool, JSON.stringify(args), status, result === undefined ? null : JSON.stringify(result), source).run();
  return id;
}

async function tellOwner(env: Env, text: string) {
  const { notify } = await import("./monitor");
  await notify(env, "Klausum OTP assistant", text).catch(() => {});
}

/** One chat turn. Runs safe tools, parks the rest for approval. */
export async function chat(env: Env, messages: ChatMessage[], source = "chat"): Promise<{ reply: string; actions: ActionView[] }> {
  if (!env.GEMINI_API_KEY) {
    return { reply: "The assistant is switched off. Add a free Gemini API key with `npx wrangler secret put GEMINI_API_KEY` (get one at aistudio.google.com) and it will start working here.", actions: [] };
  }
  const system = systemPrompt(await context(env));
  const contents: GeminiContent[] = messages.slice(-12).map((m) => ({ role: m.role, parts: [{ text: m.text.slice(0, 4000) }] }));
  const actions: ActionView[] = [];
  let reply = "";

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const parts = await gemini(env, system, contents, true);
    const text = parts.map((p) => p.text ?? "").join("").trim();
    if (text) reply = text;
    const calls = parts.filter((p) => p.functionCall);
    if (!calls.length) break;
    contents.push({ role: "model", parts });
    const responses: GeminiPart[] = [];
    for (const { functionCall } of calls) {
      const name = functionCall!.name;
      const args = (functionCall!.args ?? {}) as Record<string, unknown>;
      if (!isToolName(name)) {
        responses.push({ functionResponse: { name, response: { error: "unknown tool — nothing was done" } } });
        continue;
      }
      if (SAFE_TOOLS.has(name)) {
        try {
          const result = await runTool(env, name, args);
          const id = await audit(env, name, args, "done", WRITE_TOOLS.has(name) ? result : undefined, source);
          actions.push({ id, tool: name, args, status: "done", result: WRITE_TOOLS.has(name) ? result : undefined });
          if (WRITE_TOOLS.has(name)) await tellOwner(env, `I ran ${name} ${JSON.stringify(args)} on my own (safe action). Undo it in the control room if needed.`);
          responses.push({ functionResponse: { name, response: { result: redact(result) } } });
        } catch (e) {
          const id = await audit(env, name, args, "failed", { error: String((e as Error).message ?? e) }, source);
          actions.push({ id, tool: name, args, status: "failed" });
          responses.push({ functionResponse: { name, response: { error: String((e as Error).message ?? e) } } });
        }
      } else {
        const id = await audit(env, name, args, "pending_approval", undefined, source);
        actions.push({ id, tool: name, args, status: "pending_approval" });
        responses.push({ functionResponse: { name, response: { status: "pending_approval", note: "Not done yet. Waiting for Sadick to tap Approve." } } });
      }
    }
    contents.push({ role: "user", parts: responses });
  }
  if (!reply) reply = actions.length ? "Done — see the actions below." : "I couldn't come up with an answer. Try asking another way.";
  return { reply, actions };
}

/** Owner decision on a pending action. Approve runs it through the same code as the control room. */
export async function decide(env: Env, id: string, approve: boolean) {
  const row = await env.DB.prepare("SELECT tool,args_json,status FROM ai_actions WHERE id=?").bind(id).first<{ tool: string; args_json: string; status: string }>();
  if (!row || row.status !== "pending_approval" || !isToolName(row.tool)) return { error: "not_pending" as const };
  if (!approve) {
    await env.DB.prepare("UPDATE ai_actions SET status='cancelled', decided_at=? WHERE id=?").bind(nowS(), id).run();
    return { status: "cancelled" as const };
  }
  try {
    const result = await runTool(env, row.tool, JSON.parse(row.args_json));
    // A new API key is shown to the owner once and never stored in the audit log.
    const stored = row.tool === "key_rotate" ? { ...(result as object), api_key: "[shown once]" } : result;
    await env.DB.prepare("UPDATE ai_actions SET status='approved', result_json=?, decided_at=? WHERE id=?").bind(JSON.stringify(stored), nowS(), id).run();
    return { status: "approved" as const, result };
  } catch (e) {
    await env.DB.prepare("UPDATE ai_actions SET status='failed', result_json=?, decided_at=? WHERE id=?").bind(JSON.stringify({ error: String((e as Error).message ?? e) }), nowS(), id).run();
    return { error: "action_failed" as const, message: String((e as Error).message ?? e) };
  }
}

/** After the self-check finds new problems: a short diagnosis for the Fixes tab and the alert. */
export async function diagnose(env: Env, alertKeys: string[]): Promise<string | null> {
  if (!env.GEMINI_API_KEY || !alertKeys.length) return null;
  try {
    const failed = redact(await runTool(env, "get_logs", { status: "failed", limit: 10 }));
    const parts = await gemini(env, systemPrompt(await context(env)), [{
      role: "user",
      parts: [{ text: `The self-check just raised: ${alertKeys.join(", ")}. Recent failed deliveries: ${JSON.stringify(failed)}. In 2–3 short sentences: what is most likely wrong, and the one fix you recommend (name the handbook action).` }],
    }], false);
    const text = parts.map((p) => p.text ?? "").join("").trim().slice(0, 800);
    if (!text) return null;
    await env.DB.batch(alertKeys.map((k) =>
      env.DB.prepare("INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").bind(`ai_diagnosis:${k}`, text, nowS())));
    return text;
  } catch {
    return null; // the alert still goes out without a diagnosis
  }
}
