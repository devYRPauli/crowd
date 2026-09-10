import base64
from pathlib import Path

import numpy as np
import pytest
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

from crowd.engine import DT, _Density, compare, fifo_schedule, presample_people, run, waiting_positions
from crowd.schema import Result, Scenario, Scene


@pytest.fixture
def scene():
    return Scene.model_validate_json(
        (Path(__file__).parent / "fixtures" / "sample_room.json").read_text()
    )


@pytest.fixture
def scenario():
    return Scenario(
        n_people=5, arrival_window_s=10, arrival_pattern="uniform",
        seed=1, horizon_s=120, mode="queue",
    )


@pytest.fixture
def result(scene, scenario):
    return run(scene, scenario)


def decode(result):
    return np.frombuffer(base64.b64decode(result.frames), dtype="<f4").reshape(result.frame_shape)


@pytest.mark.parametrize("k,expected", [(1, [0, 10, 20]), (2, [0, 0, 10])])
def test_fifo_arithmetic(k, expected):
    assert fifo_schedule([0, 0, 0], [10, 10, 10], k) == expected


def test_fifo_order_and_idle_time():
    assert fifo_schedule([20, 0, 0], [5, 10, 10], 1) == [0, 0, 10]
    assert fifo_schedule([0, 20], [10, 10], 1) == [0, 0]
    assert fifo_schedule([], [], 2) == []


@pytest.mark.parametrize("arrivals,services,k", [
    ([0], [], 1), ([0], [10], 0), ([0], [10], True),
    ([-1], [10], 1), ([0], [float("nan")], 1),
])
def test_fifo_invalid_inputs(arrivals, services, k):
    with pytest.raises(ValueError):
        fifo_schedule(arrivals, services, k)


def test_waiting_positions_head_first(scene):
    positions = waiting_positions(scene.targets[0].queue_polyline)
    assert positions[:5] == [(5, 9.5), (4.5, 9.5), (4, 9.5), (3.5, 9.5), (3, 9.5)]
    assert positions[-1] == (13, 7)
    assert len(positions) == 30
    assert waiting_positions([[0, 0], [1.2, 0]]) == [(0, 0), (0.5, 0), (1, 0)]


def test_presampling_and_layout_reuse(scene, scenario):
    scenario.n_people = 150
    scenario.arrival_pattern = "front_loaded"
    people = presample_people(scene, scenario)
    assert sum(p["arrival_s"] < scenario.arrival_window_s / 2 for p in people) == 105
    assert all(0 <= p["arrival_s"] <= scenario.arrival_window_s for p in people)
    assert all(0.6 <= p["preferred_speed_m_s"] <= 1.8 for p in people)
    assert all(p["service_s"] >= 3 for p in people)
    changed = scene.model_copy(deep=True)
    changed.targets[0].queue_polyline = [[5, 9.5], [3, 9.5], [3, 12], [13, 12]]
    assert people == presample_people(changed, scenario)
    scenario.seed += 1
    assert people != presample_people(scene, scenario)


def test_determinism_and_purity(scene, scenario):
    before = (scene.model_dump_json(), scenario.model_dump_json())
    a = run(scene, scenario)
    b = run(scene, scenario)
    assert a.frames == b.frames
    assert a.model_dump() == b.model_dump()
    assert before == (scene.model_dump_json(), scenario.model_dump_json())
    assert a.people == presample_people(scene, scenario)


def test_events_waits_service_and_accounting(result):
    assert sum(result.accounting.values()) == len(result.people)
    assert result.accounting == {"not_arrived": 0, "walking": 0, "queued": 0, "in_service": 0, "done": 5}
    assert result.metrics["completed"] == 5
    waits = []
    intervals = []
    for person in result.people:
        events = result.events[person["id"]]
        assert [e["kind"] for e in events] == ["spawned", "joined_queue", "service_start", "service_end", "seated"]
        times = [e["time_s"] for e in events]
        assert times == sorted(times)
        assert person["arrival_s"] <= times[0] < person["arrival_s"] + DT
        assert person["service_s"] <= times[3] - times[2] + 1e-9
        assert times[3] - times[2] < person["service_s"] + DT + 1e-9
        start = events[2]
        assert np.linalg.norm(np.array(start["position"]) - start["service_position"]) <= 0.35
        waits.append(times[2] - times[1])
        intervals.append((tuple(start["service_position"]), times[2], times[3]))
    for i, (position, start, end) in enumerate(intervals):
        for other, start2, end2 in intervals[i + 1:]:
            if position == other:
                assert end <= start2 or end2 <= start
    assert result.metrics["mean_wait_s"] == pytest.approx(np.mean(waits))
    assert result.metrics["max_wait_s"] == pytest.approx(max(waits))
    assert result.metrics["queue_wait_person_s"] == pytest.approx(sum(waits))
    assert result.metrics["walkway_conflict_person_s"] > 0


def test_frames_geometry_and_roundtrip(result, scene):
    frames = decode(result)
    assert frames.shape == (1201, 5, 2)
    assert np.isnan(frames[0]).all()
    assert np.isnan(frames[-1]).all()
    floor = Polygon(scene.walkable).difference(unary_union([Polygon(o.poly) for o in scene.obstacles]))
    for point in frames.reshape(-1, 2):
        if np.isfinite(point).all():
            assert floor.covers(Point(point))
    assert Result.model_validate_json(result.model_dump_json()) == result


def test_overflow_visible_and_censored(scene, scenario):
    scene.targets[0].queue_polyline = [[5, 9.5], [4.5, 9.5]]
    scene.targets[0].service_s = 120
    scenario.n_people = 30
    scenario.arrival_window_s = 0.1
    scenario.horizon_s = 60
    result = run(scene, scenario)
    assert sum(result.accounting.values()) == 30
    # Crowding can prevent a head/assigned person from physically reaching service.
    assert 1 <= result.accounting["in_service"] <= 2
    assert result.accounting["queued"] > 2
    assert result.metrics["overflow_count"] > 0
    assert result.metrics["censored_wait_count"] == result.accounting["queued"]
    requested = [i for i, p in enumerate(result.people) if any(e["kind"] == "overflow_requested" for e in result.events[p["id"]])]
    assert result.metrics["overflow_count"] == len(requested)
    waiting_in_overflow = [
        i for i in requested
        if "queue_overflow" in {e["kind"] for e in result.events[result.people[i]["id"]]}
        and "overflow_end" not in {e["kind"] for e in result.events[result.people[i]["id"]]}
    ]
    assert waiting_in_overflow
    last = decode(result)[-1]
    assert np.isfinite(last[requested]).all()
    area = Polygon(scene.targets[0].overflow_area)
    assert all(area.covers(Point(last[i])) for i in waiting_in_overflow)
    assert result.metrics["spawn_delayed_count"] > 0
    assert result.metrics["spawn_native_rejections"] > 0



def test_overflow_advances_in_arrival_order(scene, scenario):
    scene.targets[0].queue_polyline = [[5, 9.5], [4.5, 9.5]]
    scene.targets[0].service_s = 3
    scenario.n_people = 12
    scenario.arrival_window_s = 0.1
    scenario.horizon_s = 240
    result = run(scene, scenario)
    promotions = []
    requested = []
    for i, person in enumerate(result.people):
        kinds = [e["kind"] for e in result.events[person["id"]]]
        if "overflow_requested" in kinds:
            requested.append((person["arrival_s"], i))
            assert kinds.count("queue_overflow") == 1
            assert kinds.count("overflow_end") == 1
            assert kinds.index("queue_overflow") < kinds.index("overflow_end")
            promoted = next(e for e in result.events[person["id"]] if e["kind"] == "overflow_end")
            promotions.append((promoted["time_s"], i))
    assert len(promotions) >= 3
    assert [i for _, i in sorted(promotions)] == [i for _, i in sorted(requested)]
    assert result.accounting["done"] == 12


def test_not_arrived_accounted_at_short_horizon(scene, scenario):
    scenario.horizon_s = 0.1
    result = run(scene, scenario)
    assert result.accounting["not_arrived"] == scenario.n_people
    assert sum(result.accounting.values()) == scenario.n_people
    assert result.metrics["mean_wait_s"] is None
    assert result.metrics["completed"] == 0


def test_service_position_fallback(scene, scenario):
    scene.targets[0].service_positions = []
    scenario.n_people = 1
    result = run(scene, scenario)
    assert result.accounting["done"] == 1
    start = next(e for e in result.events["p0"] if e["kind"] == "service_start")
    assert start["service_position"] == [5, 9.5]


def test_service_positions_can_reserve_leading_queue_slots(scene, scenario):
    scene.targets[0].service_positions = [[5, 9.5], [4.5, 9.5]]
    scene.targets[0].poly = [[4, 9], [9, 9], [9, 10], [4, 10]]
    scenario.n_people = 2
    result = run(scene, scenario)
    assert result.accounting["done"] == 2


def test_compare_changed_layout_reuses_people(scene, scenario, result):
    scene.targets[0].queue_polyline = [[5, 9.5], [3, 9.5], [3, 12], [13, 12]]
    changed = run(scene, scenario)
    assert changed.people == result.people
    assert changed.frames != result.frames
    assert changed.scene_hash != result.scene_hash
    assert compare(result, changed)["valid"]


def test_density_sustained_threshold_and_reset():
    density = _Density((0, 0, 1, 1))
    point = np.array([[0.25, 0.25]])
    empty = np.empty((0, 2))
    for _ in range(200):
        density.update(point, DT)
    assert density.result(10).bottleneck_cells == []
    density.update(point, DT)
    grid = density.result(10.05)
    assert grid.bottleneck_cells == [[0, 0]]
    assert grid.max_persons_m2[0][0] == 4
    assert grid.mean_persons_m2[0][0] == pytest.approx(4)
    assert grid.max_sustained_s[0][0] == 10.05
    density = _Density((0, 0, 1, 1))
    for _ in range(2):
        density.update(point, 6)
        density.update(empty, DT)
    assert density.result(12.1).bottleneck_cells == []


def test_compare_population_and_scenario_guards(result):
    assert compare(result, result)["status"] == "equivalent"
    different = result.model_copy(deep=True)
    different.people[0]["preferred_speed_m_s"] += 0.01
    with pytest.raises(ValueError, match="presampled people"):
        compare(result, different)
    different = result.model_copy(deep=True)
    different.scenario_hash = "f" * 64
    with pytest.raises(ValueError, match="scenarios"):
        compare(result, different)


def test_compare_never_rewards_fewer_completions(result):
    fewer = result.model_copy(deep=True)
    fewer.accounting["done"] -= 1
    fewer.accounting["queued"] += 1
    for metric in fewer.metrics:
        if metric not in ("wait_observations",):
            fewer.metrics[metric] = 0
    fewer.metrics["completed"] = fewer.accounting["done"]
    assert compare(result, fewer)["better"] != "b"
    assert compare(fewer, result)["better"] != "a"
    improvement = result.model_copy(deep=True)
    improvement.metrics["walkway_conflict_person_s"] = 0
    assert compare(result, improvement)["better"] == "b"
