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
from shapely.ops import unary_union
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
    """Queue starts at the head; waiting positions extend every 0.5 m to the tail.

    Explicit service positions define capacity; omitting them uses one server
    at the queue head.
    """

    queue_polyline: Annotated[list[Coordinate], Field(min_length=2)]
    service_positions: list[Coordinate] = Field(default_factory=list)
    service_s: Annotated[FiniteFloat, Field(gt=0)]
    overflow_area: PolygonRing | None = Field(
        default=None, description="Waiting region; omitted uses a 2 m box centered at the queue tail."
    )

    @model_validator(mode="after")
    def validate_queue(self) -> Self:
        line = LineString(self.queue_polyline)
        if line.length <= 0 or not line.is_simple:
            raise ValueError(f"Target {self.id}: queue must be nonzero and simple")
        return self


def effective_overflow_area(target: Target) -> list[list[float]]:
    """Return the explicit holding polygon or a deterministic 2 m tail box."""
    if target.overflow_area is not None:
        return [list(point) for point in target.overflow_area]
    x, y = target.queue_polyline[-1]
    return [[x - 1, y - 1], [x + 1, y - 1], [x + 1, y + 1], [x - 1, y + 1]]


class LayoutOption(Contract):
    """One permitted complete arrangement of a target and its movable obstacle."""

    id: Identifier
    target_id: Identifier
    obstacle_id: Identifier
    obstacle_poly: PolygonRing
    target_poly: PolygonRing
    service_positions: list[Coordinate]
    queue_polyline: Annotated[list[Coordinate], Field(min_length=2)]
    destinations: Annotated[list[Region], Field(min_length=1)]
    overflow_area: PolygonRing | None
    label: Annotated[str, Field(min_length=1)]


class Scene(Contract):
    """Walkable is the outer floor boundary; obstacles subtract solid regions."""

    units: Literal["m"]
    walkable: PolygonRing
    obstacles: list[Obstacle]
    destinations: Annotated[list[Region], Field(min_length=1)]
    entrances: Annotated[list[Region], Field(min_length=1)]
    exits: Annotated[list[Region], Field(min_length=1)]
    targets: Annotated[list[Target], Field(min_length=1)]
    walkways: list[Region]
    layout_options: list[LayoutOption] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_geometry(self) -> Self:
        floor = Polygon(self.walkable)
        regions = [
            *self.obstacles, *self.entrances, *self.exits,
            *self.targets, *self.walkways, *self.destinations,
        ]
        ids = [region.id for region in regions]
        if len(ids) != len(set(ids)):
            raise ValueError("Scene region IDs must be globally unique")
        for region in regions:
            if not floor.covers(Polygon(region.poly)):
                raise ValueError(f"Region {region.id} lies outside the walkable boundary")
        for opening in [*self.entrances, *self.exits]:
            if not Polygon(opening.poly).intersects(floor.boundary):
                raise ValueError(f"Entrance/exit {opening.id} must touch the walkable boundary")
        solids = [(obstacle.id, Polygon(obstacle.poly)) for obstacle in self.obstacles]
        accessible = floor.difference(unary_union([solid for _, solid in solids]))
        if accessible.is_empty or not isinstance(accessible, Polygon):
            raise ValueError("Walkable minus obstacles must be one connected region")
        option_ids = [option.id for option in self.layout_options]
        if len(option_ids) != len(set(option_ids)):
            raise ValueError("Layout option IDs must be unique")
        for option in self.layout_options:
            if option.target_id not in {target.id for target in self.targets}:
                raise ValueError(f"Layout option {option.id}: unknown target {option.target_id}")
            if option.obstacle_id not in {obstacle.id for obstacle in self.obstacles}:
                raise ValueError(f"Layout option {option.id}: unknown obstacle {option.obstacle_id}")
        for region in [
            *self.entrances, *self.exits, *self.targets, *self.walkways, *self.destinations,
        ]:
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
            overflow = Polygon(effective_overflow_area(target))
            if not floor.covers(overflow):
                raise ValueError(f"Target {target.id}: overflow area lies outside room")
            for obstacle_id, solid in solids:
                if overflow.intersection(solid).area > 0:
                    raise ValueError(f"Target {target.id}: overflow area hits {obstacle_id}")
            for entrance in self.entrances:
                if overflow.intersects(Polygon(entrance.poly)):
                    raise ValueError(f"Target {target.id}: overflow area hits entrance {entrance.id}")
            for other_target in self.targets:
                if (target.overflow_area is not None or other_target.id != target.id) and overflow.intersects(LineString(other_target.queue_polyline)):
                    raise ValueError(f"Target {target.id}: overflow area hits queue {other_target.id}")
                if any(overflow.covers(Point(p)) for p in other_target.service_positions):
                    raise ValueError(f"Target {target.id}: overflow area hits service position")
        return self


class Scenario(Contract):
    n_people: Annotated[int, Field(ge=1, strict=True)]
    arrival_window_s: Annotated[FiniteFloat, Field(gt=0)]
    arrival_pattern: Literal["front_loaded", "uniform", "waves"]
    seed: Annotated[int, Field(ge=0, strict=True)]
    horizon_s: Annotated[FiniteFloat, Field(gt=0)]
    mode: Literal["queue"]


class DensityGrid(Contract):
    """Row-major [y][x] cells, using full 0.25 m² cells even at room edges."""

    origin: Coordinate
    cell_size_m: Literal[0.5]
    mean_persons_m2: list[list[FiniteFloat]]
    max_persons_m2: list[list[FiniteFloat]]
    max_sustained_s: list[list[FiniteFloat]]
    bottleneck_cells: list[list[int]] = Field(description="[row, column] indices")


class Result(Contract):
    """Engine measurements and immutable-in-use presampled person records."""

    metrics: dict[str, FiniteFloat | None]
    accounting: dict[str, Annotated[int, Field(ge=0, strict=True)]]
    people: list[dict[str, JsonValue]]
    frames: str = Field(
        description="Base64 little-endian float32 [frame, person, xy], C order; NaN pairs mean absent."
    )
    frame_shape: Annotated[list[int], Field(min_length=3, max_length=3)]
    frame_dt_s: Literal[0.1]
    horizon_s: Annotated[FiniteFloat, Field(gt=0)]
    density_grid: DensityGrid
    events: dict[str, list[dict[str, JsonValue]]] = Field(
        description="Ordered events keyed by person ID."
    )
    diagnostics: list[dict[str, JsonValue]] = Field(
        default_factory=list, description="Deterministic queue and spawn diagnostics every 10 s."
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

    @model_validator(mode="after")
    def validate_frame_shape(self) -> Self:
        frames, people, coordinates = self.frame_shape
        if frames < 1 or people != len(self.people) or coordinates != 2:
            raise ValueError("frame_shape must be [frame_count, len(people), 2]")
        if len(base64.b64decode(self.frames)) != frames * people * coordinates * 4:
            raise ValueError("frames byte length does not match frame_shape")
        return self


SCENE_SCHEMA = Scene.model_json_schema()
SCENARIO_SCHEMA = Scenario.model_json_schema()
RESULT_SCHEMA = Result.model_json_schema()
