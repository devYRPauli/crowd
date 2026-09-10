"""Apply a named arrangement atomically, then validate the complete scene."""

from crowd.schema import Scene


def apply_layout_option(scene: Scene, option_id: str) -> Scene:
    """Return an independent validated scene, preserving IDs and service duration.

    Locked obstacles cannot be moved even by a declared option. Option metadata
    remains available on the result so another option can be selected later.
    """
    option = next((item for item in scene.layout_options if item.id == option_id), None)
    if option is None:
        raise ValueError(f"Unknown layout option: {option_id}")
    data = scene.model_dump()
    obstacle = next(item for item in data["obstacles"] if item["id"] == option.obstacle_id)
    if obstacle["locked"] and obstacle["poly"] != option.obstacle_poly:
        raise ValueError(f"Layout option {option_id} moves locked obstacle {option.obstacle_id}")
    obstacle["poly"] = option.obstacle_poly
    target = next(item for item in data["targets"] if item["id"] == option.target_id)
    target.update(
        poly=option.target_poly,
        service_positions=option.service_positions,
        queue_polyline=option.queue_polyline,
        overflow_area=option.overflow_area,
    )
    data["destinations"] = [region.model_dump() for region in option.destinations]
    return Scene.model_validate(data)
