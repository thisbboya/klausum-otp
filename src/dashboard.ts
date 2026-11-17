/**
 * /dashboard — a small, phone-friendly page served by the Worker itself (no separate
 * Pages project needed). The page holds no data: it asks for the ADMIN_TOKEN, keeps it
 * in sessionStorage (this tab only), and calls GET /admin/stats with it.
 * Script and styles are separate same-origin files so the CSP can stay strict.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Klausum OTP · Dashboard</title>
<link rel="stylesheet" href="/dashboard.css">
</head>
<body>
<header class="top">
  <div class="brand"><span class="dot"></span> Klausum OTP</div>
  <div class="right"><span id="updated" class="muted"></span><button id="refresh" class="ghost" hidden>Refresh</button><button id="logout" class="ghost" hidden>Lock</button></div>
</header>

<main>
  <section id="login" class="card narrow" hidden>
    <h1>Dashboard</h1>
    <p class="muted">Paste your admin token. It stays in this tab only and is forgotten when you close it.</p>
    <form id="login-form">
      <input id="token" type="password" autocomplete="off" placeholder="Admin token" required>
      <button type="submit">Open dashboard</button>
      <p id="login-error" class="error" role="alert"></p>
    </form>
  </section>

  <section id="app" hidden>
    <div class="grid kpis">
      <div class="card kpi"><span class="label">Emails sent today</span><b id="k-email">–</b><span id="k-email-sub" class="muted"></span></div>
      <div class="card kpi"><span class="label">SMS sent today</span><b id="k-sms">–</b><span id="k-sms-sub" class="muted"></span></div>
      <div class="card kpi"><span class="label">Delivery success</span><b id="k-success">–</b><span class="muted">today, all channels</span></div>
      <div class="card kpi"><span class="label">Avg delivery time</span><b id="k-latency">–</b><span class="muted">provider round trip, today</span></div>
      <div class="card kpi"><span class="label">Codes verified</span><b id="k-verify">–</b><span id="k-verify-sub" class="muted"></span></div>
      <div class="card kpi"><span class="label">This week</span><b id="k-week">–</b><span id="k-week-sub" class="muted"></span></div>
    </div>

    <div class="grid two">
      <div class="card">
        <h2>Free quota left</h2>
        <div id="quotas"></div>
        <p class="muted small">Yellow at 70 %, red at 90 %. Workers requests and D1 writes: see the Cloudflare dashboard.</p>
      </div>
      <div class="card">
        <h2>Last 7 days</h2>
        <div id="chart" class="chart" role="img" aria-label="Codes sent per day"></div>
        <div class="legend"><span><i class="sw email"></i>Email</span><span><i class="sw sms"></i>SMS</span></div>
      </div>
    </div>

    <div class="grid two">
      <div class="card">
        <h2>Apps</h2>
        <table><thead><tr><th>App</th><th>Status</th><th class="num">Daily cap</th></tr></thead><tbody id="apps"></tbody></table>
      </div>
      <div class="card">
        <h2>Recent deliveries</h2>
        <table><thead><tr><th>When</th><th>Provider</th><th>Result</th><th class="num">ms</th></tr></thead><tbody id="recent"></tbody></table>
      </div>
    </div>
  </section>
</main>
<script src="/dashboard.js" defer></script>
</body>
</html>`;

export const DASHBOARD_CSS = `
:root{--bg:#f6f7fb;--card:#fff;--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--brand:#2563eb;--ok:#16a34a;--warn:#d97706;--bad:#dc2626;--sms:#f5b70a;--radius:16px;
 color-scheme:light;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#0b1020;--card:#121a2e;--ink:#e2e8f0;--muted:#94a3b8;--line:#1f2a44;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased}
.top{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid var(--line);background:var(--card);position:sticky;top:0;z-index:2}
.brand{font-weight:700;display:flex;gap:8px;align-items:center}.dot{width:10px;height:10px;border-radius:50%;background:var(--brand);box-shadow:0 0 0 4px color-mix(in srgb,var(--brand) 20%,transparent)}
.right{display:flex;gap:8px;align-items:center}
main{max-width:1200px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:18px}
.narrow{max-width:420px;margin:12vh auto}
h1{margin:0 0 6px;font-size:24px}h2{margin:0 0 14px;font-size:15px}
.muted{color:var(--muted)}.small{font-size:12px;margin:12px 0 0}
.grid{display:grid;gap:14px;margin-bottom:14px}.kpis{grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}.two{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.kpi{display:flex;flex-direction:column;gap:4px}.kpi .label{font-size:13px;color:var(--muted);font-weight:600}.kpi b{font-size:28px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}.kpi .muted{font-size:12px}
input{width:100%;padding:12px 14px;border:2px solid var(--line);border-radius:12px;font:inherit;background:var(--bg);color:var(--ink);margin:12px 0}
input:focus{outline:none;border-color:var(--brand)}
button{font:inherit;font-weight:600;border:0;border-radius:12px;padding:12px 16px;background:var(--brand);color:#fff;cursor:pointer;width:100%}
button.ghost{width:auto;background:transparent;color:var(--brand);padding:6px 10px}
.error{color:var(--bad);font-weight:600;min-height:1em}
.meter{margin-bottom:14px}.meter .row{display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px}
.bar{height:10px;border-radius:99px;background:var(--line);overflow:hidden}.bar i{display:block;height:100%;border-radius:99px;background:var(--ok);transition:width .4s}
.bar i.warn{background:var(--warn)}.bar i.bad{background:var(--bad)}
.tag{font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;background:color-mix(in srgb,var(--bad) 15%,transparent);color:var(--bad);margin-left:6px}
.chart{display:flex;align-items:flex-end;gap:10px;height:160px;padding-top:8px}
.col{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;height:100%;justify-content:flex-end}
.stack{width:100%;max-width:34px;display:flex;flex-direction:column-reverse;border-radius:8px 8px 4px 4px;overflow:hidden;min-height:2px;background:var(--line)}
.stack .email{background:var(--brand)}.stack .sms{background:var(--sms)}
.col small{font-size:11px;color:var(--muted)}.col .n{font-size:11px;font-weight:700}
.legend{display:flex;gap:14px;font-size:12px;color:var(--muted);margin-top:10px}.sw{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}.sw.email{background:var(--brand)}.sw.sms{background:var(--sms)}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:var(--muted);font-weight:600;padding:6px 4px;border-bottom:1px solid var(--line)}
td{padding:8px 4px;border-bottom:1px solid var(--line);vertical-align:top}.num{text-align:right;font-variant-numeric:tabular-nums}
.ok{color:var(--ok);font-weight:700}.fail{color:var(--bad);font-weight:700}.err{display:block;color:var(--muted);font-size:11px;word-break:break-word}
@media (max-width:520px){.kpi b{font-size:24px}main{padding:12px}}
`;

export const DASHBOARD_JS = `
(() => {
  const $ = (id) => document.getElementById(id);
  const KEY = "kotp-admin";
  const pct = (x) => x == null ? "–" : Math.round(x * 100) + "%";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
  const ago = (t) => { const s = Math.round(Date.now() / 1000 - t); return s < 60 ? s + "s ago" : s < 3600 ? Math.round(s / 60) + "m ago" : s < 86400 ? Math.round(s / 3600) + "h ago" : Math.round(s / 86400) + "d ago"; };
  const token = () => { try { return sessionStorage.getItem(KEY); } catch { return null; } };
  const show = (loggedIn) => { $("login").hidden = loggedIn; $("app").hidden = !loggedIn; $("refresh").hidden = $("logout").hidden = !loggedIn; };

  async function load() {
    const t = token();
    if (!t) return show(false);
    const r = await fetch("/admin/stats", { headers: { Authorization: "Bearer " + t } }).catch(() => null);
    if (!r || r.status === 401 || r.status === 429) {
      try { sessionStorage.removeItem(KEY); } catch {}
      show(false);
      $("login-error").textContent = !r ? "Can't reach the service." : r.status === 429 ? "Too many wrong tokens from here. Try again in an hour." : "That token didn't work.";
      return;
    }
    render(await r.json());
    show(true);
  }

  function render(d) {
    const T = d.today, W = d.week;
    $("k-email").textContent = T.email.sends;
    $("k-email-sub").textContent = T.email.failed ? T.email.failed + " failed" : "none failed";
    $("k-sms").textContent = T.sms.sends;
    $("k-sms-sub").textContent = T.sms.failed ? T.sms.failed + " failed" : "none failed";
    const ok = T.email.delivered + T.sms.delivered, bad = T.email.failed + T.sms.failed;
    $("k-success").textContent = ok + bad ? pct(ok / (ok + bad)) : "–";
    $("k-latency").textContent = T.avgDeliveryMs == null ? "–" : T.avgDeliveryMs + " ms";
    $("k-verify").textContent = T.verify.ok;
    $("k-verify-sub").textContent = T.verify.failed ? T.verify.failed + " wrong tries (" + pct(T.verify.successRate) + " right)" : "no wrong tries";
    $("k-week").textContent = W.email.sends + W.sms.sends;
    $("k-week-sub").textContent = "codes sent · " + (W.verify.successRate == null ? "none verified yet" : pct(W.verify.successRate) + " of tries correct");

    $("quotas").innerHTML = d.quotas.map((q) => {
      const cls = q.ratio >= 0.9 ? "bad" : q.ratio >= 0.7 ? "warn" : "";
      const dayTxt = q.day ? q.usedToday + "/" + q.day + " today · " : "";
      return '<div class="meter"><div class="row"><b>' + esc(q.label) + (q.exhaustedToday ? '<span class="tag">used up today</span>' : "") +
        '</b><span class="muted">' + dayTxt + q.usedMonth + "/" + q.month + " this month</span></div>" +
        '<div class="bar"><i class="' + cls + '" style="width:' + Math.min(100, Math.round(q.ratio * 100)) + '%"></i></div></div>';
    }).join("");

    const max = Math.max(1, ...d.days.map((x) => x.email + x.sms));
    $("chart").innerHTML = d.days.map((x) => {
      const h = Math.round(((x.email + x.sms) / max) * 120);
      const e = x.email + x.sms ? Math.round((x.email / (x.email + x.sms)) * h) : 0;
      return '<div class="col"><span class="n">' + (x.email + x.sms) + '</span><div class="stack" style="height:' + Math.max(2, h) + 'px"><span class="email" style="height:' + e + 'px"></span><span class="sms" style="height:' + (h - e) + 'px"></span></div><small>' + x.day.slice(5) + "</small></div>";
    }).join("");

    $("apps").innerHTML = d.apps.map((a) => "<tr><td><b>" + esc(a.display_name || a.name) + '</b><span class="err">' + esc(a.name) + "</span></td><td>" + esc(a.status) + '</td><td class="num">' + a.daily_cap + "</td></tr>").join("");
    $("recent").innerHTML = d.recent.length ? d.recent.map((l) => "<tr><td>" + ago(l.created_at) + "<span class=\\"err\\">" + esc(l.channel || "") + "</span></td><td>" + esc(l.provider) + "</td><td><span class=\\"" + (l.status === "sent" ? "ok" : "fail") + "\\">" + esc(l.status) + "</span>" + (l.error ? '<span class="err">' + esc(l.error).slice(0, 140) + "</span>" : "") + '</td><td class="num">' + (l.latency_ms ?? "") + "</td></tr>").join("") : '<tr><td colspan="4" class="muted">Nothing yet.</td></tr>';
    $("updated").textContent = "Updated " + new Date(d.generatedAt).toLocaleTimeString();
  }

  $("login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    try { sessionStorage.setItem(KEY, $("token").value.trim()); } catch {}
    $("token").value = "";
    load();
  });
  $("refresh").addEventListener("click", load);
  $("logout").addEventListener("click", () => { try { sessionStorage.removeItem(KEY); } catch {} show(false); });
  setInterval(() => { if (token() && !document.hidden) load(); }, 60000);
  load();
})();
`;
