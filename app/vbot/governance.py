"""AI + data governance (H4/H5).

- Untrusted content (connector data, uploaded documents) is wrapped in <untrusted_document>
  tags and scanned for prompt injection: a cheap local heuristic first, then the Bedrock
  guardrail (prompt-attack filter) only on that content, never on the whole context.
- Outputs that leave the platform (agent write actions, exports) go through PII masking.
- Every request leaves an audit record in the write-once audit bucket (Object Lock)."""
import datetime as dt
import json
import re
import uuid

from .aws import client
from .config import settings

_INJECTION = re.compile(
    r"(ignore (all|any|previous|the above) (instructions|rules)|bỏ qua (mọi|tất cả|các) (hướng dẫn|chỉ dẫn|quy tắc)|"
    r"system prompt|you are now|act as|gửi (toàn bộ|tất cả).{0,40}(ra ngoài|cho|tới)|send (all|every).{0,40}(to|outside)|"
    r"exfiltrat|forward (all|every)|chuyển tiếp (toàn bộ|tất cả)|<\s*/?\s*(system|instructions)\s*>)",
    re.I,
)


def wrap_untrusted(title: str, text: str) -> str:
    safe = text.replace("</untrusted_document>", "")
    return f'<untrusted_document title="{title}">\n{safe}\n</untrusted_document>'


def heuristic_injection(text: str) -> list[str]:
    return sorted({m.group(0)[:60] for m in _INJECTION.finditer(text)})


def guardrail(text: str, source: str) -> dict:
    """source: INPUT (untrusted content) or OUTPUT (content leaving the platform)."""
    s = settings()
    if not s.guardrail_id or not text.strip():
        return {"action": "NONE", "text": text}
    try:
        r = client("bedrock-runtime").apply_guardrail(
            guardrailIdentifier=s.guardrail_id, guardrailVersion=s.guardrail_version,
            source=source, content=[{"text": {"text": text[:20000]}}])
    except Exception as e:  # Bedrock access pending: fall back to the local heuristic only
        return {"action": "UNAVAILABLE", "text": text, "error": str(e)[:200]}
    out = r.get("outputs") or []
    return {"action": r["action"], "text": out[0]["text"] if out else text,
            "assessments": r.get("assessments", [])}


def scan_untrusted(text: str) -> dict:
    hits = heuristic_injection(text)
    g = guardrail(text, "INPUT")
    blocked = g.get("action") == "GUARDRAIL_INTERVENED" or bool(hits)
    return {"blocked": blocked, "heuristic": hits, "guardrail": g.get("action")}


def mask_output(text: str) -> str:
    g = guardrail(text, "OUTPUT")
    if g.get("action") == "GUARDRAIL_INTERVENED":
        return g["text"]
    # local fallback masking for common identifiers
    text = re.sub(r"[\w.+-]+@[\w-]+\.[\w.]+", "[EMAIL]", text)
    text = re.sub(r"\b0\d{11}\b", "[CCCD]", text)
    return re.sub(r"\b(\+?84|0)\d{9,10}\b", "[PHONE]", text)


def audit(user_id: str, action: str, **detail):
    s = settings()
    now = dt.datetime.now(dt.timezone.utc)
    rec = {"ts": now.isoformat(), "user_id": user_id, "action": action, **detail}
    key = f"audit/{now:%Y/%m/%d}/{user_id}/{now:%H%M%S}-{uuid.uuid4().hex[:8]}.json"
    try:
        client("s3").put_object(Bucket=s.audit_bucket, Key=key, Body=json.dumps(rec, ensure_ascii=False, default=str).encode(),
                                ContentType="application/json")
    except Exception as e:  # never fail the user request because of audit I/O; surface in logs
        print(json.dumps({"level": "error", "msg": "audit write failed", "error": str(e)[:200], "record": rec}, default=str))
