"""Existing proposal polling reports real work without extra model calls."""

from copy import deepcopy
from pathlib import Path
from threading import BoundedSemaphore, Event
import time

from fastapi.testclient import TestClient
import pytest

import server
from crowd.engine import run
from crowd.schema import Scene, Scenario


@pytest.fixture
def context(monkeypatch):
    scene = Scene.model_validate_json((Path(__file__).parent / "fixtures/sample_room.json").read_text())
    scenario = Scenario(n_people=3, arrival_window_s=2, arrival_pattern="uniform", seed=1,
                        horizon_s=120, mode="queue")
    baseline = run(scene, scenario)
    for name in ("_proposal_jobs", "_proposal_private", "_proposal_cache", "_explanation_cache"):
        monkeypatch.setattr(server, name, {})
    monkeypatch.setattr(server, "_proposal_slots", BoundedSemaphore(2))
    monkeypatch.setattr(server, "_last_result", (scene.model_dump(mode="json"), scenario.model_dump(mode="json"), baseline))
    return scene, scenario, baseline


def finished(client, job_id):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        job = client.get(f"/api/propose/{job_id}").json()
        if job["status"] in {"completed", "error"}:
            return job
        time.sleep(.01)
    pytest.fail("Proposal did not finish")


def test_existing_poll_exposes_rationale_rules_rejection_and_real_simulation(monkeypatch, context):
    scene, scenario, baseline = context
    asked, allow_answer, validating, allow_validation, simulating, allow_simulation = [Event() for _ in range(6)]
    calls = []

    def ask(*args, **kwargs):
        calls.append("model")
        asked.set()
        assert allow_answer.wait(5)
        return {"candidates": [
            {"kind": "layout", "option_id": None, "rationale": "Move the dining table.",
             "patch": [{"op": "replace", "path": "/scene/obstacles/1/poly", "value": scene.obstacles[1].poly}]},
            {"kind": "layout", "option_id": None, "rationale": "Retain the layout for comparison.", "patch": []},
        ]}

    original_apply = server.apply_candidate

    def apply(*args, **kwargs):
        if not validating.is_set():
            validating.set()
            assert allow_validation.wait(5)
        return original_apply(*args, **kwargs)

    def measured(*args, **kwargs):
        if kwargs.get("cached"):
            return baseline
        assert kwargs["people"] == baseline.people
        simulating.set()
        assert allow_simulation.wait(5)
        return baseline

    monkeypatch.setattr(server.astra, "ask_structured", ask)
    monkeypatch.setattr(server, "apply_candidate", apply)
    monkeypatch.setattr(server, "_measured", measured)
    client = TestClient(server.app)
    request = {"scene": scene.model_dump(), "scenario": scenario.model_dump(), "baseline_metrics": {},
               "baseline_accounting": {}, "constraints": "Keep two volunteers and locked tables"}
    response = client.post("/api/propose", json=request)
    assert response.status_code == 200
    job_id = response.json()["job_id"]
    try:
        assert asked.wait(2)
        initial = client.get(f"/api/propose/{job_id}").json()
        assert initial["progress"]["constraints"] == request["constraints"]
        assert initial["progress"]["allowed_operations"]
        assert initial["progress"]["candidates"] == []
        allow_answer.set()
        assert validating.wait(2)
        early = client.get(f"/api/propose/{job_id}").json()["progress"]
        assert [row["rationale"] for row in early["candidates"]] == [
            "Move the dining table.", "Retain the layout for comparison."
        ]
        assert early["candidates"][0]["status"] == "validating"
        assert early["candidates"][1]["status"] == "proposed"
        assert not simulating.is_set()
        allow_validation.set()
        assert simulating.wait(2)
        during = client.get(f"/api/propose/{job_id}").json()["progress"]
        rejected, active = during["candidates"]
        assert rejected["status"] == "rejected"
        assert "locked obstacle" in rejected["rejection_reason"]
        assert rejected["patch"][0]["path"] == "/scene/obstacles/1/poly"
        assert all(isinstance(rule, str) for rule in rejected["rule_checks"])
        assert active["simulation"] == {"status": "running", "n_people": 3}
        assert "simulation" not in early["candidates"][1]
        assert "people" not in during and "frames" not in during and "events" not in during
    finally:
        allow_answer.set()
        allow_validation.set()
        allow_simulation.set()
        final = finished(client, job_id)
    assert final["status"] == "completed"
    assert final["progress"]["candidates"][1]["simulation"] == {"status": "completed", "n_people": 3, "completed": 3}
    assert calls == ["model"]


def test_progress_publication_and_reads_are_independent_copies(monkeypatch):
    monkeypatch.setattr(server, "_proposal_jobs", {"test": {"job_id": "test"}})
    progress = {"candidates": [{"rule_checks": ["Original check"]}]}
    server._proposal_update("test", progress=progress)
    progress["candidates"][0]["rule_checks"].append("Mutated after publication")
    first = server.proposal_status("test")
    assert first["progress"]["candidates"][0]["rule_checks"] == ["Original check"]
    first["progress"]["candidates"][0]["rule_checks"].append("Mutated response")
    assert server.proposal_status("test")["progress"]["candidates"][0]["rule_checks"] == ["Original check"]


@pytest.mark.parametrize("failures,status,expected_calls", [(0, 200, 1), (1, 200, 2), (2, 422, 2)])
def test_interpret_reports_correction_errors_without_additional_calls(monkeypatch, context, failures, status, expected_calls):
    scene, scenario, _ = context
    valid = {"scene": None, "scenario": scenario.model_dump(), "assumptions": []}
    invalid = {**deepcopy(valid), "scene": scene.model_dump()}
    invalid["scene"]["entrances"][0]["poly"][0] = [-1, 6]
    answers = [invalid] * failures + [valid]
    calls = []

    def ask(*args, **kwargs):
        calls.append(1)
        return deepcopy(answers[len(calls) - 1])

    monkeypatch.setattr(server.astra, "ask_structured", ask)
    response = TestClient(server.app).post("/api/interpret", json={"brief": "Test event"})
    assert response.status_code == status
    body = response.json() if status == 200 else response.json()["detail"]
    if failures:
        assert any("outside the walkable boundary" in error for error in body["correction_errors"])
    else:
        assert body["correction_errors"] == []
    assert len(calls) == expected_calls
