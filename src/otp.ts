import { randomIndex, toHex } from "./crypto";

const enc = new TextEncoder();
const dec = new TextDecoder();

export const CODE_LENGTH = 6;
export const MAX_ATTEMPTS = 5;

/** 6-digit code, each digit uniform via rejection sampling (no modulo bias, no Math.random). */
export function generateCode(): string {
  let s = "";
  for (let i = 0; i < CODE_LENGTH; i++) s += String(randomIndex(10));
  return s;
}

// ---- keys (cached per isolate) -------------------------------------------
const hmacKeys = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string) {
  let k = hmacKeys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    hmacKeys.set(secret, k);
  }
  return k;
}

const aesKeys = new Map<string, Promise<CryptoKey>>();
function aesKey(secret: string) {
  let k = aesKeys.get(secret);
  if (!k) {
    k = crypto.subtle
      .importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"])
      .then((base) =>
        crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("klausum-otp/recipient/v1") },
          base,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      );
    aesKeys.set(secret, k);
  }
  return k;
}

export async function hmacHex(secret: string, msg: string): Promise<string> {
  return toHex(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(msg)));
}

/** Pseudonymous recipient id: same person → same hash per app, but not reversible. */
export const recipientHash = (pepper: string, appId: string, recipient: string) =>
  hmacHex(pepper, `rcpt:${appId}:${recipient}`);

/**
 * Code hash. Binds app + recipient + code. We bind the recipient through its HMAC
 * (recipient_hash) so verify can recompute it without decrypting the recipient.
 */
export const codeHash = (pepper: string, appId: string, rcptHash: string, code: string) =>
  hmacHex(pepper, `code:${appId}:${rcptHash}:${code}`);

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function encryptRecipient(pepper: string, recipient: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(pepper), enc.encode(recipient)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64(out);
}

export async function decryptRecipient(pepper: string, blob: string): Promise<string> {
  const raw = unb64(blob);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, await aesKey(pepper), raw.slice(12));
  return dec.decode(pt);
}

// ---- normalisation & masking ----------------------------------------------
const EMAIL_RE = /^[^\s@]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function normaliseEmail(input: string): string | null {
  const e = input.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

/** To E.164. Default country Ghana (+233): 0241234567 → +233241234567. */
export function normalisePhone(input: string, defaultCc = "233"): string | null {
  let p = input.trim().replace(/[\s\-().]/g, "");
  if (p.startsWith("00")) p = "+" + p.slice(2);
  if (!p.startsWith("+")) {
    if (/^0\d{9}$/.test(p)) p = `+${defaultCc}${p.slice(1)}`; // local Ghana format
    else if (p.startsWith(defaultCc) && p.length === defaultCc.length + 9) p = "+" + p;
    else return null;
  }
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}

export function mask(recipient: string): string {
  if (recipient.includes("@")) {
    const [user, domain] = recipient.split("@");
    return `${user[0]}***@${domain}`;
  }
  return recipient.slice(0, 6) + "****" + recipient.slice(-3);
}
