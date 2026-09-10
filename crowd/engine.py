"""Simulation boundary, independent of web and model clients."""

from crowd.schema import Result, Scenario, Scene


def run(scene: Scene, scenario: Scenario) -> Result:
    """Rehearse a validated layout with JuPedSim and deterministic measurements.

    Contract for milestone 2: a pure function with no I/O, FastAPI, OpenAI,
    wall-clock inputs, global random state, or mutation of its arguments.
    Presample the population once per scenario seed and reuse it unchanged
    across layout comparisons. JuPedSim moves people; deterministic engine
    code computes all metrics, accounting, trajectories, and per-person events
    through horizon_s in queue mode. Return base64 little-endian float32 frames
    and SHA-256 hashes of canonical scene/scenario JSON for provenance.
    Identical inputs must produce identical results. Never fabricate metrics
    or claim native steering unless that behavior has actually been implemented.
    """
    raise NotImplementedError("JuPedSim engine is scheduled for milestone 2")
