"""Runtime configuration. Terraform writes one JSON document to SSM Parameter Store;
the Lambda environment only carries the parameter name, so no setting is baked into code."""
import json
import os
from dataclasses import dataclass, field
from functools import lru_cache

import boto3


@dataclass(frozen=True)
class Settings:
    region: str = "us-east-1"
    env: str = "mvp"
    user_pool_id: str = ""
    client_id: str = ""
    cognito_domain: str = ""
    db_cluster_arn: str = ""
    db_app_secret_arn: str = ""
    db_name: str = "vbot"
    workspace_bucket: str = ""
    audit_bucket: str = ""
    tables: dict = field(default_factory=dict)
    kms_oauth_key: str = ""
    guardrail_id: str = ""
    guardrail_version: str = ""
    sandbox_function: str = ""
    agent_state_machine: str = ""
    llm_provider: str = "auto"              # bedrock | anthropic | auto (Bedrock, fallback Claude API)
    anthropic_secret_arn: str = ""
    anthropic_workspace_id: str = ""        # needed when the key is user-level (sk-ant-usr-...), not workspace-scoped
    google_client_id: str = ""
    google_secret_arn: str = ""
    public_url: str = ""
    daily_user_budget_usd: float = 2.0      # per-user cap
    monthly_unit_budget_usd: float = 500.0  # default per department; admins override it in the quota table


@lru_cache
def settings() -> Settings:
    name = os.environ.get("VBOT_CONFIG_PARAM")
    if name:
        ssm = boto3.client("ssm", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        raw = ssm.get_parameter(Name=name)["Parameter"]["Value"]
        data = json.loads(raw)
    else:  # local development: VBOT_CONFIG_JSON or file
        path = os.environ.get("VBOT_CONFIG_FILE", "config.local.json")
        data = json.loads(os.environ.get("VBOT_CONFIG_JSON") or open(path, encoding="utf-8").read())
    known = Settings.__dataclass_fields__.keys()
    return Settings(**{k: v for k, v in data.items() if k in known})
