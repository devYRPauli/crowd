/**
 * Which exit people take when there is more than one.
 *
 * This is CROWD's own check, not a RiMEA case. RiMEA's TC11 covers exactly this
 * behaviour — a crowd leaving a room by two doors at unequal distances — but the
 * clause's own geometry, occupancy and acceptance criterion could not be read
 * from a primary source here, and a test that invents them and prints "TC11" is
 * the same kind of lie as loosening a threshold. So it claims no number, and the
 * criteria below are stated on their own terms.
 *
 * What is under test is `Simulation.nearestExit` and the periodic review that
 * follows it, which every person reaches through `headForExit` — an `exit` step
 * in an itinerary, an evacuation, or giving up on an unreachable destination.
 * Each case is run twice, once with congestion-aware routing on and once with
 * it off, because the difference between those two runs is the feature, and a
 * single number cannot show it.
 */

import { describe, expect, it } from 'vitest'
import { Simulation } from '../engine'
import { PlanBuilder } from '../../library/planBuilder'
import { createScenario } from '../../core/model/defaults'
import { AGENT_FIELD, AGENT_STRIDE } from '../types'
import type { ArrivalProfile, Plan, Population, Scenario } from '../../core/model/types'

const DT = 0.1
/** A hall wide enough that the two doors are a real choice, not a formality. */
const WIDTH = 40
const HEIGHT = 20
const DOOR = 1.2

interface ExitSplit {
  /** People who left by the door nearest where they started. */
  near: number
  /** People who left by the door at the far end of the hall. */
  far: number
  completed: number
  total: number
  clearanceS: number
  /** Longest anybody took from appearing to leaving. */
  longestS: number
}

/**
 * A hall with a door at each end and everybody starting by the west one.
 *
 * Attribution is by last seen position: an agent is gone from the snapshot on
 * the tick after it leaves, so whichever door it was closest to on its last
 * tick is the one it used. The doors are 40 m apart, so there is nothing
 * marginal about the call.
 */
const runTwoDoorHall = (
  people: number,
  adaptive: boolean,
  arrival: ArrivalProfile = { kind: 'all-at-once', startS: 0, windowS: 0 },
): ExitSplit => {
  const b = new PlanBuilder()
  const room = b.room(0, 0, WIDTH, HEIGHT)
  b.door(room.west, HEIGHT / 2, DOOR)
  b.door(room.east, HEIGHT / 2, DOOR)
  // Everybody starts in the western quarter, so the west door is nearer for all
  // of them and any use of the east one is a decision rather than an accident.
  const entry = b.zone('entry', 2, 4, 10, 16, 'West end')
  b.zone('exit', -1.8, 8.6, -0.4, 11.4, 'West door')
  b.zone('exit', WIDTH + 0.4, 8.6, WIDTH + 1.8, 11.4, 'East door')
  const plan: Plan = b.build()

  const population: Population = {
    id: 'exit-choice',
    name: 'exit-choice',
    count: people,
    color: '#4c7dd4',
    entryIds: [entry.id],
    arrival,
    profileMix: [{ profileId: 'adult', weight: 1 }],
    itinerary: [{ id: 'exit-choice:exit', kind: 'exit' }],
  }
  const base = createScenario()
  const scenario: Scenario = {
    ...base,
    name: 'exit-choice',
    durationS: Math.max(1200, arrival.startS + arrival.windowS + 300),
    seed: 1,
    routing: { ...base.routing, adaptive },
    populations: [population],
  }

  const sim = new Simulation(plan, scenario)
  const lastX = new Map<number, number>()
  const used = new Map<number, 'near' | 'far'>()
  const appeared = new Map<number, number>()
  let longestS = 0

  for (let i = 0; i < scenario.durationS / DT && !sim.isFinished; i++) {
    sim.step(DT)
    const snapshot = sim.snapshot()
    const present = new Set<number>()
    for (let k = 0; k < snapshot.count; k++) {
      const id = snapshot.agents[k * AGENT_STRIDE + AGENT_FIELD.id]
      present.add(id)
      if (!appeared.has(id)) appeared.set(id, sim.currentTime)
      lastX.set(id, snapshot.agents[k * AGENT_STRIDE + AGENT_FIELD.x])
    }
    for (const [id, x] of lastX) {
      if (present.has(id) || used.has(id)) continue
      used.set(id, x < WIDTH / 2 ? 'near' : 'far')
      longestS = Math.max(longestS, sim.currentTime - (appeared.get(id) ?? 0))
    }
  }

  const summary = sim.summary()
  let near = 0
  let far = 0
  for (const door of used.values()) {
    if (door === 'near') near++
    else far++
  }
  return {
    near,
    far,
    completed: summary.completed,
    total: summary.totalPeople,
    clearanceS: summary.clearanceTime ?? Infinity,
    longestS,
  }
}

const report = (label: string, result: ExitSplit): void => {
  console.warn(
    `Exit choice, ${label}: ${result.near} by the near door, ${result.far} by the far one ` +
      `(${((result.far / result.total) * 100).toFixed(0)}%); ` +
      `${result.completed}/${result.total} out in ${result.clearanceS.toFixed(1)} s`,
  )
}

describe('choice of exit', () => {
  /**
   * With nobody in the way the nearer door is simply the right answer, and this
   * has to hold whether or not congestion-aware routing is on. A model that
   * sends people the length of a hall to an identical door when the near one is
   * standing open is routing by something other than travel time.
   */
  it('sends an uncongested crowd to the door nearest them, either way', () => {
    const adaptive = runTwoDoorHall(40, true)
    const fixed = runTwoDoorHall(40, false)
    report('40 people, congestion-aware', adaptive)
    report('40 people, shortest-path', fixed)

    for (const result of [adaptive, fixed]) {
      expect(result.completed).toBe(result.total)
      expect(result.near / result.total).toBeGreaterThanOrEqual(0.9)
    }
  }, 180_000)

  /**
   * A crowd too big for one door spreads across both, and the whole point is
   * that it clears sooner for doing so.
   *
   * This is the behaviour the tool exists to show. A planner asking "is a second
   * door on the far wall worth it?" gets no useful answer from a model where
   * everybody queues at the nearest one regardless — it will say the second door
   * bought nothing, which is wrong in the direction that gets exits left out.
   *
   * How far the split goes is not asserted tightly, because the honest answer
   * depends on how congestion-aware the population is and that is a scenario
   * setting rather than a property of the engine. What is asserted is the shape:
   * the near door still takes more people, because it is still nearer; the far
   * one takes a real share rather than a rounding error; and the hall empties
   * materially sooner than when nobody reconsiders.
   *
   * The margin below was 15% when this was written and is 10% now, and that is
   * a threshold moving, so it is worth saying why rather than quietly doing it.
   * The measurement was 32% and is 12%. Nothing about exit choice changed: what
   * changed is that the navigation grid stopped being a fixed 0.3 m whatever the
   * geometry, and the *single*-door run — which is the baseline this is measured
   * against — got 20% faster for it, from 146.8 s to 117.5 s. The old 32% was
   * partly a coarse grid under-serving one door and flattering the second. 10%
   * is a materiality floor, not a calibration: what the feature is worth is the
   * number printed above, and the assertion exists to catch it going to zero.
   */
  it('spreads a crowd too big for one door across both, and clears sooner for it', () => {
    const adaptive = runTwoDoorHall(300, true)
    const fixed = runTwoDoorHall(300, false)
    report('300 people, congestion-aware', adaptive)
    report('300 people, shortest-path', fixed)
    console.warn(
      `Exit choice: using the second door cut clearance from ` +
        `${fixed.clearanceS.toFixed(1)} s to ${adaptive.clearanceS.toFixed(1)} s ` +
        `(${(((fixed.clearanceS - adaptive.clearanceS) / fixed.clearanceS) * 100).toFixed(0)}%).`,
    )

    expect(adaptive.completed).toBe(adaptive.total)
    expect(fixed.completed).toBe(fixed.total)

    // Shortest-path routing has no reason to use the far door and does not.
    expect(fixed.far / fixed.total).toBeLessThan(0.05)

    // Congestion-aware routing does, without abandoning the near one.
    expect(adaptive.far / adaptive.total).toBeGreaterThan(0.2)
    expect(adaptive.near).toBeGreaterThan(adaptive.far)

    // And it is worth it: a second door that goes unused saves nobody any time.
    expect(adaptive.clearanceS).toBeLessThan(fixed.clearanceS * 0.9)
  }, 300_000)

  /**
   * Somebody alone in the hall walks out of the door beside them, however
   * slowly that door has been passing people.
   *
   * A door that has seen a trickle all evening has a low measured rate, and a
   * person who counted themselves in the queue for it priced their own door as
   * a long wait. The far door had nobody heading for it, so it looked free; on
   * the way there they counted themselves at that one instead and turned back.
   * The last guest out of the banquet paced between two doors for twenty
   * minutes like that.
   */
  it('does not make somebody alone queue behind themselves', () => {
    const result = runTwoDoorHall(24, true, { kind: 'uniform', startS: 0, windowS: 3000 })
    report('24 people over 3000 s, congestion-aware', result)
    console.warn(
      `Exit choice: the longest anybody took to leave was ${result.longestS.toFixed(1)} s`,
    )

    expect(result.completed).toBe(result.total)
    expect(result.far).toBe(0)
    // The far corner of the entry zone is 12 m from the near door.
    expect(result.longestS).toBeLessThan(30)
  }, 180_000)
})
