/**
 * @klausum/otp — tiny, zero-dependency client for the Klausum OTP service.
 *
 * Works anywhere `fetch` exists: Cloudflare Workers, Node 18+, Deno, Bun.
 * SERVER-SIDE ONLY: your API key is a secret. Call this from your backend and have
 * your web page / mobile app talk to your backend — never ship the key to a browser.
 *
 *   import { createOtpClient } from "@klausum/otp";
 *   const otp = createOtpClient({ apiKey: env.KLAUSUM_OTP_KEY });
 *   const { requestId } = await otp.sendOtp({ channel: "email", to: "ama@example.com" });
 *   const { valid } = await otp.verifyOtp({ requestId, code: "482913" });
 */

export type Channel = "email" | "sms";

export interface OtpClientOptions {
  /** `kotp_live_…` or `kotp_test_…` (test keys never deliver anything). */
  apiKey: string;
  /** Defaults to https://otp.klausum.study */
  baseUrl?: string;
  /** Per-request timeout in ms (default 10 000). */
  timeoutMs?: number;
  /** Custom fetch (tests, proxies). Defaults to the global fetch. */
  fetch?: typeof fetch;
}

export interface SendOtpInput {
  channel: Channel;
  /** Email address, or phone number (local Ghana format is fine: 0241234567). */
  to: string;
  purpose?: string;
  locale?: string;
  /** SMS only: email to use if the SMS can't be delivered. */
  fallbackEmail?: string;
  /** Your user's IP (from your server's request), so per-IP limits apply per person, not to your server. */
  endUserIp?: string;
}

export interface SendOtpResult {
  requestId: string;
  channel: Channel;
  /** Seconds until the code expires. */
  expiresIn: number;
  /** Seconds before the user may ask for a new code. */
  resendAfter: number;
}

export type VerifyFailReason = "invalid_code" | "expired" | "too_many_attempts";
export type VerifyOtpResult =
  | { valid: true }
  | { valid: false; reason: VerifyFailReason; attemptsLeft?: number };

export type DeliveryStatus = "queued" | "sent" | "delivered" | "failed";
export interface StatusResult { requestId: string; channel: Channel; status: DeliveryStatus; provider: string | null }

export type OtpErrorCode = "invalid_request" | "email_not_allowed" | "unauthorized" | "rate_limited" | "not_found" | "origin_not_allowed" | "network" | "server_error";

/** Thrown for anything that isn't a normal answer. `retryAfter` is set on `rate_limited`. */
export class OtpError extends Error {
  /** For `email_not_allowed`: "disposable" (temp-mail provider) or "no_mailbox" (domain can't receive mail). */
  public reason?: string;
  constructor(public code: OtpErrorCode, public status: number, public retryAfter?: number) {
    super(`Klausum OTP: ${code}${retryAfter ? ` (retry after ${retryAfter}s)` : ""}`);
    this.name = "OtpError";
  }
}

export interface OtpClient {
  sendOtp(input: SendOtpInput): Promise<SendOtpResult>;
  verifyOtp(input: { requestId: string; code: string }): Promise<VerifyOtpResult>;
  resendOtp(input: { requestId: string; endUserIp?: string }): Promise<SendOtpResult>;
  getStatus(requestId: string): Promise<StatusResult>;
}

const KNOWN: OtpErrorCode[] = ["invalid_request", "email_not_allowed", "unauthorized", "rate_limited", "not_found", "origin_not_allowed"];

export function createOtpClient(opts: OtpClientOptions): OtpClient {
  if (!/^kotp_(live|test)_[A-Za-z0-9]{32}$/.test(opts.apiKey ?? "")) throw new Error("Klausum OTP: apiKey must be a kotp_live_… or kotp_test_… key");
  if (typeof (globalThis as { document?: unknown }).document !== "undefined" && opts.apiKey.startsWith("kotp_live_")) {
    throw new Error("Klausum OTP: a live API key must never be used in a browser. Call the service from your server.");
  }
  const base = (opts.baseUrl ?? "https://otp.klausum.study").replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(base + path, {
        method,
        headers: { Authorization: `Bearer ${opts.apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}), ...extra },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new OtpError("network", 0);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return json as T;
    const code = KNOWN.includes(json.error as OtpErrorCode) ? (json.error as OtpErrorCode) : "server_error";
    const ra = Number(res.headers.get("Retry-After") ?? json.retry_after);
    const err = new OtpError(code, res.status, Number.isFinite(ra) && ra > 0 ? ra : undefined);
    if (typeof json.reason === "string") err.reason = json.reason;
    throw err;
  }

  const toSend = (r: { request_id: string; channel: Channel; expires_in: number; resend_after: number }): SendOtpResult =>
    ({ requestId: r.request_id, channel: r.channel, expiresIn: r.expires_in, resendAfter: r.resend_after });

  return {
    async sendOtp(i) {
      return toSend(await call("POST", "/v1/otp/send", {
        channel: i.channel, to: i.to,
        ...(i.purpose ? { purpose: i.purpose } : {}), ...(i.locale ? { locale: i.locale } : {}),
        ...(i.fallbackEmail ? { fallback_email: i.fallbackEmail } : {}),
      }, i.endUserIp ? { "X-End-User-IP": i.endUserIp } : {}));
    },
    async verifyOtp(i) {
      const r = await call<{ valid: boolean; reason?: VerifyFailReason; attempts_left?: number }>(
        "POST", "/v1/otp/verify", { request_id: i.requestId, code: i.code });
      if (r.valid) return { valid: true };
      return { valid: false, reason: r.reason ?? "invalid_code", ...(r.attempts_left !== undefined ? { attemptsLeft: r.attempts_left } : {}) };
    },
    async resendOtp(i) {
      return toSend(await call("POST", "/v1/otp/resend", { request_id: i.requestId }, i.endUserIp ? { "X-End-User-IP": i.endUserIp } : {}));
    },
    async getStatus(id) {
      const r = await call<{ request_id: string; channel: Channel; status: DeliveryStatus; provider: string | null }>(
        "GET", `/v1/otp/status/${encodeURIComponent(id)}`);
      return { requestId: r.request_id, channel: r.channel, status: r.status, provider: r.provider };
    },
  };
}

// Spec-style top-level helpers: `sendOtp(apiKey, input)` etc., for one-off calls.
export const sendOtp = (apiKey: string, input: SendOtpInput) => createOtpClient({ apiKey }).sendOtp(input);
export const verifyOtp = (apiKey: string, input: { requestId: string; code: string }) => createOtpClient({ apiKey }).verifyOtp(input);
export const resendOtp = (apiKey: string, input: { requestId: string }) => createOtpClient({ apiKey }).resendOtp(input);
