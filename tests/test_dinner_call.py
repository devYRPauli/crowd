"""Dinner anchors, grouped releases and native movement use one pinned cohort."""

import base64
from collections import Counter
from copy import deepcopy
import json
import math
from pathlib import Path
import re

import numpy as np
import pytest
from shapely.geometry import LineString, Point, Polygon

from crowd.engine import (
    dinner_seat_positions, dinner_standing_zone, presample_people,
    reschedule_people, run,
)
from crowd.schema import Scenario, Scene


@pytest.fixture(scope='module')
def puck():
    # The committed saved-room catalog is the distributable Puck fixture; no
    # ignored local data directory or API key is needed by these regressions.
    html = (Path(__file__).parents[1] / 'static/index.html').read_text()
    catalog = json.loads(re.search(r'<script id="room-catalog" type="application/json">(.*?)</script>', html, re.S).group(1))
    return Scene.model_validate(next(room['scene'] for room in catalog if room['filename'] == 'venue_v3.json'))


@pytest.fixture(scope='module')
def dinner_scenario():
    return Scenario(n_people=120, arrival_window_s=600, arrival_pattern='front_loaded',
                    seed=1, horizon_s=1800, mode='dinner_call')


@pytest.fixture(scope='module')
def dinner_result(puck, dinner_scenario):
    return run(puck, dinner_scenario)


def test_puck_has_six_ring_anchors_per_table_and_two_per_sofa_segment(puck):
    anchors = dinner_seat_positions(puck)
    assert len(anchors) == 66
    groups = Counter(p['seat_group'] for p in anchors)
    tables = [o for o in puck.obstacles if o.kind == 'round_table']
    assert len(tables) == 9
    for table in tables:
        assert groups[table.id] == 6
        center = Polygon(table.poly).centroid
        assert all(math.isclose(Point(p['seat_position']).distance(center), .9)
                   for p in anchors if p['seat_group'] == table.id)
    sofa_groups = {group: count for group, count in groups.items() if ':segment_' in group}
    assert len(sofa_groups) == 6
    assert set(sofa_groups.values()) == {2}
    assert all(p['seat_position'][1] > 1.3 for p in anchors if ':segment_' in p['seat_group'])


def test_standing_anchors_use_the_exact_seeded_zone(puck, dinner_scenario):
    people = presample_people(puck, dinner_scenario)
    assert people == presample_people(puck, dinner_scenario)
    standing = [p for p in people if p['placement_kind'] == 'standing']
    assert len(standing) == 54
    zone = dinner_standing_zone(puck)
    assert zone.area == pytest.approx(5.650924923564407)
    for person in standing:
        point = Point(person['seat_anchor'])
        assert zone.contains(point)
        assert all(point.distance(Polygon(o.poly)) > 1.5 for o in puck.obstacles if o.kind == 'round_table')
        assert all(not Polygon(w.poly).covers(point) for w in puck.walkways)
        assert all(point.distance(LineString(t.queue_polyline)) > .4 for t in puck.targets)


@pytest.mark.xfail(strict=True, reason="Experimental native dinner occupancy can gridlock in dense Puck layouts; 120-person completion remains unresolved")
def test_dinner_completes_120_with_initial_frames_and_unique_lifecycle(puck, dinner_scenario, dinner_result):
    result = dinner_result
    assert result.accounting == {'seated': 0, 'walking': 0, 'queued': 0, 'in_service': 0, 'done': 120}
    assert result.metrics['initial_seat_count'] == 66
    assert result.metrics['initial_standing_count'] == 54
    frames = np.frombuffer(base64.b64decode(result.frames), dtype='<f4').reshape(result.frame_shape)
    assert np.array_equal(frames[0], np.array([p['seat_position'] for p in result.people], dtype='<f4'))
    floor = Polygon(puck.walkable)
    for person in result.people:
        events = result.events[person['id']]
        kinds = [e['kind'] for e in events]
        lifecycle = ['initially_seated', 'released', 'spawned', 'joined_queue', 'service_start', 'service_end', 'returned_to_seat']
        assert all(kinds.count(kind) == 1 for kind in lifecycle)
        assert [kinds.index(kind) for kind in lifecycle] == sorted(kinds.index(kind) for kind in lifecycle)
        release = next(e for e in events if e['kind'] == 'released')
        assert person['arrival_s'] <= release['time_s'] < person['arrival_s'] + .051
        spawn = next(e for e in events if e['kind'] == 'spawned')
        assert floor.covers(Point(spawn['release_position']))
        assert all(Polygon(o.poly).distance(Point(spawn['release_position'])) >= .2 for o in puck.obstacles)
        assert spawn['projection_distance_m'] == pytest.approx(0)
    assert max(row['in_service'] for row in result.diagnostics) == 2
    assert all(row['seated'] + row['done'] <= dinner_scenario.n_people for row in result.diagnostics)


def test_wave_reschedule_keeps_whole_groups_left_to_right_and_same_people(puck, dinner_scenario):
    people = presample_people(puck, dinner_scenario)
    before = deepcopy(people)
    waves = dinner_scenario.model_copy(update={'arrival_pattern': 'waves', 'wave_count': 3, 'wave_gap_s': 300})
    changed = reschedule_people(puck, waves, people)
    assert people == before
    assert {p['arrival_s'] for p in changed} == {0, 300, 600}
    assert [{k: v for k, v in p.items() if k != 'arrival_s'} for p in changed] == [
        {k: v for k, v in p.items() if k != 'arrival_s'} for p in people]
    groups = {}
    for person in changed:
        groups.setdefault(person['seat_group'], []).append(person)
    ordered = sorted(groups.values(), key=lambda group: np.mean([p['seat_anchor'][0] for p in group if p['placement_kind'] == 'seat']))
    assert all(len({p['arrival_s'] for p in group}) == 1 for group in ordered)
    releases = [group[0]['arrival_s'] for group in ordered]
    assert releases == sorted(releases)
    assert Counter(releases) == {0: 5, 300: 5, 600: 5}


def test_uniform_release_preserves_seats_and_nonarrival_records(puck, dinner_scenario):
    people = presample_people(puck, dinner_scenario)
    uniform = dinner_scenario.model_copy(update={'arrival_pattern': 'uniform', 'arrival_window_s': 400})
    changed = reschedule_people(puck, uniform, people)
    expected = presample_people(puck, uniform)
    assert [p['arrival_s'] for p in changed] == [p['arrival_s'] for p in expected]
    assert all(0 <= p['arrival_s'] <= 400 for p in changed)
    for before, after in zip(people, changed):
        assert {k: v for k, v in before.items() if k != 'arrival_s'} == {k: v for k, v in after.items() if k != 'arrival_s'}


@pytest.mark.xfail(strict=True, reason="Experimental native dinner occupancy can gridlock in dense Puck layouts; 120-person completion remains unresolved")
def test_puck_wave_release_completes_all_120(puck, dinner_scenario, dinner_result):
    waves = dinner_scenario.model_copy(update={'arrival_pattern': 'waves', 'wave_count': 3, 'wave_gap_s': 300})
    people = reschedule_people(puck, waves, dinner_result.people)
    result = run(puck, waves, people=people)
    assert result.accounting == {'seated': 0, 'walking': 0, 'queued': 0, 'in_service': 0, 'done': 120}


def test_small_dinner_run_is_exactly_deterministic_and_does_not_mutate_people(puck):
    scenario = Scenario(n_people=12, arrival_window_s=20, arrival_pattern='front_loaded',
                        seed=1, horizon_s=400, mode='dinner_call')
    people = presample_people(puck, scenario)
    before = deepcopy(people)
    first = run(puck, scenario, people=people)
    second = run(puck, scenario, people=people)
    assert first == second
    assert first.accounting['done'] == 12
    assert people == before


def test_unreleased_people_are_seated_not_silently_missing(puck):
    scenario = Scenario(n_people=12, arrival_window_s=600, arrival_pattern='front_loaded',
                        seed=1, horizon_s=.1, mode='dinner_call')
    result = run(puck, scenario)
    assert result.accounting == {'seated': 12, 'walking': 0, 'queued': 0, 'in_service': 0, 'done': 0}
    assert sum(result.accounting.values()) == 12
    assert np.isfinite(np.frombuffer(base64.b64decode(result.frames), dtype='<f4')).all()
    assert result.diagnostics[0]['native_agents'] == 12
    assert all(result.events[p['id']][0]['native_present'] for p in result.people)


def test_dinner_initial_positions_are_clear_and_distinct(puck, dinner_scenario):
    people = presample_people(puck, dinner_scenario)
    for index, person in enumerate(people):
        point = Point(person['seat_position'])
        assert Polygon(puck.walkable).covers(point)
        assert all(point.distance(Polygon(obstacle.poly)) >= .2 for obstacle in puck.obstacles)
        assert all(not Polygon(walkway.poly).covers(point) for walkway in puck.walkways)
        assert all(point.distance(Point(other['seat_position'])) >= .42 for other in people[index + 1:])
    assert any(person['standing_overflow'] for person in people)


def test_returned_dinner_guests_remain_native_and_visible(puck):
    scenario = Scenario(n_people=12, arrival_window_s=20, arrival_pattern='front_loaded', seed=1, horizon_s=400, mode='dinner_call')
    result = run(puck, scenario)
    assert result.accounting['done'] == 12
    assert all(row['native_agents'] == 12 for row in result.diagnostics)
    assert result.diagnostics[-1]['returned_native'] == 12
    frames = np.frombuffer(base64.b64decode(result.frames), dtype='<f4').reshape(result.frame_shape)
    for index, person in enumerate(result.people):
        returned = next(event for event in result.events[person['id']] if event['kind'] == 'returned_to_seat')
        assert math.dist(returned['position'], person['seat_position']) <= .1
        assert np.isfinite(frames[int(returned['time_s'] / .1):, index]).all()
        assert not any(event['kind'] == 'exited' for event in result.events[person['id']])
