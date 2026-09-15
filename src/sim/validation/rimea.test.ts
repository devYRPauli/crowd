/**
 * RiMEA 3.0 test cases, run against the real `Simulation`.
 *
 * This file is a public claim about what the simulator does, so it is written
 * to be falsifiable rather than green: every acceptance criterion prints the
 * number it measured, and where the engine misses a criterion the assertion
 * stays exactly as the standard states it and the test is marked `it.fails`.
 * A documented gap is worth more than a threshold quietly widened to fit, and
 * `it.fails` means CI shouts the day the engine grows into the criterion.
 *
 * Everything here drives the shipped `Simulation` through its public surface —
 * a `Plan` from `PlanBuilder`, a `Scenario`, `step()`, `snapshot()`,
 * `inspect()` and `summary()`. There is no bespoke harness, so what passes here
 * is what a user gets.
 *
 * Implemented: TC1 (corridor speed), TC6 (90° corner), TC7 (demographic
 * walking speeds) and TC12 (flow through a bottleneck), plus a single-exit
 * congestion run that is CROWD's own check and not a RiMEA case at all.
 *
 * Numbering. An earlier draft called the bottleneck sweep TC4 and the
 * single-exit run TC11, and both were wrong. RiMEA's TC4 is the fundamental
 * diagram — a long corridor held at a series of fixed densities, which is what
 * `fundamentalDiagram.test.ts` in this directory measures — and RiMEA's TC11 is
 * choice of escape route, a crowd picking between two doors at different
 * distances. The bottleneck case is TC12, whose own two widths are 0.8 m and
 * 1.2 m; both are in the sweep below. Checked against the RiMEA guideline's
 * published test list and against the JuPedSim reference notebooks
 * (`standards/rimea/rimea04_fundamental_diagram`, `…/rimea11_choice_escape`,
 * `…/rimea12d_bottleneck_width_flow`), which agree on all of it. Citing the
 * wrong clause of a standard is the same kind of lie as loosening a threshold,
 * so the numbers here are the ones that were verifiable, and a case that could
 * not be matched to a RiMEA number does not get one.
 *
 * NOT implemented:
 *  - TC2, TC3, TC8 and TC13 turn on stairs and multi-storey geometry: walking
 *    speed up and down a stair, a multi-floor building, the fundamental diagram
 *    on a stair. This version of CROWD models one floor plate. `Plan` has no
 *    storeys and no stair element, the navigation grid is a single 2-D raster
 *    (`SimWorld.grid`), and `STAIR_LOS` exists only as a classification table
 *    with nothing to classify. Faking a stair as a sloped corridor would
 *    produce numbers that look like RiMEA results and mean nothing, so those
 *    cases are simply absent. They become implementable when the plan model
 *    gains levels and vertical links.
 *  - TC4, TC5, TC9, TC10, TC11, TC14 and TC15 are not written yet. TC11 is the
 *    gap that matters most: the engine routes people to a chosen exit and
 *    nothing in this file tests that choice.
 *
 * Determinism: every population is given a fixed `id`, because the engine seeds
 * a sub-stream from it (`rng.branch('population:' + id)`). `createPopulation()`
 * mints a random id, which would make the profile mix and arrival draws differ
 * between runs of the same test.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { Simulation } from '../engine'
import { PlanBuilder } from '../../library/planBuilder'
import { AGENT_PROFILES, createScenario } from '../../core/model/defaults'
import type { AgentProfile, Plan, Population, Scenario, Zone } from '../../core/model/types'
import { AGENT_FIELD, AGENT_STRIDE } from '../types'
import { collectObstaclePolygons } from '../world'
import { distanceToPolygonEdge, pointInPolygon } from '../../core/math/geometry'

/** The engine's default physics timestep; these runs use nothing exotic. */
const DT = 0.1
const SEED = 1

/** Read one packed field of agent `index` out of a snapshot buffer. */
const at = (agents: Float32Array, index: number, key: keyof typeof AGENT_FIELD): number =>
  agents[index * AGENT_STRIDE + AGENT_FIELD[key]]

const mean = (values: readonly number[]): number =>
  values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length)

/** Sample standard deviation; 0 for fewer than two values. */
const stdev = (values: readonly number[]): number => {
  if (values.length < 2) return 0
  const m = mean(values)
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1))
}

const quantile = (sorted: readonly number[], fraction: number): number =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * sorted.length)))]

/** Everyone walks in and leaves; the id is fixed so the run is reproducible. */
const leavingPopulation = (
  id: string,
  count: number,
  entry: Zone,
  arrival: Population['arrival'],
  profileMix: Population['profileMix'],
): Population => ({
  id,
  name: id,
  count,
  color: '#4c7dd4',
  entryIds: [entry.id],
  arrival,
  profileMix,
  itinerary: [{ id: `${id}:exit`, kind: 'exit' }],
})

const scenarioFor = (population: Population, durationS: number): Scenario => ({
  ...createScenario(),
  name: population.id,
  durationS,
  seed: SEED,
  populations: [population],
})

/** Worst body-to-body interpenetration in a snapshot, in metres. */
const worstOverlap = (agents: Float32Array, count: number): number => {
  let worst = 0
  for (let a = 0; a < count; a++) {
    const ax = at(agents, a, 'x')
    const ay = at(agents, a, 'y')
    const ar = at(agents, a, 'radius')
    for (let b = a + 1; b < count; b++) {
      const dx = ax - at(agents, b, 'x')
      const dy = ay - at(agents, b, 'y')
      const minimum = ar + at(agents, b, 'radius')
      const squared = dx * dx + dy * dy
      if (squared >= minimum * minimum) continue
      const overlap = minimum - Math.sqrt(squared)
      if (overlap > worst) worst = overlap
    }
  }
  return worst
}

// ---------------------------------------------------------------------------
// TC1 — walking speed in a corridor
// ---------------------------------------------------------------------------

describe('RiMEA TC1 — walking speed in a plane corridor', () => {
  /**
   * Acceptance criterion (RiMEA 3.0, TC1): one person with a free walking
   * speed of 1.0 m/s in a 2 m × 40 m corridor covers the 40 m in 40 s ± 1 s.
   *
   * The clock runs between two gates at x = 2 m and x = 38 m and the result is
   * scaled to 40 m. Timing the whole journey instead would measure the spawn
   * point inside the entry zone and the 0.34 m arrival radius at the exit, both
   * of which are engine bookkeeping rather than walking speed. (`engine.test.ts`
   * has the loose whole-journey version of this; this is the strict one.)
   */
  it('TC1: crosses 40 m of corridor in 40 s ± 1 s at a 1.0 m/s free speed', () => {
    const fixedSpeed: AgentProfile = {
      id: 'rimea-1ms',
      name: 'RiMEA 1.0 m/s',
      radius: 0.23,
      // sd 0 with min = max = mean, so the profile is a fixed speed, not a draw.
      speed: { mean: 1.0, sd: 0, min: 1.0, max: 1.0 },
      caution: 1,
      assertiveness: 0.5,
      color: '#4c7dd4',
      heightScale: 1,
      mobility: 'walking',
    }

    const b = new PlanBuilder()
    b.room(0, 0, 40, 2)
    const entry = b.zone('entry', 0.4, 0.5, 1.4, 1.5, 'Start')
    // The exit sits in the last metre so that the engine's ease-in over the
    // final 1.2 m starts past the x = 38 gate and cannot shorten the timed run.
    b.zone('exit', 39.0, 0.4, 39.8, 1.6, 'Finish')
    const plan: Plan = b.build()

    const population = leavingPopulation(
      'rimea-tc1',
      1,
      entry,
      { kind: 'all-at-once', startS: 0, windowS: 0 },
      [{ profileId: fixedSpeed.id, weight: 1 }],
    )
    const sim = new Simulation(plan, {
      ...scenarioFor(population, 200),
      profiles: [fixedSpeed],
    })

    const gateIn = 2
    const gateOut = 38
    let previousX = Number.NaN
    let previousT = 0
    let enteredAt = Number.NaN
    let leftAt = Number.NaN
    let peakSpeed = 0

    for (let i = 0; i < 2000 && !sim.isFinished; i++) {
      sim.step(DT)
      const snapshot = sim.snapshot()
      if (snapshot.count === 0) continue
      const x = at(snapshot.agents, 0, 'x')
      peakSpeed = Math.max(peakSpeed, at(snapshot.agents, 0, 'speed'))
      const t = snapshot.time
      if (Number.isFinite(previousX)) {
        // Linear interpolation inside the tick, so the 0.1 s step does not
        // round the answer to the same order as the ±1 s tolerance.
        const crossing = (gate: number) =>
          previousT + ((gate - previousX) / (x - previousX)) * (t - previousT)
        if (!Number.isFinite(enteredAt) && previousX < gateIn && x >= gateIn) {
          enteredAt = crossing(gateIn)
        }
        if (!Number.isFinite(leftAt) && previousX < gateOut && x >= gateOut) {
          leftAt = crossing(gateOut)
        }
      }
      previousX = x
      previousT = t
    }

    const gateTime = leftAt - enteredAt
    const scaledTo40m = (gateTime * 40) / (gateOut - gateIn)
    console.warn(
      `RiMEA TC1: ${(gateOut - gateIn).toFixed(0)} m gate-to-gate in ${gateTime.toFixed(2)} s ` +
        `= ${scaledTo40m.toFixed(2)} s per 40 m (target 40 ± 1 s), ` +
        `mean gate speed ${((gateOut - gateIn) / gateTime).toFixed(3)} m/s, ` +
        `peak instantaneous speed ${peakSpeed.toFixed(3)} m/s`,
    )

    expect(sim.summary().completed).toBe(1)
    expect(scaledTo40m).toBeGreaterThanOrEqual(39)
    expect(scaledTo40m).toBeLessThanOrEqual(41)
  })
})

// ---------------------------------------------------------------------------
// TC12 — flow through a bottleneck
// ---------------------------------------------------------------------------

interface BottleneckResult {
  width: number
  people: number
  crossings: number
  windowStart: number
  windowEnd: number
  /** Persons per second through the opening while the queue is saturated. */
  flow: number
  /** Flow per metre of clear opening width. */
  specificFlow: number
  /** Fewest people still upstream at any point in the measurement window. */
  minUpstream: number
  maxOverlap: number
}

/** Opening widths swept; 0.8 m and 1.2 m are the two RiMEA TC12 states. */
const BOTTLENECK_WIDTHS = [0.8, 1.0, 1.2, 1.5, 2.0]

/**
 * Specific flow through a door, in persons per metre of clear width per second.
 * 1.2–1.4 p/m/s is where the observational literature puts the capacity of a
 * door — SFPE's maximum specific flow for a doorway is 1.3 p/m/s — and it is the
 * band RiMEA TC12 is graded against.
 */
const BAND_LOW = 1.2
const BAND_HIGH = 1.4

/** SFPE boundary layer, used only to explain the result — never to grade it. */
const BOUNDARY_LAYER = 0.15

/**
 * A room feeding one opening, measured at the opening plane.
 *
 * Population scales with the opening (70 per metre plus 30) so that every width
 * yields a comparable number of steady-state crossings without a wide door
 * finishing in seconds or a narrow one running for ten simulated minutes: every
 * run reaches its 90%-through stop between 50 and 95 s of simulated time, and
 * the whole sweep costs about 2 s of wall clock. Arrivals are metered at ~2.2×
 * the opening's capacity, which keeps the queue permanently saturated (asserted
 * via `minUpstream`) without packing the room so hard that the spawn clearance
 * test starves the inflow.
 */
const measureBottleneck = (width: number): BottleneckResult => {
  const people = Math.round(70 * width + 30)
  const windowS = Math.round(people / (2.9 * width))

  const b = new PlanBuilder()
  b.room(0, 0, 16, 6)
  const divider = b.wall({ x: 8, y: 0 }, { x: 8, y: 6 })
  b.door(divider, 3, width, 'opening')
  const entry = b.zone('entry', 0.5, 0.5, 5.0, 5.5, 'Holding room')
  b.zone('exit', 14.0, 1.0, 15.5, 5.0, 'Downstream exit')
  const plan: Plan = b.build()

  const population = leavingPopulation(
    `rimea-tc4-${width}`,
    people,
    entry,
    { kind: 'uniform', startS: 0, windowS },
    [{ profileId: 'adult', weight: 1 }],
  )
  const sim = new Simulation(plan, scenarioFor(population, 900))

  const plane = 8
  const lastX = new Map<number, number>()
  const counted = new Set<number>()
  const crossings: number[] = []
  const upstream: Array<{ time: number; count: number }> = []
  let maxOverlap = 0
  // Stopping once 90% are through keeps the tail of stragglers, which is not
  // steady-state flow, out of both the measurement and the runtime.
  const stopAfter = Math.ceil(people * 0.9)

  for (let i = 0; i < 3000 && !sim.isFinished && crossings.length < stopAfter; i++) {
    sim.step(DT)
    const snapshot = sim.snapshot()
    let behind = 0
    for (let k = 0; k < snapshot.count; k++) {
      const id = at(snapshot.agents, k, 'id')
      const x = at(snapshot.agents, k, 'x')
      if (x < plane) behind++
      const previous = lastX.get(id)
      // First crossing only: somebody who drifts back through the plane and
      // returns is one person through the door, not two.
      if (previous !== undefined && previous < plane && x >= plane && !counted.has(id)) {
        counted.add(id)
        crossings.push(snapshot.time)
      }
      lastX.set(id, x)
    }
    upstream.push({ time: snapshot.time, count: behind })
    if (i % 5 === 0) {
      maxOverlap = Math.max(maxOverlap, worstOverlap(snapshot.agents, snapshot.count))
    }
  }

  // Middle 60% of the crossings: past the build-up, before the queue thins.
  const first = Math.floor(crossings.length * 0.2)
  const last = Math.floor(crossings.length * 0.8)
  const windowStart = crossings[first]
  const windowEnd = crossings[last]
  const flow = (last - first) / (windowEnd - windowStart)
  const minUpstream = upstream
    .filter((sample) => sample.time >= windowStart && sample.time <= windowEnd)
    .reduce((lowest, sample) => Math.min(lowest, sample.count), Infinity)

  const result: BottleneckResult = {
    width,
    people,
    crossings: crossings.length,
    windowStart,
    windowEnd,
    flow,
    specificFlow: flow / width,
    minUpstream,
    maxOverlap,
  }
  console.warn(
    `RiMEA TC12: ${width.toFixed(2)} m opening, ${people} people — ` +
      `${flow.toFixed(3)} p/s over ${(windowEnd - windowStart).toFixed(1)} s ` +
      `(t=${windowStart.toFixed(1)}–${windowEnd.toFixed(1)} s, ${last - first} crossings) ` +
      `= ${result.specificFlow.toFixed(3)} p/m/s of clear width ` +
      `[${(flow / (width - 2 * BOUNDARY_LAYER)).toFixed(3)} p/m/s of effective width], ` +
      `queue never below ${minUpstream} people, worst body overlap ${maxOverlap.toFixed(3)} m`,
  )
  return result
}

describe('RiMEA TC12 — flow through a bottleneck', () => {
  const measured = new Map<number, BottleneckResult>()

  beforeAll(() => {
    for (const width of BOTTLENECK_WIDTHS) measured.set(width, measureBottleneck(width))
  }, 120_000)

  /**
   * The half of the criterion the engine does meet, asserted for every width
   * without exception: no opening passes MORE than the top of the band.
   *
   * This lives here rather than only in the per-width tests because an
   * `it.fails` test is green whenever its body throws, and it does not care
   * which way it threw. Two mutants proved that matters, both at the 0.8 m
   * width, which is marked `it.fails` for being 26% *under* the band: deleting
   * the density slowdown (`speedFromDensity` in `preferredVelocity`) took it to
   * 1.998 p/m/s, and halving every agent's radius took it to 1.830. Each is
   * roughly double the true figure and each left the suite green, because
   * "outside the band" was all the gap test ever asked. The ceiling asserted
   * here, for every width, is what turns a too-generous opening into a failure
   * instead of another shade of the same known gap. It also subsumes the older
   * 2.0 p/m/s line below, which the 1.998 reading had squeaked under by 2 parts
   * in a thousand.
   *
   * That 2.0 p/m/s line is kept as a separate, cruder statement with its own
   * meaning: no crowd of people who occupy space can exceed it, so past that
   * bodies are simply passing through each other rather than merely walking
   * implausibly fast.
   */
  it('TC12: no opening passes more than the top of the band', () => {
    for (const width of BOTTLENECK_WIDTHS) {
      const result = measured.get(width)
      expect(result, `no measurement for ${width} m`).toBeDefined()
      const specific = result!.specificFlow
      const note = `${width} m opening measured ${specific.toFixed(3)} p/m/s`
      expect(specific, note).toBeGreaterThan(0)
      expect(specific, note).toBeLessThanOrEqual(BAND_HIGH)
      // Bodies cannot pass through each other, whatever the band says.
      expect(specific, note).toBeLessThan(2.0)
      // A flow reading taken while the queue had drained would be demand, not
      // capacity. The measured minima are 23–47 people still waiting; widening
      // the window to the whole run drops them to 7–16, which is the reading
      // this floor exists to reject.
      expect(result!.minUpstream, `${width} m opening`).toBeGreaterThanOrEqual(10)
    }
  })

  /**
   * Acceptance criterion (RiMEA TC12): specific flow through the opening,
   * measured over the saturated period, is 1.2–1.4 persons per metre per second
   * of clear width.
   */
  const bandTest = (width: number) => () => {
    const result = measured.get(width)!
    console.warn(
      `RiMEA TC12 acceptance: ${width.toFixed(2)} m opening measured ` +
        `${result.specificFlow.toFixed(3)} p/m/s against a target band of ` +
        `${BAND_LOW.toFixed(1)}–${BAND_HIGH.toFixed(1)} p/m/s`,
    )
    // A missing or NaN reading would throw here too, and an `it.fails` is green
    // whenever its body throws — so the check that the measurement happened at
    // all lives in the unconditional test above, not here.
    expect(result.specificFlow).toBeGreaterThanOrEqual(BAND_LOW)
    expect(result.specificFlow).toBeLessThanOrEqual(BAND_HIGH)
  }

  /**
   * KNOWN GAP. Measured 0.892 p/m/s of clear width (0.713 p/s) against a target
   * of 1.2–1.4 p/m/s — 26% below the bottom of the band. A 0.8 m clear opening
   * leaves 0.28 m of unblocked navigation grid once `NAV_CLEARANCE` (0.26 m) is
   * taken off each side, so people thread it strictly one at a time at a 1.4 s
   * headway where observation gives 0.6–0.8 s. Charged against the *effective*
   * width instead (clear width less a 0.15 m boundary layer each side, the SFPE
   * convention) the same run reads 1.43 p/m/s, just over the top of the band —
   * so the engine moves a single file at about the right rate and the error is
   * in how much of an opening it treats as usable, not in the locomotion.
   *
   * Confirmed by experiment: setting `NAV_CLEARANCE` to 0 raises this width to
   * 1.487 p/m/s and the 1.0 m width to 1.179. That is not the fix — zero
   * clearance strands people at the corner in TC6, 17 of 20 — but it does
   * locate the error in the clearance budget charged at an opening's edges.
   */
  it.fails('TC12: 0.8 m opening passes 1.2–1.4 p/m/s', bandTest(0.8))

  /**
   * KNOWN GAP. Measured 0.903 p/m/s (0.903 p/s) against a target of 1.2–1.4
   * p/m/s — 25% below the band. Same cause as the 0.8 m case: the usable
   * navigation channel is 0.48 m, still single file. Against effective width it
   * reads 1.29 p/m/s, inside the band. Note the near-identical *absolute* flow
   * at 0.8 m and 1.0 m (0.71 vs 0.90 p/s): widening a door by 0.2 m buys almost
   * nothing until the channel is wide enough for two abreast, which is the shape
   * of the defect.
   */
  it.fails('TC12: 1.0 m opening passes 1.2–1.4 p/m/s', bandTest(1.0))

  /**
   * KNOWN GAP, and this is the second of the two widths RiMEA TC12 names.
   * Measured 1.133 p/m/s (1.360 p/s) against 1.2–1.4 — 6% below the band, much
   * closer than the narrower openings because 1.2 m leaves a 0.68 m channel and
   * the file starts to stagger. Against effective width it reads 1.51 p/m/s.
   */
  it.fails('TC12: 1.2 m opening passes 1.2–1.4 p/m/s', bandTest(1.2))

  it('TC12: 1.5 m opening passes 1.2–1.4 p/m/s', bandTest(1.5))

  it('TC12: 2.0 m opening passes 1.2–1.4 p/m/s', bandTest(2.0))
})

// ---------------------------------------------------------------------------
// TC6 — movement around a 90° corner
// ---------------------------------------------------------------------------

describe('RiMEA TC6 — movement around a 90° corner', () => {
  /**
   * Acceptance criterion (RiMEA 3.0, TC6): twenty people walking a 2 m corridor
   * with a right-angle bend round the corner without anybody passing through a
   * wall, and all of them reach the goal.
   *
   * "Inside a wall" is checked against the real footprints —
   * `collectObstaclePolygons(plan)`, the same polygons the engine rasterises and
   * hands to ORCA — with `pointInPolygon` on the agent centre, every tick, for
   * every person. Bodies are allowed to graze: a centre outside the polygon but
   * closer to it than the body radius is reported separately and tolerated up
   * to 50 mm, which is a shoulder against a wall rather than a wall passed
   * through.
   *
   * Both of those readings start at zero and only ever rise, so a scan that
   * collects nothing reports a perfect result. Replacing the polygon list with
   * an empty one leaves this test green, printing "deepest agent centre inside
   * a wall polygon 0.0000 m" — a pass that proves nothing at all. The three
   * guards below exist for that: the L really does yield six wall footprints,
   * the scan really did sample, and somebody really did walk within half a
   * metre of a wall face, so "nobody went inside one" is a statement about the
   * engine rather than about an empty loop.
   */
  it('TC6: twenty people round a right-angle bend, nobody through a wall', () => {
    const b = new PlanBuilder()
    // An L: a 10 m leg east along y ∈ [0, 2], then a 10 m leg north up
    // x ∈ [10, 12]. Both legs are 2 m wide, as the standard specifies.
    b.wall({ x: 0, y: 0 }, { x: 12, y: 0 })
    b.wall({ x: 12, y: 0 }, { x: 12, y: 12 })
    b.wall({ x: 12, y: 12 }, { x: 10, y: 12 })
    b.wall({ x: 10, y: 12 }, { x: 10, y: 2 })
    b.wall({ x: 10, y: 2 }, { x: 0, y: 2 })
    b.wall({ x: 0, y: 2 }, { x: 0, y: 0 })
    const entry = b.zone('entry', 0.4, 0.4, 1.8, 1.6, 'Start of the corridor')
    b.zone('exit', 10.4, 10.2, 11.6, 11.6, 'End of the corridor')
    const plan: Plan = b.build()

    const population = leavingPopulation(
      'rimea-tc6',
      20,
      entry,
      { kind: 'uniform', startS: 0, windowS: 10 },
      [{ profileId: 'adult', weight: 1 }],
    )
    const sim = new Simulation(plan, scenarioFor(population, 400))
    const obstacles = collectObstaclePolygons(plan)

    let deepestInsideWall = 0
    let worstBodyOverlap = 0
    let closestApproach = Infinity
    let samples = 0
    let ticks = 0

    for (let i = 0; i < 3000 && !sim.isFinished; i++) {
      sim.step(DT)
      ticks++
      const snapshot = sim.snapshot()
      for (let k = 0; k < snapshot.count; k++) {
        const point = { x: at(snapshot.agents, k, 'x'), y: at(snapshot.agents, k, 'y') }
        const radius = at(snapshot.agents, k, 'radius')
        for (const polygon of obstacles) {
          samples++
          const toEdge = distanceToPolygonEdge(point, polygon)
          if (pointInPolygon(point, polygon)) {
            deepestInsideWall = Math.max(deepestInsideWall, toEdge)
          } else {
            closestApproach = Math.min(closestApproach, toEdge)
            worstBodyOverlap = Math.max(worstBodyOverlap, radius - toEdge)
          }
        }
      }
    }

    const summary = sim.summary()
    console.warn(
      `RiMEA TC6: ${summary.completed}/${summary.totalPeople} reached the goal in ` +
        `${sim.currentTime.toFixed(1)} s over ${ticks} ticks; deepest agent centre inside a ` +
        `wall polygon ${deepestInsideWall.toFixed(4)} m (target 0), worst body-into-wall ` +
        `overlap ${worstBodyOverlap.toFixed(4)} m (tolerance 0.05 m, body radius 0.23 m); ` +
        `${samples} centre-against-footprint tests over ${obstacles.length} wall footprints, ` +
        `closest centre-to-wall ${closestApproach.toFixed(4)} m`,
    )

    // The measurement is live: six unbroken wall segments, every one of them
    // tested, and somebody hugging one closely enough for a zero to mean
    // something.
    expect(obstacles.length).toBe(6)
    expect(samples).toBeGreaterThan(0)
    expect(closestApproach).toBeLessThan(0.5)

    expect(deepestInsideWall).toBe(0)
    expect(worstBodyOverlap).toBeLessThanOrEqual(0.05)
    expect(summary.totalPeople).toBe(20)
    expect(summary.completed).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// TC7 — distribution of walking speeds
// ---------------------------------------------------------------------------

describe('RiMEA TC7 — distribution of walking speeds', () => {
  /**
   * Acceptance criterion (RiMEA 3.0, TC7): a population drawn from the
   * demographic profiles walks at the speeds those profiles specify — here,
   * each profile's mean free-flow speed within 10% of its configured mean, and
   * a spread that reflects the configured standard deviations rather than
   * everybody moving at one speed.
   *
   * Scaling: 420 people, 60 per profile, across all seven shipped
   * `AGENT_PROFILES` at equal weight. Equal weights rather than
   * `DEFAULT_PROFILE_MIX` because that mix is 2% wheelchair users, so a 10% test
   * on that profile's mean would need several thousand agents (its standard
   * error only falls below 10% of 0.89 m/s at ~5 samples, but below 3% at ~25);
   * equal weights measure every shipped profile at ~60 samples for about 1.2 s
   * of wall clock. The room is 50 m × 30 m and arrivals are spread over 60 s so
   * that people are genuinely uncongested: at 420 people in 1500 m² the mean
   * density is 0.28 persons/m², which is free flow by any table.
   *
   * A sample counts only when the engine itself says the person is unobstructed:
   * `inspect()` reports the local density, and readings above 0.4 persons/m² are
   * discarded (at 0.4 the Weidmann slowdown is 1.2%, inside the noise). Readings
   * within 4 m of the destination are discarded too, because the engine eases
   * people onto their mark over the last 1.2 m.
   */
  it('TC7: per-profile mean free-flow speeds land within 10% of their profiles', () => {
    const b = new PlanBuilder()
    b.room(0, 0, 50, 30)
    const entry = b.zone('entry', 1.0, 2.0, 5.0, 28.0, 'West end')
    b.zone('exit', 45.0, 2.0, 49.0, 28.0, 'East end')
    const plan: Plan = b.build()

    const people = 420
    const population = leavingPopulation(
      'rimea-tc7',
      people,
      entry,
      { kind: 'uniform', startS: 0, windowS: 60 },
      AGENT_PROFILES.map((profile) => ({ profileId: profile.id, weight: 1 })),
    )
    const sim = new Simulation(plan, scenarioFor(population, 600))

    const freeFlowDensity = 0.4
    const minDistanceToTarget = 4
    const perAgent = new Map<number, { profile: number; speeds: number[] }>()

    for (let i = 0; i < 2500 && !sim.isFinished; i++) {
      sim.step(DT)
      // One reading a second per person is plenty and keeps the run cheap.
      if (i % 10 !== 0) continue
      const snapshot = sim.snapshot()
      for (let k = 0; k < snapshot.count; k++) {
        const id = at(snapshot.agents, k, 'id')
        const state = sim.inspect(id)
        if (!state || state.state !== 'walking') continue
        if (state.density > freeFlowDensity) continue
        if ((state.distanceToTarget ?? 0) < minDistanceToTarget) continue
        if (state.speed < 0.05) continue
        const profile = at(snapshot.agents, k, 'profile')
        const record = perAgent.get(id) ?? { profile, speeds: [] }
        record.speeds.push(state.speed)
        perAgent.set(id, record)
      }
    }

    const byProfile = new Map<number, number[]>()
    const everyone: number[] = []
    for (const record of perAgent.values()) {
      const freeSpeed = mean(record.speeds)
      const bucket = byProfile.get(record.profile) ?? []
      bucket.push(freeSpeed)
      byProfile.set(record.profile, bucket)
      everyone.push(freeSpeed)
    }

    expect(perAgent.size).toBeGreaterThan(people * 0.9)
    expect(byProfile.size).toBe(AGENT_PROFILES.length)

    for (const [index, speeds] of [...byProfile.entries()].sort((a, c) => a[0] - c[0])) {
      const profile = AGENT_PROFILES[index]
      const measured = mean(speeds)
      const error = (measured - profile.speed.mean) / profile.speed.mean
      console.warn(
        `RiMEA TC7: ${profile.id} n=${speeds.length} measured mean ${measured.toFixed(3)} m/s ` +
          `vs configured ${profile.speed.mean.toFixed(2)} m/s (${(error * 100).toFixed(1)}%, ` +
          `tolerance ±10%); measured sd ${stdev(speeds).toFixed(3)} vs configured ` +
          `${profile.speed.sd.toFixed(2)} m/s`,
      )
      expect(speeds.length).toBeGreaterThan(20)
      expect(Math.abs(error)).toBeLessThanOrEqual(0.1)
    }

    // The mixture's standard deviation if the engine samples each profile as
    // configured: within-profile variance plus the spread of the profile means.
    const configuredMeans = AGENT_PROFILES.map((p) => p.speed.mean)
    const expectedSd = Math.sqrt(
      mean(AGENT_PROFILES.map((p) => p.speed.sd ** 2)) +
        mean(configuredMeans.map((m) => (m - mean(configuredMeans)) ** 2)),
    )
    const measuredSd = stdev(everyone)
    console.warn(
      `RiMEA TC7: overall n=${everyone.length} mean ${mean(everyone).toFixed(3)} m/s, ` +
        `sd ${measuredSd.toFixed(3)} m/s vs ${expectedSd.toFixed(3)} m/s implied by the ` +
        `configured profiles (distribution is degenerate below ${(expectedSd * 0.6).toFixed(3)})`,
    )
    // Not degenerate: a single shared speed would read 0, and a mix that
    // collapsed towards the population mean would read well under this floor.
    expect(measuredSd).toBeGreaterThanOrEqual(expectedSd * 0.6)
    expect(measuredSd).toBeLessThanOrEqual(expectedSd * 1.4)
  }, 120_000)
})

// ---------------------------------------------------------------------------
// Single-exit congestion — CROWD's own check, not a RiMEA case
// ---------------------------------------------------------------------------

interface EvacuationResult {
  total: number
  completed: number
  /** Simulated time each person left, in the order they left. */
  outAt: number[]
  maxOverlap: number
  overlapP95: number
  medianTickOverlap: number
  /** Most people at once in the 3 m of floor upstream of the door. */
  maxQueue: number
  peakDensity: number
  endTime: number
}

/**
 * Scaling: 150 people in a 16 m × 12 m room with one 1.2 m door, all present at
 * t = 0 (`all-at-once`), which is the congested case the criterion is about.
 * At ~1.3 p/s through the door the room clears in about 110 s of simulated
 * time — 1100 ticks and roughly 1.2 s of wall clock, including an all-pairs
 * overlap scan on every tick.
 */
const runSingleExitEvacuation = (): EvacuationResult => {
  const b = new PlanBuilder()
  const room = b.room(0, 0, 16, 12)
  b.door(room.east, 6, 1.2)
  const entry = b.zone('entry', 1, 1, 15, 11, 'Room floor')
  b.zone('exit', 17.2, 5.0, 18.4, 7.0, 'Outside')
  const plan: Plan = b.build()

  const people = 150
  const population = leavingPopulation(
    'rimea-tc11',
    people,
    entry,
    { kind: 'all-at-once', startS: 0, windowS: 0 },
    [{ profileId: 'adult', weight: 1 }],
  )
  const sim = new Simulation(plan, scenarioFor(population, 900))

  const outAt: number[] = []
  const tickOverlaps: number[] = []
  let reported = 0
  let maxQueue = 0

  for (let i = 0; i < 4000 && !sim.isFinished; i++) {
    sim.step(DT)
    const snapshot = sim.snapshot()
    while (reported < snapshot.stats.completed) {
      outAt.push(snapshot.time)
      reported++
    }
    let queued = 0
    for (let k = 0; k < snapshot.count; k++) {
      const x = at(snapshot.agents, k, 'x')
      const y = at(snapshot.agents, k, 'y')
      // The 3 m of room floor directly upstream of the door.
      if (x > 13 && x < 16 && y > 3 && y < 9) queued++
    }
    maxQueue = Math.max(maxQueue, queued)
    tickOverlaps.push(worstOverlap(snapshot.agents, snapshot.count))
  }

  const summary = sim.summary()
  const sorted = [...tickOverlaps].sort((a, c) => a - c)
  return {
    total: summary.totalPeople,
    completed: summary.completed,
    outAt,
    maxOverlap: quantile(sorted, 1),
    overlapP95: quantile(sorted, 0.95),
    medianTickOverlap: quantile(sorted, 0.5),
    maxQueue,
    peakDensity: summary.peakDensity,
    endTime: sim.currentTime,
  }
}

describe('Single-exit congestion', () => {
  /**
   * Two adults are 0.23 m in radius each, so their centres should stay 0.46 m
   * apart. Real crowds do compress — shoulders turn, body depth is less than
   * body width — and 0.10 m of that 0.46 m is a defensible allowance for
   * contact. Past it the model is putting two people on the same square metre
   * of floor, and every density derived from it is fiction.
   */
  const OVERLAP_TOLERANCE = 0.1

  let result: EvacuationResult

  beforeAll(() => {
    result = runSingleExitEvacuation()
    const at25 = result.outAt[Math.ceil(result.total * 0.25) - 1]
    const at50 = result.outAt[Math.ceil(result.total * 0.5) - 1]
    const at95 = result.outAt[Math.ceil(result.total * 0.95) - 1]
    console.warn(
      `Single exit: ${result.completed}/${result.total} out through one 1.2 m door — ` +
        `25% by ${at25?.toFixed(1)} s, 50% by ${at50?.toFixed(1)} s, ` +
        `95% by ${at95?.toFixed(1)} s, ` +
        `last out at ${result.outAt[result.outAt.length - 1]?.toFixed(1)} s ` +
        `(run ended ${result.endTime.toFixed(1)} s)`,
    )
    console.warn(
      `Single exit: queue peaked at ${result.maxQueue} people in the 3 m upstream of the door, ` +
        `peak density ${result.peakDensity.toFixed(2)} persons/m²; body overlap ` +
        `max ${result.maxOverlap.toFixed(3)} m, p95 ${result.overlapP95.toFixed(3)} m, ` +
        `median tick ${result.medianTickOverlap.toFixed(3)} m ` +
        `(tolerance ${OVERLAP_TOLERANCE.toFixed(2)} m on a 0.46 m pair distance)`,
    )
  }, 180_000)

  /**
   * CROWD's own criterion, stated here rather than cited: everybody gets out,
   * and they come out metered rather than all at once. RiMEA has no test case
   * for a single exit in isolation — its TC11 is escape-route *choice* between
   * two doors — so nothing below claims a clause of the standard it does not
   * have. The three criteria are still the ones that matter: a door that
   * strands people, a door with no queue behind it, and a crowd that packs
   * through itself are each a modelling failure on their own terms.
   */
  it('Single exit: all 150 people evacuate', () => {
    expect(result.total).toBe(150)
    expect(result.completed).toBe(150)
    expect(result.outAt.length).toBe(150)
    // A clearance curve, not a step: the door meters people out over time.
    expect(result.outAt[result.outAt.length - 1]).toBeGreaterThan(result.outAt[0])
  })

  /** A queue forms upstream of the exit: this is the congested case, not free flow. */
  it('Single exit: a queue forms upstream of the exit', () => {
    expect(result.maxQueue).toBeGreaterThanOrEqual(20)
    // Congestion, not free flow: Fruin walkway LOS F starts at 2.17 persons/m².
    expect(result.peakDensity).toBeGreaterThan(2.17)
  })

  /**
   * KNOWN GAP: people interpenetrate in a jam.
   *
   * Measured worst body overlap 0.377 m against a 0.10 m tolerance, on
   * a 0.46 m pair distance — at the peak two people's centres are
   * 0.083 m apart, which is one person's floor area holding two.
   * The 95th percentile of the per-tick worst overlap is 0.258 m and
   * the median 0.145 m, so this is not a single transient: for much of
   * the jam somebody is overlapping by more than the tolerance. It shows up in
   * the density too — `summary().peakDensity` reads 8.06
   * persons/m², against the 5.4 persons/m² jam density the engine's own
   * Weidmann constants assume. Everything downstream of density (level of
   * service, the crowd-safety overlay in `metrics/los`, the heat map) overstates
   * the crush at a bottleneck until this is fixed, and the per-width overlap
   * readings in the bottleneck sweep above show the same thing, so it is not
   * peculiar to this geometry.
   *
   * Where it is, as far as three experiments can place it. `relaxOverlaps` runs
   * one positional pass per step and caps each correction at 0.08 m, and it is
   * the *one pass*, not the cap, that is short: running the same pass eight
   * times a step takes the worst overlap to 0.107 m, the p95 to 0.081 and the
   * median to 0.023, and brings peak density down to 5.55 persons/m² — within
   * 0.007 m of clearing this assertion outright, at no cost in clearance time.
   * Lifting the cap instead makes it *worse* (worst overlap 0.443 m, and one
   * person never gets out), and disabling the clearance push-out at the end of
   * the same function changes nothing (0.380 m). So the fix to try is iterating
   * the projection, not widening the step.
   */
  it.fails('Single exit: no two people overlap by more than 0.10 m', () => {
    expect(result.maxOverlap).toBeLessThanOrEqual(OVERLAP_TOLERANCE)
  })
})
