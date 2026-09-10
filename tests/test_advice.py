"""Astra prose may reference measurements but cannot supply displayed numbers."""

from pathlib import Path

import pytest

from crowd.advice import (
    Explanation, Interpretation, Proposals, assumption_receipt, materially_helped,
    measurement_context, qualitative_rationale, render_explanation, strict_schema,
)
from crowd.schema import Scenario, Scene


@pytest.fixture
def context():
    return measurement_context(
        {"mean_wait_s": 10, "max_wait_s": 20, "walkway_conflict_person_s": 100},
        {"mean_wait_s": 8, "max_wait_s": 15, "walkway_conflict_person_s": 25},
        {"done": 150}, {"done": 150},
    )


def test_explanation_substitutes_only_measured_numbers(context):
    output = render_explanation(
        "max_wait_s moved from {{baseline.max_wait_s}} to {{candidate.max_wait_s}}; "
        "walkway_conflict_person_s changed by {{delta.walkway_conflict_person_s}}.", context,
    )
    assert output == "max_wait_s moved from 20 to 15; walkway_conflict_person_s changed by -75."
    assert materially_helped(context)


@pytest.mark.parametrize("text,message", [
    ("max_wait_s changed by {{delta.max_wait_s}} with {{delta.unknown_metric}}.", "Unknown measurement token"),
    ("max_wait_s changed by {{other.max_wait_s}}.", "measurement tokens"),
    ("max_wait_s is 15 seconds.", "invented numbers"),
    ("max_wait_s fell by two seconds.", "invented numbers"),
    ("max_wait_s fell by twenty seconds to {{candidate.max_wait_s}}.", "invented numbers"),
    ("max_wait_s fell by ½ to {{candidate.max_wait_s}}.", "invented numbers"),
    ("max_wait_s improved while done is {{baseline.done}}.", "quantify a changed field"),
    ("The layout is safe; max_wait_s is {{candidate.max_wait_s}}.", "safety"),
    ("Layout safety is guaranteed; max_wait_s is {{candidate.max_wait_s}}.", "safety"),
    ("The layout is optimal; max_wait_s is {{candidate.max_wait_s}}.", "safety"),
    ("The layout is validated; max_wait_s is {{candidate.max_wait_s}}.", "safety"),
    ("Everything improved.", "name a metric field"),
    ("max_wait_s improved.", "quantify a changed field"),
])
def test_explanation_rejects_ungrounded_or_forbidden_output(context, text, message):
    with pytest.raises(ValueError, match=message):
        render_explanation(text, context)


def test_null_measurement_is_explicitly_unavailable(context):
    context["baseline"]["mean_wait_s"] = None
    context["candidate"]["mean_wait_s"] = None
    context["delta"]["mean_wait_s"] = None
    output = render_explanation(
        "max_wait_s changed by {{delta.max_wait_s}}; "
        "mean_wait_s is {{candidate.mean_wait_s}}.", context,
    )
    assert output == "max_wait_s changed by -5; mean_wait_s is unavailable."


def test_no_help_and_completion_loss_are_stated_plainly(context):
    context["candidate"]["done"] = 149
    context["delta"]["done"] = -1
    assert not materially_helped(context)
    assert render_explanation(
        "done changed by {{delta.done}} despite lower max_wait_s.", context,
    ).startswith("This candidate did not materially help. ")
    unchanged = measurement_context({"max_wait_s": 20}, {"max_wait_s": 20}, {"done": 150}, {"done": 150})
    assert not materially_helped(unchanged)
    assert render_explanation("No metric fields changed.", unchanged).startswith(
        "This candidate did not materially help. "
    )


@pytest.mark.parametrize("model", [Interpretation, Proposals, Explanation])
def test_strict_schema_has_no_optional_object_properties_or_extras(model):
    def visit(value):
        if isinstance(value, dict):
            assert "default" not in value
            if value.get("type") == "object":
                assert value["additionalProperties"] is False
                assert set(value["required"]) == set(value["properties"])
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(strict_schema(model))


@pytest.mark.parametrize("text", ["Add two staff", "Reduce wait by 5%", "A safe layout", "First line\nSecond line", ""])
def test_rationale_rejects_numbers_claims_and_multiple_lines(text):
    with pytest.raises(ValueError):
        qualitative_rationale(text)


@pytest.mark.parametrize("with_scene", [False, True])
def test_assumption_receipt_includes_all_chosen_parameters(with_scene):
    scenario = Scenario(n_people=150, arrival_window_s=600, arrival_pattern="front_loaded",
                        seed=1, horizon_s=1800, mode="queue")
    scene = Scene.model_validate_json(
        (Path(__file__).parent / "fixtures" / "sample_room.json").read_text()
    ) if with_scene else None
    receipt = assumption_receipt(Interpretation(scenario=scenario, scene=scene, assumptions=[]))
    for key, value in scenario.model_dump().items():
        assert f"{key} = {value}" in receipt
    if with_scene:
        assert "check_in: service_s = 12.0; staffing = 2." in receipt
        assert any(note.startswith("scene.walkable = ") for note in receipt)
        assert any(note.startswith("scene.targets[0].service_positions = ") for note in receipt)
    else:
        assert "Service time and staffing remain those in the currently loaded scene." in receipt


def test_rationale_is_plain_text_for_the_organizer():
    assert qualitative_rationale(
        "- **Move the `check_in_desk` east**\tso guests\u2019 walk \u2014 across central_walkway \u2014 is shorter."
    ) == "Move the check in desk east so guests' walk - across central walkway - is shorter."
    with pytest.raises(ValueError):
        qualitative_rationale("**")


def test_explanation_tolerates_markdown_and_spaced_tokens(context):
    output = render_explanation(
        "- `max_wait_s` fell from {{ baseline.max_wait_s }} to {{candidate. max_wait_s}} \u2013 "
        "**walkway_conflict_person_s** changed by {{delta.walkway_conflict_person_s}}.", context,
    )
    assert output == "max_wait_s fell from 20 to 15 - walkway_conflict_person_s changed by -75."
