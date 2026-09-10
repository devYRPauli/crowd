"""Dinner-call schema, confirmation gates, cohort scheduling, and viewer metadata."""

from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

import server
from crowd.advice import Interpretation, strict_schema
from crowd.proposals import apply_candidate, apply_operations, operations_preset
from crowd.schema import Scenario, Scene


@pytest.fixture
def room():
    return Scene.model_validate_json((Path(__file__).parent / "fixtures/sample_room.json").read_text())


@pytest.fixture
def dinner():
    return Scenario(n_people=3, arrival_window_s=600, arrival_pattern="front_loaded",
                    seed=1, horizon_s=1200, mode="dinner_call")


def test_dinner_defaults_and_strict_structured_schema(dinner):
    assert (dinner.wave_count, dinner.wave_gap_s) == (3, 300)
    assert Scenario.model_validate_json(dinner.model_dump_json()) == dinner
    schema = strict_schema(Interpretation)["$defs"]["Scenario"]
    assert {"mode", "wave_count", "wave_gap_s"} <= set(schema["required"])
    assert schema["properties"]["mode"]["enum"] == ["queue", "dinner_call"]


@pytest.mark.parametrize("field,value", [("wave_count", 0), ("wave_count", True),
                                         ("wave_count", 1.5), ("wave_gap_s", 0),
                                         ("wave_gap_s", float("inf"))])
def test_invalid_wave_parameters_rejected(dinner, field, value):
    with pytest.raises(ValidationError):
        Scenario.model_validate({**dinner.model_dump(), field: value})


def test_waves_chip_depends_on_confirmed_mode(room, dinner):
    changed = dinner.model_copy(update={"wave_count": 1, "wave_gap_s": 10})
    patch = operations_preset(room, "waves_15min", changed)
    updated_room, updated = apply_operations(room, changed, patch)
    assert updated_room == room
    assert (updated.wave_count, updated.wave_gap_s, updated.mode, updated.arrival_pattern) == (3, 300, "dinner_call", "waves")
    queue_patch = operations_preset(room, "waves_15min")
    assert {p["path"] for p in queue_patch} == {"/scenario/arrival_pattern", "/scenario/arrival_window_s"}
    assert changed.wave_count == 1


@pytest.mark.parametrize("mode,path,value", [
    ("dinner_call", "/scenario/mode", "queue"),
    ("queue", "/scenario/mode", "dinner_call"),
    ("queue", "/scenario/wave_count", 4),
    ("queue", "/scenario/wave_gap_s", 100),
])
def test_operations_cannot_change_mode_or_irrelevant_schedule(room, dinner, mode, path, value):
    scenario = dinner.model_copy(update={"mode": mode})
    with pytest.raises(ValueError, match="protected"):
        apply_operations(room, scenario, [{"op": "replace", "path": path, "value": value}])


def test_layout_proposal_cannot_change_release_waves(room, dinner):
    with pytest.raises(ValueError, match="protected"):
        apply_candidate(room, dinner, [{"op": "replace", "path": "/scenario/wave_count", "value": 5}], "")


def test_interpret_reports_initial_seating_and_wave_assumptions(monkeypatch, dinner):
    prompts = []

    def ask(prompt, schema, **kwargs):
        prompts.append(prompt)
        return {"scene": None, "scenario": dinner.model_dump(), "assumptions": []}

    monkeypatch.setattr(server.astra, "ask_structured", ask)
    response = TestClient(server.app).post("/api/interpret", json={"brief": "Guests are already seated; call tables to the buffet."})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["scenario"]["mode"] == "dinner_call"
    assumptions = " ".join(body["assumptions"])
    assert "configured seats" in assumptions and "standing zone" in assumptions
    assert "wave_count = 3" in assumptions and "wave_gap_s = 300" in assumptions
    assert "return to their assigned seat or standing position" in assumptions
    assert "already seated" in prompts[0] and "dinner_call" in prompts[0]
    assert len(prompts) == 1


@pytest.mark.parametrize("change", [{"wave_gap_s": 200}, {"wave_count": 4},
                                     {"arrival_pattern": "waves"}, {"arrival_window_s": 900}])
def test_cohort_reschedules_wave_changes_but_protects_mode(monkeypatch, room, dinner, change):
    people = [{"id": "p0", "seat_position": [2, 2]}]
    monkeypatch.setattr(server, "_cohorts", server.OrderedDict())
    receipt = server._cohort_receipt(SimpleNamespace(people=people), room, dinner)
    observed = []

    def reschedule(scene, scenario, records):
        observed.append((scenario.wave_count, scenario.wave_gap_s, deepcopy(records)))
        return [{**records[0], "rescheduled": True}]

    monkeypatch.setattr(server, "reschedule_people", reschedule)
    updated = dinner.model_copy(update=change)
    result = server._cohort_people(receipt["cohort_id"], room, updated)
    assert result[0]["rescheduled"]
    assert observed == [(updated.wave_count, updated.wave_gap_s, people)]
    assert server._cohort_people(receipt["cohort_id"], room, dinner) == people
    with pytest.raises(ValueError, match="unchanged mode"):
        server._cohort_people(receipt["cohort_id"], room, dinner.model_copy(update={"mode": "queue"}))


def test_viewer_preserves_initial_seat_and_measured_final_destination(room):
    person = {"id": "p0", "target_id": room.targets[0].id,
              "destination_id": room.destinations[0].id, "seat_position": [2, 3]}
    events = {"p0": [{"kind": "initially_seated", "time_s": 0},
                     {"kind": "released", "time_s": 10},
                     {"kind": "seated", "time_s": 100, "position": [8, 9]}]}
    result = SimpleNamespace(people=[person], events=deepcopy(events))
    output = server._viewer_events(result, room)
    assert output["p0"][0]["position"] == [2, 3]
    assert output["p0"][-1]["position"] == [8, 9]
    assert result.events == events


def test_dinner_waves_preset_still_requires_confirmation(room, dinner):
    response = TestClient(server.app).post("/api/operations", json={
        "scene": room.model_dump(), "scenario": dinner.model_dump(), "preset": "waves_15min"})
    assert response.status_code == 409


def test_dinner_release_schedule_can_change_before_wave_mode(room, dinner):
    _, updated = apply_operations(room, dinner, [
        {"op": "replace", "path": "/scenario/arrival_pattern", "value": "uniform"},
        {"op": "replace", "path": "/scenario/arrival_window_s", "value": 900}])
    assert updated.arrival_pattern == "uniform" and updated.arrival_window_s == 900
    assert server._schedule_changed(dinner, updated)
    assert server._schedule_changed(dinner, dinner.model_copy(update={"arrival_pattern": "waves"}))


def test_interpret_replaces_model_seating_claim_with_engine_capacity(monkeypatch, room, dinner):
    from crowd.engine import dinner_seat_positions

    dinner = dinner.model_copy(update={"n_people": 120})
    prompts = []

    def ask(prompt, schema, **kwargs):
        prompts.append(prompt)
        return {"scene": None, "scenario": dinner.model_dump(),
                "assumptions": ["All 120 guests are already seated at their tables."]}

    monkeypatch.setattr(server.astra, "ask_structured", ask)
    response = TestClient(server.app).post("/api/interpret", json={
        "brief": "120 guests are already seated", "scene": room.model_dump(),
        "scenario": dinner.model_dump()})
    assert response.status_code == 200, response.text
    capacity = len(dinner_seat_positions(room))
    notes = " ".join(response.json()["assumptions"])
    assert f"{min(120, capacity)} people seated" in notes
    assert f"{max(0, 120-capacity)} people in the standing zone" in notes
    assert "All 120 guests" not in notes
    assert f'"engine_configured_seat_count":{capacity}' in prompts[0]


def test_seat_receipt_uses_returned_scene_and_caps_at_guest_count(room, dinner):
    from crowd.advice import assumption_receipt

    room = room.model_copy(deep=True)
    for obstacle in room.obstacles:
        if obstacle.kind == "dining_table":
            obstacle.kind = "round_table"
    output = Interpretation(scene=room, scenario=dinner, assumptions=["Everyone is sitting."])
    receipt = " ".join(assumption_receipt(output))
    assert "3 people seated" in receipt and "0 people in the standing zone" in receipt
    assert "Everyone is sitting" not in receipt


def test_queue_receipt_marks_completion_only_at_exit(dinner):
    from crowd.advice import assumption_receipt

    queue = dinner.model_copy(update={"mode": "queue"})
    output = Interpretation(scene=None, scenario=queue,
                            assumptions=["People disappear at the coffee counter."])
    notes = " ".join(assumption_receipt(output))
    assert "destination waypoint" in notes and "completion is measured only at the exit" in notes
    assert "disappear at the coffee counter" not in notes


def test_dinner_receipt_rejects_obsolete_disperse_assumption(room, dinner):
    from crowd.advice import assumption_receipt

    output = Interpretation(scene=None, scenario=dinner, assumptions=["Guests disperse after service."])
    notes = " ".join(assumption_receipt(output, room))
    assert "return to their assigned seat or standing position" in notes
    assert "remain visible" in notes and "Guests disperse" not in notes


def test_viewer_preserves_terminal_engine_coordinates_and_posture(room):
    person = {"id": "p0", "target_id": room.targets[0].id,
              "destination_id": room.destinations[0].id, "seat_position": [2, 3],
              "placement_kind": "standing"}
    original = {"p0": [{"kind": "returned_to_seat", "time_s": 20, "position": [2.1, 3.1]},
                       {"kind": "exited", "time_s": 30, "position": [24, 7]}]}
    result = SimpleNamespace(people=[person], events=deepcopy(original))
    output = server._viewer_events(result, room)["p0"]
    assert output[0]["position"] == [2.1, 3.1] and output[0]["placement_kind"] == "standing"
    assert output[1]["position"] == [24, 7]
    assert result.events == original
