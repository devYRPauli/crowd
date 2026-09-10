"""Shared contracts. Coordinates are [x, y] in metres; rings may be unclosed."""

import base64
import binascii
from typing import Annotated, Literal, Self

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    FiniteFloat,
    JsonValue,
    field_validator,
    model_validator,
)
from shapely.geometry import LineString, Point, Polygon
from shapely.validation import explain_validity

Coordinate = Annotated[list[FiniteFloat], Field(min_length=2, max_length=2)]


def _valid_polygon(points: list[list[float]]) -> list[list[float]]:
    polygon = Polygon(points)
    if not polygon.is_valid or polygon.area <= 0:
        raise ValueError(f"Invalid polygon: {explain_validity(polygon)}")
    return points


PolygonRing = Annotated[
    list[Coordinate], Field(min_length=3), AfterValidator(_valid_polygon)
]
Identifier = Annotated[str, Field(min_length=1)]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Region(Contract):
    id: Identifier
    poly: PolygonRing


class Obstacle(Region):
    kind: Identifier
    locked: bool


class Target(Region):
    """Queue runs from its tail to its head; service positions are agent centres."""

    queue_polyline: Annotated[list[Coordinate], Field(min_length=2)]
    service_positions: Annotated[list[Coordinate], Field(min_length=1)]
    service_s: Annotated[FiniteFloat, Field(gt=0)]

    @model_validator(mode="after")
    def validate_queue(self) -> Self:
        line = LineString(self.queue_polyline)
        if line.length <= 0 or not line.is_simple:
            raise ValueError(f"Target {self.id}: queue must be nonzero and simple")
        return self


class Scene(Contract):
    """Walkable is the outer floor boundary; obstacles subtract solid regions."""

    units: Literal["m"]
    walkable: PolygonRing
    obstacles: list[Obstacle]
    entrances: Annotated[list[Region], Field(min_length=1)]
    exits: Annotated[list[Region], Field(min_length=1)]
    targets: Annotated[list[Target], Field(min_length=1)]
    walkways: list[Region]

    @model_validator(mode="after")
    def validate_geometry(self) -> Self:
        floor = Polygon(self.walkable)
        regions = [
            *self.obstacles, *self.entrances, *self.exits,
            *self.targets, *self.walkways,
        ]
        ids = [region.id for region in regions]
        if len(ids) != len(set(ids)):
            raise ValueError("Scene region IDs must be globally unique")
        for region in regions:
            if not floor.covers(Polygon(region.poly)):
                raise ValueError(f"Region {region.id} lies outside the walkable boundary")
        solids = [(obstacle.id, Polygon(obstacle.poly)) for obstacle in self.obstacles]
        for region in [*self.entrances, *self.exits, *self.targets, *self.walkways]:
            for obstacle_id, solid in solids:
                if Polygon(region.poly).intersection(solid).area > 0:
                    raise ValueError(f"Region {region.id} overlaps obstacle {obstacle_id}")
        for target in self.targets:
            geometry = [LineString(target.queue_polyline)]
            geometry.extend(Point(position) for position in target.service_positions)
            for item in geometry:
                if not floor.covers(item):
                    raise ValueError(f"Target {target.id}: queue/service lies outside room")
                for obstacle_id, solid in solids:
                    if item.intersects(solid):
                        raise ValueError(f"Target {target.id}: queue/service hits {obstacle_id}")
            if not all(Polygon(target.poly).covers(Point(p)) for p in target.service_positions):
                raise ValueError(f"Target {target.id}: service positions must lie in target")
        return self


class Scenario(Contract):
    n_people: Annotated[int, Field(ge=1, strict=True)]
    arrival_window_s: Annotated[FiniteFloat, Field(gt=0)]
    arrival_pattern: Literal["front_loaded", "uniform"]
    seed: Annotated[int, Field(ge=0, strict=True)]
    horizon_s: Annotated[FiniteFloat, Field(gt=0)]
    mode: Literal["queue"]


class Result(Contract):
    """Engine-only output; person/event record fields will be set in milestone 2."""

    metrics: dict[str, FiniteFloat | None]
    accounting: dict[str, Annotated[int, Field(ge=0, strict=True)]]
    people: list[dict[str, JsonValue]]
    frames: str = Field(
        description="Base64-encoded little-endian float32 buffer; frame layout is set by the engine milestone."
    )
    events: dict[str, list[dict[str, JsonValue]]] = Field(
        description="Ordered events keyed by person ID."
    )
    scene_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    scenario_hash: str = Field(pattern=r"^[0-9a-f]{64}$")

    @field_validator("frames")
    @classmethod
    def validate_frames(cls, value: str) -> str:
        try:
            raw = base64.b64decode(value, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError("frames must be valid base64") from exc
        if len(raw) % 4:
            raise ValueError("frames must contain whole float32 values")
        return value


SCENE_SCHEMA = Scene.model_json_schema()
SCENARIO_SCHEMA = Scenario.model_json_schema()
RESULT_SCHEMA = Result.model_json_schema()
