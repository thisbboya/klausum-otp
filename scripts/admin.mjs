#!/usr/bin/env node
// Klausum OTP admin CLI — for when you're at your laptop or the dashboard is down.
//   npm run admin -- <command> [args]
// Reads ADMIN_TOKEN from the environment or .secrets.local. Talks to the live admin API.
import { readFileSync } from "node:fs";

const BASE = process.env.OTP_URL ?? "https://otp.klausum.study";
let TOKEN = process.env.ADMIN_TOKEN;
if (!TOKEN) { try { TOKEN = /^ADMIN_TOKEN=(.+)$/m.exec(readFileSync(".secrets.local", "utf8"))?.[1].trim(); } catch {} }

const HELP = `Klausum OTP admin

  apps:list                         all apps, caps, status, last key use
  apps:create <name> [display]      new app; prints its key ONCE   (--test for a kotp_test_ key)
  apps:pause <app> | apps:resume <app>
  apps:cap <app> <n>                set daily send cap
  keys:list <app>                   keys of an app
  keys:rotate <app>                 new key now; old keys keep working 24 h
  keys:revoke <app> [key_id]        stop keys immediately (all, or one)
  stats:today                       today's numbers and free-quota meters
  logs:tail [n] [--failed] [--app <app>]   latest deliveries (no recipients shown)
  provider:list
  provider:disable <resend|ahasend|textbee> | provider:enable <name>
  provider:order <first> [second]   e.g. provider:order ahasend resend
  block:list
  block:add <phone|email|domain|ip> <value> [note]
  block:remove <kind> <stored value from block:list>

<app> = app name (e.g. klausum-web) or id.  Env: ADMIN_TOKEN, OTP_URL.`;

async function api(method, path, body) {
  const r = await fetch(BASE + "/admin" + path, {
    method, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`✖ ${r.status} ${j.error ?? ""} ${(j.issues ?? []).join("; ")}`); process.exit(1); }
  return j;
}
async function appId(ref) {
  if (!ref) { console.error("✖ which app?"); process.exit(1); }
  const { apps } = await api("GET", "/apps");
  const a = apps.find((x) => x.id === ref || x.name === ref);
  if (!a) { console.error(`✖ no app "${ref}". Try apps:list`); process.exit(1); }
  return a.id;
}
const when = (t) => (t ? new Date(t * 1000).toISOString().replace("T", " ").slice(0, 16) : "—");
const pct = (x) => (x == null ? "—" : Math.round(x * 100) + "%");

const [cmd, ...args] = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); if (i < 0) return false; args.splice(i, 1); return true; };
const opt = (f) => { const i = args.indexOf(f); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
if (!cmd || cmd === "help" || cmd === "--help") { console.log(HELP); process.exit(0); }
if (!TOKEN) { console.error("✖ No ADMIN_TOKEN (env or .secrets.local)."); process.exit(1); }

switch (cmd) {
  case "apps:list": {
    const { apps } = await api("GET", "/apps");
    console.table(apps.map((a) => ({ name: a.name, display: a.display_name, status: a.status, cap: a.daily_cap, ttl: a.otp_ttl_seconds, keys: a.active_keys, "last used": when(a.key_last_used_at), id: a.id })));
    break;
  }
  case "apps:create": {
    const test = flag("--test");
    const r = await api("POST", "/apps", { name: args[0], ...(args[1] ? { display_name: args.slice(1).join(" ") } : {}), mode: test ? "test" : "live" });
    console.log(`✔ ${r.name} (${r.id})\n\n  API key (shown once — store it now):\n  ${r.api_key}\n`);
    break;
  }
  case "apps:pause": case "apps:resume":
    await api("PATCH", `/apps/${await appId(args[0])}`, { status: cmd === "apps:pause" ? "paused" : "active" });
    console.log(`✔ ${args[0]} ${cmd === "apps:pause" ? "paused" : "active"} (within 10 s everywhere)`);
    break;
  case "apps:cap":
    await api("PATCH", `/apps/${await appId(args[0])}`, { daily_cap: Number(args[1]) });
    console.log(`✔ ${args[0]} daily cap = ${args[1]}`);
    break;
  case "keys:list": {
    const { keys } = await api("GET", `/apps/${await appId(args[0])}/keys`);
    console.table(keys.map((k) => ({ id: k.id, prefix: k.prefix + "…", created: when(k.created_at), expires: when(k.expires_at), revoked: when(k.revoked_at), "last used": when(k.last_used_at) })));
    break;
  }
  case "keys:rotate": {
    const r = await api("POST", `/apps/${await appId(args[0])}/keys/rotate`, {});
    console.log(`✔ New key (shown once — store it now):\n  ${r.api_key}\n  Old keys stop working at ${when(r.old_keys_expire_at)} UTC.`);
    break;
  }
  case "keys:revoke": {
    const r = await api("POST", `/apps/${await appId(args[0])}/keys/revoke`, args[1] ? { key_id: args[1] } : {});
    console.log(`✔ revoked ${r.revoked} key(s) (within 10 s everywhere)`);
    break;
  }
  case "stats:today": {
    const s = await api("GET", "/stats");
    const t = s.today;
    console.log(`Today (UTC)  email ${t.email.sends} sent, ${t.email.failed} failed · sms ${t.sms.sends} sent, ${t.sms.failed} failed`);
    console.log(`             delivery success ${pct((t.email.delivered + t.sms.delivered) / Math.max(1, t.email.delivered + t.sms.delivered + t.email.failed + t.sms.failed))} · avg delivery ${t.avgDeliveryMs ?? "—"} ms · verified ${t.verify.ok} (${t.verify.failed} wrong)`);
    console.log(`This week    ${s.week.email.sends + s.week.sms.sends} codes\n\nFree quota:`);
    for (const q of s.quotas) console.log(`  ${q.label.padEnd(12)} ${q.day ? `${q.usedToday}/${q.day} today  ` : ""}${q.usedMonth}/${q.month} month  ${q.ratio >= 0.9 ? "🔴" : q.ratio >= 0.7 ? "🟡" : "🟢"}${q.exhaustedToday ? "  (used up today)" : ""}`);
    break;
  }
  case "logs:tail": {
    const failed = flag("--failed"), app = opt("--app");
    const q = new URLSearchParams({ limit: String(Number(args[0]) || 20), ...(failed ? { status: "failed" } : {}), ...(app ? { app } : {}) });
    const { logs } = await api("GET", `/logs?${q}`);
    for (const l of logs) console.log(`${when(l.created_at)}  ${(l.app ?? "?").padEnd(12)} ${(l.channel ?? "").padEnd(5)} ${l.provider.padEnd(8)} ${l.status === "sent" ? "✔" : "✖"} ${String(l.latency_ms ?? "").padStart(5)}ms  ${l.request_id}${l.error ? "\n      " + l.error.slice(0, 160) : ""}`);
    if (!logs.length) console.log("(nothing)");
    break;
  }
  case "provider:list": console.log(await api("GET", "/providers")); break;
  case "provider:disable": case "provider:enable": {
    const cur = await api("GET", "/providers");
    const set = new Set(cur.disabled);
    cmd === "provider:disable" ? set.add(args[0]) : set.delete(args[0]);
    console.log("✔", await api("PUT", "/providers", { ...cur, disabled: [...set] }));
    break;
  }
  case "provider:order": {
    const cur = await api("GET", "/providers");
    console.log("✔", await api("PUT", "/providers", { ...cur, email_order: args }));
    break;
  }
  case "block:list": {
    const { entries } = await api("GET", "/blocklist");
    console.table(entries.map((e) => ({ kind: e.kind, who: e.label, note: e.note ?? "", added: when(e.created_at), value: e.value })));
    break;
  }
  case "block:add": {
    const r = await api("POST", "/blocklist", { kind: args[0], value: args[1], ...(args[2] ? { note: args.slice(2).join(" ") } : {}) });
    console.log(`✔ blocked ${r.kind} ${r.label}`);
    break;
  }
  case "block:remove":
    await api("DELETE", `/blocklist/${encodeURIComponent(args[0])}/${encodeURIComponent(args[1])}`);
    console.log("✔ removed");
    break;
  default:
    console.error(`✖ unknown command "${cmd}"\n`); console.log(HELP); process.exit(1);
}
