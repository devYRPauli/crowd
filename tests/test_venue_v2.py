"""Version-two narrow-door venues must finish without dropping or requeuing people."""

from collections import Counter
from pathlib import Path

import numpy as np
import pytest
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

from crowd.engine import compare, run
from crowd.schema import Scenario, Scene

FIXTURES = Path(__file__).parent / "fixtures"


def venue(side):
    return Scene.model_validate_json((FIXTURES / f"venue_v2_{side}.json").read_text())


def scenario(n_people=150, arrival_window_s=600, horizon_s=1800):
    return Scenario(
        n_people=n_people, arrival_window_s=arrival_window_s,
        arrival_pattern="front_loaded", seed=1, horizon_s=horizon_s, mode="queue",
    )


@pytest.fixture(scope="module")
def v2_runs():
    return {side: run(venue(side), scenario()) for side in ("east", "west")}


@pytest.mark.parametrize("side", ["east", "west"])
def test_v2_all_people_finish_and_both_servers_work(v2_runs, side):
    result = v2_runs[side]
    assert result.accounting == {
        "not_arrived": 0, "walking": 0, "queued": 0, "in_service": 0, "done": 150,
    }
    assert result.metrics["completed"] == 150
    assert max(row["in_service"] for row in result.diagnostics if row["time_s"] <= 600) == 2
    assert [row["time_s"] for row in result.diagnostics] == list(range(0, 1801, 10))


@pytest.mark.parametrize("side", ["east", "west"])
def test_v2_lifecycle_is_complete_ordered_and_never_requeues(v2_runs, side):
    required = ["spawned", "joined_queue", "service_start", "service_end", "reached_destination", "exited"]
    result = v2_runs[side]
    for person in result.people:
        events = result.events[person["id"]]
        kinds = Counter(event["kind"] for event in events)
        assert all(kinds[kind] == 1 for kind in required)
        lifecycle = [event for event in events if event["kind"] in required]
        assert [event["kind"] for event in lifecycle] == required
        assert [event["time_s"] for event in events] == sorted(event["time_s"] for event in events)
        started = lifecycle[2]
        assert np.linalg.norm(np.asarray(started["position"]) - started["service_position"]) <= 0.35
        assert not any(
            event["kind"] in {"joined_queue", "queue_overflow"}
            and event["time_s"] > started["time_s"]
            for event in events
        )


def test_v2_comparison_reuses_exact_people(v2_runs):
    east, west = v2_runs["east"], v2_runs["west"]
    assert east.people == west.people
    assert compare(east, west)["valid"]


@pytest.mark.parametrize("side", ["east", "west"])
def test_v2_narrow_entrance_spawn_fallback_is_deterministic(side):
    room, demand = venue(side), scenario(n_people=12, arrival_window_s=2, horizon_s=600)
    before = room.model_dump_json(), demand.model_dump_json()
    first, second = run(room, demand), run(room, demand)
    assert first.accounting["done"] == 12
    fallback = [events[0] for events in first.events.values() if events[0].get("fallback")]
    assert fallback
    assert first.metrics["spawn_fallback_count"] == len(fallback)
    entrance = Polygon(room.entrances[0].poly)
    accessible = Polygon(room.walkable).difference(unary_union([Polygon(o.poly) for o in room.obstacles]))
    for event in fallback:
        point = Point(event["position"])
        assert entrance.distance(point) <= 1 + 1e-9
        assert accessible.covers(point)
    assert first.frames == second.frames
    assert first.events == second.events
    assert first.diagnostics == second.diagnostics
    assert before == (room.model_dump_json(), demand.model_dump_json())
