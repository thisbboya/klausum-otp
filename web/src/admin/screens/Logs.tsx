import { useState } from "react";
import { api, when } from "../api";
import { Empty, ErrorBox, PageHeader, useLoad } from "../ui";

type Log = { created_at: number; request_id: string; app: string | null; channel: string | null; provider: string; status: string; error: string | null; latency_ms: number | null };

export function Logs() {
  const [q, setQ] = useState<Record<string, string>>({});
  const query = new URLSearchParams(Object.entries(q).filter(([, v]) => v).map(([k, v]) => [k, k === "from" ? String(Math.floor(new Date(v).getTime() / 1000)) : v])).toString();
  const { data, error, loading } = useLoad<{ logs: Log[] }>(() => api("GET", `/admin/logs?limit=100${query ? "&" + query : ""}`), [query]);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setQ((x) => ({ ...x, [k]: e.target.value }));

  return (
    <>
      <PageHeader title="Logs" subtitle="Every delivery attempt for 30 days. Recipients are never stored here." />
      <section className="card filters">
        <input className="input" placeholder="Request id (otp_…)" value={q.request_id ?? ""} onChange={set("request_id")} />
        <input className="input" placeholder="App name" value={q.app ?? ""} onChange={set("app")} />
        <select className="input" value={q.status ?? ""} onChange={set("status")}><option value="">Any result</option><option value="sent">Sent</option><option value="failed">Failed</option></select>
        <select className="input" value={q.provider ?? ""} onChange={set("provider")}><option value="">Any provider</option><option>resend</option><option>ahasend</option><option>textbee</option></select>
        <select className="input" value={q.channel ?? ""} onChange={set("channel")}><option value="">Email & SMS</option><option>email</option><option>sms</option></select>
        <input className="input" type="date" value={q.from ?? ""} onChange={set("from")} aria-label="Since" />
      </section>
      {error && <ErrorBox text={error} />}
      <section className="card">
        {loading && !data ? <div className="skeleton" /> : !data?.logs.length ? <Empty title="Nothing found" text="Try fewer filters." /> : (
          <div className="list-plain">
            {data.logs.map((l, i) => (
              <div key={i} className="li log">
                <span className={`status-dot ${l.status === "sent" ? "ok" : "bad"}`} />
                <div className="li-main">
                  <b>{l.provider} <span className="muted">· {l.app ?? "—"} · {l.channel ?? ""}</span></b>
                  <span className="muted small">{when(l.created_at)} · <span className="mono">{l.request_id}</span></span>
                  {l.error && <span className="log-error small">{l.error}</span>}
                </div>
                <span className="muted small mono">{l.latency_ms != null ? `${l.latency_ms} ms` : ""}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
