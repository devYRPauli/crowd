"""Pinned people survive arrival changes, selection, and frame-cache replacement."""

from collections import OrderedDict
from copy import deepcopy
from pathlib import Path
import time

from fastapi.testclient import TestClient
import pytest

import server
from crowd.engine import run
from crowd.schema import Scenario, Scene


@pytest.fixture
def pinned(monkeypatch):
    scene = Scene.model_validate_json((Path(__file__).parent / 'fixtures/sample_room.json').read_text())
    scenario = Scenario(n_people=4, arrival_window_s=2, arrival_pattern='front_loaded',
                        seed=1, horizon_s=100, mode='queue')
    monkeypatch.setattr(server, '_cohorts', OrderedDict())
    monkeypatch.setattr(server, '_last_result', None)
    monkeypatch.setattr(server, '_runs', {})
    monkeypatch.setattr(server, '_proposal_jobs', {})
    monkeypatch.setattr(server, '_proposal_private', {})
    monkeypatch.setattr(server, '_proposal_cache', {})
    body = {'scene': scene.model_dump(mode='json'), 'scenario': scenario.model_dump(mode='json')}
    client = TestClient(server.app)
    result = client.post('/api/run', json=body)
    assert result.status_code == 200, result.text
    return client, body, result.json()


def frame_bytes(client, summary):
    response = client.get('/api/frames/' + summary['run_id'])
    assert response.status_code == 200
    return response.content


def test_confirmed_arrival_preview_matches_pinned_manual_rerun(monkeypatch, pinned):
    client, body, baseline = pinned
    monkeypatch.setattr(server.astra, 'ask_structured', lambda *a, **k: {'candidates': [{
        'kind': 'operations', 'option_id': None, 'rationale': 'Spread arrivals across the session.',
        'patch': [{'op': 'replace', 'path': '/scenario/arrival_pattern', 'value': 'uniform'},
                  {'op': 'replace', 'path': '/scenario/arrival_window_s', 'value': 30}],
    }]})
    response = client.post('/api/propose', json={**body, 'cohort_id': baseline['cohort_id'],
        'baseline_metrics': {}, 'baseline_accounting': {}, 'constraints': 'Allow arrival changes'})
    assert response.status_code == 200, response.text
    job_id = response.json()['job_id']
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        job = client.get('/api/propose/' + job_id).json()
        if job['status'] in {'completed', 'error'}:
            break
        time.sleep(.01)
    assert job['status'] == 'completed', job
    assert 'metrics' not in job['candidates'][0]
    measured = client.post(f'/api/propose/{job_id}/run', json={'index': 0, 'confirmed': True})
    assert measured.status_code == 200, measured.text
    measured = measured.json()
    expected_frames = frame_bytes(client, measured)
    # Both the original cohort and its rescheduled receipt reproduce the preview.
    for cohort_id in (baseline['cohort_id'], measured['cohort_id']):
        rerun = client.post('/api/run', json={'scene': measured['scene'], 'scenario': measured['scenario'],
                                             'cohort_id': cohort_id})
        assert rerun.status_code == 200, rerun.text
        rerun = rerun.json()
        for key in ('metrics', 'accounting', 'events', 'people_hash', 'cohort_id'):
            assert rerun[key] == measured[key]
        assert frame_bytes(client, rerun) == expected_frames
    initial_people = server._cohorts[baseline['cohort_id']]['people']
    changed_people = server._cohorts[measured['cohort_id']]['people']
    assert initial_people != changed_people
    assert [{k: v for k, v in p.items() if k != 'arrival_s'} for p in initial_people] == [
        {k: v for k, v in p.items() if k != 'arrival_s'} for p in changed_people]


def test_unrelated_selection_preserves_immutable_cohort(monkeypatch, pinned):
    client, body, baseline = pinned
    expected = frame_bytes(client, baseline)
    saved = deepcopy(server._cohorts[baseline['cohort_id']])
    other = deepcopy(body)
    other['scenario']['seed'] = 9
    assert client.post('/api/run', json=other).status_code == 200
    assert client.get('/api/frames/' + baseline['run_id']).status_code == 404
    # Even a caller mutating engine input cannot modify retained source records.
    def mutating_engine(scene, scenario, **kwargs):
        result = run(scene, scenario, **kwargs)
        kwargs['people'][0]['service_s'] = 999
        return result
    monkeypatch.setattr(server, 'simulate', mutating_engine)
    response = client.post('/api/run', json={**body, 'cohort_id': baseline['cohort_id']})
    assert response.status_code == 200, response.text
    assert response.json()['metrics'] == baseline['metrics']
    assert frame_bytes(client, response.json()) == expected
    assert server._cohorts[baseline['cohort_id']] == saved


@pytest.mark.parametrize('field,value', [('seed', 2), ('n_people', 5), ('horizon_s', 101)])
def test_pinned_scenario_invariants_reject_without_simulation(monkeypatch, pinned, field, value):
    client, body, baseline = pinned
    body['scenario'][field] = value
    monkeypatch.setattr(server, 'simulate', lambda *a, **k: pytest.fail('Invalid cohort must not simulate'))
    response = client.post('/api/run', json={**body, 'cohort_id': baseline['cohort_id']})
    assert response.status_code == 422
    assert field in response.json()['detail']


def test_pinned_service_assumption_rejected(monkeypatch, pinned):
    client, body, baseline = pinned
    body['scene']['targets'][0]['service_s'] += 1
    monkeypatch.setattr(server, 'simulate', lambda *a, **k: pytest.fail('Invalid cohort must not simulate'))
    response = client.post('/api/run', json={**body, 'cohort_id': baseline['cohort_id']})
    assert response.status_code == 422
    assert 'service_s' in response.json()['detail']


def test_lru_touch_and_expiry_are_explicit(monkeypatch, pinned):
    client, body, baseline = pinned
    monkeypatch.setattr(server, '_MAX_COHORTS', 2)
    other = deepcopy(body)
    other['scenario']['seed'] = 2
    second = client.post('/api/run', json=other).json()
    assert client.post('/api/run', json={**body, 'cohort_id': baseline['cohort_id']}).status_code == 200
    other['scenario']['seed'] = 3
    assert client.post('/api/run', json=other).status_code == 200
    assert len(server._cohorts) == 2
    assert baseline['cohort_id'] in server._cohorts
    assert second['cohort_id'] not in server._cohorts
    monkeypatch.setattr(server, 'simulate', lambda *a, **k: pytest.fail('Expired cohort must not simulate'))
    response = client.post('/api/run', json={**body, 'cohort_id': second['cohort_id']})
    assert response.status_code == 410
    assert 'expired' in response.json()['detail']


def test_operations_uses_pinned_baseline_after_other_selection(pinned):
    client, body, baseline = pinned
    other = deepcopy(body)
    other['scenario']['seed'] = 8
    assert client.post('/api/run', json=other).status_code == 200
    response = client.post('/api/operations', json={**body, 'cohort_id': baseline['cohort_id'],
                                                  'preset': 'waves_15min', 'confirmed': True})
    assert response.status_code == 200, response.text
    assert response.json()['baseline_metrics'] == baseline['metrics']
    # Later arrival waves fall beyond this fixture's 100 s observation horizon.
    assert response.json()['comparison']['status'] == 'incomplete'
    assert response.json()['comparison']['valid'] is False
    assert response.json()['comparison']['better'] is None


@pytest.mark.parametrize('endpoint', ['/api/propose', '/api/operations'])
def test_expired_advice_cohort_never_calls_astra(monkeypatch, pinned, endpoint):
    client, body, _ = pinned
    monkeypatch.setattr(server.astra, 'ask_structured', lambda *a, **k: pytest.fail('Expired cohort must not call Astra'))
    extra = ({'baseline_metrics': {}, 'baseline_accounting': {}, 'constraints': ''}
             if endpoint == '/api/propose' else {'preset': 'one_volunteer', 'confirmed': True})
    response = client.post(endpoint, json={**body, **extra, 'cohort_id': '0' * 64})
    assert response.status_code == 410
