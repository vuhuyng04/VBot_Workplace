"use strict";
/* VBot SPA: Cognito hosted login (OAuth code + PKCE), chat over SSE, workspace, sandbox, agent, images, cost. */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const usd = (n, d = 4) => "$" + Number(n || 0).toLocaleString("en-US", {minimumFractionDigits: Math.min(2, d), maximumFractionDigits: d});
const num = n => Number(n || 0).toLocaleString("vi-VN");
const ss = {get: k => { try { return sessionStorage.getItem(k); } catch { return null; } },
            set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
            del: k => { try { sessionStorage.removeItem(k); } catch {} }};
let CFG = null, TOKEN = null, CONV = null, STREAM = null;

/* ---------------- toasts + inline confirm ---------------- */
function toast(msg, kind = "info", ms = 4200) {
  const t = document.createElement("div");
  t.className = "toast " + kind; t.setAttribute("role", kind === "err" ? "alert" : "status");
  t.innerHTML = `<span>${esc(msg)}</span><button type="button" aria-label="Đóng">×</button>`;
  t.querySelector("button").onclick = () => t.remove();
  $("#toasts").appendChild(t);
  setTimeout(() => t.classList.add("out"), ms); setTimeout(() => t.remove(), ms + 400);
}
/* First click arms the button ("Xác nhận?"), second click within 3 s runs the action. */
function armed(btn, action) {
  if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; action(); return; }
  btn.dataset.label = btn.textContent; btn.dataset.armed = "1"; btn.textContent = "Xác nhận?";
  setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; } }, 3000);
}
const busy = (btn, on, label) => { btn.disabled = on; if (label) { if (on) { btn.dataset.l = btn.innerHTML; btn.innerHTML = `<span class="spin"></span>${label}`; } else if (btn.dataset.l) btn.innerHTML = btn.dataset.l; } };

/* ---------------- markdown (safe: everything escaped, then a small subset re-enabled) ---------------- */
function inline(s) {
  return s.replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}
function mdBlocks(text) {
  const lines = esc(text).split("\n"), out = [];
  let list = null, para = [];
  const flushP = () => { if (para.length) { out.push(`<p>${inline(para.join("<br>"))}</p>`); para = []; } };
  const flushL = () => { if (list) { out.push(`<${list.t}>${list.items.map(i => `<li>${inline(i)}</li>`).join("")}</${list.t}>`); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], h = l.match(/^(#{1,4})\s+(.*)/), ul = l.match(/^\s*[-*•]\s+(.*)/), ol = l.match(/^\s*\d+[.)]\s+(.*)/);
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || "")) {
      flushP(); flushL();
      const row = r => r.trim().replace(/^\||\|$/g, "").split("|").map(c => inline(c.trim()));
      const head = row(l); i += 1; const body = [];
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) body.push(row(lines[++i]));
      out.push(`<div class="md-table"><table><thead><tr>${head.map(c => `<th>${c}</th>`).join("")}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    } else if (h) { flushP(); flushL(); out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`); }
    else if (ul || ol) { flushP(); const t = ul ? "ul" : "ol"; if (!list || list.t !== t) { flushL(); list = {t, items: []}; } list.items.push((ul || ol)[1]); }
    else if (/^&gt;\s?/.test(l)) { flushP(); flushL(); out.push(`<blockquote>${inline(l.replace(/^&gt;\s?/, ""))}</blockquote>`); }
    else if (!l.trim()) { flushP(); flushL(); }
    else { flushL(); para.push(l); }
  }
  flushP(); flushL();
  return out.join("");
}
function md(src) {
  if ((src.match(/```/g) || []).length % 2) src += "\n```";      // close a fence that is still streaming
  const parts = src.split(/```([\w+-]*)\n?([\s\S]*?)```/g);
  return parts.map((part, i) => {
    if (i % 3 === 0) return mdBlocks(part);
    if (i % 3 === 1) return "";
    const lang = parts[i - 1] || "code";
    return `<div class="code-block"><div class="cb-head"><span>${esc(lang)}</span><button type="button" class="cb-copy">Sao chép</button></div><pre><code>${esc(part.replace(/\n$/, ""))}</code></pre></div>`;
  }).join("");
}

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
  if (p.get("state") !== ss.get("state")) { toast("Phiên đăng nhập không hợp lệ, vui lòng thử lại.", "err"); history.replaceState(null, "", "/"); return; }
  const body = new URLSearchParams({grant_type: "authorization_code", client_id: CFG.client_id, code: p.get("code"),
    redirect_uri: location.origin + "/", code_verifier: ss.get("pkce")});
  const r = await fetch(`https://${CFG.cognito_domain}/oauth2/token`, {method: "POST", body,
    headers: {"Content-Type": "application/x-www-form-urlencoded"}});
  if (r.ok) { const t = await r.json(); ss.set("id_token", t.id_token); } else toast("Không lấy được phiên đăng nhập.", "err");
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
let wakeToast = false;
/* fetch with retry while Aurora resumes from auto-pause (API answers 503 + Retry-After) */
async function fetchWake(path, init, tries = 4) {
  for (let i = 0; ; i++) {
    const r = await fetch(path, init);
    if (r.status !== 503 || i >= tries) return r;
    if (!wakeToast) { wakeToast = true; toast("Hệ thống đang khởi động lại sau thời gian nghỉ, chờ vài giây…", "info", 6000); setTimeout(() => (wakeToast = false), 8000); }
    await sleep(4000);
  }
}
async function api(path, opts = {}) {
  const r = await fetchWake(path, {...opts, headers: {"Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...(opts.headers || {})}});
  if (r.status === 401) { ss.del("id_token"); toast("Phiên đăng nhập đã hết hạn.", "err"); setTimeout(() => location.reload(), 1200); throw new Error("401"); }
  const data = r.headers.get("content-type")?.includes("json") ? JSON.parse(await r.text()) : await r.text();
  if (!r.ok) throw new Error(data?.detail || data || r.statusText);
  return data;
}

/* ---------------- routing ---------------- */
function show(tab) {
  $$(".tab").forEach(s => s.classList.toggle("hidden", s.id !== "tab-" + tab));
  $$(".tabs a").forEach(a => { const on = a.dataset.tab === tab; a.classList.toggle("on", on); on ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"); });
  ({files: loadFiles, sandbox: loadSbFiles, agent: loadRuns, usage: loadUsage, "minh-bach": loadTransparency})[tab]?.();
  if (tab === "chat") setTimeout(() => $("#prompt").focus(), 0);
}
function route() {
  const tab = (location.hash.match(/#\/([\w-]+)/) || [])[1] || "chat";
  document.body.classList.toggle("anon", !TOKEN);
  if (!TOKEN && tab !== "minh-bach") { $("#login").classList.remove("hidden"); $("#app").classList.add("hidden"); return; }
  $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
  show(tab);
}

/* ---------------- chat ---------------- */
const rel = d => { const s = (Date.now() - new Date(String(d).replace(" ", "T") + (String(d).includes("Z") ? "" : "Z"))) / 1000;
  return s < 60 ? "vừa xong" : s < 3600 ? `${Math.floor(s / 60)} phút` : s < 86400 ? `${Math.floor(s / 3600)} giờ` : `${Math.floor(s / 86400)} ngày`; };
async function loadConvs() {
  const rows = await api("/api/conversations");
  $("#convList").innerHTML = rows.map(c => `<li data-id="${c.id}" class="${c.id === CONV ? "on" : ""}">
    <span class="c-title" title="${esc(c.title)}">${esc(c.title)}</span><span class="c-time">${rel(c.updated_at)}</span>
    <button type="button" class="c-del" data-del="${c.id}" aria-label="Xóa hội thoại" title="Xóa">×</button></li>`).join("")
    || `<li class="c-empty">Chưa có hội thoại. Hỏi VBot điều đầu tiên ở bên phải.</li>`;
}
function metaHtml(m) {
  const p = [];
  if (m.tier_label) p.push(`<span class="pill" title="${esc(m.reason || "")}">${esc(m.tier_label)}</span>`);
  if (m.model) p.push(`<span class="pill">${esc(m.model)}${m.provider ? " · " + esc(m.provider) : ""}</span>`);
  if (m.input_tokens != null) p.push(`<span class="pill" title="token vào · ra · đọc từ cache">${num(m.input_tokens)} vào · ${num(m.output_tokens)} ra${m.cache_read ? " · cache " + num(m.cache_read) : ""}</span>`);
  if (m.usd != null) p.push(`<span class="pill money" title="chi phí của câu trả lời này">${usd(m.usd, 6)}</span>`);
  if (m.ttft_s) p.push(`<span class="pill ${m.ttft_s <= 3 ? "ok" : "warn"}" title="thời gian tới token đầu tiên">TTFT ${m.ttft_s}s</span>`);
  (m.sources || []).forEach(s => p.push(`<span class="pill src">📄 ${esc(s)}</span>`));
  (m.quarantined || []).forEach(q => p.push(`<span class="pill warn" title="${esc((q.why || []).join(", "))}">⚠ đã loại do nghi chèn lệnh: ${esc(q.title)}</span>`));
  return p.join("");
}
const EMPTY = $("#emptyChat");
function resetChat() { $("#messages").innerHTML = ""; $("#messages").appendChild(EMPTY); EMPTY.classList.remove("hidden"); $("#banner").classList.add("hidden"); }
function scrollEnd(force) { const m = $("#messages"); if (force || m.scrollHeight - m.scrollTop - m.clientHeight < 140) m.scrollTop = m.scrollHeight; }
function addMsg(role, text, meta) {
  EMPTY.classList.add("hidden");
  const el = document.createElement("article");
  el.className = "msg " + role;
  el.innerHTML = role === "assistant"
    ? `<div class="avatar" aria-hidden="true">V</div><div class="bubble"><div class="body md">${text ? md(text) : ""}</div><div class="meta">${metaHtml(meta || {})}</div>
       <div class="msg-actions"><button type="button" class="link copy-msg">Sao chép</button></div></div>`
    : `<div class="bubble"><div class="body">${esc(text)}</div></div>`;
  el._raw = text;
  $("#messages").appendChild(el); scrollEnd(true);
  return el;
}
async function openConv(id) {
  if (STREAM) STREAM.abort();
  CONV = id; resetChat(); closeConvs();
  $("#messages").insertAdjacentHTML("beforeend", `<div class="skeleton"></div><div class="skeleton short"></div>`);
  try {
    const rows = await api(`/api/conversations/${id}`);
    $$("#messages .skeleton").forEach(s => s.remove());
    rows.forEach(m => addMsg(m.role, m.content, {model: m.model, input_tokens: m.input_tokens, output_tokens: m.output_tokens,
      usd: m.cost_usd != null ? Number(m.cost_usd) : null}));
  } catch (e) { toast(e.message, "err"); }
  loadConvs().catch(() => {});
}
function showProviderNotice(data) {
  const b = $("#banner");
  b.innerHTML = `<b>Model AI tạm thời chưa sẵn sàng.</b> ${esc(data.hint || "")} Workspace, sandbox và tìm kiếm tài liệu vẫn dùng được.
    <details><summary>Chi tiết kỹ thuật</summary><code>${esc(data.message)}</code></details>`;
  b.className = "banner err";
}
function setStreaming(on) {
  $("#btnSend").classList.toggle("hidden", on); $("#btnStop").classList.toggle("hidden", !on);
  $("#prompt").disabled = false;
}
async function send(e) {
  e?.preventDefault();
  const text = $("#prompt").value.trim(); if (!text || STREAM) return;
  $("#prompt").value = ""; autoGrow(); $("#banner").classList.add("hidden");
  addMsg("user", text);
  const bubble = addMsg("assistant", "", {}); const body = bubble.querySelector(".body"); const metaEl = bubble.querySelector(".meta");
  body.innerHTML = `<span class="typing" aria-label="VBot đang soạn"><i></i><i></i><i></i></span>`;
  let meta = {}, acc = "", pending = false, gotError = false;
  const paint = () => { pending = false; body.innerHTML = md(acc) + `<span class="caret"></span>`; scrollEnd(); };
  STREAM = new AbortController(); setStreaming(true);
  try {
    const r = await fetchWake("/api/chat", {method: "POST", signal: STREAM.signal, headers: {"Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`},
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
        if (ev === "meta") { meta = {...meta, ...data}; if (!CONV) { CONV = data.conversation_id; loadConvs().catch(() => {}); } }
        if (ev === "delta") { acc += data.text; if (!pending) { pending = true; requestAnimationFrame(paint); } }
        if (ev === "usage") meta = {...meta, ...data};
        if (ev === "error") { gotError = true; showProviderNotice(data); }
        metaEl.innerHTML = metaHtml(meta);
      }
    }
  } catch (err) {
    if (err.name === "AbortError") acc += acc ? "\n\n_(đã dừng)_" : "_(đã dừng)_";
    else { toast(err.message, "err"); }
  }
  STREAM = null; setStreaming(false);
  if (!acc && !gotError && !meta.usd) showProviderNotice({message: "Kết nối bị gián đoạn khi đang nhận câu trả lời.", hint: "Vui lòng gửi lại câu hỏi."});
  body.innerHTML = acc ? md(acc) : `<span class="muted">Chưa có câu trả lời.</span>`;
  bubble._raw = acc;
  loadConvs().catch(() => {});
}
function autoGrow() { const t = $("#prompt"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 220) + "px"; }
function openConvs() { $(".convs").classList.add("open"); }
function closeConvs() { $(".convs").classList.remove("open"); }

/* ---------------- files ---------------- */
const ICON = {pdf: "PDF", docx: "DOC", doc: "DOC", xlsx: "XLS", csv: "CSV", pptx: "PPT", md: "MD", txt: "TXT", png: "IMG", svg: "SVG", json: "JSON", py: "PY"};
const ext = n => (String(n).split(".").pop() || "").toLowerCase();
const SRC = {upload: "Tải lên", sandbox: "Sandbox", agent: "Agent", image: "Thiết kế", gdrive: "Google Drive", gmail: "Gmail"};
let FILES = [];
function renderFiles() {
  const q = ($("#fileSearch").value || "").toLowerCase();
  const rows = FILES.filter(f => !q || f.title.toLowerCase().includes(q));
  $("#fileCount").textContent = FILES.length ? `${FILES.length} file` : "";
  $("#fileRows").innerHTML = rows.map(f => `<tr><td><span class="ficon">${ICON[ext(f.title)] || "FILE"}</span>${esc(f.title)}</td>
    <td><span class="pill">${esc(SRC[f.source] || f.source)}</span></td>
    <td class="n">${f.chunks ? num(f.chunks) : `<span class="muted" title="chưa index được nội dung">—</span>`}</td>
    <td>${rel(f.created_at)} trước</td><td class="actions"><button type="button" class="btn sm" data-dl="${f.id}">Tải</button>
    <button type="button" class="btn sm danger" data-del="${f.id}">Xóa</button></td></tr>`).join("")
    || `<tr><td colspan="5" class="empty-row">${FILES.length ? "Không có file khớp tìm kiếm." : "Workspace trống. Tải file lên để VBot trả lời dựa trên tài liệu của bạn."}</td></tr>`;
}
async function loadFiles() {
  if (!FILES.length) $("#fileRows").innerHTML = `<tr><td colspan="5"><div class="skeleton"></div></td></tr>`;
  try { FILES = await api("/api/files"); renderFiles(); } catch (e) { toast(e.message, "err"); }
}
function putWithProgress(url, file, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest(); x.open("PUT", url);
    Object.entries(headers || {}).forEach(([k, v]) => x.setRequestHeader(k, v));
    x.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => (x.status < 300 ? resolve() : reject(new Error(`HTTP ${x.status}`)));
    x.onerror = () => reject(new Error("mất kết nối")); x.send(file);
  });
}
async function upload(files) {
  const box = $("#uploads");
  for (const f of files) {
    const row = document.createElement("div"); row.className = "up";
    row.innerHTML = `<span class="up-name">${esc(f.name)}</span><span class="up-bar"><i></i></span><span class="up-st">0%</span>`;
    box.appendChild(row);
    const bar = row.querySelector("i"), st = row.querySelector(".up-st");
    try {
      if (f.size > 50 * 1024 * 1024) throw new Error("vượt 50 MB");
      const u = await api("/api/files/upload-url", {method: "POST", body: JSON.stringify({name: f.name, size: f.size, content_type: f.type || "application/octet-stream"})});
      await putWithProgress(u.url, f, u.headers, p => { bar.style.width = (p * 90).toFixed(0) + "%"; st.textContent = (p * 100).toFixed(0) + "%"; });
      st.textContent = "đang index…";
      const ing = await api(`/api/files/${u.document_id}/ingest`, {method: "POST"});
      bar.style.width = "100%"; row.classList.add("done"); st.textContent = ing.chunks ? `${ing.chunks} đoạn` : "đã lưu";
    } catch (e) { row.classList.add("fail"); st.textContent = "lỗi: " + e.message; }
    setTimeout(() => row.remove(), 6000);
  }
  loadFiles();
}

/* ---------------- sandbox ---------------- */
async function loadSbFiles() {
  try {
    const rows = await api("/api/files");
    $("#sbFiles").innerHTML = rows.map(f => `<label class="opt"><input type="checkbox" value="${f.id}"> ${esc(f.title)}</label>`).join("")
      || `<p class="muted small">Chưa có file. Tải lên ở tab Workspace.</p>`;
  } catch (e) { toast(e.message, "err"); }
}
async function runSandbox() {
  const btn = $("#btnRun"); busy(btn, true, "Đang chạy…");
  $("#sbOut").innerHTML = `<span class="muted">Đang chạy trong microVM cô lập…</span>`;
  try {
    const ids = $$("#sbFiles input:checked").map(o => o.value);
    const r = await api("/api/sandbox/run", {method: "POST", body: JSON.stringify({code: $("#sbCode").value, file_ids: ids})});
    if (r.error) throw new Error(r.error);
    const ok = r.exit_code === 0;
    $("#sbOut").innerHTML = `<div class="run-head"><span class="pill ${ok ? "ok" : "err"}">${ok ? "Thành công" : r.exit_code === -9 ? "Quá thời gian" : "Lỗi · exit " + r.exit_code}</span>
      <span class="pill">${r.seconds}s</span><span class="pill money">${usd(r.usd, 6)}</span></div>
      ${r.stdout ? `<pre class="stdout">${esc(r.stdout)}</pre>` : ""}${r.stderr ? `<pre class="stderr">${esc(r.stderr)}</pre>` : ""}
      ${r.files.length ? `<div class="run-files"><b>Đã lưu vào workspace:</b> ${r.files.map(f => `<button type="button" class="btn sm" data-dl="${f.document_id}">⬇ ${esc(f.name)}</button>`).join(" ")}</div>` : ""}`;
  } catch (e) { $("#sbOut").innerHTML = `<pre class="stderr">${esc(e.message)}</pre>`; }
  busy(btn, false, true);
}

/* ---------------- agent ---------------- */
const STEPS = [["planning", "Lập kế hoạch"], ["awaiting_confirmation", "Chờ bạn xác nhận"], ["running", "Đang thực hiện"], ["done", "Hoàn tất"]];
const ST_LABEL = {planning: "Đang lập kế hoạch", planned: "Đã lập kế hoạch", awaiting_confirmation: "Chờ xác nhận", running: "Đang thực hiện",
  done: "Hoàn tất", rejected: "Đã từ chối", failed: "Lỗi"};
const ST = {planning: "warn", planned: "warn", awaiting_confirmation: "money", running: "warn", done: "ok", rejected: "err", failed: "err"};
function stepper(status) {
  const idx = {planning: 0, planned: 0, awaiting_confirmation: 1, running: 2, done: 3}[status] ?? -1;
  return `<ol class="stepper">${STEPS.map(([, l], i) => `<li class="${i < idx || status === "done" ? "done" : i === idx ? "now" : ""}">${l}</li>`).join("")}</ol>`;
}
let runTimer = null;
async function loadRuns() {
  clearTimeout(runTimer);
  try {
    const rows = await api("/api/agent");
    $("#agRuns").innerHTML = rows.map(r => {
      const plan = typeof r.plan === "string" ? JSON.parse(r.plan || "null") : r.plan;
      return `<div class="card"><div class="card-head"><h3>${esc(r.goal)}</h3><span class="pill ${ST[r.status] || ""}">${esc(ST_LABEL[r.status] || r.status)}</span></div>
        ${["rejected", "failed"].includes(r.status) ? "" : stepper(r.status)}
        ${plan ? `<p>${esc(plan.summary || "")}</p>${(plan.actions || []).length ? `<ol class="actions-list">${plan.actions.map(a => `<li><span class="pill">${esc(a.type)}</span> ${esc(a.title)}</li>`).join("")}</ol>` : ""}` : ""}
        ${plan?.injection_flags?.length ? `<div class="banner err">⚠ Phát hiện dấu hiệu chèn lệnh: ${esc(plan.injection_flags.join(", "))}</div>` : ""}
        ${r.status === "awaiting_confirmation" ? `<div class="row"><button type="button" class="btn pri" data-ok="${r.id}">Xác nhận chạy <span class="chev">›</span></button><button type="button" class="btn danger" data-no="${r.id}">Từ chối</button></div>` : ""}
        ${r.result ? `<p class="muted small">${esc(r.result)}</p>` : ""}
        <div class="card-foot"><span>${rel(r.created_at)} trước</span><span>${usd(r.cost_usd, 5)}</span></div></div>`;
    }).join("") || `<div class="empty-card">Chưa có tác vụ. Giao việc ở trên, agent sẽ lập kế hoạch và chờ bạn xác nhận.</div>`;
    if (rows.some(r => ["planning", "planned", "running"].includes(r.status)) && location.hash.includes("agent")) runTimer = setTimeout(loadRuns, 3000);
  } catch (e) { toast(e.message, "err"); }
}

/* ---------------- usage + transparency ---------------- */
const meter = (v, cap) => { const p = Math.min(100, cap ? v / cap * 100 : 0); return `<span class="meter ${p > 85 ? "hot" : ""}"><i style="width:${p.toFixed(1)}%"></i></span>`; };
async function loadUsage() {
  $("#usageBox").innerHTML = `<div class="skeleton"></div>`;
  try {
    const d = await api("/api/usage"), s = d.summary, q = d.quota;
    $("#usageBox").innerHTML = `<div class="kpis"><div class="kpi"><b>${usd(s.usd, 4)}</b><span>30 ngày qua</span></div>
      <div class="kpi"><b>${num(s.requests)}</b><span>lượt dùng</span></div>
      <div class="kpi"><b>${usd(q.user_today_usd)}</b><span>hôm nay / hạn mức ${usd(q.user_cap_usd, 2)}</span>${meter(q.user_today_usd, q.user_cap_usd)}</div>
      <div class="kpi"><b>${usd(q.unit_month_usd)}</b><span>đơn vị tháng này / ${usd(q.unit_cap_usd, 0)}</span>${meter(q.unit_month_usd, q.unit_cap_usd)}</div></div>
      <div class="tablewrap"><table class="tbl"><thead><tr><th>Model / dịch vụ</th><th class="n">Lượt</th><th class="n">Token vào</th><th class="n">Token ra</th><th class="n">USD</th></tr></thead><tbody>
      ${Object.entries(s.by_model).map(([m, b]) => `<tr><td>${esc(m)}</td><td class="n">${num(b.requests)}</td><td class="n">${num(b.input_tokens)}</td><td class="n">${num(b.output_tokens)}</td><td class="n">${usd(b.usd, 6)}</td></tr>`).join("")
        || `<tr><td colspan="5" class="empty-row">Chưa có lượt dùng nào.</td></tr>`}
      </tbody></table></div>
      <p class="muted small">Hạn mức đặt lại lúc 07:00 (giờ Việt Nam) mỗi ngày. Khi chạm hạn mức, VBot tạm dừng các yêu cầu tốn phí của bạn.</p>`;
  } catch (e) { toast(e.message, "err"); }
}
function bars(obj, total) {
  const e = Object.entries(obj).sort((a, b) => b[1] - a[1]); const mx = e[0]?.[1] || 1;
  return e.map(([k, v]) => `<div class="bar"><span>${esc(k)}</span><span class="t"><i style="width:${(v / mx * 100).toFixed(1)}%"></i></span><span class="v">${usd(v, 2)}${total ? " · " + (v / total * 100).toFixed(1) + "%" : ""}</span></div>`).join("");
}
async function loadTransparency() {
  if ($("#tpBox").dataset.loaded) return;
  try {
    const d = await (await fetch("/api/transparency")).json(), q = d.quote, m = d.mvp;
    $("#tpBox").dataset.loaded = "1";
    $("#tpBox").innerHTML = `
    <div class="kpis"><div class="kpi"><b>${usd(q.total_usd_month, 0)}</b><span>báo giá 2.000 DAU / tháng</span></div>
     <div class="kpi"><b>${usd(q.usd_per_dau, 2)}</b><span>mỗi DAU / tháng</span></div>
     <div class="kpi"><b>${num(q.requests_month)}</b><span>request / tháng</span></div>
     <div class="kpi"><b>${m.total != null ? usd(m.total, 2) : "—"}</b><span>chi phí thật MVP tháng này</span></div></div>
    <div class="card"><h3>Báo giá theo component · giá niêm yết us-east-1, ${esc(q.prices_fetched_at?.slice(0, 10))}</h3>${bars(q.by_component, q.total_usd_month)}</div>
    <div class="card"><h3>Đòn bẩy tiết kiệm (tính lại bằng cùng mô hình)</h3><div class="tablewrap"><table class="tbl"><thead><tr><th>Đòn bẩy</th><th>Nếu không làm</th><th class="n">Tiết kiệm/tháng</th></tr></thead><tbody>
     ${q.levers.map(l => `<tr><td>${esc(l.lever)}</td><td>${esc(l.how)}</td><td class="n">${usd(l.saving, 0)}</td></tr>`).join("")}</tbody></table></div></div>
    <div class="card"><h3>Chi phí thật của MVP theo component</h3>${m.error ? `<p class="muted">${esc(m.error)}</p>` : (Object.keys(m.by_component || {}).length ? bars(m.by_component, m.total) : `<p class="muted">Chưa có dữ liệu (Cost Explorer cập nhật sau khoảng 24 giờ).</p>`) + `<p class="muted small">${esc(m.note || "")} · ${esc(m.period || "")}</p>`}</div>
    <details class="card"><summary><h3>Giả định tải (${q.sizing.length} chỉ số)</h3></summary><div class="tablewrap"><table class="tbl"><tbody>${q.sizing.map(s => `<tr><td>${esc(s.metric)}</td><td class="n">${typeof s.value === "number" ? num(Math.round(s.value * 100) / 100) : esc(s.value)}</td><td class="muted">${esc(s.formula)}</td></tr>`).join("")}</tbody></table></div></details>
    <details class="card"><summary><h3>Từng dòng báo giá (${q.lines.length} dòng)</h3></summary><div class="tablewrap"><table class="tbl"><thead><tr><th>Component</th><th>Hạng mục</th><th class="n">USD</th></tr></thead><tbody>
     ${q.lines.map(l => `<tr><td class="mono">${esc(l.component)}</td><td>${esc(l.y_nghia)}<div class="muted small">${esc(l.ghi_chu)}</div></td><td class="n">${usd(l.chi_phi, 2)}</td></tr>`).join("")}</tbody></table></div></details>`;
  } catch (e) { $("#tpBox").innerHTML = `<p class="muted">Không tải được dữ liệu: ${esc(e.message)}</p>`; }
}

/* ---------------- download helper ---------------- */
async function download(id) { try { const r = await api(`/api/files/${id}/download-url`); location.href = r.url; } catch (e) { toast(e.message, "err"); } }

/* ---------------- boot + events ---------------- */
async function boot() {
  try { CFG = await (await fetch("/api/config")).json(); } catch { toast("Không kết nối được máy chủ.", "err"); return; }
  $("#envName").textContent = (CFG.env || "").toUpperCase();
  await handleCallback();
  const t = ss.get("id_token");
  TOKEN = t && tokenValid(t) ? t : null;
  route();
  if (TOKEN) {
    api("/api/me").then(me => { $("#meEmail").textContent = me.email; $("#meEmail").title = `Phòng ban: ${me.department}`; }).catch(e => toast(e.message, "err"));
    loadConvs().catch(() => {});
  }
}
window.addEventListener("hashchange", route);
$("#btnLogin").onclick = login;
$("#btnLogout").onclick = logout;
const newChat = () => { if (STREAM) STREAM.abort(); CONV = null; resetChat(); location.hash = "#/chat"; loadConvs().catch(() => {}); closeConvs(); $("#prompt").focus(); };
$("#btnNew").onclick = newChat;
$("#btnConvs").onclick = () => $(".convs").classList.toggle("open");
$(".chips").onclick = e => { const q = e.target.closest("button")?.dataset.q; if (q) { $("#prompt").value = q; autoGrow(); $("#prompt").focus(); } };
$("#convList").onclick = async e => {
  const del = e.target.closest(".c-del");
  if (del) { e.stopPropagation(); armed(del, async () => {
    try { await api(`/api/conversations/${del.dataset.del}`, {method: "DELETE"}); if (CONV === del.dataset.del) newChat(); loadConvs(); toast("Đã xóa hội thoại."); } catch (er) { toast(er.message, "err"); } });
    return; }
  const li = e.target.closest("li[data-id]"); if (li) { location.hash = "#/chat"; openConv(li.dataset.id); }
};
$("#messages").onclick = e => {
  const cb = e.target.closest(".cb-copy");
  if (cb) { navigator.clipboard.writeText(cb.closest(".code-block").querySelector("code").textContent).then(() => { cb.textContent = "Đã chép ✓"; setTimeout(() => (cb.textContent = "Sao chép"), 1500); }); return; }
  const cm = e.target.closest(".copy-msg");
  if (cm) navigator.clipboard.writeText(cm.closest(".msg")._raw || "").then(() => toast("Đã sao chép câu trả lời."));
};
$("#chatForm").onsubmit = send;
$("#btnStop").onclick = () => STREAM?.abort();
$("#prompt").addEventListener("input", autoGrow);
$("#prompt").onkeydown = e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } };
document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && TOKEN) { e.preventDefault(); newChat(); }
  if (e.key === "Escape" && STREAM) STREAM.abort();
});
$("#fileInput").onchange = e => { upload([...e.target.files]); e.target.value = ""; };
$("#fileSearch").oninput = renderFiles;
const drop = $("#drop");
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => upload([...e.dataTransfer.files]));
$("#fileRows").onclick = e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.dl) download(b.dataset.dl);
  if (b.dataset.del) armed(b, async () => { try { await api(`/api/files/${b.dataset.del}`, {method: "DELETE"}); toast("Đã xóa file."); loadFiles(); } catch (er) { toast(er.message, "err"); } });
};
$("#btnRun").onclick = runSandbox;
$("#sbCode").onkeydown = e => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runSandbox(); }
  if (e.key === "Tab") { e.preventDefault(); const t = e.target, p = t.selectionStart; t.setRangeText("    ", p, t.selectionEnd, "end"); }
};
$("#sbOut").onclick = e => { const b = e.target.closest("[data-dl]"); if (b) download(b.dataset.dl); };
$("#btnAgent").onclick = async () => {
  const goal = $("#agGoal").value.trim(); if (!goal) { $("#agGoal").focus(); return; }
  const btn = $("#btnAgent"); busy(btn, true, "Đang giao việc…");
  try { await api("/api/agent", {method: "POST", body: JSON.stringify({goal})}); $("#agGoal").value = ""; toast("Đã giao việc. Agent đang lập kế hoạch."); loadRuns(); }
  catch (e) { toast(e.message, "err"); }
  busy(btn, false, true);
};
$("#agRuns").onclick = async e => {
  const b = e.target.closest("button"); const id = b?.dataset.ok || b?.dataset.no; if (!id) return;
  busy(b, true);
  try { await api(`/api/agent/${id}/decision`, {method: "POST", body: JSON.stringify({approve: !!b.dataset.ok})}); toast(b.dataset.ok ? "Đã xác nhận, agent đang thực hiện." : "Đã từ chối kế hoạch."); }
  catch (er) { toast(er.message, "err"); }
  loadRuns();
};
$("#btnImg").onclick = async () => {
  const prompt = $("#imgPrompt").value.trim(); if (prompt.length < 3) { $("#imgPrompt").focus(); return; }
  const btn = $("#btnImg"); busy(btn, true, "Đang tạo…");
  const card = document.createElement("figure"); card.className = "gen-card";
  card.innerHTML = `<div class="skeleton tall"></div><figcaption>${esc(prompt)}</figcaption>`;
  $("#imgOut").prepend(card);
  try {
    const r = await api("/api/images", {method: "POST", body: JSON.stringify({prompt})});
    card.innerHTML = `<img class="gen" src="data:${r.mime || "image/png"};base64,${r.b64}" alt="${esc(prompt)}">
      <figcaption><span>${esc(prompt)}</span><span class="muted small">${esc(r.model)} · ${usd(r.usd, 3)}</span>
      <button type="button" class="btn sm" data-dl="${r.document_id}">⬇ Tải</button></figcaption>`;
  } catch (e) { card.remove(); toast(e.message, "err", 7000); }
  busy(btn, false, true);
};
$("#imgOut").onclick = e => { const b = e.target.closest("[data-dl]"); if (b) download(b.dataset.dl); };
boot();
