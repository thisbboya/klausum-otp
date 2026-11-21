import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

/* ---- toast ---- */
const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const show = useCallback((m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3200); }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && <div className="toast" role="status">{msg}</div>}
    </ToastCtx.Provider>
  );
}

/* ---- confirmation sheet (Apple action-sheet style) ---- */
type SheetReq = { title: string; message: string; confirm: string; destructive?: boolean; typeToConfirm?: string; resolve: (ok: boolean) => void };
const SheetCtx = createContext<(r: Omit<SheetReq, "resolve">) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(SheetCtx);
export function SheetProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<SheetReq | null>(null);
  const [typed, setTyped] = useState("");
  const ask = useCallback((r: Omit<SheetReq, "resolve">) => new Promise<boolean>((resolve) => { setTyped(""); setReq({ ...r, resolve }); }), []);
  const close = (ok: boolean) => { req?.resolve(ok); setReq(null); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && req) close(false); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  return (
    <SheetCtx.Provider value={ask}>
      {children}
      {req && (
        <div className="sheet-backdrop" onClick={() => close(false)}>
          <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="sheet-title">{req.title}</h3>
            <p className="muted">{req.message}</p>
            {req.typeToConfirm && (
              <label className="field">Type <b className="mono">{req.typeToConfirm}</b> to confirm
                <input className="input" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
              </label>
            )}
            <div className="sheet-actions">
              <button className="btn secondary" onClick={() => close(false)}>Cancel</button>
              <button className={`btn ${req.destructive ? "destructive" : ""}`} disabled={!!req.typeToConfirm && typed !== req.typeToConfirm} onClick={() => close(true)}>{req.confirm}</button>
            </div>
          </div>
        </div>
      )}
    </SheetCtx.Provider>
  );
}

/* ---- data loader ---- */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await fn()); setError(null); } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{subtitle && <p className="muted">{subtitle}</p>}</div>
      {children && <div className="page-head-actions">{children}</div>}
    </div>
  );
}

export function Empty({ title, text }: { title: string; text?: string }) {
  return <div className="empty"><b>{title}</b>{text && <p className="muted small">{text}</p>}</div>;
}

export function ErrorBox({ text }: { text: string }) {
  return <div className="error-box" role="alert">{text}</div>;
}
