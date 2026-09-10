"""Completion follows physical exit/return arrival rather than service completion."""
import base64
import json
from pathlib import Path

import numpy as np
from shapely.geometry import Point, Polygon

from crowd.engine import run
from crowd.schema import Scene, Scenario


def test_queue_service_and_destination_do_not_complete_before_exit():
    scene = Scene.model_validate(json.loads((Path(__file__).parent / 'fixtures/sample_room.json').read_text()))
    scenario = Scenario(n_people=3, arrival_window_s=2, seed=1, horizon_s=200, arrival_pattern="front_loaded", mode="queue")
    result = run(scene, scenario)
    assert result.accounting['done'] == 3
    frames = np.frombuffer(base64.b64decode(result.frames), dtype='<f4').reshape(result.frame_shape)
    for index, person in enumerate(result.people):
        events = result.events[person['id']]
        kinds = [event['kind'] for event in events]
        assert kinds.count('reached_destination') == kinds.count('exited') == 1
        assert 'seated' not in kinds
        end = next(event for event in events if event['kind'] == 'service_end')
        destination = next(event for event in events if event['kind'] == 'reached_destination')
        exited = next(event for event in events if event['kind'] == 'exited')
        assert end['time_s'] < destination['time_s'] < exited['time_s']
        assert any(Polygon(exit.poly).covers(Point(exited['position'])) for exit in scene.exits)
        assert np.isnan(frames[int(exited['time_s'] / .1) + 1:, index]).all()


def test_puck_arrival_120_complete_at_actual_exits():
    import re
    html = (Path(__file__).parents[1] / 'static/index.html').read_text()
    catalog = json.loads(re.search(r'<script id="room-catalog" type="application/json">(.*?)</script>', html, re.S).group(1))
    scene = Scene.model_validate(next(room['scene'] for room in catalog if room['filename'] == 'venue_v3.json'))
    scenario = Scenario(n_people=120, arrival_window_s=600, arrival_pattern='front_loaded',
                        seed=1, horizon_s=1800, mode='queue')
    result = run(scene, scenario)
    assert result.accounting == {'not_arrived': 0, 'walking': 0, 'queued': 0, 'in_service': 0, 'done': 120}
    for events in result.events.values():
        exited = [event for event in events if event['kind'] == 'exited']
        assert len(exited) == 1
        assert any(Polygon(exit.poly).covers(Point(exited[0]['position'])) for exit in scene.exits)
        destination = next(event for event in events if event['kind'] == 'reached_destination')
        assert destination['time_s'] < exited[0]['time_s']
