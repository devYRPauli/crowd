/**
 * The neighbour index the crowd runs on.
 *
 * Everything that asks "who is near me" goes through here: the neighbour list
 * ORCA steers by, contact resolution, and the clearance check that keeps an
 * arriving person off somebody's head. The contract lets the hash be generous —
 * it works in whole cells, so a query may visit items slightly outside the
 * radius — but it is never allowed to be stingy. A missed neighbour is a pair
 * of people who walk through each other, and because the hash is rebuilt from
 * scratch every tick, a miss shows up as a one-frame glitch that is near
 * impossible to reproduce by hand.
 *
 * So the load-bearing test here is a brute-force scan. It is paired with a
 * tightness check on purpose: on its own, a query that simply visited every
 * cell would sail through the miss test, and that is exactly the regression a
 * "just widen the search" fix would introduce.
 */

import { describe, expect, it } from 'vitest'
import { SpatialHash } from './spatialHash'
import { Rng } from '../core/math/random'

interface Point {
  x: number
  y: number
}

interface Extent {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** The two-pass build the engine performs every tick, in the same order. */
const load = (hash: SpatialHash, points: readonly Point[], extent: Extent): void => {
  hash.reset(extent.minX, extent.minY, extent.maxX, extent.maxY, Math.max(1, points.length))
  for (const p of points) hash.countAt(p.x, p.y)
  hash.finalize()
  points.forEach((p, id) => hash.placeAt(p.x, p.y, id))
}

const build = (cellSize: number, points: readonly Point[], extent: Extent): SpatialHash => {
  const hash = new SpatialHash(cellSize)
  load(hash, points, extent)
  return hash
}

const collect = (hash: SpatialHash, x: number, y: number, radius: number): number[] => {
  const ids: number[] = []
  hash.query(x, y, radius, (id) => ids.push(id))
  return ids
}

const sorted = (ids: readonly number[]): number[] => [...ids].sort((a, b) => a - b)

const everyone = (n: number): number[] => Array.from({ length: n }, (_, id) => id)

/** Brute force: the answer the hash is only ever allowed to be a superset of. */
const trulyWithin = (
  points: readonly Point[],
  x: number,
  y: number,
  radius: number,
): Set<number> => {
  const ids = new Set<number>()
  points.forEach((p, id) => {
    const dx = p.x - x
    const dy = p.y - y
    if (dx * dx + dy * dy <= radius * radius) ids.add(id)
  })
  return ids
}

const scatter = (rng: Rng, n: number, extent: Extent): Point[] =>
  Array.from({ length: n }, () => ({
    x: rng.uniform(extent.minX, extent.maxX),
    y: rng.uniform(extent.minY, extent.maxY),
  }))

interface Miss {
  radius: number
  atX: number
  atY: number
  id: number
  distance: number
}

interface Sweep {
  /** Everyone the brute-force scan found and the hash did not. */
  misses: Miss[]
  /** What brute force found: how much work the hash was actually given. */
  expected: number
  /** What the hash visited, which is what any claim about tightness reads. */
  returned: number
}

const sweepAt = (
  hash: SpatialHash,
  points: readonly Point[],
  probe: Point,
  radius: number,
): Sweep => {
  const visited = collect(hash, probe.x, probe.y, radius)
  const returned = new Set(visited)
  const expected = trulyWithin(points, probe.x, probe.y, radius)
  const misses: Miss[] = []
  for (const id of expected) {
    if (!returned.has(id)) {
      misses.push({
        radius,
        atX: probe.x,
        atY: probe.y,
        id,
        distance: Math.hypot(points[id].x - probe.x, points[id].y - probe.y),
      })
    }
  }
  return { misses, expected: expected.size, returned: visited.length }
}

const CELL = 1.5
/** Forty by twenty-five metres: a hall, in the coordinates a centred plan uses. */
const HALL: Extent = { minX: -12, minY: -8, maxX: 28, maxY: 17 }

describe('the neighbour index', () => {
  it('finds everyone a brute-force scan finds, at radii either side of the cell size', () => {
    const rng = new Rng('spatial-hash-radii')
    const points = scatter(rng, 400, HALL)
    const hash = build(CELL, points, HALL)

    const probes: Point[] = [
      // The engine only ever asks from where somebody is standing, so most of
      // the probes are people rather than arbitrary coordinates.
      ...points.slice(0, 80),
      ...scatter(rng, 120, HALL),
      // On the cell lines, on both extent corners, and well outside the hall,
      // where the grid has to clamp the query into its border cells.
      ...Array.from({ length: 17 }, (_, k) => ({
        x: HALL.minX + k * CELL,
        y: HALL.minY + k * CELL,
      })),
      { x: HALL.minX, y: HALL.minY },
      { x: HALL.maxX, y: HALL.maxY },
      { x: HALL.minX - 9, y: HALL.minY - 9 },
      { x: HALL.maxX + 40, y: 0 },
    ]

    const sweep = (radius: number): Sweep => {
      const total: Sweep = { misses: [], expected: 0, returned: 0 }
      for (const probe of probes) {
        const result = sweepAt(hash, points, probe, radius)
        total.misses.push(...result.misses)
        total.expected += result.expected
        total.returned += result.returned
      }
      return total
    }

    const touching = sweep(0.2)
    const halfCell = sweep(CELL / 2)
    const oneCell = sweep(CELL)
    const neighbourRange = sweep(5)
    const wholeHall = sweep(CELL * 20)

    expect(
      [touching, halfCell, oneCell, neighbourRange, wholeHall].flatMap((s) => s.misses),
    ).toEqual([])

    // Eighty of the probes are people, so they find themselves whatever the
    // hash does. The scan only means anything if the tightest radius had real
    // pairs on top of that, and the widest had most of the hall to sweep.
    expect(touching.expected).toBeGreaterThan(80)
    expect(wholeHall.expected).toBeGreaterThan(20000)
    // The other direction, cheaply: a query that had given up and walked the
    // whole grid would hand all 400 people back to every one of these probes.
    expect(touching.returned).toBeLessThan(points.length * probes.length * 0.02)
  })

  it('misses nobody whatever the venue and the cell size', () => {
    const rng = new Rng('spatial-hash-brute-force')
    const misses: Miss[] = []
    let expected = 0

    for (let trial = 0; trial < 200; trial++) {
      const minX = rng.uniform(-30, 10)
      const minY = rng.uniform(-30, 10)
      const extent: Extent = {
        minX,
        minY,
        maxX: minX + rng.uniform(0.5, 40),
        maxY: minY + rng.uniform(0.5, 40),
      }
      // Cell size deliberately ranges either side of the query radius: the
      // engine sizes it to the neighbour range, but nothing enforces that.
      const cellSize = rng.uniform(0.2, 8)
      const points = scatter(rng, rng.int(0, 60), extent)
      const hash = build(cellSize, points, extent)

      for (let q = 0; q < 10; q++) {
        const probe = {
          x: rng.uniform(extent.minX, extent.maxX),
          y: rng.uniform(extent.minY, extent.maxY),
        }
        const result = sweepAt(hash, points, probe, rng.uniform(0, cellSize * 2))
        misses.push(...result.misses)
        expected += result.expected
      }
    }

    expect(misses).toEqual([])
    expect(expected).toBeGreaterThan(1000)
  })

  it('stays close to the radius instead of visiting the whole grid', () => {
    const rng = new Rng('spatial-hash-tightness')
    const extent: Extent = { minX: 0, minY: 0, maxX: 40, maxY: 40 }
    let returnedTotal = 0

    for (let trial = 0; trial < 100; trial++) {
      const cellSize = rng.uniform(0.5, 3)
      const points = scatter(rng, 200, extent)
      const hash = build(cellSize, points, extent)

      for (let q = 0; q < 6; q++) {
        const x = rng.uniform(0, 40)
        const y = rng.uniform(0, 40)
        const radius = rng.uniform(0, cellSize * 4)
        for (const id of collect(hash, x, y, radius)) {
          returnedTotal++
          // A cell-aligned box can overshoot by at most one cell per axis. An
          // implementation that gave up and scanned every cell would blow this
          // by an order of magnitude while still passing the no-miss test.
          expect(Math.abs(points[id].x - x)).toBeLessThanOrEqual(radius + cellSize)
          expect(Math.abs(points[id].y - y)).toBeLessThanOrEqual(radius + cellSize)
        }
      }
    }

    expect(returnedTotal).toBeGreaterThan(1000)
  })

  it('reports each person once, and everybody, when a query sweeps the venue', () => {
    const rng = new Rng('spatial-hash-sweep')
    const extent: Extent = { minX: -5, minY: -5, maxX: 5, maxY: 5 }
    // Coincident coordinates are normal — people queue shoulder to shoulder —
    // and the counting-sort layout has to keep one slot per person regardless.
    const points = [
      ...scatter(rng, 300, extent),
      ...Array.from({ length: 12 }, () => ({ x: 1.25, y: -3 })),
    ]
    const hash = build(0.4, points, extent)

    // Wide enough to sweep every cell in the grid, which is where a duplicate
    // would surface if a cell were ever visited twice.
    const ids = collect(hash, 0, 0, 50)
    expect(ids.length).toBe(points.length)
    expect(sorted(ids)).toEqual(everyone(points.length))
  })

  it('works the same in a venue laid out entirely in negative coordinates', () => {
    const rng = new Rng('spatial-hash-negative')
    const extent: Extent = { minX: -64, minY: -41, maxX: -24, maxY: -9 }
    const points = scatter(rng, 300, extent)
    const hash = build(2, points, extent)

    const misses: Miss[] = []
    let expected = 0
    for (const radius of [0.4, 2, 9]) {
      for (const probe of [...points.slice(0, 60), ...scatter(rng, 40, extent)]) {
        const result = sweepAt(hash, points, probe, radius)
        misses.push(...result.misses)
        expected += result.expected
      }
    }

    expect(misses).toEqual([])
    expect(expected).toBeGreaterThan(300)
    // Truncating towards zero instead of flooring would fold the left-hand
    // columns onto each other, so a query on one side of the hall would answer
    // with people from the other.
    for (const id of collect(hash, -60, -38, 1)) {
      expect(Math.abs(points[id].x + 60)).toBeLessThanOrEqual(3)
      expect(Math.abs(points[id].y + 38)).toBeLessThanOrEqual(3)
    }
  })

  it('hands back the ids it was given, however sparse they are', () => {
    // The engine indexes by agent id, not by position in the crowd: it places
    // whatever is in `live`, which fills with holes as people leave. An index
    // that quietly assumed 0..n-1 would look right on a full venue and hand
    // ORCA the wrong people as it emptied.
    const extent: Extent = { minX: 0, minY: 0, maxX: 40, maxY: 40 }
    const crowd = [
      { x: 1, y: 1, id: 7 },
      { x: 1.2, y: 1.1, id: 1204 },
      { x: 38, y: 38, id: 3 },
      { x: 20, y: 20, id: 2147483647 },
    ]
    const hash = new SpatialHash(2)
    hash.reset(extent.minX, extent.minY, extent.maxX, extent.maxY, crowd.length)
    for (const p of crowd) hash.countAt(p.x, p.y)
    hash.finalize()
    for (const p of crowd) hash.placeAt(p.x, p.y, p.id)

    expect(sorted(collect(hash, 1, 1, 1))).toEqual([7, 1204])
    expect(collect(hash, 38, 38, 0.5)).toEqual([3])
    // Entries live in an Int32Array, so the largest id that fits has to come
    // back intact rather than wrapping round to a negative one.
    expect(collect(hash, 20, 20, 0.5)).toEqual([2147483647])
    expect(sorted(collect(hash, 20, 20, 100))).toEqual([3, 7, 1204, 2147483647])
  })
})

describe('cell boundaries', () => {
  it('finds the neighbour on the far side of a cell boundary', () => {
    // Two people a micron apart across a cell line is the case the structure
    // exists to get right: miss it and they walk through each other.
    const eps = 1e-6
    for (const cellSize of [1, 0.7, 2.5]) {
      const extent: Extent = { minX: 0, minY: 0, maxX: 10, maxY: 10 }
      const points: Point[] = []
      for (let k = 1; k * cellSize < 10; k++) {
        points.push({ x: k * cellSize - eps, y: 5 }, { x: k * cellSize + eps, y: 5 })
      }
      const hash = build(cellSize, points, extent)

      points.forEach((p, id) => {
        // Asked from where each of the pair stands, which is the only way the
        // engine ever asks — not from the line between them.
        const ids = collect(hash, p.x, p.y, eps * 4)
        expect(ids).toContain(id)
        expect(ids).toContain(id % 2 === 0 ? id + 1 : id - 1)
      })
    }
  })

  it('finds somebody standing exactly on a cell line, from either side of it', () => {
    // Placement and lookup share one cell function, so a person on the line is
    // wherever that function puts them — what must hold is that a query from
    // either neighbouring cell still reaches them.
    for (const cellSize of [1, 0.3, 2]) {
      const extent: Extent = { minX: 0, minY: 0, maxX: 12, maxY: 12 }
      const onLines = Array.from({ length: 6 }, (_, k) => ({
        x: (k + 1) * cellSize,
        y: (k + 1) * cellSize,
      }))
      const hash = build(cellSize, onLines, extent)

      onLines.forEach((p, id) => {
        const step = cellSize * 0.4
        expect(collect(hash, p.x - step, p.y - step, cellSize)).toContain(id)
        expect(collect(hash, p.x + step, p.y + step, cellSize)).toContain(id)
        expect(collect(hash, p.x, p.y, 0)).toContain(id)
      })
    }
  })

  it('finds all four neighbours around a grid corner', () => {
    const eps = 1e-4
    const corners: Point[] = [
      { x: 3 - eps, y: 3 - eps },
      { x: 3 + eps, y: 3 - eps },
      { x: 3 - eps, y: 3 + eps },
      { x: 3 + eps, y: 3 + eps },
    ]
    const hash = build(1, corners, { minX: 0, minY: 0, maxX: 10, maxY: 10 })
    expect(sorted(collect(hash, 3, 3, eps * 4))).toEqual([0, 1, 2, 3])
  })
})

describe('rebuilding every tick', () => {
  it('answers with the crowd on the floor now, however big the last one was', () => {
    const extent: Extent = { minX: 0, minY: 0, maxX: 30, maxY: 30 }
    const rng = new Rng('spatial-hash-frames')
    const hash = new SpatialHash(2)
    load(hash, scatter(rng, 240, extent), extent)
    expect(collect(hash, 15, 15, 100)).toHaveLength(240)

    // The tick after nearly everyone has left. The entry array still physically
    // holds the 240 ids from the frame before, so anything that trusted its
    // contents rather than this frame's counts would hand ORCA people who have
    // gone home — and index `agents` with ids that are no longer live.
    const remaining: Point[] = [
      { x: 4, y: 4 },
      { x: 4.2, y: 4.1 },
      { x: 27, y: 28 },
    ]
    load(hash, remaining, extent)

    expect(sorted(collect(hash, 15, 15, 100))).toEqual([0, 1, 2])
    expect(collect(hash, 4.1, 4.05, 0.3)).toContain(0)
    expect(collect(hash, 27, 28, 0.5)).toEqual([2])
    for (const probe of [
      { x: 0, y: 0 },
      { x: 4, y: 4 },
      { x: 15, y: 15 },
      { x: 30, y: 30 },
    ]) {
      for (const id of collect(hash, probe.x, probe.y, 12)) expect(id).toBeLessThan(3)
    }
  })

  it('forgets the last tick even when there is nobody left to rebuild with', () => {
    const extent: Extent = { minX: 0, minY: 0, maxX: 10, maxY: 10 }
    const rng = new Rng('spatial-hash-reset')
    const hash = build(1, scatter(rng, 50, extent), extent)
    expect(collect(hash, 5, 5, 100)).toHaveLength(50)

    // A reset with no rebuild behind it is what a tick looks like when every
    // agent has left: it must answer nothing, not the last tick's crowd.
    hash.reset(extent.minX, extent.minY, extent.maxX, extent.maxY, 1)
    expect(collect(hash, 5, 5, 100)).toEqual([])

    load(hash, [{ x: 9, y: 9 }], extent)
    expect(collect(hash, 5, 5, 100)).toEqual([0])
  })

  it('does not leak stale ids when the grid shrinks and grows again', () => {
    // The cell arrays are only reallocated when they grow, so a shrinking
    // extent reuses counts written for a different grid. That is the branch
    // where a stale count would resurrect ids from a previous tick.
    const rng = new Rng('spatial-hash-reuse')
    const hash = new SpatialHash(1.5)
    const misses: Miss[] = []
    const strangers: number[] = []

    for (let trial = 0; trial < 150; trial++) {
      const extent: Extent = {
        minX: 0,
        minY: 0,
        maxX: rng.uniform(1, 60),
        maxY: rng.uniform(1, 60),
      }
      const points = scatter(rng, rng.int(0, 50), extent)
      load(hash, points, extent)

      for (let q = 0; q < 5; q++) {
        const probe = {
          x: rng.uniform(extent.minX, extent.maxX),
          y: rng.uniform(extent.minY, extent.maxY),
        }
        const radius = rng.uniform(0, 4)
        for (const id of collect(hash, probe.x, probe.y, radius)) {
          if (!Number.isInteger(id) || id < 0 || id >= points.length) strangers.push(id)
        }
        misses.push(...sweepAt(hash, points, probe, radius).misses)
      }
    }

    expect(strangers).toEqual([])
    expect(misses).toEqual([])
  })
})

describe('degenerate crowds', () => {
  it('answers nothing before it has ever been reset', () => {
    // Until the first reset the grid has no cells at all and the typed arrays
    // behind it are empty. Asking anyway has to come back empty-handed rather
    // than reading off the end of them.
    const hash = new SpatialHash(1)
    expect(collect(hash, 0, 0, 5)).toEqual([])
  })

  it('answers nothing when the venue is empty', () => {
    const hash = new SpatialHash(1)
    load(hash, [], { minX: 0, minY: 0, maxX: 20, maxY: 20 })
    expect(collect(hash, 10, 10, 1000)).toEqual([])
    expect(collect(hash, -400, 900, 0)).toEqual([])
  })

  it('finds the only person in the venue, and not from across it', () => {
    const extent: Extent = { minX: 0, minY: 0, maxX: 50, maxY: 50 }
    const hash = build(4, [{ x: 31.5, y: 12.25 }], extent)

    expect(collect(hash, 31.5, 12.25, 0)).toEqual([0])
    expect(collect(hash, 30, 13, 5)).toEqual([0])
    expect(collect(hash, 25, 25, 200)).toEqual([0])
    expect(collect(hash, 5, 45, 4)).toEqual([])
  })

  it('returns the whole huddle when everybody is standing on one spot', () => {
    const spot = { x: 2.5, y: -1.25 }
    const extent: Extent = { minX: -5, minY: -5, maxX: 15, maxY: 15 }
    // Sixty-four people on one coordinate is what a crush looks like before
    // contact resolution has prised anyone apart: the counting-sort layout owes
    // a slot per person, not one per position.
    const crowd = [...Array.from({ length: 64 }, () => ({ ...spot })), { x: 12, y: 12 }]
    const hash = build(1, crowd, extent)

    // Zero radius is contact resolution's "who else is exactly here".
    expect(sorted(collect(hash, spot.x, spot.y, 0))).toEqual(everyone(64))
    expect(sorted(collect(hash, spot.x + 0.4, spot.y - 0.3, 0.6))).toEqual(everyone(64))
    expect(collect(hash, 12, 12, 0)).toEqual([64])
    expect(collect(hash, 7, 7, 1)).toEqual([])
  })

  it('keeps people who drift outside the extent', () => {
    // Contact resolution can push somebody past the world bounds. Such a person
    // is clamped into the border cell rather than dropped, so a query out there
    // still finds them and they can be pushed back.
    const extent: Extent = { minX: 0, minY: 0, maxX: 10, maxY: 10 }
    const hash = build(
      2,
      [
        { x: 5, y: 5 },
        { x: 20, y: 5 },
        { x: -7, y: -7 },
      ],
      extent,
    )

    expect(collect(hash, 19, 5, 1.5)).toContain(1)
    expect(collect(hash, -9, -9, 1.5)).toContain(2)
    expect(collect(hash, -9, -9, 1.5)).not.toContain(1)
  })

  it('copes with the inside-out bounds a plan with no geometry produces', () => {
    // The grid collapses to a single cell rather than throwing or allocating
    // wildly, and everybody ends up in it.
    const hash = build(
      1,
      [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
      { minX: 5, minY: 5, maxX: -5, maxY: -5 },
    )
    expect(sorted(collect(hash, 0, 0, 1))).toEqual([0, 1])
  })

  it('keeps the rest of the crowd findable when one position has gone NaN', () => {
    const extent: Extent = { minX: 0, minY: 0, maxX: 20, maxY: 20 }
    const rng = new Rng('spatial-hash-nan')
    const crowd = scatter(rng, 40, extent)
    const points = [...crowd, { x: NaN, y: NaN }]
    const hash = build(2, points, extent)

    const misses: Miss[] = []
    for (const probe of crowd) misses.push(...sweepAt(hash, crowd, probe, 3).misses)
    expect(misses).toEqual([])
    // A broken position lands in the first cell, where it is an extra the
    // callers' own distance checks throw away, rather than corrupting the
    // layout and taking real neighbours with it.
    expect(collect(hash, 0, 0, 0)).toContain(40)
  })

  it('sweeps the whole grid for a radius wider than it, rather than one corner', () => {
    const rng = new Rng('spatial-hash-nonfinite')
    const extent: Extent = { minX: 0, minY: 0, maxX: 40, maxY: 40 }
    const points = scatter(rng, 200, extent)
    const hash = build(5, points, extent)
    expect(collect(hash, 20, 20, 60)).toHaveLength(200)

    // Truncating the span with `| 0` is ToInt32, so a radius that reached past
    // two billion cells wrapped and collapsed onto the grid's first cell: the
    // answer came back as whoever was standing in the venue's bottom-left
    // corner, which a caller cannot tell from an empty stretch of floor.
    expect(sorted(collect(hash, 20, 20, Infinity))).toEqual(everyone(200))
    expect(sorted(collect(hash, 20, 20, 1e12))).toEqual(everyone(200))

    // A bound that is not a number is no span at all, so the loops walk nothing
    // and the caller gets an empty answer instead of a plausible wrong one.
    expect(collect(hash, 20, 20, NaN)).toEqual([])
    expect(collect(hash, NaN, NaN, 5)).toEqual([])

    // A negative radius inverts the span, which the loop bounds reject outright.
    expect(collect(hash, 20, 20, -1)).toEqual([])
  })
})
