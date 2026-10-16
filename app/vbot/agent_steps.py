"""Step Functions task handlers for tier-4 background agents.

plan -> request_confirmation (.waitForTaskToken, user approves in the UI) -> execute -> notify.
Write actions run only after explicit approval (H4). Each handler is a Lambda entry point."""
import datetime as dt
import json

from . import governance, llm, quota
from .aws import client
from .config import settings
from .db import user_tx

PLAN_PROMPT = """Bạn là agent quản lý dự án. Lập kế hoạch ngắn cho mục tiêu dưới đây.
Trả về DUY NHẤT một JSON hợp lệ dạng:
{"summary": "...", "steps": ["..."], "actions": [{"type": "create_ticket"|"update_page"|"save_document", "title": "...", "body": "..."}]}
Tối đa 5 actions. Mọi action là hành động ghi, sẽ chờ người dùng xác nhận."""


def _update(user_id, run_id, **cols):
    sets = ", ".join(f"{k} = :{k}" if k != "plan" else "plan = CAST(:plan AS jsonb)" for k in cols)
    with user_tx(user_id) as tx:
        tx.run(f"UPDATE agent_runs SET {sets}, updated_at = now() WHERE id = CAST(:id AS uuid) AND user_id = :uid",
               id=run_id, uid=user_id, **cols)


def plan(event, _ctx=None):
    goal = event["goal"]
    scan = governance.scan_untrusted(goal)
    text, usage, usd = llm.complete("sonnet", "medium", [{"role": "user", "content": f"{PLAN_PROMPT}\n\nMục tiêu: {goal}"}],
                                    max_tokens=3000)
    start, end = text.find("{"), text.rfind("}")
    try:
        p = json.loads(text[start:end + 1])
    except Exception:
        p = {"summary": text[:500], "steps": [], "actions": [{"type": "save_document", "title": "Kế hoạch", "body": text}]}
    p["injection_flags"] = scan["heuristic"]
    quota.record(event["user_id"], event["department"], "agent.plan", "Claude Sonnet 5.5", usd,
                 usage.input_tokens, usage.output_tokens, tier="t4")
    _update(event["user_id"], event["run_id"], status="planned", plan=json.dumps(p, ensure_ascii=False), cost_usd=round(usd, 6))
    return {**event, "plan": p, "usd": usd}


def request_confirmation(event, _ctx=None):
    """Invoked with .waitForTaskToken: store the token; the API resumes the execution."""
    e = event["input"]
    _update(e["user_id"], e["run_id"], status="awaiting_confirmation", task_token=event["token"])
    governance.audit(e["user_id"], "agent.awaiting_confirmation", run_id=e["run_id"],
                     actions=[a.get("type") for a in e["plan"].get("actions", [])])
    return {"ok": True}


def execute(event, _ctx=None):
    """Connectors for Jira/Confluence/Notion act with the user's own OAuth token when connected;
    otherwise the action result is written to the user's workspace as a document."""
    s = settings()
    results = []
    for a in event["plan"].get("actions", [])[:5]:
        body = governance.mask_output(a.get("body", ""))
        name = f"agent-{event['run_id'][:8]}-{a.get('type', 'action')}.md"
        key = f"users/{event['user_id']}/files/agent-{event['run_id']}/{name}"
        content = f"# {a.get('title', '')}\n\nLoại: {a.get('type')}\n\n{body}\n"
        client("s3").put_object(Bucket=s.workspace_bucket, Key=key, Body=content.encode("utf-8"))
        with user_tx(event["user_id"]) as tx:
            tx.run("""INSERT INTO documents (id, user_id, source, s3_key, title) VALUES (gen_random_uuid(), :u, 'agent', :k, :t)""",
                   u=event["user_id"], k=key, t=name)
        results.append({"type": a.get("type"), "title": a.get("title"), "saved_as": name,
                        "connector": "chưa kết nối, đã lưu vào workspace"})
    governance.audit(event["user_id"], "agent.execute", run_id=event["run_id"], results=results)
    return {**event, "results": results}


def notify(event, _ctx=None):
    summary = "; ".join(f"{r['type']}: {r['title']}" for r in event.get("results", []))
    _update(event["user_id"], event["run_id"], status="done", result=f"Hoàn tất {dt.datetime.now(dt.timezone.utc):%H:%M} UTC. {summary}")
    return {"ok": True}


def on_reject(event, _ctx=None):
    _update(event["user_id"], event["run_id"], status="rejected", result="Người dùng từ chối kế hoạch; không có hành động nào được thực hiện.")
    return {"ok": True}


def on_error(event, _ctx=None):
    err = event.get("error", {})
    _update(event["user_id"], event["run_id"], status="failed", result=str(err.get("Cause", err))[:500])
    return {"ok": True}


HANDLERS = {"plan": plan, "request_confirmation": request_confirmation, "execute": execute,
            "notify": notify, "on_reject": on_reject, "on_error": on_error}


def handler(event, ctx):
    return HANDLERS[event["step"]](event["payload"], ctx)
