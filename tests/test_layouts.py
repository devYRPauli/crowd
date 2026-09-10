"""Named layout application and physical scene validation."""

from pathlib import Path

import pytest
from pydantic import ValidationError
from shapely.geometry import Polygon

from crowd.layouts import apply_layout_option
from crowd.schema import Scene, effective_overflow_area


@pytest.fixture
def scene():
    return Scene.model_validate_json(
        (Path(__file__).parent / "fixtures" / "sample_room.json").read_text()
    )


def test_layout_options_round_trip_and_preserve_original(scene):
    before = scene.model_dump_json()
    east = apply_layout_option(scene, "desk_east")
    assert east.targets[0].service_positions == [[21.5, 10], [21.5, 12]]
    assert east.targets[0].service_s == scene.targets[0].service_s
    assert east.targets[0].id == scene.targets[0].id
    assert east.obstacles[1:] == scene.obstacles[1:]
    assert Scene.model_validate_json(east.model_dump_json()) == east
    assert apply_layout_option(east, "desk_north") == scene
    assert scene.model_dump_json() == before


def test_layout_option_rejects_unknown_and_locked_changes(scene):
    with pytest.raises(ValueError, match="Unknown layout option"):
        apply_layout_option(scene, "invented")
    data = scene.model_dump()
    data["obstacles"][0]["locked"] = True
    locked = Scene.model_validate(data)
    with pytest.raises(ValueError, match="locked obstacle"):
        apply_layout_option(locked, "desk_east")
    assert apply_layout_option(locked, "desk_north") == locked


def test_layout_option_validates_applied_geometry(scene):
    data = scene.model_dump()
    data["layout_options"][1]["obstacle_poly"] = [[25, 1], [26, 1], [26, 2], [25, 2]]
    source = Scene.model_validate(data)
    with pytest.raises(ValidationError, match="outside the walkable boundary"):
        apply_layout_option(source, "desk_east")


@pytest.mark.parametrize("field", ["entrances", "exits"])
def test_opening_must_touch_boundary(scene, field):
    data = scene.model_dump()
    data[field][0]["poly"] = [[2, 2], [3, 2], [3, 3], [2, 3]]
    with pytest.raises(ValidationError, match="must touch the walkable boundary"):
        Scene.model_validate(data)


def test_floor_must_remain_connected(scene):
    data = scene.model_dump()
    data["obstacles"].append({
        "id": "divider", "kind": "wall", "locked": True,
        "poly": [[23, 0], [23.2, 0], [23.2, 14], [23, 14]],
    })
    with pytest.raises(ValidationError, match="one connected region"):
        Scene.model_validate(data)


def test_default_overflow_is_two_metre_tail_box_and_explicit_can_cross_walkway(scene):
    data = scene.model_dump()
    data["targets"][0]["overflow_area"] = None
    target = Scene.model_validate(data).targets[0]
    assert Polygon(effective_overflow_area(target)).bounds == (12, 6, 14, 8)
    assert Polygon(effective_overflow_area(target)).area == 4
    data["targets"][0]["overflow_area"] = [[14, 6.1], [16, 6.1], [16, 7.9], [14, 7.9]]
    assert Scene.model_validate(data).targets[0].overflow_area is not None
