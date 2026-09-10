"""Bounded Astra retries and compact proposal input, without network calls."""

import copy
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from openai import APIConnectionError, APIStatusError, APITimeoutError
from pydantic import ValidationError

from crowd import astra
from crowd.advice import HEADLINE_METRICS, compact_proposal_payload
from crowd.schema import Scenario, Scene


TINY_SCHEMA = {
    "type": "object", "properties": {"ok": {"type": "boolean"}},
    "required": ["ok"], "additionalProperties": False,
}


@pytest.fixture
def mocked_astra(monkeypatch, tmp_path):
    client, factory = MagicMock(), MagicMock()
    factory.return_value.__enter__.return_value = client
    response = SimpleNamespace(
        id="mock_response", status="completed", output=[], output_text='{"ok": true}',
        usage=SimpleNamespace(input_tokens=100, output_tokens=20),
        incomplete_details=None, error=None,
    )
    client.responses.create.return_value = response
    clock = SimpleNamespace(
        perf_counter=MagicMock(side_effect=[100.0, 103.25]), sleep=MagicMock(),
    )
    monkeypatch.setattr(astra, "time", clock)
    monkeypatch.setattr(astra, "OpenAI", factory)
    monkeypatch.setattr(astra, "load_api_key", lambda: "mock-key-never-sent")
    monkeypatch.setattr(astra, "USAGE_PATH", tmp_path / "usage.jsonl")
    return client, factory, response, clock


def api_error(kind):
    request = SimpleNamespace(method="POST", url="https://example.invalid/responses")
    if kind == "connection":
        return APIConnectionError(request=request)
    if kind == "timeout":
        return APITimeoutError(request=request)
    return APIStatusError("mock status", response=SimpleNamespace(
        status_code=kind, request=request, headers={},
    ), body=None)


@pytest.mark.parametrize("kind", ["connection", "timeout", 408, 409, 429, 500, 503, 599])
def test_transient_failure_retries_once_and_logs_one_call(mocked_astra, kind):
    client, factory, response, clock = mocked_astra
    client.responses.create.side_effect = [api_error(kind), response]
    assert astra.ask_structured("private prompt", TINY_SCHEMA) == {"ok": True}
    assert client.responses.create.call_count == 2
    assert client.responses.create.call_args_list[0] == client.responses.create.call_args_list[1]
    clock.sleep.assert_called_once_with(0.5)
    assert factory.call_args.kwargs["max_retries"] == 0
    lines = astra.USAGE_PATH.read_text().splitlines()
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert record["attempts"] == 2
    assert record["status"] == "completed"
    assert record["elapsed_s"] == 3.25
    assert record["input_tokens"] == 100
    assert record["output_tokens"] == 20
    assert record["cost_estimate_usd"] == pytest.approx(0.002)
    assert "private prompt" not in lines[0]
    assert "mock-key-never-sent" not in lines[0]


def test_retry_limit_is_two_attempts_total(mocked_astra):
    client, _, _, clock = mocked_astra
    client.responses.create.side_effect = api_error("timeout")
    with pytest.raises(APITimeoutError):
        astra.ask_structured("timeout", TINY_SCHEMA)
    assert client.responses.create.call_count == 2
    clock.sleep.assert_called_once_with(0.5)
    record = json.loads(astra.USAGE_PATH.read_text())
    assert record["attempts"] == 2
    assert record["status"] == "error"
    assert record["error_type"] == "APITimeoutError"
    assert record["elapsed_s"] == 3.25
    assert record["input_tokens"] is None
    assert record["cost_estimate_usd"] is None


@pytest.mark.parametrize("status", [400, 401, 403, 404, 422])
def test_authentication_and_other_permanent_errors_do_not_retry(mocked_astra, status):
    client, _, _, clock = mocked_astra
    client.responses.create.side_effect = api_error(status)
    with pytest.raises(APIStatusError):
        astra.ask_structured("permanent failure", TINY_SCHEMA)
    assert client.responses.create.call_count == 1
    clock.sleep.assert_not_called()
    record = json.loads(astra.USAGE_PATH.read_text())
    assert record["attempts"] == 1
    assert record["status"] == "error"


@pytest.mark.parametrize("failure", ["incomplete", "refusal", "invalid_json"])
def test_unusable_model_output_does_not_retry(mocked_astra, failure):
    client, _, response, clock = mocked_astra
    if failure == "incomplete":
        response.status = "incomplete"
        response.incomplete_details = {"reason": "max_output_tokens"}
    elif failure == "refusal":
        response.output = [SimpleNamespace(type="message", content=[
            SimpleNamespace(type="refusal", refusal="Mock refusal"),
        ])]
    else:
        response.output_text = "not json"
    with pytest.raises((RuntimeError, ValidationError)):
        astra.ask_structured("bad output", TINY_SCHEMA)
    assert client.responses.create.call_count == 1
    clock.sleep.assert_not_called()
    assert json.loads(astra.USAGE_PATH.read_text())["attempts"] == 1


@pytest.mark.parametrize("overrides,timeout,cap", [({}, 45.0, 2048), ({"timeout_s": 120.0}, 120.0, 2048),
                                                        ({"max_output_tokens": 1000}, 45.0, 1000)])
def test_timeout_and_output_cap_are_explicit_and_logged(mocked_astra, overrides, timeout, cap):
    client, factory, _, _ = mocked_astra
    astra.ask_structured("bounded output", TINY_SCHEMA, **overrides)
    assert factory.call_args.kwargs["timeout"] == timeout
    assert factory.call_args.kwargs["max_retries"] == 0
    assert client.responses.create.call_args.kwargs["max_output_tokens"] == cap
    record = json.loads(astra.USAGE_PATH.read_text())
    assert record["timeout_s"] == timeout
    assert record["max_output_tokens"] == cap
    assert record["elapsed_s"] == 3.25
    assert record["attempts"] == 1


def test_compact_proposal_payload_keeps_only_decision_context_without_mutation():
    scene = Scene.model_validate_json(
        (Path(__file__).parent / "fixtures" / "sample_room.json").read_text()
    )
    scenario = Scenario(n_people=150, arrival_window_s=600, arrival_pattern="front_loaded",
                        seed=1, horizon_s=1800, mode="queue")
    metrics = {key: i + 1 for i, key in enumerate(HEADLINE_METRICS)}
    metrics.update(frames="forbidden frame payload", events=["forbidden events"],
                   diagnostics=["unnecessary trace"], extra_engine_metric=123)
    accounting = {"done": 150, "queued": 0, "walking": 0, "in_service": 0, "not_arrived": 0}
    before = (scene.model_dump(), scenario.model_dump(), copy.deepcopy(metrics), copy.deepcopy(accounting))
    compact = compact_proposal_payload(scene, scenario, metrics, accounting, "Keep two volunteers")
    assert before == (scene.model_dump(), scenario.model_dump(), metrics, accounting)
    assert set(compact) == {"scene", "scenario", "baseline_metrics", "baseline_accounting", "constraints"}
    assert len(HEADLINE_METRICS) == 6
    assert set(compact["baseline_metrics"]) == set(HEADLINE_METRICS)
    assert compact["baseline_metrics"] == {key: metrics[key] for key in HEADLINE_METRICS}
    assert compact["baseline_accounting"] == accounting
    assert compact["scenario"] == scenario.model_dump(mode="json")
    assert compact["constraints"] == "Keep two volunteers"
    summary = compact["scene"]
    assert summary["walkable_bbox"] == [0, 0, 24, 14]
    for index, obstacle in enumerate(scene.obstacles):
        item = summary["obstacles"][index]
        assert item["id"] == obstacle.id
        assert item["index"] == index
        assert item["locked"] == obstacle.locked
        assert item["kind"] == obstacle.kind
        assert "poly" not in item
        assert len(item["bbox"]) == 4
    assert summary["obstacles"][0]["bbox"] == [5, 10, 9, 11]
    for option in summary["layout_options"]:
        assert set(option) == {"id", "target_id", "label"}
    for name in ("entrances", "exits", "walkways", "destinations"):
        assert [item["id"] for item in summary[name]] == [item.id for item in getattr(scene, name)]
        assert all(set(item) == {"id", "index", "bbox"} for item in summary[name])
    target = summary["targets"][0]
    assert target["id"] == scene.targets[0].id
    assert target["index"] == 0
    assert target["queue_polyline"] == scene.targets[0].queue_polyline
    assert target["service_positions"] == scene.targets[0].service_positions
    assert target["service_s"] == scene.targets[0].service_s
    assert target["overflow_bbox"] == [9.5, 8.5, 16.5, 11.5]
    encoded = json.dumps(compact, separators=(",", ":"))
    assert all(forbidden not in encoded for forbidden in ("frames", "events", "diagnostics", "extra_engine_metric"))
    full = json.dumps({**compact, "scene": scene.model_dump(mode="json")}, separators=(",", ":"))
    assert len(encoded) < len(full)
    assert len(encoded) < 3000


def test_compact_proposal_payload_marks_missing_metrics_and_default_overflow():
    scene = Scene.model_validate_json(
        (Path(__file__).parent / "fixtures" / "sample_room.json").read_text()
    )
    data = scene.model_dump()
    data["targets"][0]["overflow_area"] = None
    scene = Scene.model_validate(data)
    scenario = Scenario(n_people=1, arrival_window_s=1, arrival_pattern="uniform",
                        seed=1, horizon_s=1, mode="queue")
    compact = compact_proposal_payload(scene, scenario, {}, {}, "")
    assert compact["baseline_metrics"] == dict.fromkeys(HEADLINE_METRICS)
    assert compact["scene"]["targets"][0]["overflow_bbox"] is None
