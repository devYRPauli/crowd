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
from shapely.ops import unary_union

from crowd.schema import DensityGrid, Result, Scenario, Scene

DT = 0.05
FRAME_DT = 0.1
RADIUS = 0.2
REACHED_M = 0.25
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
    arrivals in the first half, shuffled across IDs.
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


@dataclass
class _Queue:
    positions: list[tuple[float, float]]
    approach: int
    stage: int
    journey: int
    servers: list[_Server] = field(default_factory=list)


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
        queues[target.id] = queue
    return queues


def run(scene: Scene, scenario: Scenario) -> Result:
    """Rehearse at dt=0.05, saving frames at t=0, 0.1, ... <= horizon.

    Agents enter via the tail waypoint (0.6 m tolerance), then fill the native
    queue head first. Overflow remains physically at the tail. Each explicit
    service position has a single-slot native queue. Dispatch requires arrival
    within 0.25 m of the waiting head; service starts only within 0.25 m of the
    reserved service position. pop(1) at service end routes that person toward
    their destination centroid; arrival within 0.25 m despawns them.

    Waits include queue movement and travel to service. Mean/max cover started
    services only; censored waits and total waiting exposure are separate.
    overflow_count counts distinct people requesting a position when all slots
    are reserved. Delayed spawns remain not_arrived until physically admitted.
    Events occur on dt boundaries; a fractional final dt measures the last state
    without stepping past the horizon. Frames use NaN pairs for absent people.
    """
    scene = Scene.model_validate(scene.model_dump())
    scenario = Scenario.model_validate(scenario.model_dump())
    people = presample_people(scene, scenario)
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
        for agent_id, server in pending_dispatch.items():
            person = agent_person[agent_id]
            sim.switch_agent_journey(agent_id, server.journeys[people[person]["destination_id"]], server.stage)
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
        occupied = [agent.position for agent in agents.values()]
        remaining = []
        for person in awaiting_spawn:
            p = people[person]
            candidates = spawn_positions[p["entrance_id"]]
            offset = min(int(p["spawn_choice"] * len(candidates)), len(candidates) - 1)
            queue = queues[p["target_id"]]
            admitted = None
            for j in range(len(candidates)):
                position = candidates[(offset + j) % len(candidates)]
                if any(math.dist(position, other) <= 2 * RADIUS + 0.02 for other in occupied):
                    continue
                try:
                    agent_id = sim.add_agent(jps.CollisionFreeSpeedModelAgentParameters(
                        position=position, desired_speed=p["preferred_speed_m_s"], radius=RADIUS,
                        journey_id=queue.journey, stage_id=queue.approach,
                    ))
                except RuntimeError as exc:
                    # JuPedSim's neighbour index can still reflect the previous
                    # step. A native collision rejection is a blocked candidate,
                    # not permission to overlap it or swallow other model errors.
                    if "Model constraint violation:" in str(exc) and "too close to agent" in str(exc):
                        native_spawn_rejections += 1
                        continue
                    raise RuntimeError(f"Failed to spawn {p['id']} at {position} at t={time_s}: {exc}") from exc
                admitted = (agent_id, position)
                break
            if admitted is None:
                remaining.append(person)
                delayed.add(person)
                continue
            agent_id, position = admitted
            agent_person[agent_id] = person
            agents[agent_id] = sim.agent(agent_id)
            occupied.append(position)
            states[person] = "walking"
            delay = max(0.0, time_s - p["arrival_s"])
            spawn_delay += delay
            event(person, "spawned", time_s, position=list(position), delay_s=delay)
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
            # Native enqueued contains assigned slots, not overflow agents.
            waiting = sorted((a for a in requesting if a.id not in enqueued), key=lambda a: (joined[agent_person[a.id]], agent_person[a.id]))
            free = max(0, len(queue.positions) - len(enqueued))
            for agent in waiting[free:]:
                person = agent_person[agent.id]
                if person not in overflow:
                    overflow.add(person)
                    event(person, "queue_overflow", time_s, position=list(agent.position))
            free_server = next((s for s in queue.servers if s.agent is None), None)
            if free_server is not None and enqueued:
                head = enqueued[0]
                if math.dist(agents[head].position, queue.positions[0]) <= REACHED_M:
                    native.pop(1)
                    free_server.agent = head
                    pending_dispatch[head] = free_server

        active = [(agent_person[a.id], a.position) for a in agents.values() if states[agent_person[a.id]] != "done"]
        if step % 2 == 0:
            for person, position in active:
                frames[step // 2, person] = position
        positions = np.asarray([position for _, position in active], dtype=float).reshape(-1, 2)
        if interval > 0:
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
        "spawn_delay_person_s": spawn_delay,
        "bottleneck_cell_count": len(grid.bottleneck_cells),
        "completed": accounting["done"],
    }
    return Result(
        metrics=metrics, accounting=accounting, people=people,
        frames=base64.b64encode(frames.tobytes()).decode("ascii"),
        frame_shape=list(frames.shape), frame_dt_s=FRAME_DT, horizon_s=scenario.horizon_s,
        density_grid=grid, events=events, scene_hash=_hash(scene), scenario_hash=_hash(scenario),
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
