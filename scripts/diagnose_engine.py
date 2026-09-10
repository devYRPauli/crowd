"""Run the venue baseline and exact west-wall candidate; persist compact traces."""

import argparse
import copy
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from crowd.engine import run  # noqa: E402
from crowd.schema import Scenario, Scene  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


def west_wall_candidate(scene: dict) -> dict:
    """Change only the user-specified buffet, target, queue and destination."""
    candidate = copy.deepcopy(scene)
    buffet = next(item for item in candidate["obstacles"] if item["id"] == "buffet_table")
    buffet["poly"] = [[0, 2], [1.5, 2], [1.5, 7], [0, 7]]
    target = next(item for item in candidate["targets"] if item["id"] == "buffet")
    target.update(
        poly=[[1.5, 2], [2.5, 2], [2.5, 7], [1.5, 7]],
        service_positions=[[2, 4], [2, 5.5]],
        queue_polyline=[[2.65, 4.75], [2.65, 3.3], [18, 3.3], [21, 3.3], [21, 6.0]],
    )
    candidate["destinations"] = [{
        "id": "disperse",
        "poly": [[1.5, 1.0], [2.5, 1.0], [2.5, 1.75], [1.5, 1.75]],
    }]
    return candidate



def rush_utilization(trace: list[dict]) -> dict:
    """Estimate busy/rush fractions using left-endpoint 10 s trace intervals.

    Rush means the target has queued people (including overflow), not merely a
    reserved server. This is trace sampling, not exact dt=0.05 integration.
    """
    totals = {}
    for row, following in zip(trace, trace[1:]):
        dt = following["time_s"] - row["time_s"]
        for target_id, head in row["heads"].items():
            if head.get("queued_count", row["queue_length"]) <= 0:
                continue
            for service in head["services"]:
                key = f"{target_id}@{service['position'][0]:g},{service['position'][1]:g}"
                value = totals.setdefault(key, {"rush_s": 0.0, "busy_s": 0.0, "reserved_s": 0.0})
                value["rush_s"] += dt
                value["busy_s"] += dt * (service["state"] == "in_service")
                value["reserved_s"] += dt * (service["state"] != "free")
    return {"method": "left-endpoint trace sampling (10 s)", "positions": {
        key: {**value, "busy_fraction": value["busy_s"] / value["rush_s"]}
        for key, value in totals.items()
    }}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", default="engine_trace")
    parser.add_argument("--scene", type=Path, default=ROOT / "data/venue.json")
    parser.add_argument("--candidate", type=Path, help="Use an explicit candidate JSON instead of the v1 west-wall transform")
    args = parser.parse_args()
    if not args.prefix or Path(args.prefix).name != args.prefix:
        parser.error("--prefix must be a filename prefix, not a path")
    raw = json.loads(args.scene.read_text())
    scenario = Scenario(
        n_people=150, arrival_window_s=600, arrival_pattern="front_loaded",
        seed=1, horizon_s=1800, mode="queue",
    )
    candidate = json.loads(args.candidate.read_text()) if args.candidate else west_wall_candidate(raw)
    for name, layout in [("baseline", raw), ("candidate", candidate)]:
        print(f"Running {name} ...", flush=True)
        started = time.perf_counter()
        result = run(Scene.model_validate(layout), scenario)
        wall_s = round(time.perf_counter() - started, 3)
        trace = result.diagnostics
        if not trace:
            raise RuntimeError("Engine returned no diagnostic trace")
        path = ROOT / "data" / f"{args.prefix}_{name}.jsonl"
        path.write_text("".join(json.dumps(record, sort_keys=True) + "\n" for record in trace))
        worst = max(trace, key=lambda record: record["stuck_count"])
        summary = {
            "trace_file": str(path.relative_to(ROOT)),
            "rush_utilization": rush_utilization(trace),
            "trace_samples": len(trace),
            "max_queue_length": max(record["queue_length"] for record in trace),
            "max_in_service": max(record["in_service"] for record in trace),
            "final_heads": trace[-1]["heads"],
            "queued_with_no_service_samples": sum(
                record["queue_length"] > 0 and record["in_service"] == 0
                for record in trace
            ),
            "max_stuck": worst["stuck_count"],
            "max_stalled_service_approaches": max(len(record.get("stalled_service_approaches", [])) for record in trace),
            "handoff_routed": sum(event["kind"] == "handoff_routed" for events in result.events.values() for event in events),
            "handoff_route_unavailable": sum(event["kind"] == "handoff_route_unavailable" for events in result.events.values() for event in events),
            "worst_stuck_time_s": worst["time_s"],
            "worst_stuck_clusters_2m": worst["stuck_clusters_2m"],
            "final_spawn_rejections": trace[-1]["spawn_rejections"],
        }
        print(f"TRACE {name} {json.dumps(summary, sort_keys=True)}", flush=True)
        print(f"FINAL {name} {json.dumps({'metrics': result.metrics, 'accounting': result.accounting, 'wall_s': wall_s}, sort_keys=True)}", flush=True)


if __name__ == "__main__":
    main()
