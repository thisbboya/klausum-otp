import { useEffect, useState } from "react";
import { api } from "../api";
import { ErrorBox, PageHeader, useLoad, useToast } from "../ui";

type P = { email_order: ("resend" | "ahasend")[]; disabled: string[] };
const INFO: Record<string, string> = { resend: "Email · 100/day, 3,000/month free", ahasend: "Email · 1,000/month free", textbee: "SMS from your Android phone · 50/day" };

export function Providers() {
  const toast = useToast();
  const { data, error } = useLoad<P>(() => api("GET", "/admin/providers"));
  const [p, setP] = useState<P | null>(null);
  useEffect(() => { if (data) setP(data); }, [data]);

  async function save(next: P) {
    setP(next);
    try { await api("PUT", "/admin/providers", next); toast("Saved — applies to the next code"); }
    catch (e) { toast((e as Error).message); if (data) setP(data); }
  }
  if (error) return <ErrorBox text={error} />;
  if (!p) return <div className="skeleton" />;
  const swap = () => save({ ...p, email_order: [...p.email_order].reverse() as P["email_order"] });
  const toggle = (name: string, on: boolean) => save({ ...p, disabled: on ? p.disabled.filter((x) => x !== name) : [...new Set([...p.disabled, name])] });

  return (
    <>
      <PageHeader title="Providers" subtitle="Who delivers your codes. Changes apply instantly — no redeploy." />
      <section className="card">
        <h2>Email order</h2>
        <div className="order">
          {p.email_order.map((n, i) => <div key={n} className="order-item"><span className="order-n">{i + 1}</span><b>{n}</b><span className="muted small">{i === 0 ? "tried first" : "backup"}</span></div>)}
        </div>
        <button className="btn tinted sm" onClick={swap}>Swap order</button>
      </section>
      <section className="card">
        <h2>On / Off</h2>
        <div className="list-plain">
          {["resend", "ahasend", "textbee"].map((n) => {
            const on = !p.disabled.includes(n);
            return (
              <label key={n} className="li toggle-row">
                <div className="li-main"><b>{n}</b><span className="muted small">{INFO[n]}</span></div>
                <input type="checkbox" className="switch" checked={on} onChange={(e) => toggle(n, e.target.checked)} aria-label={`${n} ${on ? "on" : "off"}`} />
              </label>
            );
          })}
        </div>
      </section>
    </>
  );
}
