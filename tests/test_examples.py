"""Curated simple rooms are valid, measurable, and usable without model calls."""

from pathlib import Path

import pytest
from shapely.geometry import Point

from crowd.engine import dinner_standing_zone, presample_people, run
from crowd.layouts import apply_layout_option
from crowd.schema import Scenario, Scene


@pytest.fixture(params=["open_coffee_room", "furnished_coffee_room"])
def example(request):
    return Scene.model_validate_json((Path(__file__).parent / "fixtures" / f"{request.param}.json").read_text())


def test_coffee_examples_roundtrip_and_both_legal_options(example):
    assert Scene.model_validate_json(example.model_dump_json()) == example
    assert len(example.entrances) == len(example.exits) == 1
    assert len(example.targets[0].service_positions) == 2
    for option in example.layout_options:
        applied = apply_layout_option(example, option.id)
        assert Scene.model_validate_json(applied.model_dump_json()) == applied
        assert applied.targets[0].service_s == example.targets[0].service_s


def test_coffee_examples_complete_sixty_people(example):
    scenario = Scenario(n_people=60, arrival_window_s=180, arrival_pattern="front_loaded",
                        seed=1, horizon_s=600, mode="queue")
    result = run(example, scenario)
    assert result.accounting["done"] == result.metrics["completed"] == 60
    assert sum(result.accounting.values()) == 60
    assert all(result.accounting[state] == 0 for state in ("not_arrived", "walking", "queued", "in_service"))


def test_coffee_examples_have_dinner_standing_space(example):
    zone = dinner_standing_zone(example)
    assert not zone.is_empty and zone.area > 20
    scenario = Scenario(n_people=60, arrival_window_s=180, arrival_pattern="front_loaded",
                        seed=1, horizon_s=600, mode="dinner_call")
    people = presample_people(example, scenario)
    standing = [person for person in people if person["placement_kind"] == "standing"]
    assert standing
    assert all(zone.covers(Point(person["seat_position"])) for person in standing)
    assert people == presample_people(example, scenario)


def test_coffee_furniture_uses_real_world_footprints(example):
    for obstacle in example.obstacles:
        xs, ys = zip(*obstacle.poly)
        dimensions = sorted([max(xs) - min(xs), max(ys) - min(ys)])
        expected = [0.8, 1.5] if obstacle.kind == "buffet" else [1.6, 1.6]
        assert dimensions == pytest.approx(expected)
    assert len(example.obstacles) in (1, 4)
    for option in example.layout_options:
        xs, ys = zip(*option.obstacle_poly)
        assert sorted([max(xs) - min(xs), max(ys) - min(ys)]) == pytest.approx([0.8, 1.5])
        assert Point(option.service_positions[0]).distance(Point(option.service_positions[1])) == pytest.approx(0.8)
