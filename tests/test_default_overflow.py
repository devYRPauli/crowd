"""Implicit tail-box overflow remains measured, visible, and deterministic."""

import base64

import numpy as np
import pytest
from pydantic import ValidationError
from shapely.geometry import LineString, Point, Polygon

from crowd.engine import run
from crowd.schema import Scenario, Scene, effective_overflow_area


def default_scene():
    return Scene.model_validate({
        "units": "m", "walkable": [[0, 0], [12, 0], [12, 8], [0, 8]],
        "obstacles": [{"id": "desk", "kind": "desk", "locked": False,
                       "poly": [[10.3, 3], [11.3, 3], [11.3, 5], [10.3, 5]]}],
        "entrances": [{"id": "in", "poly": [[0, 3.5], [0.5, 3.5], [0.5, 4.5], [0, 4.5]]}],
        "exits": [{"id": "out", "poly": [[11.5, 6], [12, 6], [12, 7], [11.5, 7]]}],
        "destinations": [{"id": "seat", "poly": [[9, 6], [10, 6], [10, 7], [9, 7]]}],
        "targets": [{"id": "check_in", "poly": [[9.5, 3], [10.3, 3], [10.3, 5], [9.5, 5]],
                     "queue_polyline": [[9, 4], [6, 4]], "service_positions": [[10, 4]],
                     "service_s": 120}],
        "walkways": [{"id": "aisle", "poly": [[5, 3], [7, 3], [7, 5], [5, 5]]}],
    })


def test_default_box_is_deterministic_and_counted_inside_walkway():
    scene = default_scene()
    original = scene.model_dump_json()
    scenario = Scenario(n_people=20, arrival_window_s=0.1, arrival_pattern="uniform",
                        seed=1, horizon_s=60, mode="queue")
    first, second = run(scene, scenario), run(scene, scenario)
    assert first == second
    assert scene.model_dump_json() == original
    assert scene.targets[0].overflow_area is None
    box = Polygon(effective_overflow_area(scene.targets[0]))
    assert box.bounds == (5, 3, 7, 5)
    assert box.area == 4
    assert sum(first.accounting.values()) == 20
    assert first.metrics["overflow_count"] > 0
    assert first.metrics["walkway_conflict_person_s"] > 0
    queue = LineString(scene.targets[0].queue_polyline)
    frames = np.frombuffer(base64.b64decode(first.frames), dtype="<f4").reshape(first.frame_shape)
    overflow_wait_s = 0.0
    for index, person in enumerate(first.people):
        events = first.events[person["id"]]
        for event in events:
            if event["kind"] == "overflow_requested":
                point = Point(event["holding_position"])
                assert box.covers(point)
                assert point.distance(queue) >= 0.43 - 1e-9
        joined = next((e["time_s"] for e in events if e["kind"] == "queue_overflow"), None)
        if joined is None:
            continue
        released = next((e["time_s"] for e in events if e["kind"] == "overflow_end"), 60)
        for frame in range(int(np.ceil(joined / 0.1)), int(released / 0.1)):
            point = Point(frames[frame, index])
            if box.covers(point):
                overflow_wait_s += 0.1
    # There are actual overflow occupants in the walkway, not just main-queue
    # people producing a nonzero conflict metric near its tail.
    assert overflow_wait_s > 0
    assert first.metrics["walkway_conflict_person_s"] >= overflow_wait_s - 0.2


def test_invalid_default_box_is_rejected_instead_of_clipped():
    raw = default_scene().model_dump()
    raw["targets"][0]["queue_polyline"] = [[9, 4], [0.5, 1]]
    with pytest.raises(ValidationError, match="overflow area lies outside room"):
        Scene.model_validate(raw)
