import { describe, expect, it } from 'vitest'
import type { NavGrid } from './eikonal'
import { cellCenter, createNavGrid, gridIndex, sampleField, worldToCell } from './eikonal'
import type { RouteDirection } from './flowFields'
import {
  DensityField,
  FlowFieldCache,
  NOMINAL_BODY_RADIUS,
  PACE_LOOKAHEAD,
  hardCoreCorrection,
  speedFromDensity,
} from './flowFields'
import { crowdSafetyLevel } from '../metrics/los'

/** The kernel width the estimator is calibrated on, and the one the engine builds with. */
const BANDWIDTH = 0.7

const cellCount = (grid: NavGrid): number => grid.cols * grid.rows

const cellAt = (grid: NavGrid, x: number, y: number): number => {
  const { col, row } = worldToCell(grid, x, y)
  return gridIndex(grid, col, row)
}

/** A 12 m square hall at the cell size the engine defaults to. */
const hallGrid = (): NavGrid => createNavGrid({ minX: 0, minY: 0, maxX: 12, maxY: 12 }, 0.3)

/** The same hall with everything outside a horizontal corridor walled off. */
const corridorMask = (grid: NavGrid, minY: number, maxY: number): Uint8Array => {
  const blocked = new Uint8Array(cellCount(grid))
  for (let row = 0; row < grid.rows; row++) {
    const y = grid.originY + (row + 0.5) * grid.cellSize
    if (y > minY && y < maxY) continue
    for (let col = 0; col < grid.cols; col++) blocked[row * grid.cols + col] = 1
  }
  return blocked
}

/** People on a regular lattice filling a box, standing in for a uniform crowd. */
const crowd = (x0: number, y0: number, x1: number, y1: number, spacing: number): Float32Array => {
  const people: number[] = []
  for (let x = x0; x < x1; x += spacing) {
    for (let y = y0; y < y1; y += spacing) people.push(x, y)
  }
  return Float32Array.from(people)
}

const headcount = (people: Float32Array): number => people.length / 2

const meanDensity = (
  grid: NavGrid,
  values: Float32Array,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number => {
  let total = 0
  let samples = 0
  for (let x = x0; x <= x1; x += grid.cellSize) {
    for (let y = y0; y <= y1; y += grid.cellSize) {
      total += values[cellAt(grid, x, y)]
      samples++
    }
  }
  return total / samples
}

/** A 12 x 6 m room at 0.25 m cells, optionally with a wall built into it. */
const room = (
  wall?: (x: number, y: number) => boolean,
): { grid: NavGrid; cache: FlowFieldCache } => {
  const grid = createNavGrid({ minX: 0, minY: 0, maxX: 12, maxY: 6 }, 0.25)
  const blocked = new Uint8Array(cellCount(grid))
  if (wall) {
    for (let row = 0; row < grid.rows; row++) {
      const y = grid.originY + (row + 0.5) * grid.cellSize
      for (let col = 0; col < grid.cols; col++) {
        const x = grid.originX + (col + 0.5) * grid.cellSize
        if (wall(x, y)) blocked[row * grid.cols + col] = 1
      }
    }
  }
  const speed = new Float32Array(cellCount(grid)).fill(1)
  return { grid, cache: new FlowFieldCache(grid, blocked, speed) }
}

const congestionAt = (
  grid: NavGrid,
  density: number,
  inside: (x: number, y: number) => boolean,
): Float32Array => {
  const values = new Float32Array(cellCount(grid))
  for (let row = 0; row < grid.rows; row++) {
    const y = grid.originY + (row + 0.5) * grid.cellSize
    for (let col = 0; col < grid.cols; col++) {
      const x = grid.originX + (col + 0.5) * grid.cellSize
      if (inside(x, y)) values[row * grid.cols + col] = density
    }
  }
  return values
}

/** `direction` is nullable by design; these cases all expect a real heading. */
const requireRoute = (route: RouteDirection | null): RouteDirection => {
  if (!route) throw new Error('expected a heading towards the destination')
  return route
}

const refreshedAt = (cache: FlowFieldCache, id: string): number =>
  cache.get(id)?.refreshedAt ?? Number.NaN

describe('hardCoreCorrection', () => {
  it('puts back the fifth a kernel loses to bodies that cannot overlap', () => {
    const correction = hardCoreCorrection(NOMINAL_BODY_RADIUS, BANDWIDTH)
    expect(correction).toBeCloseTo(1.241, 3)
    expect(correction).toBeGreaterThan(1)
    // The Gaussian expects to find people inside the two-radius disc around
    // everybody, where nobody's centre can be. That share of its mass — 19% for
    // this body and this bandwidth — is what it comes back light by.
    expect(1 - 1 / correction).toBeCloseTo(0.194, 3)
  })

  it('grows with the body and fades as the kernel widens', () => {
    const nominal = hardCoreCorrection(NOMINAL_BODY_RADIUS, BANDWIDTH)
    expect(hardCoreCorrection(0.3, BANDWIDTH)).toBeGreaterThan(nominal)
    expect(hardCoreCorrection(NOMINAL_BODY_RADIUS, 1.4)).toBeLessThan(nominal)

    for (let radius = 0.1; radius < 0.4; radius += 0.05) {
      expect(hardCoreCorrection(radius + 0.05, BANDWIDTH)).toBeGreaterThan(
        hardCoreCorrection(radius, BANDWIDTH),
      )
    }
    for (let bandwidth = 0.4; bandwidth < 1.4; bandwidth += 0.1) {
      expect(hardCoreCorrection(NOMINAL_BODY_RADIUS, bandwidth + 0.1)).toBeLessThan(
        hardCoreCorrection(NOMINAL_BODY_RADIUS, bandwidth),
      )
    }
    // A kernel far wider than a body barely notices the hole in it.
    expect(hardCoreCorrection(NOMINAL_BODY_RADIUS, 20)).toBeCloseTo(1, 3)
  })

  it('is exactly 1 when bodies are points, and only bodies lift it off the textbook kernel', () => {
    // Nothing is excluded when nobody occupies room, so there is nothing to put
    // back and the estimator is already unbiased. A factor that came out a hair
    // off 1 here would bias every density the product reports, including the
    // heads-in-a-polygon figures printed beside them, which need no correction.
    expect(hardCoreCorrection(0, BANDWIDTH)).toBe(1)
    expect(hardCoreCorrection(0, 0.25)).toBe(1)

    const grid = hallGrid()
    const points = new DensityField(grid, BANDWIDTH, undefined, 0)
    points.update(Float32Array.from([6.15, 6.15]), 1, 0)
    // Point bodies leave the plain Gaussian peak of 1 / 2*pi*sigma^2, which is
    // the baseline the 1.24 correction is measured against.
    expect(Math.max(...points.values)).toBeCloseTo(1 / (2 * Math.PI * BANDWIDTH * BANDWIDTH), 5)
  })
})

describe('DensityField', () => {
  it('reads one person as one person, not as a cell packed with them', () => {
    const grid = hallGrid()
    const field = new DensityField(grid, BANDWIDTH)
    // Smoothing off: this is the field the estimator actually produces, not the
    // value it is converging on.
    field.update(Float32Array.from([6.15, 6.15]), 1, 0)

    let peak = 0
    let mass = 0
    for (const value of field.values) {
      if (value > peak) peak = value
      mass += value
    }
    // Counting heads per cell put this one walker at 1 / 0.09 = 11 persons/m2 —
    // LOS F, crush territory, and a walker told to stop moving in an empty hall.
    expect(peak).toBeCloseTo(0.4, 2)
    expect(speedFromDensity(peak)).toBeGreaterThan(0.95)
    // What the kernel spreads out is one person, lifted by the hard-core
    // correction and short only by the 1% tail the precomputed stamp drops.
    const carried =
      (mass * grid.cellSize * grid.cellSize) / hardCoreCorrection(NOMINAL_BODY_RADIUS, BANDWIDTH)
    expect(carried).toBeGreaterThan(0.97)
    expect(carried).toBeLessThanOrEqual(1)
  })

  it('takes a walker their own body off, so a lone walker keeps their free speed', () => {
    const grid = hallGrid()
    const field = new DensityField(grid, BANDWIDTH, corridorMask(grid, 4.5, 7.5))
    const x = 6
    const y = 4.75 // hard against the south wall, where the coverage division bites
    field.update(Float32Array.from([x, y]), 1, 0)

    // The field is right to read this: somebody standing there does occupy floor.
    const here = sampleField(grid, field.values, x, y, 0)
    expect(here).toBeGreaterThan(0.5)
    // Which is most of a level-of-service band, and used raw it slows the only
    // person in the corridor down to 94% of their free speed.
    expect(speedFromDensity(here)).toBeLessThan(0.96)

    expect(field.othersAt(x, y, here, 0)).toBeLessThan(0.02)
    const ahead = sampleField(grid, field.values, x + PACE_LOOKAHEAD, y, 0)
    expect(field.othersAt(x + PACE_LOOKAHEAD, y, ahead, PACE_LOOKAHEAD)).toBeLessThan(0.05)
    expect(speedFromDensity(field.othersAt(x + PACE_LOOKAHEAD, y, ahead, PACE_LOOKAHEAD))).toBe(1)
    // A sparse sample cannot drive the answer negative.
    expect(field.othersAt(x, y, 0.05, 0)).toBe(0)
  })

  it('leaves the crowd in, but currently shaves a neighbour with the walker', () => {
    const grid = hallGrid()
    const field = new DensityField(grid, BANDWIDTH, corridorMask(grid, 4.5, 7.5))
    const x = 6
    const y = 4.75
    field.update(Float32Array.from([x, y, x + 0.6, y]), 2, 0)
    const sampled = sampleField(grid, field.values, x, y, 0)

    const alone = new DensityField(grid, BANDWIDTH, corridorMask(grid, 4.5, 7.5))
    alone.update(Float32Array.from([x + 0.6, y]), 1, 0)
    const companionOnly = sampleField(grid, alone.values, x, y, 0)

    const others = field.othersAt(x, y, sampled, 0)
    expect(others).toBeGreaterThan(0.3)
    expect(others).toBeLessThan(sampled)
    // SUSPECTED BUG, pinned as it behaves today: `othersAt` subtracts the walker's
    // kernel *peak* for the cell they are in, while `sampled` is a bilinear read
    // at their exact sub-cell position, which is lower. The difference comes off
    // the neighbour — here the companion alone contributes 0.50 persons/m2 and
    // only 0.41 of it survives. Never fabricated crowd, but ~18% of a real one.
    expect(others).toBeLessThan(companionOnly * 0.9)
    expect(others).toBeGreaterThan(companionOnly * 0.75)
  })

  it('subtracts less of the walker the further ahead the sample sits', () => {
    const grid = hallGrid()
    const field = new DensityField(grid, BANDWIDTH, corridorMask(grid, 4.5, 7.5))
    field.update(Float32Array.from([6, 6]), 1, 0)

    const sampled = 2
    const atFeet = field.othersAt(6, 6, sampled, 0)
    const aStrideOut = field.othersAt(6, 6, sampled, PACE_LOOKAHEAD)
    const wellAhead = field.othersAt(6, 6, sampled, 1.5)
    expect(atFeet).toBeLessThan(aStrideOut)
    expect(aStrideOut).toBeLessThan(wellAhead)
    expect(wellAhead).toBeLessThan(sampled)

    // How much of the walker comes off is the kernel evaluated at the sample
    // distance — the same curve the field deposited them with, so a walker
    // reading one stride ahead takes 81% of themselves off rather than all or
    // none of it.
    const share = (sampled - aStrideOut) / (sampled - atFeet)
    expect(share).toBeCloseTo(
      Math.exp(-(PACE_LOOKAHEAD * PACE_LOOKAHEAD) / (2 * BANDWIDTH * BANDWIDTH)),
      6,
    )
  })

  it('normalises by walkable floor, so a corridor does not read thinner than a hall', () => {
    const grid = hallGrid()
    const blocked = corridorMask(grid, 4.5, 7.5)

    const hall = new DensityField(grid, BANDWIDTH)
    const inHall = crowd(0.5, 0.5, 12, 12, 1)
    hall.update(inHall, headcount(inHall), 0)

    const corridor = new DensityField(grid, BANDWIDTH, blocked)
    const bare = new DensityField(grid, BANDWIDTH)
    const inCorridor = crowd(0.5, 5, 12, 7.5, 1)
    corridor.update(inCorridor, headcount(inCorridor), 0)
    bare.update(inCorridor, headcount(inCorridor), 0)

    // Both crowds stand at one person per square metre of floor they can use.
    expect(headcount(inHall) / (12 * 12)).toBeCloseTo(1, 6)
    expect(headcount(inCorridor) / (12 * 3)).toBeCloseTo(1, 6)

    const hallMean = meanDensity(grid, hall.values, 4, 4, 8, 8)
    const corridorMean = meanDensity(grid, corridor.values, 4, 4.6, 8, 7.4)
    expect(corridorMean).toBeGreaterThan(hallMean)
    expect(corridorMean).toBeLessThan(hallMean * 1.05)

    // Against the wall — where most of a 3 m corridor's crowd is — the kernel
    // has half of itself inside the masonry. Without the division the same
    // people read a third light, which is a whole Fruin band at this density.
    const corrected = meanDensity(grid, corridor.values, 4, 4.6, 8, 4.8)
    const uncorrected = meanDensity(grid, bare.values, 4, 4.6, 8, 4.8)
    expect(uncorrected).toBeLessThan(corrected * 0.7)
    expect(corrected).toBeGreaterThan(hallMean * 0.95)
  })

  it('puts a 4 persons/m2 crush over the safety threshold rather than under it', () => {
    const grid = hallGrid()
    const packed = crowd(4, 5, 8, 7, 0.5)
    expect(headcount(packed) / (4 * 2)).toBeCloseTo(4, 6)

    const field = new DensityField(grid, BANDWIDTH)
    // The same estimator with no body to exclude: a plain kernel density.
    const plain = new DensityField(grid, BANDWIDTH, undefined, 0)
    field.update(packed, headcount(packed), 0)
    plain.update(packed, headcount(packed), 0)

    const measured = sampleField(grid, field.values, 6, 6, 0)
    const light = sampleField(grid, plain.values, 6, 6, 0)
    expect(measured).toBeCloseTo(4, 0)
    expect(measured / light).toBeCloseTo(hardCoreCorrection(NOMINAL_BODY_RADIUS, BANDWIDTH), 4)
    // This is the whole point of the correction: uncorrected, the overlay that
    // fires at 4 persons/m2 stays quiet through a crush and disagrees with the
    // heads-in-a-polygon figure printed beside it.
    expect(crowdSafetyLevel(measured)).toBe('warn')
    expect(crowdSafetyLevel(light)).toBe('safe')
  })

  it('eases towards the crowd it is given instead of snapping to it', () => {
    const grid = hallGrid()
    const field = new DensityField(grid, BANDWIDTH)
    const packed = crowd(4, 5, 8, 7, 0.5)
    field.update(packed, headcount(packed), 0)
    const full = sampleField(grid, field.values, 6, 6, 0)

    // Everybody leaves at once. A field that snapped would flip the routing
    // fields it feeds from one tick to the next; it decays instead.
    field.update(packed, 0)
    const afterOne = sampleField(grid, field.values, 6, 6, 0)
    expect(afterOne).toBeCloseTo(full * 0.35, 5)
    for (let tick = 0; tick < 6; tick++) field.update(packed, 0)
    expect(sampleField(grid, field.values, 6, 6, 0)).toBeLessThan(full * 0.01)

    field.reset()
    expect(sampleField(grid, field.values, 6, 6, 0)).toBe(0)
  })

  it('keeps one person in a cupboard at a plausible density rather than an absurd one', () => {
    const closet = createNavGrid({ minX: 0, minY: 0, maxX: 3, maxY: 3 }, 0.3)
    const solid = new Uint8Array(cellCount(closet)).fill(1)
    const pocket = cellAt(closet, 1.5, 1.5)
    solid[pocket] = 0
    const field = new DensityField(closet, BANDWIDTH, solid)
    field.update(Float32Array.from([1.65, 1.65]), 1, 0)

    const hall = new DensityField(hallGrid(), BANDWIDTH)
    hall.update(Float32Array.from([6.15, 6.15]), 1, 0)
    const openPeak = Math.max(...hall.values)

    // Three percent of this kernel lands on floor anybody can stand on, and
    // dividing by that reports one person alone in a lift as 13.6 persons/m² —
    // past jam density, the crush overlay firing on somebody standing by
    // themselves. The floor on the division holds them to three and a bit times
    // their open-floor peak instead.
    expect(field.values[pocket]).toBeCloseTo(openPeak / 0.3, 5)
    expect(field.values[pocket]).toBeLessThan(1.4)
    expect(crowdSafetyLevel(field.values[pocket])).toBe('safe')
  })

  it('leaves the reading as it stands for a walker who is off the grid', () => {
    const grid = hallGrid()
    const field = new DensityField(grid, BANDWIDTH)
    field.update(Float32Array.from([6, 6]), 1, 0)

    // Somebody outside the nav grid has no coverage cell to scale their own
    // body by, so the sample survives untouched instead of coming back NaN and
    // poisoning the speed they are given.
    expect(field.othersAt(-3, 6, 2.5, 0)).toBe(2.5)
    expect(field.othersAt(6, 40, 2.5, PACE_LOOKAHEAD)).toBe(2.5)
  })
})

describe('PACE_LOOKAHEAD', () => {
  it('reads one body ahead, from inside the kernel that does the reading', () => {
    expect(PACE_LOOKAHEAD).toBeGreaterThan(0)
    expect(PACE_LOOKAHEAD).toBeCloseTo(2 * NOMINAL_BODY_RADIUS, 1)
    // Reaching past the bandwidth is what breaks doorways: people in the opening
    // see the clear floor beyond it, walk through at nearly free speed, and the
    // door passes 30% more than a real one.
    expect(PACE_LOOKAHEAD).toBeLessThan(BANDWIDTH)
    // And close enough in that most of the walker still comes off the reading,
    // which is what keeps a lone walker at free speed.
    const own = Math.exp(-(PACE_LOOKAHEAD * PACE_LOOKAHEAD) / (2 * BANDWIDTH * BANDWIDTH))
    expect(own).toBeGreaterThan(0.6)
    expect(own).toBeLessThan(0.95)
  })

  it('reads the floor a walker is heading into, not the bunch at their back', () => {
    const grid = hallGrid()
    const field = new DensityField(grid, BANDWIDTH, corridorMask(grid, 4.5, 7.5))
    // Somebody at the front of a bunch: twenty people packed half a metre apart
    // behind them, open corridor ahead.
    const bunch = crowd(4, 5, 5.6, 7.1, 0.5)
    const people = Float32Array.from([6, 6, ...bunch])
    field.update(people, headcount(people), 0)

    const read = (x: number, distance: number): number =>
      field.othersAt(x, 6, sampleField(grid, field.values, x, 6, 0), distance)
    const ahead = read(6 + PACE_LOOKAHEAD, PACE_LOOKAHEAD)
    const ring = read(6, 0)
    const behind = read(6 - PACE_LOOKAHEAD, PACE_LOOKAHEAD)

    expect(ahead).toBeCloseTo(0.79, 1)
    expect(ring).toBeCloseTo(1.73, 1)
    expect(behind).toBeCloseTo(2.92, 1)
    // Same walker, same instant, and the same amount of their own body taken
    // off both readings: the whole of the gap is where the sample was taken.
    expect(behind - ahead).toBeCloseTo(
      sampleField(grid, field.values, 6 - PACE_LOOKAHEAD, 6, 0) -
        sampleField(grid, field.values, 6 + PACE_LOOKAHEAD, 6, 0),
      9,
    )

    // And that is what sets the pace. Reading forward, this walker keeps seven
    // eighths of their free speed and pulls away from the bunch, which is what
    // dissolves it. A ring would halve their speed on the strength of people
    // who are behind them, closing the gap and packing the bunch tighter — the
    // loop with the sign the wrong way round that clots a steady corridor into
    // platoons, each reporting a density nobody in it is actually walking in.
    expect(speedFromDensity(ahead)).toBeGreaterThan(0.85)
    expect(speedFromDensity(ring)).toBeLessThan(0.55)
    expect(speedFromDensity(behind)).toBeLessThan(0.3)
  })
})

describe('FlowFieldCache', () => {
  it('heads for the destination and costs the walk to it', () => {
    const { grid, cache } = room()
    const goalCell = cellAt(grid, 11.5, 3)
    cache.ensure('east', [goalCell])
    const goal = cellCenter(grid, goalCell % grid.cols, Math.floor(goalCell / grid.cols))

    // Off the centre line, so a field that merely ran along the grid axes would
    // not pass: the heading has to point at the goal, not just east.
    const from = { x: 6, y: 1 }
    const route = requireRoute(cache.direction('east', from, 0))
    const bearing = Math.atan2(goal.y - from.y, goal.x - from.x)
    // Within a few degrees of the true bearing. A Dijkstra flood would quantise
    // this to the nearest 45 degrees and miss by ten times as much.
    expect(Math.abs(Math.atan2(route.dy, route.dx) - bearing)).toBeLessThan(0.1)

    const far = cache.cost('east', { x: 1, y: 3 })
    const middle = cache.cost('east', { x: 6, y: 3 })
    const near = cache.cost('east', { x: 11, y: 3 })
    expect(far).toBeGreaterThan(middle)
    expect(middle).toBeGreaterThan(near)
    // Unit traversal speed, open floor: the cost is the straight-line walk.
    expect(far).toBeCloseTo(Math.hypot(goal.x - 1, goal.y - 3), 1)
    // Across a diagonal the marching solve reads a couple of percent long. It
    // matters which way the residual goes: long means a route never looks
    // cheaper than walking it is, so a door-choice never flatters itself.
    const straight = Math.hypot(goal.x - from.x, goal.y - from.y)
    expect(route.cost / straight).toBeGreaterThanOrEqual(1)
    expect(route.cost / straight).toBeLessThan(1.03)
  })

  it('says a sealed-off destination costs Infinity rather than guessing', () => {
    // One cell of wall is enough: the solver relaxes four neighbours, so nothing
    // leaks diagonally through it.
    const { grid, cache } = room((x) => x > 5.9 && x < 6.2)
    cache.ensure('east', [cellAt(grid, 11.5, 3)])

    expect(cache.cost('east', { x: 2, y: 3 })).toBe(Infinity)
    expect(cache.direction('east', { x: 2, y: 3 }, 0)).toBeNull()
    expect(cache.cost('east', { x: 8, y: 3 })).toBeLessThan(5)

    // A destination nobody registered is unreachable too — not free, and not a crash.
    expect(cache.cost('nowhere', { x: 8, y: 3 })).toBe(Infinity)
    expect(cache.direction('nowhere', { x: 8, y: 3 }, 1)).toBeNull()
  })

  it('bends around a crowd once density is fed in, and not before', () => {
    // Two doors through one wall. The walker starts level with the south door,
    // which is the shortest way through by a clear margin.
    const { grid, cache } = room(
      (x, y) => x > 5.9 && x < 6.2 && !(y > 1 && y < 2) && !(y > 4 && y < 5),
    )
    cache.ensure('east', [cellAt(grid, 11.5, 3)])
    const from = { x: 2, y: 1.5 }

    const shortest = requireRoute(cache.direction('east', from, 0))
    const staticCost = cache.cost('east', from, 0)
    expect(shortest.dx).toBeGreaterThan(0.9)
    // Awareness buys nothing until a congested field has been solved at least
    // once; before that the two potentials are the same array's worth of numbers.
    expect(cache.cost('east', from, 1)).toBe(staticCost)
    expect(requireRoute(cache.direction('east', from, 1)).dy).toBeCloseTo(shortest.dy, 12)

    const jam = congestionAt(grid, 5, (x, y) => x > 4.5 && x < 7.5 && y < 3)
    cache.update(10, jam)

    const aware = requireRoute(cache.direction('east', from, 1))
    // The whole point of carrying two potentials: same walker, same instant, a
    // route that splits away from the queue rather than joining it.
    expect(aware.dy).toBeGreaterThan(shortest.dy + 0.3)
    expect(cache.cost('east', from, 1)).toBeGreaterThan(staticCost * 1.05)
    // Half-aware people sit between the two, which is what produces a split
    // rather than everybody swapping doors at once.
    const half = cache.cost('east', from, 0.5)
    expect(half).toBeGreaterThan(staticCost)
    expect(half).toBeLessThan(cache.cost('east', from, 1))
    // The shortest-path field is not touched by any of this.
    expect(cache.cost('east', from, 0)).toBe(staticCost)
  })

  it('refreshes the most overdue fields first, a budget at a time', () => {
    const { grid, cache } = room()
    cache.ensure('a', [cellAt(grid, 11.5, 3)])
    cache.ensure('b', [cellAt(grid, 0.5, 3)])
    cache.ensure('c', [cellAt(grid, 6, 0.5)])
    const jam = congestionAt(grid, 4, (x) => x > 5 && x < 7)

    // Default budget is two per tick, so a third destination waits a tick.
    cache.update(10, jam)
    expect(refreshedAt(cache, 'a')).toBe(10)
    expect(refreshedAt(cache, 'b')).toBe(10)
    expect(refreshedAt(cache, 'c')).toBe(-Infinity)

    // Oldest first: the destination that has never been solved goes next tick,
    // ahead of the two that just ran — and those two are inside the replan
    // interval, so they do not re-solve on every tick to keep it company.
    cache.update(10.5, jam)
    expect(refreshedAt(cache, 'c')).toBe(10.5)
    expect(refreshedAt(cache, 'a')).toBe(10)

    // Two ticks later the first pair is overdue and the newcomer is not.
    cache.update(12, jam)
    expect(refreshedAt(cache, 'a')).toBe(12)
    expect(refreshedAt(cache, 'b')).toBe(12)
    expect(refreshedAt(cache, 'c')).toBe(10.5)

    cache.retain(new Set(['a']))
    expect(cache.size).toBe(1)
    expect(cache.has('b')).toBe(false)
    // A dropped destination stops consuming the budget entirely.
    cache.update(20, jam)
    expect(refreshedAt(cache, 'a')).toBe(20)
    expect(refreshedAt(cache, 'c')).toBeNaN()
  })

  it('counts a clear corridor down a second per metre, without a step anywhere along it', () => {
    const { grid, cache } = room((_x, y) => y < 2 || y > 4)
    const goalCell = cellAt(grid, 11.5, 3)
    cache.ensure('east', [goalCell])
    const goal = cellCenter(grid, goalCell % grid.cols, Math.floor(goalCell / grid.cols))

    let previous = Infinity
    let samples = 0
    for (let x = 0.4; x <= goal.x; x += 0.05) {
      const cost = cache.cost('east', { x, y: 3 })
      expect(cost).toBeLessThan(previous)
      // Traversal speed is 1 m/s here, so five centimetres of corridor is fifty
      // milliseconds of cost — at every sub-cell position, not only at cell
      // centres. A walker descending this field crosses cell boundaries all the
      // way down it and must not feel one. The last couple of metres are left
      // out of the even count-down: the analytic disc seeded around the goal
      // flattens the cone there, and the field still falls, just not by 50 ms a
      // step.
      if (samples > 0 && x < 9) expect(previous - cost).toBeCloseTo(0.05, 3)
      previous = cost
      samples++
    }
    expect(samples).toBeGreaterThan(200)
    // Eleven metres of corridor, and the marching solve reads a tenth of a
    // percent long over the whole of it — and long rather than short, so a door
    // this far off never flatters itself against a nearer one.
    const straight = goal.x - 0.4
    expect(cache.cost('east', { x: 0.4, y: 3 })).toBeGreaterThanOrEqual(straight)
    expect(cache.cost('east', { x: 0.4, y: 3 }) / straight).toBeLessThan(1.001)

    // Past the destination the walk costs more again, so somebody who overshoots
    // is turned round rather than sent on to the far wall.
    expect(cache.cost('east', { x: goal.x + 0.3, y: 3 })).toBeGreaterThan(previous)
  })

  it('has no direction left to give once somebody is standing on the destination', () => {
    const { grid, cache } = room()
    const goalCell = cellAt(grid, 11.5, 3)
    cache.ensure('east', [goalCell])
    const goal = cellCenter(grid, goalCell % grid.cols, Math.floor(goalCell / grid.cols))

    // The potential is flat at its own minimum. A normalised gradient there is
    // noise, so the cache says nothing and the caller steers at the exact spot
    // it was aiming for instead of being shoved in whichever way the float went.
    expect(cache.direction('east', goal, 0)).toBeNull()
    // Nothing left to walk, either: they are standing on it.
    expect(cache.cost('east', goal)).toBe(0)
    const approach = requireRoute(cache.direction('east', { x: goal.x - 1, y: goal.y }, 0))
    expect(approach.dx).toBeCloseTo(1, 2)
    expect(approach.cost).toBeCloseTo(1, 1)

    // Off the grid entirely — pushed outside the venue bounds — is unreachable,
    // not nearby.
    expect(cache.cost('east', { x: 40, y: 3 })).toBe(Infinity)
    expect(cache.direction('east', { x: 40, y: 3 }, 1)).toBeNull()
  })

  it('hands back the field it already solved instead of solving it again', () => {
    const { grid, cache } = room()
    const field = cache.ensure('east', [cellAt(grid, 11.5, 3)])
    const potential = field.staticPotential
    // The two potentials start as separate arrays, so a congested re-solve can
    // never clobber the shortest path everybody else is following.
    expect(field.congestedPotential).not.toBe(potential)

    // Registering the destination again is what a venue with a dozen of them
    // does on every setup pass: it gets the field back, not another solve.
    const again = cache.ensure('east', [cellAt(grid, 0.5, 3)])
    expect(again).toBe(field)
    expect(again.staticPotential).toBe(potential)
    // Including the goal it was solved for — a re-registration is a lookup, and
    // the new cells are ignored.
    expect(again.goalCells).toEqual([cellAt(grid, 11.5, 3)])

    cache.cost('east', { x: 3, y: 3 }, 1)
    cache.direction('east', { x: 3, y: 3 }, 1)
    expect(cache.get('east')?.staticPotential).toBe(potential)

    const jam = congestionAt(grid, 4, (x) => x > 5 && x < 7)
    cache.update(10, jam)
    const congested = field.congestedPotential
    expect(congested).not.toBe(potential)

    // Inside the two-second replan interval nothing is re-solved at all: this is
    // the budget that keeps a tick from turning into a dozen eikonal solves.
    cache.update(11.5, jam)
    expect(field.congestedPotential).toBe(congested)
    expect(field.refreshedAt).toBe(10)

    // When it does come due, only the congested field is rebuilt.
    cache.update(12.5, jam)
    expect(field.congestedPotential).not.toBe(congested)
    expect(field.staticPotential).toBe(potential)
    expect(field.refreshedAt).toBe(12.5)
  })

  it('never solves a congested field for a scenario with congestion switched off', () => {
    const { grid, cache } = room()
    cache.setOptions({ congestionWeight: 0 })
    const field = cache.ensure('east', [cellAt(grid, 11.5, 3)])
    const congested = field.congestedPotential

    cache.update(
      100,
      congestionAt(grid, 5, () => true),
    )
    expect(field.congestedPotential).toBe(congested)
    expect(field.refreshedAt).toBe(-Infinity)
    // Congestion-aware people get the empty-venue answer, because that is the
    // only one this run has — never a stale one dressed up as current.
    expect(cache.cost('east', { x: 6, y: 3 }, 1)).toBe(cache.cost('east', { x: 6, y: 3 }, 0))
  })
})
