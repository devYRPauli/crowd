"""Proposal permissions are checked against the original scene, atomically."""

from pathlib import Path

import pytest
from pydantic import ValidationError

from crowd.proposals import apply_candidate, staffing_permission
from crowd.schema import Scenario, Scene


@pytest.fixture
def inputs():
    scene = Scene.model_validate_json(
        (Path(__file__).parent / "fixtures" / "sample_room.json").read_text()
    )
    scenario = Scenario(n_people=150, arrival_window_s=600, arrival_pattern="front_loaded",
                        seed=1, horizon_s=1800, mode="queue")
    return scene, scenario


def replace(path, value):
    return [{"op": "replace", "path": path, "value": value}]


@pytest.mark.parametrize("field,value", [
    ("n_people", 20), ("arrival_pattern", "uniform"), ("arrival_window_s", 500),
    ("seed", 2), ("horizon_s", 2000), ("mode", "queue"),
])
def test_forbidden_scenario_fields(inputs, field, value):
    with pytest.raises(ValueError, match="Scenario fields are protected"):
        apply_candidate(*inputs, replace(f"/scenario/{field}", value), "allow staffing changes")


@pytest.mark.parametrize("path,value", [
    ("/scene/targets/0/service_s", 2),
    ("/scene/obstacles/1/locked", False),
    ("/scene/obstacles/1", {}),
    ("/scene/obstacles", []),
    ("/scene/layout_options", []),
    ("/scene/destinations", []),
    ("/scene/targets/0/id", "changed"),
    ("/scene/targets/0/poly", [[2, 2], [3, 2], [3, 3]]),
])
def test_protected_scene_fields(inputs, path, value):
    with pytest.raises(ValueError):
        apply_candidate(*inputs, replace(path, value), "allow staffing changes")


def test_locked_polygon_and_option_rejected(inputs):
    scene, scenario = inputs
    with pytest.raises(ValueError, match="locked obstacle"):
        apply_candidate(scene, scenario, replace("/scene/obstacles/1/poly", scene.obstacles[1].poly), "")
    data = scene.model_dump()
    data["obstacles"][0]["locked"] = True
    with pytest.raises(ValueError, match="locked obstacle"):
        apply_candidate(Scene.model_validate(data), scenario, [], "", "desk_east")


def test_unlocked_translation_and_option_preserve_inputs(inputs):
    scene, scenario = inputs
    before = scene.model_dump_json(), scenario.model_dump_json()
    moved, sampled = apply_candidate(scene, scenario, replace(
        "/scene/obstacles/0/poly", [[5, 11], [9, 11], [9, 12], [5, 12]]
    ), "")
    assert moved.obstacles[0].poly[0] == [5, 11]
    assert sampled == scenario and sampled is not scenario
    assert before == (scene.model_dump_json(), scenario.model_dump_json())
    east, _ = apply_candidate(scene, scenario, [], "Keep two volunteers", "desk_east")
    assert east.targets[0].service_positions == [[21.5, 10], [21.5, 12]]


def test_rejects_reshape_and_invalid_geometry_atomically(inputs):
    scene, scenario = inputs
    before = scene.model_dump_json()
    with pytest.raises(ValueError, match="preserve its polygon shape"):
        apply_candidate(scene, scenario, replace(
            "/scene/obstacles/0/poly", [[5, 11], [10, 11], [10, 12], [5, 12]]
        ), "")
    with pytest.raises(ValidationError, match="outside room"):
        apply_candidate(scene, scenario, replace(
            "/scene/targets/0/queue_polyline", [[5, 9.5], [-3, 7]]
        ), "")
    assert scene.model_dump_json() == before


@pytest.mark.parametrize("constraints,allowed", [
    ("Keep two volunteers and the dining tables", False),
    ("Optimize the layout", False),
    ("allow staffing changes", True),
    ("add volunteers", True),
    ("up to 3 volunteers", True),
    ("up to two volunteers", False),
    ("Do not allow staffing changes", False),
    ("Do not add more volunteers", False),
    ("Disallow staffing changes", False),
    ("Do not add 3 volunteers", False),
    ("It is not permitted to add volunteers", False),
    ("Keep two existing volunteers; add volunteers", False),
    ("Keep staffing unchanged; allow staffing changes", False),
    ("Maybe add volunteers", False),
    ("Can we add volunteers?", False),
    ("up to 4 volunteers; up to 2 volunteers", False),
])
def test_staffing_count_changes_require_explicit_permission(inputs, constraints, allowed):
    patch = replace("/scene/targets/0/service_positions", [[6, 9.5], [7, 9.5], [8, 9.5]])
    if allowed:
        result, _ = apply_candidate(*inputs, patch, constraints)
        assert len(result.targets[0].service_positions) == 3
    else:
        with pytest.raises(ValueError, match="staffing constraints"):
            apply_candidate(*inputs, patch, constraints)


def test_layout_option_cannot_bypass_staffing_or_destination_protection(inputs):
    scene, scenario = inputs
    data = scene.model_dump()
    data["layout_options"][1]["service_positions"].append([21.5, 11])
    with pytest.raises(ValueError, match="staffing constraints"):
        apply_candidate(Scene.model_validate(data), scenario, [], "Keep two volunteers", "desk_east")
    data["layout_options"][1]["destinations"][0]["id"] = "changed"
    with pytest.raises(ValueError, match="Destination IDs"):
        apply_candidate(Scene.model_validate(data), scenario, [], "allow staffing changes", "desk_east")


def test_staffing_permission_is_fail_closed():
    assert staffing_permission("allow staffing changes")
    assert not staffing_permission("perhaps there could be another person helping")
    assert not staffing_permission("Keep two volunteers; allow staffing changes")


@pytest.mark.parametrize("operation", [
    {"op": "remove", "path": "/scene/obstacles/0", "value": None},
    {"op": "replace", "path": "/scene/obstacles/00/poly", "value": []},
    {"op": "replace", "path": "/scene/obstacles/99/poly", "value": []},
    {"op": "replace", "path": "/scene/targets/0/queue_polyline", "value": [], "from": "/x"},
])
def test_patch_grammar_is_restricted(inputs, operation):
    with pytest.raises(ValueError):
        apply_candidate(*inputs, [operation], "")
