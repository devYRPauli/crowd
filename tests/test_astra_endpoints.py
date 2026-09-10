"""Mocked Astra integration: validation retries, scope rejection, and measured prose."""

from copy import deepcopy
from pathlib import Path
import time

import pytest
from fastapi.testclient import TestClient

import server
from crowd.engine import run
from crowd.schema import Scenario, Scene


@pytest.fixture
def scene_data():
    return Scene.model_validate_json(
        (Path(__file__).parent / "fixtures" / "sample_room.json").read_text()
    ).model_dump(mode="json")


@pytest.fixture
def scenario_data():
    return Scenario(
        n_people=3, arrival_window_s=2, arrival_pattern="front_loaded",
        seed=1, horizon_s=60, mode="queue",
    ).model_dump(mode="json")


def mock_answers(monkeypatch, answers):
    calls = []
    responses = iter(answers)

    def ask(prompt, schema, **kwargs):
        calls.append({"prompt": prompt, "schema": schema, **kwargs})
        value = next(responses)
        if isinstance(value, Exception):
            raise value
        return deepcopy(value)

    monkeypatch.setattr(server.astra, "ask_structured", ask)
    return calls



def completed_proposal(client, response):
    assert response.status_code == 200, response.text
    assert set(response.json()) == {"job_id"}
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        job = client.get("/api/propose/" + response.json()["job_id"]).json()
        if job["status"] in {"completed", "error"}:
            assert job["status"] == "completed", job
            return job
        time.sleep(0.01)
    pytest.fail("Proposal worker did not finish within test deadline")


def test_interpret_returns_bad_scene_errors_after_exactly_one_correction(
    monkeypatch, scene_data, scenario_data
):
    scene_data["obstacles"][0]["poly"] = [[-2, 1], [-1, 1], [-1, 2], [-2, 2]]
    answer = {"scenario": scenario_data, "scene": scene_data, "assumptions": []}
    calls = mock_answers(monkeypatch, [answer, answer])
    response = TestClient(server.app).post("/api/interpret", json={"brief": "Three guests."})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["attempts"] == 2
    assert detail["errors"]
    assert len(calls) == 2
    assert "outside" in calls[1]["prompt"].lower()
    assert all(call.get("reasoning", "low") == "low" for call in calls)


def test_interpret_correction_and_complete_assumptions(monkeypatch, scene_data, scenario_data):
    invalid = deepcopy(scene_data)
    invalid["entrances"][0]["poly"] = [[10, 1], [11, 1], [11, 2], [10, 2]]
    calls = mock_answers(monkeypatch, [
        {"scenario": scenario_data, "scene": invalid, "assumptions": []},
        {"scenario": scenario_data, "scene": scene_data, "assumptions": ["A seated event."]},
    ])
    response = TestClient(server.app).post("/api/interpret", json={"brief": "A seated event."})
    assert response.status_code == 200, response.text
    body = response.json()
    assert Scene.model_validate(body["scene"]) == Scene.model_validate(scene_data)
    assert Scenario.model_validate(body["scenario"]) == Scenario.model_validate(scenario_data)
    assumptions = "\n".join(body["assumptions"])
    for key in scenario_data:
        assert key in assumptions
    assert "service_s" in assumptions
    assert "staff" in assumptions.lower() or "service_positions" in assumptions
    assert "walkable" in assumptions
    assert len(calls) == 2


def test_interpret_model_failure_leaves_manual_api_available(monkeypatch, scene_data, scenario_data):
    calls = mock_answers(monkeypatch, [RuntimeError("Test upstream outage")])
    client = TestClient(server.app)
    response = client.post("/api/interpret", json={"brief": "A small event."})
    assert response.status_code == 502
    assert response.json()["detail"]
    assert len(calls) == 1
    assert client.get("/api/scene").status_code == 200
    rehearsal = client.post("/api/run", json={"scene": scene_data, "scenario": scenario_data})
    assert rehearsal.status_code == 200
    assert client.get(f'/api/frames/{rehearsal.json()["run_id"]}').status_code == 200


def test_propose_rejects_locked_candidate_and_runs_survivor_with_same_people(
    monkeypatch, scene_data, scenario_data
):
    locked_index = next(i for i, item in enumerate(scene_data["obstacles"]) if item["locked"])
    calls = mock_answers(monkeypatch, [{"candidates": [
        {"option_id": None, "patch": [{"op": "replace", "path": f"/scene/obstacles/{locked_index}/poly", "value": scene_data["obstacles"][locked_index]["poly"]}], "rationale": "Move a table."},
        {"option_id": None, "patch": [{"op": "replace", "path": "/scene/targets/0/queue_polyline", "value": scene_data["targets"][0]["queue_polyline"]}], "rationale": "Retain the queue for comparison."},
    ]}])
    baseline = run(Scene.model_validate(scene_data), Scenario.model_validate(scenario_data))
    measured = []

    def record_run(scene, scenario, **kwargs):
        result = run(scene, scenario, **kwargs)
        measured.append(result)
        return result

    monkeypatch.setattr(server, "simulate", record_run)
    client = TestClient(server.app)
    response = client.post("/api/propose", json={
        "scene": scene_data, "scenario": scenario_data,
        "baseline_metrics": baseline.metrics, "baseline_accounting": baseline.accounting,
        "constraints": "Keep two volunteers and the dining tables",
    })
    assert response.status_code == 200, response.text
    body = completed_proposal(client, response)
    assert len(body["rejected"]) == 1
    assert "locked" in body["rejected"][0]["reason"].lower()
    assert len(body["candidates"]) == 1
    assert body["candidates"][0]["comparison"]
    assert measured
    assert all(result.people == baseline.people for result in measured)
    assert calls[0]["reasoning"] == "medium"
    assert calls[0]["timeout_s"] == 120
    assert calls[0]["max_output_tokens"] == 2048


def test_explain_substitutes_only_measured_numbers(monkeypatch):
    calls = mock_answers(monkeypatch, [{
        "explanation": "mean_wait_s changed from {{baseline.mean_wait_s}} to {{candidate.mean_wait_s}}, a change of {{delta.mean_wait_s}}."
    }])
    response = TestClient(server.app).post("/api/explain", json={
        "baseline_metrics": {"mean_wait_s": 20}, "baseline_accounting": {"done": 150},
        "candidate_metrics": {"mean_wait_s": 15}, "candidate_accounting": {"done": 150},
        "rationale": "Shorten the walk to service.",
    })
    assert response.status_code == 200, response.text
    prose = response.json()["explanation"]
    assert "{{" not in prose
    assert "20" in prose and "15" in prose and "-5" in prose
    assert calls[0].get("reasoning", "low") == "low"


@pytest.mark.parametrize("text", [
    "This layout is safe.", "This layout is optimal.", "This layout is validated.",
    "The wait is 999 seconds.",
])
def test_explain_rejects_unmeasured_numbers_and_safety_claims(monkeypatch, text):
    mock_answers(monkeypatch, [{"explanation": text}])
    response = TestClient(server.app).post("/api/explain", json={
        "baseline_metrics": {"mean_wait_s": 20}, "baseline_accounting": {"done": 150},
        "candidate_metrics": {"mean_wait_s": 15}, "candidate_accounting": {"done": 150},
        "rationale": "Move the queue.",
    })
    assert response.status_code == 422
    assert response.json()["detail"]
