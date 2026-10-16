"""Tier 5 image generation: Stable Image Core on Bedrock in us-west-2 (the region that offers
text-to-image). Only the prompt crosses regions, never workspace documents."""
import base64
import json
from functools import lru_cache

import boto3

from .llm import PRICES

MODEL = "stability.stable-image-core-v1:1"
REGION = "us-west-2"


class ImageUnavailable(RuntimeError):
    pass


@lru_cache(maxsize=1)
def _client():
    return boto3.client("bedrock-runtime", region_name=REGION)


def generate(prompt: str) -> tuple[bytes, float, str]:
    try:
        r = _client().invoke_model(modelId=MODEL, body=json.dumps({
            "prompt": prompt, "aspect_ratio": "16:9", "output_format": "png"}))
    except Exception as e:
        raise ImageUnavailable(f"Dịch vụ sinh ảnh chưa sẵn sàng: {str(e)[:160]}") from e
    body = json.loads(r["body"].read())
    if body.get("finish_reasons", [None])[0] not in (None, "SUCCESS"):
        raise ImageUnavailable(f"Ảnh bị từ chối: {body['finish_reasons'][0]}")
    return base64.b64decode(body["images"][0]), PRICES["image_core"]["usd"], "Stable Image Core"
