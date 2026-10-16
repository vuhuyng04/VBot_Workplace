import type { Page, Route } from "@playwright/test";

/* A fake VBot API for UI tests. Everything the page fetches under /api is answered here. */
export type Calls = { method: string; path: string; body?: unknown }[];
type Role = "user" | "unit_admin" | "platform_admin";

const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const sse = (events: [string, unknown][]) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");

export const ADMIN_USERS = [
  { id: "u-root", sub: "u-root", email: "root@cty.vn", department: "it", role: "platform_admin", status: "CONFIRMED", enabled: true, created_at: now() },
  { id: "u-kt", sub: "u-kt", email: "nv.kt@cty.vn", department: "ke-toan", role: "user", status: "FORCE_CHANGE_PASSWORD", enabled: true, created_at: now() },
];

export async function mockApi(page: Page, opts: { signedIn?: boolean; role?: Role } = {}): Promise<Calls> {
  const calls: Calls = [];
  const role = opts.role || "user";
  if (opts.signedIn !== false) {
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
    await page.addInitScript(t => { try { sessionStorage.setItem("id_token", t); } catch { /* about:blank */ } }, `x.${payload}.y`);
  }
  await page.route("**/api/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname, method = req.method();
    calls.push({ method, path, body: req.postDataJSON?.() ?? undefined });
    const is = (m: string, p: string | RegExp) => method === m && (typeof p === "string" ? path === p : p.test(path));
    if (is("GET", "/api/config")) return json(route, { client_id: "c", cognito_domain: "auth.example.com", env: "test" });
    if (is("GET", "/api/me")) return json(route, { email: "an@cty.vn", department: "ke-toan", groups: role === "user" ? ["user"] : ["user", role] });
    if (is("GET", "/api/conversations")) return json(route, [{ id: "c1", title: "Báo cáo quý 3", updated_at: now() }]);
    if (is("GET", "/api/conversations/c1")) return json(route, [
      { role: "user", content: "Tính tổng" },
      { role: "assistant", content: "Kết quả:\n\n| Tháng | Doanh thu |\n|---|---|\n| T1 | 120 |\n\n<script>window.__xss=1</script>", model: "Claude Haiku 5.5", input_tokens: 10, output_tokens: 5, cost_usd: 0.001 },
    ]);
    if (is("DELETE", /^\/api\/conversations\//)) return json(route, { ok: true });
    if (is("POST", "/api/chat")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: sse([
      ["meta", { conversation_id: "c2", tier_label: "Cấp 1 · Hỏi đáp", model: "Claude Haiku 5.5", sources: ["ke_hoach.docx"], quarantined: [] }],
      ["delta", { text: "Xin chào, " }], ["delta", { text: "đây là **câu trả lời**." }],
      ["usage", { provider: "Amazon Bedrock", input_tokens: 8, output_tokens: 6, usd: 0.0004, ttft_s: 0.9 }], ["done", {}]]) });
    if (is("GET", "/api/files")) return json(route, [{ id: "f1", title: "ke_hoach.docx", source: "upload", created_at: now(), chunks: 12 }]);
    if (is("GET", "/api/agent")) return json(route, []);
    if (is("GET", "/api/usage")) return json(route, { summary: { usd: 0.12, requests: 3, by_model: {} },
      quota: { user_today_usd: 0.1, user_cap_usd: 2, unit_month_usd: 5, unit_cap_usd: 500 } });
    if (is("GET", "/api/transparency")) return json(route, { quote: { total_usd_month: 12610, usd_per_dau: 6.31, requests_month: 900000,
      prices_fetched_at: "2026-10-01", by_component: { llm: 9000, ops: 2500 }, levers: [], sizing: [], lines: [] }, mvp: { total: 3.2, by_component: { authn: 1 } } });
    if (path.startsWith("/api/admin/")) {
      if (role === "user") return json(route, { detail: "Chỉ quản trị viên mới truy cập được trang này." }, 403);
      if (is("GET", "/api/admin/users")) return json(route, { role, scope: role === "platform_admin" ? null : "ke-toan", me: "u-root", users: ADMIN_USERS });
      if (is("GET", "/api/admin/departments")) return json(route, { month: "2026-10", default_cap_usd: 500, daily_user_cap_usd: 2,
        departments: [{ name: "it", users: 1, month_usd: 1, cap_usd: 500, custom_cap: false }, { name: "ke-toan", users: 1, month_usd: 90, cap_usd: 100, custom_cap: true }] });
      if (is("POST", "/api/admin/users")) return json(route, { id: "u-new", email: "moi@cty.vn", department: "ke-toan", role: "user" }, 201);
      if (is("PATCH", /^\/api\/admin\/users\//)) return json(route, { id: "x", changed: { enabled: false } });
      if (is("GET", "/api/admin/audit")) return json(route, { date: "2026-10-16", total: 1, records: [
        { ts: new Date().toISOString(), user_id: "u-root", email: "root@cty.vn", action: "admin.user.update", target: "u-kt", changes: { enabled: false } }] });
    }
    return json(route, { detail: `unmocked ${method} ${path}` }, 404);
  });
  return calls;
}
