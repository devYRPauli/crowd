/**
 * What a door is worth.
 *
 * Egress capacity is the number this tool exists to produce: somebody asks
 * whether the doors they have will clear the room they are filling, and every
 * other feature is in service of answering that. It went unmeasured for a long
 * time, and in that time it was wrong by a factor of five.
 *
 * The defect was in how somebody was judged to have left. `atAnyExit` accepted
 * anyone within `radius + 0.35` of the *edge* of a doorway's threshold, which
 * dilated a 3'0" leaf into a 2.07 m capture front reaching a metre back into
 * the room, so people were counted out while still on the open floor and never
 * funnelled through the gap at all. A 2'0" door and an 8'0" pair then cleared
 * the same hall at nearly the same rate: four times the width bought 1.34 times
 * the flow. Egress figures came out five to ten times optimistic, in the
 * optimistic direction, on the one question the tool is asked.
 *
 * Nothing caught it, because nothing measured it. RiMEA TC12 measures flow
 * through a gap in a wall, not through a door somebody is routed out of, and
 * the single-exit case asserts that everybody gets out rather than how fast.
 * This file is the missing measurement, and its first job is to hold the thing
 * that makes a door a door: width has to buy flow.
 */

import { describe, expect, it } from 'vitest'
import { Simulation } from '../engine'
import { PlanBuilder } from '../../library/planBuilder'
import { createScenario } from '../../core/model/defaults'
import { DOOR_WIDTHS } from '../../core/model/standards'
import type { Population, Scenario } from '../../core/model/types'

const DT = 0.1
const HALL_W = 30
const HALL_H = 20
const PEOPLE = 200

/** A stock leaf by the name a supplier calls it, so the widths are real ones. */
const leaf = (imperial: string): number => {
  const size = DOOR_WIDTHS.find((entry) => entry.imperial === imperial)
  if (!size) throw new Error(`No stock door called ${imperial}`)
  return size.metres
}

interface Egress {
  /** People per second across the saturated middle of the run. */
  perSecond: number
  /** Per second per metre of clear width — the figure capacity is quoted in. */
  specific: number
  clearanceS: number
  completed: number
}

/**
 * A hall with one door, emptied through it.
 *
 * Flow is taken between the 20th and 80th percentile of the crowd so that
 * neither the walk-up at the start nor the stragglers at the end are in it;
 * what is left is the saturated period, which is what a capacity figure
 * describes.
 */
const emptyThrough = (width: number, seed = 1): Egress => {
  const b = new PlanBuilder()
  const room = b.room(0, 0, HALL_W, HALL_H)
  b.door(room.south, HALL_W / 2, width, 'door', 'exit')
  const floor = b.zone('entry', 2, 2, HALL_W - 2, HALL_H - 2, 'Floor')

  const population: Population = {
    id: 'egress',
    name: 'egress',
    count: PEOPLE,
    color: '#4c7dd4',
    entryIds: [floor.id],
    arrival: { kind: 'all-at-once', startS: 0, windowS: 0 },
    profileMix: [{ profileId: 'adult', weight: 1 }],
    itinerary: [{ id: 'egress:exit', kind: 'exit' }],
  }
  const base = createScenario()
  const scenario: Scenario = {
    ...base,
    name: 'egress',
    durationS: 3600,
    seed,
    populations: [population],
  }

  const sim = new Simulation(b.build(), scenario)
  const low = Math.round(PEOPLE * 0.2)
  const high = Math.round(PEOPLE * 0.8)
  let atLow: number | null = null
  let atHigh: number | null = null

  for (let i = 0; i < 80_000 && !sim.isFinished; i++) {
    sim.step(DT)
    const done = sim.stats().completed
    if (atLow === null && done >= low) atLow = i * DT
    if (atHigh === null && done >= high) {
      atHigh = i * DT
      break
    }
  }

  const summary = sim.summary()
  const perSecond = atLow !== null && atHigh !== null ? (high - low) / (atHigh - atLow) : NaN
  return {
    perSecond,
    specific: perSecond / width,
    clearanceS: summary.clearanceTime,
    completed: sim.stats().completed,
  }
}

describe('egress through a door', () => {
  const single = emptyThrough(leaf(`3'0"`))
  const pair = emptyThrough(leaf(`6'0" pair`))
  const narrow = emptyThrough(leaf(`2'0"`))

  it('reports what each leaf passed', () => {
    for (const [label, width, result] of [
      [`2'0"`, leaf(`2'0"`), narrow],
      [`3'0"`, leaf(`3'0"`), single],
      [`6'0" pair`, leaf(`6'0" pair`), pair],
    ] as Array<[string, number, Egress]>) {
      console.warn(
        `egress ${label.padEnd(9)} ${width.toFixed(3)} m clear: ` +
          `${result.perSecond.toFixed(2)} p/s, ${result.specific.toFixed(3)} p/m/s`,
      )
      expect(Number.isFinite(result.perSecond)).toBe(true)
    }
  })

  /**
   * The one that would have caught the defect.
   *
   * Doubling the clear width has to roughly double the flow. Under the old exit
   * test this ratio was 1.12 — the extra leaf bought almost nothing, because
   * the leaf was not what people were passing through. It measures 2.5 now,
   * above 2 because a wide door loses proportionally less of itself to the
   * clearance the engine keeps between a shoulder and a jamb.
   *
   * The band is wide on purpose: what it is defending is the order of
   * magnitude, and a run-to-run spread of about a tenth sits inside it.
   */
  it('makes a wider door worth more than a narrow one', () => {
    const ratio = pair.perSecond / single.perSecond
    console.warn(`egress: a 6'0" pair passes ${ratio.toFixed(2)}x a 3'0" leaf`)
    expect(ratio).toBeGreaterThan(1.8)
    expect(ratio).toBeLessThan(3.6)
  })

  /**
   * Specific flow through a wide door, against the observational literature.
   *
   * 1.2–1.4 persons per metre per second is where SFPE and Fruin put a door's
   * capacity, and it is the band RiMEA TC12 grades against. A pair of 3'0"
   * leaves reads inside it.
   *
   * A narrow leaf reads lower — the same known gap TC12 records at its 0.8 m
   * and 1.0 m widths. The engine keeps a fixed clearance between a body and a
   * jamb, so a narrow opening loses proportionally more of itself to it, and
   * people thread it closer to single file than they should. Charged against
   * SFPE's effective width instead — clear width less a 0.15 m boundary layer
   * each side — every width here reads between 1.53 and 1.68 p/m/s, so the
   * engine is consistent with itself and the disagreement is about how much of
   * an opening is usable, not about how fast people walk through one.
   */
  it('passes a wide door at the rate the literature reports', () => {
    expect(pair.specific).toBeGreaterThan(1.15)
    expect(pair.specific).toBeLessThan(1.6)
  })

  it('takes markedly longer to clear the same hall through a 2 ft door', () => {
    // The product's whole claim: change the plan, and the answer changes.
    expect(narrow.perSecond).toBeLessThan(single.perSecond)
    expect(narrow.specific).toBeLessThan(pair.specific)
  })

  /**
   * Each run above stops the moment it has its measurement, so this asserts
   * that the saturated window was actually reached and not that the hall
   * emptied — a door narrow enough to strand people would never get here.
   * Full clearance through a single exit is RiMEA TC11's case, in
   * `engine.test.ts`.
   */
  it('reaches the measuring window through every one of them', () => {
    const window = Math.round(PEOPLE * 0.8)
    expect(narrow.completed).toBeGreaterThanOrEqual(window)
    expect(single.completed).toBeGreaterThanOrEqual(window)
    expect(pair.completed).toBeGreaterThanOrEqual(window)
  })
}, 240_000)
