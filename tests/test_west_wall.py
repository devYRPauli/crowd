"""Regression for a queue whose head is separate from two west-wall servers."""

from collections import Counter
from pathlib import Path

import numpy as np
import pytest

from crowd.engine import compare, run
from crowd.schema import Scenario, Scene


@pytest.fixture(scope="module")
def venue_runs():
    baseline = Scene.model_validate_json(
        (Path(__file__).parent / "fixtures" / "venue.json").read_text()
    )
    candidate_data = baseline.model_dump()
    buffet = next(o for o in candidate_data["obstacles"] if o["id"] == "buffet_table")
    buffet["poly"] = [[0, 2], [1.5, 2], [1.5, 7], [0, 7]]
    target = next(t for t in candidate_data["targets"] if t["id"] == "buffet")
    target.update(
        poly=[[1.5, 2], [2.5, 2], [2.5, 7], [1.5, 7]],
        service_positions=[[2, 4], [2, 5.5]],
        queue_polyline=[[2.65, 4.75], [2.65, 3.3], [18, 3.3], [21, 3.3], [21, 6]],
    )
    candidate_data["destinations"] = [{
        "id": "disperse", "poly": [[1.5, 1], [2.5, 1], [2.5, 1.75], [1.5, 1.75]],
    }]
    candidate = Scene.model_validate(candidate_data)
    scenario = Scenario(
        n_people=150, arrival_window_s=600, arrival_pattern="front_loaded",
        seed=1, horizon_s=1800, mode="queue",
    )
    return run(baseline, scenario), run(candidate, scenario)


def test_west_wall_handoff_completes_with_both_servers(venue_runs):
    baseline, candidate = venue_runs
    for result in venue_runs:
        assert result.accounting == {
            "not_arrived": 0, "walking": 0, "queued": 0, "in_service": 0, "done": 150,
        }
        assert result.metrics["completed"] == 150
        assert max(row["in_service"] for row in result.diagnostics if row["time_s"] <= 600) == 2
        assert [row["time_s"] for row in result.diagnostics] == list(range(0, 1801, 10))
        for row in result.diagnostics:
            for head in row["heads"].values():
                assert head["main_reserved"] <= head["main_capacity"]
                assert head["native_length"] <= head["main_capacity"]
                assert head["overflow_reserved"] <= head["overflow_capacity"]
    assert baseline.people == candidate.people
    assert compare(baseline, candidate)["valid"]
    assert (
        candidate.metrics["walkway_conflict_person_s"]
        < baseline.metrics["walkway_conflict_person_s"] * 0.4
    )


def test_west_wall_release_never_requeues_and_service_starts_on_arrival(venue_runs):
    required = ["spawned", "joined_queue", "service_start", "service_end", "reached_destination", "exited"]
    for result in venue_runs:
        for person in result.people:
            events = result.events[person["id"]]
            counts = Counter(event["kind"] for event in events)
            assert all(counts[kind] == 1 for kind in required)
            lifecycle = [event for event in events if event["kind"] in required]
            assert [event["kind"] for event in lifecycle] == required
            assert [event["time_s"] for event in events] == sorted(event["time_s"] for event in events)
            started = lifecycle[2]
            assert np.linalg.norm(
                np.asarray(started["position"]) - started["service_position"]
            ) <= 0.35
            assert not any(
                event["kind"] in {"joined_queue", "queue_overflow"}
                and event["time_s"] > started["time_s"]
                for event in events
            )


def test_west_wall_distant_handoff_route_is_deterministic(venue_runs):
    from scripts.diagnose_engine import west_wall_candidate

    baseline = Scene.model_validate_json(
        (Path(__file__).parent / "fixtures" / "venue.json").read_text()
    )
    scene = Scene.model_validate(west_wall_candidate(baseline.model_dump()))
    scenario = Scenario(n_people=150, arrival_window_s=600, arrival_pattern="front_loaded",
                        seed=1, horizon_s=1800, mode="queue")
    repeated = run(scene, scenario)
    candidate = venue_runs[1]
    assert repeated.frames == candidate.frames
    assert repeated.events == candidate.events
    assert repeated.diagnostics == candidate.diagnostics
    assert any(e["kind"] == "handoff_routed" for events in candidate.events.values() for e in events)
