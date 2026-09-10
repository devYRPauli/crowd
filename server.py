"""HTTP scaffold; simulation and model actions are intentionally unimplemented."""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from crowd.schema import Scene

ROOT = Path(__file__).resolve().parent
app = FastAPI(title="Crowd", version="0.1.0")


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
def run() -> None:
    raise HTTPException(status_code=501, detail="Simulation is scheduled for milestone 2")


@app.post("/api/interpret")
def interpret() -> None:
    raise HTTPException(status_code=501, detail="Brief interpretation is not implemented")


@app.post("/api/propose")
def propose() -> None:
    raise HTTPException(status_code=501, detail="Layout proposals are not implemented")


@app.post("/api/explain")
def explain() -> None:
    raise HTTPException(status_code=501, detail="Trade-off explanations are not implemented")
