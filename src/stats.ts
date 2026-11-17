/** Per-day counters (stats_daily). Callers add these statements to batches they already run. */
export const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export const statStmt = (db: D1Database, key: string, ms = 0, day = utcDay()) =>
  db.prepare(
    `INSERT INTO stats_daily (day, key, count, sum_ms) VALUES (?, ?, 1, ?)
     ON CONFLICT(day, key) DO UPDATE SET count = count + 1, sum_ms = sum_ms + excluded.sum_ms`,
  ).bind(day, key, Math.max(0, Math.round(ms)));

/** Rotate secrets at least this often (docs/ROTATION.md). */
export const SECRET_MAX_AGE_DAYS = 180;

/** Free-tier limits we track (checked 2026-11-17, see docs/RESEARCH.md). */
export const QUOTAS = [
  { provider: "resend", label: "Resend", day: 100, month: 3000 },
  { provider: "ahasend", label: "AhaSend", day: null, month: 1000 },
  { provider: "textbee", label: "textbee SMS", day: 50, month: 300 },
] as const;

type Row = { day: string; key: string; count: number; sum_ms: number };

export async function buildStats(db: D1Database, now = Date.now()) {
  const today = utcDay(now);
  const weekAgo = utcDay(now - 6 * 86400_000);
  const monthStart = today.slice(0, 8) + "01";
  const from = weekAgo < monthStart ? weekAgo : monthStart;

  const [rowsRes, appsRes, settingsRes, logsRes, secretsRes] = await db.batch([
    db.prepare("SELECT day, key, count, sum_ms FROM stats_daily WHERE day >= ? ORDER BY day").bind(from),
    db.prepare("SELECT id, name, display_name, status, daily_cap FROM apps WHERE id != 'app_system_admin' ORDER BY created_at"),
    db.prepare("SELECT key, value FROM settings WHERE key LIKE 'exhausted:%'"),
    db.prepare(
      `SELECT l.created_at, l.provider, l.status, l.error, l.latency_ms, r.channel
       FROM delivery_logs l LEFT JOIN otp_requests r ON r.id = l.otp_request_id
       ORDER BY l.created_at DESC LIMIT 25`,
    ),
    db.prepare("SELECT key, value FROM settings WHERE key LIKE 'secret:%' ORDER BY key"),
  ]);
  const rows = rowsRes.results as Row[];
  const sum = (pred: (r: Row) => boolean) => rows.filter(pred).reduce((a, r) => ({ n: a.n + r.count, ms: a.ms + r.sum_ms }), { n: 0, ms: 0 });
  const on = (d: string) => (r: Row) => r.day === d;
  const since = (d: string) => (r: Row) => r.day >= d;

  const channel = (c: "email" | "sms", when: (r: Row) => boolean) => {
    const sends = sum((r) => when(r) && r.key === `send:${c}`).n;
    const ok = sum((r) => when(r) && r.key === `sent:${c}`).n;
    const failed = sum((r) => when(r) && r.key === `failed:${c}`).n;
    return { sends, delivered: ok, failed, successRate: ok + failed ? ok / (ok + failed) : null };
  };
  const latency = (when: (r: Row) => boolean) => {
    const s = sum((r) => when(r) && /^provider:[^:]+:sent$/.test(r.key));
    return s.n ? Math.round(s.ms / s.n) : null;
  };
  const verify = (when: (r: Row) => boolean) => {
    const ok = sum((r) => when(r) && r.key === "verify:ok").n;
    const bad = sum((r) => when(r) && r.key === "verify:fail").n;
    return { ok, failed: bad, successRate: ok + bad ? ok / (ok + bad) : null };
  };

  const exhausted = new Map((settingsRes.results as { key: string; value: string }[]).map((s) => [s.key.slice(10), s.value]));
  const quotas = QUOTAS.map((q) => {
    const usedToday = sum((r) => r.day === today && r.key === `provider:${q.provider}:sent`).n;
    const usedMonth = sum((r) => r.day >= monthStart && r.key === `provider:${q.provider}:sent`).n;
    return {
      ...q, usedToday, usedMonth,
      exhaustedToday: exhausted.get(q.provider) === today,
      // 70 % = warn, 90 % = danger (the bigger of the day/month ratios)
      ratio: Math.max(q.day ? usedToday / q.day : 0, usedMonth / q.month),
    };
  });

  const days = Array.from({ length: 7 }, (_, i) => utcDay(now - (6 - i) * 86400_000)).map((d) => ({
    day: d,
    email: sum((r) => r.day === d && r.key === "send:email").n,
    sms: sum((r) => r.day === d && r.key === "send:sms").n,
  }));

  const nowS = Math.floor(now / 1000);
  const secrets = (secretsRes.results as { key: string; value: string }[]).map((r) => {
    const ageDays = Math.floor((nowS - Number(r.value)) / 86400);
    return { name: r.key.slice(7), setAt: Number(r.value), ageDays, due: ageDays >= SECRET_MAX_AGE_DAYS };
  });

  return {
    secrets,
    generatedAt: new Date(now).toISOString(),
    today: { email: channel("email", on(today)), sms: channel("sms", on(today)), verify: verify(on(today)), avgDeliveryMs: latency(on(today)) },
    week: { email: channel("email", since(weekAgo)), sms: channel("sms", since(weekAgo)), verify: verify(since(weekAgo)), avgDeliveryMs: latency(since(weekAgo)) },
    days,
    quotas,
    apps: appsRes.results,
    recent: logsRes.results,
  };
}
