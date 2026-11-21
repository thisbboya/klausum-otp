import { useState } from "react";
import { api, ago } from "../api";
import { Empty, ErrorBox, PageHeader, useConfirm, useLoad, useToast } from "../ui";

type App = { id: string; name: string; display_name: string | null; allowed_origins: string[]; daily_cap: number; otp_ttl_seconds: number; sms_app_hash: string | null; status: string; key_last_used_at: number | null; active_keys: number };

export function Apps() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, reload } = useLoad<{ apps: App[] }>(() => api("GET", "/admin/apps"));
  const [shownKey, setShownKey] = useState<{ title: string; key: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try {
      const r = await api("POST", "/admin/apps", { name: f.name, display_name: f.display_name, mode: f.mode });
      setShownKey({ title: `Key for ${r.name}`, key: r.api_key }); setCreating(false); reload();
    } catch (err) { toast((err as Error).message); }
  }

  async function act(a: App, what: "pause" | "resume" | "rotate" | "revoke" | "delete") {
    try {
      if (what === "pause" || what === "resume") {
        if (what === "pause" && !(await confirm({ title: `Pause ${a.display_name || a.name}?`, message: "Its keys stop working within 10 seconds until you resume it.", confirm: "Pause" }))) return;
        await api("PATCH", `/admin/apps/${a.id}`, { status: what === "pause" ? "paused" : "active" }); toast(what === "pause" ? "Paused" : "Resumed");
      } else if (what === "rotate") {
        if (!(await confirm({ title: "Make a new key?", message: "The new key works right away. Old keys keep working for 24 hours, then stop.", confirm: "Rotate" }))) return;
        const r = await api("POST", `/admin/apps/${a.id}/keys/rotate`, {}); setShownKey({ title: `New key for ${a.name}`, key: r.api_key });
      } else if (what === "revoke") {
        if (!(await confirm({ title: "Revoke all keys?", message: "Every key of this app stops within 10 seconds. The app breaks until you give it a new key.", confirm: "Revoke", destructive: true }))) return;
        const r = await api("POST", `/admin/apps/${a.id}/keys/revoke`, {}); toast(`Revoked ${r.revoked} key(s)`);
      } else {
        if (!(await confirm({ title: `Delete ${a.name}?`, message: "Deletes the app, its keys and its users' authenticator enrolments. This can't be undone.", confirm: "Delete", destructive: true, typeToConfirm: a.name }))) return;
        await api("DELETE", `/admin/apps/${a.id}?confirm=${encodeURIComponent(a.id)}`); toast("Deleted");
      }
      reload();
    } catch (e) { toast((e as Error).message); }
  }

  async function save(a: App, e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try {
      await api("PATCH", `/admin/apps/${a.id}`, {
        display_name: f.display_name, daily_cap: Number(f.daily_cap), otp_ttl_seconds: Number(f.otp_ttl_seconds),
        allowed_origins: f.allowed_origins.split(",").map((s) => s.trim()).filter(Boolean), sms_app_hash: f.sms_app_hash || null,
      });
      toast("Saved"); setEditing(null); reload();
    } catch (err) { toast((err as Error).message); }
  }

  if (error) return <ErrorBox text={error} />;
  return (
    <>
      <PageHeader title="Apps & Keys" subtitle="Every project that sends codes, and its keys.">
        <button className="btn sm" onClick={() => setCreating((x) => !x)}>{creating ? "Cancel" : "New app"}</button>
      </PageHeader>

      {shownKey && (
        <section className="card key-card">
          <b>{shownKey.title} — copy it now, it won't be shown again</b>
          <div className="key mono">{shownKey.key}</div>
          <div className="row-gap">
            <button className="btn tinted sm" onClick={() => { navigator.clipboard.writeText(shownKey.key).catch(() => {}); toast("Copied"); }}>Copy</button>
            <button className="btn plain sm" onClick={() => setShownKey(null)}>I've saved it</button>
          </div>
        </section>
      )}

      {creating && (
        <form className="card form-grid" onSubmit={create}>
          <label className="field">Name (a–z, 0–9, -)<input className="input" name="name" required pattern="[a-z0-9][a-z0-9-]{1,39}" /></label>
          <label className="field">Shown in emails<input className="input" name="display_name" required maxLength={40} /></label>
          <label className="field">Key type<select className="input" name="mode"><option value="live">Live — sends codes</option><option value="test">Test — sends nothing</option></select></label>
          <button className="btn">Create</button>
        </form>
      )}

      {data && !data.apps.length && <section className="card"><Empty title="No apps yet" /></section>}
      <div className="stack">
        {data?.apps.map((a) => (
          <section key={a.id} className="card app">
            <div className="app-head">
              <div className="app-avatar">{(a.display_name || a.name)[0].toUpperCase()}</div>
              <div className="app-title"><b>{a.display_name || a.name}</b><span className="muted small mono">{a.name}</span></div>
              <span className={`badge ${a.status === "active" ? "green" : "orange"}`}><span className="dot" />{a.status === "active" ? "Active" : "Paused"}</span>
            </div>
            <div className="facts small">
              <span><b>{a.daily_cap}</b> codes/day</span>
              <span><b>{Math.round(a.otp_ttl_seconds / 60)}</b> min codes</span>
              <span><b>{a.active_keys}</b> active key{a.active_keys === 1 ? "" : "s"}</span>
              <span className="muted">last used {ago(a.key_last_used_at)}</span>
            </div>
            {editing === a.id ? (
              <form className="form-grid" onSubmit={(e) => save(a, e)}>
                <label className="field">Shown in emails<input className="input" name="display_name" defaultValue={a.display_name ?? ""} required maxLength={40} /></label>
                <label className="field">Daily cap<input className="input" name="daily_cap" type="number" min={1} max={10000} defaultValue={a.daily_cap} /></label>
                <label className="field">Code lifetime (seconds)<input className="input" name="otp_ttl_seconds" type="number" min={60} max={600} defaultValue={a.otp_ttl_seconds} /></label>
                <label className="field">Allowed websites (comma-separated)<input className="input" name="allowed_origins" defaultValue={a.allowed_origins.join(", ")} placeholder="https://klausum.study" /></label>
                <label className="field">Android SMS app hash<input className="input" name="sms_app_hash" maxLength={11} defaultValue={a.sms_app_hash ?? ""} /></label>
                <div className="row-gap"><button className="btn sm">Save</button><button type="button" className="btn secondary sm" onClick={() => setEditing(null)}>Cancel</button></div>
              </form>
            ) : (
              <div className="row-gap wrap">
                <button className="btn secondary sm" onClick={() => setEditing(a.id)}>Edit</button>
                <button className="btn secondary sm" onClick={() => act(a, a.status === "active" ? "pause" : "resume")}>{a.status === "active" ? "Pause" : "Resume"}</button>
                <button className="btn tinted sm" onClick={() => act(a, "rotate")}>Rotate key</button>
                <button className="btn danger sm" onClick={() => act(a, "revoke")}>Revoke keys</button>
                <button className="btn plain sm destructive-text" onClick={() => act(a, "delete")}>Delete</button>
              </div>
            )}
          </section>
        ))}
      </div>
    </>
  );
}
