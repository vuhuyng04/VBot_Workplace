"use client";
import { useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { num, usd } from "@/lib/format";
import { useToast } from "@/components/Toasts";

type ModelRow = { requests: number; input_tokens: number; output_tokens: number; usd: number };
type Usage = {
  summary: { usd: number; requests: number; by_model: Record<string, ModelRow> };
  quota: { user_today_usd: number; user_cap_usd: number; unit_month_usd: number; unit_cap_usd: number };
};

export function Meter({ v, cap }: { v: number; cap: number }) {
  const p = Math.min(100, cap ? (v / cap) * 100 : 0);
  return (
    <span className={`meter${p > 85 ? " hot" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p)} aria-label={`${p.toFixed(0)}% hạn mức`}>
      <i style={{ width: `${p.toFixed(1)}%` }} />
    </span>
  );
}

export function Kpi({ label, value, sub, children }: { label: string; value: string; sub?: string; children?: React.ReactNode }) {
  return <div className="kpi"><span className="k-label">{label}</span><b>{value}</b>{sub && <span className="k-sub">{sub}</span>}{children}</div>;
}

export function UsageView({ active }: { active: boolean }) {
  const toast = useToast();
  const [d, setD] = useState<Usage | null>(null);
  useEffect(() => { if (active) api<Usage>("/api/usage").then(setD).catch(e => toast(errMsg(e), "err")); }, [active, toast]);
  const s = d?.summary, q = d?.quota;
  const models = Object.entries(s?.by_model || {}).sort((a, b) => b[1].usd - a[1].usd);

  return (
    <section className={`tab${active ? "" : " hidden"}`}>
      <header className="page-head"><span className="eyebrow">Chi phí của tôi</span><h1>Bạn đã dùng bao nhiêu</h1>
        <p>Mọi lượt gọi model, sandbox và tạo hình đều được ghi lại theo đúng đơn giá niêm yết.</p></header>
      {!d ? <div className="skeleton" /> : <>
        <div className="kpis">
          <Kpi label="30 ngày qua" value={usd(s!.usd, 4)} />
          <Kpi label="Lượt dùng" value={num(s!.requests)} sub="30 ngày qua" />
          <Kpi label="Hôm nay" value={usd(q!.user_today_usd)} sub={`hạn mức ${usd(q!.user_cap_usd, 2)} / ngày`}><Meter v={q!.user_today_usd} cap={q!.user_cap_usd} /></Kpi>
          <Kpi label="Đơn vị tháng này" value={usd(q!.unit_month_usd)} sub={`hạn mức ${usd(q!.unit_cap_usd, 0)} / tháng`}><Meter v={q!.unit_month_usd} cap={q!.unit_cap_usd} /></Kpi>
        </div>
        <div className="panel flush">
          <div className="tablewrap">
            <table className="tbl">
              <thead><tr><th>Model / dịch vụ</th><th className="n">Lượt</th><th className="n">Token vào</th><th className="n">Token ra</th><th className="n">USD</th></tr></thead>
              <tbody>
                {models.map(([m, b]) => <tr key={m}><td>{m}</td><td className="n">{num(b.requests)}</td><td className="n">{num(b.input_tokens)}</td><td className="n">{num(b.output_tokens)}</td><td className="n">{usd(b.usd, 6)}</td></tr>)}
                {!models.length && <tr><td colSpan={5} className="empty-row">Chưa có lượt dùng nào.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <p className="muted small">Hạn mức đặt lại lúc 07:00 (giờ Việt Nam) mỗi ngày. Khi chạm hạn mức, VBot tạm dừng các yêu cầu tốn phí của bạn.</p>
      </>}
    </section>
  );
}
