"""Pure JuPedSim rehearsal, deterministic sampling, scheduling, and measurement.

No I/O, web/model clients, global RNG, or writes to caller-owned inputs.
Native stages route all movement; agents are never teleported or directly steered.
"""

import base64
import hashlib
import heapq
import json
import math
from dataclasses import dataclass, field

import jupedsim as jps
import numpy as np
from shapely import intersects_xy
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import nearest_points, unary_union

from crowd.schema import DensityGrid, Result, Scenario, Scene, effective_overflow_area

DT = 0.05
FRAME_DT = 0.1
RADIUS = 0.2
REACHED_M = 0.35
QUEUE_SPACING_M = 0.5
CELL_SIZE_M = 0.5


def fifo_schedule(arrival_times: list[float], service_times: list[float], k: int) -> list[float]:
    """Return FIFO waits in input order, breaking arrival ties by index.

    This pure arithmetic has no geometry and never substitutes for integrated
    waits. Each server remains occupied for the person's full service duration.
    """
    if isinstance(k, bool) or not isinstance(k, int) or k < 1:
        raise ValueError("k must be a positive integer")
    if len(arrival_times) != len(service_times):
        raise ValueError("Arrival and service lists must have equal length")
    if any(not math.isfinite(t) or t < 0 for t in [*arrival_times, *service_times]):
        raise ValueError("Arrival and service times must be finite and nonnegative")
    available = [(0.0, slot) for slot in range(k)]
    waits = [0.0] * len(arrival_times)
    for person in sorted(range(len(waits)), key=lambda i: (arrival_times[i], i)):
        free_at, slot = heapq.heappop(available)
        start = max(arrival_times[person], free_at)
        waits[person] = start - arrival_times[person]
        heapq.heappush(available, (start + service_times[person], slot))
    return waits


def waiting_positions(polyline: list[list[float]]) -> list[tuple[float, float]]:
    """Sample every 0.5 m from head to tail, including the head.

    A fractional final interval is omitted rather than adding a too-close slot.
    """
    line = LineString(polyline)
    return [
        tuple(line.interpolate(i * QUEUE_SPACING_M).coords[0])
        for i in range(math.floor(line.length / QUEUE_SPACING_M + 1e-9) + 1)
    ]


def presample_people(scene: Scene, scenario: Scenario) -> list[dict]:
    """One local RNG batch, reused verbatim throughout a run.

    Layout-only changes regenerate identical records; compare checks full record
    equality. Service-time changes intentionally invalidate that equality. Region
    choices depend on IDs, never coordinates. Front-loaded places round(0.7*N)
    arrivals in the first half, shuffled across IDs. Waves use five batches as
    evenly sized as possible at 0, window/5, ..., 4*window/5, shuffled across IDs.
    """
    rng = np.random.default_rng(scenario.seed)
    n = scenario.n_people
    if scenario.arrival_pattern == "front_loaded":
        early = round(0.7 * n)
        arrivals = np.concatenate([
            rng.uniform(0, scenario.arrival_window_s / 2, early),
            rng.uniform(scenario.arrival_window_s / 2, scenario.arrival_window_s, n - early),
        ])
        rng.shuffle(arrivals)
    elif scenario.arrival_pattern == "waves":
        batches = np.repeat(np.arange(5), [n // 5 + (i < n % 5) for i in range(5)])
        arrivals = batches * (scenario.arrival_window_s / 5)
        rng.shuffle(arrivals)
    else:
        arrivals = rng.uniform(0, scenario.arrival_window_s, n)
    speeds = np.clip(rng.normal(1.2, 0.2, n), 0.6, 1.8)
    service_noise = rng.normal(0, 1, n)
    spawn_choices = rng.random(n)
    entrances = sorted(scene.entrances, key=lambda item: item.id)
    targets = sorted(scene.targets, key=lambda item: item.id)
    destinations = sorted(scene.destinations, key=lambda item: item.id)
    people = []
    for i in range(n):
        target = targets[i % len(targets)]
        people.append({
            "id": f"p{i}", "arrival_s": float(arrivals[i]),
            "preferred_speed_m_s": float(speeds[i]),
            "service_s": max(3.0, float(target.service_s * (1 + 0.2 * service_noise[i]))),
            "entrance_id": entrances[i % len(entrances)].id,
            "target_id": target.id,
            "destination_id": destinations[i % len(destinations)].id,
            "spawn_choice": float(spawn_choices[i]),
        })
    return people


def _validated_people(scene: Scene, scenario: Scenario, people: list[dict], *, check_window=True) -> list[dict]:
    """Copy supplied records after checking the same population contract as sampling."""
    fields = {"id", "arrival_s", "preferred_speed_m_s", "service_s", "entrance_id",
              "target_id", "destination_id", "spawn_choice"}
    if not isinstance(people, list) or len(people) != scenario.n_people:
        raise ValueError("Presampled people count must equal scenario.n_people")
    references = {
        "entrance_id": {item.id for item in scene.entrances},
        "target_id": {item.id for item in scene.targets},
        "destination_id": {item.id for item in scene.destinations},
    }
    copied, ids = [], set()
    for index, person in enumerate(people):
        if not isinstance(person, dict) or set(person) != fields:
            raise ValueError(f"Presampled person {index}: unexpected or missing fields")
        identifier = person["id"]
        if not isinstance(identifier, str) or not identifier.strip() or identifier in ids:
            raise ValueError(f"Presampled person {index}: IDs must be unique nonempty strings")
        ids.add(identifier)
        for key, choices in references.items():
            if not isinstance(person[key], str) or person[key] not in choices:
                raise ValueError(f"Presampled person {identifier}: unknown {key}")
        for key in ("arrival_s", "preferred_speed_m_s", "service_s", "spawn_choice"):
            value = person[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"Presampled person {identifier}: {key} must be a finite number")
        if person["arrival_s"] < 0 or (check_window and person["arrival_s"] > scenario.arrival_window_s):
            raise ValueError(f"Presampled person {identifier}: arrival_s is outside the arrival window")
        if not 0.6 <= person["preferred_speed_m_s"] <= 1.8:
            raise ValueError(f"Presampled person {identifier}: preferred_speed_m_s must be in [0.6, 1.8]")
        if person["service_s"] < 3:
            raise ValueError(f"Presampled person {identifier}: service_s must be at least 3 seconds")
        if not 0 <= person["spawn_choice"] < 1:
            raise ValueError(f"Presampled person {identifier}: spawn_choice must be in [0, 1)")
        copied.append(dict(person))
    return copied


def reschedule_people(scene: Scene, scenario: Scenario, people: list[dict]) -> list[dict]:
    """Change only arrival times, preserving the original ordered person records.

    Arrival draws follow the new scenario's seed and pattern. Speeds, service
    durations, region choices, and spawn choices remain exactly as supplied.
    """
    scene = Scene.model_validate(scene.model_dump())
    scenario = Scenario.model_validate(scenario.model_dump())
    copied = _validated_people(scene, scenario, people, check_window=False)
    for person, sampled in zip(copied, presample_people(scene, scenario)):
        person["arrival_s"] = sampled["arrival_s"]
    return _validated_people(scene, scenario, copied)


def _hash(model: Scene | Scenario) -> str:
    canonical = json.dumps(model.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


@dataclass
class _Server:
    position: tuple[float, float]
    stage: int
    journeys: dict[str, int]
    agent: int | None = None
    end_s: float | None = None
    dispatched_s: float | None = None
    busy_rush_s: float = 0.0


@dataclass
class _Holding:
    position: tuple[float, float]
    stage: int
    journey: int
    agent: int | None = None


@dataclass
class _Queue:
    positions: list[tuple[float, float]]
    approach: int
    stage: int
    journey: int
    servers: list[_Server] = field(default_factory=list)
    assigned: set[int] = field(default_factory=set)
    holding: list[_Holding] = field(default_factory=list)
    overflow_fifo: list[int] = field(default_factory=list)
    rush_s: float = 0.0


class _Density:
    """Fixed-grid left-endpoint integration with consecutive threshold exposure."""

    def __init__(self, bounds: tuple[float, float, float, float]):
        x0, y0, x1, y1 = bounds
        self.origin = (x0, y0)
        self.shape = (math.ceil((y1 - y0) / CELL_SIZE_M), math.ceil((x1 - x0) / CELL_SIZE_M))
        self.integral = np.zeros(self.shape)
        self.peak = np.zeros(self.shape)
        self.streak = np.zeros(self.shape)
        self.longest = np.zeros(self.shape)

    def update(self, positions: np.ndarray, dt: float) -> None:
        counts = np.zeros(self.shape)
        if len(positions):
            indices = np.floor((positions - self.origin) / CELL_SIZE_M).astype(int)
            columns = np.clip(indices[:, 0], 0, self.shape[1] - 1)
            rows = np.clip(indices[:, 1], 0, self.shape[0] - 1)
            np.add.at(counts, (rows, columns), 1)
        density = counts / CELL_SIZE_M**2
        self.integral += density * dt
        self.peak = np.maximum(self.peak, density)
        self.streak = np.where(density > 3, self.streak + dt, 0)
        self.longest = np.maximum(self.longest, self.streak)

    def result(self, horizon_s: float) -> DensityGrid:
        return DensityGrid(
            origin=list(self.origin), cell_size_m=CELL_SIZE_M,
            mean_persons_m2=(self.integral / horizon_s).tolist(),
            max_persons_m2=self.peak.tolist(),
            max_sustained_s=np.round(self.longest, 9).tolist(),
            bottleneck_cells=np.argwhere(self.longest > 10 + 1e-9).tolist(),
        )


def _spawn_positions(entrance: Polygon, safe_floor: Polygon) -> list[tuple[float, float]]:
    area = entrance.intersection(safe_floor)
    if area.is_empty or area.area <= 0:
        raise ValueError("Entrance has no space for an agent with radius 0.2 m")
    x0, y0, x1, y1 = area.bounds
    candidates = [tuple(area.representative_point().coords[0])]
    for y in np.arange(y0, y1 + 1e-9, 0.45):
        for x in np.arange(x0, x1 + 1e-9, 0.45):
            point = (float(x), float(y))
            if area.covers(Point(point)) and entrance.contains(Point(point)):
                candidates.append(point)
    return candidates


def _build_queues(sim: jps.Simulation, scene: Scene, safe_floor: Polygon, seats: dict) -> dict[str, _Queue]:
    queues = {}
    for target in sorted(scene.targets, key=lambda item: item.id):
        positions = waiting_positions(target.queue_polyline)
        services = [tuple(p) for p in target.service_positions] or positions[:1]
        # Leading queue slots used as service positions are reserved for service.
        while positions and any(math.dist(positions[0], p) < 1e-9 for p in services):
            positions = positions[1:]
        if not positions:
            raise ValueError(f"Target {target.id}: queue needs a waiting position behind service")
        for p in [*positions, *services]:
            if not safe_floor.covers(Point(p)):
                raise ValueError(f"Target {target.id}: position {p} lacks agent clearance")
        if any(math.dist(a, b) < 2 * RADIUS for i, a in enumerate(services) for b in services[i + 1:]):
            raise ValueError(f"Target {target.id}: service positions overlap")
        if any(math.dist(a, b) < 2 * RADIUS for a in positions for b in services):
            raise ValueError(f"Target {target.id}: waiting and service positions overlap")
        approach = sim.add_waypoint_stage(positions[-1], 0.6)
        stage = sim.add_queue_stage(positions)
        handoff = sim.add_waypoint_stage(positions[0], REACHED_M)
        journey = jps.JourneyDescription([approach, stage, handoff])
        journey.set_transition_for_stage(approach, jps.Transition.create_fixed_transition(stage))
        journey.set_transition_for_stage(stage, jps.Transition.create_fixed_transition(handoff))
        queue = _Queue(positions, approach, stage, sim.add_journey(journey))
        for position in services:
            service_stage = sim.add_queue_stage([position])
            journeys = {}
            for destination, (seat_stage, _) in seats.items():
                description = jps.JourneyDescription([service_stage, seat_stage])
                description.set_transition_for_stage(service_stage, jps.Transition.create_fixed_transition(seat_stage))
                journeys[destination] = sim.add_journey(description)
            queue.servers.append(_Server(position, service_stage, journeys))
        area = Polygon(effective_overflow_area(target)).buffer(-RADIUS - 0.05).intersection(safe_floor)
        if target.overflow_area is None:
            # A default box straddles its own tail. Reserve holding positions
            # clear of the polyline and service bodies, preserving native slots.
            area = area.difference(LineString(target.queue_polyline).buffer(2 * RADIUS + 0.03))
            area = area.difference(unary_union([
                Point(position).buffer(2 * RADIUS + 0.03) for position in services
            ]))
        if area.is_empty:
            raise ValueError(f"Target {target.id}: overflow_area has no safe holding positions")
        x0, y0, x1, y1 = area.bounds
        candidates = [(float(x), float(y)) for y in np.arange(y0, y1 + 1e-9, 0.65)
                      for x in np.arange(x0, x1 + 1e-9, 0.65) if area.covers(Point(x, y))]
        # Fill nearest the overflow exit first, leaving later arrivals behind.
        candidates.sort(key=lambda p: (math.dist(p, positions[-1]), p))
        if not candidates:
            raise ValueError(f"Target {target.id}: overflow_area has no safe holding positions")
        for position in candidates:
            holding_stage = sim.add_queue_stage([position])
            description = jps.JourneyDescription([holding_stage, approach])
            description.set_transition_for_stage(holding_stage, jps.Transition.create_fixed_transition(approach))
            queue.holding.append(_Holding(position, holding_stage, sim.add_journey(description)))
        queues[target.id] = queue
    return queues



def _handoff_waypoints(floor: Polygon, start: tuple, goal: tuple, waiting: list) -> list | None:
    """Clearanced native route around the current queue, never a position edit.

    A distant native head can be assigned ahead of agents it has not physically
    passed. Routing directly to service can then pin it against a solid corner
    behind those agents. Treat their current bodies as temporary route exclusions.
    JuPedSim still integrates movement/collisions on the unchanged scene floor.
    """
    bodies = unary_union([Point(p).buffer(2 * RADIUS, quad_segs=3) for p in waiting])
    route_floor = floor.buffer(-RADIUS - 0.01, quad_segs=3).difference(bodies)
    parts = [route_floor] if route_floor.geom_type == "Polygon" else list(route_floor.geoms)
    component = next((p for p in parts if p.geom_type == "Polygon"
                      and p.contains(Point(start)) and p.contains(Point(goal))), None)
    if component is None:
        return None
    return jps.RoutingEngine(component).compute_waypoints(start, goal)[1:-1]


def run(scene: Scene, scenario: Scenario, *, people: list[dict] | None = None) -> Result:
    """Rehearse at dt=0.05, saving frames at t=0, 0.1, ... <= horizon.

    Supplied people are validated and copied; omitted people use the scenario seed.
    Main queue capacity is reserved before entry; native slots run head to tail.
    A free server releases the assigned head immediately, then service begins
    only on physical arrival within 0.35 m. Queue pop is applied by iterate before
    switching journeys, preventing stale queue membership and re-queueing.
    Overflow reserves separated holding slots in its region or default tail box;
    promotion follows arrival order as soon as a main queue slot is available,
    including people still approaching their overflow reservation. Full holding
    capacity delays spawning outside the room. Every step retries pending arrivals;
    blocked entrance samples fall back to the nearest free point within 1 m.
    Watchdogs route stalled agents through native waypoints without moving them
    directly or changing service capacity or native FIFO reservations.

    Waits include queue movement and travel to service. Mean/max cover started
    services only; censored waits and total waiting exposure are separate.
    overflow_count counts distinct people requesting a position when all slots
    are reserved. Delayed spawns remain not_arrived until physically admitted.
    Events occur on dt boundaries; a fractional final dt measures the last state
    without stepping past the horizon. Frames use NaN pairs for absent people.
    """
    scene = Scene.model_validate(scene.model_dump())
    scenario = Scenario.model_validate(scenario.model_dump())
    people = presample_people(scene, scenario) if people is None else _validated_people(scene, scenario, people)
    floor = Polygon(scene.walkable).difference(unary_union([Polygon(o.poly) for o in scene.obstacles]))
    if floor.geom_type != "Polygon" or floor.is_empty:
        raise ValueError("Simulation requires one connected polygon after subtracting obstacles")
    safe_floor = floor.buffer(-RADIUS - 0.01)
    sim = jps.Simulation(model=jps.CollisionFreeSpeedModel(), geometry=floor, dt=DT)
    seats = {}
    for destination in sorted(scene.destinations, key=lambda item: item.id):
        polygon = Polygon(destination.poly)
        center = polygon.centroid
        if not polygon.covers(center) or not safe_floor.covers(center):
            raise ValueError(f"Destination {destination.id}: centroid is not safely walkable")
        position = tuple(center.coords[0])
        seats[destination.id] = (sim.add_waypoint_stage(position, REACHED_M), position)
    queues = _build_queues(sim, scene, safe_floor, seats)
    spawn_positions = {
        entrance.id: _spawn_positions(Polygon(entrance.poly), safe_floor)
        for entrance in scene.entrances
    }
    spawn_fallbacks = {
        entrance.id: Polygon(entrance.poly).buffer(1.0).intersection(safe_floor)
        for entrance in scene.entrances
    }
    walkways = unary_union([Polygon(w.poly) for w in scene.walkways])
    n = scenario.n_people
    states = ["not_arrived"] * n
    events = {p["id"]: [] for p in people}
    agent_person = {}
    pending_dispatch = {}
    joined = {}
    waits = []
    overflow = set()
    delayed = set()
    spawn_delay = 0.0
    native_spawn_rejections = 0
    fallback_spawns = 0
    spawn_reasons = {"occupied": 0, "native_collision": 0, "capacity": 0, "fifo_predecessor": 0}
    diagnostics = []
    conflict_person_s = 0.0
    queue_wait_person_s = 0.0
    arrival_order = sorted(range(n), key=lambda i: (people[i]["arrival_s"], i))
    awaiting_spawn = []
    next_arrival = 0
    step_count = math.floor(scenario.horizon_s / DT + 1e-9)
    frame_count = math.floor(scenario.horizon_s / FRAME_DT + 1e-9) + 1
    frames = np.full((frame_count, n, 2), np.nan, dtype="<f4")
    density = _Density(floor.bounds)

    def event(person: int, kind: str, time_s: float, **details) -> None:
        events[people[person]["id"]].append({"kind": kind, "time_s": round(time_s, 9), **details})

    for step in range(step_count + 1):
        time_s = round(step * DT, 9)
        interval = min(DT, max(0.0, scenario.horizon_s - time_s))
        agents = {agent.id: agent for agent in sim.agents()}
        for agent_id, (journey, stage) in pending_dispatch.items():
            sim.switch_agent_journey(agent_id, journey, stage)
        pending_dispatch.clear()

        for queue in queues.values():
            for server in queue.servers:
                if server.agent is None:
                    continue
                person = agent_person[server.agent]
                if server.end_s is None:
                    native = sim.get_stage(server.stage)
                    if server.agent in native.enqueued() and math.dist(agents[server.agent].position, server.position) <= REACHED_M:
                        server.end_s = time_s + people[person]["service_s"]
                        states[person] = "in_service"
                        waits.append(time_s - joined[person])
                        event(
                            person, "service_start", time_s,
                            position=list(agents[server.agent].position),
                            service_position=list(server.position),
                        )
                elif time_s + 1e-9 >= server.end_s:
                    native = sim.get_stage(server.stage)
                    if native.enqueued() != [server.agent]:
                        raise RuntimeError("Service queue occupant differs from reserved person")
                    native.pop(1)
                    states[person] = "walking"
                    event(person, "service_end", time_s)
                    server.agent = None
                    server.end_s = None

        for agent_id, agent in agents.items():
            person = agent_person[agent_id]
            seat_stage, center = seats[people[person]["destination_id"]]
            if agent.stage_id == seat_stage and math.dist(agent.position, center) <= REACHED_M:
                states[person] = "done"
                event(person, "seated", time_s)
                sim.mark_agent_for_removal(agent_id)

        while next_arrival < n and people[arrival_order[next_arrival]]["arrival_s"] <= time_s + 1e-9:
            awaiting_spawn.append(arrival_order[next_arrival])
            next_arrival += 1
        # Promote at most one FIFO overflow occupant per target per step. A pop
        # must pass through iterate before switching out of a native queue.
        for queue in queues.values():
            if queue.overflow_fifo and len(queue.assigned) < len(queue.positions):
                first = queue.overflow_fifo[0]
                hold = next(h for h in queue.holding if h.agent == first)
                native = sim.get_stage(hold.stage)
                if first in agents:
                    if first in native.enqueued():
                        native.pop(1)
                        pending_dispatch[first] = (queue.journey, queue.approach)
                    else:
                        # The oldest overflow person may be blocked short of
                        # their reserved holding coordinate. Free main capacity
                        # is permission to advance, not to finish that detour.
                        sim.switch_agent_journey(first, queue.journey, queue.approach)
                    queue.assigned.add(first)
                    queue.overflow_fifo.pop(0)
                    hold.agent = None
                    kind = "overflow_end" if agent_person[first] in joined else "overflow_bypassed"
                    event(agent_person[first], kind, time_s, reason="Main queue capacity became available")
        occupied = [agent.position for agent in agents.values()]
        remaining = []
        blocked_targets = set()
        for person in awaiting_spawn:
            p = people[person]
            if p["target_id"] in blocked_targets:
                remaining.append(person)
                delayed.add(person)
                spawn_reasons["fifo_predecessor"] += 1
                continue
            candidates = spawn_positions[p["entrance_id"]]
            offset = min(int(p["spawn_choice"] * len(candidates)), len(candidates) - 1)
            queue = queues[p["target_id"]]
            main_slot = len(queue.assigned) < len(queue.positions) and not queue.overflow_fifo
            holding = None if main_slot else next((h for h in queue.holding if h.agent is None), None)
            if not main_slot and holding is None:
                remaining.append(person)
                delayed.add(person)
                spawn_reasons["capacity"] += 1
                blocked_targets.add(p["target_id"])
                continue
            admitted = None
            def attempts():
                for j in range(len(candidates)):
                    yield candidates[(offset + j) % len(candidates)], False
                free = spawn_fallbacks[p["entrance_id"]]
                if occupied:
                    free = free.difference(unary_union([
                        Point(position).buffer(2 * RADIUS + 0.021)
                        for position in occupied
                    ]))
                if not free.is_empty:
                    nearest = nearest_points(Point(candidates[offset]), free)[1]
                    yield tuple(nearest.coords[0]), True

            for position, fallback in attempts():
                if any(math.dist(position, other) <= 2 * RADIUS + 0.02 for other in occupied):
                    spawn_reasons["occupied"] += 1
                    continue
                try:
                    agent_id = sim.add_agent(jps.CollisionFreeSpeedModelAgentParameters(
                        position=position, desired_speed=p["preferred_speed_m_s"], radius=RADIUS,
                        journey_id=queue.journey if main_slot else holding.journey,
                        stage_id=queue.approach if main_slot else holding.stage,
                    ))
                except RuntimeError as exc:
                    # JuPedSim's neighbour index can still reflect the previous
                    # step. A native collision rejection is a blocked candidate,
                    # not permission to overlap it or swallow other model errors.
                    if "Model constraint violation:" in str(exc) and "too close to agent" in str(exc):
                        spawn_reasons["native_collision"] += 1
                        native_spawn_rejections += 1
                        continue
                    raise RuntimeError(f"Failed to spawn {p['id']} at {position} at t={time_s}: {exc}") from exc
                admitted = (agent_id, position)
                break
            if admitted is None:
                remaining.append(person)
                delayed.add(person)
                blocked_targets.add(p["target_id"])
                continue
            agent_id, position = admitted
            if main_slot:
                queue.assigned.add(agent_id)
            else:
                holding.agent = agent_id
                queue.overflow_fifo.append(agent_id)
                overflow.add(person)
            agent_person[agent_id] = person
            agents[agent_id] = sim.agent(agent_id)
            occupied.append(position)
            states[person] = "walking"
            delay = max(0.0, time_s - p["arrival_s"])
            spawn_delay += delay
            fallback_spawns += int(fallback)
            event(person, "spawned", time_s, position=list(position), delay_s=delay, fallback=fallback)
            if not main_slot:
                event(person, "overflow_requested", time_s, holding_position=list(holding.position))
        awaiting_spawn = remaining
        # add_agent can reallocate native agent storage, invalidating old handles.
        agents = {agent.id: agent for agent in sim.agents()}

        # A join is physical entry through the tail waypoint, not scheduled arrival.
        for queue in queues.values():
            requesting = [a for a in agents.values() if a.stage_id == queue.stage]
            native = sim.get_stage(queue.stage)
            enqueued = native.enqueued()
            for agent in requesting:
                person = agent_person[agent.id]
                if person not in joined:
                    joined[person] = time_s
                    states[person] = "queued"
                    event(person, "joined_queue", time_s, position=list(agent.position))
            for hold in queue.holding:
                if hold.agent is None:
                    continue
                person = agent_person[hold.agent]
                target = next(t for t in scene.targets if queues[t.id] is queue)
                if (person not in joined
                        and math.dist(agents[hold.agent].position, hold.position) <= REACHED_M
                        and Polygon(effective_overflow_area(target)).covers(Point(agents[hold.agent].position))):
                    joined[person] = time_s
                    states[person] = "queued"
                    event(person, "joined_queue", time_s, position=list(agents[hold.agent].position))
                    event(person, "queue_overflow", time_s, position=list(agents[hold.agent].position))
            free_servers = [s for s in queue.servers if s.agent is None]
            dispatch = list(zip(enqueued, free_servers))
            if dispatch:
                native.pop(len(dispatch))
            forced = set()
            if len(dispatch) < len(free_servers) and step >= 100:
                # A targeting head can be physically blocked before JuPedSim
                # marks it enqueued. A free server must not wait indefinitely.
                waiting = sorted((a for a in requesting if a.id not in enqueued),
                                 key=lambda a: (joined[agent_person[a.id]], agent_person[a.id]))
                for agent, free_server in zip(waiting, free_servers[len(dispatch):]):
                    person = agent_person[agent.id]
                    history = frames[step // 2 - 50:step // 2, person]
                    if np.isfinite(history).all() and np.max(np.linalg.norm(history - agent.position, axis=1)) < 0.1:
                        forced.add(agent.id)
                        dispatch.append((agent.id, free_server))
                        event(person, "queue_stall_detected", time_s, stationary_s=5,
                              position=list(agent.position), action="Dispatch to free service position")
            for head, free_server in dispatch:
                # The native head is the first assigned person, who may be
                # blocked short of its waiting coordinate. Dispatch must unblock
                # them; only SERVICE arrival is distance-gated.
                queue.assigned.remove(head)
                free_server.agent = head
                free_server.dispatched_s = time_s
                person = agent_person[head]
                event(person, "service_dispatched", time_s, service_position=list(free_server.position),
                      position=list(agents[head].position))
                pending_dispatch[head] = (free_server.journeys[people[person]["destination_id"]], free_server.stage)
                if math.dist(agents[head].position, queue.positions[0]) > 3:
                    waypoints = _handoff_waypoints(
                        floor, tuple(agents[head].position), free_server.position,
                        [a.position for a in agents.values() if a.id != head and states[agent_person[a.id]] == "queued"],
                    )
                    if waypoints is None:
                        event(person, "handoff_route_unavailable", time_s,
                              reason="No connected clearanced route around current queued people; native routing retained")
                    elif waypoints:
                        stages = [sim.add_waypoint_stage(tuple(p), 0.15) for p in waypoints]
                        stages.extend([free_server.stage, seats[people[person]["destination_id"]][0]])
                        description = jps.JourneyDescription(stages)
                        for current, following in zip(stages, stages[1:]):
                            description.set_transition_for_stage(current, jps.Transition.create_fixed_transition(following))
                        pending_dispatch[head] = (sim.add_journey(description), stages[0])
                        event(person, "handoff_routed", time_s, waypoints=[list(p) for p in waypoints])
                if head in forced:
                    # Not yet enqueued: switch before iterate can enqueue it.
                    journey, stage = pending_dispatch.pop(head)
                    sim.switch_agent_journey(head, journey, stage)

        # A clearanced handoff path can become stale as the queue advances.
        # Replan only a physically stalled approach, using native waypoints;
        # never move the agent or change its reserved service position.
        if step >= 200 and step % 200 == 0:
            for queue in queues.values():
                for server in queue.servers:
                    if server.agent is None or server.end_s is not None or time_s - server.dispatched_s < 10:
                        continue
                    person = agent_person[server.agent]
                    current = tuple(agents[server.agent].position)
                    history = frames[step // 2 - 100:step // 2, person]
                    if not np.isfinite(history).all() or np.max(np.linalg.norm(history - current, axis=1)) > 0.5:
                        continue
                    waypoints = _handoff_waypoints(floor, current, server.position,
                        [a.position for a in agents.values() if a.id != server.agent and states[agent_person[a.id]] == "queued"])
                    if waypoints:
                        stages = [sim.add_waypoint_stage(tuple(p), 0.15) for p in waypoints]
                        stages.extend([server.stage, seats[people[person]["destination_id"]][0]])
                        description = jps.JourneyDescription(stages)
                        for stage, following in zip(stages, stages[1:]):
                            description.set_transition_for_stage(stage, jps.Transition.create_fixed_transition(following))
                        sim.switch_agent_journey(server.agent, sim.add_journey(description), stages[0])
                        event(person, "handoff_replanned", time_s, waypoints=[list(p) for p in waypoints])

        if step >= 1200 and step % 200 == 0:
            for queue in queues.values():
                enqueued = [a for a in sim.get_stage(queue.stage).enqueued() if a in queue.assigned]
                for index, agent_id in enumerate(enqueued):
                    if agent_id in pending_dispatch or agent_id not in queue.assigned:
                        continue
                    person = agent_person[agent_id]
                    current = tuple(agents[agent_id].position)
                    history = frames[step // 2 - 600:step // 2, person]
                    goal = queue.positions[index]
                    if (not np.isfinite(history).all()
                            or np.max(np.linalg.norm(history - current, axis=1)) >= 0.1
                            or math.dist(current, goal) <= REACHED_M
                            or any(math.dist(a.position, goal) < 2 * RADIUS + 0.02
                                   for a in agents.values() if a.id != agent_id)):
                        continue
                    waypoints = _handoff_waypoints(floor, current, goal,
                        [a.position for a in agents.values() if a.id != agent_id and states[agent_person[a.id]] == "queued"])
                    if waypoints is None:
                        event(person, "queue_stall_detected", time_s, stationary_s=60,
                              position=list(current), action="No clearanced route to free assigned position")
                        continue
                    stages = [sim.add_waypoint_stage(tuple(p), 0.15) for p in [*waypoints, goal]]
                    # Retain the SAME queue stage: native FIFO reservation is
                    # kept while the agent follows the detour and returns.
                    stages.append(queue.stage)
                    description = jps.JourneyDescription(stages)
                    for stage, following in zip(stages, stages[1:]):
                        description.set_transition_for_stage(stage, jps.Transition.create_fixed_transition(following))
                    handoff = sim.add_waypoint_stage(queue.positions[0], REACHED_M)
                    description.add(handoff)
                    description.set_transition_for_stage(queue.stage, jps.Transition.create_fixed_transition(handoff))
                    # Its service dispatch will replace this journey after pop.
                    sim.switch_agent_journey(agent_id, sim.add_journey(description), stages[0])
                    event(person, "queue_stall_detected", time_s, stationary_s=60,
                          position=list(current), action="Native detour to free assigned queue position")

        active = [(agent_person[a.id], a.position) for a in agents.values() if states[agent_person[a.id]] != "done"]
        if step % 2 == 0:
            for person, position in active:
                frames[step // 2, person] = position
        if step % 200 == 0:
            stuck = []
            if step >= 600:
                history = frames[step // 2 - 300:step // 2 + 1]
                for person, position in active:
                    track = history[:, person]
                    if np.isfinite(track).all() and np.max(np.linalg.norm(track - position, axis=1)) < 0.1:
                        stuck.append({"id": people[person]["id"], "state": states[person],
                                      "position": [round(v, 3) for v in position]})
            stalled_approaches = []
            if step >= 600:
                for queue in queues.values():
                    for server in queue.servers:
                        if server.agent is None or server.end_s is not None or time_s - server.dispatched_s < 30:
                            continue
                        person = agent_person[server.agent]
                        old = frames[step // 2 - 300, person]
                        current = agents[server.agent].position
                        progress = math.dist(old, server.position) - math.dist(current, server.position)
                        if np.isfinite(old).all() and progress < 0.1:
                            stalled_approaches.append({"id": people[person]["id"], "state": states[person],
                                "position": list(current), "service_position": list(server.position),
                                "progress_30s_m": round(progress, 3)})
            clusters = {}
            for row in stuck:
                x, y = row["position"]
                key = f"{row['state']}@{math.floor(x / 2) * 2},{math.floor(y / 2) * 2}"
                clusters[key] = clusters.get(key, 0) + 1
            diagnostics.append({
                "time_s": time_s, "queue_length": states.count("queued"),
                "in_service": states.count("in_service"), "done": states.count("done"),
                "not_arrived": states.count("not_arrived"), "stuck_count": len(stuck),
                "stuck": stuck, "stuck_clusters_2m": clusters,
                "stalled_service_approaches": stalled_approaches,
                "spawn_rejection_units": {"occupied": "candidate positions blocked by people",
                    "native_collision": "native add_agent collision rejections", "capacity": "person-step retries with no waiting reservation",
                    "fifo_predecessor": "person-step retries behind an earlier blocked arrival for this target"},
                "spawn_rejections": dict(spawn_reasons),
                "heads": {key: {"position": list(q.positions[0]),
                    "occupancy": sum(math.dist(a.position, q.positions[0]) <= REACHED_M for a in agents.values()),
                    "native_length": len(sim.get_stage(q.stage).enqueued()),
                    "queued_count": sum(states[i] == "queued" and people[i]["target_id"] == key for i in range(n)),
                    "main_reserved": len(q.assigned), "main_capacity": len(q.positions),
                    "overflow_reserved": len(q.overflow_fifo), "overflow_capacity": len(q.holding),
                    "reserved_services": sum(s.agent is not None for s in q.servers),
                    "rush_s": round(q.rush_s, 9),
                    "services": [{"position": list(s.position), "id": people[agent_person[s.agent]]["id"] if s.agent else None,
                        "agent_position": list(agents[s.agent].position) if s.agent else None,
                        "state": states[agent_person[s.agent]] if s.agent else "free",
                        "busy_rush_s": round(s.busy_rush_s, 9)} for s in q.servers],
                    "head_distance_m": (math.dist(agents[sim.get_stage(q.stage).enqueued()[0]].position, q.positions[0])
                        if sim.get_stage(q.stage).enqueued() else None)} for key, q in queues.items()},
            })
        positions = np.asarray([position for _, position in active], dtype=float).reshape(-1, 2)
        if interval > 0:
            for target_id, queue in queues.items():
                if any(states[i] == "queued" and people[i]["target_id"] == target_id for i in range(n)):
                    queue.rush_s += interval
                    for server in queue.servers:
                        if server.end_s is not None:
                            server.busy_rush_s += interval
            density.update(positions, interval)
            queued_positions = np.asarray([position for person, position in active if states[person] == "queued"], dtype=float).reshape(-1, 2)
            queue_wait_person_s += len(queued_positions) * interval
            if len(queued_positions):
                conflict_person_s += int(np.count_nonzero(intersects_xy(walkways, queued_positions[:, 0], queued_positions[:, 1]))) * interval
        if step < step_count:
            sim.iterate()

    accounting = {state: states.count(state) for state in ("not_arrived", "walking", "queued", "in_service", "done")}
    if sum(accounting.values()) != n:
        raise RuntimeError("Population accounting does not balance")
    censored = [scenario.horizon_s - joined[i] for i in joined if states[i] == "queued"]
    spawn_delay += sum(scenario.horizon_s - people[i]["arrival_s"] for i in awaiting_spawn)
    grid = density.result(scenario.horizon_s)
    metrics = {
        "mean_wait_s": float(np.mean(waits)) if waits else None,
        "max_wait_s": max(waits) if waits else None,
        "wait_observations": len(waits),
        "censored_wait_count": len(censored),
        "censored_wait_person_s": sum(censored),
        "queue_wait_person_s": round(queue_wait_person_s, 9),
        "walkway_conflict_person_s": round(conflict_person_s, 9),
        "overflow_count": len(overflow),
        "spawn_delayed_count": len(delayed),
        "spawn_native_rejections": native_spawn_rejections,
        "spawn_fallback_count": fallback_spawns,
        "spawn_delay_person_s": spawn_delay,
        "bottleneck_cell_count": len(grid.bottleneck_cells),
        "completed": accounting["done"],
    }
    return Result(
        metrics=metrics, accounting=accounting, people=people,
        frames=base64.b64encode(frames.tobytes()).decode("ascii"),
        frame_shape=list(frames.shape), frame_dt_s=FRAME_DT, horizon_s=scenario.horizon_s,
        density_grid=grid, events=events, diagnostics=diagnostics, scene_hash=_hash(scene), scenario_hash=_hash(scenario),
    )


def compare(a: Result, b: Result) -> dict:
    """Better means Pareto improvement including completions; deltas are b minus a.

    Reject different people/scenarios. Fewer completions can never win, and lower
    observed waits cannot hide fewer service starts. Null waits are not gains.
    """
    if a.people != b.people:
        raise ValueError("Cannot compare results with different presampled people")
    if a.scenario_hash != b.scenario_hash or a.horizon_s != b.horizon_s:
        raise ValueError("Cannot compare results from different scenarios or horizons")
    lower_is_better = (
        "mean_wait_s", "max_wait_s", "queue_wait_person_s", "walkway_conflict_person_s",
        "overflow_count", "spawn_delayed_count", "bottleneck_cell_count",
    )

    def dominates(candidate: Result, baseline: Result) -> bool:
        if candidate.accounting["done"] < baseline.accounting["done"]:
            return False
        if candidate.metrics["wait_observations"] < baseline.metrics["wait_observations"]:
            return False
        improved = candidate.accounting["done"] > baseline.accounting["done"]
        for name in lower_is_better:
            new, old = candidate.metrics[name], baseline.metrics[name]
            if new is None or old is None:
                if new != old:
                    return False
            elif new > old + 1e-9:
                return False
            elif new < old - 1e-9:
                improved = True
        return improved

    better = "b" if dominates(b, a) else "a" if dominates(a, b) else None
    deltas = {
        key: b.metrics[key] - value if value is not None and b.metrics[key] is not None else None
        for key, value in a.metrics.items() if key in b.metrics
    }
    return {
        "valid": True, "better": better,
        "status": "improvement" if better else "equivalent" if a.metrics == b.metrics and a.accounting == b.accounting else "trade_off",
        "deltas_b_minus_a": deltas,
        "completed": {"a": a.accounting["done"], "b": b.accounting["done"]},
    }


def compare_operations(a: Result, b: Result) -> dict:
    """Compare changed arrivals explicitly, without declaring an automatic winner.

    Every non-arrival person field and the observation horizon must match.
    Scene changes are allowed for staffing; permitted changes are checked by the
    caller against the original scene. Unchanged arrivals use strict compare().
    """
    if a.horizon_s != b.horizon_s:
        raise ValueError("Cannot compare operations across different horizons")
    for result in (a, b):
        for person in result.people:
            arrival = person.get("arrival_s")
            if isinstance(arrival, bool) or not isinstance(arrival, (int, float)) or not math.isfinite(arrival) or arrival < 0:
                raise ValueError("Operations comparison requires finite nonnegative arrival_s for every person")
    original = [{key: value for key, value in person.items() if key != "arrival_s"} for person in a.people]
    candidate = [{key: value for key, value in person.items() if key != "arrival_s"} for person in b.people]
    if original != candidate:
        raise ValueError("Cannot compare operations with different non-arrival person fields")
    if a.people == b.people and a.scenario_hash == b.scenario_hash:
        return compare(a, b)
    return {
        "valid": True, "better": None, "status": "operations_trade_off",
        "label": "different arrival schedule, same people and service times",
        "deltas_b_minus_a": {
            key: b.metrics[key] - value if value is not None and b.metrics[key] is not None else None
            for key, value in a.metrics.items() if key in b.metrics
        },
        "completed": {"a": a.accounting["done"], "b": b.accounting["done"]},
    }
