"use client";
import { useState } from "react";
import { download, errMsg, post } from "@/lib/api";
import { usd } from "@/lib/format";
import { Icon } from "@/components/Icon";
import { useToast } from "@/components/Toasts";

type Gen = { key: number; prompt: string; done?: { document_id: string; usd: number; model: string; mime: string; b64: string } };
let genSeq = 0;

export function Images({ active }: { active: boolean }) {
  const toast = useToast();
  const [prompt, setPrompt] = useState("");
  const [items, setItems] = useState<Gen[]>([]);
  const busy = items.some(i => !i.done);

  async function generate() {
    const p = prompt.trim();
    if (p.length < 3 || busy) return;
    const key = ++genSeq;
    setItems(xs => [{ key, prompt: p }, ...xs]);
    try {
      const r = await post<NonNullable<Gen["done"]>>("/api/images", { prompt: p });
      setItems(xs => xs.map(x => (x.key === key ? { ...x, done: r } : x)));
    } catch (e) {
      setItems(xs => xs.filter(x => x.key !== key));
      toast(errMsg(e), "err", 7000);
    }
  }

  return (
    <section className={`tab${active ? "" : " hidden"}`}>
      <header className="page-head"><span className="eyebrow">Thiết kế</span><h1>Tạo hình minh họa</h1>
        <p>Dùng cho slide và tài liệu. Sơ đồ hay mockup nên hỏi trong Chat (cấp 5) để VBot viết SVG/HTML, rẻ hơn ảnh.</p></header>
      <div className="panel">
        <label className="field-label" htmlFor="imgPrompt">Mô tả hình</label>
        <textarea id="imgPrompt" rows={3} value={prompt} onChange={e => setPrompt(e.target.value)}
          onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") generate(); }}
          placeholder="Hình minh họa tối giản cho slide về chuyển đổi số, tông xanh navy, có biểu tượng đám mây và dữ liệu" />
        <div className="row end">
          <span className="muted small">Khoảng $0,04 mỗi ảnh · lưu vào Workspace</span>
          <button className="btn pri" type="button" onClick={generate} disabled={busy || prompt.trim().length < 3}>
            {busy ? <><span className="spin" />Đang tạo…</> : <><Icon name="spark" />Tạo hình</>}
          </button>
        </div>
      </div>
      <div className="gallery">
        {items.map(g => (
          <figure key={g.key} className="gen-card">
            {g.done ? <img src={`data:${g.done.mime || "image/png"};base64,${g.done.b64}`} alt={g.prompt} /> : <div className="skeleton tall" />}
            <figcaption>
              <div><span className="p" title={g.prompt}>{g.prompt}</span>
                {g.done && <span className="muted small">{g.done.model} · {usd(g.done.usd, 3)}</span>}</div>
              {g.done && <button type="button" className="icon-btn sm plain" aria-label="Tải ảnh" title="Tải xuống" onClick={() => download(g.done!.document_id)}><Icon name="download" /></button>}
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
