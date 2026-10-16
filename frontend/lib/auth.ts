/* Cognito hosted UI: OAuth authorization code + PKCE. The id_token lives in sessionStorage only. */
export type Config = { client_id: string; cognito_domain: string; env?: string };

export const ss = {
  get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } },
  del: (k: string) => { try { sessionStorage.removeItem(k); } catch { /* private mode */ } },
};

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const redirectUri = () => location.origin + "/";

export async function login(cfg: Config) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  ss.set("pkce", verifier); ss.set("state", state);
  const q = new URLSearchParams({ response_type: "code", client_id: cfg.client_id, redirect_uri: redirectUri(),
    scope: "openid email profile", code_challenge_method: "S256", code_challenge: challenge, state });
  location.href = `https://${cfg.cognito_domain}/oauth2/authorize?${q}`;
}

/** Exchanges ?code= for tokens. Returns an error message, or null when there was nothing to do or it worked. */
export async function handleCallback(cfg: Config): Promise<string | null> {
  const p = new URLSearchParams(location.search);
  if (!p.get("code")) return null;
  if (p.get("state") !== ss.get("state")) { history.replaceState(null, "", "/"); return "Phiên đăng nhập không hợp lệ, vui lòng thử lại."; }
  const body = new URLSearchParams({ grant_type: "authorization_code", client_id: cfg.client_id, code: p.get("code")!,
    redirect_uri: redirectUri(), code_verifier: ss.get("pkce") || "" });
  let err: string | null = null;
  try {
    const r = await fetch(`https://${cfg.cognito_domain}/oauth2/token`, { method: "POST", body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    if (r.ok) ss.set("id_token", (await r.json()).id_token); else err = "Không lấy được phiên đăng nhập.";
  } catch { err = "Không lấy được phiên đăng nhập."; }
  ss.del("pkce"); ss.del("state");
  history.replaceState(null, "", "/#/chat");
  return err;
}

export function logout(cfg: Config) {
  ss.del("id_token");
  location.href = `https://${cfg.cognito_domain}/logout?client_id=${cfg.client_id}&logout_uri=${encodeURIComponent(redirectUri())}`;
}

export function validToken(): string | null {
  const t = ss.get("id_token");
  if (!t) return null;
  try {
    const exp = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).exp;
    return exp * 1000 > Date.now() + 30000 ? t : null;
  } catch { return null; }
}
