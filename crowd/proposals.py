"""Fail-closed application of the model's explicitly permitted Scene edits."""

import re

import numpy as np
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

from crowd.layouts import apply_layout_option
from crowd.schema import Scenario, Scene


_COUNT = r"(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)"
_STAFF = r"(?:volunteers?|servers?|staff(?:ing)?|service positions?)\b"
_WORDS = dict(zip("one two three four five six seven eight nine ten".split(), range(1, 11)))


def _staffing_rule(constraints: str) -> tuple[bool, int | None]:
    text = constraints.lower()
    # A denial wins even when the same brief also contains a positive phrase.
    deny = rf"\b(?:keep|retain|maintain|exactly)\s+(?:the\s+)?(?:{_COUNT}\s+)?(?:current\s+|existing\s+|same\s+)?{_STAFF}"
    clauses = re.split(r"[.;\n]", text)
    negative = r"\b(?:no|not|without|don't|cannot|can't|never|disallow|forbid|prohibit|unchanged|fixed)\b"
    uncertain = r"\b(?:maybe|perhaps|possibly|might)\b|\?"
    if re.search(deny, text) or any(
        re.search(_STAFF, clause) and re.search(negative + "|" + uncertain, clause)
        for clause in clauses
    ):
        return False, None
    limits = re.findall(rf"\bup to\s+({_COUNT})\s+{_STAFF}", text)
    if limits:
        return True, min(int(value) if value.isdigit() else _WORDS[value] for value in limits)
    allow = (
        r"\ballow\s+(?:staffing changes|changing staffing|staff changes)\b"
        r"|\b(?:add|increase|change)\s+(?:(?:more|extra|additional|a|an|\d+)\s+)?" + _STAFF
    )
    return bool(re.search(allow, text)), None


def staffing_permission(constraints: str) -> bool:
    """Only explicit permission allows a changed service-position count."""
    return _staffing_rule(constraints)[0]


def _is_translation(before: list[list[float]], after: object) -> bool:
    if not isinstance(after, list) or len(after) != len(before):
        return False
    try:
        if any(not isinstance(point, list) or len(point) != 2 for point in after):
            return False
        dx, dy = after[0][0] - before[0][0], after[0][1] - before[0][1]
        return all(
            abs(new[0] - old[0] - dx) < 1e-9 and abs(new[1] - old[1] - dy) < 1e-9
            for old, new in zip(before, after)
        )
    except (TypeError, IndexError):
        return False


def apply_candidate(
    scene: Scene,
    scenario: Scenario,
    patch: list[dict],
    constraints: str,
    option_id: str | None = None,
) -> tuple[Scene, Scenario]:
    """Apply replace operations to the JSON document ``{scene, scenario}``.

    A named option is applied first. All edits are atomic and checked against the
    original scene; no error mutates either input. Scenario edits are forbidden.
    """
    working = apply_layout_option(scene, option_id) if option_id is not None else scene
    data = working.model_dump()
    if not isinstance(patch, list):
        raise ValueError("Candidate patch must be a list of JSON patch operations")
    for operation in patch:
        if not isinstance(operation, dict) or set(operation) != {"op", "path", "value"}:
            raise ValueError("Each patch operation requires exactly op, path, and value")
        if operation["op"] != "replace":
            raise ValueError("Only replace operations are permitted")
        path = operation["path"]
        if not isinstance(path, str):
            raise ValueError("Patch path must be a string")
        if path == "/scenario" or path.startswith("/scenario/"):
            raise ValueError(f"Scenario fields are protected: {path}")
        match = re.fullmatch(
            r"/scene/(obstacles|targets)/(0|[1-9]\d*)/(poly|queue_polyline|service_positions)", path
        )
        if not match:
            raise ValueError(f"Patch path is outside permitted scope: {path}")
        collection, index_text, field = match.groups()
        index = int(index_text)
        if index >= len(data[collection]):
            raise ValueError(f"Patch index is out of range: {path}")
        if collection == "obstacles":
            if field != "poly":
                raise ValueError(f"Only obstacle polygon translations are permitted: {path}")
            if scene.obstacles[index].locked:
                raise ValueError(f"Cannot touch locked obstacle {scene.obstacles[index].id}")
            if not _is_translation(data[collection][index][field], operation["value"]):
                raise ValueError("An unlocked obstacle move must preserve its polygon shape")
        elif field not in {"queue_polyline", "service_positions"}:
            raise ValueError("Target polygons may change only through a declared layout option")
        data[collection][index][field] = operation["value"]

    result = Scene.model_validate(data)
    permitted, limit = _staffing_rule(constraints)
    for before, after in zip(scene.targets, result.targets):
        old_count, new_count = max(1, len(before.service_positions)), max(1, len(after.service_positions))
        if old_count != new_count and (not permitted or (limit is not None and new_count > limit)):
            raise ValueError("Service-position count change is not permitted by the staffing constraints")
        if before.id != after.id or before.service_s != after.service_s:
            raise ValueError("Target IDs and service_s are protected")
    for before, after in zip(scene.obstacles, result.obstacles):
        if before.locked and before != after:
            raise ValueError(f"Cannot change locked obstacle {before.id}")
    if [region.id for region in scene.destinations] != [region.id for region in result.destinations]:
        raise ValueError("Destination IDs and order must remain unchanged for matched presampled people")
    return result, scenario.model_copy(deep=True)


def apply_operations(scene: Scene, scenario: Scenario, patch: list[dict]) -> tuple[Scene, Scenario]:
    """Validate an operations preview; only explicit confirmation permits running it.

    Arrival pattern/window may change. Staffing edits add/remove positions while
    preserving the coordinates of the retained servers; geometry moves stay in
    layout proposals. All other Scene and Scenario fields remain protected.
    """
    data, schedule = scene.model_dump(), scenario.model_dump()
    if not isinstance(patch, list) or not patch:
        raise ValueError("An operations change requires a nonempty patch")
    seen = set()
    for operation in patch:
        if not isinstance(operation, dict) or set(operation) != {"op", "path", "value"}:
            raise ValueError("Each patch operation requires exactly op, path, and value")
        path = operation["path"]
        if operation["op"] != "replace" or not isinstance(path, str):
            raise ValueError("Only replace operations with string paths are permitted")
        if path in seen:
            raise ValueError(f"Duplicate operation path: {path}")
        seen.add(path)
        if path in {"/scenario/arrival_pattern", "/scenario/arrival_window_s"}:
            schedule[path.rsplit("/", 1)[1]] = operation["value"]
            continue
        match = re.fullmatch(r"/scene/targets/(0|[1-9]\d*)/service_positions", path)
        if match is None:
            raise ValueError(f"Operations patch path is protected: {path}")
        index = int(match.group(1))
        if index >= len(scene.targets):
            raise ValueError(f"Target index is out of range: {path}")
        positions = operation["value"]
        if not isinstance(positions, list) or not positions:
            raise ValueError("Staffing requires explicit nonempty service positions")
        old = scene.targets[index].service_positions or [scene.targets[index].queue_polyline[0]]
        if len(positions) == len(old):
            raise ValueError("Operations may change service-position count, not move existing servers")
        try:
            before = {tuple(p) for p in old}
            after = {tuple(p) for p in positions}
        except TypeError:
            raise ValueError("Service positions must be coordinate pairs") from None
        if len(after) != len(positions) or not (before < after or after < before):
            raise ValueError("Staffing changes must retain existing server coordinates when adding or removing positions")
        data["targets"][index]["service_positions"] = positions
    updated_scene, updated_scenario = Scene.model_validate(data), Scenario.model_validate(schedule)
    if updated_scene == scene and updated_scenario == scenario:
        raise ValueError("Operations patch does not change an operating assumption")
    return updated_scene, updated_scenario


def operations_preset(scene: Scene, preset: str) -> list[dict]:
    """Deterministic judge controls for the scene's first service target."""
    if preset == "waves_15min":
        return [{"op": "replace", "path": "/scenario/arrival_pattern", "value": "waves"},
                {"op": "replace", "path": "/scenario/arrival_window_s", "value": 900}]
    target = scene.targets[0]
    positions = [list(p) for p in target.service_positions] or [list(target.queue_polyline[0])]
    if preset == "one_volunteer":
        positions = positions[:1]
    elif preset == "third_volunteer":
        if len(positions) >= 3:
            raise ValueError("The target already has at least three service positions")
        floor = Polygon(scene.walkable).difference(unary_union([Polygon(o.poly) for o in scene.obstacles])).buffer(-0.21)
        area = Polygon(target.poly).intersection(floor)
        queue = LineString(target.queue_polyline)
        if area.is_empty:
            raise ValueError("The target has no clearanced position for an additional volunteer")
        x0, y0, x1, y1 = area.bounds
        choices = [(float(x), float(y)) for x in np.arange(x0, x1 + 1e-9, 0.25)
                   for y in np.arange(y0, y1 + 1e-9, 0.25)
                   if area.covers(Point(x, y)) and Point(x, y).distance(queue) >= 0.45
                   and all(Point(x, y).distance(Point(p)) >= 0.45 for p in positions)]
        while len(positions) < 3:
            choices = [p for p in choices if all(Point(p).distance(Point(old)) >= 0.45 for old in positions)]
            if not choices:
                raise ValueError("The target has no clearanced position for an additional volunteer")
            choices.sort(key=lambda p: (-min(Point(p).distance(Point(old)) for old in positions), p))
            positions.append(list(choices[0]))
    else:
        raise ValueError(f"Unknown operations preset: {preset}")
    return [{"op": "replace", "path": "/scene/targets/0/service_positions", "value": positions}]
