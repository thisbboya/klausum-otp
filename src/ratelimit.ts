/**
 * Window counters in D1. One UPSERT per rule, all rules in ONE db.batch round trip.
 *
 * Each window starts at the FIRST hit and lasts `window` seconds. (Clock-aligned
 * fixed windows let 2 sends through when they straddle a boundary — e.g. at :29 and
 * :31 — which broke "1 send per 30 s".)
 */
export type Rule = { key: string; limit: number; window: number };

const SQL = `INSERT INTO rate_counters (key, count, window_start) VALUES (?1, 1, ?2)
  ON CONFLICT(key) DO UPDATE SET
    count        = CASE WHEN ?2 < rate_counters.window_start + ?3 THEN rate_counters.count + 1 ELSE 1 END,
    window_start = CASE WHEN ?2 < rate_counters.window_start + ?3 THEN rate_counters.window_start ELSE ?2 END
  RETURNING count, window_start`;

export async function hit(db: D1Database, rules: Rule[], now = Math.floor(Date.now() / 1000)) {
  const res = await db.batch(rules.map((r) => db.prepare(SQL).bind(r.key, now, r.window)));
  let retryAfter = 0;
  rules.forEach((r, i) => {
    const { count, window_start } = res[i].results[0] as { count: number; window_start: number };
    if (count > r.limit) retryAfter = Math.max(retryAfter, window_start + r.window - now);
  });
  return { ok: retryAfter === 0, retryAfter: Math.max(retryAfter, retryAfter ? 1 : 0) };
}
