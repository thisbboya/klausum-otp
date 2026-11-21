import { useState } from "react";
import { api } from "./api";

/** Two steps: email → (email code + authenticator code). */
export function Login({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState("");
  const [reqId, setReqId] = useState("");
  const [code, setCode] = useState("");
  const [totp, setTotp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { const r = await api<{ request_id: string }>("POST", "/auth/admin/start", { email }); setReqId(r.request_id); setStep(2); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await api("POST", "/auth/admin/verify", { request_id: reqId, code: code.trim(), totp: totp.trim() }); onDone(); }
    catch (err) { setError((err as Error).message === "invalid" ? "One of the codes isn't right. Check both and try again." : (err as Error).message); setTotp(""); }
    finally { setBusy(false); }
  }

  return (
    <div className="login">
      <div className="login-card rise">
        <img src="/favicon.svg" alt="" width={56} height={56} />
        <h1>Control Room</h1>
        <p className="muted">Klausum OTP</p>
        {step === 1 ? (
          <form onSubmit={start} className="login-form">
            <input className="input" type="email" autoComplete="email" placeholder="Owner email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            <button className="btn lg block" disabled={busy}>{busy ? "Sending…" : "Continue"}</button>
          </form>
        ) : (
          <form onSubmit={verify} className="login-form">
            <p className="small muted">Enter the code we emailed you and the code from your authenticator app.</p>
            <input className="input code-input" inputMode="numeric" autoComplete="one-time-code" placeholder="Email code" maxLength={6} pattern="\d{6}" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required autoFocus />
            <input className="input code-input" inputMode="numeric" autoComplete="off" placeholder="Authenticator code" maxLength={6} pattern="\d{6}" value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))} required />
            <button className="btn lg block" disabled={busy || code.length < 6 || totp.length < 6}>{busy ? "Checking…" : "Sign in"}</button>
            <button type="button" className="btn plain" onClick={() => { setStep(1); setError(null); }}>Use a different email</button>
          </form>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>
    </div>
  );
}
