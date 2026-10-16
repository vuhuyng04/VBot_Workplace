"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, authHeader, del, errMsg, fetchWake } from "@/lib/api";
import { num, toDate, usd } from "@/lib/format";
import { Armed } from "@/components/Armed";
import { Icon, type IconName } from "@/components/Icon";
import { Markdown } from "@/components/Markdown";
import { useToast } from "@/components/Toasts";

type Conv = { id: string; title: string; updated_at: string };
type Meta = {
  tier_label?: string; reason?: string; model?: string; provider?: string; input_tokens?: number; output_tokens?: number;
  cache_read?: number; usd?: number | null; ttft_s?: number; sources?: string[]; quarantined?: { title: string; why?: string[] }[];
};
type Msg = { id: number; role: "user" | "assistant"; text: string; meta: Meta; streaming?: boolean; stopped?: boolean };
type Notice = { message: string; hint?: string };

const SUGGESTIONS: [IconName, string, string, string][] = [
  ["file", "Tóm tắt tài liệu", "Điểm chính, việc cần làm", "Tóm tắt các điểm chính trong tài liệu tôi vừa tải lên"],
  ["chat", "Soạn email", "Trả lời, xin lùi lịch, cảm ơn", "Soạn email trả lời khách hàng xin lùi lịch họp sang thứ Sáu, giọng lịch sự"],
  ["agent", "Viết báo cáo", "Tiến độ, biên bản, tờ trình", "Viết báo cáo tiến độ dự án tuần này theo mẫu: kết quả, vướng mắc, kế hoạch tuần sau"],
  ["code", "Viết code", "Python, SQL, phân tích dữ liệu", "Viết script Python đọc file Excel và tính tổng doanh thu theo tháng"],
];
const TIERS: [string, string][] = [["", "Tự chọn cấp"], ["t1", "Cấp 1 · Hỏi đáp"], ["t2", "Cấp 2 · Tài liệu"],
  ["t3", "Cấp 3 · Dữ liệu, code"], ["t4", "Cấp 4 · Dự án"], ["t5", "Cấp 5 · Thiết kế"]];

function groupOf(d: string): string {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const t = toDate(d).getTime(), day = 86400000;
  return t >= start.getTime() ? "Hôm nay" : t >= start.getTime() - day ? "Hôm qua" : t >= start.getTime() - 7 * day ? "7 ngày qua" : "Cũ hơn";
}

function MetaPills({ m }: { m: Meta }) {
  return (
    <div className="meta">
      {m.tier_label && <span className="pill" title={m.reason}>{m.tier_label}</span>}
      {m.model && <span className="pill">{m.model}{m.provider ? ` · ${m.provider}` : ""}</span>}
      {m.input_tokens != null && <span className="pill" title="token vào · ra · đọc từ cache">
        {num(m.input_tokens)} vào · {num(m.output_tokens)} ra{m.cache_read ? ` · cache ${num(m.cache_read)}` : ""}</span>}
      {m.usd != null && <span className="pill money" title="chi phí của câu trả lời này">{usd(m.usd, 6)}</span>}
      {!!m.ttft_s && <span className={`pill ${m.ttft_s <= 3 ? "ok" : "warn"}`} title="thời gian tới token đầu tiên">TTFT {m.ttft_s}s</span>}
      {(m.sources || []).map(s => <span key={s} className="pill src" title="nguồn trong workspace"><Icon name="file" />{s}</span>)}
      {(m.quarantined || []).map(q => <span key={q.title} className="pill warn" title={(q.why || []).join(", ")}><Icon name="alert" />đã loại do nghi chèn lệnh: {q.title}</span>)}
    </div>
  );
}

const Message = memo(function Message({ m, onCopy }: { m: Msg; onCopy: (t: string) => void }) {
  if (m.role === "user") return <article className="msg user"><div className="bubble"><div className="body">{m.text}</div></div></article>;
  return (
    <article className="msg assistant">
      <div className="avatar" aria-hidden="true" />
      <div className="bubble">
        <div className="body md">
          {m.streaming && !m.text ? <span className="typing" aria-label="VBot đang soạn"><i /><i /><i /></span> : <Markdown source={m.text} />}
          {m.streaming && m.text && <span className="caret" />}
          {m.stopped && <p className="muted small">(đã dừng)</p>}
          {!m.streaming && !m.text && !m.stopped && <span className="muted">Chưa có câu trả lời.</span>}
        </div>
        <MetaPills m={m.meta} />
        {!m.streaming && m.text && (
          <div className="msg-actions"><button type="button" className="btn ghost sm" onClick={() => onCopy(m.text)}><Icon name="copy" />Sao chép</button></div>
        )}
      </div>
    </article>
  );
});

export function Chat({ active }: { active: boolean }) {
  const toast = useToast();
  const [convs, setConvs] = useState<Conv[] | null>(null);
  const [cid, setCid] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [loadingConv, setLoadingConv] = useState(false);
  const [q, setQ] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState("");
  const [useRag, setUseRag] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const stream = useRef<AbortController | null>(null);
  const seq = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const cidRef = useRef(cid); cidRef.current = cid;

  const loadConvs = useCallback(() => api<Conv[]>("/api/conversations").then(setConvs).catch(() => {}), []);
  useEffect(() => { loadConvs(); }, [loadConvs]);
  useEffect(() => { if (active) setTimeout(() => input.current?.focus(), 0); }, [active]);

  const nearBottom = () => { const el = list.current; return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 140; };
  const scrollEnd = () => requestAnimationFrame(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; });

  const newChat = useCallback(() => {
    stream.current?.abort(); setCid(null); setMsgs([]); setNotice(null); setDrawer(false);
    if (location.hash !== "#/chat") location.hash = "#/chat";
    setTimeout(() => input.current?.focus(), 0);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); newChat(); }
      if (e.key === "Escape") stream.current?.abort();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [newChat]);

  async function openConv(id: string) {
    stream.current?.abort(); setCid(id); setMsgs([]); setNotice(null); setDrawer(false); setLoadingConv(true);
    if (location.hash !== "#/chat") location.hash = "#/chat";
    try {
      const rows = await api<{ role: Msg["role"]; content: string; model?: string; input_tokens?: number; output_tokens?: number; cost_usd?: string | number | null }[]>(`/api/conversations/${id}`);
      if (cidRef.current !== id) return;
      setMsgs(rows.map(r => ({ id: ++seq.current, role: r.role, text: r.content,
        meta: { model: r.model, input_tokens: r.input_tokens ?? undefined, output_tokens: r.output_tokens, usd: r.cost_usd != null ? Number(r.cost_usd) : null } })));
      scrollEnd();
    } catch (e) { toast(errMsg(e), "err"); }
    setLoadingConv(false);
  }

  async function removeConv(id: string) {
    try { await del(`/api/conversations/${id}`); if (cidRef.current === id) newChat(); toast("Đã xóa hội thoại.", "ok"); loadConvs(); }
    catch (e) { toast(errMsg(e), "err"); }
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const text = prompt.trim();
    if (!text || stream.current) return;
    setPrompt(""); setNotice(null);
    const aid = ++seq.current + 1; seq.current = aid;
    setMsgs(ms => [...ms, { id: aid - 1, role: "user", text, meta: {} }, { id: aid, role: "assistant", text: "", meta: {}, streaming: true }]);
    scrollEnd();
    const patch = (f: (m: Msg) => Msg) => setMsgs(ms => ms.map(m => (m.id === aid ? f(m) : m)));
    let acc = "", meta: Meta = {}, frame = 0, gotError = false, stopped = false, gotUsage = false;
    const paint = () => { frame = 0; const stick = nearBottom(); patch(m => ({ ...m, text: acc, meta })); if (stick) scrollEnd(); };
    const ctrl = new AbortController(); stream.current = ctrl; setStreaming(true);
    try {
      const r = await fetchWake("/api/chat", { method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({ message: text, conversation_id: cidRef.current, mode: mode || null, use_rag: useRag }) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(typeof d.detail === "string" ? d.detail : r.statusText); }
      const reader = r.body!.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = (block.match(/^event: (.*)$/m) || [])[1];
          const data = JSON.parse((block.match(/^data: (.*)$/m) || [])[1] || "{}");
          if (ev === "meta") { meta = { ...meta, ...data }; if (!cidRef.current) { setCid(data.conversation_id); cidRef.current = data.conversation_id; loadConvs(); } }
          else if (ev === "delta") acc += data.text;
          else if (ev === "usage") { meta = { ...meta, ...data }; gotUsage = true; }
          else if (ev === "error") { gotError = true; setNotice(data); }
          if (!frame) frame = requestAnimationFrame(paint);
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") stopped = true;
      else { gotError = true; toast(errMsg(err), "err"); }
    }
    if (frame) cancelAnimationFrame(frame);
    stream.current = null; setStreaming(false);
    if (!acc && !gotError && !stopped && !gotUsage) setNotice({ message: "Kết nối bị gián đoạn khi đang nhận câu trả lời.", hint: "Vui lòng gửi lại câu hỏi." });
    const stick = nearBottom();
    patch(m => ({ ...m, text: acc, meta, streaming: false, stopped }));
    if (stick) scrollEnd();   // the final meta pills add height after the last paint
    loadConvs();
  }

  const copy = useCallback((t: string) => navigator.clipboard.writeText(t).then(() => toast("Đã sao chép câu trả lời.", "ok")), [toast]);

  const groups = useMemo(() => {
    const out: [string, Conv[]][] = [];
    (convs || []).filter(c => !q || c.title.toLowerCase().includes(q.toLowerCase())).forEach(c => {
      const g = groupOf(c.updated_at), last = out[out.length - 1];
      if (last && last[0] === g) last[1].push(c); else out.push([g, [c]]);
    });
    return out;
  }, [convs, q]);

  // auto-grow the composer up to 220px
  useEffect(() => {
    const t = input.current;
    if (!t) return;
    t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 220) + "px";
    t.style.overflowY = t.scrollHeight > 220 ? "auto" : "hidden";
  }, [prompt]);

  const title = convs?.find(c => c.id === cid)?.title || "Hội thoại mới";

  return (
    <section className={`tab chat-layout${active ? "" : " hidden"}`}>
      <aside className={`convs${drawer ? " open" : ""}`} aria-label="Danh sách hội thoại">
        <div className="convs-head">
          <button className="btn pri block" type="button" title="Hội thoại mới (Ctrl+K)" onClick={newChat}><Icon name="plus" />Hội thoại mới</button>
          <label className="search"><Icon name="search" /><input type="search" placeholder="Tìm hội thoại" aria-label="Tìm hội thoại" value={q} onChange={e => setQ(e.target.value)} /></label>
        </div>
        <div className="conv-list">
          {convs === null && <><div className="skeleton" /><div className="skeleton short" /></>}
          {convs !== null && !groups.length && <div className="conv-empty">{q ? "Không có hội thoại khớp." : "Chưa có hội thoại. Hỏi VBot điều đầu tiên ở khung bên cạnh."}</div>}
          {groups.map(([g, items]) => (
            <div key={g}>
              <div className="conv-group">{g}</div>
              {items.map(c => (
                <div key={c.id} className={`conv${c.id === cid ? " on" : ""}`} role="button" tabIndex={0} aria-current={c.id === cid ? "true" : undefined}
                  onClick={() => openConv(c.id)} onKeyDown={e => { if (e.key === "Enter") openConv(c.id); }}>
                  <span className="c-title" title={c.title}>{c.title}</span>
                  <Armed className="icon-btn sm plain del" label="Xóa hội thoại" onConfirm={() => removeConv(c.id)}><Icon name="trash" /></Armed>
                </div>
              ))}
            </div>
          ))}
        </div>
      </aside>
      <div className="convs-scrim" onClick={() => setDrawer(false)} />
      <div className="chat-main">
        <div className="chat-top">
          <button className="icon-btn" type="button" aria-label="Mở danh sách hội thoại" onClick={() => setDrawer(true)}><Icon name="menu" /></button>
          <span className="chat-title">{title}</span>
        </div>
        {notice && (
          <div className="banner err" role="status">
            <Icon name="alert" />
            <div><b>Model AI tạm thời chưa sẵn sàng.</b> {notice.hint} Workspace, sandbox và tìm kiếm tài liệu vẫn dùng được.
              <details><summary>Chi tiết kỹ thuật</summary><code>{notice.message}</code></details></div>
            <button className="icon-btn" type="button" aria-label="Đóng thông báo" onClick={() => setNotice(null)}><Icon name="x" /></button>
          </div>
        )}
        <div className="messages" ref={list} aria-live="polite">
          {loadingConv && <><div className="skeleton" /><div className="skeleton short" /></>}
          {!loadingConv && !msgs.length && (
            <div className="empty">
              <span className="empty-mark" aria-hidden="true" />
              <h2>Hôm nay VBot giúp gì cho bạn?</h2>
              <p className="muted">VBot tự chọn model theo độ khó của việc và trả lời dựa trên tài liệu trong workspace của bạn.</p>
              <div className="chips">
                {SUGGESTIONS.map(([icon, t, sub, qq]) => (
                  <button key={t} type="button" onClick={() => { setPrompt(qq); input.current?.focus(); }}><Icon name={icon} /><b>{t}</b><span>{sub}</span></button>
                ))}
              </div>
            </div>
          )}
          {msgs.map(m => <Message key={m.id} m={m} onCopy={copy} />)}
        </div>
        <form className="composer" onSubmit={send}>
          <div className="composer-box">
            <textarea ref={input} rows={1} value={prompt} onChange={e => setPrompt(e.target.value)} aria-label="Câu hỏi"
              placeholder="Hỏi VBot về email, tài liệu, dữ liệu, code hay dự án…"
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
            <div className="composer-bar">
              <select value={mode} onChange={e => setMode(e.target.value)} title="Cấp tác vụ" aria-label="Cấp tác vụ">
                {TIERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <label className="switch" title="Tìm trong tài liệu của bạn khi trả lời">
                <input type="checkbox" checked={useRag} onChange={e => setUseRag(e.target.checked)} /><span className="track" aria-hidden="true" />Dùng tài liệu của tôi
              </label>
              <span className="spacer" />
              {streaming
                ? <button className="icon-btn danger" type="button" aria-label="Dừng (Esc)" title="Dừng (Esc)" onClick={() => stream.current?.abort()}><Icon name="stop" solid /></button>
                : <button className="icon-btn pri" type="submit" aria-label="Gửi (Enter)" title="Gửi (Enter)" disabled={!prompt.trim()}><Icon name="send" /></button>}
            </div>
          </div>
          <p className="composer-hint">Enter để gửi · Shift+Enter xuống dòng · Ctrl+K hội thoại mới · VBot có thể sai, hãy kiểm tra thông tin quan trọng.</p>
        </form>
      </div>
    </section>
  );
}
