"""Shared boto3 clients (created once per Lambda execution environment)."""
from functools import lru_cache

import boto3
from botocore.config import Config

from .config import settings

_cfg = Config(retries={"max_attempts": 4, "mode": "adaptive"}, read_timeout=120, connect_timeout=5)


# SSE-KMS buckets only accept SigV4 presigned URLs; regional endpoint avoids a redirect.
_s3_cfg = _cfg.merge(Config(signature_version="s3v4", s3={"addressing_style": "virtual"}))


@lru_cache(maxsize=None)
def client(name: str):
    if name == "s3":
        return boto3.client("s3", region_name=settings().region, config=_s3_cfg,
                            endpoint_url=f"https://s3.{settings().region}.amazonaws.com")
    if name == "lambda":  # sandbox runs are not idempotent: never retry, wait for the full run
        return boto3.client("lambda", region_name=settings().region,
                            config=Config(retries={"max_attempts": 1, "mode": "standard"}, read_timeout=200, connect_timeout=5))
    return boto3.client(name, region_name=settings().region, config=_cfg)


@lru_cache(maxsize=None)
def secret(arn: str) -> str:
    return client("secretsmanager").get_secret_value(SecretId=arn)["SecretString"]
