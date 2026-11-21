import { useEffect } from "react";
import { api, pct } from "../api";
import { ErrorBox, PageHeader, useLoad } from "../ui";
import type { ScreenProps } from "../App";

type Stats = any;

export function Overview({ go }: ScreenProps) {
  const { data: s, error, reload } = useLoad<Stats>(() => api("GET", "/admin/stats"));
  useEffect(() => { const t = setInterval(() => !document.hidden && reload(), 60_000); return () => clearInterval(t); }, [reload]);
  if (error) return <ErrorBox text={error} />;
  if (!s) return <div className="skeleton" />;

  const T = s.today;
  const ok = T.email.delivered + T.sms.delivered, bad = T.email.failed + T.sms.failed;
  const due = (s.secrets ?? []).filter((x: any) => x.due);
  const max = Math.max(1, ...s.days.map((d: any) => d.email + d.sms));

  return (
    <>
      <PageHeader title="Overview" subtitle={`Updated ${new Date(s.generatedAt).toLocaleTimeString()}`}>
        <button className="btn secondary sm" onClick={reload}>Refresh</button>
      </PageHeader>

      {due.length > 0 && (
        <button className="banner warn" onClick={() => go("settings")}>
          🔑 {due.length} secret{due.length > 1 ? "s" : ""} due for rotation — open Settings
        </button>
      )}

      <div className="tiles">
        <Tile label="Codes today" value={T.email.sends + T.sms.sends} sub={`${T.email.sends} email · ${T.sms.sends} SMS`} />
        <Tile label="Delivered" value={ok + bad ? pct(ok / (ok + bad)) : "—"} sub={bad ? `${bad} failed` : "none failed"} tone={bad ? "orange" : "green"} />
        <Tile label="Delivery time" value={T.avgDeliveryMs == null ? "—" : `${T.avgDeliveryMs} ms`} sub="average, today" />
        <Tile label="Verified" value={T.verify.ok} sub={`${T.verify.failed} wrong tries`} />
      </div>

      <div className="two-col">
        <section className="card">
          <h2>Free quota</h2>
          <div className="meters">
            {s.quotas.map((q: any) => {
              const tone = q.ratio >= 0.9 ? "red" : q.ratio >= 0.7 ? "orange" : "green";
              return (
                <div key={q.provider} className="meter">
                  <div className="meter-row"><b>{q.label}</b>{q.exhaustedToday && <span className="badge red">used up today</span>}<span className="muted small">{q.day ? `${q.usedToday}/${q.day} today · ` : ""}{q.usedMonth}/{q.month} month</span></div>
                  <div className="bar"><i className={tone} style={{ width: `${Math.min(100, Math.round(q.ratio * 100))}%` }} /></div>
                </div>
              );
            })}
          </div>
        </section>
        <section className="card">
          <h2>Last 7 days</h2>
          <div className="chart" role="img" aria-label="Codes per day">
            {s.days.map((d: any) => {
              const h = Math.round(((d.email + d.sms) / max) * 120);
              return (
                <div key={d.day} className="col">
                  <span className="n">{d.email + d.sms}</span>
                  <div className="stick" style={{ height: Math.max(3, h) }}><span className="sms" style={{ height: d.email + d.sms ? `${(d.sms / (d.email + d.sms)) * 100}%` : 0 }} /></div>
                  <small>{new Date(d.day + "T00:00:00Z").toLocaleDateString([], { weekday: "short" })}</small>
                </div>
              );
            })}
          </div>
          <div className="legend small muted"><span><i className="sw email" />Email</span><span><i className="sw sms" />SMS</span></div>
        </section>
      </div>

      <section className="card">
        <div className="card-head"><h2>Recent deliveries</h2><button className="btn plain sm" onClick={() => go("logs")}>All logs</button></div>
        <div className="list-plain">
          {s.recent.slice(0, 6).map((l: any, i: number) => (
            <div key={i} className="li">
              <span className={`status-dot ${l.status === "sent" ? "ok" : "bad"}`} />
              <div className="li-main"><b>{l.provider}</b><span className="muted small">{l.channel ?? ""} · {new Date(l.created_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>
              <span className="muted small mono">{l.latency_ms ?? ""}{l.latency_ms != null ? " ms" : ""}</span>
            </div>
          ))}
          {!s.recent.length && <p className="muted small">Nothing sent yet.</p>}
        </div>
      </section>
    </>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: "green" | "orange" }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <b className={`tile-value ${tone ?? ""}`}>{value}</b>
      {sub && <span className="tile-sub muted">{sub}</span>}
    </div>
  );
}
