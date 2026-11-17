#!/usr/bin/env node
// Small latency benchmark. Uses a TEST key (kotp_test_…) so no email/SMS is ever sent.
//   node scripts/bench.mjs [count=100]
// Needs BENCH_API_KEY (a kotp_test_ key) in the environment or in .secrets.local.
// Stays well inside free limits: count sends + count verifies (default 200 requests).
import { readFileSync } from "node:fs";

const BASE = process.env.BENCH_URL ?? "https://otp.klausum.study";
const N = Number(process.argv[2] ?? 100);
let KEY = process.env.BENCH_API_KEY;
if (!KEY) {
  try { KEY = /^BENCH_API_KEY=(.+)$/m.exec(readFileSync(".secrets.local", "utf8"))?.[1].trim(); } catch {}
}
if (!KEY?.startsWith("kotp_test_")) { console.error("Set BENCH_API_KEY to a kotp_test_ key."); process.exit(1); }

const h = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const serverTotal = (res) => Number(/total;dur=(\d+)/.exec(res.headers.get("server-timing") ?? "")?.[1] ?? NaN);
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const fmt = (name, xs) => `${name.padEnd(22)} n=${xs.length}  p50=${pct(xs, 50)}ms  p95=${pct(xs, 95)}ms  max=${Math.max(...xs)}ms`;

async function timed(path, body) {
  const t0 = performance.now();
  const res = await fetch(BASE + path, { method: "POST", headers: h, body: JSON.stringify(body) });
  const json = await res.json();
  return { ms: Math.round(performance.now() - t0), server: serverTotal(res), status: res.status, json };
}

// Warm up: TLS handshake + isolate start + auth cache (not counted).
await fetch(BASE + "/health");
await timed("/v1/otp/send", { channel: "email", to: `warm-${Date.now()}@bench.invalid` });

const run = Date.now().toString(36);
const send = { client: [], server: [] }, verify = { client: [], server: [] };
const ids = [];
for (let i = 0; i < N; i++) {
  const r = await timed("/v1/otp/send", { channel: "email", to: `b${i}-${run}@bench.invalid` });
  if (r.status !== 202) { console.error("send failed", r.status, r.json); process.exit(1); }
  send.client.push(r.ms); send.server.push(r.server); ids.push(r.json.request_id);
}
for (const id of ids) {
  const r = await timed("/v1/otp/verify", { request_id: id, code: "000000" }); // wrong code = the slower path
  if (r.status !== 200) { console.error("verify failed", r.status, r.json); process.exit(1); }
  verify.client.push(r.ms); verify.server.push(r.server);
}

console.log(`\nKlausum OTP benchmark → ${BASE}  (${new Date().toISOString()})`);
console.log(fmt("send   (from here)", send.client));
console.log(fmt("send   (server-side)", send.server));
console.log(fmt("verify (from here)", verify.client));
console.log(fmt("verify (server-side)", verify.server));
console.log("\n'from here' = full round trip from this computer; 'server-side' = Server-Timing total inside the Worker.");
