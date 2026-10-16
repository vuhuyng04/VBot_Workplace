"""Admin console RBAC: who may see and change which users, budgets and audit records."""
import datetime as dt

import pytest
from fastapi import HTTPException

from vbot import quota


@pytest.fixture
def people(env):
    return {
        "root": env.user("root@cty.vn", "it", "platform_admin"),
        "kt_admin": env.user("truong.kt@cty.vn", "ke-toan", "unit_admin"),
        "kt_user": env.user("nv.kt@cty.vn", "ke-toan"),
        "kd_user": env.user("nv.kd@cty.vn", "kinh-doanh"),
    }


def test_plain_user_is_refused(api, people):
    r = api.login(people["kt_user"]).get("/api/admin/users")
    assert r.status_code == 403


def test_token_groups_are_not_trusted(api, env, people):
    # token still claims platform_admin, but Cognito says plain user: access must be denied at once
    r = api.login(people["kt_user"], token_groups=("platform_admin",)).get("/api/admin/users")
    assert r.status_code == 403


def test_disabled_admin_is_refused(api, env, people):
    env.idp.admin_disable_user(UserPoolId=env.pool, Username=people["root"])
    assert api.login(people["root"]).get("/api/admin/users").status_code == 403


def test_platform_admin_sees_everyone(api, people):
    r = api.login(people["root"]).get("/api/admin/users")
    assert r.status_code == 200
    body = r.json()
    assert body["role"] == "platform_admin" and body["scope"] is None
    assert {u["email"] for u in body["users"]} == {"root@cty.vn", "truong.kt@cty.vn", "nv.kt@cty.vn", "nv.kd@cty.vn"}
    roles = {u["email"]: u["role"] for u in body["users"]}
    assert roles["truong.kt@cty.vn"] == "unit_admin" and roles["nv.kd@cty.vn"] == "user"


def test_unit_admin_sees_only_own_department(api, people):
    body = api.login(people["kt_admin"]).get("/api/admin/users").json()
    assert body["scope"] == "ke-toan"
    assert {u["email"] for u in body["users"]} == {"truong.kt@cty.vn", "nv.kt@cty.vn"}


def test_unit_admin_creates_users_in_own_department_only(api, env, people):
    c = api.login(people["kt_admin"])
    r = c.post("/api/admin/users", json={"email": "Moi@Cty.vn", "department": "kinh-doanh"})
    assert r.status_code == 201
    assert r.json()["department"] == "ke-toan" and r.json()["email"] == "moi@cty.vn"
    assert env.groups(r.json()["id"]) == {"user"}
    assert c.post("/api/admin/users", json={"email": "x@cty.vn", "role": "unit_admin"}).status_code == 403


def test_unit_admin_cannot_touch_other_departments_or_escalate(api, env, people):
    c = api.login(people["kt_admin"])
    assert c.patch(f"/api/admin/users/{people['kd_user']}", json={"enabled": False}).status_code == 404
    assert c.patch(f"/api/admin/users/{people['kt_user']}", json={"role": "unit_admin"}).status_code == 403
    assert c.patch(f"/api/admin/users/{people['kt_user']}", json={"department": "it"}).status_code == 403
    r = c.patch(f"/api/admin/users/{people['kt_user']}", json={"enabled": False})
    assert r.status_code == 200 and r.json()["changed"] == {"enabled": False}
    assert env.idp.admin_get_user(UserPoolId=env.pool, Username=people["kt_user"])["Enabled"] is False


def test_unit_admin_cannot_change_platform_admin(api, env, people):
    other_root = env.user("root2@cty.vn", "ke-toan", "platform_admin")
    assert api.login(people["kt_admin"]).patch(f"/api/admin/users/{other_root}", json={"enabled": False}).status_code == 403


def test_admin_cannot_lock_themselves_out(api, people):
    c = api.login(people["root"])
    assert c.patch(f"/api/admin/users/{people['root']}", json={"enabled": False}).status_code == 400
    assert c.patch(f"/api/admin/users/{people['root']}", json={"role": "user"}).status_code == 400


def test_platform_admin_moves_and_promotes_users(api, env, people):
    c = api.login(people["root"])
    r = c.patch(f"/api/admin/users/{people['kd_user']}", json={"department": "Ke-Toan", "role": "unit_admin"})
    assert r.status_code == 200
    assert r.json()["changed"] == {"department": ["kinh-doanh", "ke-toan"], "role": ["user", "unit_admin"]}
    assert env.attr(people["kd_user"], "custom:department") == "ke-toan"
    assert env.groups(people["kd_user"]) == {"user", "unit_admin"}
    c.patch(f"/api/admin/users/{people['kd_user']}", json={"role": "user"})
    assert env.groups(people["kd_user"]) == {"user"}


def test_validation(api, people):
    c = api.login(people["root"])
    assert c.post("/api/admin/users", json={"email": "not-an-email"}).status_code == 422
    assert c.post("/api/admin/users", json={"email": "a@cty.vn", "department": "Phòng KT"}).status_code == 422
    assert c.post("/api/admin/users", json={"email": "a@cty.vn", "role": "god"}).status_code == 422
    assert c.post("/api/admin/users", json={"email": "nv.kt@cty.vn"}).status_code == 409


def test_resend_invite_only_for_pending_accounts(api, env, people):
    c = api.login(people["root"])
    new = c.post("/api/admin/users", json={"email": "cho@cty.vn", "department": "it"}).json()
    assert c.post(f"/api/admin/users/{new['id']}/resend").status_code == 200
    env.idp.admin_set_user_password(UserPoolId=env.pool, Username=new["id"], Password="Abcdefgh1234!", Permanent=True)
    assert c.post(f"/api/admin/users/{new['id']}/resend").status_code == 400


def test_department_budget_override_enforced(api, people):
    c = api.login(people["root"])
    deps = {d["name"]: d for d in c.get("/api/admin/departments").json()["departments"]}
    assert deps["ke-toan"]["cap_usd"] == 500.0 and deps["ke-toan"]["users"] == 2 and not deps["ke-toan"]["custom_cap"]

    assert c.put("/api/admin/departments/ke-toan/cap", json={"usd": 1.5}).status_code == 200
    quota.record(people["kt_user"], "ke-toan", "chat", "Claude Haiku 5.5", 1.6)
    with pytest.raises(HTTPException) as e:
        quota.check(people["kt_user"], "ke-toan")
    assert e.value.status_code == 429
    quota.check(people["kd_user"], "kinh-doanh")   # other departments keep the default cap

    deps = {d["name"]: d for d in c.get("/api/admin/departments").json()["departments"]}
    assert deps["ke-toan"]["custom_cap"] and deps["ke-toan"]["month_usd"] == pytest.approx(1.6)
    c.delete("/api/admin/departments/ke-toan/cap")
    assert quota.check(people["kt_user"], "ke-toan")["unit_cap_usd"] == 500.0


def test_budgets_and_audit_are_platform_only(api, people):
    c = api.login(people["kt_admin"])
    assert c.put("/api/admin/departments/ke-toan/cap", json={"usd": 9}).status_code == 403
    assert c.get("/api/admin/audit").status_code == 403
    assert [d["name"] for d in c.get("/api/admin/departments").json()["departments"]] == ["ke-toan"]


def test_admin_actions_land_in_audit_log(api, people):
    c = api.login(people["root"])
    c.patch(f"/api/admin/users/{people['kt_user']}", json={"enabled": False})
    today = dt.datetime.now(dt.timezone.utc).date().isoformat()
    body = c.get("/api/admin/audit", params={"date": today, "action": "admin.user"}).json()
    rec = next(r for r in body["records"] if r["action"] == "admin.user.update")
    assert rec["target"] == people["kt_user"] and rec["email"] == "root@cty.vn" and rec["changes"] == {"enabled": False}
    only_me = c.get("/api/admin/audit", params={"date": today, "user": people["kt_user"]}).json()
    assert only_me["records"] == []
