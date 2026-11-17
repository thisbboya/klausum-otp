/**
 * /admin — the control room. Login = email code + authenticator code → HttpOnly session cookie.
 * Everything else talks to /admin/* with that cookie (same origin, CSRF-checked server-side).
 * Styles come from /dashboard.css plus a few extras; the script is /control.js (strict CSP).
 */
export const CONTROL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Klausum OTP · Control room</title>
<link rel="stylesheet" href="/dashboard.css">
<style>
.tabs{display:flex;gap:6px;overflow-x:auto;padding:2px 0 12px;scrollbar-width:none}
.tabs button{width:auto;background:var(--card);color:var(--ink);border:1px solid var(--line);padding:8px 14px;border-radius:99px;white-space:nowrap}
.tabs button[aria-selected=true]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.row>*{flex:1;min-width:140px}
.btns{display:flex;gap:8px;flex-wrap:wrap}.btns button{width:auto;padding:8px 12px;font-size:13px}
button.soft{background:color-mix(in srgb,var(--brand) 12%,transparent);color:var(--brand)}
button.danger{background:color-mix(in srgb,var(--bad) 12%,transparent);color:var(--bad)}
.appcard{border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:12px}
.appcard h3{margin:0 0 4px;font-size:16px}.pill{font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;margin-left:6px}
.pill.on{background:color-mix(in srgb,var(--ok) 15%,transparent);color:var(--ok)}.pill.off{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}
label.f{display:flex;flex-direction:column;font-size:12px;font-weight:600;color:var(--muted);gap:4px}
label.f input,select{margin:0;padding:9px 11px;font-size:14px;border:2px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);font:inherit}
.key{font-family:ui-monospace,monospace;background:var(--bg);border:2px dashed var(--brand);border-radius:10px;padding:12px;word-break:break-all;margin:8px 0}
.toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:10px 16px;border-radius:12px;font-weight:600;z-index:9;max-width:90vw}
.codes{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.toggle{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)}
</style>
</head>
<body>
<header class="top">
  <div class="brand"><span class="dot"></span> Klausum OTP <span class="muted" style="font-weight:600">· control room</span></div>
  <div class="right"><span id="updated" class="muted"></span><button id="logout" class="ghost" hidden>Log out</button></div>
</header>
<main>
  <section id="login" class="card narrow" hidden>
    <h1>Control room</h1>
    <form id="step1">
      <p class="muted">Enter the owner email. We'll send a code there.</p>
      <input id="email" type="email" autocomplete="email" placeholder="you@example.com" required>
      <button type="submit">Email me a code</button>
    </form>
    <form id="step2" hidden>
      <p class="muted">Enter the code from your email <b>and</b> the code from your authenticator app.</p>
      <div class="codes">
        <label class="f">Email code<input id="ecode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="\\d{6}" required></label>
        <label class="f">Authenticator<input id="tcode" inputmode="numeric" autocomplete="off" maxlength="6" pattern="\\d{6}" required></label>
      </div>
      <button type="submit" style="margin-top:12px">Log in</button>
      <button type="button" id="back" class="ghost" style="width:100%">Start again</button>
    </form>
    <p id="login-msg" class="error" role="alert"></p>
  </section>

  <section id="app" hidden>
    <nav class="tabs" role="tablist">
      <button role="tab" data-tab="overview" aria-selected="true">Overview</button>
      <button role="tab" data-tab="apps">Apps &amp; keys</button>
      <button role="tab" data-tab="logs">Logs</button>
      <button role="tab" data-tab="providers">Providers</button>
      <button role="tab" data-tab="blocklist">Blocklist</button>
    </nav>

    <div data-panel="overview">
      <div id="secret-warn"></div>
      <div class="grid kpis" id="kpis"></div>
      <div class="grid two"><div class="card"><h2>Free quota left</h2><div id="quotas"></div></div>
      <div class="card"><h2>Last 7 days</h2><div id="chart" class="chart"></div><div class="legend"><span><i class="sw email"></i>Email</span><span><i class="sw sms"></i>SMS</span></div></div></div>
    </div>

    <div data-panel="apps" hidden>
      <div class="card" style="margin-bottom:14px">
        <h2>New app</h2>
        <form id="newapp" class="row">
          <label class="f">Name (a-z, 0-9, -)<input name="name" required pattern="[a-z0-9][a-z0-9-]{1,39}"></label>
          <label class="f">Shown in emails<input name="display_name" required maxlength="40"></label>
          <label class="f">Key type<select name="mode"><option value="live">Live (sends codes)</option><option value="test">Test (sends nothing)</option></select></label>
          <button type="submit" style="flex:0 0 auto;width:auto">Create</button>
        </form>
        <div id="newkey"></div>
      </div>
      <div class="card"><h2>Apps</h2><div id="apps"></div></div>
    </div>

    <div data-panel="logs" hidden>
      <div class="card">
        <form id="logq" class="row" style="margin-bottom:12px">
          <label class="f">Request id<input name="request_id" placeholder="otp_…"></label>
          <label class="f">App<input name="app" placeholder="klausum-web"></label>
          <label class="f">Channel<select name="channel"><option value="">any</option><option>email</option><option>sms</option></select></label>
          <label class="f">Result<select name="status"><option value="">any</option><option>sent</option><option>failed</option></select></label>
          <label class="f">Provider<select name="provider"><option value="">any</option><option>resend</option><option>ahasend</option><option>textbee</option></select></label>
          <label class="f">Since<input name="from" type="date"></label>
          <button type="submit" style="flex:0 0 auto;width:auto">Search</button>
        </form>
        <table><thead><tr><th>When</th><th>App</th><th>Provider</th><th>Result</th><th class="num">ms</th></tr></thead><tbody id="logs"></tbody></table>
      </div>
    </div>

    <div data-panel="providers" hidden>
      <div class="card narrow" style="margin:0;max-width:560px">
        <h2>Email order</h2>
        <p class="muted small" style="margin:0 0 10px">First one is tried first; the next takes over if it fails or its free quota is used up.</p>
        <div class="row"><label class="f">First<select id="p1"><option>resend</option><option>ahasend</option></select></label><label class="f">Then<select id="p2"><option value="">—</option><option>resend</option><option>ahasend</option></select></label></div>
        <h2 style="margin-top:18px">On / off</h2>
        <div id="ptoggles"></div>
        <button id="psave" style="margin-top:14px">Save</button>
      </div>
    </div>

    <div data-panel="blocklist" hidden>
      <div class="card">
        <form id="blockf" class="row" style="margin-bottom:12px">
          <label class="f">Type<select name="kind"><option value="phone">Phone</option><option value="email">Email</option><option value="domain">Email domain</option><option value="ip">IP address</option></select></label>
          <label class="f">Value<input name="value" required placeholder="0241234567 · bad@x.com · spam.com · 1.2.3.4"></label>
          <label class="f">Note<input name="note" maxlength="200"></label>
          <button type="submit" class="danger" style="flex:0 0 auto;width:auto">Block</button>
        </form>
        <p class="muted small" style="margin:0 0 10px">Phones, emails and IPs are stored as one-way hashes; only a masked form is shown.</p>
        <table><thead><tr><th>Type</th><th>Who</th><th>Note</th><th></th></tr></thead><tbody id="blocks"></tbody></table>
      </div>
    </div>
  </section>
</main>
<script src="/control.js" defer></script>
</body>
</html>`;

export const CONTROL_JS = `
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
  const pct = (x) => x == null ? "–" : Math.round(x * 100) + "%";
  const when = (t) => t ? new Date(t * 1000).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "—";
  const toast = (m) => { const t = document.createElement("div"); t.className = "toast"; t.textContent = m; document.body.append(t); setTimeout(() => t.remove(), 3200); };
  let reqId = null;

  async function api(method, path, body) {
    const r = await fetch(path, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && path.startsWith("/admin")) { show(false); throw new Error("Please log in again."); }
    if (!r.ok) throw new Error(j.error === "rate_limited" ? "Too many tries. Wait a little and try again." : (j.issues || [j.error || "Something went wrong"]).join("; "));
    return j;
  }
  const run = (fn) => (...a) => fn(...a).catch((e) => toast(e.message));

  function show(loggedIn) { $("login").hidden = loggedIn; $("app").hidden = !loggedIn; $("logout").hidden = !loggedIn; }

  // ---- login ----
  $("step1").addEventListener("submit", run(async (e) => {
    e.preventDefault(); $("login-msg").textContent = "";
    const r = await api("POST", "/auth/admin/start", { email: $("email").value });
    reqId = r.request_id; $("step1").hidden = true; $("step2").hidden = false; $("ecode").focus();
  }));
  $("step2").addEventListener("submit", async (e) => {
    e.preventDefault(); $("login-msg").textContent = "";
    try { await api("POST", "/auth/admin/verify", { request_id: reqId, code: $("ecode").value.trim(), totp: $("tcode").value.trim() }); }
    catch (err) { $("login-msg").textContent = err.message === "invalid" ? "One of the codes isn't right. Check both and try again." : err.message; $("tcode").value = ""; return; }
    $("step2").reset(); $("step2").hidden = true; $("step1").hidden = false; boot();
  });
  $("back").addEventListener("click", () => { $("step2").hidden = true; $("step1").hidden = false; $("login-msg").textContent = ""; });
  $("logout").addEventListener("click", run(async () => { await api("POST", "/auth/admin/logout"); show(false); }));

  // ---- tabs ----
  const loaders = { overview: loadOverview, apps: loadApps, logs: () => loadLogs(new FormData($("logq"))), providers: loadProviders, blocklist: loadBlocks };
  document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== b.dataset.tab));
    run(loaders[b.dataset.tab])();
  }));

  // ---- overview ----
  async function loadOverview() {
    const d = await api("GET", "/admin/stats"), T = d.today;
    const due = (d.secrets || []).filter((x) => x.due);
    $("secret-warn").innerHTML = due.length ? '<div class="card" style="margin-bottom:14px;border-color:var(--warn)"><b>🔑 Time to rotate ' + due.length + ' secret(s)</b><p class="muted small" style="margin:6px 0 0">' + due.map((x) => esc(x.name) + " (" + x.ageDays + " days)").join(" · ") + ' — see docs/ROTATION.md, then <code>npm run admin -- secret:rotated NAME</code>.</p></div>' : "";
    const ok = T.email.delivered + T.sms.delivered, bad = T.email.failed + T.sms.failed;
    const k = [["Emails today", T.email.sends, T.email.failed + " failed"], ["SMS today", T.sms.sends, T.sms.failed + " failed"],
      ["Delivery success", ok + bad ? pct(ok / (ok + bad)) : "–", "today"], ["Avg delivery", T.avgDeliveryMs == null ? "–" : T.avgDeliveryMs + " ms", "provider round trip"],
      ["Codes verified", T.verify.ok, T.verify.failed + " wrong tries"], ["This week", d.week.email.sends + d.week.sms.sends, "codes sent"]];
    $("kpis").innerHTML = k.map(([l, v, s]) => '<div class="card kpi"><span class="label">' + l + "</span><b>" + esc(v) + '</b><span class="muted">' + esc(s) + "</span></div>").join("");
    $("quotas").innerHTML = d.quotas.map((q) => { const c = q.ratio >= .9 ? "bad" : q.ratio >= .7 ? "warn" : ""; return '<div class="meter"><div class="row" style="display:flex"><b>' + esc(q.label) + (q.exhaustedToday ? '<span class="tag">used up today</span>' : "") + '</b><span class="muted" style="text-align:right">' + (q.day ? q.usedToday + "/" + q.day + " today · " : "") + q.usedMonth + "/" + q.month + ' month</span></div><div class="bar"><i class="' + c + '" style="width:' + Math.min(100, Math.round(q.ratio * 100)) + '%"></i></div></div>'; }).join("");
    const max = Math.max(1, ...d.days.map((x) => x.email + x.sms));
    $("chart").innerHTML = d.days.map((x) => { const h = Math.round((x.email + x.sms) / max * 120), e = x.email + x.sms ? Math.round(x.email / (x.email + x.sms) * h) : 0; return '<div class="col"><span class="n">' + (x.email + x.sms) + '</span><div class="stack" style="height:' + Math.max(2, h) + 'px"><span class="email" style="height:' + e + 'px"></span><span class="sms" style="height:' + (h - e) + 'px"></span></div><small>' + x.day.slice(5) + "</small></div>"; }).join("");
    $("updated").textContent = "Updated " + new Date().toLocaleTimeString();
  }

  // ---- apps & keys ----
  const showKey = (key, note) => { $("newkey").innerHTML = '<p class="muted small" style="margin-top:12px"><b>' + esc(note) + '</b></p><div class="key">' + esc(key) + "</div>"; $("newkey").scrollIntoView({ behavior: "smooth", block: "center" }); };
  $("newapp").addEventListener("submit", run(async (e) => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
    const r = await api("POST", "/admin/apps", f); e.target.reset();
    showKey(r.api_key, "Key for " + r.name + " — copy it now, it won't be shown again."); loadApps();
  }));
  async function loadApps() {
    const { apps } = await api("GET", "/admin/apps");
    $("apps").innerHTML = apps.map((a) => '<div class="appcard" data-id="' + esc(a.id) + '">' +
      "<h3>" + esc(a.display_name || a.name) + '<span class="pill ' + (a.status === "active" ? "on" : "off") + '">' + esc(a.status) + "</span></h3>" +
      '<p class="muted small" style="margin:0 0 10px">' + esc(a.name) + " · " + a.active_keys + " active key(s) · last used " + when(a.key_last_used_at) + "</p>" +
      '<div class="row" style="margin-bottom:10px">' +
      '<label class="f">Shown in emails<input data-f="display_name" value="' + esc(a.display_name || "") + '"></label>' +
      '<label class="f">Daily cap<input data-f="daily_cap" type="number" min="1" max="10000" value="' + a.daily_cap + '"></label>' +
      '<label class="f">Code lifetime (s)<input data-f="otp_ttl_seconds" type="number" min="60" max="600" value="' + a.otp_ttl_seconds + '"></label>' +
      '<label class="f">Allowed websites (comma)<input data-f="allowed_origins" value="' + esc((a.allowed_origins || []).join(", ")) + '"></label>' +
      '<label class="f">SMS app hash<input data-f="sms_app_hash" maxlength="11" value="' + esc(a.sms_app_hash || "") + '"></label></div>' +
      '<div class="btns"><button class="soft" data-a="save">Save</button><button class="soft" data-a="' + (a.status === "active" ? "pause" : "resume") + '">' + (a.status === "active" ? "Pause" : "Resume") + "</button>" +
      '<button class="soft" data-a="rotate">Rotate key</button><button class="danger" data-a="revoke">Revoke keys</button><button class="danger" data-a="delete">Delete app</button></div></div>').join("") || '<p class="muted">No apps yet.</p>';
  }
  $("apps").addEventListener("click", run(async (e) => {
    const b = e.target.closest("button[data-a]"); if (!b) return;
    const card = b.closest(".appcard"), id = card.dataset.id, a = b.dataset.a;
    if (a === "save") {
      const v = (f) => card.querySelector('[data-f="' + f + '"]').value.trim();
      await api("PATCH", "/admin/apps/" + id, { display_name: v("display_name"), daily_cap: Number(v("daily_cap")), otp_ttl_seconds: Number(v("otp_ttl_seconds")),
        allowed_origins: v("allowed_origins") ? v("allowed_origins").split(",").map((s) => s.trim()).filter(Boolean) : [], sms_app_hash: v("sms_app_hash") || null });
      toast("Saved");
    } else if (a === "pause" || a === "resume") {
      await api("PATCH", "/admin/apps/" + id, { status: a === "pause" ? "paused" : "active" }); toast(a === "pause" ? "Paused (within 10 s everywhere)" : "Resumed");
    } else if (a === "rotate") {
      if (!confirm("Make a new key? The old one keeps working for 24 hours, then stops.")) return;
      const r = await api("POST", "/admin/apps/" + id + "/keys/rotate", {}); showKey(r.api_key, "New key — copy it now. Old keys stop in 24 h.");
    } else if (a === "revoke") {
      if (!confirm("Stop ALL keys of this app now? The app breaks until it gets a new key.")) return;
      const r = await api("POST", "/admin/apps/" + id + "/keys/revoke", {}); toast("Revoked " + r.revoked + " key(s)");
    } else if (a === "delete") {
      const name = prompt("This deletes the app, its keys and its users' authenticators. Type the app id to confirm:\\n" + id);
      if (name !== id) return;
      await api("DELETE", "/admin/apps/" + id + "?confirm=" + encodeURIComponent(id)); toast("Deleted");
    }
    loadApps();
  }));

  // ---- logs ----
  async function loadLogs(fd) {
    const q = new URLSearchParams(); for (const [k, v] of fd) if (v) q.set(k, k === "from" ? String(Math.floor(new Date(v).getTime() / 1000)) : v);
    const { logs } = await api("GET", "/admin/logs?" + q);
    $("logs").innerHTML = logs.map((l) => "<tr><td>" + when(l.created_at) + '<span class="err">' + esc(l.request_id) + "</span></td><td>" + esc(l.app ?? "?") + '<span class="err">' + esc(l.channel ?? "") + "</span></td><td>" + esc(l.provider) + '</td><td><span class="' + (l.status === "sent" ? "ok" : "fail") + '">' + esc(l.status) + "</span>" + (l.error ? '<span class="err">' + esc(l.error) + "</span>" : "") + '</td><td class="num">' + (l.latency_ms ?? "") + "</td></tr>").join("") || '<tr><td colspan="5" class="muted">Nothing found.</td></tr>';
  }
  $("logq").addEventListener("submit", run(async (e) => { e.preventDefault(); await loadLogs(new FormData(e.target)); }));

  // ---- providers ----
  let prov = null;
  async function loadProviders() {
    prov = await api("GET", "/admin/providers");
    $("p1").value = prov.email_order[0]; $("p2").value = prov.email_order[1] || "";
    $("ptoggles").innerHTML = ["resend", "ahasend", "textbee"].map((p) => '<label class="toggle"><span><b>' + p + "</b></span><input type=\\"checkbox\\" data-p=\\"" + p + '" ' + (prov.disabled.includes(p) ? "" : "checked") + "></label>").join("");
  }
  $("psave").addEventListener("click", run(async () => {
    const order = [$("p1").value, $("p2").value].filter((v, i, a) => v && a.indexOf(v) === i);
    const disabled = [...document.querySelectorAll("[data-p]")].filter((x) => !x.checked).map((x) => x.dataset.p);
    await api("PUT", "/admin/providers", { email_order: order, disabled }); toast("Saved — applies to the next send");
  }));

  // ---- blocklist ----
  async function loadBlocks() {
    const { entries } = await api("GET", "/admin/blocklist");
    $("blocks").innerHTML = entries.map((b) => "<tr><td>" + esc(b.kind) + "</td><td><b>" + esc(b.label) + '</b><span class="err">' + when(b.created_at) + "</span></td><td>" + esc(b.note ?? "") + '</td><td class="num"><button class="ghost" data-k="' + esc(b.kind) + '" data-v="' + esc(b.value) + '">Remove</button></td></tr>').join("") || '<tr><td colspan="4" class="muted">Nobody is blocked.</td></tr>';
  }
  $("blockf").addEventListener("submit", run(async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); if (!f.note) delete f.note; const r = await api("POST", "/admin/blocklist", f); e.target.reset(); toast("Blocked " + r.label); loadBlocks(); }));
  $("blocks").addEventListener("click", run(async (e) => { const b = e.target.closest("button[data-k]"); if (!b) return; await api("DELETE", "/admin/blocklist/" + encodeURIComponent(b.dataset.k) + "/" + encodeURIComponent(b.dataset.v)); loadBlocks(); }));

  async function boot() {
    try { await loadOverview(); show(true); } catch { show(false); }
  }
  setInterval(() => { if (!$("app").hidden && !document.hidden && !document.querySelector('[data-panel="overview"]').hidden) loadOverview().catch(() => {}); }, 60000);
  boot();
})();
`;
