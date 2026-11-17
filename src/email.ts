import type { Env } from "./index";

export type Email = { to: string; subject: string; text: string; html: string };
export type SendResult = { ok: true } | { ok: false; quota: boolean; error: string };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Plain, image-free template. Code in the subject so it shows in phone notifications. */
export function otpEmail(appName: string, code: string, ttlSeconds: number): Omit<Email, "to"> {
  const mins = Math.round(ttlSeconds / 60);
  const subject = `Your ${appName} code: ${code}`;
  const text =
    `${appName}\n\nYour verification code is: ${code}\n\n` +
    `It expires in ${mins} minutes.\n\nIf you didn't ask for this, ignore this email.\n`;
  const a = esc(appName);
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:440px;background:#ffffff;border-radius:12px;padding:32px" cellpadding="0" cellspacing="0">
<tr><td style="font-size:18px;font-weight:bold">${a}</td></tr>
<tr><td style="padding-top:16px;font-size:15px">Your verification code is:</td></tr>
<tr><td style="padding:16px 0;font-size:36px;font-weight:bold;letter-spacing:8px;font-family:'Courier New',monospace">${code}</td></tr>
<tr><td style="font-size:14px;color:#52525b">It expires in ${mins} minutes.</td></tr>
<tr><td style="padding-top:24px;font-size:13px;color:#71717a">If you didn't ask for this, ignore this email.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

async function errText(r: Response) {
  return (await r.text().catch(() => "")).slice(0, 300);
}

export async function sendResend(env: Env, m: Email): Promise<SendResult> {
  if (!env.RESEND_API_KEY) return { ok: false, quota: false, error: "resend not configured" };
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
  });
  if (r.ok) return { ok: true };
  const body = await errText(r);
  // Docs: 429 daily_quota_exceeded / monthly_quota_exceeded → skip Resend until midnight UTC.
  const quota = r.status === 429 && /quota/i.test(body);
  return { ok: false, quota, error: `resend ${r.status}: ${body}` };
}

export async function sendAhaSend(env: Env, m: Email): Promise<SendResult> {
  if (!env.AHASEND_API_KEY || !env.AHASEND_ACCOUNT_ID) return { ok: false, quota: false, error: "ahasend not configured" };
  const from = /^(.*)<(.+)>$/.exec(env.EMAIL_FROM);
  const r = await fetch(`https://api.ahasend.com/v2/accounts/${env.AHASEND_ACCOUNT_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.AHASEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: from ? { name: from[1].trim(), email: from[2].trim() } : { email: env.EMAIL_FROM },
      recipients: [{ email: m.to }],
      subject: m.subject, text_content: m.text, html_content: m.html,
    }),
  });
  if (r.ok) return { ok: true };
  const body = await errText(r);
  return { ok: false, quota: r.status === 429 || /quota|limit/i.test(body), error: `ahasend ${r.status}: ${body}` };
}

export const EMAIL_PROVIDERS = { resend: sendResend, ahasend: sendAhaSend } as const;
export type EmailProvider = keyof typeof EMAIL_PROVIDERS;
