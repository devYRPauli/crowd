"""Validated Astra wire contracts and deterministic presentation of measurements."""

import copy
import json
import re
from typing import Annotated, Literal

from pydantic import Field, FiniteFloat

from crowd.schema import Contract, Coordinate, Scenario, Scene


class Interpretation(Contract):
    scenario: Scenario
    scene: Scene | None
    assumptions: list[str]


class Patch(Contract):
    op: Literal["replace"]
    path: str
    value: str | FiniteFloat | list[Coordinate] | None


class Proposal(Contract):
    option_id: str | None
    patch: Annotated[list[Patch], Field(max_length=20)]
    rationale: str


class Proposals(Contract):
    candidates: Annotated[list[Proposal], Field(max_length=2)]


class Explanation(Contract):
    explanation: str


def strict_schema(model: type[Contract]) -> dict:
    """Responses strict objects require all properties, including nullable ones."""
    schema = copy.deepcopy(model.model_json_schema())

    def visit(value):
        if isinstance(value, dict):
            value.pop("default", None)
            if value.get("type") == "object":
                value["additionalProperties"] = False
                value["required"] = list(value.get("properties", {}))
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(schema)
    return schema


def assumption_receipt(output: Interpretation) -> list[str]:
    """Every chosen parameter is shown for confirmation, even if Astra omits it."""
    notes = list(output.assumptions)
    notes.extend(f"{key} = {value}" for key, value in output.scenario.model_dump().items())
    if output.scene is None:
        notes.append("Service time and staffing remain those in the currently loaded scene.")
    else:
        for target in output.scene.targets:
            notes.append(f"{target.id}: service_s = {target.service_s}; staffing = {len(target.service_positions) or 1}.")

        def numbers(value, path):
            if isinstance(value, list) and value and isinstance(value[0], (int, float, list)):
                notes.append(f"{path} = {json.dumps(value, separators=(',', ':'))}")
            elif isinstance(value, list):
                for i, item in enumerate(value):
                    numbers(item, f"{path}[{i}]")
            elif isinstance(value, dict):
                for key, item in value.items():
                    numbers(item, f"{path}.{key}")
            elif isinstance(value, (int, float)) and not isinstance(value, bool):
                notes.append(f"{path} = {value}")

        numbers(output.scene.model_dump(), "scene")
    return list(dict.fromkeys(notes))


_NUMBER = re.compile(r"\d|\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|percent|half|halved|quarter|twice|double|doubled|triple|tripled)\b", re.I)
_CLAIM = re.compile(r"\b((?:un)?safe(?:r|st|ly|ty)?|optim(?:al|ally|ality|um)|validat(?:e|ed|ion))\b", re.I)
_TOKEN = re.compile(r"\{\{(baseline|candidate|delta)\.([A-Za-z_][A-Za-z_0-9]*)\}\}")


def qualitative_rationale(text: str) -> str:
    if not text.strip() or "\n" in text or _NUMBER.search(text) or any(c.isnumeric() for c in text) or _CLAIM.search(text):
        raise ValueError("Rationale must be one qualitative line without numeric or safety/optimality claims")
    return text.strip()


def measurement_context(baseline: dict, candidate: dict, baseline_accounting: dict, candidate_accounting: dict) -> dict:
    before = {**baseline_accounting, **baseline}
    after = {**candidate_accounting, **candidate}
    delta = {key: after[key] - value if value is not None and after[key] is not None else None
             for key, value in before.items() if key in after}
    return {"baseline": before, "candidate": after, "delta": delta}


def materially_helped(context: dict) -> bool:
    before, after = context["baseline"], context["candidate"]
    if after.get("done", after.get("completed", 0)) < before.get("done", before.get("completed", 0)):
        return False
    if after.get("done", after.get("completed", 0)) > before.get("done", before.get("completed", 0)):
        return True
    fields = ("mean_wait_s", "max_wait_s", "walkway_conflict_person_s", "overflow_count")
    return any(before.get(key) is not None and after.get(key) is not None and before[key] > 0
               and after[key] <= before[key] * 0.95 for key in fields)


def render_explanation(text: str, context: dict) -> str:
    """Only deterministic tokens supply numbers in the explanation shown in UI."""
    text = " ".join(text.split())
    prose = _TOKEN.sub("MEASUREMENT", text)
    if not text or _NUMBER.search(prose) or any(c.isnumeric() for c in prose) or _CLAIM.search(prose):
        raise ValueError("Explanation must use measurement tokens, not invented numbers or safety/optimality claims")
    changed = [key for key, value in context["delta"].items() if value is not None and abs(value) > 1e-9]
    if changed and not any(key in text for key in changed):
        raise ValueError("Explanation must name a metric field that changed")
    if changed and not any(match.group(2) in changed for match in _TOKEN.finditer(text)):
        raise ValueError("Explanation must quantify a changed field with its measurement tokens")

    def substitute(match):
        group, field = match.groups()
        if field not in context[group]:
            raise ValueError(f"Unknown measurement token: {group}.{field}")
        value = context[group][field]
        return "unavailable" if value is None else f"{value:,.2f}".rstrip("0").rstrip(".")

    rendered = _TOKEN.sub(substitute, text)
    if "{{" in rendered or "}}" in rendered:
        raise ValueError("Invalid measurement token")
    if not materially_helped(context):
        rendered = "This candidate did not materially help. " + rendered
    return rendered
