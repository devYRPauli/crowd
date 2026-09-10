"""Local rehearsal API. Keep only the last completed run in this worker's memory."""

import base64
import json
from pathlib import Path
from threading import Lock
from uuid import uuid4

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, ConfigDict
from shapely.geometry import Polygon

from crowd.engine import run as simulate
from crowd.schema import Scenario, Scene

ROOT = Path(__file__).resolve().parent
app = FastAPI(title="Crowd", version="0.1.0")
_run_lock = Lock()
_runs: dict[str, tuple[dict, bytes, dict[str, str]]] = {}


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scene: Scene
    scenario: Scenario


def _viewer_events(result, scene: Scene) -> dict:
    """Annotate engine events; ahead means earlier joins still awaiting service.

    Same-time service starts precede joins; simultaneous joins break ties by
    person order. This count does not claim to measure spatial overtaking.
    """
    events = {}
    timeline = []
    destinations = {d.id: list(Polygon(d.poly).centroid.coords[0]) for d in scene.destinations}
    for index, person in enumerate(result.people):
        rows = [dict(row, target_id=person["target_id"]) for row in result.events[person["id"]]]
        events[person["id"]] = rows
        for row in rows:
            if row["kind"] in ("joined_queue", "service_start"):
                timeline.append((row["time_s"], row["kind"] == "joined_queue", index, person["id"], row))
            if row["kind"] == "seated":
                row["position"] = destinations[person["destination_id"]]
    waiting: dict[str, set[str]] = {}
    for _, _, _, person_id, row in sorted(timeline, key=lambda item: item[:3]):
        queue = waiting.setdefault(row["target_id"], set())
        if row["kind"] == "service_start":
            queue.discard(person_id)
        else:
            row["people_ahead"] = len(queue)
            queue.add(person_id)
    return events


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/api/scene", response_model=Scene)
def get_scene() -> Scene:
    return Scene.model_validate_json(
        (ROOT / "tests" / "fixtures" / "sample_room.json").read_text(encoding="utf-8")
    )


@app.post("/api/scene")
def save_scene(scene: Scene) -> None:
    raise HTTPException(status_code=501, detail="Scene persistence is not implemented")


@app.post("/api/run")
def run(request: RunRequest) -> dict:
    global _runs
    if not _run_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="A rehearsal is already running")
    try:
        try:
            result = simulate(request.scene, request.scenario)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        frames = np.frombuffer(base64.b64decode(result.frames), dtype="<f4").reshape(result.frame_shape)[::2]
        run_id = uuid4().hex
        summary = {
            "run_id": run_id, "metrics": result.metrics, "accounting": result.accounting,
            "events": _viewer_events(result, request.scene),
        }
        headers = {
            "X-Frame-Count": str(len(frames)), "X-Person-Count": str(len(result.people)),
            "X-Frame-Dt-S": "0.2",
            "X-Person-Ids": json.dumps([p["id"] for p in result.people], separators=(",", ":")),
            "Cache-Control": "no-store",
        }
        # Atomic replacement: readers can still fetch the old run while this one computes.
        _runs = {run_id: (summary, frames.tobytes(), headers)}
        return summary
    finally:
        _run_lock.release()


@app.get("/api/frames/{run_id}")
def get_frames(run_id: str) -> Response:
    cached = _runs.get(run_id)
    if cached is None:
        raise HTTPException(status_code=404, detail="Run not found; only the last completed run is retained")
    return Response(content=cached[1], media_type="application/octet-stream", headers=cached[2])


@app.post("/api/interpret")
def interpret() -> None:
    raise HTTPException(status_code=501, detail="Brief interpretation is not implemented")


@app.post("/api/propose")
def propose() -> None:
    raise HTTPException(status_code=501, detail="Layout proposals are not implemented")


@app.post("/api/explain")
def explain() -> None:
    raise HTTPException(status_code=501, detail="Trade-off explanations are not implemented")
