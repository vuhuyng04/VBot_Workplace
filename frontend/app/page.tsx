"use client";
/* VBot SPA: one statically exported page with hash routing (#/chat, #/files, ...), so the Cognito
   redirect_uri stays origin + "/" and FastAPI only has to serve index.html and /_next. */
import { useEffect, useState } from "react";
import { api, errMsg, setToken } from "@/lib/api";
import { handleCallback, login, logout, validToken, type Config } from "@/lib/auth";
import { AppBar, USER_TABS, isAdmin, type Me, type Tab } from "@/components/AppBar";
import { Hero } from "@/components/Hero";
import { ToastProvider, useToast } from "@/components/Toasts";
import { Admin } from "@/views/Admin";
import { Agent } from "@/views/Agent";
import { Chat } from "@/views/Chat";
import { Files } from "@/views/Files";
import { Images } from "@/views/Images";
import { Sandbox } from "@/views/Sandbox";
import { Transparency } from "@/views/Transparency";
import { UsageView } from "@/views/Usage";

const TABS = new Set<string>([...USER_TABS.map(t => t[0]), "admin", "minh-bach"]);
const readTab = (): Tab => { const t = (location.hash.match(/#\/([\w-]+)/) || [])[1] || "chat"; return (TABS.has(t) ? t : "chat") as Tab; };

function Shell() {
  const toast = useToast();
  const [cfg, setCfg] = useState<Config | null>(null);
  const [token, setTok] = useState<string | null | undefined>(undefined);   // undefined while booting
  const [tab, setTab] = useState<Tab>("chat");
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    const onHash = () => setTab(readTab());
    onHash();
    window.addEventListener("hashchange", onHash);
    (async () => {
      let c: Config;
      try { c = await (await fetch("/api/config")).json(); } catch { toast("Không kết nối được máy chủ.", "err"); setTok(null); return; }
      setCfg(c);
      const err = await handleCallback(c);
      if (err) toast(err, "err");
      onHash();
      const t = validToken();
      setToken(t); setTok(t);
      if (t) api<Me>("/api/me").then(setMe).catch(e => toast(errMsg(e), "err"));
    })();
    return () => window.removeEventListener("hashchange", onHash);
  }, [toast]);

  const signedIn = !!token;
  useEffect(() => { document.body.classList.toggle("anon", !signedIn); }, [signedIn]);

  const booting = token === undefined;
  const showHero = !booting && !signedIn && tab !== "minh-bach";

  return (
    <>
      <AppBar tab={tab} signedIn={signedIn} env={cfg?.env || ""} me={me} onLogout={() => cfg && logout(cfg)} />
      {showHero && <Hero ready={!!cfg} onLogin={() => cfg && login(cfg)} />}
      {booting && <main id="app"><div className="page"><section className="tab"><div className="skeleton" /><div className="skeleton short" /></section></div></main>}
      {!booting && !showHero && (
        <main id="app">
          {signedIn && <Chat active={tab === "chat"} />}
          <div className="page">
            {signedIn && <>
              <Files active={tab === "files"} />
              <Sandbox active={tab === "sandbox"} />
              <Agent active={tab === "agent"} />
              <Images active={tab === "image"} />
              <UsageView active={tab === "usage"} />
              <Admin active={tab === "admin"} />
            </>}
            <Transparency active={tab === "minh-bach"} />
          </div>
        </main>
      )}
      <footer className="foot">
        <div className="foot-in"><span><b>VBot</b> Workplace · Production Capstone · AI20k Track 2</span><span>Dữ liệu ở us-east-1 · không dùng để huấn luyện model</span></div>
      </footer>
    </>
  );
}

export default function Page() {
  return <ToastProvider><Shell /></ToastProvider>;
}
