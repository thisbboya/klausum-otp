/**
 * TOTP (RFC 6238) on top of HOTP (RFC 4226): HMAC-SHA1, 6 digits, 30 s step.
 * Web Crypto only — no npm crypto libraries.
 */
const enc = new TextEncoder();
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const STEP = 30;
export const DIGITS = 6;
export const WINDOW = 1; // RFC 6238 §5.2: allow at most one step of clock drift

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

/** HOTP (RFC 4226 §5.3) with dynamic truncation. */
export async function hotp(key: Uint8Array, counter: number, digits = DIGITS): Promise<string> {
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 0xff; c = Math.floor(c / 256); }
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", k, msg));
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const stepAt = (unixSeconds: number) => Math.floor(unixSeconds / STEP);

/**
 * Check a code against steps [now-WINDOW, now+WINDOW]. Returns the matching step,
 * or null. Every candidate is computed and compared (no early exit on a match).
 */
export async function matchStep(key: Uint8Array, code: string, now: number): Promise<number | null> {
  const s0 = stepAt(now);
  let found: number | null = null;
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const cand = await hotp(key, s0 + d);
    let diff = 0;
    for (let i = 0; i < DIGITS; i++) diff |= cand.charCodeAt(i) ^ code.charCodeAt(i);
    if (diff === 0 && found === null) found = s0 + d;
  }
  return found;
}

export function otpauthUrl(issuer: string, account: string, secretB32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret: secretB32, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP) });
  return `otpauth://totp/${label}?${q}`;
}

// ---- secret encryption at rest (AES-GCM, key derived from TOTP_KEY) --------
const keys = new Map<string, Promise<CryptoKey>>();
function aes(secret: string) {
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]).then((base) =>
      crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("klausum-otp/totp/v1") },
        base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
    keys.set(secret, k);
  }
  return k;
}
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** AAD binds the ciphertext to its row, so a secret can't be swapped onto another user. */
export async function sealSecret(totpKey: string, raw: Uint8Array, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, await aes(totpKey), raw));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return b64(out);
}

export async function openSecret(totpKey: string, blob: string, aad: string): Promise<Uint8Array> {
  const raw = unb64(blob);
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: raw.slice(0, 12), additionalData: enc.encode(aad) }, await aes(totpKey), raw.slice(12)));
}
