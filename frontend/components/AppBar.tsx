"use client";
import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";
import { LogoMark, Wordmark } from "./Logo";

export type Tab = "chat" | "files" | "sandbox" | "agent" | "image" | "usage" | "admin" | "minh-bach";
export const USER_TABS: [Tab, IconName, string][] = [
  ["chat", "chat", "Chat"], ["files", "folder", "Workspace"], ["sandbox", "code", "Sandbox"],
  ["agent", "agent", "Agent"], ["image", "image", "Thiết kế"], ["usage", "chart", "Chi phí"],
];
export type Me = { email: string; department?: string; groups?: string[] };
export const isAdmin = (me: Me | null) => !!me?.groups?.some(g => g === "platform_admin" || g === "unit_admin");

export function AppBar({ tab, signedIn, env, me, onLogout }: {
  tab: Tab; signedIn: boolean; env: string; me: Me | null; onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", click); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", click); document.removeEventListener("keydown", key); };
  }, [open]);
  useEffect(() => setOpen(false), [tab]);

  return (
    <header className="appbar">
      <div className="appbar-in">
        <a href="#/chat" className="brand" aria-label="VBot Workplace, về trang chat">
          <LogoMark size={30} className="mark" />
          <Wordmark />
          {env && <span className="env-badge">{env.toUpperCase()}</span>}
        </a>
        {signedIn && (
          <nav className="tabs" aria-label="Chức năng">
            {[...USER_TABS, ...(isAdmin(me) ? [["admin", "shield", "Quản trị"] as (typeof USER_TABS)[number]] : [])].map(([id, icon, label]) => (
              <a key={id} href={`#/${id}`} className={tab === id ? "on" : undefined} aria-current={tab === id ? "page" : undefined}>
                <Icon name={icon} /><span>{label}</span>
              </a>
            ))}
          </nav>
        )}
        <div className="appbar-right">
          <a href="#/minh-bach" className={`btn ghost sm hide-sm${tab === "minh-bach" ? " on" : ""}`}><Icon name="layers" />Kiến trúc &amp; chi phí</a>
          {signedIn && (
            <div className="user" ref={box}>
              <button className="avatar-btn" type="button" aria-haspopup="menu" aria-expanded={open} aria-label="Tài khoản" onClick={() => setOpen(o => !o)}>
                {me?.email?.[0] || "·"}
              </button>
              {open && (
                <div className="menu" role="menu">
                  <div className="menu-head"><b>{me?.email || "—"}</b>{me?.department && <span className="muted small">Phòng ban: {me.department}</span>}</div>
                  <a href="#/usage" role="menuitem"><Icon name="chart" />Chi phí của tôi</a>
                  {isAdmin(me) && <a href="#/admin" role="menuitem"><Icon name="shield" />Quản trị</a>}
                  <a href="#/minh-bach" role="menuitem"><Icon name="layers" />Kiến trúc &amp; chi phí</a>
                  <button type="button" role="menuitem" onClick={onLogout}><Icon name="logout" />Đăng xuất</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
