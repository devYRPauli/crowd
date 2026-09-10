"""Operations comparisons preserve person identity while changing arrivals."""

from collections import Counter
from copy import deepcopy
from pathlib import Path

import pytest

from crowd.engine import compare, compare_operations, presample_people, reschedule_people, run
from crowd.schema import Scenario, Scene


@pytest.fixture
def inputs():
    scene = Scene.model_validate_json(
        (Path(__file__).parent / "fixtures" / "sample_room.json").read_text()
    )
    scenario = Scenario(n_people=5, arrival_window_s=10, arrival_pattern="front_loaded",
                        seed=1, horizon_s=100, mode="queue")
    return scene, scenario


def test_explicit_presampled_people_preserve_default_frames_and_inputs(inputs):
    scene, scenario = inputs
    people = presample_people(scene, scenario)
    before = deepcopy(people)
    automatic = run(scene, scenario)
    explicit = run(scene, scenario, people=people)
    assert explicit == automatic
    assert explicit.frames == automatic.frames
    assert people == before
    assert explicit.people == people
    explicit.people[0]["service_s"] = 999
    assert people == before


@pytest.mark.parametrize("field,value", [
    ("id", ""), ("id", 3), ("arrival_s", -1), ("arrival_s", 11),
    ("arrival_s", float("nan")), ("preferred_speed_m_s", float("inf")),
    ("preferred_speed_m_s", 0.5), ("preferred_speed_m_s", 2),
    ("preferred_speed_m_s", True), ("service_s", 2.9), ("service_s", "12"),
    ("spawn_choice", -0.1), ("spawn_choice", 1), ("target_id", "missing"),
    ("entrance_id", "missing"), ("destination_id", "missing"),
])
def test_run_rejects_invalid_supplied_person(inputs, field, value):
    scene, scenario = inputs
    people = presample_people(scene, scenario)
    people[0][field] = value
    with pytest.raises(ValueError, match="Presampled person"):
        run(scene, scenario, people=people)


@pytest.mark.parametrize("defect", ["count", "duplicate", "missing_field", "extra_field"])
def test_run_rejects_invalid_population_contract(inputs, defect):
    scene, scenario = inputs
    people = presample_people(scene, scenario)
    if defect == "count":
        people.pop()
    elif defect == "duplicate":
        people[1]["id"] = people[0]["id"]
    elif defect == "missing_field":
        del people[0]["spawn_choice"]
    else:
        people[0]["injected"] = "unsupported"
    with pytest.raises(ValueError):
        run(scene, scenario, people=people)


def test_rescheduling_reuses_every_nonarrival_value_even_when_window_shrinks(inputs):
    scene, scenario = inputs
    people = presample_people(scene, scenario)
    before = deepcopy(people)
    changed = scenario.model_copy(update={"arrival_window_s": 1, "arrival_pattern": "uniform"})
    result = reschedule_people(scene, changed, people)
    expected = presample_people(scene, changed)
    assert [p["arrival_s"] for p in result] == [p["arrival_s"] for p in expected]
    for original, rescheduled in zip(people, result):
        assert {k: v for k, v in original.items() if k != "arrival_s"} == {
            k: v for k, v in rescheduled.items() if k != "arrival_s"
        }
    assert people == before
    assert result == reschedule_people(scene, changed, people)


def test_waves_are_five_actual_equal_batches_and_rescheduling_preserves_people(inputs):
    scene, scenario = inputs
    original = scenario.model_copy(update={"n_people": 150, "arrival_window_s": 600})
    people = presample_people(scene, original)
    waves = original.model_copy(update={"arrival_pattern": "waves", "arrival_window_s": 900})
    assert Scenario.model_validate_json(waves.model_dump_json()) == waves
    changed = reschedule_people(scene, waves, people)
    assert Counter(p["arrival_s"] for p in changed) == {0: 30, 180: 30, 360: 30, 540: 30, 720: 30}
    assert [p["arrival_s"] for p in changed] == [p["arrival_s"] for p in presample_people(scene, waves)]
    assert [{k: v for k, v in p.items() if k != "arrival_s"} for p in changed] == [
        {k: v for k, v in p.items() if k != "arrival_s"} for p in people
    ]


@pytest.fixture
def operations_results(inputs):
    scene, scenario = inputs
    baseline = run(scene, scenario)
    changed = scenario.model_copy(update={"arrival_pattern": "waves", "arrival_window_s": 15})
    people = reschedule_people(scene, changed, baseline.people)
    candidate = run(scene, changed, people=people)
    return baseline, candidate


def test_operations_comparison_is_labeled_and_never_an_automatic_winner(operations_results):
    baseline, candidate = operations_results
    with pytest.raises(ValueError, match="different presampled people"):
        compare(baseline, candidate)
    output = compare_operations(baseline, candidate)
    assert output["valid"]
    assert output["better"] is None
    assert output["label"] == "different arrival schedule, same people and service times"
    assert output["completed"] == {"a": baseline.accounting["done"], "b": candidate.accounting["done"]}
    assert output["deltas_b_minus_a"]["completed"] == candidate.metrics["completed"] - baseline.metrics["completed"]
    # Even a fabricated apparent improvement cannot change this mode's verdict.
    candidate.metrics["mean_wait_s"] = 0
    candidate.accounting["done"] = baseline.accounting["done"] + 1
    assert compare_operations(baseline, candidate)["better"] is None
    candidate.accounting["done"] = 0
    assert compare_operations(baseline, candidate)["better"] is None


@pytest.mark.parametrize("field,value", [
    ("id", "someone_else"), ("service_s", 100), ("preferred_speed_m_s", 1.7),
    ("entrance_id", "another_entrance"), ("target_id", "another_target"),
    ("destination_id", "another_destination"), ("spawn_choice", 0.99),
])
def test_operations_comparison_refuses_nonarrival_changes(operations_results, field, value):
    baseline, candidate = operations_results
    candidate.people[0][field] = value
    with pytest.raises(ValueError, match="non-arrival person fields"):
        compare_operations(baseline, candidate)


def test_operations_comparison_allows_scene_changes_but_refuses_horizon_changes(operations_results):
    baseline, candidate = operations_results
    candidate.scene_hash = "f" * 64
    assert compare_operations(baseline, candidate)["valid"]
    candidate.horizon_s += 1
    with pytest.raises(ValueError, match="different horizons"):
        compare_operations(baseline, candidate)


def test_unchanged_arrivals_use_strict_comparison(inputs):
    result = run(*inputs)
    assert compare_operations(result, result) == compare(result, result)
    changed = result.model_copy(update={"scenario_hash": "f" * 64})
    with pytest.raises(ValueError, match="different scenarios"):
        compare(result, changed)
    comparison = compare_operations(result, changed)
    assert comparison["valid"]
    assert comparison["better"] is None
    assert comparison["label"] == "different arrival schedule, same people and service times"
