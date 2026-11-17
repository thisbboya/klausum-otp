/**
 * The verify / enrol logic, independent of HTTP, so the public API and the admin
 * control-room login share exactly the same tested code paths.
 */
import { renderSVG } from "uqr";
import type { Env } from "./index";
import { MAX_ATTEMPTS, codeHash, hmacHex } from "./otp";
import { counterStatements, evaluate } from "./ratelimit";
import { base32Encode, matchStep, openSecret, otpauthUrl, sealSecret } from "./totp";

const nowS = () => Math.floor(Date.now() / 1000);

export type OtpVerdict =
  | { valid: true }
  | { valid: false; reason: "invalid_code" | "expired" | "too_many_attempts"; attemptsLeft?: number }
  | { rateLimited: true; retryAfter: number };

/**
 * ONE D1 round trip. The code hash binds app + request + code, so the expected hash is known
 * before reading anything:
 *   1. bump the per-recipient verify counter
 *   2. if code matches (and live, unused, within limits) → mark used          (single use)
 *   3. if code doesn't match (and live, within limits)  → attempts + 1        (attempt limit)
 *   4. read the row's final state to pick the answer
 * Statements run in order inside one transaction, so two concurrent verifies of the same code
 * can't both succeed. The comparison happens in SQL; both sides are HMACs the caller can't steer
 * byte-by-byte, so equality timing reveals nothing useful.
 */
export async function verifyOtpCore(env: Env, appId: string, requestId: string, code: string): Promise<OtpVerdict> {
  const now = nowS();
  const expected = await codeHash(env.OTP_PEPPER, appId, requestId, code);
  const live = `id=?1 AND app_id=?2 AND used_at IS NULL AND status!='invalidated' AND attempts < ${MAX_ATTEMPTS} AND expires_at > ?3
    AND (SELECT count FROM rate_counters WHERE key = 'v600:' || otp_requests.recipient_hash) <= 10`;
  const [counter, ok, bump, state] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO rate_counters (key, count, window_start)
         VALUES ('v600:' || COALESCE((SELECT recipient_hash FROM otp_requests WHERE id=?1 AND app_id=?2), 'unknown'), 1, ?3)
       ON CONFLICT(key) DO UPDATE SET
         count        = CASE WHEN ?3 < rate_counters.window_start + 600 THEN rate_counters.count + 1 ELSE 1 END,
         window_start = CASE WHEN ?3 < rate_counters.window_start + 600 THEN rate_counters.window_start ELSE ?3 END
       RETURNING count, window_start`,
    ).bind(requestId, appId, now),
    env.DB.prepare(`UPDATE otp_requests SET used_at=?3, recipient_enc=NULL WHERE ${live} AND code_hash=?4 RETURNING 1 AS ok`)
      .bind(requestId, appId, now, expected),
    env.DB.prepare(`UPDATE otp_requests SET attempts=attempts+1 WHERE ${live} AND code_hash!=?4 RETURNING attempts`)
      .bind(requestId, appId, now, expected),
    env.DB.prepare("SELECT used_at, status, attempts, expires_at FROM otp_requests WHERE id=? AND app_id=?").bind(requestId, appId),
  ]);
  if (ok.results.length === 1) return { valid: true };
  const row = state.results[0] as { used_at: number | null; status: string; attempts: number; expires_at: number } | undefined;
  // Unknown / other app's / used / replaced → same answer, reveals nothing.
  if (!row || row.used_at !== null || row.status === "invalidated") return { valid: false, reason: "invalid_code" };
  const rl = evaluate([{ key: "", limit: 10, window: 600 }], [counter], now);
  if (!rl.ok) return { rateLimited: true, retryAfter: rl.retryAfter };
  const bumped = bump.results[0] as { attempts: number } | undefined;
  if (bumped) {
    const left = Math.max(0, MAX_ATTEMPTS - bumped.attempts);
    return left === 0 ? { valid: false, reason: "too_many_attempts", attemptsLeft: 0 } : { valid: false, reason: "invalid_code", attemptsLeft: left };
  }
  if (row.attempts >= MAX_ATTEMPTS) return { valid: false, reason: "too_many_attempts", attemptsLeft: 0 };
  if (row.expires_at <= now) return { valid: false, reason: "expired" };
  return { valid: false, reason: "invalid_code" };
}

export const totpAad = (appId: string, ref: string) => `${appId}:${ref}`;

export async function enrollTotpCore(env: Env, appId: string, userRef: string, issuer: string) {
  // A confirmed enrolment can't be silently replaced (that would let anyone holding the
  // app key take over a user's 2FA).
  const existing = await env.DB.prepare("SELECT confirmed_at FROM totp_secrets WHERE app_id=? AND user_ref=?")
    .bind(appId, userRef).first<{ confirmed_at: number | null }>();
  if (existing?.confirmed_at) return { alreadyEnrolled: true as const };
  const raw = crypto.getRandomValues(new Uint8Array(20)); // 160-bit secret (RFC 4226 §4 recommends ≥128)
  const secret = base32Encode(raw);
  await env.DB.prepare(
    `INSERT INTO totp_secrets (app_id,user_ref,secret_encrypted,last_used_step,created_at,confirmed_at) VALUES (?,?,?,NULL,?,NULL)
     ON CONFLICT(app_id,user_ref) DO UPDATE SET secret_encrypted=excluded.secret_encrypted, last_used_step=NULL, created_at=excluded.created_at`,
  ).bind(appId, userRef, await sealSecret(env.TOTP_KEY, raw, totpAad(appId, userRef)), nowS()).run();
  const url = otpauthUrl(issuer, userRef, secret);
  return { secret, otpauthUrl: url, qrSvg: renderSVG(url, { ecc: "M", border: 2 }) };
}

export type TotpVerdict = { valid: boolean } | { rateLimited: true; retryAfter: number };

/** Round trip 1: rate counter + encrypted secret. Round trip 2: atomic replay-protection update. */
export async function verifyTotpCore(env: Env, appId: string, userRef: string, code: string): Promise<TotpVerdict> {
  const refHash = (await hmacHex(env.OTP_PEPPER, `totp:${appId}:${userRef}`)).slice(0, 32);
  const rules = [{ key: `t600:${refHash}`, limit: 10, window: 600 }];
  const now = nowS();
  const [counter, sel] = await env.DB.batch([
    ...counterStatements(env.DB, rules, now),
    env.DB.prepare("SELECT secret_encrypted,last_used_step FROM totp_secrets WHERE app_id=? AND user_ref=?").bind(appId, userRef),
  ]);
  const rl = evaluate(rules, [counter], now);
  if (!rl.ok) return { rateLimited: true, retryAfter: rl.retryAfter };
  const row = sel.results[0] as { secret_encrypted: string } | undefined;
  if (!row) return { valid: false };
  const key = await openSecret(env.TOTP_KEY, row.secret_encrypted, totpAad(appId, userRef));
  const step = await matchStep(key, code, now);
  if (step === null) return { valid: false };
  // Replay protection: the step must be newer than the last accepted one. Atomic, so two
  // simultaneous requests with the same code can't both pass.
  const r = await env.DB.prepare(
    `UPDATE totp_secrets SET last_used_step=?, confirmed_at=COALESCE(confirmed_at, ?)
     WHERE app_id=? AND user_ref=? AND (last_used_step IS NULL OR last_used_step < ?)`,
  ).bind(step, now, appId, userRef, step).run();
  return { valid: r.meta.changes === 1 };
}
