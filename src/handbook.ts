/**
 * The machine-readable handbook: every alert the self-check can raise, what it means, and the
 * fixes for it. The Fixes tab shows it; the assistant reads it as its "brain". Written from
 * docs/RUNBOOK.md — keep the two in step.
 */
import type { ToolName } from "./assistant-tools";

export type FixAction = { id: string; label: string; tool: ToolName; args: Record<string, unknown>; safe: boolean };
export type HandbookEntry = {
  id: string;
  match: (alertKey: string) => boolean;
  title: string;
  meaning: string;
  userImpact: string;
  actions: FixAction[];
};

const prov = (k: string) => k.split(":")[1] ?? "";

export const HANDBOOK: HandbookEntry[] = [
  {
    id: "d1",
    match: (k) => k === "d1",
    title: "Database is failing",
    meaning: "Cloudflare D1 is returning errors. Either Cloudflare has an incident (check cloudflarestatus.com) or the free daily write limit (100 000 rows) was hit — it resets at 00:00 UTC.",
    userImpact: "Codes can't be sent or checked. Users should sign in with Google meanwhile.",
    actions: [{ id: "recheck", label: "Run the health check again", tool: "run_check", args: {}, safe: true }],
  },
  {
    id: "provider-streak",
    match: (k) => k.startsWith("streak:") && k !== "streak:textbee",
    title: "An email provider keeps failing",
    meaning: "The provider failed 3 times in a row. Codes are already falling back to the next provider. Look at Logs for the exact error (bad key, quota, outage).",
    userImpact: "Emails may arrive a little slower via the backup provider; nothing is lost.",
    actions: [
      { id: "move-later", label: "Try the other provider first", tool: "provider_order", args: { later: "$provider" }, safe: true },
      { id: "turn-off", label: "Turn this provider off", tool: "provider_toggle", args: { provider: "$provider", on: false }, safe: false },
    ],
  },
  {
    id: "provider-key",
    match: (k) => k.startsWith("key:"),
    title: "A provider API key is invalid",
    meaning: "The provider rejected our key. Make a new key on its website and store it with `npx wrangler secret put <NAME>`, then mark it rotated.",
    userImpact: "That provider can't send; the backup provider is used.",
    actions: [
      { id: "move-later", label: "Use the other provider first", tool: "provider_order", args: { later: "$provider" }, safe: true },
      { id: "turn-off", label: "Turn this provider off", tool: "provider_toggle", args: { provider: "$provider", on: false }, safe: false },
    ],
  },
  {
    id: "quota",
    match: (k) => k.startsWith("quota:"),
    title: "A free quota is running out",
    meaning: "A provider has used 80 %+ of its free daily or monthly allowance. When it's used up the service skips it automatically until it resets.",
    userImpact: "None yet. If every email provider runs out, codes stop until the reset.",
    actions: [
      { id: "move-later", label: "Use the other provider first", tool: "provider_order", args: { later: "$provider" }, safe: true },
      { id: "see-stats", label: "Show usage", tool: "get_stats", args: {}, safe: true },
    ],
  },
  {
    id: "errors",
    match: (k) => k === "errors",
    title: "Many codes are failing to deliver",
    meaning: "More than 5 % of codes in the last hour failed. Usually a provider problem — check Logs filtered to failed.",
    userImpact: "Some users don't receive their code.",
    actions: [{ id: "failed-logs", label: "Show failed deliveries", tool: "get_logs", args: { status: "failed", limit: 20 }, safe: true }],
  },
  {
    id: "spike",
    match: (k) => k === "spike",
    title: "Unusual spike in sends",
    meaning: "Codes sent in the last hour are 5× normal. Possibly abuse (someone looping, or flooding a victim). Find the app/IP/recipient in Logs.",
    userImpact: "Free quotas can be burned through; real users may then miss codes.",
    actions: [
      { id: "logs", label: "Show recent deliveries", tool: "get_logs", args: { limit: 30 }, safe: true },
      { id: "block-ip", label: "Block an IP…", tool: "block_add", args: { kind: "ip", value: "" }, safe: true },
    ],
  },
  {
    id: "secrets",
    match: (k) => k === "secrets",
    title: "Secrets are due for rotation",
    meaning: "One or more secrets are older than 180 days. Follow docs/ROTATION.md, then mark each rotated in Settings.",
    userImpact: "None — this is routine hygiene.",
    actions: [{ id: "ages", label: "Show secret ages", tool: "get_stats", args: {}, safe: true }],
  },
  {
    id: "sms-phone",
    match: (k) => k === "textbee:silent" || k === "streak:textbee",
    title: "SMS phone is offline",
    meaning: "The textbee phone hasn't checked in. Check charging, Wi-Fi/data and that the app is running (docs/SMS-PHONE.md).",
    userImpact: "SMS codes fall back to email where the app gave one.",
    actions: [{ id: "sms-off", label: "Stop trying SMS for now", tool: "provider_toggle", args: { provider: "textbee", on: false }, safe: false }],
  },
];

/** The entry for an alert, with "$provider" placeholders filled from the alert key. */
export function entryFor(alertKey: string): Omit<HandbookEntry, "match"> | null {
  const e = HANDBOOK.find((h) => h.match(alertKey));
  if (!e) return null;
  const p = prov(alertKey);
  const { match: _m, ...rest } = e;
  return {
    ...rest,
    actions: e.actions.map((a) => ({ ...a, args: Object.fromEntries(Object.entries(a.args).map(([k, v]) => [k, v === "$provider" ? p : v])) })),
  };
}

/** Plain-text handbook for the assistant's instructions. */
export function handbookText(): string {
  return HANDBOOK.map((h) => `## ${h.title} [${h.id}]\nMeaning: ${h.meaning}\nUser impact: ${h.userImpact}\nFixes: ${h.actions.map((a) => `${a.label} → ${a.tool}${a.safe ? " (safe)" : " (needs owner approval)"}`).join("; ")}`).join("\n\n");
}
