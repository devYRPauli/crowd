"""Operation previews require confirmation and preserve the measured cohort."""

from copy import deepcopy
import json
from pathlib import Path
import time

from fastapi.testclient import TestClient
import pytest
from pydantic import ValidationError

import server
from crowd.advice import Proposal
from crowd.engine import presample_people, run
from crowd.proposals import apply_operations, operations_preset
from crowd.schema import Scenario, Scene


@pytest.fixture
def baseline(monkeypatch):
    scene = Scene.model_validate_json((Path(__file__).parent / "fixtures/sample_room.json").read_text())
    scenario = Scenario(n_people=3, arrival_window_s=2, arrival_pattern="front_loaded",
                        seed=1, horizon_s=120, mode="queue")
    people = presample_people(scene, scenario)
    people[0]["preferred_speed_m_s"] = 0.71
    result = run(scene, scenario, people=people)
    monkeypatch.setattr(server, "_last_result", (scene.model_dump(mode="json"), scenario.model_dump(mode="json"), result))
    monkeypatch.setattr(server, "_proposal_jobs", {})
    monkeypatch.setattr(server, "_proposal_cache", {})
    monkeypatch.setattr(server, "_explanation_cache", {})
    monkeypatch.setattr(server, "_proposal_private", {})
    return scene, scenario, result


def job_for(client, scene, scenario):
    response = client.post("/api/propose", json={
        "scene": scene.model_dump(), "scenario": scenario.model_dump(),
        "baseline_metrics": {}, "baseline_accounting": {}, "constraints": "Allow staffing changes",
    })
    assert response.status_code == 200, response.text
    job_id = response.json()["job_id"]
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        job = client.get(f"/api/propose/{job_id}").json()
        if job["status"] in {"completed", "error"}:
            assert job["status"] == "completed", job
            return job_id, job
        time.sleep(0.01)
    pytest.fail("Proposal job did not finish")


def proposal(kind, patch):
    return {"kind": kind, "option_id": None, "patch": patch, "rationale": "Spread arrivals across the session."}


def patch(path, value):
    return {"op": "replace", "path": path, "value": value}


def test_operations_preview_is_unmeasured_until_confirmed(monkeypatch, baseline):
    scene, scenario, original = baseline
    op = proposal("operations", [patch("/scenario/arrival_pattern", "uniform"),
                                  patch("/scenario/arrival_window_s", 30)])
    monkeypatch.setattr(server.astra, "ask_structured", lambda *args, **kwargs: {"candidates": [op]})
    measured = []

    def record(scene, scenario, **kwargs):
        result = run(scene, scenario, **kwargs)
        measured.append(result)
        return result

    monkeypatch.setattr(server, "simulate", record)
    client = TestClient(server.app)
    job_id, job = job_for(client, scene, scenario)
    preview = job["candidates"][0]
    assert preview["kind"] == "operations" and preview["requires_confirmation"]
    assert not {"metrics", "accounting", "comparison"} & preview.keys()
    assert measured == []
    assert not {"people", "frames", "baseline"} & job.keys()
    assert client.post(f"/api/propose/{job_id}/run", json={"index": 0}).status_code == 409
    assert measured == []
    response = client.post(f"/api/propose/{job_id}/run", json={"index": 0, "confirmed": True})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["comparison"]["status"] == "operations_trade_off"
    assert body["comparison"]["better"] is None
    assert body["scenario"]["arrival_window_s"] == 30
    assert body["baseline_metrics"] == original.metrics
    assert client.get(f'/api/frames/{body["run_id"]}').status_code == 200
    altered = measured[-1]
    assert altered.people != original.people
    assert [{k: v for k, v in p.items() if k != "arrival_s"} for p in altered.people] == [
        {k: v for k, v in p.items() if k != "arrival_s"} for p in original.people]
    restored = client.post(f"/api/propose/{job_id}/run", json={"index": -1})
    assert restored.status_code == 200
    assert measured[-1].people == original.people
    assert measured[-1].frames == original.frames


def test_layout_jobs_and_reruns_use_actual_baseline_people(monkeypatch, baseline):
    scene, scenario, original = baseline
    monkeypatch.setattr(server.astra, "ask_structured", lambda *args, **kwargs: {"candidates": [proposal("layout", [])]})
    passed_people = []

    def record(scene, scenario, **kwargs):
        passed_people.append(deepcopy(kwargs.get("people")))
        return run(scene, scenario, **kwargs)

    monkeypatch.setattr(server, "simulate", record)
    client = TestClient(server.app)
    job_id, job = job_for(client, scene, scenario)
    assert job["candidates"][0]["requires_confirmation"] is False
    assert passed_people == [original.people]
    assert client.post(f"/api/propose/{job_id}/run", json={"index": 0}).status_code == 200
    assert passed_people == [original.people, original.people]


def test_staffing_cannot_be_smuggled_through_layout_kind(monkeypatch, baseline):
    scene, scenario, _ = baseline
    changed = proposal("layout", operations_preset(scene, "one_volunteer"))
    monkeypatch.setattr(server.astra, "ask_structured", lambda *args, **kwargs: {"candidates": [changed]})
    monkeypatch.setattr(server, "simulate", lambda *args, **kwargs: pytest.fail("Layout staffing must not simulate"))
    client = TestClient(server.app)
    job_id, job = job_for(client, scene, scenario)
    assert job["candidates"] == []
    assert "confirmation" in job["rejected"][0]["reason"]
    assert client.post(f"/api/propose/{job_id}/run", json={"index": 0, "confirmed": True}).status_code == 404


@pytest.mark.parametrize("preset", ["one_volunteer", "third_volunteer", "waves_15min"])
def test_judge_presets_are_gated_and_keep_nonarrival_people(monkeypatch, baseline, preset):
    scene, scenario, original = baseline
    client = TestClient(server.app)
    request = {"scene": scene.model_dump(), "scenario": scenario.model_dump(), "preset": preset}
    assert client.post("/api/operations", json=request).status_code == 409
    assert server._last_result[2] is original
    response = client.post("/api/operations", json={**request, "confirmed": True})
    assert response.status_code == 200, response.text
    body, changed = response.json(), server._last_result[2]
    assert body["kind"] == "operations"
    assert [{k: v for k, v in p.items() if k != "arrival_s"} for p in changed.people] == [
        {k: v for k, v in p.items() if k != "arrival_s"} for p in original.people]
    if preset == "waves_15min":
        assert body["scenario"]["arrival_pattern"] == "waves"
        assert body["scenario"]["arrival_window_s"] == 900
        assert body["comparison"]["better"] is None
    else:
        assert changed.people == original.people
        assert len(body["scene"]["targets"][0]["service_positions"]) == (1 if preset == "one_volunteer" else 3)


@pytest.mark.parametrize("path,value", [
    ("/scenario/n_people", 1), ("/scenario/seed", 2), ("/scenario/horizon_s", 150),
    ("/scenario/mode", "queue"), ("/scene/targets/0/service_s", 3),
    ("/scene/obstacles/1/poly", [[1, 1], [2, 1], [2, 2], [1, 2]]),
    ("/scene/targets/0/queue_polyline", [[5, 9], [4, 9]]),
])
def test_operations_reject_protected_fields_without_changing_input(baseline, path, value):
    scene, scenario, _ = baseline
    before = (scene.model_dump_json(), scenario.model_dump_json())
    with pytest.raises(ValueError, match="protected"):
        apply_operations(scene, scenario, [patch(path, value)])
    assert before == (scene.model_dump_json(), scenario.model_dump_json())


def test_operations_reject_same_count_moves_or_repositioned_existing_servers(baseline):
    scene, scenario, _ = baseline
    positions = deepcopy(scene.targets[0].service_positions)
    positions[0][0] += 0.1
    with pytest.raises(ValueError, match="count"):
        apply_operations(scene, scenario, [patch("/scene/targets/0/service_positions", positions)])
    positions.append([5.5, 10.5])
    with pytest.raises(ValueError, match="retain"):
        apply_operations(scene, scenario, [patch("/scene/targets/0/service_positions", positions)])


def test_proposal_kind_is_required():
    with pytest.raises(ValidationError, match="kind"):
        Proposal.model_validate({"option_id": None, "patch": [], "rationale": "Keep the queue."})


def test_drag_geometry_is_checked_before_manual_scene_use(baseline):
    scene, _, _ = baseline
    client = TestClient(server.app)
    assert client.post("/api/scene/validate", json={"scene": scene.model_dump()}).json()["scene"] == scene.model_dump(mode="json")
    invalid = scene.model_dump()
    invalid["obstacles"][0]["poly"] = [[-1, 0], [1, 0], [1, 2], [-1, 2]]
    assert client.post("/api/scene/validate", json={"scene": invalid}).status_code == 422


def test_revise_brief_passes_current_context_and_keeps_optional_scene(monkeypatch, baseline):
    scene, scenario, _ = baseline
    seen = []

    def ask(prompt, schema, **kwargs):
        seen.append(prompt)
        return {"scenario": scenario.model_dump(), "scene": None, "assumptions": []}

    monkeypatch.setattr(server.astra, "ask_structured", ask)
    response = TestClient(server.app).post("/api/interpret", json={
        "brief": "Keep this geometry and revise the arrivals.", "scene": scene.model_dump(), "scenario": scenario.model_dump(),
    })
    assert response.status_code == 200
    assert response.json()["scene"] is None
    context = json.loads(seen[0].split("Current context: ", 1)[1])
    assert context["scenario"] == scenario.model_dump(mode="json")
    assert "walkable_bbox" in context["scene"]
    assert "walkable" not in context["scene"]


def test_third_volunteer_preset_can_follow_one_volunteer_control(baseline):
    scene, scenario, _ = baseline
    smaller, scenario = apply_operations(scene, scenario, operations_preset(scene, "one_volunteer"))
    larger, _ = apply_operations(smaller, scenario, operations_preset(smaller, "third_volunteer"))
    assert len(larger.targets[0].service_positions) == 3
    assert smaller.targets[0].service_positions[0] in larger.targets[0].service_positions
