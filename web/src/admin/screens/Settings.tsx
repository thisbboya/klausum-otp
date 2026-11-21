import { useState } from "react";
import { api, when } from "../api";
import { ErrorBox, PageHeader, useLoad, useToast } from "../ui";
import { Icon } from "../../ui/components";
import type { ScreenProps } from "../App";

export function Settings({ go }: ScreenProps) {
  const toast = useToast();
  const { data, error, reload } = useLoad<any>(() => api("GET", "/admin/stats"));
  const [busy, setBusy] = useState<string | null>(null);

  async function post(path: string, body: unknown, ok: string, key: string) {
    setBusy(key);
    try { await api("POST", path, body); toast(ok); reload(); } catch (e) { toast((e as Error).message); } finally { setBusy(null); }
  }

  if (error) return <ErrorBox text={error} />;
  return (
    <>
      <PageHeader title="Settings" />

      <section className="card phone-only">
        <h2>More</h2>
        <div className="list-plain">
          {([["logs", "Logs", "list"], ["providers", "Providers", "switch"], ["blocklist", "Blocklist", "block"]] as const).map(([id, label, icon]) => (
            <button key={id} className="li nav-row" onClick={() => go(id)}><Icon name={icon} size={20} /><b>{label}</b><span className="chev">›</span></button>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Secrets</h2>
        <p className="muted small">Rotate every 180 days (docs/ROTATION.md). After you rotate one, tap Mark rotated.</p>
        <div className="list-plain">
          {(data?.secrets ?? []).map((s: any) => (
            <div key={s.name} className="li">
              <div className="li-main"><b className="mono small">{s.name}</b><span className="muted small">set {when(s.setAt)} · {s.ageDays} days old</span></div>
              {s.due ? <span className="badge orange">Rotate</span> : <span className="badge green">OK</span>}
              <button className="btn plain sm" disabled={busy === s.name} onClick={() => post("/admin/secrets/rotated", { name: s.name }, `${s.name} marked rotated`, s.name)}>Mark rotated</button>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Alerts & checks</h2>
        <div className="row-gap wrap">
          <button className="btn secondary sm" disabled={busy === "test"} onClick={() => post("/admin/monitor/test-alert", {}, "Test alert sent to Telegram and email", "test")}>Send test alert</button>
          <button className="btn secondary sm" disabled={busy === "check"} onClick={() => post("/admin/monitor/check", {}, "Check finished", "check")}>Run self-check</button>
          <button className="btn secondary sm" disabled={busy === "sum"} onClick={() => post("/admin/monitor/daily-summary", {}, "Daily summary sent", "sum")}>Send daily summary now</button>
        </div>
      </section>

      <section className="card">
        <h2>About</h2>
        <div className="list-plain small">
          <a className="li nav-row" href="https://status.klausum.study" target="_blank" rel="noreferrer"><b>Public status page</b><span className="chev">›</span></a>
          <a className="li nav-row" href="https://github.com/thisbboya/klausum-otp" target="_blank" rel="noreferrer"><b>Code on GitHub</b><span className="chev">›</span></a>
          <a className="li nav-row" href="https://github.com/thisbboya/klausum-otp/blob/main/docs/RUNBOOK.md" target="_blank" rel="noreferrer"><b>Runbook</b><span className="chev">›</span></a>
        </div>
      </section>
    </>
  );
}
