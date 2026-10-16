import { ss } from "./auth";

type Notify = (msg: string, kind?: "info" | "ok" | "err", ms?: number) => void;
let notify: Notify = () => {};
let token: string | null = null;
let wakeShown = false;

export const setNotifier = (n: Notify) => { notify = n; };
export const setToken = (t: string | null) => { token = t; };
export const authHeader = (): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** fetch that waits while Aurora resumes from auto-pause (the API answers 503 + Retry-After). */
export async function fetchWake(path: string, init?: RequestInit, tries = 4): Promise<Response> {
  for (let i = 0; ; i++) {
    const r = await fetch(path, init);
    if (r.status !== 503 || i >= tries) return r;
    if (!wakeShown) {
      wakeShown = true;
      notify("Hệ thống đang khởi động lại sau thời gian nghỉ, chờ vài giây…", "info", 6000);
      setTimeout(() => (wakeShown = false), 8000);
    }
    await sleep(4000);
  }
}

export class ApiError extends Error {}

export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetchWake(path, { ...opts, headers: { "Content-Type": "application/json", ...authHeader(), ...(opts.headers || {}) } });
  if (r.status === 401) {
    ss.del("id_token");
    notify("Phiên đăng nhập đã hết hạn.", "err");
    setTimeout(() => location.reload(), 1200);
    throw new ApiError("Phiên đăng nhập đã hết hạn.");
  }
  const text = await r.text();
  const data = r.headers.get("content-type")?.includes("json") && text ? JSON.parse(text) : text;
  if (!r.ok) {
    const d = (data as { detail?: unknown })?.detail;
    throw new ApiError(typeof d === "string" ? d : d ? JSON.stringify(d) : (typeof data === "string" && data) || r.statusText);
  }
  return data as T;
}

export const post = <T = unknown>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) });
export const del = <T = unknown>(path: string) => api<T>(path, { method: "DELETE" });

export async function download(id: string) {
  try { const r = await api<{ url: string }>(`/api/files/${id}/download-url`); location.href = r.url; }
  catch (e) { notify((e as Error).message, "err"); }
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
