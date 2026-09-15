/**
 * The neighbour index the crowd runs on.
 *
 * Everything that asks "who is near me" goes through here: ORCA, contact
 * resolution, the density a walker reads ahead of itself. The contract lets the
 * hash be generous — it works in whole cells, so a query may visit items
 * slightly outside the radius — but it is never allowed to be stingy. A missed
 * neighbour is a pair of people who walk through each other, and because the
 * hash is rebuilt from scratch every tick, a miss shows up as a one-frame
 * glitch that is near impossible to reproduce by hand.
 *
 * So the load-bearing test is a brute-force scan over random points. It is
 * paired with a tightness check on purpose: on its own, a query that simply
 * visited every cell would sail through the miss test, and that is exactly the
 * regression a "just widen the search" fix would introduce.
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

describe('SpatialHash.query', () => {
  it('returns every point genuinely within the radius', () => {
    const rng = new Rng('spatial-hash-brute-force')
    const misses: Array<Record<string, number>> = []
    let found = 0

    for (let trial = 0; trial < 200; trial++) {
      const extent: Extent = {
        minX: rng.uniform(-30, 10),
        minY: rng.uniform(-30, 10),
        maxX: 0,
        maxY: 0,
      }
      extent.maxX = extent.minX + rng.uniform(0.5, 40)
      extent.maxY = extent.minY + rng.uniform(0.5, 40)
      // Cell size deliberately ranges either side of the query radius: the
      // engine sizes it to the neighbour range, but nothing enforces that.
      const cellSize = rng.uniform(0.2, 8)
      const points = scatter(rng, rng.int(0, 60), extent)
      const hash = build(cellSize, points, extent)

      for (let q = 0; q < 10; q++) {
        const x = rng.uniform(extent.minX, extent.maxX)
        const y = rng.uniform(extent.minY, extent.maxY)
        const radius = rng.uniform(0, cellSize * 2)
        const returned = new Set(collect(hash, x, y, radius))
        for (const id of trulyWithin(points, x, y, radius)) {
          found++
          if (!returned.has(id)) {
            misses.push({
              trial,
              cellSize,
              x,
              y,
              radius,
              pointX: points[id].x,
              pointY: points[id].y,
            })
          }
        }
      }
    }

    expect(misses).toEqual([])
    // Guards the scan above against passing because it never had anything to find.
    expect(found).toBeGreaterThan(1000)
  })

  it('finds neighbours on the far side of a cell boundary', () => {
    const eps = 1e-6
    for (const cellSize of [1, 0.7, 2.5]) {
      const extent: Extent = { minX: 0, minY: 0, maxX: 10, maxY: 10 }
      const points: Point[] = []
      for (let k = 1; k * cellSize < 10; k++) {
        points.push({ x: k * cellSize - eps, y: 5 }, { x: k * cellSize + eps, y: 5 })
      }
      const hash = build(cellSize, points, extent)

      for (let k = 1; k * cellSize < 10; k++) {
        const ids = collect(hash, k * cellSize, 5, eps * 4).sort((a, b) => a - b)
        expect(ids).toContain((k - 1) * 2)
        expect(ids).toContain((k - 1) * 2 + 1)
      }
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
    expect(collect(hash, 3, 3, eps * 4).sort((a, b) => a - b)).toEqual([0, 1, 2, 3])
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
        const radius = rng.uniform(0, cellSize)
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

    expect(returnedTotal).toBeGreaterThan(100)
  })

  it('reports each id once even when a query spans many cells', () => {
    const rng = new Rng('spatial-hash-duplicates')
    const extent: Extent = { minX: -5, minY: -5, maxX: 5, maxY: 5 }
    const points = scatter(rng, 300, extent)
    const hash = build(0.4, points, extent)

    // Wide enough to sweep every cell in the grid, which is where a duplicate
    // would surface if a cell were ever visited twice.
    const ids = collect(hash, 0, 0, 50)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(points.length)
  })

  it('makes every stored id reachable exactly once', () => {
    const rng = new Rng('spatial-hash-completeness')
    const extent: Extent = { minX: 0, minY: 0, maxX: 12, maxY: 7 }
    // Duplicated coordinates are normal — people queue shoulder to shoulder —
    // and the counting-sort layout has to keep one slot per entry regardless.
    const points = [
      ...scatter(rng, 40, extent),
      ...Array.from({ length: 10 }, () => ({ x: 6, y: 3 })),
    ]
    const hash = build(1.5, points, extent)

    expect(collect(hash, 6, 3.5, 100).sort((a, b) => a - b)).toEqual(
      points.map((_, id) => id).sort((a, b) => a - b),
    )
  })
})

describe('SpatialHash rebuilds', () => {
  it('discards the previous contents on reset', () => {
    const extent: Extent = { minX: 0, minY: 0, maxX: 10, maxY: 10 }
    const rng = new Rng('spatial-hash-reset')
    const hash = build(1, scatter(rng, 50, extent), extent)
    expect(collect(hash, 5, 5, 100)).toHaveLength(50)

    // A reset with no rebuild behind it is what an engine tick looks like when
    // every agent has left: it must answer nothing, not the last tick's crowd.
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
    const misses: Array<Record<string, number>> = []
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
        const x = rng.uniform(extent.minX, extent.maxX)
        const y = rng.uniform(extent.minY, extent.maxY)
        const radius = rng.uniform(0, 4)
        const returned = collect(hash, x, y, radius)
        for (const id of returned) {
          if (!Number.isInteger(id) || id < 0 || id >= points.length) strangers.push(id)
        }
        const expected = trulyWithin(points, x, y, radius)
        const seen = new Set(returned)
        for (const id of expected) if (!seen.has(id)) misses.push({ trial, x, y, radius, id })
      }
    }

    expect(strangers).toEqual([])
    expect(misses).toEqual([])
  })
})

describe('SpatialHash degenerate input', () => {
  it('answers nothing before it has ever been reset', () => {
    const hash = new SpatialHash(1)
    expect(collect(hash, 0, 0, 5)).toEqual([])
  })

  it('answers nothing when the venue is empty', () => {
    const hash = new SpatialHash(1)
    load(hash, [], { minX: 0, minY: 0, maxX: 20, maxY: 20 })
    expect(collect(hash, 10, 10, 1000)).toEqual([])
  })

  it('handles a zero radius', () => {
    const extent: Extent = { minX: 0, minY: 0, maxX: 10, maxY: 10 }
    const hash = build(
      1,
      [
        { x: 3, y: 3 },
        { x: 3, y: 3 },
        { x: 7, y: 7 },
      ],
      extent,
    )

    // Two people at the same coordinate is the case that matters: a zero-radius
    // query is how the engine asks "who else is exactly here".
    expect(collect(hash, 3, 3, 0).sort((a, b) => a - b)).toEqual([0, 1])
    expect(collect(hash, 7, 7, 0)).toEqual([2])
    expect(collect(hash, 5.5, 5.5, 0)).toEqual([])
  })

  it('keeps points that drift outside the extent', () => {
    // Agents can be pushed past the world bounds by contact resolution. Such a
    // point is clamped into the border cell rather than dropped, so a query out
    // there still finds it.
    const extent: Extent = { minX: 0, minY: 0, maxX: 10, maxY: 10 }
    const stray = { x: 20, y: 5 }
    const hash = build(2, [{ x: 5, y: 5 }, stray], extent)

    expect(collect(hash, 19, 5, 1.5)).toContain(1)
    expect(collect(hash, -9, 5, 1.5)).not.toContain(1)
  })

  it('survives an inverted extent', () => {
    // A plan with no geometry yields bounds that are the wrong way round. The
    // grid collapses to a single cell rather than throwing or allocating wildly.
    const hash = build(
      1,
      [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
      {
        minX: 5,
        minY: 5,
        maxX: -5,
        maxY: -5,
      },
    )
    expect(collect(hash, 0, 0, 1).sort((a, b) => a - b)).toEqual([0, 1])
  })
})
