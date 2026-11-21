import { useEffect, useState } from "react";
import { Icon } from "../ui/components";
import { api, setLoggedOutHandler } from "./api";
import { Login } from "./Login";
import { SheetProvider, ToastProvider } from "./ui";
import { Overview } from "./screens/Overview";
import { Apps } from "./screens/Apps";
import { Logs } from "./screens/Logs";
import { Providers } from "./screens/Providers";
import { Blocklist } from "./screens/Blocklist";
import { Fixes } from "./screens/Fixes";
import { Assistant } from "./screens/Assistant";
import { Settings } from "./screens/Settings";

const TABS = [
  { id: "overview", label: "Overview", icon: "chart", Screen: Overview },
  { id: "fixes", label: "Fixes", icon: "wrench", Screen: Fixes },
  { id: "assistant", label: "Assistant", icon: "sparkle", Screen: Assistant },
  { id: "apps", label: "Apps & Keys", icon: "apps", Screen: Apps },
  { id: "logs", label: "Logs", icon: "list", Screen: Logs },
  { id: "providers", label: "Providers", icon: "switch", Screen: Providers },
  { id: "blocklist", label: "Blocklist", icon: "block", Screen: Blocklist },
  { id: "settings", label: "Settings", icon: "gear", Screen: Settings },
] as const;
type TabId = (typeof TABS)[number]["id"];
const PHONE_TABS: TabId[] = ["overview", "fixes", "assistant", "apps", "settings"];

const fromHash = (): TabId => {
  const h = location.hash.slice(1);
  return (TABS.find((t) => t.id === h)?.id ?? "overview") as TabId;
};

export function App() {
  const [auth, setAuth] = useState<"checking" | "in" | "out">("checking");
  const [tab, setTab] = useState<TabId>(fromHash);
  const [openFixes, setOpenFixes] = useState(0);

  useEffect(() => {
    setLoggedOutHandler(() => setAuth("out"));
    api("GET", "/admin/fixes").then((r) => { setAuth("in"); setOpenFixes(r.fixes.length); }).catch(() => setAuth("out"));
    const onHash = () => setTab(fromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (auth === "checking") return <div className="splash"><img src="/favicon.svg" alt="" width={48} height={48} /></div>;
  if (auth === "out") return <Login onDone={() => setAuth("in")} />;

  const go = (id: TabId) => { location.hash = id; setTab(id); window.scrollTo({ top: 0 }); };
  const Current = TABS.find((t) => t.id === tab)!.Screen;

  return (
    <ToastProvider>
      <SheetProvider>
        <div className="shell">
          <aside className="sidebar" aria-label="Sections">
            <div className="side-brand"><img src="/favicon.svg" alt="" width={26} height={26} /><div><b>Klausum OTP</b><span className="small muted">Control Room</span></div></div>
            <nav>
              {TABS.map((t) => (
                <button key={t.id} className={`side-item ${tab === t.id ? "active" : ""}`} onClick={() => go(t.id)} aria-current={tab === t.id ? "page" : undefined}>
                  <Icon name={t.icon} size={19} /><span>{t.label}</span>
                  {t.id === "fixes" && openFixes > 0 && <span className="count">{openFixes}</span>}
                </button>
              ))}
            </nav>
            <div className="side-foot">
              <a className="side-item" href="https://status.klausum.study" target="_blank" rel="noreferrer"><Icon name="globe" size={19} /><span>Status page</span></a>
              <button className="side-item" onClick={async () => { await api("POST", "/auth/admin/logout").catch(() => {}); setAuth("out"); }}><Icon name="logout" size={19} /><span>Log out</span></button>
            </div>
          </aside>

          <main className="content" key={tab}>
            <Current onFixesChanged={setOpenFixes} go={go} />
          </main>

          <nav className="tabbar glass" aria-label="Sections">
            {PHONE_TABS.map((id) => {
              const t = TABS.find((x) => x.id === id)!;
              return (
                <button key={id} className={tab === id ? "active" : ""} onClick={() => go(id)} aria-current={tab === id ? "page" : undefined}>
                  <span className="tab-icon"><Icon name={t.icon} size={23} />{id === "fixes" && openFixes > 0 && <span className="dotbadge" />}</span>
                  <span>{t.label.split(" ")[0]}</span>
                </button>
              );
            })}
          </nav>
        </div>
      </SheetProvider>
    </ToastProvider>
  );
}

export type ScreenProps = { onFixesChanged: (n: number) => void; go: (id: TabId) => void };
