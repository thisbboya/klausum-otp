/** Same-origin calls to the admin API with the session cookie. 401 → back to login. */
export class AuthError extends Error {}

let onLoggedOut: () => void = () => {};
export const setLoggedOutHandler = (fn: () => void) => { onLoggedOut = fn; };

export async function api<T = any>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path.startsWith("/admin")) { onLoggedOut(); throw new AuthError("Please log in again."); }
  if (!r.ok) {
    const msg = j.error === "rate_limited" ? "Too many tries. Wait a little and try again."
      : j.message ?? (Array.isArray(j.issues) ? j.issues.join("; ") : j.error ?? "Something went wrong.");
    throw new Error(msg);
  }
  return j as T;
}

export const when = (t?: number | null) => (t ? new Date(t * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");
export const ago = (t?: number | null) => {
  if (!t) return "—";
  const s = Math.round(Date.now() / 1000 - t);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
export const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);
