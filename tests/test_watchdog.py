"""Native queue contract used by the stalled-person waypoint watchdog."""

import jupedsim as jps
import pytest
from shapely.geometry import Polygon


def queue_probe():
    sim = jps.Simulation(
        model=jps.CollisionFreeSpeedModel(),
        geometry=Polygon([(0, 0), (12, 0), (12, 12), (0, 12)]), dt=0.05,
    )
    queue = sim.add_queue_stage([(3, 5), (3.7, 5), (4.4, 5)])
    handoff = sim.add_waypoint_stage((10, 10), 0.2)
    waypoint = sim.add_waypoint_stage((5, 7), 0.2)
    normal = jps.JourneyDescription([queue, handoff])
    normal.set_transition_for_stage(queue, jps.Transition.create_fixed_transition(handoff))
    normal_id = sim.add_journey(normal)
    detour = jps.JourneyDescription([waypoint, queue, handoff])
    detour.set_transition_for_stage(waypoint, jps.Transition.create_fixed_transition(queue))
    detour.set_transition_for_stage(queue, jps.Transition.create_fixed_transition(handoff))
    detour_id = sim.add_journey(detour)
    people = [sim.add_agent(jps.CollisionFreeSpeedModelAgentParameters(
        position=position, journey_id=normal_id, stage_id=queue,
    )) for position in [(3, 5), (3.7, 5)]]
    sim.iterate(10)
    assert sim.get_stage(queue).enqueued() == people
    return sim, queue, waypoint, handoff, detour_id, people


@pytest.mark.parametrize("detouring_index", [0, 1])
def test_same_queue_detour_preserves_fifo_without_duplicate(detouring_index):
    sim, queue, waypoint, handoff, detour, people = queue_probe()
    person = people[detouring_index]
    sim.switch_agent_journey(person, detour, waypoint)
    sim.iterate(20)
    assert sim.agent(person).stage_id == waypoint
    assert sim.get_stage(queue).enqueued() == people
    # Returning through the same stage reuses the reservation, without appending.
    sim.iterate(150)
    assert sim.agent(person).stage_id == queue
    assert sim.get_stage(queue).enqueued() == people
    sim.get_stage(queue).pop(1)
    sim.iterate()
    assert sim.get_stage(queue).enqueued() == [people[1]]
    assert sim.agent(people[0]).stage_id == handoff


@pytest.mark.parametrize("detouring_index", [0, 1])
def test_pop_during_detour_removes_head_and_never_requeues_it(detouring_index):
    sim, queue, waypoint, handoff, detour, people = queue_probe()
    sim.switch_agent_journey(people[detouring_index], detour, waypoint)
    sim.iterate(10)
    assert sim.agent(people[detouring_index]).stage_id == waypoint
    sim.get_stage(queue).pop(1)
    sim.iterate()
    assert sim.get_stage(queue).enqueued() == [people[1]]
    for _ in range(200):
        sim.iterate()
        assert sim.get_stage(queue).enqueued() == [people[1]]
    assert sim.agent(people[0]).stage_id == handoff
    assert sim.agent(people[1]).stage_id == queue
