"use strict";
/* VBot SPA: Cognito hosted login (OAuth code + PKCE), chat over SSE, workspace, sandbox, agent, images, cost. */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const usd = (n, d = 4) => "$" + Number(n || 0).toLocaleString("en-US", {minimumFractionDigits: Math.min(2, d), maximumFractionDigits: d});
const num = n => Number(n || 0).toLocaleString("vi-VN");
const ss = {get: k => { try { return sessionStorage.getItem(k); } catch { return null; } },
            set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
            del: k => { try { sessionStorage.removeItem(k); } catch {} }};
let CFG = null, TOKEN = null, CONV = null;

/* ---------------- auth ---------------- */
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function login() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  ss.set("pkce", verifier); ss.set("state", state);
  const q = new URLSearchParams({response_type: "code", client_id: CFG.client_id, redirect_uri: location.origin + "/",
    scope: "openid email profile", code_challenge_method: "S256", code_challenge: challenge, state});
  location.href = `https://${CFG.cognito_domain}/oauth2/authorize?${q}`;
}
async function handleCallback() {
  const p = new URLSearchParams(location.search);
  if (!p.get("code")) return;
  if (p.get("state") !== ss.get("state")) { alertBanner("Phiên đăng nhập không hợp lệ, thử lại.", true); return; }
  const body = new URLSearchParams({grant_type: "authorization_code", client_id: CFG.client_id, code: p.get("code"),
    redirect_uri: location.origin + "/", code_verifier: ss.get("pkce")});
  const r = await fetch(`https://${CFG.cognito_domain}/oauth2/token`, {method: "POST", body,
    headers: {"Content-Type": "application/x-www-form-urlencoded"}});
  if (r.ok) { const t = await r.json(); ss.set("id_token", t.id_token); }
  history.replaceState(null, "", "/#/chat");
}
function logout() {
  ss.del("id_token");
  location.href = `https://${CFG.cognito_domain}/logout?client_id=${CFG.client_id}&logout_uri=${encodeURIComponent(location.origin + "/")}`;
}
function tokenValid(t) {
  try { return JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).exp * 1000 > Date.now() + 30000; }
  catch { return false; }
}
async function api(path, opts = {}) {
  const r = await fetch(path, {...opts, headers: {"Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...(opts.headers || {})}});
  if (r.status === 401) { ss.del("id_token"); location.reload(); }
  const data = r.headers.get("content-type")?.includes("json") ? JSON.parse(await r.text()) : await r.text();
  if (!r.ok) throw new Error(data?.detail || data || r.statusText);
  return data;
}

/* ---------------- routing ---------------- */
function show(tab) {
  document.querySelectorAll(".tab").forEach(s => s.classList.toggle("hidden", s.id !== "tab-" + tab));
  document.querySelectorAll(".tabs a").forEach(a => a.classList.toggle("on", a.dataset.tab === tab));
  ({files: loadFiles, sandbox: loadSbFiles, agent: loadRuns, usage: loadUsage, "minh-bach": loadTransparency})[tab]?.();
}
function route() {
  const tab = (location.hash.match(/#\/([\w-]+)/) || [])[1] || "chat";
  document.body.classList.toggle("anon", !TOKEN);
  if (!TOKEN && tab !== "minh-bach") { $("#login").classList.remove("hidden"); $("#app").classList.add("hidden"); return; }
  $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
  show(tab);
}
function alertBanner(msg, err) { const b = $("#banner"); b.textContent = msg; b.className = "banner" + (err ? " err" : ""); }

/* ---------------- chat ---------------- */
async function loadConvs() {
  const rows = await api("/api/conversations");
  $("#convList").innerHTML = rows.map(c => `<li data-id="${c.id}" class="${c.id === CONV ? "on" : ""}" title="${esc(c.title)}">${esc(c.title)}</li>`).join("");
}
function metaHtml(m) {
  const p = [];
  if (m.tier_label) p.push(`<span class="pill">${esc(m.tier_label)}</span>`);
  if (m.model) p.push(`<span class="pill">${esc(m.model)}</span>`);
  if (m.input_tokens != null) p.push(`<span class="pill">${num(m.input_tokens)} vào · ${num(m.output_tokens)} ra${m.cache_read ? " · cache " + num(m.cache_read) : ""}</span>`);
  if (m.usd != null) p.push(`<span class="pill money">${usd(m.usd, 6)}</span>`);
  if (m.ttft_s) p.push(`<span class="pill ok">TTFT ${m.ttft_s}s</span>`);
  (m.sources || []).forEach(s => p.push(`<span class="pill">📄 ${esc(s)}</span>`));
  (m.quarantined || []).forEach(q => p.push(`<span class="pill warn" title="${esc((q.why || []).join(", "))}">⚠ đã loại: ${esc(q.title)}</span>`));
  return p.join("");
}
const EMPTY = $("#emptyChat");
function resetChat() { $("#messages").innerHTML = ""; $("#messages").appendChild(EMPTY); EMPTY.classList.remove("hidden"); }
function addMsg(role, text, meta) {
  EMPTY.classList.add("hidden");
  const el = document.createElement("div");
  el.className = "msg " + role;
  el.innerHTML = `<div class="body">${esc(text)}</div>${role === "assistant" ? `<div class="meta">${metaHtml(meta || {})}</div>` : ""}`;
  $("#messages").appendChild(el); $("#messages").scrollTop = 1e9;
  return el;
}
async function openConv(id) {
  CONV = id; resetChat();
  const rows = await api(`/api/conversations/${id}`);
  rows.forEach(m => addMsg(m.role, m.content, {model: m.model, input_tokens: m.input_tokens, output_tokens: m.output_tokens,
    usd: m.cost_usd != null ? Number(m.cost_usd) : null}));
  loadConvs();
}
async function send(e) {
  e.preventDefault();
  const text = $("#prompt").value.trim(); if (!text) return;
  $("#prompt").value = ""; $("#btnSend").disabled = true; $("#banner").classList.add("hidden");
  addMsg("user", text);
  const bubble = addMsg("assistant", "…", {}); const body = bubble.querySelector(".body"); const metaEl = bubble.querySelector(".meta");
  let meta = {}, acc = "";
  try {
    const r = await fetch("/api/chat", {method: "POST", headers: {"Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`},
      body: JSON.stringify({message: text, conversation_id: CONV, mode: $("#mode").value || null, use_rag: $("#useRag").checked})});
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.detail || r.statusText); }
    const reader = r.body.getReader(), dec = new TextDecoder(); let buf = "";
    for (;;) {
      const {value, done} = await reader.read(); if (done) break;
      buf += dec.decode(value, {stream: true});
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = (block.match(/^event: (.*)$/m) || [])[1], data = JSON.parse((block.match(/^data: (.*)$/m) || [])[1] || "{}");
        if (ev === "meta") { meta = {...meta, ...data}; CONV = data.conversation_id; }
        if (ev === "delta") { acc += data.text; body.textContent = acc; $("#messages").scrollTop = 1e9; }
        if (ev === "usage") meta = {...meta, ...data};
        if (ev === "error") { body.textContent = acc || "—"; alertBanner(`${data.message}${data.hint ? " · " + data.hint : ""}`, true); }
        metaEl.innerHTML = metaHtml(meta);
      }
    }
  } catch (err) { body.textContent = "—"; alertBanner(err.message, true); }
  $("#btnSend").disabled = false; loadConvs();
}

/* ---------------- files ---------------- */
async function loadFiles() {
  const rows = await api("/api/files");
  $("#fileRows").innerHTML = rows.map(f => `<tr><td>${esc(f.title)}</td><td>${esc(f.source)}</td><td class="n">${f.chunks}</td>
    <td>${esc(String(f.created_at).slice(0, 16))}</td><td><button class="btn sm" data-dl="${f.id}">Tải</button>
    <button class="btn sm danger" data-del="${f.id}">Xóa</button></td></tr>`).join("") || `<tr><td colspan="5" class="muted">Chưa có file.</td></tr>`;
}
async function upload(files) {
  for (const f of files) {
    const u = await api("/api/files/upload-url", {method: "POST", body: JSON.stringify({name: f.name, size: f.size, content_type: f.type || "application/octet-stream"})});
    const put = await fetch(u.url, {method: "PUT", body: f, headers: u.headers});
    if (!put.ok) { alert("Upload lỗi: " + f.name); continue; }
    await api(`/api/files/${u.document_id}/ingest`, {method: "POST"});
  }
  loadFiles();
}

/* ---------------- sandbox ---------------- */
async function loadSbFiles() {
  const rows = await api("/api/files");
  $("#sbFiles").innerHTML = rows.map(f => `<option value="${f.id}">${esc(f.title)}</option>`).join("");
}
async function runSandbox() {
  $("#btnRun").disabled = true; $("#sbOut").textContent = "Đang chạy…";
  try {
    const ids = [...$("#sbFiles").selectedOptions].map(o => o.value);
    const r = await api("/api/sandbox/run", {method: "POST", body: JSON.stringify({code: $("#sbCode").value, file_ids: ids})});
    if (r.error) throw new Error(r.error);
    $("#sbOut").textContent = `exit ${r.exit_code} · ${r.seconds}s · ${usd(r.usd, 6)}\n\n${r.stdout}${r.stderr ? "\n--- stderr ---\n" + r.stderr : ""}` +
      (r.files.length ? `\n\nĐã lưu vào workspace: ${r.files.map(f => f.name).join(", ")}` : "");
  } catch (e) { $("#sbOut").textContent = e.message; }
  $("#btnRun").disabled = false;
}

/* ---------------- agent ---------------- */
const ST = {planning: "warn", planned: "warn", awaiting_confirmation: "money", running: "warn", done: "ok", rejected: "err", failed: "err"};
async function loadRuns() {
  const rows = await api("/api/agent");
  $("#agRuns").innerHTML = rows.map(r => {
    const plan = typeof r.plan === "string" ? JSON.parse(r.plan || "null") : r.plan;
    return `<div class="card"><h3>${esc(r.goal)}</h3><div><span class="pill ${ST[r.status] || ""}">${esc(r.status)}</span>
      <span class="pill money">${usd(r.cost_usd, 5)}</span></div>
      ${plan ? `<div>${esc(plan.summary || "")}</div><ol>${(plan.actions || []).map(a => `<li><b>${esc(a.type)}</b>: ${esc(a.title)}</li>`).join("")}</ol>` : ""}
      ${plan?.injection_flags?.length ? `<div class="pill warn">⚠ phát hiện dấu hiệu chèn lệnh: ${esc(plan.injection_flags.join(", "))}</div>` : ""}
      ${r.status === "awaiting_confirmation" ? `<div class="row"><button class="btn pri" data-ok="${r.id}">Xác nhận chạy</button><button class="btn danger" data-no="${r.id}">Từ chối</button></div>` : ""}
      ${r.result ? `<div class="muted">${esc(r.result)}</div>` : ""}</div>`;
  }).join("") || `<p class="muted">Chưa có tác vụ.</p>`;
  if (rows.some(r => ["planning", "planned", "running"].includes(r.status)) && location.hash.includes("agent")) setTimeout(loadRuns, 3000);
}

/* ---------------- usage + transparency ---------------- */
async function loadUsage() {
  const d = await api("/api/usage"), s = d.summary, q = d.quota;
  $("#usageBox").innerHTML = `<div class="kpis"><div class="kpi"><b>${usd(s.usd, 4)}</b><span>30 ngày qua</span></div>
    <div class="kpi"><b>${num(s.requests)}</b><span>request</span></div>
    <div class="kpi"><b>${usd(q.user_today_usd)} / ${usd(q.user_cap_usd, 2)}</b><span>hạn mức hôm nay</span></div>
    <div class="kpi"><b>${usd(q.unit_month_usd)} / ${usd(q.unit_cap_usd, 0)}</b><span>ngân sách đơn vị tháng</span></div></div>
    <table class="tbl" style="margin-top:12px"><thead><tr><th>Model/dịch vụ</th><th>Request</th><th>Token vào</th><th>Token ra</th><th>USD</th></tr></thead><tbody>
    ${Object.entries(s.by_model).map(([m, b]) => `<tr><td>${esc(m)}</td><td class="n">${num(b.requests)}</td><td class="n">${num(b.input_tokens)}</td><td class="n">${num(b.output_tokens)}</td><td class="n">${usd(b.usd, 6)}</td></tr>`).join("")}
    </tbody></table>`;
}
function bars(obj, total) {
  const e = Object.entries(obj).sort((a, b) => b[1] - a[1]); const mx = e[0]?.[1] || 1;
  return e.map(([k, v]) => `<div class="bar"><span>${esc(k)}</span><span class="t"><i style="width:${(v / mx * 100).toFixed(1)}%"></i></span><span class="v">${usd(v, 2)}${total ? " · " + (v / total * 100).toFixed(1) + "%" : ""}</span></div>`).join("");
}
async function loadTransparency() {
  const d = await (await fetch("/api/transparency")).json(), q = d.quote, m = d.mvp;
  $("#tpBox").innerHTML = `
  <div class="kpis"><div class="kpi"><b>${usd(q.total_usd_month, 0)}</b><span>báo giá 2.000 DAU / tháng</span></div>
   <div class="kpi"><b>${usd(q.usd_per_dau, 2)}</b><span>mỗi DAU / tháng</span></div>
   <div class="kpi"><b>${num(q.requests_month)}</b><span>request / tháng</span></div>
   <div class="kpi"><b>${m.total != null ? usd(m.total, 2) : "—"}</b><span>chi phí thật MVP tháng này</span></div></div>
  <div class="card"><h3>Báo giá theo component (giá niêm yết us-east-1, ${esc(q.prices_fetched_at?.slice(0, 10))})</h3>${bars(q.by_component, q.total_usd_month)}</div>
  <div class="card"><h3>Đòn bẩy tiết kiệm (tính lại bằng cùng mô hình)</h3><table class="tbl"><thead><tr><th>Đòn bẩy</th><th>Nếu không làm</th><th>Tiết kiệm/tháng</th></tr></thead><tbody>
   ${q.levers.map(l => `<tr><td>${esc(l.lever)}</td><td>${esc(l.how)}</td><td class="n">${usd(l.saving, 0)}</td></tr>`).join("")}</tbody></table></div>
  <div class="card"><h3>Chi phí thật của MVP theo tag component</h3>${m.error ? `<p class="muted">${esc(m.error)}</p>` : bars(m.by_component, m.total) + `<p class="muted small">${esc(m.note)} · ${esc(m.period)}</p>`}</div>
  <div class="card"><h3>Giả định tải</h3><table class="tbl"><tbody>${q.sizing.map(s => `<tr><td>${esc(s.metric)}</td><td class="n">${typeof s.value === "number" ? num(Math.round(s.value * 100) / 100) : esc(s.value)}</td><td class="muted">${esc(s.formula)}</td></tr>`).join("")}</tbody></table></div>
  <div class="card"><h3>Từng dòng báo giá</h3><table class="tbl"><thead><tr><th>Component</th><th>Hạng mục</th><th>USD</th></tr></thead><tbody>
   ${q.lines.map(l => `<tr><td class="mono">${esc(l.component)}</td><td>${esc(l.y_nghia)}<div class="muted small">${esc(l.ghi_chu)}</div></td><td class="n">${usd(l.chi_phi, 2)}</td></tr>`).join("")}</tbody></table></div>`;
}

/* ---------------- boot ---------------- */
async function boot() {
  CFG = await (await fetch("/api/config")).json();
  $("#envName").textContent = (CFG.env || "").toUpperCase();
  await handleCallback();
  const t = ss.get("id_token");
  TOKEN = t && tokenValid(t) ? t : null;
  route();
  if (TOKEN) {
    api("/api/me").then(me => { $("#meEmail").textContent = me.email; }).catch(e => alertBanner(e.message, true));
    loadConvs().catch(() => {});
  }
}
window.addEventListener("hashchange", route);
$("#btnLogin").onclick = login;
$("#btnLogout").onclick = logout;
$("#btnNew").onclick = () => { CONV = null; resetChat(); location.hash = "#/chat"; loadConvs(); };
document.querySelector(".chips").onclick = e => { const q = e.target.dataset.q; if (q) { $("#prompt").value = q; $("#prompt").focus(); } };
$("#convList").onclick = e => { const id = e.target.dataset.id; if (id) { location.hash = "#/chat"; openConv(id); } };
$("#chatForm").onsubmit = send;
$("#prompt").onkeydown = e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#chatForm").requestSubmit(); } };
$("#fileInput").onchange = e => upload([...e.target.files]);
const drop = $("#drop");
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => upload([...e.dataTransfer.files]));
$("#fileRows").onclick = async e => {
  if (e.target.dataset.dl) { const r = await api(`/api/files/${e.target.dataset.dl}/download-url`); location.href = r.url; }
  if (e.target.dataset.del && confirm("Xóa file này?")) { await api(`/api/files/${e.target.dataset.del}`, {method: "DELETE"}); loadFiles(); }
};
$("#btnRun").onclick = runSandbox;
$("#btnAgent").onclick = async () => {
  const goal = $("#agGoal").value.trim(); if (!goal) return;
  try { await api("/api/agent", {method: "POST", body: JSON.stringify({goal})}); $("#agGoal").value = ""; loadRuns(); } catch (e) { alert(e.message); }
};
$("#agRuns").onclick = async e => {
  const id = e.target.dataset.ok || e.target.dataset.no; if (!id) return;
  await api(`/api/agent/${id}/decision`, {method: "POST", body: JSON.stringify({approve: !!e.target.dataset.ok})}); loadRuns();
};
$("#btnImg").onclick = async () => {
  $("#btnImg").disabled = true; $("#imgOut").textContent = "Đang tạo…";
  try { const r = await api("/api/images", {method: "POST", body: JSON.stringify({prompt: $("#imgPrompt").value})});
    $("#imgOut").innerHTML = `<p class="muted">${esc(r.model)} · ${usd(r.usd, 3)} · đã lưu vào workspace</p><img class="gen" src="data:image/png;base64,${r.b64}" alt="">`;
  } catch (e) { $("#imgOut").textContent = e.message; }
  $("#btnImg").disabled = false;
};
boot();
