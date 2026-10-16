"use client";
import { useEffect, useState } from "react";
import { errMsg } from "@/lib/api";
import { num, usd } from "@/lib/format";
import { Kpi } from "./Usage";

type Quote = {
  total_usd_month: number; usd_per_dau: number; requests_month: number; prices_fetched_at?: string;
  by_component: Record<string, number>;
  levers: { lever: string; how: string; saving: number }[];
  sizing: { metric: string; value: number | string; formula: string }[];
  lines: { component: string; y_nghia: string; ghi_chu: string; chi_phi: number }[];
};
type Mvp = { total?: number | null; by_component?: Record<string, number>; error?: string; note?: string; period?: string };

function Bars({ data, total }: { data: Record<string, number>; total?: number | null }) {
  const rows = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = rows[0]?.[1] || 1;
  return (
    <div className="bars">
      {rows.map(([k, v]) => (
        <div className="bar" key={k}>
          <span className="k">{k}</span>
          <span className="t"><i style={{ width: `${((v / max) * 100).toFixed(1)}%` }} /></span>
          <span className="v">{usd(v, 2)}{total ? <small> · {((v / total) * 100).toFixed(1)}%</small> : null}</span>
        </div>
      ))}
    </div>
  );
}

let cache: { quote: Quote; mvp: Mvp } | null = null;

export function Transparency({ active }: { active: boolean }) {
  const [d, setD] = useState(cache);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!active || cache) return;
    fetch("/api/transparency").then(r => r.json()).then(x => { cache = x; setD(x); }).catch(e => setErr(errMsg(e)));
  }, [active]);
  const q = d?.quote, m = d?.mvp;

  return (
    <section className={`tab${active ? "" : " hidden"}`}>
      <header className="page-head"><span className="eyebrow">Minh bạch</span><h1>Kiến trúc, tính năng và chi phí</h1>
        <p>Báo giá cho 2.000 người dùng mỗi ngày tính từ giá niêm yết AWS, đặt cạnh chi phí thật của bản MVP đang chạy.</p></header>
      {err && <p className="muted">Không tải được dữ liệu: {err}</p>}
      {!d && !err && <><div className="skeleton" /><div className="skeleton short" /></>}
      {q && m && <>
        <div className="kpis">
          <Kpi label="Báo giá 2.000 DAU" value={usd(q.total_usd_month, 0)} sub="mỗi tháng" />
          <Kpi label="Mỗi DAU" value={usd(q.usd_per_dau, 2)} sub="mỗi tháng" />
          <Kpi label="Request" value={num(q.requests_month)} sub="mỗi tháng" />
          <Kpi label="Chi phí thật MVP" value={m.total != null ? usd(m.total, 2) : "—"} sub="tháng này" />
        </div>
        <div className="card"><h3>Báo giá theo component · giá niêm yết us-east-1, {q.prices_fetched_at?.slice(0, 10)}</h3><Bars data={q.by_component} total={q.total_usd_month} /></div>
        <div className="card"><h3>Đòn bẩy tiết kiệm (tính lại bằng cùng mô hình)</h3>
          <div className="tablewrap"><table className="tbl"><thead><tr><th>Đòn bẩy</th><th>Nếu không làm</th><th className="n">Tiết kiệm/tháng</th></tr></thead>
            <tbody>{q.levers.map(l => <tr key={l.lever}><td>{l.lever}</td><td>{l.how}</td><td className="n">{usd(l.saving, 0)}</td></tr>)}</tbody></table></div></div>
        <div className="card"><h3>Chi phí thật của MVP theo component</h3>
          {m.error ? <p className="muted">{m.error}</p> : <>
            {Object.keys(m.by_component || {}).length ? <Bars data={m.by_component!} total={m.total} /> : <p className="muted">Chưa có dữ liệu (Cost Explorer cập nhật sau khoảng 24 giờ).</p>}
            <p className="muted small">{[m.note, m.period].filter(Boolean).join(" · ")}</p>
          </>}
        </div>
        <details className="card"><summary><h3>Giả định tải ({q.sizing.length} chỉ số)</h3></summary>
          <div className="tablewrap"><table className="tbl"><tbody>{q.sizing.map(s => (
            <tr key={s.metric}><td>{s.metric}</td><td className="n">{typeof s.value === "number" ? num(Math.round(s.value * 100) / 100) : s.value}</td><td className="muted">{s.formula}</td></tr>
          ))}</tbody></table></div></details>
        <details className="card"><summary><h3>Từng dòng báo giá ({q.lines.length} dòng)</h3></summary>
          <div className="tablewrap"><table className="tbl"><thead><tr><th>Component</th><th>Hạng mục</th><th className="n">USD</th></tr></thead>
            <tbody>{q.lines.map((l, i) => (
              <tr key={i}><td className="mono">{l.component}</td><td>{l.y_nghia}<div className="muted small">{l.ghi_chu}</div></td><td className="n">{usd(l.chi_phi, 2)}</td></tr>
            ))}</tbody></table></div></details>
      </>}
    </section>
  );
}
