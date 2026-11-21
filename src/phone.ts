/**
 * Free phone-number verification without SMS.
 *
 *  Telegram: POST /v1/phone/start {method:"telegram"} → a t.me link with a one-time start token.
 *            The user opens the bot, taps "Share my number"; Telegram sends us the contact.
 *            We accept it only if contact.user_id === from.id (their OWN number, which Telegram
 *            itself confirmed by SMS when the account was made).
 *  WhatsApp: POST /v1/phone/start {method:"whatsapp"} → a 6-digit code and a wa.me link with a
 *            pre-filled message. The user sends it; Meta tells us which number sent it.
 *            Messages users send in are free; we never send anything back.
 *  Both:     GET /v1/phone/status/:id → {status:"pending"|"verified"|"expired", phone?}
 *
 * Webhooks (no API key; each is authenticated its own way):
 *  POST /hooks/telegram   header X-Telegram-Bot-Api-Secret-Token = TELEGRAM_WEBHOOK_SECRET
 *  GET  /hooks/whatsapp   Meta's subscribe handshake (WHATSAPP_VERIFY_TOKEN)
 *  POST /hooks/whatsapp   X-Hub-Signature-256 = HMAC-SHA256(WHATSAPP_APP_SECRET, raw body)
 */
import { Hono } from "hono";
import type { Env } from "./index";
import { requireApiKey, preflight, type Vars } from "./auth";
import { newId, randomString, sha256Hex, timingSafeEqual, toHex } from "./crypto";

export const PHONE_TTL = 600; // 10 minutes to finish in the other app
const nowS = () => Math.floor(Date.now() / 1000);
const digits = (s: string) => s.replace(/\D/g, "");
const e164 = (s: string) => `+${digits(s)}`;

// ---------- API (app key) ----------
export const phone = new Hono<{ Bindings: Env; Variables: Vars }>();
phone.use("*", preflight);
phone.use("*", requireApiKey);

phone.post("/start", async (c) => {
  const b = (await c.req.json().catch(() => null)) as { method?: unknown } | null;
  const method = b?.method;
  if (method !== "telegram" && method !== "whatsapp") return c.json({ error: "invalid_request" }, 400);
  if (method === "telegram" && !(c.env.TELEGRAM_BOT_TOKEN && c.env.TELEGRAM_BOT_USERNAME && c.env.TELEGRAM_WEBHOOK_SECRET)) return c.json({ error: "method_unavailable" }, 400);
  if (method === "whatsapp" && !(c.env.WHATSAPP_NUMBER && c.env.WHATSAPP_APP_SECRET)) return c.json({ error: "method_unavailable" }, 400);

  const app = c.get("app");
  const now = nowS();
  // Cheap abuse cap: 60 unfinished checks per app per 10 minutes.
  const open = await c.env.DB.prepare("SELECT COUNT(*) n FROM phone_checks WHERE app_id=? AND created_at>? AND status='pending'")
    .bind(app.id, now - PHONE_TTL).first<{ n: number }>();
  if ((open?.n ?? 0) >= 60) return c.json({ error: "rate_limited", retry_after: 60 }, 429, { "Retry-After": "60" });

  const id = newId("pc");
  for (let i = 0; i < 5; i++) {
    const secret = method === "telegram" ? randomString(24) : String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
    const res = await c.env.DB.prepare("INSERT OR IGNORE INTO phone_checks (id,app_id,method,secret_hash,created_at,expires_at) VALUES (?,?,?,?,?,?)")
      .bind(id, app.id, method, await sha256Hex(`${method}:${secret}`), now, now + PHONE_TTL).run();
    if (!res.meta.changes) continue; // another open check holds this code: draw again
    const name = app.display_name || app.name;
    if (method === "telegram") {
      return c.json({ request_id: id, method, link: `https://t.me/${c.env.TELEGRAM_BOT_USERNAME}?start=${secret}`, expires_in: PHONE_TTL }, 201);
    }
    const text = `${name} code ${secret}`;
    return c.json({ request_id: id, method, code: secret, message: text, link: `https://wa.me/${digits(c.env.WHATSAPP_NUMBER!)}?text=${encodeURIComponent(text)}`, expires_in: PHONE_TTL }, 201);
  }
  return c.json({ error: "internal_error" }, 500);
});

phone.get("/status/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT status, phone, expires_at FROM phone_checks WHERE id=? AND app_id=?")
    .bind(c.req.param("id"), c.get("app").id).first<{ status: string; phone: string | null; expires_at: number }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.status === "verified") return c.json({ status: "verified", phone: row.phone });
  return c.json({ status: row.expires_at < nowS() ? "expired" : "pending" });
});

// ---------- webhooks ----------
export const hooks = new Hono<{ Bindings: Env }>();

async function tg(env: Env, method: string, body: unknown) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
  }).catch(() => {});
}

type TgMsg = { chat: { id: number; type: string }; from?: { id: number }; text?: string; contact?: { phone_number: string; user_id?: number } };

hooks.post("/telegram", async (c) => {
  const want = c.env.TELEGRAM_WEBHOOK_SECRET;
  if (!want || !timingSafeEqual(c.req.header("X-Telegram-Bot-Api-Secret-Token") ?? "", want)) return c.json({ error: "unauthorized" }, 401);
  const u = (await c.req.json().catch(() => null)) as { message?: TgMsg } | null;
  const m = u?.message;
  if (!m || m.chat.type !== "private") return c.json({ ok: true });
  const chat = String(m.chat.id);
  const now = nowS();

  const start = m.text?.match(/^\/start\s+([A-Za-z0-9]{24})$/);
  if (start) {
    const res = await c.env.DB.prepare("UPDATE phone_checks SET chat_id=? WHERE method='telegram' AND secret_hash=? AND status='pending' AND expires_at>?")
      .bind(chat, await sha256Hex(`telegram:${start[1]}`), now).run();
    if (!res.meta.changes) {
      await tg(c.env, "sendMessage", { chat_id: m.chat.id, text: "This link has expired. Go back and tap \"Verify with Telegram\" again." });
    } else {
      await tg(c.env, "sendMessage", {
        chat_id: m.chat.id,
        text: "Tap the button below to confirm your phone number.",
        reply_markup: { keyboard: [[{ text: "📱 Share my number", request_contact: true }]], one_time_keyboard: true, resize_keyboard: true },
      });
    }
    return c.json({ ok: true });
  }

  if (m.contact) {
    // Only the sender's own number counts — not a contact forwarded from their address book.
    if (!m.from || m.contact.user_id !== m.from.id) {
      await tg(c.env, "sendMessage", { chat_id: m.chat.id, text: "Please use the \"Share my number\" button to send your own number." });
      return c.json({ ok: true });
    }
    const res = await c.env.DB.prepare(
      `UPDATE phone_checks SET status='verified', phone=?, verified_at=? WHERE id = (
         SELECT id FROM phone_checks WHERE method='telegram' AND chat_id=? AND status='pending' AND expires_at>? ORDER BY created_at DESC LIMIT 1)`,
    ).bind(e164(m.contact.phone_number), now, chat, now).run();
    await tg(c.env, "sendMessage", {
      chat_id: m.chat.id,
      text: res.meta.changes ? "✅ Number confirmed. You can go back now." : "No verification is waiting. Go back and tap \"Verify with Telegram\" again.",
      reply_markup: { remove_keyboard: true },
    });
    return c.json({ ok: true });
  }
  return c.json({ ok: true });
});

hooks.get("/whatsapp", (c) => {
  const q = c.req.query();
  const want = c.env.WHATSAPP_VERIFY_TOKEN;
  if (want && q["hub.mode"] === "subscribe" && timingSafeEqual(q["hub.verify_token"] ?? "", want)) return c.text(q["hub.challenge"] ?? "");
  return c.text("forbidden", 403);
});

hooks.post("/whatsapp", async (c) => {
  const raw = await c.req.text();
  const secret = c.env.WHATSAPP_APP_SECRET;
  if (!secret) return c.json({ error: "unavailable" }, 503);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = `sha256=${toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))}`;
  if (!timingSafeEqual(c.req.header("X-Hub-Signature-256") ?? "", sig)) return c.json({ error: "unauthorized" }, 401);

  type WaMsg = { from: string; type: string; text?: { body: string } };
  const body = JSON.parse(raw) as { entry?: { changes?: { value?: { messages?: WaMsg[] } }[] }[] };
  const now = nowS();
  for (const e of body.entry ?? []) for (const ch of e.changes ?? []) for (const msg of ch.value?.messages ?? []) {
    const code = msg.type === "text" ? msg.text?.body.match(/\b(\d{6})\b/)?.[1] : undefined;
    if (!code || !/^\d{7,15}$/.test(msg.from)) continue;
    await c.env.DB.prepare("UPDATE phone_checks SET status='verified', phone=?, verified_at=? WHERE method='whatsapp' AND secret_hash=? AND status='pending' AND expires_at>?")
      .bind(e164(msg.from), now, await sha256Hex(`whatsapp:${code}`), now).run();
  }
  return c.json({ ok: true }); // always 200 so Meta doesn't retry
});
