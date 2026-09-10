import base64
import json
import struct
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from shapely.geometry import Polygon

from crowd import astra
from crowd.schema import (
    RESULT_SCHEMA,
    SCENARIO_SCHEMA,
    SCENE_SCHEMA,
    Result,
    Scenario,
    Scene,
)
from server import app

FIXTURE = Path(__file__).parent / "fixtures" / "sample_room.json"
TINY_SCHEMA = {
    "type": "object",
    "properties": {"ok": {"type": "boolean"}},
    "required": ["ok"],
    "additionalProperties": False,
}
RESULT_METADATA = {
    "frame_shape": [1, 1, 2], "frame_dt_s": 0.1, "horizon_s": 0.1,
    "density_grid": {
        "origin": [0, 0], "cell_size_m": 0.5,
        "mean_persons_m2": [[0]], "max_persons_m2": [[0]],
        "max_sustained_s": [[0]], "bottleneck_cells": [],
    },
}


@pytest.fixture
def scene():
    return Scene.model_validate_json(FIXTURE.read_text())


@pytest.fixture
def scenario():
    return Scenario(
        n_people=20, arrival_window_s=60, arrival_pattern="uniform",
        seed=42, horizon_s=300, mode="queue",
    )


def test_schema_round_trip(scene, scenario):
    frames = base64.b64encode(struct.pack("<ff", 1.25, 2.5)).decode("ascii")
    result = Result(
        metrics={"mean_wait_s": 0.0}, accounting={"presampled": 20},
        people=[{"id": "p0", "arrival_s": 0}], frames=frames,
        events={"p0": [{"kind": "arrived", "time_s": 0}]},
        scene_hash="a" * 64, scenario_hash="b" * 64,
        **RESULT_METADATA,
    )
    for model, schema in (
        (scene, SCENE_SCHEMA), (scenario, SCENARIO_SCHEMA), (result, RESULT_SCHEMA)
    ):
        assert type(model).model_validate_json(model.model_dump_json()) == model
        assert json.loads(json.dumps(schema)) == type(model).model_json_schema()
        assert schema["additionalProperties"] is False
        assert set(schema["required"]) == {
            name for name, field in type(model).model_fields.items() if field.is_required()
        }
    assert struct.unpack("<ff", base64.b64decode(result.frames)) == (1.25, 2.5)


def test_sample_room_contents(scene):
    assert Polygon(scene.walkable).bounds == (0, 0, 24, 14)
    assert Polygon(scene.walkable).area == 336
    assert len(scene.entrances) == 1
    assert len(scene.exits) == 2
    assert len(scene.walkways) == 1
    assert len(scene.targets[0].service_positions) == 2
    assert len(scene.targets[0].queue_polyline) >= 2
    assert sum(o.kind == "dining_table" and o.locked for o in scene.obstacles) == 3
    assert any(d.id == "seating_area" for d in scene.destinations)
    assert all(o.id != "seating_area" for o in scene.obstacles)
    assert scene.targets[0].queue_polyline == [[5, 9.5], [3, 9.5], [3, 7], [13, 7]]


@pytest.mark.parametrize("defect", ["crossed", "outside", "duplicate", "blocked", "service", "extra"])
def test_scene_rejects_invalid_input(scene, defect):
    data = scene.model_dump()
    if defect == "crossed":
        data["walkable"] = [[0, 0], [24, 14], [24, 0], [0, 14]]
    elif defect == "outside":
        data["entrances"][0]["poly"][0] = [-1, 6]
    elif defect == "duplicate":
        data["exits"][0]["id"] = data["entrances"][0]["id"]
    elif defect == "blocked":
        data["targets"][0]["queue_polyline"] = [[2, 8.5], [7, 10.5]]
    elif defect == "service":
        data["targets"][0]["service_positions"][0] = [14, 9.5]
    else:
        data["unrecognized"] = True
    with pytest.raises(ValidationError):
        Scene.model_validate(data)


@pytest.mark.parametrize("overflow,message", [
    ([[-1, 9], [2, 9], [2, 11], [-1, 11]], "outside room"),
    ([[6, 2], [8, 2], [8, 4], [6, 4]], "hits dining_1"),
    ([[0.5, 6.5], [2, 6.5], [2, 7.5], [0.5, 7.5]], "hits entrance"),
    ([[11, 6.5], [14, 6.5], [14, 7.5], [11, 7.5]], "hits queue"),
    ([[7.7, 9.2], [8.3, 9.2], [8.3, 9.8], [7.7, 9.8]], "hits service position"),
])
def test_overflow_area_rejects_conflicting_geometry(scene, overflow, message):
    data = scene.model_dump()
    data["targets"][0]["overflow_area"] = overflow
    with pytest.raises(ValidationError, match=message):
        Scene.model_validate(data)


def test_overflow_area_legacy_schema_compatibility(scene):
    data = scene.model_dump()
    del data["targets"][0]["overflow_area"]
    assert Scene.model_validate(data).targets[0].overflow_area is None


@pytest.mark.parametrize("field,value", [
    ("n_people", -1), ("arrival_window_s", 0), ("seed", -1),
    ("horizon_s", float("inf")), ("mode", "free"), ("arrival_pattern", "random"),
])
def test_scenario_rejects_invalid_input(scenario, field, value):
    data = scenario.model_dump()
    data[field] = value
    with pytest.raises(ValidationError):
        Scenario.model_validate(data)


@pytest.mark.parametrize("frames", ["not base64!", "AA=="])
def test_result_rejects_invalid_frames(frames):
    with pytest.raises(ValidationError, match="frames"):
        Result(
            metrics={}, accounting={}, people=[], frames=frames, events={},
            scene_hash="a" * 64, scenario_hash="b" * 64,
            **RESULT_METADATA,
        )


def test_http_scaffold(scene):
    with TestClient(app) as client:
        page = client.get("/")
        assert page.status_code == 200
        assert "'/api/scene'" in page.text
        response = client.get("/api/scene")
        assert response.status_code == 200
        assert Scene.model_validate(response.json()) == scene
        assert client.post("/api/scene", json=scene.model_dump()).status_code == 501
        for action in ("interpret", "propose", "explain"):
            response = client.post(f"/api/{action}", json={})
            assert response.status_code == 422
            assert response.json()["detail"]


@pytest.fixture
def fake_astra(monkeypatch, tmp_path):
    client = MagicMock()
    factory = MagicMock()
    factory.return_value.__enter__.return_value = client
    monkeypatch.setattr(astra, "OpenAI", factory)
    monkeypatch.setattr(astra, "USAGE_PATH", tmp_path / "usage.jsonl")
    response = SimpleNamespace(
        id="resp_test", status="completed", output=[], output_text='{"ok": true}',
        usage=SimpleNamespace(input_tokens=100, output_tokens=20),
        incomplete_details=None, error=None,
    )
    client.responses.create.return_value = response
    return client, response


def test_astra_request_and_usage(fake_astra):
    client, _ = fake_astra
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGf8AAAAASUVORK5CYII="
    )
    assert astra.ask_structured("Say ok", TINY_SCHEMA, images=[png]) == {"ok": True}
    request = client.responses.create.call_args.kwargs
    assert request["model"] == "gpt-6-astra"
    assert request["reasoning"] == {"effort": "low"}
    assert request["text"]["format"]["strict"] is True
    assert request["text"]["format"]["schema"] == TINY_SCHEMA
    assert request["input"][0]["content"][1]["image_url"].startswith("data:image/png;base64,")
    astra.ask_structured("Say ok again", TINY_SCHEMA)
    records = [json.loads(line) for line in astra.USAGE_PATH.read_text().splitlines()]
    assert len(records) == 2
    assert records[0]["input_tokens"] == 100
    assert records[0]["output_tokens"] == 20
    assert records[0]["cost_estimate_usd"] == pytest.approx(0.002)
    assert records[0]["status"] == "completed"
    assert "Say ok" not in astra.USAGE_PATH.read_text()


@pytest.mark.parametrize("failure", ["api", "incomplete", "refusal", "json", "array", "geometry"])
def test_astra_failure_is_loud_and_logged(fake_astra, scene, failure):
    client, response = fake_astra
    schema = TINY_SCHEMA
    if failure == "api":
        client.responses.create.side_effect = RuntimeError("Network failed")
    elif failure == "incomplete":
        response.status = "incomplete"
        response.incomplete_details = {"reason": "max_output_tokens"}
    elif failure == "refusal":
        response.output = [SimpleNamespace(
            type="message", content=[SimpleNamespace(type="refusal", refusal="Cannot comply")]
        )]
    elif failure == "json":
        response.output_text = "{"
    elif failure == "array":
        response.output_text = "[]"
    else:
        schema = SCENE_SCHEMA
        data = scene.model_dump()
        data["targets"][0]["service_positions"] = [[100, 100]]
        response.output_text = json.dumps(data)
    with pytest.raises((RuntimeError, ValidationError)):
        astra.ask_structured("Test failure", schema)
    record = json.loads(astra.USAGE_PATH.read_text())
    assert record["status"] == "error"
    assert record["error_type"]
    assert record["input_tokens"] == (None if failure == "api" else 100)
    assert record["cost_estimate_usd"] == (None if failure == "api" else 0.002)


def test_astra_live_tiny_object():
    if not astra.load_api_key():
        pytest.skip("OPENAI_API_KEY is not set in environment or .env")
    assert astra.ask_structured("Return a JSON object with ok set to true.", TINY_SCHEMA) == {"ok": True}


def test_dotenv_key_loading(monkeypatch, tmp_path):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    path = tmp_path / "test.env"
    path.write_text('# Comment\nUNRELATED=ignored\nOPENAI_API_KEY="fake-test-key" # comment\n')
    monkeypatch.setattr(astra, "ENV_PATH", path)
    assert astra.load_api_key() == "fake-test-key"
    monkeypatch.setenv("OPENAI_API_KEY", "environment-test-key")
    assert astra.load_api_key() == "environment-test-key"
