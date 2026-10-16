export const usd = (n: number | null | undefined, d = 4) =>
  "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: Math.min(2, d), maximumFractionDigits: d });
export const num = (n: number | null | undefined) => Number(n || 0).toLocaleString("vi-VN");

/** Postgres timestamps arrive as "2026-10-16 08:00:00" (UTC, no zone); treat them as UTC. */
export function toDate(d: string): Date {
  const s = String(d).replace(" ", "T");
  return new Date(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z");
}
export function rel(d: string): string {
  const s = (Date.now() - toDate(d).getTime()) / 1000;
  if (s < 60) return "vừa xong";
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  return `${Math.floor(s / 86400)} ngày trước`;
}
export const ext = (n: string) => (String(n).split(".").pop() || "").toLowerCase();
