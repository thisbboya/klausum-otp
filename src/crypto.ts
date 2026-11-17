const enc = new TextEncoder();
const ALPHANUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(input)));
}

/** Uniform random integer in [0, n) via rejection sampling — no modulo bias. */
export function randomIndex(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 256) throw new Error("n out of range");
  const limit = 256 - (256 % n); // largest multiple of n that fits in a byte
  const buf = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

export function randomString(len: number, alphabet = ALPHANUM): string {
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[randomIndex(alphabet.length)];
  return s;
}

/** Constant-time compare: XORs every byte, never returns early. */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export const newApiKey = (mode: "live" | "test" = "live") => `kotp_${mode}_${randomString(32)}`;
export const newId = (prefix: string) => `${prefix}_${randomString(20)}`;
