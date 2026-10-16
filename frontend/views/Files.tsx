"use client";
import { useCallback, useEffect, useState, type DragEvent } from "react";
import { api, del, download, errMsg, post } from "@/lib/api";
import { ext, num, rel } from "@/lib/format";
import { Armed } from "@/components/Armed";
import { Icon } from "@/components/Icon";
import { useToast } from "@/components/Toasts";

export type FileRow = { id: string; title: string; source: string; created_at: string; chunks: number };
type Up = { key: number; name: string; pct: number; status: string; state?: "done" | "fail" };

const MAX = 50 * 1024 * 1024;
const BADGE: Record<string, string> = { pdf: "PDF", docx: "DOC", doc: "DOC", xlsx: "XLS", csv: "CSV", pptx: "PPT", md: "MD", txt: "TXT", png: "IMG", jpg: "IMG", svg: "SVG", json: "JSON", py: "PY" };
const SRC: Record<string, string> = { upload: "Tải lên", sandbox: "Sandbox", agent: "Agent", image: "Thiết kế", gdrive: "Google Drive", gmail: "Gmail" };

export function FileBadge({ name }: { name: string }) {
  const b = BADGE[ext(name)] || "FILE";
  return <span className={`ficon ${b.toLowerCase()}`} aria-hidden="true">{b}</span>;
}

function putWithProgress(url: string, file: File, headers: Record<string, string>, onProgress: (p: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    Object.entries(headers || {}).forEach(([k, v]) => x.setRequestHeader(k, v));
    x.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => (x.status < 300 ? resolve() : reject(new Error(`HTTP ${x.status}`)));
    x.onerror = () => reject(new Error("mất kết nối"));
    x.send(file);
  });
}

let upSeq = 0;

export function Files({ active }: { active: boolean }) {
  const toast = useToast();
  const [rows, setRows] = useState<FileRow[] | null>(null);
  const [q, setQ] = useState("");
  const [ups, setUps] = useState<Up[]>([]);
  const [over, setOver] = useState(false);

  const load = useCallback(() => api<FileRow[]>("/api/files").then(setRows).catch(e => toast(errMsg(e), "err")), [toast]);
  useEffect(() => { if (active) load(); }, [active, load]);

  async function upload(files: File[]) {
    for (const f of files) {
      const key = ++upSeq;
      const set = (p: Partial<Up>) => setUps(us => us.map(u => (u.key === key ? { ...u, ...p } : u)));
      setUps(us => [...us, { key, name: f.name, pct: 0, status: "0%" }]);
      try {
        if (f.size > MAX) throw new Error("vượt 50 MB");
        const u = await post<{ document_id: string; url: string; headers: Record<string, string> }>("/api/files/upload-url",
          { name: f.name, size: f.size, content_type: f.type || "application/octet-stream" });
        await putWithProgress(u.url, f, u.headers, p => set({ pct: p * 90, status: `${Math.round(p * 100)}%` }));
        set({ status: "đang index…" });
        const ing = await post<{ chunks: number }>(`/api/files/${u.document_id}/ingest`, {});
        set({ pct: 100, state: "done", status: ing.chunks ? `${ing.chunks} đoạn` : "đã lưu" });
      } catch (e) { set({ state: "fail", status: "lỗi: " + errMsg(e) }); }
      setTimeout(() => setUps(us => us.filter(x => x.key !== key)), 6000);
    }
    load();
  }

  async function remove(id: string) {
    try { await del(`/api/files/${id}`); toast("Đã xóa file.", "ok"); load(); } catch (e) { toast(errMsg(e), "err"); }
  }

  const onDrag = (e: DragEvent, on: boolean) => { e.preventDefault(); setOver(on); };
  const shown = (rows || []).filter(f => !q || f.title.toLowerCase().includes(q.toLowerCase()));

  return (
    <section className={`tab${active ? "" : " hidden"}`}>
      <header className="page-head"><span className="eyebrow">Workspace</span><h1>Tài liệu của bạn</h1>
        <p>Chỉ bạn và agent của bạn đọc được. Quota 10 GB. File được index để VBot tìm khi trả lời.</p></header>
      <label className={`drop${over ? " over" : ""}`} onDragEnter={e => onDrag(e, true)} onDragOver={e => onDrag(e, true)}
        onDragLeave={e => onDrag(e, false)} onDrop={e => { onDrag(e, false); upload([...e.dataTransfer.files]); }}>
        <input type="file" multiple onChange={e => { upload([...(e.target.files || [])]); e.target.value = ""; }} />
        <Icon name="upload" size="xl" /><b>Kéo thả file vào đây hoặc bấm để chọn</b>
        <span>TXT, MD, CSV, DOCX, XLSX, PPTX, PDF · tối đa 50 MB mỗi file</span>
      </label>
      <div className="uploads" aria-live="polite">
        {ups.map(u => (
          <div key={u.key} className={`up${u.state ? " " + u.state : ""}`}>
            <FileBadge name={u.name} /><span className="up-name">{u.name}</span>
            <span className="up-bar"><i style={{ width: `${u.pct}%` }} /></span><span className="up-st">{u.status}</span>
          </div>
        ))}
      </div>
      <div className="panel flush">
        <div className="panel-bar">
          <label className="search"><Icon name="search" /><input type="search" placeholder="Tìm file" aria-label="Tìm file" value={q} onChange={e => setQ(e.target.value)} /></label>
          <span className="spacer" />
          {!!rows?.length && <span className="muted small">{rows.length} file</span>}
        </div>
        <div className="tablewrap">
          <table className="tbl files-tbl">
            <thead><tr><th>Tên file</th><th>Nguồn</th><th className="n">Đoạn đã index</th><th>Thêm lúc</th><th className="n"><span className="sr">Thao tác</span></th></tr></thead>
            <tbody>
              {rows === null && <tr><td colSpan={5}><div className="skeleton" /></td></tr>}
              {rows !== null && !shown.length && <tr><td colSpan={5} className="empty-row">
                {rows.length ? "Không có file khớp tìm kiếm." : "Workspace trống. Tải file lên để VBot trả lời dựa trên tài liệu của bạn."}</td></tr>}
              {shown.map(f => (
                <tr key={f.id}>
                  <td><div className="fname"><FileBadge name={f.title} /><span title={f.title}>{f.title}</span></div></td>
                  <td><span className="pill">{SRC[f.source] || f.source}</span></td>
                  <td className="n">{f.chunks ? num(f.chunks) : <span className="muted" title="chưa index được nội dung">—</span>}</td>
                  <td>{rel(f.created_at)}</td>
                  <td className="actions">
                    <button type="button" className="icon-btn sm plain" aria-label={`Tải ${f.title}`} title="Tải xuống" onClick={() => download(f.id)}><Icon name="download" /></button>
                    <Armed className="icon-btn sm plain del" label={`Xóa ${f.title}`} onConfirm={() => remove(f.id)}><Icon name="trash" /></Armed>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
