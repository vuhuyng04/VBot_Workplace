"""Quota and cost metering (H8): per-user daily cap, per-unit monthly cap, ledger per request."""
import datetime as dt
import time
from decimal import Decimal

from fastapi import HTTPException

from .aws import client
from .config import settings


def _keys(user_id: str, department: str):
    now = dt.datetime.now(dt.timezone.utc)
    return (f"user#{user_id}", f"day#{now:%Y-%m-%d}"), (f"unit#{department}", f"month#{now:%Y-%m}")


def _get(pk, sk) -> float:
    r = client("dynamodb").get_item(TableName=settings().tables["quota"], Key={"pk": {"S": pk}, "sk": {"S": sk}},
                                    ConsistentRead=True)
    return float(r.get("Item", {}).get("usd", {}).get("N", "0"))


_CAPS: dict[str, tuple[float, float | None]] = {}   # department -> (fetched_at, override); 60 s cache


def unit_cap_override(department: str) -> float | None:
    hit = _CAPS.get(department)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    r = client("dynamodb").get_item(TableName=settings().tables["quota"], Key={"pk": {"S": f"unit#{department}"}, "sk": {"S": "cap"}})
    v = r.get("Item", {}).get("usd", {}).get("N")
    _CAPS[department] = (time.time(), float(v) if v is not None else None)
    return _CAPS[department][1]


def unit_cap(department: str) -> float:
    """Monthly budget of a department: the admin-set override, else the platform default."""
    o = unit_cap_override(department)
    return settings().monthly_unit_budget_usd if o is None else o


def set_unit_cap(department: str, usd: float | None):
    t, key = settings().tables["quota"], {"pk": {"S": f"unit#{department}"}, "sk": {"S": "cap"}}
    if usd is None:
        client("dynamodb").delete_item(TableName=t, Key=key)
    else:
        client("dynamodb").put_item(TableName=t, Item={**key, "usd": {"N": str(Decimal(str(round(usd, 4))))}})
    _CAPS.pop(department, None)


def unit_month_usd(department: str) -> float:
    return _get(*_keys("-", department)[1])


def check(user_id: str, department: str):
    s = settings()
    (upk, usk), (dpk, dsk) = _keys(user_id, department)
    used_user, used_unit, cap = _get(upk, usk), _get(dpk, dsk), unit_cap(department)
    if used_user >= s.daily_user_budget_usd:
        raise HTTPException(429, f"Đã dùng hết hạn mức {s.daily_user_budget_usd} USD hôm nay. Hạn mức đặt lại lúc 07:00 (giờ Việt Nam).")
    if used_unit >= cap:
        raise HTTPException(429, f"Đơn vị {department} đã dùng hết ngân sách tháng.")
    return {"user_today_usd": round(used_user, 4), "user_cap_usd": s.daily_user_budget_usd,
            "unit_month_usd": round(used_unit, 4), "unit_cap_usd": cap}


def record(user_id: str, department: str, kind: str, model: str, usd: float, input_tokens: int = 0,
           output_tokens: int = 0, cache_read: int = 0, cache_write: int = 0, tier: str = ""):
    s = settings()
    ddb = client("dynamodb")
    (upk, usk), (dpk, dsk) = _keys(user_id, department)
    amount = {":u": {"N": str(Decimal(str(round(usd, 8))))}, ":one": {"N": "1"}}
    ttl = str(int(time.time()) + 400 * 86400)
    for pk, sk in ((upk, usk), (dpk, dsk)):
        ddb.update_item(TableName=s.tables["quota"], Key={"pk": {"S": pk}, "sk": {"S": sk}},
                        UpdateExpression="ADD usd :u, requests :one SET expires_at = :ttl",
                        ExpressionAttributeValues={**amount, ":ttl": {"N": ttl}})
    now = dt.datetime.now(dt.timezone.utc)
    ddb.put_item(TableName=s.tables["usage"], Item={
        "pk": {"S": f"user#{user_id}"}, "sk": {"S": f"{now.isoformat()}#{kind}"},
        "kind": {"S": kind}, "model": {"S": model}, "tier": {"S": tier}, "department": {"S": department},
        "usd": {"N": str(round(usd, 8))}, "input_tokens": {"N": str(input_tokens)}, "output_tokens": {"N": str(output_tokens)},
        "cache_read": {"N": str(cache_read)}, "cache_write": {"N": str(cache_write)},
        "expires_at": {"N": ttl},
    })


def summary(user_id: str, days: int = 30) -> dict:
    s = settings()
    since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)).isoformat()
    r = client("dynamodb").query(TableName=s.tables["usage"],
                                 KeyConditionExpression="pk = :p AND sk >= :s",
                                 ExpressionAttributeValues={":p": {"S": f"user#{user_id}"}, ":s": {"S": since}})
    by_model, total, n = {}, 0.0, 0
    for it in r.get("Items", []):
        usd = float(it["usd"]["N"])
        m = it["model"]["S"]
        b = by_model.setdefault(m, {"usd": 0.0, "requests": 0, "input_tokens": 0, "output_tokens": 0})
        b["usd"] += usd
        b["requests"] += 1
        b["input_tokens"] += int(it["input_tokens"]["N"])
        b["output_tokens"] += int(it["output_tokens"]["N"])
        total += usd
        n += 1
    return {"days": days, "requests": n, "usd": round(total, 6), "by_model": by_model}
