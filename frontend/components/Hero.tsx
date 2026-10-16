import { Icon, type IconName } from "./Icon";

const FACTS: [IconName, string, string][] = [
  ["spark", "5 cấp tác vụ", "Từ trả lời email tới agent quản lý dự án, tự chọn model phù hợp."],
  ["folder", "Workspace riêng", "Người khác và agent của họ không đọc được tài liệu của bạn."],
  ["shield", "Sandbox an toàn", "Code chạy trong microVM cô lập, không có mạng."],
  ["coins", "Minh bạch chi phí", "Mỗi câu trả lời hiện model, token và số tiền USD."],
];

export function Hero({ onLogin, ready }: { onLogin: () => void; ready: boolean }) {
  return (
    <section className="hero">
      <div className="hero-in">
        <div className="hero-card">
          <span className="eyebrow light">Trợ lý AI nội bộ</span>
          <h1>Làm việc nhanh hơn với VBot</h1>
          <p>Email, tài liệu, dữ liệu, code và dự án trong một workspace riêng của bạn. Đăng nhập bằng tài khoản tập đoàn (SSO, bắt buộc MFA).</p>
          <div className="row">
            <button className="btn light lg" type="button" onClick={onLogin} disabled={!ready}><Icon name="lock" />Đăng nhập</button>
            <a href="#/minh-bach" className="btn ghost-light lg">Xem kiến trúc &amp; chi phí</a>
          </div>
        </div>
        <ul className="hero-facts">
          {FACTS.map(([icon, title, body]) => <li key={title}><Icon name={icon} size="lg" /><b>{title}</b><span>{body}</span></li>)}
        </ul>
      </div>
    </section>
  );
}
