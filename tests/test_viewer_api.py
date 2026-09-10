import base64
from pathlib import Path
from types import SimpleNamespace

import numpy as np
from fastapi.testclient import TestClient

import server
from crowd.engine import run
from crowd.schema import Scenario, Scene


def test_run_and_binary_frames_match_engine(monkeypatch):
    scene = Scene.model_validate_json(
        (Path(__file__).parent / "fixtures" / "sample_room.json").read_text()
    )
    scenario = Scenario(
        n_people=3, arrival_window_s=2, arrival_pattern="uniform",
        seed=1, horizon_s=80, mode="queue",
    )
    expected = run(scene, scenario)
    monkeypatch.setattr(server, "_runs", {})
    with TestClient(server.app) as client:
        response = client.post("/api/run", json={"scene": scene.model_dump(), "scenario": scenario.model_dump()})
        assert response.status_code == 200
        summary = response.json()
        assert set(summary) == {"run_id", "metrics", "accounting", "events"}
        assert summary["metrics"] == expected.metrics
        assert summary["accounting"] == expected.accounting
        frames = client.get(f"/api/frames/{summary['run_id']}")
        assert frames.status_code == 200
        assert frames.headers["content-type"] == "application/octet-stream"
        assert frames.headers["x-frame-dt-s"] == "0.2"
        assert frames.headers["x-person-count"] == "3"
        assert frames.headers["x-frame-count"] == "401"
        assert frames.headers["x-person-ids"] == '["p0","p1","p2"]'
        source = np.frombuffer(base64.b64decode(expected.frames), dtype="<f4").reshape(expected.frame_shape)
        assert frames.content == source[::2].tobytes()
        for rows in summary["events"].values():
            join = next(row for row in rows if row["kind"] == "joined_queue")
            assert isinstance(join["people_ahead"], int)
            assert join["target_id"] == "check_in"
            assert next(row for row in rows if row["kind"] == "seated")["position"] == [19.5, 10.25]
        second = client.post("/api/run", json={"scene": scene.model_dump(), "scenario": scenario.model_dump()})
        assert second.status_code == 200
        assert second.json()["run_id"] != summary["run_id"]
        assert client.get(f"/api/frames/{summary['run_id']}").status_code == 404
        assert len(server._runs) == 1


def test_ahead_counts_use_prior_joins_and_service_start_order():
    scene = Scene.model_validate_json(
        (Path(__file__).parent / "fixtures" / "sample_room.json").read_text()
    )
    result = SimpleNamespace(
        people=[{"id": f"p{i}", "target_id": "check_in"} for i in range(3)],
        events={
            "p0": [{"kind": "joined_queue", "time_s": 1}, {"kind": "service_start", "time_s": 3}],
            "p1": [{"kind": "joined_queue", "time_s": 2}],
            "p2": [{"kind": "joined_queue", "time_s": 3}],
        },
    )
    rows = server._viewer_events(result, scene)
    assert [rows[f"p{i}"][0]["people_ahead"] for i in range(3)] == [0, 1, 1]
    assert "people_ahead" not in result.events["p0"][0]


def test_invalid_run_and_concurrent_run_leave_cache_intact(monkeypatch):
    scene = Scene.model_validate_json(
        (Path(__file__).parent / "fixtures" / "sample_room.json").read_text()
    )
    scenario = Scenario(n_people=1, arrival_window_s=1, arrival_pattern="uniform", seed=1, horizon_s=1, mode="queue")
    monkeypatch.setattr(server, "_runs", {"previous": ({}, b"cached", {})})
    with TestClient(server.app) as client:
        assert client.post("/api/run", json={}).status_code == 422
        server._run_lock.acquire()
        try:
            response = client.post("/api/run", json={"scene": scene.model_dump(), "scenario": scenario.model_dump()})
            assert response.status_code == 409
            assert client.get("/api/frames/previous").content == b"cached"
        finally:
            server._run_lock.release()


def test_viewer_is_single_file_under_budget():
    source = (Path(__file__).parents[1] / "static" / "index.html").read_text()
    assert len(source.splitlines()) < 600
    assert '<canvas id="room"' in source
    assert '<script src=' not in source
