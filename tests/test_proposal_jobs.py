"""Background proposal jobs preserve manual runs, bounded storage, and errors."""

import json
from pathlib import Path
from threading import Event, Lock, current_thread
import time

from fastapi.testclient import TestClient
import pytest

import server
from crowd.engine import run
from crowd.schema import Scenario, Scene


@pytest.fixture
def rehearsal(monkeypatch):
    scene = Scene.model_validate_json((Path(__file__).parent / "fixtures/sample_room.json").read_text())
    scenario = Scenario(n_people=3, arrival_window_s=2, arrival_pattern="front_loaded",
                        seed=1, horizon_s=60, mode="queue")
    result = run(scene, scenario)
    monkeypatch.setattr(server, "_last_result", (scene.model_dump(mode="json"), scenario.model_dump(mode="json"), result))
    monkeypatch.setattr(server, "_proposal_jobs", {})
    request = {"scene": scene.model_dump(mode="json"), "scenario": scenario.model_dump(mode="json"),
               "baseline_metrics": {"mean_wait_s": 999999}, "baseline_accounting": {"done": 999999},
               "constraints": "Keep two volunteers"}
    return request, result


def wait_job(client, job_id):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        response = client.get(f"/api/propose/{job_id}")
        assert response.status_code == 200
        job = response.json()
        if job["status"] in {"completed", "error"}:
            return job
        time.sleep(0.01)
    pytest.fail("Proposal worker did not terminate within test deadline")


def submit(client, request):
    response = client.post("/api/propose", json=request)
    assert response.status_code == 200, response.text
    assert set(response.json()) == {"job_id"}
    return response.json()["job_id"]


def unchanged():
    return {"kind": "layout", "option_id": None, "patch": [], "rationale": "Retain the layout for comparison."}


def test_post_returns_while_astra_pending_and_manual_run_remains_available(monkeypatch, rehearsal):
    request, baseline = rehearsal
    entered, release = Event(), Event()
    calls = []

    def ask(prompt, schema, **kwargs):
        calls.append((prompt, kwargs))
        entered.set()
        assert release.wait(5)
        return {"candidates": [unchanged()]}

    monkeypatch.setattr(server.astra, "ask_structured", ask)
    client = TestClient(server.app)
    job_id = submit(client, request)
    try:
        assert entered.wait(2)
        job = client.get(f"/api/propose/{job_id}").json()
        assert job["status"] == "running"
        assert job["stage"] == "asking_astra"
        manual = client.post("/api/run", json={key: request[key] for key in ("scene", "scenario")})
        assert manual.status_code == 200
        run_id = manual.json()["run_id"]
        assert client.get(f"/api/frames/{run_id}").status_code == 200
    finally:
        release.set()
        job = wait_job(client, job_id)
    assert job["status"] == "completed"
    assert job["stage"] == "done"
    assert job["baseline_metrics"] == baseline.metrics
    assert job["baseline_accounting"] == baseline.accounting
    assert job["candidates"][0]["comparison"]["valid"]
    assert client.get(f"/api/frames/{run_id}").status_code == 200
    prompt, settings = calls[0]
    payload = json.loads(prompt.split("Input: ", 1)[1])
    assert len(payload["baseline_metrics"]) == 6
    assert payload["baseline_metrics"]["mean_wait_s"] == baseline.metrics["mean_wait_s"]
    assert payload["baseline_accounting"] == baseline.accounting
    assert '"frames"' not in prompt and '"events"' not in prompt and '"people"' not in prompt
    assert settings["reasoning"] == "medium"
    assert settings["timeout_s"] == 120
    assert settings["max_output_tokens"] == 2048


@pytest.mark.parametrize("blocked_index", [0, 1])
def test_manual_run_during_each_candidate_simulation(monkeypatch, rehearsal, blocked_index):
    request, result = rehearsal
    entered, release = Event(), Event()
    calls = []
    monkeypatch.setattr(server.astra, "ask_structured", lambda *args, **kwargs: {"candidates": [unchanged(), unchanged()]})

    def simulate(scene, scenario, **kwargs):
        if current_thread().name.startswith("crowd-proposal-"):
            index = len(calls)
            calls.append(index)
            if index == blocked_index:
                entered.set()
                assert release.wait(5)
        return result

    monkeypatch.setattr(server, "simulate", simulate)
    client = TestClient(server.app)
    job_id = submit(client, request)
    try:
        assert entered.wait(2)
        assert client.get(f"/api/propose/{job_id}").json()["stage"] == f"simulating {'AB'[blocked_index]}"
        manual = client.post("/api/run", json={key: request[key] for key in ("scene", "scenario")})
        assert manual.status_code == 200
        run_id = manual.json()["run_id"]
    finally:
        release.set()
        job = wait_job(client, job_id)
    assert job["status"] == "completed"
    assert len(job["candidates"]) == 2
    assert client.get(f"/api/frames/{run_id}").status_code == 200


def test_job_error_is_sanitized_and_manual_run_still_works(monkeypatch, rehearsal):
    request, _ = rehearsal

    def fail(*args, **kwargs):
        raise RuntimeError("PRIVATE_CREDENTIAL_MUST_NOT_LEAK")

    monkeypatch.setattr(server.astra, "ask_structured", fail)
    client = TestClient(server.app)
    job = wait_job(client, submit(client, request))
    assert job["status"] == "error"
    assert job["stage"] == "done"
    assert job["error"]["error_type"] == "RuntimeError"
    assert "PRIVATE_CREDENTIAL" not in json.dumps(job)
    assert client.post("/api/run", json={key: request[key] for key in ("scene", "scenario")}).status_code == 200


def test_workers_and_retention_are_bounded_without_evicting_active_jobs(monkeypatch, rehearsal):
    request, _ = rehearsal
    monkeypatch.setattr(server, "_MAX_PROPOSAL_JOBS", 2)
    both_entered, release, lock = Event(), Event(), Lock()
    entered = 0

    def ask(*args, **kwargs):
        nonlocal entered
        with lock:
            entered += 1
            if entered == 2:
                both_entered.set()
        assert release.wait(5)
        return {"candidates": []}

    monkeypatch.setattr(server.astra, "ask_structured", ask)
    client = TestClient(server.app)
    first, second = submit(client, request), submit(client, request)
    try:
        assert both_entered.wait(2)
        assert client.post("/api/propose", json=request).status_code == 429
        assert client.get(f"/api/propose/{first}").json()["status"] == "running"
        assert client.get(f"/api/propose/{second}").json()["status"] == "running"
    finally:
        release.set()
        assert wait_job(client, first)["status"] == "completed"
        assert wait_job(client, second)["status"] == "completed"
    third = submit(client, request)
    assert wait_job(client, third)["status"] == "completed"
    assert client.get(f"/api/propose/{first}").status_code == 404
    assert client.get(f"/api/propose/{second}").status_code == 200
    assert len(server._proposal_jobs) == 2


def test_bad_model_schema_ends_job_with_validation_errors(monkeypatch, rehearsal):
    request, _ = rehearsal
    monkeypatch.setattr(server.astra, "ask_structured", lambda *args, **kwargs: {"candidates": "invalid"})
    client = TestClient(server.app)
    job = wait_job(client, submit(client, request))
    assert job["status"] == "error"
    assert job["error"]["errors"]


@pytest.mark.parametrize("path,value", [
    ("/scenario/n_people", 1), ("/scenario/arrival_window_s", 20),
    ("/scenario/arrival_pattern", "uniform"), ("/scene/targets/0/service_s", 3),
])
def test_forbidden_patch_is_rejected_inside_completed_job(monkeypatch, rehearsal, path, value):
    request, _ = rehearsal
    bad = {"kind": "layout", "option_id": None, "patch": [{"op": "replace", "path": path, "value": value}],
           "rationale": "Adjust the rehearsal."}
    monkeypatch.setattr(server.astra, "ask_structured", lambda *args, **kwargs: {"candidates": [bad, unchanged()]})
    client = TestClient(server.app)
    job = wait_job(client, submit(client, request))
    assert job["status"] == "completed"
    assert job["rejected"][0]["index"] == 0
    assert job["candidates"][0]["index"] == 1
