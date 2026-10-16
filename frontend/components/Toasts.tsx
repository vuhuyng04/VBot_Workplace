"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { setNotifier } from "@/lib/api";
import { Icon } from "./Icon";

type Kind = "info" | "ok" | "err";
type Item = { id: number; msg: string; kind: Kind; out?: boolean };
export type ToastFn = (msg: string, kind?: Kind, ms?: number) => void;

const Ctx = createContext<ToastFn>(() => {});
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const seq = useRef(0);
  const remove = useCallback((id: number) => setItems(xs => xs.filter(x => x.id !== id)), []);
  const toast = useCallback<ToastFn>((msg, kind = "info", ms = 4200) => {
    const id = ++seq.current;
    setItems(xs => [...xs.slice(-3), { id, msg, kind }]);
    setTimeout(() => setItems(xs => xs.map(x => (x.id === id ? { ...x, out: true } : x))), ms);
    setTimeout(() => remove(id), ms + 350);
  }, [remove]);
  useEffect(() => setNotifier(toast), [toast]);

  return (
    <Ctx.Provider value={toast}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map(t => (
          <div key={t.id} className={`toast ${t.kind}${t.out ? " out" : ""}`} role={t.kind === "err" ? "alert" : "status"}>
            <Icon name={t.kind === "err" ? "alert" : t.kind === "ok" ? "check" : "spark"} />
            <span>{t.msg}</span>
            <button type="button" aria-label="Đóng" onClick={() => remove(t.id)}><Icon name="x" /></button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
