# VBot Workplace — MVP trên AWS + báo giá 2.000 DAU

**URL công khai (HTTPS):** https://s4cxct67qimymr2nezhjem7i6q0dwwum.lambda-url.us-east-1.on.aws/
Trang kiến trúc và chi phí xem không cần đăng nhập: `/#/minh-bach`.

## Giao nộp capstone
| File | Tạo bằng | Kiểm tra |
|---|---|---|
| `quote/out/G03_baogia.xlsx` (BaoGia, BangChung, TaiTinh, DonGia) | `python quote/build_quote.py` | `node quote/check.mjs quote/out/G03_baogia.xlsx` → **ĐẠT, 19/19 component** |
| Số liệu cho slide | `quote/out/summary.json` (cùng nguồn với XLSX, nên tổng trên slide luôn bằng TOTAL) | |

Toàn bộ đơn giá lấy từ AWS Price List API (`quote/fetch_prices.py` → `quote/prices.json`, kèm SKU và offer file), là giá On-Demand trả phí ở us-east-1. Sizing nằm trong `quote/assumptions.yaml`.
**TOTAL: $12,610/tháng, $6.31/DAU.** LLM chiếm 71%, 1 FTE vận hành chiếm 20%.

## Kiến trúc MVP đang chạy (us-east-1)
```
Người dùng ──HTTPS──> Lambda Function URL (streaming) ── FastAPI + SPA (arm64)
                      │  JWT Cognito (SSO + TOTP MFA, không cho tự đăng ký)
                      ├─ Aurora PostgreSQL Serverless v2 (pgvector, RLS) qua RDS Data API, tự pause về 0 ACU
                      ├─ S3 workspace (prefix theo user, SSE-KMS)   ├─ S3 audit (Object Lock)
                      ├─ DynamoDB: quota, usage ledger, sessions, oauth
                      ├─ Bedrock (Claude Haiku/Sonnet 5.5 qua us.*, Guardrails, Titan Embed v2; Stable Image ở us-west-2)
                      ├─ Lambda sandbox: subnet cô lập, chỉ ra được S3 bằng HTTPS, role không có quyền dữ liệu
                      └─ Step Functions agent: plan → chờ user xác nhận → execute → notify
Vận hành: CloudWatch alarms + dashboard, SNS email, Budget $50, anomaly monitor theo tag, AWS Backup (bản sao sang us-west-2)
```
Bản prod trong báo giá dùng cùng các thành phần đó, cộng thêm ALB + ECS Fargate + NAT + WAF + CloudFront. Các phần này đã có module Terraform (`infra/modules/lb`, `edge`) và bật bằng `demo_mode` / `edge_enabled`.

## Trạng thái kiểm thử E2E (`python scripts/e2e.py`, kết quả ghi ở `docs/e2e-results.json`)
19/21 check đạt ở lần chạy gần nhất (trước khi có check RBAC của trang Quản trị, nay tổng cộng 22 check):
- SSO + MFA, chặn request thiếu token hoặc token giả.
- Upload, index, RAG.
- Cô lập A/B: danh sách file, tải file, ingest, kết quả tìm kiếm.
- Tài liệu chứa prompt injection bị cách ly.
- Sandbox: chạy pandas, xuất XLSX, không có AWS credential, không ra được Internet hay metadata endpoint, có timeout.
- Ghi sổ chi phí theo user.

2 check còn lỗi đều cần gọi được LLM (chat và bước lập kế hoạch của agent).

## Việc chặn bên phía AWS (cần chủ account xử lý)
1. **Bedrock:** mọi model trả `NOT_AUTHORIZED / Operation not allowed`. Cần mở case AWS Support (Account and billing) xin verify account, và gửi form use-case Anthropic trong Bedrock → Model access.
2. **CloudFront:** báo "account must be verified". Sau khi được verify thì đặt `edge_enabled = true`.

Cách tạm thời: đặt `llm_provider = "anthropic"` và `anthropic_api_key = "..."` trong `terraform.tfvars` (key lưu trong Secrets Manager), rồi plan/apply.

## Tài khoản và phân quyền
Không cho tự đăng ký. Tài khoản đầu tiên tạo bằng `scripts/add_user.py email phongban --admin` (nhóm `platform_admin`). Từ đó quản trị qua tab **Quản trị** trên web:

| Vai trò (nhóm Cognito) | Làm được |
|---|---|
| `user` | dùng VBot; không vào được trang Quản trị |
| `unit_admin` | trong phòng ban của mình: thêm người dùng thường, khoá/mở khoá, gửi lại thư mời; xem chi phí phòng ban |
| `platform_admin` | mọi phòng ban: thêm/sửa người dùng, đổi phòng ban và vai trò, đặt hạn mức tháng riêng cho từng phòng ban, đọc nhật ký audit |

Vai trò và trạng thái khoá được kiểm tra trực tiếp với Cognito ở mỗi lời gọi `/api/admin/*`, nên hạ quyền hoặc khoá có hiệu lực ngay ở trang Quản trị. Các API thường vẫn tin ID token tới khi nó hết hạn (tối đa 60 phút); khi khoá hoặc đổi phòng ban, hệ thống thu hồi refresh token để người dùng phải đăng nhập lại. Mọi thao tác quản trị, kể cả việc đọc nhật ký, đều được ghi vào bucket audit (Object Lock).

## Kiểm thử tự động
```powershell
cd app; ..\.venv\Scripts\python -m pytest tests -q        # API: RBAC quản trị, hạn mức, JWT, định tuyến model, governance, phục vụ SPA
cd frontend; npm run build; npm run test:e2e                # UI: Playwright với API giả lập (đăng nhập, chat, xoá hai bước, quản trị, mobile)
```
Test API dùng moto giả lập Cognito, DynamoDB và S3 (`pip install -r app/requirements-dev.txt`). Phần cần Aurora Data API và model thật vẫn do `scripts/e2e.py` kiểm tra trên môi trường đã deploy.

## CI/CD (GitHub Actions, OIDC, không lưu access key)
| Workflow | Khi nào | Làm gì |
|---|---|---|
| `ci` | mọi PR và push lên `main` | ruff + import smoke + test API (pytest, moto); typecheck, build và test UI (Playwright) cho `frontend/`; build báo giá và chạy validator của đề; `terraform fmt`/`validate`; `terraform plan` bằng role chỉ đọc `vbot-github-plan` (kết quả ở Job summary) |
| `deploy` | sau khi `ci` xanh trên `main`, hoặc chạy tay | chờ duyệt ở environment **production**, sau đó assume `vbot-github-deploy`: build artifact, plan, apply, migrate, smoke test (`/api/health`, `/api/config`, `/api/me` trả 401) |

Role deploy chỉ tin token OIDC của repo `vuhuyng04/VBot_Workplace` khi chạy trong environment `production` (Terraform: `infra/modules/cicd`).
GitHub variables: `AWS_PLAN_ROLE_ARN`, `AWS_DEPLOY_ROLE_ARN`. Secret: `ALERT_EMAIL`.

## Vận hành (local)
```powershell
$env:AWS_PROFILE = "root"; copy infra/envs/mvp/terraform.tfvars.example infra/envs/mvp/terraform.tfvars
.venv/Scripts/python scripts/build.py            # build dist/app.zip + dist/sandbox.zip (arm64, không cần Docker; cần Node ≥ 20.9 để build UI)
terraform -chdir=infra/envs/mvp plan -out=x.tfplan; terraform -chdir=infra/envs/mvp apply x.tfplan
.venv/Scripts/python scripts/migrate.py          # schema + RLS (chạy lại được nhiều lần)
.venv/Scripts/python scripts/add_user.py a@cty.vn phongban [--admin]
.venv/Scripts/python scripts/e2e.py              # kiểm thử end-to-end
```
**Giao diện (`frontend/`, Next.js):** `next build` xuất site tĩnh ra `frontend/out`, `build.py` đóng gói thư mục đó và FastAPI phục vụ cùng Lambda với `/api`. Sửa UI ở local: chạy API bằng uvicorn ở cổng 8000, sau đó `cd frontend; npm ci; npm run dev`. Dev server chuyển tiếp `/api` sang `VBOT_API` (mặc định `http://127.0.0.1:8000`).

**Chi phí MVP khi nhàn rỗi:** khoảng $9/tháng (4 khóa KMS, 2 secret, alarm, dashboard, lưu trữ). Mọi phần khác trả theo request. Các thành phần tính phí theo giờ (NAT, ALB, Fargate, WAF) chỉ bật khi `demo_mode = true`.
Credit còn lại khi bắt đầu: $189.49 (xem bằng `aws freetier get-account-plan-state`, cần CLI ≥ 2.27).
Sau khoảng 24h, đặt `activate_cost_tags = true` để Cost Explorer tách chi phí theo tag `component` (trùng với mã component trong báo giá).
