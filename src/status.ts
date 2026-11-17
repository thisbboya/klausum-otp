/**
 * Public status page — status.klausum.study (and /status on the main domain).
 * Data: the 15-minute self-check writes `check:ok` / `check:degraded` per day into stats_daily
 * and opens/closes rows in `incidents` for user-facing problems only (internal ones like quota
 * warnings or secret age never appear publicly). No personal data is ever shown.
 */
import type { Env } from "./index";
import { statStmt, utcDay } from "./stats";

/** Which alerts are public, under which component and wording. */
export function publicIncident(key: string): { component: "api" | "email"; title: string } | null {
  if (key === "d1") return { component: "api", title: "Codes can't be sent or checked (database problem)" };
  if (key === "errors") return { component: "email", title: "Some codes are failing to deliver" };
  if (key.startsWith("streak:") || key.startsWith("key:")) return { component: "email", title: "Email delivery is slower than usual (using backup provider)" };
  return null; // quota, spike, secrets, sms phone: internal only
}

/** Called by the self-check with the current set of alert keys. */
export async function recordStatus(env: Env, alertKeys: string[]) {
  const t = Math.floor(Date.now() / 1000);
  const pub = alertKeys.map((k) => ({ k, p: publicIncident(k) })).filter((x) => x.p) as { k: string; p: NonNullable<ReturnType<typeof publicIncident>> }[];
  const { results: open } = await env.DB.prepare("SELECT id, key FROM incidents WHERE resolved_at IS NULL").all<{ id: string; key: string }>();
  const openKeys = new Set(open.map((o) => o.key));
  const nowKeys = new Set(pub.map((x) => x.k));
  await env.DB.batch([
    statStmt(env.DB, pub.length ? "check:degraded" : "check:ok"),
    ...pub.filter((x) => !openKeys.has(x.k)).map((x) =>
      env.DB.prepare("INSERT INTO incidents (id,key,component,title,started_at) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(), x.k, x.p.component, x.p.title, t)),
    ...open.filter((o) => !nowKeys.has(o.key)).map((o) => env.DB.prepare("UPDATE incidents SET resolved_at=? WHERE id=?").bind(t, o.id)),
  ]);
}

export async function statusData(env: Env, now = Date.now()) {
  const from = utcDay(now - 89 * 86400_000);
  const [days, incidents] = await env.DB.batch([
    env.DB.prepare("SELECT day, key, count FROM stats_daily WHERE day >= ? AND key IN ('check:ok','check:degraded')").bind(from),
    env.DB.prepare("SELECT component, title, started_at, resolved_at FROM incidents WHERE started_at > ? ORDER BY started_at DESC LIMIT 30").bind(Math.floor(now / 1000) - 90 * 86400),
  ]);
  const rows = days.results as { day: string; key: string; count: number }[];
  const series = Array.from({ length: 90 }, (_, i) => {
    const d = utcDay(now - (89 - i) * 86400_000);
    const ok = rows.find((r) => r.day === d && r.key === "check:ok")?.count ?? 0;
    const bad = rows.find((r) => r.day === d && r.key === "check:degraded")?.count ?? 0;
    return { day: d, checks: ok + bad, uptime: ok + bad ? ok / (ok + bad) : null };
  });
  const measured = series.filter((d) => d.uptime !== null);
  const uptime90 = measured.length ? measured.reduce((a, d) => a + (d.uptime as number) * d.checks, 0) / measured.reduce((a, d) => a + d.checks, 0) : null;
  const inc = incidents.results as { component: string; title: string; started_at: number; resolved_at: number | null }[];
  const openNow = inc.filter((i) => i.resolved_at === null);
  const comp = (c: string) => (openNow.some((i) => i.component === c) ? "degraded" : "operational");
  return {
    overall: openNow.length ? "degraded" : "operational",
    components: [
      { id: "api", name: "Code API", status: comp("api") },
      { id: "email", name: "Email delivery", status: comp("email") },
      { id: "authenticator", name: "Authenticator codes", status: comp("api") },
    ],
    uptime90,
    days: series,
    incidents: inc,
    updatedAt: new Date(now).toISOString(),
  };
}

export const STATUS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Klausum OTP · Status</title>
<meta name="description" content="Live status of the Klausum one-time code service.">
<link rel="stylesheet" href="/status.css">
</head>
<body>
<main>
  <header><div class="logo"><span></span>Klausum OTP</div><a href="https://otp.klausum.study">otp.klausum.study</a></header>
  <section class="hero" id="hero"><div class="badge" id="badge">Checking…</div><h1 id="headline">Loading status</h1><p id="sub" class="muted"></p></section>
  <section class="card"><div id="components"></div></section>
  <section class="card"><div class="row"><h2>Last 90 days</h2><span id="uptime" class="muted"></span></div><div class="bars" id="bars" role="img" aria-label="Daily uptime, last 90 days"></div><div class="row muted small"><span>90 days ago</span><span>Today</span></div></section>
  <section class="card"><h2>Incidents</h2><div id="incidents"></div></section>
  <footer class="muted small">Checked from inside the service every 15 minutes. Updated <span id="updated"></span>.</footer>
</main>
<script src="/status.js" defer></script>
</body>
</html>`;

export const STATUS_CSS = `
:root{--bg:#f5f5f7;--card:#fff;--ink:#1d1d1f;--muted:#6e6e73;--line:#e5e5ea;--ok:#34c759;--warn:#ff9f0a;--bad:#ff3b30;--none:#e5e5ea;color-scheme:light;
 font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--ink:#f5f5f7;--muted:#98989d;--line:#2c2c2e;--none:#2c2c2e;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased}
main{max-width:760px;margin:0 auto;padding:24px 16px 48px}
header{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px}header a{color:var(--muted);text-decoration:none;font-size:14px}
.logo{font-weight:600;font-size:17px;display:flex;gap:8px;align-items:center}.logo span{width:12px;height:12px;border-radius:4px;background:linear-gradient(135deg,#0a84ff,#5e5ce6)}
.hero{text-align:center;padding:24px 0 32px}.hero h1{font-size:34px;letter-spacing:-.02em;margin:14px 0 6px;font-weight:700}
.badge{display:inline-flex;gap:8px;align-items:center;padding:6px 14px;border-radius:99px;font-weight:600;font-size:14px;background:var(--card);border:1px solid var(--line)}
.badge::before{content:"";width:9px;height:9px;border-radius:50%;background:var(--muted)}.badge.ok::before{background:var(--ok)}.badge.warn::before{background:var(--warn)}
.card{background:var(--card);border-radius:18px;padding:20px;margin-bottom:16px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
h2{font-size:17px;margin:0 0 12px;font-weight:600}.row{display:flex;justify-content:space-between;align-items:baseline}
.comp{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--line);font-size:15px}.comp:last-child{border:0}
.st{font-weight:600}.st.operational{color:var(--ok)}.st.degraded{color:var(--warn)}
.bars{display:grid;grid-template-columns:repeat(90,1fr);gap:2px;height:34px;margin:6px 0 8px}.bars i{border-radius:2px;background:var(--none)}
.bars i.ok{background:var(--ok)}.bars i.warn{background:var(--warn)}.bars i.bad{background:var(--bad)}
.inc{padding:12px 0;border-bottom:1px solid var(--line)}.inc:last-child{border:0}.inc b{font-weight:600}
.muted{color:var(--muted)}.small{font-size:12px}footer{text-align:center;margin-top:24px}
`;

export const STATUS_JS = `
(async () => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
  const fmt = (t) => new Date(t * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  try {
    const d = await (await fetch("/status.json")).json();
    const ok = d.overall === "operational";
    $("badge").textContent = ok ? "Operational" : "Degraded"; $("badge").className = "badge " + (ok ? "ok" : "warn");
    $("headline").textContent = ok ? "All systems operational" : "Some systems are degraded";
    $("sub").textContent = ok ? "Codes are being sent and checked normally." : "We're on it. Details below.";
    $("components").innerHTML = d.components.map((c) => '<div class="comp"><span>' + esc(c.name) + '</span><span class="st ' + c.status + '">' + (c.status === "operational" ? "Operational" : "Degraded") + "</span></div>").join("");
    $("uptime").textContent = d.uptime90 == null ? "No data yet" : (Math.floor(d.uptime90 * 10000) / 100) + "% uptime";
    $("bars").innerHTML = d.days.map((x) => '<i class="' + (x.uptime == null ? "" : x.uptime >= 0.999 ? "ok" : x.uptime >= 0.95 ? "warn" : "bad") + '" title="' + x.day + ": " + (x.uptime == null ? "no data" : (Math.floor(x.uptime * 1000) / 10) + "%") + '"></i>').join("");
    $("incidents").innerHTML = d.incidents.length ? d.incidents.map((i) => '<div class="inc"><b>' + esc(i.title) + '</b><div class="muted small">' + fmt(i.started_at) + " — " + (i.resolved_at ? "resolved " + fmt(i.resolved_at) : "ongoing") + "</div></div>").join("") : '<p class="muted">No incidents in the last 90 days.</p>';
    $("updated").textContent = new Date(d.updatedAt).toLocaleTimeString();
  } catch { $("headline").textContent = "Status unavailable"; $("sub").textContent = "The status service itself can't be reached right now."; }
})();
`;
