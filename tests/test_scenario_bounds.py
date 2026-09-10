import pytest
from pydantic import ValidationError

from crowd.schema import Scenario


def _scenario(**overrides):
    base = dict(n_people=120, arrival_window_s=600, arrival_pattern="uniform", seed=1, horizon_s=1800, mode="queue")
    return Scenario(**{**base, **overrides})


def test_scenario_accepts_demo_sizes():
    assert _scenario(n_people=1000, horizon_s=7200, arrival_window_s=7200, wave_count=50).n_people == 1000


@pytest.mark.parametrize(
    "field, value",
    [("n_people", 1001), ("horizon_s", 7201), ("arrival_window_s", 7201), ("wave_count", 51)],
)
def test_scenario_rejects_oversized_requests(field, value):
    with pytest.raises(ValidationError):
        _scenario(**{field: value})
