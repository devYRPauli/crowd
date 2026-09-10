"""Exact-input advice fallback and receipt totals preserve manual rehearsals."""

from copy import deepcopy
import json
from pathlib import Path
import time

from fastapi.testclient import TestClient
import pytest

import server
from crowd.engine import run
from crowd.schema import Scenario, Scene


@pytest.fixture
def context(monkeypatch):
    scene = Scene.model_validate_json((Path(__file__).parent / "fixtures/sample_room.json").read_text())
    scenario = Scenario(n_people=3, arrival_window_s=2, arrival_pattern="uniform",
                        seed=1, horizon_s=120, mode="queue")
    baseline = run(scene, scenario)
    for name in ("_proposal_jobs", "_proposal_private", "_proposal_cache", "_explanation_cache"):
        monkeypatch.setattr(server, name, {})
    monkeypatch.setattr(server, "_last_result", (scene.model_dump(mode="json"), scenario.model_dump(mode="json"), baseline))
    return scene, scenario, baseline


def request_for(scene, scenario, constraints="Keep two volunteers"):
    return {"scene": scene.model_dump(), "scenario": scenario.model_dump(),
            "constraints": constraints, "baseline_metrics": {}, "baseline_accounting": {}}


def proposal_job(client, request):
    response = client.post("/api/propose", json=request)
    assert response.status_code == 200, response.text
    job_id = response.json()["job_id"]
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        job = client.get(f"/api/propose/{job_id}").json()
        if job["status"] in {"completed", "error"}:
            return job
        time.sleep(0.01)
    pytest.fail("Proposal job did not finish")


def proposal_reply():
    return {"candidates": [{"kind": "operations", "option_id": None,
                            "patch": [{"op": "replace", "path": "/scenario/arrival_window_s", "value": 30}],
                            "rationale": "Spread the arrival period."}]}


def mock_reply(monkeypatch, reply):
    def ask(*args, **kwargs):
        if isinstance(reply, Exception):
            raise reply
        return deepcopy(reply)
    monkeypatch.setattr(server.astra, "ask_structured", ask)


@pytest.mark.parametrize("failure", [RuntimeError("offline"), TimeoutError("slow"),
                                     ValueError("OPENAI_API_KEY missing"), {"candidates": "bad"}])
def test_matching_proposal_failure_uses_cached_preview_without_simulation(monkeypatch, context, failure):
    scene, scenario, baseline = context
    client = TestClient(server.app)
    request = request_for(scene, scenario)
    mock_reply(monkeypatch, proposal_reply())
    original = proposal_job(client, request)
    assert original["status"] == "completed" and not original["cached"]
    monkeypatch.setattr(server, "simulate", lambda *args, **kwargs: pytest.fail("Unconfirmed preview must not simulate"))
    # Cache contents are independent of previous jobs and their selected state.
    server._proposal_private[original["job_id"]]["candidates"][0]["preview"]["rationale"] = "Changed privately"
    mock_reply(monkeypatch, failure)
    restored = proposal_job(client, request)
    assert restored["status"] == "completed" and restored["cached"] is True
    assert restored["candidates"] == original["candidates"]
    assert isinstance(restored["error"], str) and "\n" not in restored["error"]
    assert "people" not in restored and "baseline" not in restored and "frames" not in restored
    assert restored["candidates"][0]["requires_confirmation"]
    assert "metrics" not in restored["candidates"][0]
    assert client.post(f'/api/propose/{restored["job_id"]}/run', json={"index": 0}).status_code == 409
    assert server._proposal_private[restored["job_id"]]["baseline"].people == baseline.people
    monkeypatch.setattr(server, "simulate", run)
    manual = client.post("/api/run", json={"scene": scene.model_dump(), "scenario": scenario.model_dump()})
    assert manual.status_code == 200
    assert client.get(f'/api/frames/{manual.json()["run_id"]}').status_code == 200


@pytest.mark.parametrize("changed", ["scene", "scenario", "constraints", "measurements", "people"])
def test_proposal_cache_never_crosses_scene_scenario_constraints_measurements_or_cohort(monkeypatch, context, changed):
    scene, scenario, baseline = context
    client = TestClient(server.app)
    mock_reply(monkeypatch, proposal_reply())
    original = proposal_job(client, request_for(scene, scenario))
    assert original["status"] == "completed"
    constraints = "Keep two volunteers"
    if changed == "scene":
        scene = scene.model_copy(deep=True)
        scene.targets[0].service_s += 1
        baseline = run(scene, scenario)
    elif changed == "scenario":
        scenario = scenario.model_copy(update={"arrival_window_s": 3})
        baseline = run(scene, scenario)
    elif changed == "constraints":
        constraints = "Retain current volunteers"
    elif changed == "measurements":
        baseline = baseline.model_copy(deep=True)
        baseline.metrics["max_wait_s"] += 1
    else:
        baseline = baseline.model_copy(deep=True)
        baseline.people[0]["preferred_speed_m_s"] = 0.7
    monkeypatch.setattr(server, "_last_result", (scene.model_dump(mode="json"), scenario.model_dump(mode="json"), baseline))
    mock_reply(monkeypatch, TimeoutError("offline"))
    result = proposal_job(client, request_for(scene, scenario, constraints))
    assert result["status"] == "error"
    assert not result.get("cached")


def explanation_request():
    return {"scene_hash": "a" * 64, "baseline_metrics": {"mean_wait_s": 20},
            "candidate_metrics": {"mean_wait_s": 15}, "baseline_accounting": {"done": 150},
            "candidate_accounting": {"done": 150}, "rationale": "Shorten the walk."}


@pytest.mark.parametrize("failure", [ValueError("missing key"), TimeoutError("timeout"),
                                     {"explanation": "The layout is safe and waits are 999 seconds."}])
def test_explanation_cache_on_missing_key_timeout_and_invalid_output(monkeypatch, context, failure):
    client = TestClient(server.app)
    request = explanation_request()
    mock_reply(monkeypatch, {"explanation": "mean_wait_s moved from {{baseline.mean_wait_s}} to {{candidate.mean_wait_s}}."})
    original = client.post("/api/explain", json=request)
    assert original.status_code == 200 and not original.json()["cached"]
    mock_reply(monkeypatch, failure)
    restored = client.post("/api/explain", json=request)
    assert restored.status_code == 200
    assert restored.json()["cached"] is True
    assert restored.json()["explanation"] == original.json()["explanation"]
    assert "\n" not in restored.json()["error"]


@pytest.mark.parametrize("changed", ["scene_hash", "metrics", "accounting", "rationale", "kind"])
def test_explanation_cache_requires_every_input_to_match(monkeypatch, context, changed):
    client = TestClient(server.app)
    request = explanation_request()
    # Missing fingerprints still require exact complete measurement payloads.
    if changed != "scene_hash":
        request.pop("scene_hash")
    mock_reply(monkeypatch, {"explanation": "mean_wait_s changed by {{delta.mean_wait_s}}."})
    assert client.post("/api/explain", json=request).status_code == 200
    if changed == "scene_hash":
        request["scene_hash"] = "b" * 64
    elif changed == "metrics":
        request["candidate_metrics"]["mean_wait_s"] = 14
    elif changed == "accounting":
        request["candidate_accounting"]["done"] = 149
    elif changed == "rationale":
        request["rationale"] = "A different change."
    else:
        request["kind"] = "operations"
    mock_reply(monkeypatch, RuntimeError("offline"))
    assert client.post("/api/explain", json=request).status_code == 502


def test_advice_cache_is_bounded_without_removing_job_confirmation_state(monkeypatch, context):
    scene, scenario, _ = context
    monkeypatch.setattr(server, "_MAX_ADVICE_CACHE", 2)
    client = TestClient(server.app)
    mock_reply(monkeypatch, proposal_reply())
    jobs = [proposal_job(client, request_for(scene, scenario, str(i))) for i in range(3)]
    assert len(server._proposal_cache) == 2
    assert client.get(f'/api/propose/{jobs[0]["job_id"]}').status_code == 200
    assert client.post(f'/api/propose/{jobs[0]["job_id"]}/run', json={"index": 0}).status_code == 409
    mock_reply(monkeypatch, TimeoutError("offline"))
    assert proposal_job(client, request_for(scene, scenario, "0"))["status"] == "error"


def test_invalid_scene_request_does_not_destroy_previous_manual_run(context):
    scene, scenario, _ = context
    client = TestClient(server.app)
    before = client.post("/api/run", json={"scene": scene.model_dump(), "scenario": scenario.model_dump()}).json()
    invalid = request_for(scene, scenario)
    invalid["scene"]["obstacles"][0]["poly"] = [[-1, 1], [1, 1], [1, 2], [-1, 2]]
    assert client.post("/api/propose", json=invalid).status_code == 422
    assert client.get(f'/api/frames/{before["run_id"]}').status_code == 200


def test_usage_aggregates_only_receipt_counters(monkeypatch, tmp_path):
    path = tmp_path / "usage.jsonl"
    rows = [
        {"status": "completed", "input_tokens": 100, "output_tokens": 20, "cost_estimate_usd": 0.002, "elapsed_s": 1.2},
        {"status": "error", "input_tokens": None, "output_tokens": None, "cost_estimate_usd": None, "elapsed_s": 2.3},
        {"status": "error", "input_tokens": 4, "output_tokens": 2, "cost_estimate_usd": 0.00014},
        {"status": "completed", "input_tokens": True, "output_tokens": -1, "cost_estimate_usd": "bad", "prompt": "PRIVATE_PROMPT", "api_key": "PRIVATE_KEY"},
    ]
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\nnot-json\n[\"PRIVATE_DATA\"]\n")
    monkeypatch.setattr(server.astra, "USAGE_PATH", path)
    response = TestClient(server.app).get("/api/usage")
    assert response.status_code == 200
    data = response.json()
    assert data == {"calls": 4, "completed_calls": 2, "failed_calls": 2, "unknown_status_calls": 0,
                    "input_tokens": 104, "output_tokens": 22, "cost_estimate_usd": 0.00214, "elapsed_s": 3.5,
                    "unknown_usage_calls": 2, "unknown_failed_calls": 1, "unknown_elapsed_calls": 2,
                    "invalid_receipt_lines": 2}
    assert "PRIVATE" not in response.text


def test_usage_missing_file_and_unreadable_source(monkeypatch, tmp_path):
    monkeypatch.setattr(server.astra, "USAGE_PATH", tmp_path / "absent.jsonl")
    assert TestClient(server.app).get("/api/usage").json()["calls"] == 0
    monkeypatch.setattr(server.astra, "USAGE_PATH", tmp_path)
    response = TestClient(server.app).get("/api/usage")
    assert response.status_code == 503
    assert str(tmp_path) not in response.text
