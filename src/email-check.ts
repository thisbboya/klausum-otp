/**
 * "Only real, legitimate email addresses."
 *
 * 1. Disposable/temporary providers (10-minute mail, guerrillamail, yopmail, …) are refused
 *    using the community blocklist — including their sub-domains.
 * 2. The domain must actually receive mail: it needs MX records (checked over DNS-over-HTTPS,
 *    cached). Domains with no MX, or a "null MX" (RFC 7505: `0 .`), are refused.
 * 3. A domain whose mail servers belong to a disposable provider is refused too (temp-mail
 *    services rotate new domain names but keep pointing them at the same servers).
 *
 * If the DNS lookup itself fails (resolver outage) we let the address through rather than
 * lock everyone out — the blocklist check still applies.
 */
import { DISPOSABLE_DOMAINS } from "./disposable-domains";

export type EmailVerdict = { ok: true } | { ok: false; reason: "disposable" | "no_mailbox" };

/** True if the domain or any parent domain is on the blocklist. */
export function isDisposableDomain(domain: string): boolean {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".");
  for (let i = 0; i < labels.length - 1; i++) if (DISPOSABLE_DOMAINS.has(labels.slice(i).join("."))) return true;
  return false;
}

type Mx = { ok: boolean; hosts: string[] };
const mxCache = new Map<string, { v: Mx | null; until: number }>();

async function lookupMx(domain: string, f: typeof fetch): Promise<Mx | null> {
  const hit = mxCache.get(domain);
  if (hit && hit.until > Date.now()) return hit.v;
  let v: Mx | null = null;
  try {
    const r = await f(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, {
      headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(2500),
    });
    if (r.ok) {
      const j = (await r.json()) as { Status: number; Answer?: { type: number; data: string }[] };
      const hosts = (j.Answer ?? []).filter((a) => a.type === 15).map((a) => a.data.trim().split(/\s+/)[1]?.replace(/\.$/, "").toLowerCase() ?? "");
      const real = hosts.filter((h) => h && h !== "" && h !== ".");
      // Status 3 = NXDOMAIN (domain doesn't exist). Empty or null-MX = no mailbox.
      v = { ok: j.Status === 0 && real.length > 0, hosts: real };
    }
  } catch { v = null; }
  // Cache answers: good ones 6 h, bad ones 10 min, resolver failures not at all.
  if (v) mxCache.set(domain, { v, until: Date.now() + (v.ok ? 6 * 3600_000 : 600_000) });
  if (mxCache.size > 5000) mxCache.clear();
  return v;
}

export async function checkEmail(email: string, opts: { dns: boolean; fetch?: typeof fetch }): Promise<EmailVerdict> {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (isDisposableDomain(domain)) return { ok: false, reason: "disposable" };
  if (!opts.dns) return { ok: true };
  const mx = await lookupMx(domain, opts.fetch ?? fetch);
  if (!mx) return { ok: true }; // resolver outage: fail open (blocklist already applied)
  if (!mx.ok) return { ok: false, reason: "no_mailbox" };
  if (mx.hosts.some((h) => isDisposableDomain(h))) return { ok: false, reason: "disposable" };
  return { ok: true };
}

export const clearMxCache = () => mxCache.clear();
