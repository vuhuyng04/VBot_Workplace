"use client";
import { useCallback, useEffect, useState } from "react";
import { api, errMsg, post } from "@/lib/api";
import { rel, usd } from "@/lib/format";
import { Icon } from "@/components/Icon";
import { useToast } from "@/components/Toasts";

type Plan = { summary?: string; actions?: { type: string; title: string }[]; injection_flags?: string[] };
type Run = { id: string; goal: string; status: string; plan: Plan | string | null; result?: string; cost_usd?: number; created_at: string };

const STEPS = ["Lập kế hoạch", "Chờ bạn xác nhận", "Đang thực hiện", "Hoàn tất"];
const STEP_OF: Record<string, number> = { planning: 0, planned: 0, awaiting_confirmation: 1, running: 2, done: 3 };
const LABEL: Record<string, string> = { planning: "Đang lập kế hoạch", planned: "Đã lập kế hoạch", awaiting_confirmation: "Chờ xác nhận",
  running: "Đang thực hiện", done: "Hoàn tất", rejected: "Đã từ chối", failed: "Lỗi" };
const TONE: Record<string, string> = { planning: "warn", planned: "warn", awaiting_confirmation: "money", running: "warn", done: "ok", rejected: "err", failed: "err" };
const LIVE = ["planning", "planned", "running"];

function Stepper({ status }: { status: string }) {
  const idx = STEP_OF[status] ?? -1;
  return <ol className="stepper">{STEPS.map((l, i) => <li key={l} className={i < idx || status === "done" ? "done" : i === idx ? "now" : undefined}>{l}</li>)}</ol>;
}

function RunCard({ r, onDecide }: { r: Run; onDecide: (id: string, ok: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const plan: Plan | null = typeof r.plan === "string" ? JSON.parse(r.plan || "null") : r.plan;
  const decide = async (ok: boolean) => { setBusy(true); await onDecide(r.id, ok); setBusy(false); };
  return (
    <div className="card">
      <div className="card-head"><h3>{r.goal}</h3><span className={`pill ${TONE[r.status] || ""}`}>{LABEL[r.status] || r.status}</span></div>
      {!["rejected", "failed"].includes(r.status) && <Stepper status={r.status} />}
      {plan?.summary && <p>{plan.summary}</p>}
      {!!plan?.actions?.length && <ol className="actions-list">{plan.actions.map((a, i) => <li key={i}><span className="pill">{a.type}</span>{a.title}</li>)}</ol>}
      {!!plan?.injection_flags?.length && <div className="notice"><Icon name="alert" />Phát hiện dấu hiệu chèn lệnh: {plan.injection_flags.join(", ")}</div>}
      {r.status === "awaiting_confirmation" && (
        <div className="row">
          <button type="button" className="btn pri" disabled={busy} onClick={() => decide(true)}><Icon name="check" />Xác nhận chạy</button>
          <button type="button" className="btn danger" disabled={busy} onClick={() => decide(false)}>Từ chối</button>
        </div>
      )}
      {r.result && <p className="muted small">{r.result}</p>}
      <div className="card-foot"><span>{rel(r.created_at)}</span><span>{usd(r.cost_usd, 5)}</span></div>
    </div>
  );
}

export function Agent({ active }: { active: boolean }) {
  const toast = useToast();
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [goal, setGoal] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(() => api<Run[]>("/api/agent").then(setRuns).catch(e => toast(errMsg(e), "err")), [toast]);
  useEffect(() => { if (active) load(); }, [active, load]);
  // poll every 3 s only while this tab is open and something is still moving
  const live = !!runs?.some(r => LIVE.includes(r.status));
  useEffect(() => {
    if (!active || !live) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [active, live, load]);

  async function start() {
    const g = goal.trim();
    if (g.length < 5) { toast("Mô tả mục tiêu cụ thể hơn một chút.", "info"); return; }
    setSending(true);
    try { await post("/api/agent", { goal: g }); setGoal(""); toast("Đã giao việc. Agent đang lập kế hoạch.", "ok"); load(); }
    catch (e) { toast(errMsg(e), "err"); }
    setSending(false);
  }
  async function decide(id: string, approve: boolean) {
    try { await post(`/api/agent/${id}/decision`, { approve }); toast(approve ? "Đã xác nhận, agent đang thực hiện." : "Đã từ chối kế hoạch.", "ok"); }
    catch (e) { toast(errMsg(e), "err"); }
    load();
  }

  return (
    <section className={`tab${active ? "" : " hidden"}`}>
      <header className="page-head"><span className="eyebrow">Agent dự án</span><h1>Giao việc cho agent chạy nền</h1>
        <p>Agent lập kế hoạch, <b>chờ bạn xác nhận</b> trước mọi hành động ghi (tạo ticket, cập nhật trang), rồi thực hiện và báo kết quả.</p></header>
      <div className="panel">
        <label className="field-label" htmlFor="agGoal">Mục tiêu</label>
        <textarea id="agGoal" rows={3} value={goal} onChange={e => setGoal(e.target.value)}
          onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") start(); }}
          placeholder="Ví dụ: Lập kế hoạch sprint 2 tuần cho việc ra mắt cổng tuyển dụng nội bộ, tạo ticket cho từng hạng mục" />
        <div className="row end">
          <span className="muted small">Ctrl+Enter để giao</span>
          <button className="btn pri" type="button" onClick={start} disabled={sending}>{sending ? <><span className="spin" />Đang giao việc…</> : <><Icon name="send" />Giao việc</>}</button>
        </div>
      </div>
      <h2 className="section-title">Tác vụ gần đây</h2>
      <div className="cards">
        {runs === null && <div className="skeleton" />}
        {runs?.length === 0 && <div className="empty-card"><Icon name="agent" size="xl" />Chưa có tác vụ. Giao việc ở trên, agent sẽ lập kế hoạch và chờ bạn xác nhận.</div>}
        {runs?.map(r => <RunCard key={r.id} r={r} onDecide={decide} />)}
      </div>
    </section>
  );
}
