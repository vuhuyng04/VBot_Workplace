"""Aurora access through the RDS Data API (HTTPS + IAM; no VPC, NAT or connection pool needed).

Every user query runs inside a transaction that first sets app.user_id, so Postgres
Row-Level Security limits the vbot_app role to that user's rows (defence in depth on top
of the explicit user_id filters in each query)."""
import contextlib
import datetime as dt
import decimal
import json
import time
import uuid

from .aws import client
from .config import settings


def _param(name, value):
    if value is None:
        return {"name": name, "value": {"isNull": True}}
    if isinstance(value, bool):
        return {"name": name, "value": {"booleanValue": value}}
    if isinstance(value, int):
        return {"name": name, "value": {"longValue": value}}
    if isinstance(value, (float, decimal.Decimal)):
        return {"name": name, "value": {"stringValue": str(value)}, "typeHint": "DECIMAL"}
    if isinstance(value, uuid.UUID):
        return {"name": name, "value": {"stringValue": str(value)}, "typeHint": "UUID"}
    if isinstance(value, (dict, list)):
        return {"name": name, "value": {"stringValue": json.dumps(value, ensure_ascii=False)}, "typeHint": "JSON"}
    if isinstance(value, dt.datetime):
        return {"name": name, "value": {"stringValue": value.strftime("%Y-%m-%d %H:%M:%S")}, "typeHint": "TIMESTAMP"}
    return {"name": name, "value": {"stringValue": str(value)}}


def _cell(c):
    if c.get("isNull"):
        return None
    for k in ("stringValue", "longValue", "doubleValue", "booleanValue"):
        if k in c:
            return c[k]
    if "arrayValue" in c:
        return [_cell(x) for x in next(iter(c["arrayValue"].values()))] if c["arrayValue"] else []
    return None


class Tx:
    def __init__(self, tx_id: str | None):
        self.tx_id = tx_id

    def run(self, sql: str, **params) -> list[dict]:
        s = settings()
        req = dict(resourceArn=s.db_cluster_arn, secretArn=s.db_app_secret_arn, database=s.db_name,
                   sql=sql, parameters=[_param(k, v) for k, v in params.items()], includeResultMetadata=True)
        if self.tx_id:
            req["transactionId"] = self.tx_id
        r = client("rds-data").execute_statement(**req)
        if "columnMetadata" not in r:
            return []
        cols = [c["name"] for c in r["columnMetadata"]]
        return [dict(zip(cols, (_cell(c) for c in row), strict=True)) for row in r.get("records", [])]

    def one(self, sql: str, **params) -> dict | None:
        rows = self.run(sql, **params)
        return rows[0] if rows else None


class DatabaseWaking(RuntimeError):
    """Aurora Serverless v2 is resuming from auto-pause (0 ACU); the API maps this to 503 + Retry-After."""


def _begin(rds, s, wait_s: float = 25.0) -> str:
    """BeginTransaction, waiting while an auto-paused cluster resumes (typically ~15 s)."""
    deadline = time.monotonic() + wait_s
    delay = 1.0
    while True:
        try:
            return rds.begin_transaction(resourceArn=s.db_cluster_arn, secretArn=s.db_app_secret_arn, database=s.db_name)["transactionId"]
        except rds.exceptions.DatabaseResumingException as e:
            if time.monotonic() + delay > deadline:
                raise DatabaseWaking("Cơ sở dữ liệu đang khởi động lại sau thời gian nghỉ, vui lòng thử lại sau vài giây.") from e
            time.sleep(delay)
            delay = min(delay * 1.6, 5.0)


@contextlib.contextmanager
def user_tx(user_id: str):
    """Transaction bound to one user: RLS sees app.user_id for every statement inside."""
    s = settings()
    rds = client("rds-data")
    tx_id = _begin(rds, s)
    tx = Tx(tx_id)
    try:
        tx.run("SELECT set_config('app.user_id', :uid, true)", uid=user_id)
        yield tx
        rds.commit_transaction(resourceArn=s.db_cluster_arn, secretArn=s.db_app_secret_arn, transactionId=tx_id)
    except Exception:
        rds.rollback_transaction(resourceArn=s.db_cluster_arn, secretArn=s.db_app_secret_arn, transactionId=tx_id)
        raise
