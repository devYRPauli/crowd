"""Measure POST-to-visible proposal latency against the running local server."""

import argparse
import json
import time
from pathlib import Path
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scene", default="data/venue_v3.json")
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument("--constraints", default="Keep two volunteers and the dining tables. Reduce queue conflict with the walkways.")
    args = parser.parse_args()

    def request(path, body=None):
        encoded = None if body is None else json.dumps(body).encode()
        with urlopen(Request(args.url + path, data=encoded,
                             headers={"Content-Type": "application/json"}), timeout=300) as response:
            return json.load(response)

    scene = json.loads(Path(args.scene).read_text())
    scenario = dict(n_people=150, arrival_window_s=600, arrival_pattern="front_loaded",
                    seed=1, horizon_s=1800, mode="queue")
    baseline_start = time.perf_counter()
    baseline = request("/api/run", {"scene": scene, "scenario": scenario})
    baseline_s = time.perf_counter() - baseline_start
    started = time.perf_counter()
    job = request("/api/propose", {"scene": scene, "scenario": scenario,
                                  "baseline_metrics": baseline["metrics"],
                                  "baseline_accounting": baseline["accounting"],
                                  "constraints": args.constraints})
    post_s = time.perf_counter() - started
    previous = None
    while time.perf_counter() - started < 300:
        result = request(f"/api/propose/{job['job_id']}")
        if result["stage"] != previous:
            print(f"{time.perf_counter() - started:.3f}s {result['stage']}", flush=True)
            previous = result["stage"]
        if result["status"] in {"completed", "error"}:
            elapsed = time.perf_counter() - started
            print(json.dumps({"scene": args.scene, "baseline_wall_s": round(baseline_s, 3),
                              "post_wall_s": round(post_s, 3), "candidates_visible_wall_s": round(elapsed, 3),
                              "status": result["status"], "candidate_count": len(result.get("candidates", [])),
                              "baseline_metrics": baseline["metrics"], "baseline_accounting": baseline["accounting"],
                              "candidates": [{"index": c["index"], "metrics": c["metrics"],
                                              "accounting": c["accounting"], "comparison": c["comparison"]}
                                             for c in result.get("candidates", [])],
                              "rejected": result.get("rejected", []), "error": result.get("error")}, indent=2))
            if result["status"] == "error" or not result.get("candidates"):
                raise SystemExit(1)
            return
        time.sleep(1)
    raise TimeoutError("Proposal job did not finish within 300 seconds")


if __name__ == "__main__":
    main()
