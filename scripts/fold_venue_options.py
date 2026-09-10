"""Fold the user's local venue pairs into validated named-option scene files."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from crowd.layouts import apply_layout_option  # noqa: E402
from crowd.schema import Scene  # noqa: E402


def fold(first: Path, second: Path, output: Path, names: tuple[str, str], labels: tuple[str, str]):
    scenes = [Scene.model_validate_json(path.read_text()) for path in (first, second)]
    original = scenes[0].model_dump(mode="json")
    options = []
    for scene, name, label in zip(scenes, names, labels):
        target = scene.targets[0]
        obstacle = next(item for item in scene.obstacles if not item.locked and item.kind in {"desk", "buffet"})
        options.append(dict(id=name, label=label, target_id=target.id, obstacle_id=obstacle.id,
                            obstacle_poly=obstacle.poly, target_poly=target.poly,
                            service_positions=target.service_positions, queue_polyline=target.queue_polyline,
                            destinations=[item.model_dump(mode="json") for item in scene.destinations],
                            overflow_area=target.overflow_area))
    original["layout_options"] = options
    folded = Scene.model_validate(original)
    for source, name in zip(scenes, names):
        applied = apply_layout_option(folded, name).model_dump(mode="json")
        applied.pop("layout_options")
        expected = source.model_dump(mode="json")
        expected.pop("layout_options")
        if applied != expected:
            raise ValueError(f"{name}: source differs outside permitted layout-option fields")
    output.write_text(json.dumps(folded.model_dump(mode="json"), indent=2) + "\n")
    print(f"{output}: validated {', '.join(names)}, default={names[0]}")


if __name__ == "__main__":
    data = Path(__file__).resolve().parents[1] / "data"
    fold(data / "venue_v3.json", data / "venue_v3_south.json", data / "venue_v3_options.json",
         ("line_in_aisle", "line_south_corridor"), ("Line in the central aisle", "Line along the south corridor"))
    fold(data / "venue_v1.json", data / "venue_v1_west.json", data / "venue_v1_options.json",
         ("buffet_east", "buffet_west"), ("Buffet on the east wall", "Buffet on the west wall"))
