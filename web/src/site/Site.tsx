import { useEffect, useState } from "react";
import { CodeBlock, Icon, Section } from "../ui/components";

const GITHUB = "https://github.com/thisbboya/klausum-otp";
const STATUS = "https://status.klausum.study";

const SEND = `curl -X POST https://otp.klausum.study/v1/otp/send \\
  -H "Authorization: Bearer $KLAUSUM_OTP_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"channel":"email","to":"ama@example.com"}'`;

const SDK = `import { createOtpClient } from "@klausum/otp";

const otp = createOtpClient({ apiKey: env.KLAUSUM_OTP_KEY });

// 1. send a code
const { requestId } = await otp.sendOtp({ channel: "email", to: "ama@example.com" });

// 2. check what the user typed
const { valid } = await otp.verifyOtp({ requestId, code: "482913" });`;

const SELFHOST = `git clone ${GITHUB} && cd klausum-otp && npm ci
npx wrangler d1 create klausum-otp        # paste the id into wrangler.jsonc
npx wrangler d1 migrations apply klausum-otp --remote
npx wrangler secret put OTP_PEPPER         # + TOTP_KEY, ADMIN_TOKEN, RESEND_API_KEY
npm run build:web && npx wrangler deploy`;

type Status = { overall: string; uptime90: number | null } | null;

function useStatus(): Status {
  const [s, setS] = useState<Status>(null);
  useEffect(() => {
    fetch("/status.json").then((r) => r.json()).then(setS).catch(() => setS(null));
  }, []);
  return s;
}

export function Site() {
  const status = useStatus();
  return (
    <>
      <Nav />
      <main>
        <Hero status={status} />
        <Features />
        <HowItWorks />
        <Security />
        <QuickStart />
        <Api />
        <SelfHost />
      </main>
      <Footer />
    </>
  );
}

function Nav() {
  return (
    <header className="nav glass">
      <div className="wrap nav-inner">
        <a className="brand" href="#top"><img src="/favicon.svg" alt="" width={22} height={22} /> Klausum OTP</a>
        <nav className="nav-links" aria-label="Sections">
          <a href="#features">Features</a>
          <a href="#security">Security</a>
          <a href="#start">Get started</a>
          <a href="#api">API</a>
          <a href={STATUS}>Status</a>
        </nav>
        <a className="btn sm" href="/admin">Control room</a>
      </div>
    </header>
  );
}

function Hero({ status }: { status: Status }) {
  const ok = status?.overall === "operational";
  return (
    <Section id="top" className="hero">
      <div className="wrap center rise">
        <a className="status-pill" href={STATUS}>
          <span className={`dot ${status ? (ok ? "ok" : "warn") : ""}`} />
          {status ? (ok ? "All systems operational" : "Some systems degraded") : "Checking status…"}
        </a>
        <h1>One-time codes.<br /><span className="grad">Fast. Private. Free.</span></h1>
        <p className="lead">Email codes and authenticator-app codes for every project, from one tiny service at the edge. Codes are never stored, never logged, and gone in five minutes.</p>
        <div className="cta">
          <a className="btn lg" href="#start">Get started</a>
          <a className="btn lg secondary" href={GITHUB}><Icon name="github" size={18} /> GitHub</a>
        </div>
        <CodeCard />
      </div>
    </Section>
  );
}

function CodeCard() {
  const digits = "482913".split("");
  return (
    <div className="device" aria-hidden>
      <div className="device-bar"><span /><span /><span /></div>
      <div className="device-body">
        <p className="small muted">Your Klausum code</p>
        <div className="digits">{digits.map((d, i) => <span key={i} style={{ animationDelay: `${200 + i * 90}ms` }}>{d}</span>)}</div>
        <p className="small muted">Expires in 5 minutes · works once</p>
      </div>
    </div>
  );
}

const FEATURES = [
  { icon: "mail", title: "Email codes", text: "Resend first, AhaSend as automatic backup. The code is in the subject so it shows in notifications." },
  { icon: "key", title: "Authenticator apps", text: "TOTP enrolment with a QR code, encrypted secrets and replay protection. Works with Google Authenticator." },
  { icon: "bolt", title: "Fast from Ghana", text: "Runs at the Accra edge. One database round trip per request — about 155 ms end to end." },
  { icon: "shield", title: "Real emails only", text: "10,000+ throwaway domains refused, and every domain must actually receive mail." },
  { icon: "chart", title: "Watched for you", text: "Self-check every 15 minutes, Telegram and email alerts, a daily summary, public status page." },
  { icon: "globe", title: "Free to run", text: "Cloudflare Workers + D1, Resend and AhaSend free tiers. Open source under MIT." },
] as const;

function Features() {
  return (
    <Section id="features">
      <div className="wrap">
        <h2 className="center">Everything a sign-in needs.<br /><span className="muted">Nothing it doesn't.</span></h2>
        <div className="grid3">
          {FEATURES.map((f) => (
            <article key={f.title} className="card feature">
              <span className="feature-icon"><Icon name={f.icon} /></span>
              <h3>{f.title}</h3>
              <p className="muted">{f.text}</p>
            </article>
          ))}
        </div>
      </div>
    </Section>
  );
}

function HowItWorks() {
  const steps = [
    { n: "1", t: "Your server asks", d: "POST /v1/otp/send with the user's email. You get a request id back in milliseconds." },
    { n: "2", t: "We deliver", d: "In the background, by the fastest healthy provider. Your user gets a clean, image-free email." },
    { n: "3", t: "Your server checks", d: "POST /v1/otp/verify with the code they typed. Valid once, for five minutes, five tries." },
  ];
  return (
    <Section className="tinted-bg">
      <div className="wrap">
        <h2 className="center">How it works</h2>
        <ol className="steps">
          {steps.map((s) => (
            <li key={s.n} className="card"><span className="step-n">{s.n}</span><h3>{s.t}</h3><p className="muted">{s.d}</p></li>
          ))}
        </ol>
      </div>
    </Section>
  );
}

function Security() {
  const rows = [
    ["Codes", "6 digits from a secure random source, no modulo bias. Stored only as an HMAC."],
    ["Lifetime", "5 minutes, single use, locked after 5 wrong tries. A new code cancels the old one."],
    ["Limits", "Per person: 1 per 30 s, 3 per 10 min, 10 per day. Per IP and per app caps too."],
    ["Privacy", "Recipients are hashed; logs never contain an email or a phone number."],
    ["Keys", "kotp_live_ keys stored as SHA-256 only, rotate with 24 h overlap, revoke in seconds."],
    ["Admin", "Email code + authenticator, HttpOnly session, brute-force lock-out."],
  ];
  return (
    <Section id="security">
      <div className="wrap narrow">
        <h2 className="center">Built like it matters.</h2>
        <p className="lead center muted">Every rule below has a test. Over a hundred of them run on every change before anything ships.</p>
        <div className="list security-list">
          {rows.map(([k, v]) => (
            <div key={k} className="row-item"><span className="check"><Icon name="check" size={18} /></span><div><b>{k}</b><p className="muted">{v}</p></div></div>
          ))}
        </div>
      </div>
    </Section>
  );
}

function QuickStart() {
  return (
    <Section id="start" className="tinted-bg">
      <div className="wrap narrow">
        <h2 className="center">Five minutes to your first code.</h2>
        <p className="lead center muted">Call it from your server — your key is a secret, never ship it to a browser.</p>
        <CodeBlock label="TypeScript · @klausum/otp (zero dependencies)" code={SDK} />
        <CodeBlock label="or plain curl" code={SEND} />
      </div>
    </Section>
  );
}

const ENDPOINTS = [
  ["POST", "/v1/otp/send", "{ channel, to, purpose? } → 202 { request_id, expires_in, resend_after }"],
  ["POST", "/v1/otp/verify", "{ request_id, code } → { valid } or { valid:false, reason, attempts_left }"],
  ["POST", "/v1/otp/resend", "{ request_id } → a fresh code; the old one stops working"],
  ["GET", "/v1/otp/status/:id", "queued · sent · delivered · failed, and which provider"],
  ["POST", "/v1/totp/enroll", "{ user_ref, issuer } → { secret, otpauth_url, qr_svg }"],
  ["POST", "/v1/totp/verify", "{ user_ref, code } → { valid } — ±30 s, no replays"],
];

function Api() {
  return (
    <Section id="api">
      <div className="wrap narrow">
        <h2 className="center">API</h2>
        <p className="center muted">All requests: <code>Authorization: Bearer kotp_…</code> and a JSON body. Errors: 400 · 401 · 429 with <code>Retry-After</code>.</p>
        <div className="list api-list">
          {ENDPOINTS.map(([m, p, d]) => (
            <div key={p} className="row-item api-row">
              <span className={`method ${m.toLowerCase()}`}>{m}</span>
              <div><code className="path">{p}</code><p className="muted small">{d}</p></div>
            </div>
          ))}
        </div>
        <p className="center"><a href={`${GITHUB}#api-reference`}>Full reference on GitHub <Icon name="arrow" size={14} /></a></p>
      </div>
    </Section>
  );
}

function SelfHost() {
  return (
    <Section className="tinted-bg">
      <div className="wrap narrow">
        <h2 className="center">Run your own copy.</h2>
        <p className="lead center muted">Free Cloudflare account, a domain and a free Resend account. About fifteen minutes.</p>
        <CodeBlock label="Self-host" code={SELFHOST} />
      </div>
    </Section>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="wrap footer-inner small muted">
        <span>© {new Date().getFullYear()} Sadick · Klausum OTP · MIT licensed</span>
        <nav aria-label="Footer">
          <a href={STATUS}>Status</a>
          <a href={GITHUB}>GitHub</a>
          <a href={`${GITHUB}/blob/main/PRIVACY.md`}>Privacy</a>
          <a href={`${GITHUB}/blob/main/TERMS.md`}>Terms</a>
        </nav>
      </div>
    </footer>
  );
}
