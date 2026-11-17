# Apple-style website, control room and AI assistant — design

_2026-11-17 · owner: Sadick_

## Intent
Klausum OTP is Sadick's own one-time-code service for all his projects (no renters). He wants:
1. a **public website** that presents it and documents it,
2. the **control room rebuilt** to Apple quality with more features and one-click fixes,
3. an **AI assistant** in the control room that understands the service through a handbook and can
   diagnose and fix problems.
Everything **Apple-themed**, light and dark, phone-friendly. Must stay free (Cloudflare free tier).

## Goals
- Website at `https://otp.klausum.study/`: hero, how it works, security, speed, quick start, API reference,
  self-host guide, links to status + GitHub. Content comes from README / SECURITY.md (single source of truth).
- Control room at `/admin`: same login (email code + authenticator), redesigned:
  Overview · Apps & keys · Logs · Providers · Blocklist · **Fixes** · **Assistant** · Settings (secrets age, alerts test).
- **Fixes**: each runbook problem shown as a card when detected ("Resend failing 3×"), with its explanation and
  one-click actions that call the existing admin API.
- **Assistant**: chat panel. Uses Gemini (free tier, key as Worker secret `GEMINI_API_KEY`). Knows the service from
  a machine-readable handbook. Can call tools = the admin API actions.
  - **May act alone (reversible, protective):** block an abusing IP/number/email; move email to the backup provider.
    Every such action is logged and sent to Telegram.
  - **Must ask (owner taps Approve):** pause/delete apps, rotate/revoke keys, change caps/TTL, unblock, provider on/off.
  - Also runs automatically after a self-check finds a problem: writes a diagnosis + suggested fix into Fixes and Telegram.

## Non-goals
Billing, sign-up for other developers, SMS, Meraaba, multi-tenant anything.

## Anti-goals
- AI that can do destructive things without a tap, or see codes/recipients/secrets.
- A second deployment to keep in sync; a slower API; weaker security headers on the API.
- Anything that shows "made with Claude/AI tools" credits.

## Constraints
- Cloudflare Workers free plan: 10 ms CPU/request — UI is static files, AI calls go to Gemini (I/O, not CPU).
- One repo, one Worker, one CI pipeline. Strict CSP stays (no inline scripts).
- Existing admin API and session cookie are reused; the old `/admin` and `/dashboard` pages are replaced.

## Approaches (picked: B)
- A — keep HTML strings in the Worker: no new tooling, but can't reach Apple quality; messy at this size.
- **B — React + Vite front-end in `web/`, built to static files served by the same Worker (Workers Static Assets).** Real components and motion, one deploy, same origin (cookie + CSP simple). Cost: one build step in CI. **Chosen.**
- C — separate Cloudflare Pages site: second deploy, cross-origin cookies. Rejected.

## How (decided)
- `web/` (Vite + React + TypeScript), two entry points: `index.html` (website) and `admin.html` (control room).
  No UI framework; hand-written CSS with Apple-like tokens (system font stack incl. SF Pro, 12–20 px radii,
  #f5f5f7 / #000 backgrounds, translucent blurred headers, subtle shadows, 200–300 ms ease-out motion,
  `prefers-reduced-motion` respected). Icons inline SVG.
- `wrangler.jsonc` → `assets: { directory: "web/dist", run_worker_first: [...] }` so `/v1/*`, `/admin/*` API,
  `/auth/*`, `/health`, `/status.json` hit the Worker; pages/files come from assets. `status.klausum.study` keeps
  its current page.
- Handbook: `src/handbook.ts` — list of problems {id, how detected (alert key), meaning, safe auto-actions,
  owner-approval actions, user message}, generated from RUNBOOK.md content; served at `/admin/handbook`.
- Assistant backend: `POST /admin/assistant` (session-only). Sends the conversation + handbook + live stats
  (no PII) to Gemini with function-calling tools mapped 1:1 to admin actions. Tool calls in the "must ask" set
  return a pending action the UI shows with Approve/Cancel; approval calls the normal admin API.
  All AI actions written to an `ai_actions` audit table and shown in the Assistant tab.
- Self-check hook: when new alerts fire and `GEMINI_API_KEY` is set, ask the assistant for a diagnosis
  (no tool execution beyond the "may act alone" set), save it to Fixes, include it in the Telegram alert.
- Tests: Worker side (handbook, assistant tool gating with a mocked Gemini, audit log). Front-end: typecheck +
  build in CI; key screens checked in the browser.

## Left to the builder
Exact layout of each screen, copy wording, chart details, Gemini model choice (newest free Flash),
component structure.

## Calls I made (Sadick can change)
- Gemini free tier as the AI; the "act alone vs ask" split above.
- Website lives on `otp.klausum.study/` (the API stays on the same host).
