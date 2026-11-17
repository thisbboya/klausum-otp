/**
 * Self-check (cron every 15 min) and daily summary (cron 08:00 UTC = 08:00 Ghana).
 *
 * Alerts go to Telegram (if TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set) AND email (to ADMIN_EMAIL).
 * Each alert type is sent at most once every 6 hours (remembered in `settings`), and a short
 * "resolved" note follows when it clears.
 *
 * Checks: D1 works · provider API keys still valid · a provider failed 3 times in a row ·
 * any free quota ≥ 80 % · error rate > 5 % in the last hour · sends ≥ 5× normal in the last hour
 * (possible attack) · textbee phone silent > 30 min (only when SMS is configured).
 * "Service completely down" can't be seen from inside — that's the external uptime monitor's job.
 */
import type { Env } from "./index";
import { buildStats, utcDay } from "./stats";
import { sendAhaSend, sendResend } from "./email";
import { recordStatus } from "./status";
import { diagnose } from "./assistant";

export type Alert = { key: string; title: string; detail: string };
const nowS = () => Math.floor(Date.now() / 1000);
const REPEAT_AFTER = 6 * 3600;

async function resendKeyOk(env: Env): Promise<boolean | null> {
  if (!env.RESEND_API_KEY) return null;
  const r = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` }, signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!r) return null; // network blip: don't alert on that alone
  if (r.ok) return true;
  const j = (await r.json().catch(() => ({}))) as { name?: string };
  return j.name === "restricted_api_key"; // a send-only key answers "restricted" = valid
}
async function ahasendKeyOk(env: Env): Promise<boolean | null> {
  if (!env.AHASEND_API_KEY) return null;
  const r = await fetch("https://api.ahasend.com/v2/ping", { headers: { Authorization: `Bearer ${env.AHASEND_API_KEY}` }, signal: AbortSignal.timeout(8000) }).catch(() => null);
  return r ? r.ok : null;
}
async function textbeeSilentMinutes(env: Env): Promise<number | null> {
  if (!env.TEXTBEE_API_KEY || !env.TEXTBEE_DEVICE_ID) return null;
  const r = await fetch(`https://api.textbee.dev/api/v1/gateway/devices/${env.TEXTBEE_DEVICE_ID}`, {
    headers: { "x-api-key": env.TEXTBEE_API_KEY, "User-Agent": "klausum-otp/1.0" }, signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!r?.ok) return null;
  const j = (await r.json().catch(() => ({}))) as { data?: { lastHeartbeat?: string } };
  const t = j.data?.lastHeartbeat ? Date.parse(j.data.lastHeartbeat) : NaN;
  return Number.isFinite(t) ? Math.round((Date.now() - t) / 60000) : null;
}

/** Pure checks over the database (unit-tested). */
export async function findAlerts(env: Env, now = Date.now()): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const t = Math.floor(now / 1000);

  // D1 alive?
  try { await env.DB.prepare("SELECT 1").first(); }
  catch (e) { return [{ key: "d1", title: "Database (D1) is failing", detail: String(e).slice(0, 200) }]; }

  // A provider failed 3 times in a row (real attempts only, not "skipped").
  const { results: recent } = await env.DB.prepare(
    `SELECT provider, status FROM delivery_logs WHERE created_at > ? AND provider IN ('resend','ahasend','textbee')
       AND (error IS NULL OR error NOT LIKE 'skipped%') ORDER BY created_at DESC LIMIT 60`,
  ).bind(t - 86400).all<{ provider: string; status: string }>();
  for (const p of ["resend", "ahasend", "textbee"]) {
    const last3 = recent.filter((r) => r.provider === p).slice(0, 3);
    if (last3.length === 3 && last3.every((r) => r.status === "failed"))
      alerts.push({ key: `streak:${p}`, title: `${p} failed 3 times in a row`, detail: "Codes are falling back to the next provider (if any). Check the control room → Logs for the error." });
  }

  // Quotas ≥ 80 %.
  const s = await buildStats(env.DB, now);
  for (const q of s.quotas)
    if (q.ratio >= 0.8) alerts.push({ key: `quota:${q.provider}`, title: `${q.label} free quota at ${Math.round(q.ratio * 100)} %`, detail: `${q.day ? `${q.usedToday}/${q.day} today, ` : ""}${q.usedMonth}/${q.month} this month.` });

  // Last hour: error rate and spikes.
  const hour = await env.DB.prepare(
    `SELECT COUNT(*) AS sends, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
     FROM otp_requests WHERE created_at > ? AND app_id != 'app_system_admin' AND (provider IS NULL OR provider NOT IN ('test','console'))`,
  ).bind(t - 3600).first<{ sends: number; failed: number | null }>();
  const sends = hour?.sends ?? 0, failed = hour?.failed ?? 0;
  if (sends >= 10 && failed / sends > 0.05)
    alerts.push({ key: "errors", title: `Error rate ${Math.round((failed / sends) * 100)} % in the last hour`, detail: `${failed} of ${sends} codes failed to deliver.` });
  const week = s.days.slice(0, 6).reduce((a, d) => a + d.email + d.sms, 0); // previous 6 days
  const normalPerHour = week / (6 * 24);
  if (sends >= 30 && sends >= 5 * Math.max(normalPerHour, 1))
    alerts.push({ key: "spike", title: `Unusual spike: ${sends} codes in the last hour`, detail: `About ${Math.max(1, Math.round(normalPerHour))}/hour is normal. Possible abuse — check Logs, consider the Blocklist or pausing an app.` });

  // Secrets older than 180 days (one combined reminder).
  const due = s.secrets.filter((x) => x.due);
  if (due.length) alerts.push({ key: "secrets", title: `${due.length} secret(s) due for rotation`, detail: due.map((x) => `${x.name}: ${x.ageDays} days old`).join("\n") + "\nHow: docs/ROTATION.md, then `npm run admin -- secret:rotated <NAME>`." });

  return alerts;
}

// ---- delivery of alerts ----------------------------------------------------
async function telegram(env: Env, text: string) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  return !!r?.ok;
}
async function email(env: Env, subject: string, text: string) {
  if (!env.ADMIN_EMAIL) return false;
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<pre style="font-family:ui-monospace,Menlo,monospace;font-size:14px;white-space:pre-wrap">${esc(text)}</pre>`;
  const mail = { to: env.ADMIN_EMAIL, subject, text, html };
  const r = await sendResend(env, mail).catch(() => ({ ok: false as const }));
  return r.ok || (await sendAhaSend(env, mail).catch(() => ({ ok: false as const }))).ok;
}
export async function notify(env: Env, subject: string, text: string) {
  const [tg, em] = await Promise.all([telegram(env, `${subject}\n\n${text}`), email(env, subject, text)]);
  return { telegram: tg, email: em };
}

// Every 15 minutes: run checks, alert on new problems (once per 6 h each), say when they clear.
export async function selfCheck(env: Env) {
  const alerts = await findAlerts(env);
  const [r, a] = await Promise.all([resendKeyOk(env), ahasendKeyOk(env)]);
  if (r === false) alerts.push({ key: "key:resend", title: "Resend API key is invalid", detail: "Make a new send-only key at resend.com and run: npx wrangler secret put RESEND_API_KEY" });
  if (a === false) alerts.push({ key: "key:ahasend", title: "AhaSend API key is invalid", detail: "Make a new API key in AhaSend and run: npx wrangler secret put AHASEND_API_KEY" });
  const silent = await textbeeSilentMinutes(env);
  if (silent !== null && silent > 30) alerts.push({ key: "textbee:silent", title: `SMS phone silent for ${silent} min`, detail: "Check the textbee phone: charging, Wi-Fi/data, app running. SMS codes fall back to email meanwhile. See docs/SMS-PHONE.md." });

  const t = nowS();
  const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'alert:%'").all<{ key: string; value: string }>();
  const open = new Map(results.map((x) => [x.key.slice(6), Number(x.value)]));
  const writes: D1PreparedStatement[] = [];

  const fresh = alerts.filter((x) => !open.has(x.key) || t - (open.get(x.key) ?? 0) >= REPEAT_AFTER);
  if (fresh.length) {
    const diagnosis = await diagnose(env, fresh.map((x) => x.key)); // null when no Gemini key
    const text = fresh.map((x) => `⚠️ ${x.title}\n${x.detail}`).join("\n\n") + (diagnosis ? `\n\n🤖 Assistant: ${diagnosis}` : "") + "\n\nControl room: https://otp.klausum.study/admin#fixes";
    await notify(env, fresh.length === 1 ? `Klausum OTP: ${fresh[0].title}` : `Klausum OTP: ${fresh.length} problems`, text);
    for (const x of fresh) writes.push(env.DB.prepare("INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").bind(`alert:${x.key}`, String(t), t));
  }
  const now = new Set(alerts.map((x) => x.key));
  const cleared = [...open.keys()].filter((k) => !now.has(k));
  if (cleared.length) {
    await notify(env, "Klausum OTP: resolved", cleared.map((k) => `✅ ${k} is back to normal`).join("\n"));
    for (const k of cleared) writes.push(env.DB.prepare("DELETE FROM settings WHERE key IN (?, ?)").bind(`alert:${k}`, `ai_diagnosis:${k}`));
  }
  if (writes.length) await env.DB.batch(writes);
  await recordStatus(env, alerts.map((x) => x.key)); // public status page + incident history
  return { alerts: alerts.map((x) => x.key), sent: fresh.map((x) => x.key), cleared };
}

/** Cron 08:00 UTC (= 08:00 in Ghana): yesterday in one message. */
export async function dailySummary(env: Env, now = Date.now()) {
  const yesterday = utcDay(now - 86400_000);
  const s = await buildStats(env.DB, now);
  const { results } = await env.DB.prepare("SELECT key, count FROM stats_daily WHERE day=?").bind(yesterday).all<{ key: string; count: number }>();
  const n = (k: string) => results.find((r) => r.key === k)?.count ?? 0;
  const top = await env.DB.prepare(
    `SELECT a.name, COUNT(*) AS n FROM delivery_logs l JOIN apps a ON a.id=l.app_id
     WHERE l.created_at >= ? AND l.created_at < ? AND l.status='sent' GROUP BY a.name ORDER BY n DESC LIMIT 1`,
  ).bind(Date.parse(yesterday + "T00:00:00Z") / 1000, Date.parse(yesterday + "T00:00:00Z") / 1000 + 86400).first<{ name: string; n: number }>();
  const sent = n("send:email") + n("send:sms"), failed = n("failed:email") + n("failed:sms");
  const verified = n("verify:ok"), wrong = n("verify:fail");
  const quota = s.quotas.map((q) => `• ${q.label}: ${q.month - q.usedMonth} of ${q.month} left this month${q.day ? ` (${q.day} per day)` : ""}`).join("\n");
  const text =
    `Yesterday (${yesterday})\n` +
    `• Codes sent: ${sent} (email ${n("send:email")}, SMS ${n("send:sms")})\n` +
    `• Failed: ${failed}${sent ? ` (${Math.round((failed / sent) * 100)} %)` : ""}\n` +
    `• Verified: ${verified}, wrong tries: ${wrong}\n` +
    `• Top app: ${top ? `${top.name} (${top.n})` : "—"}\n\nFree quota:\n${quota}\n\nControl room: https://otp.klausum.study/admin`;
  return notify(env, `Klausum OTP daily: ${sent} codes, ${failed} failed`, text);
}
