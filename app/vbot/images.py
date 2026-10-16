"""Tier 5 images.

Primary: Stable Image Core on Bedrock in us-west-2 (the region that offers text-to-image; only
the prompt crosses regions). Fallback when Bedrock is unavailable: Claude draws an SVG
illustration, which also suits diagrams and mockups better than a raster image."""
import base64
import json
import re
from functools import lru_cache

import boto3

from . import llm
from .llm import PRICES

MODEL = "stability.stable-image-core-v1:1"
REGION = "us-west-2"
SVG_PROMPT = """Vẽ một hình minh họa dạng SVG cho mô tả dưới đây.
Yêu cầu: chỉ trả về đúng một phần tử <svg>…</svg> hợp lệ (viewBox="0 0 1280 720"), không markdown, không giải thích,
không script, không ảnh ngoài, không font ngoài; bố cục phẳng, gọn, màu hài hòa; chữ (nếu có) bằng tiếng Việt.
Mô tả: """


class ImageUnavailable(RuntimeError):
    pass


@lru_cache(maxsize=1)
def _client():
    return boto3.client("bedrock-runtime", region_name=REGION)


def _stability(prompt: str):
    r = _client().invoke_model(modelId=MODEL, body=json.dumps({"prompt": prompt, "aspect_ratio": "16:9", "output_format": "png"}))
    body = json.loads(r["body"].read())
    if body.get("finish_reasons", [None])[0] not in (None, "SUCCESS"):
        raise ImageUnavailable(f"Ảnh bị từ chối: {body['finish_reasons'][0]}")
    return base64.b64decode(body["images"][0]), PRICES["image_core"]["usd"], "Stable Image Core", "image/png"


def _svg(prompt: str):
    text, _usage, usd = llm.complete("sonnet", "low", [{"role": "user", "content": SVG_PROMPT + prompt}], max_tokens=8000)
    m = re.search(r"<svg[\s\S]*</svg>", text)
    if not m:
        raise ImageUnavailable("Model không trả về SVG hợp lệ")
    svg = re.sub(r"<script[\s\S]*?</script>|\son\w+=\"[^\"]*\"|href=\"(?!#)[^\"]*\"", "", m.group(0))  # strip active content
    return svg.encode("utf-8"), usd, "Claude Sonnet 5.5 (SVG)", "image/svg+xml"


def generate(prompt: str) -> tuple[bytes, float, str, str]:
    """Returns (bytes, usd, model label, mime type)."""
    try:
        return _stability(prompt)
    except ImageUnavailable:
        raise
    except Exception as e:
        try:
            return _svg(prompt)
        except llm.ProviderUnavailable as e2:
            raise ImageUnavailable(f"Dịch vụ sinh ảnh chưa sẵn sàng (Bedrock: {str(e)[:80]}; {e2})") from e2
