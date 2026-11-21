import { api, when } from "../api";
import { Empty, ErrorBox, PageHeader, useConfirm, useLoad, useToast } from "../ui";

type Entry = { kind: string; value: string; label: string; note: string | null; created_at: number };
const KIND: Record<string, string> = { phone: "Phone", email: "Email", domain: "Email domain", ip: "IP address" };

export function Blocklist() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, reload } = useLoad<{ entries: Entry[] }>(() => api("GET", "/admin/blocklist"));

  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    try { const r = await api("POST", "/admin/blocklist", { kind: f.kind, value: f.value, ...(f.note ? { note: f.note } : {}) }); toast(`Blocked ${r.label}`); form.reset(); reload(); }
    catch (err) { toast((err as Error).message); }
  }
  async function remove(x: Entry) {
    if (!(await confirm({ title: `Unblock ${x.label}?`, message: "They'll be able to receive codes again.", confirm: "Unblock" }))) return;
    try { await api("DELETE", `/admin/blocklist/${encodeURIComponent(x.kind)}/${encodeURIComponent(x.value)}`); toast("Unblocked"); reload(); }
    catch (err) { toast((err as Error).message); }
  }

  if (error) return <ErrorBox text={error} />;
  return (
    <>
      <PageHeader title="Blocklist" subtitle="Stop abusers. Phones, emails and IPs are stored as one-way hashes; you only see a masked form." />
      <form className="card form-grid" onSubmit={add}>
        <label className="field">Type<select className="input" name="kind"><option value="phone">Phone</option><option value="email">Email</option><option value="domain">Email domain</option><option value="ip">IP address</option></select></label>
        <label className="field">Value<input className="input" name="value" required placeholder="0241234567 · bad@x.com · spam.com · 1.2.3.4" /></label>
        <label className="field">Note (optional)<input className="input" name="note" maxLength={200} /></label>
        <button className="btn danger">Block</button>
      </form>
      <section className="card">
        {!data?.entries.length ? <Empty title="Nobody is blocked" /> : (
          <div className="list-plain">
            {data.entries.map((x) => (
              <div key={x.kind + x.value} className="li">
                <div className="li-main"><b>{x.label}</b><span className="muted small">{KIND[x.kind] ?? x.kind} · {when(x.created_at)}{x.note ? ` · ${x.note}` : ""}</span></div>
                <button className="btn plain sm" onClick={() => remove(x)}>Unblock</button>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
