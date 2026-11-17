/**
 * Control-room session cookie: issued only after BOTH an emailed code (to ADMIN_EMAIL) and an
 * authenticator code (TOTP) check out. Stateless and signed: HMAC(ADMIN_TOKEN-derived key).
 * Rotating ADMIN_TOKEN therefore logs every session out.
 *   Cookie: __Host-kotp_admin=<exp>.<nonce>.<sig>; HttpOnly; Secure; SameSite=Strict; Path=/; 12 h
 * State-changing requests made with the cookie must also come from our own origin (CSRF guard).
 */
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "./index";
import { randomString, timingSafeEqual, toHex } from "./crypto";

export const SESSION_COOKIE = "__Host-kotp_admin";
export const SESSION_TTL = 12 * 3600;
const enc = new TextEncoder();

async function sign(secret: string, data: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode(`session:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

export async function issueSession(c: Context<{ Bindings: Env }>) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const nonce = randomString(16);
  const value = `${exp}.${nonce}.${await sign(c.env.ADMIN_TOKEN, `${exp}.${nonce}`)}`;
  setCookie(c, SESSION_COOKIE, value, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: SESSION_TTL });
}

export function endSession(c: Context<{ Bindings: Env }>) {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
}

export async function readSession(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const v = getCookie(c, SESSION_COOKIE);
  if (!v || !c.env.ADMIN_TOKEN) return false;
  const [expS, nonce, sig] = v.split(".");
  const exp = Number(expS);
  if (!nonce || !sig || !Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  if (!timingSafeEqual(sig, await sign(c.env.ADMIN_TOKEN, `${expS}.${nonce}`))) return false;
  // CSRF: a cookie alone must never be enough to change things from another site.
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("Origin");
    if (!origin || origin !== new URL(c.req.url).origin) return false;
  }
  return true;
}
