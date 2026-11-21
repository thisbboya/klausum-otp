import { useEffect, useRef, useState } from "react";
import { api, ago } from "../api";
import { useConfirm, useLoad, useToast } from "../ui";
import { Icon } from "../../ui/components";

type Msg = { role: "user" | "model"; text: string };
type Act = { id: string; tool: string; args: Record<string, unknown>; status: string; result?: unknown };

const LABEL: Record<string, string> = {
  block_add: "Block", block_remove: "Unblock", provider_order: "Change email provider order", provider_toggle: "Turn provider on/off",
  app_pause: "Pause app", app_resume: "Resume app", app_cap: "Change daily cap", key_rotate: "Rotate API key", key_revoke: "Revoke API keys",
  get_stats: "Read stats", get_logs: "Read logs", list_apps: "List apps", get_fixes: "Read open problems", run_check: "Run health check",
};
const SUGGESTIONS = ["How is the service doing today?", "Why did deliveries fail recently?", "How much free email quota is left this month?", "Which secrets need rotating soon?"];

// Chat text stays in memory if the session expires mid-conversation (Review Focus).
let saved: Msg[] = [];

export function Assistant() {
  const toast = useToast();
  const confirm = useConfirm();
  const [msgs, setMsgs] = useState<Msg[]>(saved);
  const [acts, setActs] = useState<Act[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const history = useLoad<{ actions: any[]; enabled: boolean }>(() => api("GET", "/admin/assistant/actions"));
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { saved = msgs; end.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [msgs, acts]);

  async function send(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    const next = [...msgs, { role: "user" as const, text: t }];
    setMsgs(next); setInput(""); setBusy(true);
    try {
      const r = await api<{ reply: string; actions: Act[] }>("POST", "/admin/assistant", { messages: next });
      setMsgs([...next, { role: "model", text: r.reply }]);
      if (r.actions.length) setActs((a) => [...a, ...r.actions]);
      history.reload();
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }

  async function decide(a: Act, approve: boolean) {
    if (approve && ["key_revoke", "key_rotate", "app_pause"].includes(a.tool) &&
        !(await confirm({ title: LABEL[a.tool] ?? a.tool, message: `${describe(a)}. This takes effect right away.`, confirm: "Approve", destructive: a.tool === "key_revoke" }))) return;
    try {
      const r = await api<any>("POST", `/admin/assistant/${approve ? "approve" : "cancel"}`, { id: a.id });
      setActs((all) => all.map((x) => (x.id === a.id ? { ...x, status: approve ? "approved" : "cancelled" } : x)));
      if (approve && r.result?.api_key) setNewKey(r.result.api_key);
      toast(approve ? "Approved and done ✓" : "Cancelled");
      history.reload();
    } catch (e) { toast((e as Error).message); }
  }

  const enabled = history.data?.enabled ?? true;
  const pending = (history.data?.actions ?? []).filter((x) => x.status === "pending_approval" && !acts.some((a) => a.id === x.id))
    .map((x) => ({ id: x.id, tool: x.tool, args: JSON.parse(x.args_json), status: x.status }));

  return (
    <div className="assistant">
      <div className="page-head"><div><h1>Assistant</h1><p className="muted">Asks the handbook, reads live stats, and fixes things — risky changes wait for your tap.</p></div></div>

      {!enabled && <div className="banner">The assistant is off. Add a free Gemini key: <code>npx wrangler secret put GEMINI_API_KEY</code></div>}
      {newKey && (
        <section className="card key-card">
          <b>New API key — copy it now, it won't be shown again</b>
          <div className="key mono">{newKey}</div>
          <button className="btn tinted sm" onClick={() => { navigator.clipboard.writeText(newKey).catch(() => {}); toast("Copied"); }}>Copy</button>
          <button className="btn plain sm" onClick={() => setNewKey(null)}>Done</button>
        </section>
      )}

      <div className="chat card">
        {!msgs.length && (
          <div className="chat-empty">
            <span className="ai-orb"><Icon name="sparkle" size={28} /></span>
            <b>How can I help?</b>
            <div className="chips">{SUGGESTIONS.map((s) => <button key={s} className="chip" onClick={() => send(s)}>{s}</button>)}</div>
          </div>
        )}
        {msgs.map((m, i) => <div key={i} className={`bubble ${m.role}`}>{m.text}</div>)}
        {[...pending, ...acts].map((a) => <ActionCard key={a.id} a={a} onDecide={decide} />)}
        {busy && <div className="bubble model typing"><span /><span /><span /></div>}
        <div ref={end} />
      </div>

      <form className="composer glass" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
        <input className="input" placeholder="Ask about the service…" value={input} onChange={(e) => setInput(e.target.value)} disabled={busy} aria-label="Message" />
        <button className="btn send" disabled={busy || !input.trim()} aria-label="Send"><Icon name="arrow" size={18} /></button>
      </form>

      <section className="card">
        <h2>Activity</h2>
        <div className="list-plain">
          {(history.data?.actions ?? []).slice(0, 15).map((x) => (
            <div key={x.id} className="li">
              <span className={`status-dot ${x.status === "done" || x.status === "approved" ? "ok" : x.status === "pending_approval" ? "warn" : "muted"}`} />
              <div className="li-main"><b>{LABEL[x.tool] ?? x.tool}</b><span className="muted small">{statusText(x.status)} · {x.source === "self-check" ? "after an alert" : "chat"} · {ago(x.created_at)}</span></div>
            </div>
          ))}
          {!history.data?.actions?.length && <p className="muted small">Nothing yet. Everything the assistant does or proposes is listed here.</p>}
        </div>
      </section>
    </div>
  );
}

function describe(a: Act) {
  const v = Object.entries(a.args).map(([k, x]) => `${k}: ${String(x)}`).join(", ");
  return `${LABEL[a.tool] ?? a.tool}${v ? ` (${v})` : ""}`;
}
const statusText = (s: string) => ({ done: "Done by assistant", approved: "Approved by you", pending_approval: "Waiting for you", cancelled: "Cancelled", failed: "Failed" } as Record<string, string>)[s] ?? s;

function ActionCard({ a, onDecide }: { a: Act; onDecide: (a: Act, ok: boolean) => void }) {
  if (a.tool.startsWith("get_") || a.tool === "list_apps" || a.tool === "run_check") return <div className="action-line muted small">✓ {LABEL[a.tool] ?? a.tool}</div>;
  return (
    <div className={`action-card ${a.status}`}>
      <div><b>{describe(a)}</b><span className="small muted">{statusText(a.status)}</span></div>
      {a.status === "pending_approval" && (
        <div className="action-buttons">
          <button className="btn secondary sm" onClick={() => onDecide(a, false)}>Cancel</button>
          <button className="btn sm" onClick={() => onDecide(a, true)}>Approve</button>
        </div>
      )}
    </div>
  );
}
