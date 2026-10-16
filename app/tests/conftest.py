"""Test fixtures: AWS is faked with moto (Cognito, DynamoDB, S3); no real account is touched.
The Aurora Data API cannot be faked, so DB-backed endpoints are covered by scripts/e2e.py instead."""
import json
import os

os.environ.update(AWS_ACCESS_KEY_ID="testing", AWS_SECRET_ACCESS_KEY="testing", AWS_SESSION_TOKEN="testing",
                  AWS_DEFAULT_REGION="us-east-1", VBOT_CONFIG_JSON='{"user_pool_id": "x", "client_id": "y"}')
os.environ.pop("AWS_PROFILE", None)
os.environ.pop("VBOT_CONFIG_PARAM", None)

import boto3  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from moto import mock_aws  # noqa: E402

from vbot import aws, config, quota  # noqa: E402
from vbot.auth import User, current_user  # noqa: E402


def _reset_caches():
    config.settings.cache_clear()
    aws.client.cache_clear()
    quota._CAPS.clear()


class Env:
    def __init__(self, pool: str):
        self.pool = pool
        self.idp = boto3.client("cognito-idp", region_name="us-east-1")

    def user(self, email: str, department: str = "default", role: str = "user") -> str:
        u = self.idp.admin_create_user(UserPoolId=self.pool, Username=email, MessageAction="SUPPRESS",
                                       UserAttributes=[{"Name": "email", "Value": email},
                                                       {"Name": "custom:department", "Value": department}])["User"]
        for g in {"user", role}:
            self.idp.admin_add_user_to_group(UserPoolId=self.pool, Username=u["Username"], GroupName=g)
        return u["Username"]

    def groups(self, sub: str) -> set[str]:
        return {g["GroupName"] for g in self.idp.admin_list_groups_for_user(UserPoolId=self.pool, Username=sub)["Groups"]}

    def attr(self, sub: str, name: str) -> str | None:
        u = self.idp.admin_get_user(UserPoolId=self.pool, Username=sub)
        return {a["Name"]: a["Value"] for a in u["UserAttributes"]}.get(name)


@pytest.fixture
def env():
    with mock_aws():
        idp = boto3.client("cognito-idp", region_name="us-east-1")
        pool = idp.create_user_pool(PoolName="vbot-test", UsernameAttributes=["email"],
                                    Schema=[{"Name": "department", "AttributeDataType": "String", "Mutable": True}])["UserPool"]["Id"]
        for g in ("user", "unit_admin", "platform_admin"):
            idp.create_group(UserPoolId=pool, GroupName=g)
        ddb = boto3.client("dynamodb", region_name="us-east-1")
        for t in ("quota", "usage"):
            ddb.create_table(TableName=f"vbot-{t}", BillingMode="PAY_PER_REQUEST",
                             KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
                             AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"}, {"AttributeName": "sk", "AttributeType": "S"}])
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket="vbot-audit")
        os.environ["VBOT_CONFIG_JSON"] = json.dumps({
            "user_pool_id": pool, "client_id": "web-client", "audit_bucket": "vbot-audit",
            "tables": {"quota": "vbot-quota", "usage": "vbot-usage"},
            "daily_user_budget_usd": 2.0, "monthly_unit_budget_usd": 500.0})
        _reset_caches()
        yield Env(pool)
    _reset_caches()


@pytest.fixture
def api(env):
    """TestClient whose caller is chosen with api.login(sub). The token's groups are deliberately
    empty: admin endpoints must decide from live Cognito state, not from the token."""
    from vbot import main

    client = TestClient(main.app)

    def login(sub: str, email: str = "", department: str = "default", token_groups: tuple[str, ...] = ()):
        main.app.dependency_overrides[current_user] = lambda: User(sub, email, token_groups, department)
        return client

    client.login = login
    yield client
    main.app.dependency_overrides.clear()
