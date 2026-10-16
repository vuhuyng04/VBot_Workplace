"""VBot API (FastAPI). Runs unchanged on Lambda (Lambda Web Adapter, response streaming)
and on ECS Fargate behind the ALB."""
import base64
import datetime as dt
import json
import pathlib
import time
import uuid

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import governance, images, llm, quota, rag
from .auth import User, current_user
from .aws import client
from .config import settings
from .db import user_tx

app = FastAPI(title="VBot", docs_url=None, redoc_url=None)
HERE = pathlib.Path(__file__).parent
WEB = HERE / "web"
STARTED = time.time()


def log(**kv):
    print(json.dumps({"ts": dt.datetime.now(dt.timezone.utc).isoformat(), **kv}, ensure_ascii=False, default=str))


# ---------------------------------------------------------------- public
@app.get("/api/health")
def health():
    return {"ok": True, "uptime_s": round(time.time() - STARTED)}


@app.get("/api/config")
def public_config():
    s = settings()
    return {"region": s.region, "user_pool_id": s.user_pool_id, "client_id": s.client_id,
            "cognito_domain": s.cognito_domain, "llm_provider": s.llm_provider, "env": s.env}


@app.get("/api/transparency")
def transparency():
    """Quote for 2.000 DAU (from the generated summary) + live MVP spend by component tag."""
    summary = json.loads((HERE / "quote_summary.json").read_text(encoding="utf-8"))
    return {"quote": summary, "mvp": _mvp_costs()}


_cost_cache: dict = {}


def _mvp_costs():
    if _cost_cache.get("exp", 0) > time.time():
        return _cost_cache["data"]
    today = dt.date.today()
    start = today.replace(day=1)
    end = today + dt.timedelta(days=1)
    try:
        ce = client("ce")
        r = ce.get_cost_and_usage(
            TimePeriod={"Start": start.isoformat(), "End": end.isoformat()}, Granularity="MONTHLY",
            Metrics=["UnblendedCost"],
            Filter={"Tags": {"Key": "project", "Values": ["vbot"]}},
            GroupBy=[{"Type": "TAG", "Key": "component"}])
        groups = {g["Keys"][0].split("$", 1)[-1] or "(chưa gắn)": round(float(g["Metrics"]["UnblendedCost"]["Amount"]), 4)
                  for g in r["ResultsByTime"][0]["Groups"]}
        r2 = ce.get_cost_and_usage(
            TimePeriod={"Start": start.isoformat(), "End": end.isoformat()}, Granularity="MONTHLY",
            Metrics=["UnblendedCost"], GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}])
        services = {g["Keys"][0]: round(float(g["Metrics"]["UnblendedCost"]["Amount"]), 4)
                    for g in r2["ResultsByTime"][0]["Groups"] if float(g["Metrics"]["UnblendedCost"]["Amount"]) > 0.0001}
        data = {"period": f"{start}..{today}", "by_component": groups, "by_service": services,
                "total": round(sum(services.values()), 4), "note": "Chi phí thật của MVP (gross, trước credit), cập nhật mỗi giờ"}
    except Exception as e:
        data = {"error": str(e)[:200]}
    _cost_cache.update(exp=time.time() + 3600, data=data)
    return data


# ---------------------------------------------------------------- user
@app.get("/api/me")
def me(u: User = Depends(current_user)):
    with user_tx(u.user_id) as tx:
        tx.run("""INSERT INTO users (user_id, email, department) VALUES (:u, :e, :d)
                  ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, department = EXCLUDED.department""",
               u=u.user_id, e=u.email, d=u.department)
    return {"user_id": u.user_id, "email": u.email, "groups": u.groups, "department": u.department,
            "quota": quota.check(u.user_id, u.department)}


@app.get("/api/usage")
def usage(u: User = Depends(current_user)):
    return {"summary": quota.summary(u.user_id), "quota": quota.check(u.user_id, u.department)}


@app.get("/api/conversations")
def conversations(u: User = Depends(current_user)):
    with user_tx(u.user_id) as tx:
        return tx.run("SELECT id, title, updated_at FROM conversations WHERE user_id = :u ORDER BY updated_at DESC LIMIT 50", u=u.user_id)


@app.get("/api/conversations/{cid}")
def conversation(cid: uuid.UUID, u: User = Depends(current_user)):
    with user_tx(u.user_id) as tx:
        return tx.run("""SELECT role, content, tier, model, input_tokens, output_tokens, cost_usd, created_at
                         FROM messages WHERE conversation_id = CAST(:c AS uuid) AND user_id = :u ORDER BY created_at""",
                      c=str(cid), u=u.user_id)


@app.delete("/api/conversations/{cid}")
def delete_conversation(cid: uuid.UUID, u: User = Depends(current_user)):
    with user_tx(u.user_id) as tx:
        tx.run("DELETE FROM conversations WHERE id = CAST(:c AS uuid) AND user_id = :u", c=str(cid), u=u.user_id)
    governance.audit(u.user_id, "conversation.delete", conversation_id=str(cid))
    return {"ok": True}


# ---------------------------------------------------------------- chat
class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=20000)
    conversation_id: uuid.UUID | None = None
    mode: str | None = None          # force a tier: t1..t5
    use_rag: bool = True


def _sse(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"


@app.post("/api/chat")
def chat(body: ChatIn, u: User = Depends(current_user)):
    quota.check(u.user_id, u.department)
    r = llm.route(body.message, body.mode)
    cid = str(body.conversation_id or uuid.uuid4())

    with user_tx(u.user_id) as tx:
        if not body.conversation_id:
            tx.run("INSERT INTO conversations (id, user_id, title) VALUES (CAST(:c AS uuid), :u, :t)",
                   c=cid, u=u.user_id, t=body.message[:80])
        history = tx.run("""SELECT role, content FROM messages WHERE conversation_id = CAST(:c AS uuid) AND user_id = :u
                            ORDER BY created_at DESC LIMIT 10""", c=cid, u=u.user_id)[::-1]
        hits = rag.search(tx, u.user_id, body.message) if body.use_rag else []
        memories = tx.run("SELECT content FROM memories WHERE user_id = :u ORDER BY created_at DESC LIMIT 5", u=u.user_id)
        tx.run("""INSERT INTO messages (id, conversation_id, user_id, role, content, tier)
                  VALUES (CAST(:i AS uuid), CAST(:c AS uuid), :u, 'user', :m, :t)""",
               i=str(uuid.uuid4()), c=cid, u=u.user_id, m=body.message, t=r.tier)

    # untrusted context: scan each retrieved chunk, drop the flagged ones
    context, quarantined, sources = [], [], []
    for h in hits:
        scan = governance.scan_untrusted(h["content"])
        if scan["blocked"]:
            quarantined.append({"title": h["title"], "why": scan["heuristic"] or [scan["guardrail"]]})
            continue
        context.append(governance.wrap_untrusted(h["title"], h["content"]))
        sources.append(h["title"])
    extra = ""
    if memories:
        extra += "Ghi nhớ về người dùng:\n" + "\n".join(f"- {m['content']}" for m in memories) + "\n"
    if context:
        extra += "Tài liệu liên quan trong workspace của người dùng:\n" + "\n\n".join(context)

    msgs = [{"role": h["role"], "content": h["content"]} for h in history] + [{"role": "user", "content": body.message}]

    def gen():
        yield _sse("meta", {"conversation_id": cid, "tier": r.tier, "tier_label": llm.TIERS[r.tier],
                            "model": llm.MODELS[r.model]["label"], "reason": r.reason,
                            "sources": sorted(set(sources)), "quarantined": quarantined})
        started, first, text = time.time(), None, []
        try:
            for ev in llm.stream(r.model, r.effort, msgs, extra):
                if ev[0] == "text":
                    if first is None:
                        first = time.time() - started
                    text.append(ev[1])
                    yield _sse("delta", {"text": ev[1]})
                else:
                    usage_, usd = ev[1], ev[2]
                    answer = "".join(text)
                    stats = {"input_tokens": usage_.input_tokens, "output_tokens": usage_.output_tokens,
                             "cache_read": getattr(usage_, "cache_read_input_tokens", 0) or 0,
                             "cache_write": getattr(usage_, "cache_creation_input_tokens", 0) or 0,
                             "usd": round(usd, 6), "ttft_s": round(first or 0, 2), "total_s": round(time.time() - started, 2)}
                    with user_tx(u.user_id) as tx:
                        tx.run("""INSERT INTO messages (id, conversation_id, user_id, role, content, tier, model, input_tokens, output_tokens, cost_usd)
                                  VALUES (CAST(:i AS uuid), CAST(:c AS uuid), :u, 'assistant', :m, :t, :mo, :it, :ot, :usd)""",
                               i=str(uuid.uuid4()), c=cid, u=u.user_id, m=answer, t=r.tier, mo=llm.MODELS[r.model]["label"],
                               it=stats["input_tokens"], ot=stats["output_tokens"], usd=stats["usd"])
                        tx.run("UPDATE conversations SET updated_at = now() WHERE id = CAST(:c AS uuid) AND user_id = :u", c=cid, u=u.user_id)
                    quota.record(u.user_id, u.department, "chat", llm.MODELS[r.model]["label"], usd,
                                 stats["input_tokens"], stats["output_tokens"], stats["cache_read"], stats["cache_write"], r.tier)
                    governance.audit(u.user_id, "chat", conversation_id=cid, tier=r.tier, model=r.model,
                                     usd=stats["usd"], sources=sources, quarantined=len(quarantined))
                    log(level="info", msg="chat", user=u.user_id, tier=r.tier, model=r.model, **stats)
                    yield _sse("usage", stats)
        except llm.ProviderUnavailable as e:
            log(level="error", msg="llm unavailable", error=str(e))
            yield _sse("error", {"message": str(e), "hint": "Bedrock của account đang chờ AWS mở quyền truy cập model."})
        except Exception as e:
            log(level="error", msg="chat failed", error=repr(e)[:500])
            yield _sse("error", {"message": "Lỗi khi gọi model, thử lại sau."})
        yield _sse("done", {})

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class MemoryIn(BaseModel):
    content: str = Field(min_length=1, max_length=500)


@app.post("/api/memories")
def add_memory(body: MemoryIn, u: User = Depends(current_user)):
    with user_tx(u.user_id) as tx:
        tx.run("INSERT INTO memories (id, user_id, content) VALUES (CAST(:i AS uuid), :u, :c)", i=str(uuid.uuid4()), u=u.user_id, c=body.content)
    return {"ok": True}


@app.get("/api/memories")
def list_memories(u: User = Depends(current_user)):
    with user_tx(u.user_id) as tx:
        return tx.run("SELECT id, content, created_at FROM memories WHERE user_id = :u ORDER BY created_at DESC", u=u.user_id)


# ---------------------------------------------------------------- files (workspace)
QUOTA_BYTES = 10 * 1024 ** 3
MAX_FILE = 50 * 1024 ** 2


def _key(u: User, doc_id: str, name: str) -> str:
    safe = "".join(c for c in name if c.isalnum() or c in "._- ")[:120] or "file"
    return f"users/{u.user_id}/files/{doc_id}/{safe}"


def _used_bytes(user_id: str) -> int:
    s3, total, token = client("s3"), 0, None
    while True:
        kw = {"Bucket": settings().workspace_bucket, "Prefix": f"users/{user_id}/"}
        if token:
            kw["ContinuationToken"] = token
        r = s3.list_objects_v2(**kw)
        total += sum(o["Size"] for o in r.get("Contents", []))
        if not r.get("IsTruncated"):
            return total
        token = r["NextContinuationToken"]


class UploadIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    size: int = Field(gt=0, le=MAX_FILE)
    content_type: str = "application/octet-stream"


@app.post("/api/files/upload-url")
def upload_url(body: UploadIn, u: User = Depends(current_user)):
    if _used_bytes(u.user_id) + body.size > QUOTA_BYTES:
        raise HTTPException(413, "Vượt quota 10 GB của workspace.")
    doc_id = str(uuid.uuid4())
    key = _key(u, doc_id, body.name)
    with user_tx(u.user_id) as tx:
        tx.run("INSERT INTO documents (id, user_id, source, s3_key, title) VALUES (CAST(:i AS uuid), :u, 'upload', :k, :t)",
               i=doc_id, u=u.user_id, k=key, t=body.name)
    url = client("s3").generate_presigned_url("put_object", ExpiresIn=600, Params={
        "Bucket": settings().workspace_bucket, "Key": key, "ContentType": body.content_type})
    return {"document_id": doc_id, "url": url, "headers": {"Content-Type": body.content_type}}


@app.post("/api/files/{doc_id}/ingest")
def ingest(doc_id: uuid.UUID, u: User = Depends(current_user)):
    with user_tx(u.user_id) as tx:
        d = tx.one("SELECT id, s3_key, title FROM documents WHERE id = CAST(:i AS uuid) AND user_id = :u", i=str(doc_id), u=u.user_id)
        if not d:
            raise HTTPException(404, "Không tìm thấy tài liệu")
        data = client("s3").get_object(Bucket=settings().workspace_bucket, Key=d["s3_key"])["Body"].read()
        text = rag.extract_text(d["title"], data)
        tx.run("DELETE FROM chunks WHERE document_id = CAST(:i AS uuid) AND user_id = :u", i=str(doc_id), u=u.user_id)
        n = rag.index(tx, u.user_id, str(doc_id), text) if text else 0
    governance.audit(u.user_id, "file.ingest", document_id=str(doc_id), chunks=n)
    return {"chunks": n, "chars": len(text)}


@app.get("/api/files")
def files(u: User = Depends(current_user)):
    with user_tx(u.user_id) as tx:
        return tx.run("""SELECT d.id, d.title, d.source, d.created_at, count(c.id) AS chunks
                         FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
                         WHERE d.user_id = :u GROUP BY d.id ORDER BY d.created_at DESC LIMIT 200""", u=u.user_id)


@app.get("/api/files/{doc_id}/download-url")
def download_url(doc_id: uuid.UUID, u: User = Depends(current_user)):
    with user_tx(u.user_id) as tx:
        d = tx.one("SELECT s3_key, title FROM documents WHERE id = CAST(:i AS uuid) AND user_id = :u", i=str(doc_id), u=u.user_id)
    if not d:
        raise HTTPException(404, "Không tìm thấy tài liệu")
    url = client("s3").generate_presigned_url("get_object", ExpiresIn=300, Params={
        "Bucket": settings().workspace_bucket, "Key": d["s3_key"],
        "ResponseContentDisposition": f'attachment; filename="{d["title"]}"'})
    return {"url": url}


@app.delete("/api/files/{doc_id}")
def delete_file(doc_id: uuid.UUID, u: User = Depends(current_user)):
    with user_tx(u.user_id) as tx:
        d = tx.one("DELETE FROM documents WHERE id = CAST(:i AS uuid) AND user_id = :u RETURNING s3_key", i=str(doc_id), u=u.user_id)
    if d and d["s3_key"]:
        client("s3").delete_object(Bucket=settings().workspace_bucket, Key=d["s3_key"])
    governance.audit(u.user_id, "file.delete", document_id=str(doc_id))
    return {"ok": bool(d)}


def save_output(u: User, name: str, data: bytes, source: str = "agent") -> str:
    doc_id = str(uuid.uuid4())
    key = _key(u, doc_id, name)
    client("s3").put_object(Bucket=settings().workspace_bucket, Key=key, Body=data)
    with user_tx(u.user_id) as tx:
        tx.run("INSERT INTO documents (id, user_id, source, s3_key, title) VALUES (CAST(:i AS uuid), :u, :s, :k, :t)",
               i=doc_id, u=u.user_id, s=source, k=key, t=name)
    return doc_id


# ---------------------------------------------------------------- sandbox
class SandboxIn(BaseModel):
    code: str = Field(min_length=1, max_length=50000)
    file_ids: list[uuid.UUID] = []


def keepalive_json(work):
    """Long jobs: stream a space every 10 s so idle-timeout proxies keep the connection open,
    then the JSON body (leading whitespace is valid JSON). Errors are returned as {"error": ...}."""
    import concurrent.futures as cf

    def gen():
        with cf.ThreadPoolExecutor(1) as ex:
            fut = ex.submit(work)
            while True:
                try:
                    res = fut.result(timeout=10)
                    break
                except cf.TimeoutError:
                    yield b" "
                except HTTPException as e:
                    res = {"error": e.detail, "status": e.status_code}
                    break
                except Exception as e:
                    log(level="error", msg="job failed", error=repr(e)[:300])
                    res = {"error": "Lỗi khi chạy tác vụ", "status": 500}
                    break
        yield json.dumps(res, ensure_ascii=False, default=str).encode()

    return StreamingResponse(gen(), media_type="application/json")


@app.post("/api/sandbox/run")
def sandbox_run(body: SandboxIn, u: User = Depends(current_user)):
    quota.check(u.user_id, u.department)
    return keepalive_json(lambda: _sandbox_run(body, u))


def _sandbox_run(body: SandboxIn, u: User):
    inputs = []
    with user_tx(u.user_id) as tx:
        for fid in body.file_ids[:10]:
            d = tx.one("SELECT s3_key, title FROM documents WHERE id = CAST(:i AS uuid) AND user_id = :u", i=str(fid), u=u.user_id)
            if not d:
                raise HTTPException(404, f"Không có file {fid}")
            inputs.append({"name": d["title"], "url": client("s3").generate_presigned_url(
                "get_object", ExpiresIn=300, Params={"Bucket": settings().workspace_bucket, "Key": d["s3_key"]})})
    started = time.time()
    r = client("lambda").invoke(FunctionName=settings().sandbox_function,
                                Payload=json.dumps({"code": body.code, "inputs": inputs, "timeout_s": 90}).encode())
    out = json.loads(r["Payload"].read())
    if r.get("FunctionError"):
        raise HTTPException(500, f"Sandbox lỗi: {out.get('errorMessage', '')[:300]}")
    saved = []
    for f in out.get("files", []):
        saved.append({"document_id": save_output(u, f["name"], base64.b64decode(f["b64"]), "sandbox"), "name": f["name"]})
    seconds = time.time() - started
    usd = seconds * 2 * 0.0000133334 + 0.0000002  # 2 GB ARM Lambda, same unit price as the quote
    quota.record(u.user_id, u.department, "sandbox", "lambda-sandbox", usd, tier="t3")
    governance.audit(u.user_id, "sandbox.run", seconds=round(seconds, 2), exit_code=out.get("exit_code"),
                     outputs=[s["name"] for s in saved], code_sha=uuid.uuid5(uuid.NAMESPACE_OID, body.code).hex)
    return {"stdout": out.get("stdout", ""), "stderr": out.get("stderr", ""), "exit_code": out.get("exit_code"),
            "files": saved, "seconds": round(seconds, 2), "usd": round(usd, 6)}


# ---------------------------------------------------------------- images (tier 5)
class ImageIn(BaseModel):
    prompt: str = Field(min_length=3, max_length=2000)


@app.post("/api/images")
def image(body: ImageIn, u: User = Depends(current_user)):
    quota.check(u.user_id, u.department)
    scan = governance.heuristic_injection(body.prompt)
    if scan:
        raise HTTPException(400, "Prompt bị chặn bởi bộ lọc an toàn.")
    try:
        png, usd, model = images.generate(body.prompt)
    except images.ImageUnavailable as e:
        raise HTTPException(503, str(e)) from e
    doc_id = save_output(u, f"anh-{dt.datetime.now():%Y%m%d-%H%M%S}.png", png, "image")
    quota.record(u.user_id, u.department, "image", model, usd, tier="t5")
    governance.audit(u.user_id, "image.generate", document_id=doc_id, usd=usd)
    return {"document_id": doc_id, "usd": usd, "model": model, "b64": base64.b64encode(png).decode()}


# ---------------------------------------------------------------- agent (tier 4)
class AgentIn(BaseModel):
    goal: str = Field(min_length=5, max_length=4000)


@app.post("/api/agent")
def agent_start(body: AgentIn, u: User = Depends(current_user)):
    quota.check(u.user_id, u.department)
    run_id = str(uuid.uuid4())
    with user_tx(u.user_id) as tx:
        tx.run("INSERT INTO agent_runs (id, user_id, goal, status) VALUES (CAST(:i AS uuid), :u, :g, 'planning')",
               i=run_id, u=u.user_id, g=body.goal)
    ex = client("stepfunctions").start_execution(
        stateMachineArn=settings().agent_state_machine, name=run_id,
        input=json.dumps({"run_id": run_id, "user_id": u.user_id, "email": u.email, "department": u.department, "goal": body.goal}))
    with user_tx(u.user_id) as tx:
        tx.run("UPDATE agent_runs SET execution_arn = :e WHERE id = CAST(:i AS uuid) AND user_id = :u", e=ex["executionArn"], i=run_id, u=u.user_id)
    governance.audit(u.user_id, "agent.start", run_id=run_id)
    return {"run_id": run_id}


@app.get("/api/agent")
def agent_runs(u: User = Depends(current_user)):
    with user_tx(u.user_id) as tx:
        return tx.run("""SELECT id, goal, status, plan, result, cost_usd, created_at, updated_at FROM agent_runs
                         WHERE user_id = :u ORDER BY created_at DESC LIMIT 20""", u=u.user_id)


class DecisionIn(BaseModel):
    approve: bool


@app.post("/api/agent/{run_id}/decision")
def agent_decision(run_id: uuid.UUID, body: DecisionIn, u: User = Depends(current_user)):
    with user_tx(u.user_id) as tx:
        r = tx.one("""SELECT task_token, status FROM agent_runs WHERE id = CAST(:i AS uuid) AND user_id = :u""", i=str(run_id), u=u.user_id)
        if not r or r["status"] != "awaiting_confirmation" or not r["task_token"]:
            raise HTTPException(409, "Tác vụ không ở trạng thái chờ xác nhận")
        tx.run("UPDATE agent_runs SET status = :s, task_token = NULL, updated_at = now() WHERE id = CAST(:i AS uuid) AND user_id = :u",
               s="running" if body.approve else "rejected", i=str(run_id), u=u.user_id)
    sfn = client("stepfunctions")
    if body.approve:
        sfn.send_task_success(taskToken=r["task_token"], output=json.dumps({"approved": True, "by": u.user_id}))
    else:
        sfn.send_task_failure(taskToken=r["task_token"], error="Rejected", cause="Người dùng từ chối")
    governance.audit(u.user_id, "agent.decision", run_id=str(run_id), approve=body.approve)
    return {"ok": True}


# ---------------------------------------------------------------- SPA
if WEB.exists():
    app.mount("/assets", StaticFiles(directory=WEB / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith("api/"):
            return JSONResponse({"detail": "not found"}, status_code=404)
        return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-cache"})
