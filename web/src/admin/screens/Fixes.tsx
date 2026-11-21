import { useEffect, useState } from "react";
import { api, ago } from "../api";
import { Empty, ErrorBox, PageHeader, useConfirm, useLoad, useToast } from "../ui";
import type { ScreenProps } from "../App";

type Action = { id: string; label: string; tool: string; args: Record<string, unknown>; safe: boolean };
type Fix = { alertKey: string; since: number; aiDiagnosis: string | null; entry: { title: string; meaning: string; userImpact: string; actions: Action[] } | null };

export function Fixes({ onFixesChanged, go }: ScreenProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, reload } = useLoad<{ fixes: Fix[] }>(() => api("GET", "/admin/fixes"));
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { if (data) onFixesChanged(data.fixes.length); }, [data, onFixesChanged]);

  async function check() {
    setBusy("check");
    try { const r = await api("POST", "/admin/actions/run", { tool: "run_check", args: {} }); toast(r.result.alerts.length ? `${r.result.alerts.length} problem(s) found` : "All clear ✓"); await reload(); }
    catch (e) { toast((e as Error).message); } finally { setBusy(null); }
  }

  async function run(a: Action) {
    let args = { ...a.args };
    if (a.tool === "block_add" && !args.value) {
      const v = prompt("Which IP address should be blocked?");
      if (!v) return;
      args = { ...args, value: v.trim() };
    }
    if (!a.safe && !(await confirm({ title: a.label, message: "This changes how the service behaves. Continue?", confirm: a.label }))) return;
    setBusy(a.id);
    try {
      const r = await api("POST", "/admin/actions/run", { tool: a.tool, args });
      toast(a.tool.startsWith("get_") ? "See the result below" : "Done ✓");
      if (a.tool.startsWith("get_")) setResult({ title: a.label, data: r.result });
      await reload();
    } catch (e) { toast((e as Error).message); } finally { setBusy(null); }
  }
  const [result, setResult] = useState<{ title: string; data: unknown } | null>(null);

  if (error) return <ErrorBox text={error} />;
  return (
    <>
      <PageHeader title="Fixes" subtitle="Problems the self-check found, what they mean, and one-tap fixes.">
        <button className="btn secondary sm" disabled={busy === "check"} onClick={check}>{busy === "check" ? "Checking…" : "Run check now"}</button>
      </PageHeader>

      {data && !data.fixes.length && <section className="card"><Empty title="Everything looks healthy ✓" text="The self-check runs every 15 minutes. Problems will show up here with their fixes." /></section>}

      {data?.fixes.map((f) => (
        <section key={f.alertKey} className="card fix">
          <div className="fix-head">
            <span className="badge orange"><span className="dot" />Open</span>
            <span className="muted small">since {ago(f.since)}</span>
          </div>
          <h2>{f.entry?.title ?? f.alertKey}</h2>
          {f.aiDiagnosis && <div className="ai-note"><b>Assistant</b><p>{f.aiDiagnosis}</p></div>}
          {f.entry && (
            <>
              <p>{f.entry.meaning}</p>
              <p className="muted small"><b>For users:</b> {f.entry.userImpact}</p>
              <div className="fix-actions">
                {f.entry.actions.map((a) => (
                  <button key={a.id} className={`btn ${a.safe ? "tinted" : "secondary"} sm`} disabled={busy === a.id} onClick={() => run(a)}>
                    {busy === a.id ? "Working…" : a.label}
                  </button>
                ))}
                <button className="btn plain sm" onClick={() => go("assistant")}>Ask the assistant</button>
              </div>
            </>
          )}
        </section>
      ))}

      {result && (
        <section className="card">
          <div className="card-head"><h2>{result.title}</h2><button className="btn plain sm" onClick={() => setResult(null)}>Close</button></div>
          <pre className="json">{JSON.stringify(result.data, null, 2)}</pre>
        </section>
      )}
    </>
  );
}
