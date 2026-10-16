"""Admin console API (RBAC on Cognito groups).

Roles: platform_admin (everything), unit_admin (users of their own department only), user (no access).
The caller's role and department are read live from Cognito on every admin call, not from the ID token,
so a demotion or a disabled account takes effect immediately instead of when the token expires."""
import datetime as dt
import json
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from . import governance, quota
from .auth import User, current_user
from .aws import client
from .config import settings

router = APIRouter(prefix="/api/admin")
ROLES = ("user", "unit_admin", "platform_admin")   # lowest to highest
ADMIN_ROLES = ROLES[1:]
DEPT = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
MAX_USERS = 5000


def _idp():
    return client("cognito-idp")


def _pool() -> str:
    return settings().user_pool_id


def role_of(groups) -> str:
    return next((r for r in reversed(ROLES) if r in groups), "user")


def _attrs(items) -> dict:
    return {a["Name"]: a["Value"] for a in items or []}


@dataclass(frozen=True)
class Actor:
    user: User
    role: str
    department: str

    @property
    def scope(self) -> str | None:
        """Department this admin is limited to; None = all departments."""
        return None if self.role == "platform_admin" else self.department


def _live(username: str) -> tuple[dict, str]:
    try:
        u = _idp().admin_get_user(UserPoolId=_pool(), Username=username)
    except _idp().exceptions.UserNotFoundException as e:
        raise HTTPException(404, "Không tìm thấy người dùng") from e
    groups = [g["GroupName"] for g in _idp().admin_list_groups_for_user(UserPoolId=_pool(), Username=username)["Groups"]]
    return u, role_of(groups)


def admin_actor(u: User = Depends(current_user)) -> Actor:
    live, role = _live(u.user_id)
    if not live.get("Enabled", True) or role not in ADMIN_ROLES:
        raise HTTPException(403, "Chỉ quản trị viên mới truy cập được trang này.")
    return Actor(u, role, _attrs(live.get("UserAttributes")).get("custom:department") or "default")


def platform_actor(a: Actor = Depends(admin_actor)) -> Actor:
    if a.role != "platform_admin":
        raise HTTPException(403, "Chỉ quản trị nền tảng (platform_admin) mới làm được việc này.")
    return a


# ---------------------------------------------------------------- users
def _all_users() -> list[dict]:
    """Every user with role. Cognito cannot filter on custom attributes, so filtering happens here."""
    idp, pool, users, token = _idp(), _pool(), [], None
    while len(users) < MAX_USERS:
        r = idp.list_users(UserPoolId=pool, Limit=60, **({"PaginationToken": token} if token else {}))
        users += r["Users"]
        token = r.get("PaginationToken")
        if not token:
            break
    members: dict[str, set[str]] = {}
    for g in ADMIN_ROLES:
        token = None
        while True:
            r = idp.list_users_in_group(UserPoolId=pool, GroupName=g, Limit=60, **({"NextToken": token} if token else {}))
            members.setdefault(g, set()).update(x["Username"] for x in r["Users"])
            token = r.get("NextToken")
            if not token:
                break
    out = []
    for u in users:
        a = _attrs(u.get("Attributes"))
        groups = [g for g in ADMIN_ROLES if u["Username"] in members[g]]
        out.append({"id": u["Username"], "sub": a.get("sub", u["Username"]), "email": a.get("email", ""),
                    "department": a.get("custom:department") or "default", "role": role_of(groups),
                    "status": u.get("UserStatus", ""), "enabled": u.get("Enabled", True),
                    "created_at": u.get("UserCreateDate"), "updated_at": u.get("UserLastModifiedDate")})
    return sorted(out, key=lambda x: x["email"])


def _visible(a: Actor, users: list[dict]) -> list[dict]:
    return [u for u in users if a.scope is None or u["department"] == a.scope]


def _target(a: Actor, uid: str) -> tuple[dict, str, str]:
    live, role = _live(uid)
    dept = _attrs(live.get("UserAttributes")).get("custom:department") or "default"
    if a.scope is not None and dept != a.scope:
        raise HTTPException(404, "Không tìm thấy người dùng")    # do not reveal users of other departments
    if a.role != "platform_admin" and role == "platform_admin":
        raise HTTPException(403, "Không thể thay đổi quản trị nền tảng.")
    return live, role, dept


def _set_role(uid: str, role: str):
    idp, pool = _idp(), _pool()
    idp.admin_add_user_to_group(UserPoolId=pool, Username=uid, GroupName="user")
    for g in ADMIN_ROLES:
        if g == role:
            idp.admin_add_user_to_group(UserPoolId=pool, Username=uid, GroupName=g)
        else:
            idp.admin_remove_user_from_group(UserPoolId=pool, Username=uid, GroupName=g)


def _dept(v: str) -> str:
    v = v.strip().lower()
    if not DEPT.match(v):
        raise ValueError("Mã phòng ban chỉ gồm chữ thường không dấu, số, '-' hoặc '_' (tối đa 64 ký tự).")
    return v


class NewUser(BaseModel):
    email: str = Field(min_length=3, max_length=254, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    department: str | None = None
    role: str = "user"

    @field_validator("department")
    @classmethod
    def _check_dept(cls, v):
        return None if v is None else _dept(v)


class UserPatch(BaseModel):
    department: str | None = None
    role: str | None = None
    enabled: bool | None = None

    @field_validator("department")
    @classmethod
    def _check_dept(cls, v):
        return None if v is None else _dept(v)


@router.get("/users")
def list_users(a: Actor = Depends(admin_actor)):
    return {"role": a.role, "scope": a.scope, "me": a.user.user_id, "users": _visible(a, _all_users())}


@router.post("/users", status_code=201)
def create_user(body: NewUser, a: Actor = Depends(admin_actor)):
    if body.role not in ROLES:
        raise HTTPException(422, "Vai trò không hợp lệ")
    if a.scope is not None:   # unit_admin: own department, plain users only
        if body.role != "user":
            raise HTTPException(403, "Quản trị đơn vị chỉ tạo được người dùng thường.")
        dept = a.scope
    else:
        dept = body.department or "default"
    email = body.email.strip().lower()
    idp = _idp()
    try:
        r = idp.admin_create_user(UserPoolId=_pool(), Username=email, DesiredDeliveryMediums=["EMAIL"],
                                  UserAttributes=[{"Name": "email", "Value": email}, {"Name": "email_verified", "Value": "true"},
                                                  {"Name": "custom:department", "Value": dept}])
    except idp.exceptions.UsernameExistsException as e:
        raise HTTPException(409, "Email này đã có tài khoản.") from e
    uid = r["User"]["Username"]
    _set_role(uid, body.role)
    governance.audit(a.user.user_id, "admin.user.create", target=uid, email=email, department=dept, role=body.role)
    return {"id": uid, "email": email, "department": dept, "role": body.role, "status": r["User"].get("UserStatus")}


@router.patch("/users/{uid}")
def update_user(uid: str, body: UserPatch, a: Actor = Depends(admin_actor)):
    live, role, dept = _target(a, uid)
    is_me = a.user.user_id in (uid, _attrs(live.get("UserAttributes")).get("sub"))
    if is_me and (body.enabled is False or (body.role and body.role != a.role)):
        raise HTTPException(400, "Không thể tự khoá hoặc tự đổi vai trò của chính mình.")
    if a.scope is not None and (body.department or body.role):
        raise HTTPException(403, "Quản trị đơn vị chỉ khoá/mở khoá được người dùng.")
    if body.role is not None and body.role not in ROLES:
        raise HTTPException(422, "Vai trò không hợp lệ")
    idp, pool, changed = _idp(), _pool(), {}
    if body.department and body.department != dept:
        idp.admin_update_user_attributes(UserPoolId=pool, Username=uid,
                                         UserAttributes=[{"Name": "custom:department", "Value": body.department}])
        changed["department"] = [dept, body.department]
    if body.role and body.role != role:
        _set_role(uid, body.role)
        changed["role"] = [role, body.role]
    if body.enabled is not None and body.enabled != live.get("Enabled", True):
        (idp.admin_enable_user if body.enabled else idp.admin_disable_user)(UserPoolId=pool, Username=uid)
        changed["enabled"] = body.enabled
    if changed and (body.enabled is False or "department" in changed or "role" in changed):
        idp.admin_user_global_sign_out(UserPoolId=pool, Username=uid)   # refresh tokens stop working
    if changed:
        governance.audit(a.user.user_id, "admin.user.update", target=uid, changes=changed)
    return {"id": uid, "changed": changed}


@router.post("/users/{uid}/resend")
def resend_invite(uid: str, a: Actor = Depends(admin_actor)):
    live, _, _ = _target(a, uid)
    if live.get("UserStatus") != "FORCE_CHANGE_PASSWORD":
        raise HTTPException(400, "Người dùng đã kích hoạt tài khoản, không cần gửi lại thư mời.")
    email = _attrs(live.get("UserAttributes")).get("email", "")
    # email-as-username pools take the e-mail here, not the generated username
    _idp().admin_create_user(UserPoolId=_pool(), Username=email, MessageAction="RESEND", DesiredDeliveryMediums=["EMAIL"])
    governance.audit(a.user.user_id, "admin.user.resend_invite", target=uid)
    return {"ok": True, "email": email}


# ---------------------------------------------------------------- departments + budgets
class Cap(BaseModel):
    usd: float = Field(ge=0, le=1_000_000)


@router.get("/departments")
def departments(a: Actor = Depends(admin_actor)):
    counts: dict[str, int] = {}
    for u in _visible(a, _all_users()):
        counts[u["department"]] = counts.get(u["department"], 0) + 1
    if a.scope is not None:
        counts.setdefault(a.scope, 0)
    month = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m")
    rows = [{"name": d, "users": n, "month_usd": round(quota.unit_month_usd(d), 4), "cap_usd": quota.unit_cap(d),
             "custom_cap": quota.unit_cap_override(d) is not None} for d, n in sorted(counts.items())]
    return {"month": month, "default_cap_usd": settings().monthly_unit_budget_usd,
            "daily_user_cap_usd": settings().daily_user_budget_usd, "departments": rows}


@router.put("/departments/{name}/cap")
def set_cap(name: str, body: Cap, a: Actor = Depends(platform_actor)):
    try:
        name = _dept(name)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    old = quota.unit_cap(name)
    quota.set_unit_cap(name, body.usd)
    governance.audit(a.user.user_id, "admin.department.cap", department=name, old_usd=old, new_usd=body.usd)
    return {"name": name, "cap_usd": body.usd}


@router.delete("/departments/{name}/cap")
def reset_cap(name: str, a: Actor = Depends(platform_actor)):
    quota.set_unit_cap(name, None)
    governance.audit(a.user.user_id, "admin.department.cap", department=name, new_usd="default")
    return {"name": name, "cap_usd": quota.unit_cap(name)}


# ---------------------------------------------------------------- audit log (write-once bucket)
@router.get("/audit")
def audit_log(date: str = Query(default="", pattern=r"^(\d{4}-\d{2}-\d{2})?$"), user: str = "", action: str = "",
              limit: int = Query(default=100, ge=1, le=300), a: Actor = Depends(platform_actor)):
    day = dt.date.fromisoformat(date) if date else dt.datetime.now(dt.timezone.utc).date()
    prefix = f"audit/{day:%Y/%m/%d}/" + (f"{user}/" if user else "")
    s3, bucket, objs, token = client("s3"), settings().audit_bucket, [], None
    while len(objs) < 5000:
        r = s3.list_objects_v2(Bucket=bucket, Prefix=prefix, **({"ContinuationToken": token} if token else {}))
        objs += r.get("Contents", [])
        token = r.get("NextContinuationToken")
        if not token:
            break
    objs.sort(key=lambda o: o["LastModified"], reverse=True)

    def read(o):
        try:
            return json.loads(s3.get_object(Bucket=bucket, Key=o["Key"])["Body"].read())
        except Exception as e:
            return {"ts": o["LastModified"].isoformat(), "action": "(không đọc được)", "error": str(e)[:120], "key": o["Key"]}

    with ThreadPoolExecutor(16) as ex:
        recs = list(ex.map(read, objs[:limit * 3 if action else limit]))
    if action:
        recs = [r for r in recs if str(r.get("action", "")).startswith(action)][:limit]
    users = _all_users()
    emails = {u["id"]: u["email"] for u in users} | {u["sub"]: u["email"] for u in users}
    for r in recs:
        r["email"] = emails.get(r.get("user_id", ""), "")
    governance.audit(a.user.user_id, "admin.audit.read", date=str(day), user=user or None, action_filter=action or None)
    return {"date": str(day), "total": len(objs), "records": recs}
