"use client";
import { useEffect, useState } from "react";
import { api, download, errMsg, post } from "@/lib/api";
import { usd } from "@/lib/format";
import { Icon } from "@/components/Icon";
import { useToast } from "@/components/Toasts";
import type { FileRow } from "./Files";

const SAMPLE = `import os
import pandas as pd

# File đầu vào nằm trong thư mục làm việc; ghi kết quả vào OUTPUT_DIR
df = pd.DataFrame({"thang": ["T1", "T2", "T3"], "doanh_thu": [120, 135, 160]})
df["tang_truong_%"] = df["doanh_thu"].pct_change().mul(100).round(1)
print(df)

df.to_excel(os.path.join(os.environ["OUTPUT_DIR"], "bao_cao.xlsx"), index=False)`;

type Run = { stdout: string; stderr: string; exit_code: number; files: { document_id: string; name: string }[]; seconds: number; usd: number };

export function Sandbox({ active }: { active: boolean }) {
  const toast = useToast();
  const [code, setCode] = useState(SAMPLE);
  const [files, setFiles] = useState<FileRow[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [out, setOut] = useState<Run | { error: string } | null>(null);

  useEffect(() => { if (active) api<FileRow[]>("/api/files").then(setFiles).catch(e => toast(errMsg(e), "err")); }, [active, toast]);

  async function run() {
    if (running) return;
    setRunning(true); setOut(null);
    try {
      const r = await post<Run & { error?: string }>("/api/sandbox/run", { code, file_ids: [...picked] });
      setOut(r.error ? { error: r.error } : r);
    } catch (e) { setOut({ error: errMsg(e) }); }
    setRunning(false);
  }

  const toggle = (id: string) => setPicked(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <section className={`tab${active ? "" : " hidden"}`}>
      <header className="page-head"><span className="eyebrow">Sandbox</span><h1>Chạy code Python an toàn</h1>
        <p>Mỗi lần chạy là một microVM riêng: không có mạng, chỉ thấy file bạn chọn, tối đa 90 giây. File ghi vào <code>OUTPUT_DIR</code> được lưu về workspace.</p></header>
      <div className="sb-grid">
        <div className="editor">
          <div className="editor-bar">
            <span className="tabname"><Icon name="code" />main.py</span><span className="spacer" /><span className="kbd-hint">Ctrl+Enter</span>
            <button className="btn pri sm" type="button" onClick={run} disabled={running}>
              {running ? <><span className="spin" />Đang chạy…</> : <><Icon name="play" solid />Chạy</>}
            </button>
          </div>
          <textarea className="code" spellCheck={false} aria-label="Mã Python" value={code} onChange={e => setCode(e.target.value)}
            onKeyDown={e => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); run(); }
              if (e.key === "Tab") { e.preventDefault(); e.currentTarget.setRangeText("    ", e.currentTarget.selectionStart, e.currentTarget.selectionEnd, "end"); setCode(e.currentTarget.value); }
            }} />
          <div className="terminal" aria-live="polite">
            {running && <span className="term-muted">Đang chạy trong microVM cô lập…</span>}
            {!running && !out && <span className="term-muted">Kết quả chạy sẽ hiện ở đây.</span>}
            {out && "error" in out && <pre className="stderr">{out.error}</pre>}
            {out && !("error" in out) && <>
              <div className="run-head">
                <span className={`pill ${out.exit_code === 0 ? "ok" : "err"}`}>{out.exit_code === 0 ? "Thành công" : out.exit_code === -9 ? "Quá thời gian" : `Lỗi · exit ${out.exit_code}`}</span>
                <span className="pill">{out.seconds}s</span><span className="pill money">{usd(out.usd, 6)}</span>
              </div>
              {out.stdout && <pre className="stdout">{out.stdout}</pre>}
              {out.stderr && <pre className="stderr">{out.stderr}</pre>}
              {!!out.files.length && <div className="run-files"><b>Đã lưu vào workspace:</b>
                {out.files.map(f => <button key={f.document_id} type="button" className="btn sm" onClick={() => download(f.document_id)}><Icon name="download" />{f.name}</button>)}</div>}
            </>}
          </div>
        </div>
        <aside className="panel">
          <h3>File đầu vào</h3>
          <p className="muted small">Chọn file trong workspace để code đọc được{picked.size ? ` · đã chọn ${picked.size}` : ""}.</p>
          <div className="optlist">
            {files === null && <div className="skeleton" />}
            {files?.length === 0 && <p className="muted small">Chưa có file. Tải lên ở tab <a href="#/files">Workspace</a>.</p>}
            {files?.map(f => (
              <label key={f.id} className="opt"><input type="checkbox" checked={picked.has(f.id)} onChange={() => toggle(f.id)} /><span title={f.title}>{f.title}</span></label>
            ))}
          </div>
        </aside>
      </div>
    </section>
  );
}
