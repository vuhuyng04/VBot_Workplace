import { useId } from "react";

/** VBot mark: a white V on a navy tile, with a gold spark at the tip of the V (the assistant "speaking").
    Same drawing as app/icon.svg (favicon); keep the two in sync. */
export function LogoMark({ size = 30, className }: { size?: number; className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#134D8B" />
          <stop offset="1" stopColor="#002147" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${id})`} />
      <rect x=".5" y=".5" width="31" height="31" rx="8.5" fill="none" stroke="#fff" strokeOpacity=".1" />
      <path d="M9.5 10.5 16 22.5l6.5-12" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="24.2" cy="7.6" r="2.4" fill="#F9A730" />
    </svg>
  );
}

export function Wordmark() {
  return <span className="word"><b>VBot</b> <span>Workplace</span></span>;
}
