"""Structured Astra calls and append-only usage receipts (no prompt logging)."""

import base64
import json
import os
import shlex
import time
from datetime import datetime, timezone
from pathlib import Path

from openai import APIConnectionError, APIStatusError, OpenAI
from pydantic import JsonValue, TypeAdapter

from crowd.schema import SCENE_SCHEMA, SCENARIO_SCHEMA, Scene, Scenario

MODEL = "gpt-6-astra"
USAGE_PATH = Path(__file__).resolve().parents[1] / "usage.jsonl"
ENV_PATH = Path(__file__).resolve().parents[1] / ".env"
_OBJECT = TypeAdapter(dict[str, JsonValue])


def load_api_key() -> str | None:
    """Read only OPENAI_API_KEY; an existing environment value takes precedence.

    Accept KEY=VALUE lines, quotes, and comments without executing shell syntax
    or loading unrelated settings. Never log the key or file contents.
    """
    if key := os.getenv("OPENAI_API_KEY"):
        return key
    if not ENV_PATH.exists():
        return None
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        name, separator, value = line.partition("=")
        if separator and name.strip() == "OPENAI_API_KEY":
            try:
                parts = shlex.split(value, comments=True)
            except ValueError:
                raise ValueError("Malformed OPENAI_API_KEY assignment in .env") from None
            if len(parts) > 1:
                raise ValueError("Malformed OPENAI_API_KEY assignment in .env")
            return parts[0] if parts else None
    return None


def _image_url(data: bytes) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        mime = "image/png"
    elif data.startswith(b"\xff\xd8\xff"):
        mime = "image/jpeg"
    elif data.startswith((b"GIF87a", b"GIF89a")):
        mime = "image/gif"
    elif data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        mime = "image/webp"
    else:
        raise ValueError("Images must be PNG, JPEG, GIF, or WebP bytes")
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def ask_structured(
    prompt: str, schema: dict, images: list[bytes] = [], reasoning: str = "low",
    *, timeout_s: float = 45.0, max_output_tokens: int = 2048,
) -> dict:
    """Return a JSON object under the Responses API's strict schema contract.

    Scene/Scenario schemas also receive local Pydantic validation, including
    Shapely scene checks. Future proposal schemas must be validated against the
    original Scene (including locked objects) before acceptance by an endpoint.
    Refusals, incomplete output, API failures, and invalid JSON raise errors.
    Each application call gets a receipt, including failed calls with unknown
    usage represented as null. Estimates use $10/M input and $50/M output;
    they are not invoices and do not adjust for caching or service tiers.
    """
    started = time.perf_counter()
    content = [{"type": "input_text", "text": prompt}]
    content.extend(
        {"type": "input_image", "image_url": _image_url(data), "detail": "auto"}
        for data in images
    )
    receipt = {
        "time": datetime.now(timezone.utc).isoformat(),
        "model": MODEL,
        "reasoning": reasoning,
        "timeout_s": timeout_s,
        "max_output_tokens": max_output_tokens,
        "attempts": 0,
        "input_tokens": None,
        "output_tokens": None,
        "cost_estimate_usd": None,
        "status": "error",
    }
    try:
        # Retry once only for transient transport/status errors, never invalid
        # schemas, authentication, refusals, or incomplete model output.
        with OpenAI(api_key=load_api_key(), max_retries=0, timeout=timeout_s) as client:
            request = dict(
                model=MODEL,
                input=[{"role": "user", "content": content}],
                reasoning={"effort": reasoning},
                max_output_tokens=max_output_tokens,
                text={"format": {
                    "type": "json_schema", "name": "crowd_output",
                    "schema": schema, "strict": True,
                }},
            )
            for attempt in range(2):
                receipt["attempts"] = attempt + 1
                try:
                    response = client.responses.create(**request)
                    break
                except (APIConnectionError, APIStatusError) as exc:
                    transient = isinstance(exc, APIConnectionError) or exc.status_code in (408, 409, 429) or exc.status_code >= 500
                    if attempt or not transient:
                        raise
                    time.sleep(0.5)
        receipt["response_id"] = response.id
        if response.usage is not None:
            receipt.update(
                input_tokens=response.usage.input_tokens,
                output_tokens=response.usage.output_tokens,
                cost_estimate_usd=(
                    response.usage.input_tokens * 10
                    + response.usage.output_tokens * 50
                ) / 1_000_000,
            )
        if response.status != "completed":
            raise RuntimeError(
                f"Astra response {response.id}: status={response.status}, "
                f"details={response.incomplete_details}, error={response.error}"
            )
        for item in response.output:
            if item.type == "message":
                for part in item.content:
                    if part.type == "refusal":
                        raise RuntimeError(f"Astra response {response.id} refused: {part.refusal}")
        parsed = _OBJECT.validate_json(response.output_text, strict=True)
        if schema == SCENE_SCHEMA:
            Scene.model_validate(parsed)
        elif schema == SCENARIO_SCHEMA:
            Scenario.model_validate(parsed)
        receipt["status"] = "completed"
        return parsed
    except Exception as exc:
        receipt["error_type"] = type(exc).__name__
        raise
    finally:
        receipt["elapsed_s"] = round(time.perf_counter() - started, 6)
        with USAGE_PATH.open("a", encoding="utf-8") as log:
            log.write(json.dumps(receipt, allow_nan=False) + "\n")
