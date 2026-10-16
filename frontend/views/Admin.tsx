"use client";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { api, del, errMsg, post } from "@/lib/api";
import { rel, toDate, usd } from "@/lib/format";
import { Armed } from "@/components/Armed";
import { Icon } from "@/components/Icon";
import { useToast } from "@/components/Toasts";
import { Kpi, Meter } from "./Usage";

type Role = "user" | "unit_admin" | "platform_admin";
type AdminUser = { id: string; sub: string; email: string; department: string; role: Role; status: string; enabled: boolean; created_at: string };
type UsersResp = { role: Role; scope: string | null; me: string; users: AdminUser[] };
type Dept = { name: string; users: number; month_usd: number; cap_usd: number; custom_cap: boolean };
type DeptResp = { month: string; default_cap_usd: number; daily_user_cap_usd: number; departments: Dept[] };
type AuditRec = { ts: string; user_id: string; email: string; action: string; [k: string]: unknown };

const ROLE_LABEL: Record<Role, string> = { user: "Người dùng", unit_admin: "Quản trị đơn vị", platform_admin: "Quản trị nền tảng" };
const patch = <T,>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
const put = <T,>(path: string, body: unknown) => api<T>(path, { method: "PUT", body: JSON.stringify(body) });

function StatusPill({ u }: { u: AdminUser }) {
  if (!u.enabled) return <span className="pill err">Đã khoá</span>;
  if (u.status === "FORCE_CHANGE_PASSWORD") return <span className="pill warn" title="Chưa đăng nhập lần đầu">Chờ kích hoạt</span>;
  if (u.status === "CONFIRMED") return <span className="pill ok">Đang hoạt động</span>;
  return <span className="pill">{u.status}</span>;
}

/* ---------------------------------------------------------------- users */
function Users({ data, depts, reload }: { data: UsersResp; depts: string[]; reload: () => void }) {
  const toast = useToast();
  const platform = data.role === "platform_admin";
  const [q, setQ] = useState("");
  const [dept, setDept] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: "", department: data.scope || "", role: "user" as Role });
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState({ department: "", role: "user" as Role });
  const [busy, setBusy] = useState<string | null>(null);

  const shown = data.users.filter(u => (!q || u.email.includes(q.toLowerCase())) && (!dept || u.department === dept));

  async function run(id: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(id);
    try { await fn(); toast(ok, "ok"); reload(); } catch (e) { toast(errMsg(e), "err"); }
    setBusy(null);
  }
  async function create(e: FormEvent) {
    e.preventDefault();
    await run("new", () => post("/api/admin/users", { email: form.email.trim(), department: form.department.trim() || undefined, role: form.role }),
      `Đã tạo tài khoản. Thư mời đã gửi tới ${form.email.trim()}.`);
    setForm(f => ({ ...f, email: "" })); setAdding(false);
  }
  const startEdit = (u: AdminUser) => { setEditing(u.id); setEdit({ department: u.department, role: u.role }); };
  const saveEdit = (u: AdminUser) => run(u.id, () => patch(`/api/admin/users/${u.id}`, {
    department: edit.department !== u.department ? edit.department : undefined, role: edit.role !== u.role ? edit.role : undefined,
  }), "Đã cập nhật. Người dùng sẽ phải đăng nhập lại.").then(() => setEditing(null));

  return (
    <div className="panel flush">
      <div className="panel-bar">
        <label className="search"><Icon name="search" /><input type="search" placeholder="Tìm email" aria-label="Tìm email" value={q} onChange={e => setQ(e.target.value)} /></label>
        {platform && (
          <select className="sm-select" value={dept} onChange={e => setDept(e.target.value)} aria-label="Lọc theo phòng ban">
            <option value="">Mọi phòng ban</option>{depts.map(d => <option key={d}>{d}</option>)}
          </select>
        )}
        <span className="spacer" />
        <span className="muted small">{shown.length}/{data.users.length} người</span>
        <button className="btn pri sm" type="button" onClick={() => setAdding(a => !a)}><Icon name="plus" />Thêm người dùng</button>
      </div>
      {adding && (
        <form className="inline-form" onSubmit={create}>
          <label><span className="field-label">Email công ty</span>
            <input type="text" inputMode="email" required autoFocus placeholder="ten@cty.vn" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></label>
          <label><span className="field-label">Phòng ban</span>
            <input type="text" list="dept-list" placeholder="ke-toan" value={form.department} disabled={!platform}
              onChange={e => setForm({ ...form, department: e.target.value })} /></label>
          <label><span className="field-label">Vai trò</span>
            <select value={form.role} disabled={!platform} onChange={e => setForm({ ...form, role: e.target.value as Role })}>
              {(Object.keys(ROLE_LABEL) as Role[]).map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select></label>
          <div className="inline-actions">
            <button className="btn pri" type="submit" disabled={busy === "new"}>{busy === "new" ? <><span className="spin" />Đang tạo…</> : "Tạo và gửi thư mời"}</button>
            <button className="btn ghost" type="button" onClick={() => setAdding(false)}>Huỷ</button>
          </div>
          <p className="muted small inline-note">Người dùng nhận email kèm mật khẩu tạm (hạn 3 ngày), đặt mật khẩu mới và cài MFA ở lần đăng nhập đầu.</p>
        </form>
      )}
      <datalist id="dept-list">{depts.map(d => <option key={d} value={d} />)}</datalist>
      <div className="tablewrap">
        <table className="tbl admin-tbl">
          <thead><tr><th>Email</th><th>Phòng ban</th><th>Vai trò</th><th>Trạng thái</th><th>Tạo lúc</th><th className="n"><span className="sr">Thao tác</span></th></tr></thead>
          <tbody>
            {shown.map(u => {
              const me = u.id === data.me || u.sub === data.me;
              const locked = !platform && u.role === "platform_admin";
              return editing === u.id ? (
                <tr key={u.id} className="editing">
                  <td>{u.email}</td>
                  <td><input type="text" list="dept-list" aria-label="Phòng ban" value={edit.department} onChange={e => setEdit({ ...edit, department: e.target.value })} /></td>
                  <td><select aria-label="Vai trò" value={edit.role} disabled={me} onChange={e => setEdit({ ...edit, role: e.target.value as Role })}>
                    {(Object.keys(ROLE_LABEL) as Role[]).map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></td>
                  <td colSpan={2}><StatusPill u={u} /></td>
                  <td className="actions">
                    <button className="btn pri sm" type="button" disabled={busy === u.id} onClick={() => saveEdit(u)}>Lưu</button>
                    <button className="btn ghost sm" type="button" onClick={() => setEditing(null)}>Huỷ</button>
                  </td>
                </tr>
              ) : (
                <tr key={u.id}>
                  <td><span className="cell-strong">{u.email}</span>{me && <span className="pill src">bạn</span>}</td>
                  <td><span className="mono">{u.department}</span></td>
                  <td>{ROLE_LABEL[u.role]}</td>
                  <td><StatusPill u={u} /></td>
                  <td>{u.created_at ? rel(u.created_at) : "—"}</td>
                  <td className="actions">
                    {u.enabled && u.status === "FORCE_CHANGE_PASSWORD" && !locked && (
                      <button className="btn ghost sm" type="button" disabled={busy === u.id}
                        onClick={() => run(u.id, () => post(`/api/admin/users/${u.id}/resend`, {}), `Đã gửi lại thư mời tới ${u.email}.`)}>Gửi lại thư mời</button>
                    )}
                    {platform && <button className="btn ghost sm" type="button" onClick={() => startEdit(u)}>Sửa</button>}
                    {!me && !locked && (u.enabled
                      ? <Armed className="btn sm danger" label="Khoá" onConfirm={() => run(u.id, () => patch(`/api/admin/users/${u.id}`, { enabled: false }), `Đã khoá ${u.email}.`)}>Khoá</Armed>
                      : <button className="btn sm" type="button" disabled={busy === u.id}
                          onClick={() => run(u.id, () => patch(`/api/admin/users/${u.id}`, { enabled: true }), `Đã mở khoá ${u.email}.`)}>Mở khoá</button>)}
                  </td>
                </tr>
              );
            })}
            {!shown.length && <tr><td colSpan={6} className="empty-row">Không có người dùng khớp bộ lọc.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- departments */
function Departments({ data, platform, reload }: { data: DeptResp; platform: boolean; reload: () => void }) {
  const toast = useToast();
  const [caps, setCaps] = useState<Record<string, string>>({});
  const total = data.departments.reduce((s, d) => s + d.month_usd, 0);

  async function save(d: Dept) {
    const v = Number((caps[d.name] ?? "").replace(",", "."));
    if (!Number.isFinite(v) || v < 0) { toast("Nhập số USD hợp lệ.", "err"); return; }
    try { await put(`/api/admin/departments/${d.name}/cap`, { usd: v }); toast(`Đã đặt hạn mức ${d.name}: ${usd(v, 2)}/tháng.`, "ok"); setCaps(c => ({ ...c, [d.name]: "" })); reload(); }
    catch (e) { toast(errMsg(e), "err"); }
  }
  async function reset(d: Dept) {
    try { await del(`/api/admin/departments/${d.name}/cap`); toast(`${d.name} dùng lại hạn mức mặc định.`, "ok"); reload(); }
    catch (e) { toast(errMsg(e), "err"); }
  }

  return <>
    <div className="kpis">
      <Kpi label={`Chi phí tháng ${data.month}`} value={usd(total, 2)} sub={`${data.departments.length} phòng ban`} />
      <Kpi label="Hạn mức mặc định" value={usd(data.default_cap_usd, 0)} sub="mỗi phòng ban / tháng" />
      <Kpi label="Hạn mức mỗi người" value={usd(data.daily_user_cap_usd, 2)} sub="mỗi ngày" />
      <Kpi label="Gần chạm hạn mức" value={String(data.departments.filter(d => d.cap_usd && d.month_usd / d.cap_usd > 0.85).length)} sub="phòng ban dùng > 85%" />
    </div>
    <div className="panel flush">
      <div className="tablewrap">
        <table className="tbl">
          <thead><tr><th>Phòng ban</th><th className="n">Người dùng</th><th className="n">Đã dùng tháng này</th><th>Mức dùng</th><th className="n">Hạn mức</th>{platform && <th><span className="sr">Đổi hạn mức</span></th>}</tr></thead>
          <tbody>
            {data.departments.map(d => (
              <tr key={d.name}>
                <td><span className="mono">{d.name}</span></td>
                <td className="n">{d.users}</td>
                <td className="n">{usd(d.month_usd, 4)}</td>
                <td className="meter-cell"><Meter v={d.month_usd} cap={d.cap_usd} /></td>
                <td className="n">{usd(d.cap_usd, 2)}{d.custom_cap && <span className="pill money" title="Hạn mức riêng của phòng ban">riêng</span>}</td>
                {platform && (
                  <td className="actions">
                    <input className="cap-input" type="text" inputMode="decimal" placeholder="USD" aria-label={`Hạn mức mới cho ${d.name}`}
                      value={caps[d.name] ?? ""} onChange={e => setCaps(c => ({ ...c, [d.name]: e.target.value }))}
                      onKeyDown={e => { if (e.key === "Enter") save(d); }} />
                    <button className="btn sm" type="button" disabled={!caps[d.name]} onClick={() => save(d)}>Đặt</button>
                    {d.custom_cap && <button className="btn ghost sm" type="button" onClick={() => reset(d)}>Mặc định</button>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
    <p className="muted small">Khi phòng ban chạm hạn mức tháng, VBot tạm dừng các yêu cầu tốn phí của cả phòng ban tới đầu tháng sau. Hạn mức mới có hiệu lực trong vòng 1 phút.</p>
  </>;
}

/* ---------------------------------------------------------------- audit */
const today = () => new Date().toISOString().slice(0, 10);
function Audit({ users }: { users: AdminUser[] }) {
  const toast = useToast();
  const [date, setDate] = useState(today);
  const [user, setUser] = useState("");
  const [action, setAction] = useState("");
  const [filter, setFilter] = useState("");
  const [data, setData] = useState<{ total: number; records: AuditRec[] } | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await api(`/api/admin/audit?${new URLSearchParams({ date, user, action: filter })}`)); }
    catch (e) { toast(errMsg(e), "err"); }
    setLoading(false);
  }, [date, user, filter, toast]);
  useEffect(() => { load(); }, [load]);
  const apply = () => (filter === action.trim() ? load() : setFilter(action.trim()));

  const detail = (r: AuditRec) =>
    JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !["ts", "user_id", "email", "action"].includes(k))));

  return (
    <div className="panel flush">
      <div className="panel-bar wrap">
        <label className="field-inline"><span>Ngày (UTC)</span><input type="date" value={date} max={today()} onChange={e => setDate(e.target.value || today())} /></label>
        <label className="field-inline"><span>Người dùng</span>
          <select value={user} onChange={e => setUser(e.target.value)}><option value="">Tất cả</option>{users.map(u => <option key={u.id} value={u.sub}>{u.email}</option>)}</select></label>
        <label className="search"><Icon name="search" /><input type="search" placeholder="Hành động, vd. admin. hoặc chat" aria-label="Lọc hành động" value={action}
          onChange={e => setAction(e.target.value)} onKeyDown={e => { if (e.key === "Enter") apply(); }} /></label>
        <button className="btn sm" type="button" onClick={apply} disabled={loading}>{loading ? <span className="spin" /> : "Lọc"}</button>
        <span className="spacer" />
        {data && <span className="muted small">{data.records.length} / {data.total} bản ghi</span>}
      </div>
      <div className="tablewrap">
        <table className="tbl">
          <thead><tr><th>Thời gian</th><th>Người dùng</th><th>Hành động</th><th>Chi tiết</th></tr></thead>
          <tbody>
            {!data && <tr><td colSpan={4}><div className="skeleton" /></td></tr>}
            {data?.records.map((r, i) => (
              <tr key={i}>
                <td className="nowrap">{toDate(r.ts).toLocaleTimeString("vi-VN")}</td>
                <td>{r.email || <span className="mono muted">{r.user_id?.slice(0, 8)}</span>}</td>
                <td><span className={`pill${r.action.startsWith("admin.") ? " money" : ""}`}>{r.action}</span></td>
                <td className="audit-detail" title={detail(r)}><code>{detail(r)}</code></td>
              </tr>
            ))}
            {data && !data.records.length && <tr><td colSpan={4} className="empty-row">Không có bản ghi trong ngày này.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="muted small inline-note">Nhật ký lưu trong bucket chỉ-ghi-một-lần (S3 Object Lock): không ai sửa hay xoá được, kể cả quản trị viên. Việc xem nhật ký cũng được ghi lại.</p>
    </div>
  );
}

/* ---------------------------------------------------------------- page */
type Section = "users" | "departments" | "audit";

export function Admin({ active }: { active: boolean }) {
  const [section, setSection] = useState<Section>("users");
  const [users, setUsers] = useState<UsersResp | null>(null);
  const [depts, setDepts] = useState<DeptResp | null>(null);
  const [denied, setDenied] = useState<string | null>(null);

  const load = useCallback(() => {
    api<UsersResp>("/api/admin/users").then(r => { setUsers(r); setDenied(null); }).catch(e => setDenied(errMsg(e)));
    api<DeptResp>("/api/admin/departments").then(setDepts).catch(() => {});
  }, []);
  useEffect(() => { if (active) load(); }, [active, load]);

  const platform = users?.role === "platform_admin";
  const deptNames = useMemo(() => [...new Set([...(depts?.departments.map(d => d.name) || []), ...(users?.users.map(u => u.department) || [])])].sort(), [depts, users]);
  const sections: [Section, string][] = [["users", "Người dùng"], ["departments", "Phòng ban & ngân sách"], ...(platform ? [["audit", "Nhật ký"] as [Section, string]] : [])];

  return (
    <section className={`tab${active ? "" : " hidden"}`}>
      <header className="page-head"><span className="eyebrow">Quản trị</span><h1>Người dùng và ngân sách</h1>
        <p>{users ? (platform ? "Bạn là quản trị nền tảng: quản lý mọi phòng ban, hạn mức và nhật ký." : `Bạn quản trị phòng ban ${users.scope}: thêm, khoá và gửi lại thư mời cho người trong phòng.`)
          : "Quyền được kiểm tra trực tiếp với Cognito ở mỗi thao tác."}</p></header>
      {denied && <div className="notice"><Icon name="lock" />{denied}</div>}
      {!denied && <>
        <nav className="subtabs" aria-label="Mục quản trị">
          {sections.map(([id, label]) => (
            <button key={id} type="button" className={section === id ? "on" : undefined} aria-current={section === id ? "page" : undefined} onClick={() => setSection(id)}>{label}</button>
          ))}
        </nav>
        {!users && <div className="skeleton" />}
        {users && section === "users" && <Users data={users} depts={deptNames} reload={load} />}
        {section === "departments" && (depts ? <Departments data={depts} platform={!!platform} reload={load} /> : <div className="skeleton" />)}
        {users && platform && section === "audit" && <Audit users={users.users} />}
      </>}
    </section>
  );
}
