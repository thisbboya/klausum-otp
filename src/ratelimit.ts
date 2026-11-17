/**
 * Window counters in D1. One UPSERT per rule; callers put them in a db.batch together
 * with their own statements so a whole request costs ONE round trip.
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

/** Prepared upserts, one per rule (key may also be a SQL expression via keySql). */
export const counterStatements = (db: D1Database, rules: Rule[], now: number) =>
  rules.map((r) => db.prepare(SQL).bind(r.key, now, r.window));

/**
 * SQL that is true only if every rule is still within its limit — evaluated inside the
 * same batch, after the upserts, so later statements can be made conditional on it.
 */
export function withinLimitsSql(rules: Rule[]): { sql: string; binds: (string | number)[] } {
  return {
    sql: rules.map(() => "(SELECT count FROM rate_counters WHERE key = ?) <= ?").join(" AND "),
    binds: rules.flatMap((r) => [r.key, r.limit]),
  };
}

/** Read the RETURNING rows of the upserts and compute Retry-After. */
export function evaluate(rules: Rule[], results: D1Result[], now: number) {
  let retryAfter = 0;
  rules.forEach((r, i) => {
    const row = results[i].results[0] as { count: number; window_start: number };
    if (row.count > r.limit) retryAfter = Math.max(retryAfter, row.window_start + r.window - now, 1);
  });
  return { ok: retryAfter === 0, retryAfter };
}

/** Stand-alone check (one round trip). */
export async function hit(db: D1Database, rules: Rule[], now = Math.floor(Date.now() / 1000)) {
  return evaluate(rules, await db.batch(counterStatements(db, rules, now)), now);
}
