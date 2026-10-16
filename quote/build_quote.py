"""Build the VBot quote (XLSX + summary) from assumptions.yaml and prices.json.

Outputs (quote/out/):
  G03_baogia.xlsx  sheets BaoGia, BangChung (graded) + TaiTinh, DonGia (transparency)
  summary.json     totals, per-component, top items, savings levers (used by slides and web)

Usage: .venv/Scripts/python quote/build_quote.py
"""
import copy
import datetime as dt
import json
import pathlib

import yaml
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

HERE = pathlib.Path(__file__).parent
OUT_DIR = HERE / "out"
COLUMNS = ["Component", "Ý nghĩa", "Ghi chú", "Chi phí/tháng (USD)", "Bằng chứng"]


def n(x, d=0):
    """Format a number for notes: thousands with '.', decimals with ',' (Vietnamese)."""
    s = f"{x:,.{d}f}"
    return s.replace(",", "_").replace(".", ",").replace("_", ".")


def usd(x):
    return f"{x:,.2f}".replace(",", "_").replace(".", ",").replace("_", ".")


class Model:
    """Computes sizing and quote lines for one set of assumptions."""

    def __init__(self, A, P):
        self.A, self.P = A, P
        self.lines, self.sizing, self.used = [], [], []

    def p(self, key):
        if key not in self.used:
            self.used.append(key)
        return self.P[key]["usd"]

    def size(self, metric, value, formula, unit=""):
        self.sizing.append((metric, value, unit, formula))
        return value

    def line(self, comp, meaning, note, cost, keys):
        for k in keys:
            self.p(k)
        self.lines.append({"component": comp, "y_nghia": meaning, "ghi_chu": note,
                           "chi_phi": round(cost, 2), "keys": keys})
        return cost

    # ---------- LLM ----------
    def llm_input_cost(self, tokens, cached, model):
        w = min(self.A["llm"]["cache_write_share"], 1 - cached)
        normal = 1 - cached - w
        return tokens * (normal * self.p(f"{model}_in") + cached * self.p(f"{model}_cache_read")
                         + w * self.p(f"{model}_cache_write")) / 1e6

    def run(self):
        A, U = self.A, self.A["users"]
        ud = self.size("Ngày-người mỗi tháng", U["dau"] * U["workdays"], "DAU × ngày làm việc")
        tiers = A["tiers"]
        req_by_tier = {k: t["req"] * ud for k, t in tiers.items()}
        total_req = self.size("Request mỗi tháng", sum(req_by_tier.values()),
                              "Σ (request/người/ngày theo cấp) × ngày-người")
        req_day = total_req / U["workdays"]
        peak_rps = self.size("Request/giây giờ cao điểm", req_day * U["peak_hour_share"] / 3600,
                             f"request/ngày × {U['peak_hour_share']} / 3600 giây")
        self.size("Request/người/ngày", total_req / ud, "tổng các cấp")

        # Token volumes per model
        vol = {"haiku": {"in": 0, "out": 0, "cost_in": 0}, "sonnet": {"in": 0, "out": 0, "cost_in": 0}}
        for k, t in tiers.items():
            calls = req_by_tier[k] * t["steps"]
            tin, tout = calls * t["in"], calls * t["out"]
            self.size(f"{t['name']}: lượt gọi LLM", calls, f"{t['req']} req × {t['steps']} bước × ngày-người")
            self.size(f"{t['name']}: token vào/ra (triệu)", f"{n(tin / 1e6)} / {n(tout / 1e6)}",
                      f"lượt × {t['in']} vào, × {t['out']} ra")
            for model, share in (("haiku", t["haiku"]), ("sonnet", 1 - t["haiku"])):
                vol[model]["in"] += tin * share
                vol[model]["out"] += tout * share
                vol[model]["cost_in"] += self.llm_input_cost(tin * share, t["cached"], model)
        L = A["llm"]
        r_calls = total_req * L["router_llm_share"]
        vol["haiku"]["in"] += r_calls * L["router_in"]
        vol["haiku"]["out"] += r_calls * L["router_out"]
        vol["haiku"]["cost_in"] += r_calls * L["router_in"] * self.p("haiku_in") / 1e6
        peak_out_tps = (vol["haiku"]["out"] + vol["sonnet"]["out"]) / U["workdays"] * U["peak_hour_share"] / 3600
        self.size("Token ra/giây giờ cao điểm", peak_out_tps, "token ra/ngày × tỉ lệ giờ cao điểm / 3600")

        for model, label, pin, pout in (("haiku", "Claude Haiku 5.5", "haiku_in", "haiku_out"),
                                        ("sonnet", "Claude Sonnet 5.5", "sonnet_in", "sonnet_out")):
            v = vol[model]
            c_out = v["out"] * self.p(pout) / 1e6
            share_txt = "cấp 1–4 sau routing + router phân loại" if model == "haiku" else "phần khó cấp 1–4 + cấp 5"
            self.line("llm", f"Bedrock {label} ({share_txt}), prod",
                      f"us-east-1, inference profile us.*. Vào {n(v['in'] / 1e6)}M token × {self.P[pin]['usd']} USD/1M "
                      f"(có prompt cache: đọc {self.P[model + '_cache_read']['usd']}, ghi {self.P[model + '_cache_write']['usd']}) = {usd(v['cost_in'])}; "
                      f"ra {n(v['out'] / 1e6)}M × {self.P[pout]['usd']} USD/1M = {usd(c_out)}",
                      v["cost_in"] + c_out, [pin, model + "_cache_read", model + "_cache_write", pout])

        t5 = tiers["t5_design"]
        imgs = req_by_tier["t5_design"] * t5["images"]
        self.size("Ảnh sinh mỗi tháng", imgs, f"request cấp 5 × {t5['images']} ảnh")
        self.line("llm", "Sinh ảnh cấp 5 (Stable Image Core trên Bedrock us-west-2, region duy nhất có text-to-image)",
                  f"us-west-2: {n(imgs)} ảnh × {self.P['image_core']['usd']} USD/ảnh; chỉ gửi prompt mô tả, không gửi tài liệu; sơ đồ, mockup dạng SVG/HTML do LLM viết nên không tính ảnh",
                  imgs * self.p("image_core"), ["image_core"])

        E = L["eval"]
        e_calls = E["runs_per_month"] * E["cases"]
        e_cost = e_calls * (E["in"] * (self.p("haiku_in") + self.p("sonnet_in")) + E["out"] * (self.p("haiku_out") + self.p("sonnet_out"))) / 1e6
        self.line("llm", "Cổng eval trên staging (Haiku và Sonnet so với bộ chấm)",
                  f"staging: {E['runs_per_month']} lần/tháng × {n(E['cases'])} case × cả 2 model; mỗi case {E['in']} token vào, {E['out']} ra",
                  e_cost, ["haiku_in", "haiku_out", "sonnet_in", "sonnet_out"])

        # ---------- Embedding ----------
        Em = A["embedding"]
        corpus = U["dau"] * Em["docs_per_user"] * Em["chunks_per_doc"] * Em["tokens_per_chunk"]
        self.size("Token kho tài liệu (triệu)", corpus / 1e6, "DAU × tài liệu × chunk × token/chunk")
        reindex = corpus * Em["monthly_change"]
        query = total_req * Em["rag_share"] * Em["query_tokens"]
        c_emb = reindex / 1e3 * self.p("embed_titan_v2_batch") + corpus / 12 / 1e3 * self.p("embed_titan_v2_batch") \
            + query / 1e3 * self.p("embed_titan_v2")
        self.line("embedding", "Titan Text Embeddings v2 (512 chiều) cho index và truy vấn RAG",
                  f"index lại {n(reindex / 1e6)}M token/tháng + index đầu {n(corpus / 1e6)}M chia 12 tháng, batch {self.P['embed_titan_v2_batch']['usd']} USD/1K; "
                  f"truy vấn {n(query / 1e6, 1)}M token × {self.P['embed_titan_v2']['usd']} USD/1K; không dùng rerank trả phí (hybrid search trong Postgres)",
                  c_emb, ["embed_titan_v2_batch", "embed_titan_v2"])

        # ---------- Compute ----------
        C = A["compute"]
        task_h = C["app_task_vcpu"] * self.p("fargate_arm_vcpu_h") + C["app_task_gb"] * self.p("fargate_arm_gb_h")
        th = C["app_tasks_always"] * U["month_hours"] + C["app_tasks_peak_extra"] * U["business_hours"]
        self.line("compute", "ECS Fargate ARM: web API, LLM gateway, RAG, authz (prod, multi-AZ)",
                  f"task {C['app_task_vcpu']} vCPU/{C['app_task_gb']} GB = {task_h:.5f} USD/giờ; {C['app_tasks_always']} task (1 mỗi AZ) × {U['month_hours']} giờ "
                  f"+ {C['app_tasks_peak_extra']} task × {U['business_hours']} giờ hành chính = {n(th)} task-giờ",
                  th * task_h, ["fargate_arm_vcpu_h", "fargate_arm_gb_h"])
        st_h = C["staging_task_vcpu"] * self.p("fargate_arm_vcpu_h") + C["staging_task_gb"] * self.p("fargate_arm_gb_h")
        self.line("compute", "ECS Fargate ARM cho staging",
                  f"staging: 1 task {C['staging_task_vcpu']} vCPU/{C['staging_task_gb']} GB × {C['staging_hours']} giờ × {st_h:.5f} USD/giờ, tắt ngoài giờ",
                  C["staging_hours"] * st_h, ["fargate_arm_vcpu_h", "fargate_arm_gb_h"])
        t4 = tiers["t4_agent"]
        ag_runs = req_by_tier["t4_agent"]
        ag_gbs = ag_runs * t4["steps"] * 10 * 1.0
        self.line("compute", "Lambda ARM chạy từng bước agent nền (Step Functions gọi)",
                  f"{n(ag_runs)} lượt agent × {t4['steps']} bước × 10 giây × 1 GB = {n(ag_gbs)} GB-giây × {self.P['lambda_arm_gb_s']['usd']:.8f}; "
                  f"+ {n(ag_runs * t4['steps'])} request × {self.P['lambda_arm_req']['usd']}",
                  ag_gbs * self.p("lambda_arm_gb_s") + ag_runs * t4["steps"] * self.p("lambda_arm_req"),
                  ["lambda_arm_gb_s", "lambda_arm_req"])

        # ---------- Gateway / LB / Auth ----------
        self.line("gateway", "LLM gateway: quota theo người và đơn vị, rate limit, retry, fallback model, ghi token và USD",
                  "Module trong service app, chi phí nằm trong dòng compute ECS Fargate (prod)", 0,
                  ["fargate_arm_vcpu_h"])
        lb_cost = U["month_hours"] * self.p("alb_h") + U["month_hours"] * 1 * self.p("alb_lcu_h")
        self.line("load_balancer", "Application Load Balancer multi-AZ, TLS, health check, SSE streaming (prod + staging theo host rule)",
                  f"{U['month_hours']} giờ × {self.P['alb_h']['usd']} USD + trung bình 1 LCU × {U['month_hours']} giờ × {self.P['alb_lcu_h']['usd']} USD; staging dùng chung ALB, target group riêng",
                  lb_cost, ["alb_h", "alb_lcu_h"])
        self.line("authn", "Amazon Cognito liên kết SSO tập đoàn (SAML/OIDC), MFA do IdP tập đoàn bắt buộc",
                  f"{n(U['mau'])} MAU người dùng liên kết × {self.P['cognito_enterprise_mau']['usd']} USD/MAU (giá trả phí, user pool dùng cho prod và staging)",
                  U["mau"] * self.p("cognito_enterprise_mau"), ["cognito_enterprise_mau"])
        self.line("authz", "RBAC/ABAC bằng Cedar trong app + Row-Level Security Postgres + ACL gốc đồng bộ từ connector",
                  "Thư viện Cedar chạy trong service app, chi phí nằm trong dòng compute ECS Fargate; RLS nằm trong database Aurora", 0,
                  ["fargate_arm_vcpu_h"])

        # ---------- Database / vector ----------
        D = A["database"]
        acu_h = D["instances"] * (D["acu_business"] * U["business_hours"] + D["acu_offhours"] * (U["month_hours"] - U["business_hours"]))
        io = total_req * D["io_per_req"]
        db_cost = acu_h * self.p("aurora_acu_h") + D["storage_gb"] * self.p("aurora_storage_gb") + io * self.p("aurora_io")
        self.line("database", "Aurora PostgreSQL Serverless v2 multi-AZ (writer + reader khác AZ): user, chat, memory, metadata",
                  f"{D['instances']} instance × ({D['acu_business']} ACU × {U['business_hours']} giờ + {D['acu_offhours']} ACU × {U['month_hours'] - U['business_hours']} giờ) = {n(acu_h)} ACU-giờ × {self.P['aurora_acu_h']['usd']}; "
                  f"{D['storage_gb']} GB × {self.P['aurora_storage_gb']['usd']}; {n(io / 1e6)}M I/O × 0,20 USD/1M",
                  db_cost, ["aurora_acu_h", "aurora_storage_gb", "aurora_io"])
        st_db = D["staging_acu"] * U["business_hours"] * self.p("aurora_acu_h") + D["staging_storage_gb"] * self.p("aurora_storage_gb")
        self.line("database", "Aurora Serverless v2 cho staging (tự tạm dừng khi rảnh)",
                  f"staging: {D['staging_acu']} ACU × {U['business_hours']} giờ × {self.P['aurora_acu_h']['usd']} + {D['staging_storage_gb']} GB × {self.P['aurora_storage_gb']['usd']}",
                  st_db, ["aurora_acu_h", "aurora_storage_gb"])
        chunks = U["dau"] * Em["docs_per_user"] * Em["chunks_per_doc"]
        self.size("Số vector", chunks, "DAU × tài liệu × chunk")
        self.line("vector_db", "pgvector (HNSW, halfvec 512 chiều) trong Aurora, lọc theo user_id và ACL trước khi xếp hạng",
                  f"{n(chunks / 1e6)}M vector; dung lượng và ACU nằm trong dòng database Aurora (prod)", 0,
                  ["aurora_storage_gb"])

        # ---------- Object storage ----------
        S = A["storage"]
        gb = U["dau"] * S["workspace_gb_per_user"]
        objs = U["dau"] * S["objects_per_user"]
        s3_store = gb * ((1 - S["ia_share"]) * self.p("s3_int_fa_gb") + S["ia_share"] * self.p("s3_int_ia_gb"))
        self.line("object_storage", "S3 Intelligent-Tiering: workspace riêng (prefix theo user, SSE-KMS, ABAC), quota 10 GB/người",
                  f"{n(gb)} GB ({S['workspace_gb_per_user']} GB/người trung bình): {int((1 - S['ia_share']) * 100)}% × {self.P['s3_int_fa_gb']['usd']} + {int(S['ia_share'] * 100)}% × {self.P['s3_int_ia_gb']['usd']} USD/GB; "
                  f"giám sát {n(objs / 1e6, 1)}M object × {self.P['s3_int_monitor_obj']['usd'] * 1000} USD/1.000",
                  s3_store + objs * self.p("s3_int_monitor_obj"), ["s3_int_fa_gb", "s3_int_ia_gb", "s3_int_monitor_obj"])
        puts, gets = total_req * S["puts_per_req"], total_req * S["gets_per_req"]
        self.line("object_storage", "Request S3 cho workspace (đọc, ghi file)",
                  f"{n(puts / 1e6, 2)}M PUT × 0,005 USD/1.000 + {n(gets / 1e6, 2)}M GET × 0,0004 USD/1.000",
                  puts * self.p("s3_put") + gets * self.p("s3_get"), ["s3_put", "s3_get"])

        # ---------- Cache / queue ----------
        Q = A["cache_queue"]
        wru, rru = total_req * Q["ddb_writes_per_req"], total_req * Q["ddb_reads_per_req"]
        self.line("cache_queue", "DynamoDB on-demand: phiên, cache kết quả, bộ đếm quota, OAuth token đã mã hóa",
                  f"{n(wru / 1e6, 1)}M WRU × 0,625 USD/1M + {n(rru / 1e6, 1)}M RRU × 0,125 USD/1M + {Q['ddb_storage_gb']} GB × {self.P['ddb_storage_gb']['usd']} USD (giá trả phí)",
                  wru * self.p("ddb_wru") + rru * self.p("ddb_rru") + Q["ddb_storage_gb"] * self.p("ddb_storage_gb"),
                  ["ddb_wru", "ddb_rru", "ddb_storage_gb"])
        msgs = total_req * Q["sqs_msgs_per_req"]
        trans = ag_runs * Q["sfn_transitions_per_agent"]
        self.line("cache_queue", "SQS hàng đợi tác vụ + Step Functions điều phối agent nền (retry, hủy, thông báo)",
                  f"{n(msgs / 1e6, 2)}M message × 0,40 USD/1M; {n(ag_runs)} lượt agent × {Q['sfn_transitions_per_agent']} chuyển trạng thái × 0,025 USD/1.000",
                  msgs * self.p("sqs_req") + trans * self.p("sfn_transition"), ["sqs_req", "sfn_transition"])

        # ---------- Sandbox ----------
        Sb = A["sandbox"]
        runs = (req_by_tier["t3_data_code"] * tiers["t3_data_code"]["sandbox_runs"]
                + req_by_tier["t4_agent"] * tiers["t4_agent"]["sandbox_runs"]
                + req_by_tier["t2_docs"] * L["doc_export_runs_per_t2"])
        self.size("Lượt sandbox mỗi tháng", runs, "cấp 3 × 2 + cấp 4 × 1 + cấp 2 × 0,5 xuất file")
        gbs = runs * Sb["memory_gb"] * Sb["avg_seconds"]
        self.line("sandbox", "Lambda ARM (Firecracker microVM) chạy code agent: subnet không egress, chỉ mount prefix S3 của đúng user, hủy sau khi chạy",
                  f"{n(runs)} lượt × {Sb['memory_gb']} GB × {Sb['avg_seconds']} giây = {n(gbs)} GB-giây × {self.P['lambda_arm_gb_s']['usd']:.8f} + request × 0,20 USD/1M; timeout 300 giây",
                  gbs * self.p("lambda_arm_gb_s") + runs * self.p("lambda_arm_req"), ["lambda_arm_gb_s", "lambda_arm_req"])

        # ---------- Connectors ----------
        Cn = A["connectors"]
        sync = U["dau"] * Cn["count"] * Cn["sync_per_user_day"] * U["workdays"]
        live = total_req * Cn["live_calls_per_req"]
        cgbs = sync * Cn["memory_gb"] * Cn["avg_seconds"] + live * Cn["memory_gb"] * Cn["live_seconds"]
        self.line("connectors", "Lambda connector Google Workspace, Microsoft 365, Jira/Confluence, Notion (OAuth ủy nhiệm từng user, webhook + đồng bộ delta)",
                  f"đồng bộ {n(sync / 1e6, 2)}M lượt ({Cn['count']} connector × {Cn['sync_per_user_day']}/người/ngày) × {Cn['memory_gb']} GB × {Cn['avg_seconds']} giây + gọi trực tiếp {n(live / 1e6, 2)}M × {Cn['live_seconds']} giây = {n(cgbs)} GB-giây; chạy ngoài VPC nên không qua NAT",
                  cgbs * self.p("lambda_arm_gb_s") + (sync + live) * self.p("lambda_arm_req"), ["lambda_arm_gb_s", "lambda_arm_req"])

        # ---------- Secrets / KMS ----------
        Se = A["security"]
        kreq = total_req * Se["kms_req_per_req"]
        self.line("secrets_kms", "KMS customer managed key (workspace, OAuth token, audit, DB) + Secrets Manager cho secret hệ thống",
                  f"{Se['kms_keys']} khóa × 1 USD + {n(kreq / 1e6, 2)}M request × 0,03 USD/10.000; {Se['secrets']} secret × 0,40 USD; OAuth token người dùng mã hóa envelope trong DynamoDB",
                  Se["kms_keys"] * self.p("kms_key") + kreq * self.p("kms_req") + Se["secrets"] * self.p("secret"),
                  ["kms_key", "kms_req", "secret"])

        # ---------- Governance ----------
        G = A["governance"]
        tu_in = total_req * G["untrusted_share"] * G["untrusted_text_units"]
        tu_out = total_req * G["output_pii_share"] * G["output_text_units"]
        self.line("governance", "Bedrock Guardrails: chống prompt injection trên nội dung connector + che PII ở đầu ra ghi ra ngoài",
                  f"{n(tu_in / 1e6, 2)}M text unit × {self.P['guard_prompt_attack']['usd']} (prompt attack) + {n(tu_out / 1e6, 2)}M × {self.P['guard_pii']['usd']} (PII); chỉ quét nội dung không tin cậy, không quét toàn context",
                  tu_in * self.p("guard_prompt_attack") + tu_out * self.p("guard_pii"), ["guard_prompt_attack", "guard_pii"])
        audit_gb = total_req * G["audit_kb_per_req"] / 1e6
        audit_store = audit_gb * G["audit_retention_months"]
        self.line("governance", "Audit log 12 tháng: S3 Object Lock, lớp Glacier Instant Retrieval",
                  f"{n(audit_gb, 1)} GB/tháng × {G['audit_retention_months']} tháng = {n(audit_store)} GB × {self.P['s3_gir_gb']['usd']} USD/GB khi đủ 12 tháng; ghi theo lô mỗi phút",
                  audit_store * self.p("s3_gir_gb") + 44000 * self.p("s3_put"), ["s3_gir_gb", "s3_put"])

        # ---------- Network ----------
        N = A["network"]
        self.line("network", "NAT Gateway 2 AZ cho task app gọi AWS API (KMS, SQS, Secrets, Logs, ECR)",
                  f"{N['nat_gateways']} NAT (1 mỗi AZ, HA) × {U['month_hours']} giờ × {self.P['nat_h']['usd']} + {N['nat_gb']} GB × {self.P['nat_gb']['usd']}; S3 và DynamoDB đi qua gateway endpoint",
                  N["nat_gateways"] * U["month_hours"] * self.p("nat_h") + N["nat_gb"] * self.p("nat_gb"), ["nat_h", "nat_gb"])
        self.line("network", "VPC interface endpoint bedrock-runtime (private endpoint tới API model, H1)",
                  f"{N['bedrock_endpoint_azs']} AZ × {U['month_hours']} giờ × {self.P['vpce_h']['usd']} + {N['vpce_gb']} GB × {self.P['vpce_gb']['usd']}",
                  N["bedrock_endpoint_azs"] * U["month_hours"] * self.p("vpce_h") + N["vpce_gb"] * self.p("vpce_gb"), ["vpce_h", "vpce_gb"])
        wreq = total_req * N["waf_requests_per_req"]
        self.line("network", "AWS WAF trước ALB (managed rules, rate limit)",
                  f"1 web ACL × 5 USD + {N['waf_rules']} rule × 1 USD + {n(wreq / 1e6, 2)}M request × 0,60 USD/1M",
                  self.p("waf_acl") + N["waf_rules"] * self.p("waf_rule") + wreq * self.p("waf_req"), ["waf_acl", "waf_rule", "waf_req"])
        eg = U["dau"] * N["egress_gb_per_user_day"] * U["workdays"]
        self.line("network", "Data transfer ra Internet (stream câu trả lời, tải file)",
                  f"{n(eg)} GB = {U['dau']} người × {N['egress_gb_per_user_day'] * 1000:.0f} MB/ngày × {U['workdays']} ngày × {self.P['egress_gb']['usd']} USD/GB",
                  eg * self.p("egress_gb"), ["egress_gb"])

        # ---------- Monitoring ----------
        O = A["observability"]
        logs = total_req * O["log_kb_per_req"] / 1e6
        traces = total_req * O["trace_sample"]
        mon = (logs * self.p("cw_logs_ingest_gb") + logs * O["log_retention_months"] * self.p("cw_logs_store_gb")
               + O["custom_metrics"] * self.p("cw_metric") + O["alarms"] * self.p("cw_alarm") + traces * self.p("xray_trace"))
        self.line("monitoring", "CloudWatch log, metric (token, USD theo user và đơn vị, TTFT), alarm, X-Ray trace",
                  f"log {n(logs, 1)} GB × 0,50 + lưu {O['log_retention_months']} tháng × 0,03; {O['custom_metrics']} metric × 0,30; {O['alarms']} alarm × 0,10; {n(traces)} trace (lấy mẫu {int(O['trace_sample'] * 100)}%) × 5 USD/1M",
                  mon, ["cw_logs_ingest_gb", "cw_logs_store_gb", "cw_metric", "cw_alarm", "xray_trace"])

        # ---------- Backup / DR ----------
        B = A["backup"]
        self.line("backup_dr", "Bản sao snapshot Aurora sang us-west-2 (DR khi mất region); PITR 7 ngày trong us-east-1 cho RPO 1 giờ",
                  f"{B['aurora_snapshot_gb_usw2']} GB × {self.P['aurora_backup_gb_usw2']['usd']} USD/GB-tháng (us-west-2) + truyền {B['aurora_snapshot_gb_usw2']} GB × {self.P['xregion_gb']['usd']}; PITR nằm trong mức backup bằng dung lượng cluster của Aurora",
                  B["aurora_snapshot_gb_usw2"] * (self.p("aurora_backup_gb_usw2") + self.p("xregion_gb")),
                  ["aurora_backup_gb_usw2", "xregion_gb"])
        self.line("backup_dr", "S3 Cross-Region Replication workspace sang us-west-2, lớp Glacier Instant Retrieval; versioning chống xóa nhầm",
                  f"{n(B['s3_replicated_gb'])} GB × {self.P['s3_gir_gb']['usd']} + {B['s3_new_gb_month']} GB mới/tháng × {self.P['xregion_gb']['usd']} truyền liên region",
                  B["s3_replicated_gb"] * self.p("s3_gir_gb") + B["s3_new_gb_month"] * self.p("xregion_gb"), ["s3_gir_gb", "xregion_gb"])

        # ---------- CI/CD ----------
        Ci = A["cicd"]
        self.line("cicd", "CodeBuild ARM (build, test, eval smoke, terraform plan) + ECR registry; IaC Terraform cho prod và staging",
                  f"{n(Ci['build_minutes'])} phút × {self.P['codebuild_arm_small_min']['usd']} USD + {Ci['ecr_gb']} GB image × {self.P['ecr_gb']['usd']} USD",
                  Ci["build_minutes"] * self.p("codebuild_arm_small_min") + Ci["ecr_gb"] * self.p("ecr_gb"),
                  ["codebuild_arm_small_min", "ecr_gb"])

        # ---------- Ops ----------
        Op = A["ops"]
        self.lines.append({"component": "ops_labor", "y_nghia": "Kỹ sư SRE/MLOps vận hành nền tảng, trực giờ hành chính",
                           "ghi_chu": f"{Op['fte']} FTE × {n(Op['usd_per_fte_month'])} USD/tháng (lương, bảo hiểm, phụ cấp tại Việt Nam); on-call ngoài giờ luân phiên với đội platform sẵn có",
                           "chi_phi": round(Op["fte"] * Op["usd_per_fte_month"], 2), "keys": []})
        self.total_req, self.peak_rps = total_req, peak_rps
        return self


def build(A, P):
    return Model(A, P["prices"]).run()


def levers(A, P, base_total):
    """Each lever = what the bill would be without that optimisation."""
    def total(mut):
        a = copy.deepcopy(A)
        mut(a)
        return sum(l["chi_phi"] for l in build(a, P).lines)

    def no_routing(a):
        for t in a["tiers"].values():
            t["haiku"] = 0.0
        a["llm"]["router_llm_share"] = 0

    def no_cache(a):
        for t in a["tiers"].values():
            t["cached"] = 0.0
        a["llm"]["cache_write_share"] = 0

    def always_on(a):
        a["compute"]["app_tasks_always"] += a["compute"]["app_tasks_peak_extra"]
        a["compute"]["app_tasks_peak_extra"] = 0
        a["compute"]["staging_hours"] = a["users"]["month_hours"]
        a["database"]["acu_offhours"] = a["database"]["acu_business"]

    def guard_all(a):
        a["governance"]["untrusted_share"] = 1.0
        a["governance"]["untrusted_text_units"] = 15
        a["governance"]["output_pii_share"] = 1.0

    def all_images(a):
        a["tiers"]["t5_design"]["images"] = 4

    out = []
    for name, fn, how in [
        ("Routing Haiku 5.5 / Sonnet 5.5", no_routing, "nếu mọi lượt dùng Sonnet 5.5"),
        ("Prompt caching", no_cache, "nếu không dùng prompt cache"),
        ("Scale theo giờ hành chính", always_on, "nếu app, staging, Aurora chạy mức cao 24/7"),
        ("Guardrail chỉ trên nội dung không tin cậy", guard_all, "nếu quét toàn bộ context mọi request"),
        ("Sơ đồ/mockup bằng SVG thay ảnh", all_images, "nếu mỗi request cấp 5 sinh 4 ảnh"),
    ]:
        t = total(fn)
        out.append({"lever": name, "without": round(t, 2), "saving": round(t - base_total, 2), "how": how})
    return out


def write_xlsx(m, P, path):
    wb = Workbook()
    ws = wb.active
    ws.title = "BaoGia"
    ws.append(COLUMNS)
    ev_ids = {k: f"E{i + 1:02d}" for i, k in enumerate(m.used)}
    for l in m.lines:
        refs = [ev_ids[k] for k in l["keys"]]
        if refs:
            refs.append(P["prices"][l["keys"][0]]["page"])
        ws.append([l["component"], l["y_nghia"], l["ghi_chu"], l["chi_phi"], "; ".join(refs) if refs else "NA"])
    total = round(sum(l["chi_phi"] for l in m.lines), 2)
    ws.append(["TOTAL", "Tổng chi phí hạ tầng và vận hành mỗi tháng", f"{len(m.lines)} dòng; {usd(total / m.A['users']['dau'])} USD/DAU", total, ""])
    widths = [16, 60, 110, 20, 60]
    for i, w in enumerate(widths):
        ws.column_dimensions[chr(65 + i)].width = w
    for c in ws[1]:
        c.font = Font(bold=True)
        c.fill = PatternFill("solid", fgColor="D9EDF6")
    for row in ws.iter_rows(min_row=2):
        row[3].number_format = "#,##0.00"
        for c in row:
            c.alignment = Alignment(wrap_text=True, vertical="top")

    ev = wb.create_sheet("BangChung")
    ev.append(["evidence_id", "mo_ta", "link", "ngay_chup", "anh"])
    day = P["fetched_at"][:10]
    for k, eid in ev_ids.items():
        p = P["prices"][k]
        ev.append([eid, f"{p['service_code']} | {p['usagetype']} | SKU {p['sku']} | {p['usd']} USD / {p['unit']} | us-east-1 On-Demand | AWS Price List API: {p['offer_file']}",
                   p["page"], day, ""])
    for i, w in enumerate([12, 120, 50, 12, 30]):
        ev.column_dimensions[chr(65 + i)].width = w

    sz = wb.create_sheet("TaiTinh")
    sz.append(["Chỉ số", "Giá trị", "Đơn vị", "Công thức"])
    for metric, value, unit, formula in m.sizing:
        sz.append([metric, round(value, 3) if isinstance(value, float) else value, unit, formula])
    for i, w in enumerate([45, 22, 10, 70]):
        sz.column_dimensions[chr(65 + i)].width = w

    dg = wb.create_sheet("DonGia")
    dg.append(["key", "service_code", "usagetype", "sku", "usd", "unit", "page", "offer_file"])
    for k in m.used:
        p = P["prices"][k]
        dg.append([k, p["service_code"], p["usagetype"], p["sku"], p["usd"], p["unit"], p["page"], p["offer_file"]])
    wb.save(path)
    return total


def main():
    A = yaml.safe_load((HERE / "assumptions.yaml").read_text(encoding="utf-8"))
    P = json.loads((HERE / "prices.json").read_text(encoding="utf-8"))
    m = build(A, P)
    OUT_DIR.mkdir(exist_ok=True)
    xlsx = OUT_DIR / f"{A['team']}_baogia.xlsx"
    total = write_xlsx(m, P, xlsx)

    by_comp = {}
    for l in m.lines:
        by_comp[l["component"]] = round(by_comp.get(l["component"], 0) + l["chi_phi"], 2)
    top = sorted(m.lines, key=lambda l: -l["chi_phi"])[:5]
    summary = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "prices_fetched_at": P["fetched_at"], "region": A["region"],
        "total_usd_month": total, "usd_per_dau": round(total / A["users"]["dau"], 2),
        "usd_per_request": round(total / m.total_req, 4), "requests_month": round(m.total_req),
        "peak_rps": round(m.peak_rps, 2),
        "by_component": dict(sorted(by_comp.items(), key=lambda x: -x[1])),
        "top5": [{"component": l["component"], "item": l["y_nghia"], "usd": l["chi_phi"]} for l in top],
        "levers": levers(A, P, total),
        "sizing": [{"metric": a, "value": b, "formula": d} for a, b, _, d in m.sizing],
        "lines": [{k: v for k, v in l.items() if k != "keys"} for l in m.lines],
    }
    (OUT_DIR / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"{xlsx.name}: TOTAL {total:,.2f} USD/tháng · {total / A['users']['dau']:.2f} USD/DAU · {len(m.lines)} dòng")
    for c, v in summary["by_component"].items():
        print(f"  {c:15} {v:>10,.2f}  {v / total * 100:5.1f}%")
    print("Đòn bẩy:")
    for lv in summary["levers"]:
        print(f"  {lv['lever']:42} tiết kiệm {lv['saving']:>10,.2f} ({lv['how']})")


if __name__ == "__main__":
    main()
