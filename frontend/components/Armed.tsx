"use client";
import { useEffect, useState, type ReactNode } from "react";

/** Destructive action without a modal: the first click arms the button, a second click within 3 s runs it. */
export function Armed({ onConfirm, className, label, children }: {
  onConfirm: () => void; className?: string; label: string; children: ReactNode;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button type="button" className={className} data-armed={armed ? "1" : undefined}
      aria-label={armed ? `Xác nhận ${label.toLowerCase()}` : label} title={armed ? "Bấm lần nữa để xác nhận" : label}
      onClick={e => { e.stopPropagation(); if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>
      {armed ? "Xác nhận?" : children}
    </button>
  );
}
