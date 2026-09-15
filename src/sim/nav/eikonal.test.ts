import { describe, expect, it } from 'vitest'
import type { Vec2 } from '../../core/math/vec2'
import type { NavGrid } from './eikonal'
import {
  cellCenter,
  clearanceField,
  createNavGrid,
  gridIndex,
  rasterizePolygon,
  sampleField,
  sampleGradient,
  solveEikonal,
  worldToCell,
} from './eikonal'

const cellCount = (grid: NavGrid): number => grid.cols * grid.rows

const openSpeed = (grid: NavGrid): Float32Array => new Float32Array(cellCount(grid)).fill(1)

const cellAt = (grid: NavGrid, x: number, y: number): number => {
  const { col, row } = worldToCell(grid, x, y)
  return gridIndex(grid, col, row)
}

const valueAt = (grid: NavGrid, field: Float32Array, x: number, y: number): number =>
  field[cellAt(grid, x, y)]

/** Axis-aligned rectangle, counter-clockwise. */
const rect = (minX: number, minY: number, maxX: number, maxY: number): Vec2[] => [
  { x: minX, y: minY },
  { x: maxX, y: minY },
  { x: maxX, y: maxY },
  { x: minX, y: maxY },
]

/**
 * Follow the potential downhill in half-cell steps, the way an agent does.
 * Stops on arrival, on a flat spot, or when it walks into an unreachable region.
 */
const descend = (
  grid: NavGrid,
  potential: Float32Array,
  startX: number,
  startY: number,
  maxSteps: number,
): Vec2[] => {
  const step = grid.cellSize * 0.5
  const path: Vec2[] = [{ x: startX, y: startY }]
  let x = startX
  let y = startY
  for (let i = 0; i < maxSteps; i++) {
    const sample = sampleGradient(grid, potential, x, y)
    if (sample === null || sample.value <= step) break
    if (sample.dx === 0 && sample.dy === 0) break
    x += sample.dx * step
    y += sample.dy * step
    path.push({ x, y })
  }
  return path
}

describe('createNavGrid', () => {
  it('covers the bounds and round-trips world points', () => {
    const grid = createNavGrid({ minX: -3, minY: 1, maxX: 7, maxY: 6 }, 0.5)
    expect(grid.cols).toBe(20)
    expect(grid.rows).toBe(10)
    expect(grid.originX).toBe(-3)
    expect(gridIndex(grid, 4, 2)).toBe(44)

    const centre = cellCenter(grid, 4, 2)
    expect(centre).toEqual({ x: -0.75, y: 2.25 })
    expect(worldToCell(grid, centre.x, centre.y)).toEqual({ col: 4, row: 2 })
    // Anywhere inside the cell resolves to the same cell.
    expect(worldToCell(grid, centre.x + 0.24, centre.y - 0.24)).toEqual({ col: 4, row: 2 })
  })

  it('clamps points outside the grid onto the edge', () => {
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 5, maxY: 5 }, 1)
    expect(worldToCell(grid, -40, -40)).toEqual({ col: 0, row: 0 })
    expect(worldToCell(grid, 400, 400)).toEqual({ col: 4, row: 4 })
  })

  it('rounds a partial cell up rather than dropping it', () => {
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 5.1, maxY: 4.9 }, 1)
    expect(grid.cols).toBe(6)
    expect(grid.rows).toBe(5)
  })
})

describe('rasterizePolygon', () => {
  it('fills the interior and leaves the rest alone', () => {
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 0.25)
    const mask = new Uint8Array(cellCount(grid))
    rasterizePolygon(grid, rect(2, 3, 5, 6), mask)

    expect(mask[cellAt(grid, 3.5, 4.5)]).toBe(1)
    expect(mask[cellAt(grid, 2.1, 3.1)]).toBe(1)
    expect(mask[cellAt(grid, 4.9, 5.9)]).toBe(1)
    expect(mask[cellAt(grid, 1.9, 4.5)]).toBe(0)
    expect(mask[cellAt(grid, 5.1, 4.5)]).toBe(0)
    expect(mask[cellAt(grid, 3.5, 6.1)]).toBe(0)

    // The filled area is the polygon's, to within the cells its edges cut.
    let filled = 0
    for (const v of mask) filled += v
    expect(filled * grid.cellSize * grid.cellSize).toBeCloseTo(9, 0)
  })

  it('grows the footprint by the dilation radius', () => {
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 0.25)
    const plain = new Uint8Array(cellCount(grid))
    const grown = new Uint8Array(cellCount(grid))
    rasterizePolygon(grid, rect(4, 4, 6, 6), plain)
    rasterizePolygon(grid, rect(4, 4, 6, 6), grown, 1, 0.5)

    expect(plain[cellAt(grid, 6.3, 5)]).toBe(0)
    expect(grown[cellAt(grid, 6.3, 5)]).toBe(1)
    expect(grown[cellAt(grid, 3.7, 5)]).toBe(1)
    expect(grown[cellAt(grid, 5, 6.3)]).toBe(1)
    // Corners dilate radially, so a cell 0.5 m out on both axes stays clear.
    expect(grown[cellAt(grid, 6.45, 6.45)]).toBe(0)
    expect(grown[cellAt(grid, 6.8, 5)]).toBe(0)
  })

  it('writes the requested value', () => {
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 4, maxY: 4 }, 0.5)
    const mask = new Uint8Array(cellCount(grid))
    rasterizePolygon(grid, rect(1, 1, 3, 3), mask, 7)
    expect(mask[cellAt(grid, 2, 2)]).toBe(7)
  })
})

describe('clearanceField', () => {
  it('reports the distance to a wall to within a cell', () => {
    // The wall sits mid-grid so the solid world outside the border never wins.
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 20, maxY: 16 }, 0.25)
    const blocked = new Uint8Array(cellCount(grid))
    rasterizePolygon(grid, rect(10, 0, 10.5, 16), blocked)
    const clearance = clearanceField(grid, blocked)

    for (const distance of [0.5, 1, 2, 3]) {
      const right = valueAt(grid, clearance, 10.5 + distance, 8)
      const left = valueAt(grid, clearance, 10 - distance, 8)
      expect(Math.abs(right - distance)).toBeLessThanOrEqual(grid.cellSize)
      expect(Math.abs(left - distance)).toBeLessThanOrEqual(grid.cellSize)
    }
    // Read on a cell centre the convention shows through exactly: clearance is
    // measured to the centre of the nearest solid cell, half a cell inside the face.
    expect(valueAt(grid, clearance, 11.375, 8)).toBeCloseTo(1, 6)
    expect(valueAt(grid, clearance, 9.125, 8)).toBeCloseTo(1, 6)
  })

  it('is exact on the diagonal, where a chamfer mask would not be', () => {
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 20, maxY: 20 }, 0.25)
    const blocked = new Uint8Array(cellCount(grid))
    blocked[cellAt(grid, 10, 10)] = 1
    const clearance = clearanceField(grid, blocked)
    const solid = cellCenter(grid, worldToCell(grid, 10, 10).col, worldToCell(grid, 10, 10).row)

    for (const [dx, dy] of [
      [3, 3],
      [2, 4],
      [-3, 3],
      [-4, -2],
    ]) {
      const value = valueAt(grid, clearance, solid.x + dx, solid.y + dy)
      expect(value).toBeCloseTo(Math.hypot(dx, dy), 6)
    }
  })

  it('treats the world beyond the grid as solid', () => {
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 6, maxY: 6 }, 0.5)
    const clearance = clearanceField(grid, new Uint8Array(cellCount(grid)))
    // Nothing is blocked, so every cell measures its own distance to the border.
    expect(valueAt(grid, clearance, 0.25, 3)).toBeCloseTo(0.5, 6)
    expect(valueAt(grid, clearance, 3, 5.75)).toBeCloseTo(0.5, 6)
    expect(valueAt(grid, clearance, 3, 3)).toBeCloseTo(3, 6)
  })

  it('goes negative inside solids so a body pushed into one can be pushed back out', () => {
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 12, maxY: 12 }, 0.25)
    const blocked = new Uint8Array(cellCount(grid))
    rasterizePolygon(grid, rect(4, 4, 8, 8), blocked)
    const clearance = clearanceField(grid, blocked)

    expect(valueAt(grid, clearance, 6, 6)).toBeLessThan(-1.5)
    expect(valueAt(grid, clearance, 4.1, 6)).toBeGreaterThan(-grid.cellSize * 2)
    expect(valueAt(grid, clearance, 4.1, 6)).toBeLessThanOrEqual(0)
    expect(valueAt(grid, clearance, 9, 6)).toBeGreaterThan(0)
  })
})

describe('solveEikonal', () => {
  it('matches Euclidean distance within 3% in every direction, diagonals included', () => {
    // 0.1 m cells: the error of a first-order upwind scheme scales with distance
    // measured in cells, and real plans run 100+ cells across.
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 20, maxY: 20 }, 0.1)
    const goal = cellAt(grid, 10, 10)
    const potential = solveEikonal(grid, new Uint8Array(cellCount(grid)), openSpeed(grid), [goal])
    const origin = cellCenter(grid, worldToCell(grid, 10, 10).col, worldToCell(grid, 10, 10).row)

    expect(potential[goal]).toBe(0)

    let worst = 0
    for (let turn = 0; turn < 16; turn++) {
      const angle = (turn * Math.PI) / 8
      for (const radius of [3, 4, 6, 8]) {
        const cell = worldToCell(
          grid,
          origin.x + Math.cos(angle) * radius,
          origin.y + Math.sin(angle) * radius,
        )
        const centre = cellCenter(grid, cell.col, cell.row)
        const exact = Math.hypot(centre.x - origin.x, centre.y - origin.y)
        const solved = potential[gridIndex(grid, cell.col, cell.row)]
        worst = Math.max(worst, Math.abs(solved - exact) / exact)
      }
    }
    // 4-connected Dijkstra would read 41% long on the diagonals and 8-connected
    // 8% long at 22.5°; only a Godunov update lands inside a few percent at every
    // angle, which is what makes the gradient usable as a steering direction.
    expect(worst).toBeLessThan(0.03)
  })

  it('keeps the gradient pointing at the goal from every direction', () => {
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 20, maxY: 20 }, 0.1)
    const potential = solveEikonal(grid, new Uint8Array(cellCount(grid)), openSpeed(grid), [
      cellAt(grid, 10, 10),
    ])
    const origin = cellCenter(grid, worldToCell(grid, 10, 10).col, worldToCell(grid, 10, 10).row)

    for (let turn = 0; turn < 16; turn++) {
      const angle = (turn * Math.PI) / 8
      const x = origin.x + Math.cos(angle) * 5
      const y = origin.y + Math.sin(angle) * 5
      const sample = sampleGradient(grid, potential, x, y)
      expect(sample).not.toBeNull()
      const towardsGoal = Math.atan2(origin.y - y, origin.x - x)
      const heading = Math.atan2(sample!.dy, sample!.dx)
      const error = Math.abs(
        Math.atan2(Math.sin(heading - towardsGoal), Math.cos(heading - towardsGoal)),
      )
      expect((error * 180) / Math.PI).toBeLessThan(5)
    }
  })

  it('routes through the gap in a wall, and the gradient walks an agent through it', () => {
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 20, maxY: 20 }, 0.25)
    const blocked = new Uint8Array(cellCount(grid))
    rasterizePolygon(grid, rect(0, 9.75, 11.5, 10.25), blocked)
    rasterizePolygon(grid, rect(13.5, 9.75, 20, 10.25), blocked)

    const goalX = 3
    const goalY = 17
    const potential = solveEikonal(grid, blocked, openSpeed(grid), [cellAt(grid, goalX, goalY)])

    // Straight up is 14 m but walled off; the way round is the 2 m gap at x≈12.5.
    const detour = valueAt(grid, potential, goalX, 3)
    expect(detour).toBeGreaterThan(20)
    expect(detour).toBeLessThan(30)
    // Just below the wall the cost is nearly the whole detour, not the 7 m gap.
    expect(valueAt(grid, potential, goalX, 9.5)).toBeGreaterThan(20)

    const path = descend(grid, potential, goalX, 3, 600)
    const end = path[path.length - 1]
    expect(Math.hypot(end.x - goalX, end.y - goalY)).toBeLessThan(0.5)
    expect(path.length).toBeLessThan(400)

    const crossing = path.find((p) => p.y >= 10.25)
    expect(crossing).toBeDefined()
    expect(crossing!.x).toBeGreaterThan(11.5)
    expect(crossing!.x).toBeLessThan(13.5)
  })

  it('leaves sealed regions unreachable', () => {
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 20, maxY: 20 }, 0.25)
    const blocked = new Uint8Array(cellCount(grid))
    for (const wall of [
      rect(6, 6, 6.5, 14),
      rect(13.5, 6, 14, 14),
      rect(6, 6, 14, 6.5),
      rect(6, 13.5, 14, 14),
    ]) {
      rasterizePolygon(grid, wall, blocked)
    }
    const potential = solveEikonal(grid, blocked, openSpeed(grid), [cellAt(grid, 2, 2)])

    expect(valueAt(grid, potential, 10, 10)).toBe(Infinity)
    expect(valueAt(grid, potential, 6.2, 6.2)).toBe(Infinity) // the wall itself
    expect(sampleGradient(grid, potential, 10, 10)).toBeNull()
    expect(sampleGradient(grid, potential, 40, 40)).toBeNull() // off the grid
    // Outside the box the field is still a clean distance field.
    expect(valueAt(grid, potential, 18, 2)).toBeCloseTo(16, 1)
  })

  it('ignores goal cells buried in an obstacle', () => {
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 0.25)
    const blocked = new Uint8Array(cellCount(grid))
    rasterizePolygon(grid, rect(4, 4, 6, 6), blocked)
    const potential = solveEikonal(grid, blocked, openSpeed(grid), [cellAt(grid, 5, 5)])

    expect(potential[cellAt(grid, 5, 5)]).toBe(Infinity)
    expect(potential[cellAt(grid, 1, 1)]).toBe(Infinity)
  })

  it('rises faster across a slow band than across free space', () => {
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 20, maxY: 6 }, 0.25)
    const blocked = new Uint8Array(cellCount(grid))
    const band = new Uint8Array(cellCount(grid))
    rasterizePolygon(grid, rect(8, 0, 10, 6), band)
    const slow = openSpeed(grid)
    for (let i = 0; i < band.length; i++) if (band[i]) slow[i] = 0.25

    const goal = [cellAt(grid, 1, 3)]
    const free = solveEikonal(grid, blocked, openSpeed(grid), goal)
    const slowed = solveEikonal(grid, blocked, slow, goal)

    // Up to the band the two fields agree.
    expect(valueAt(grid, slowed, 7.5, 3)).toBeCloseTo(valueAt(grid, free, 7.5, 3), 1)
    // Across it, 2 m at quarter speed costs 8 instead of 2.
    const freeRise = valueAt(grid, free, 10.5, 3) - valueAt(grid, free, 7.5, 3)
    const slowRise = valueAt(grid, slowed, 10.5, 3) - valueAt(grid, slowed, 7.5, 3)
    expect(freeRise).toBeCloseTo(3, 1)
    expect(slowRise).toBeGreaterThan(freeRise * 2.5)
    expect(slowRise).toBeCloseTo(9, 0)
  })

  it('copes with a degenerate grid and with no reachable goal', () => {
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 0.2, maxY: 0.2 }, 1)
    expect([grid.cols, grid.rows]).toEqual([1, 1])

    const reached = solveEikonal(grid, new Uint8Array(1), openSpeed(grid), [0])
    expect(reached[0]).toBe(0)
    expect(sampleField(grid, reached, 0.5, 0.5, -1)).toBe(0)

    // No goal, and an out-of-range goal, both leave the field unreachable
    // rather than NaN or out-of-bounds.
    expect(solveEikonal(grid, new Uint8Array(1), openSpeed(grid), [])[0]).toBe(Infinity)
    const stray = solveEikonal(grid, new Uint8Array(1), openSpeed(grid), [-1, 99])
    expect(stray[0]).toBe(Infinity)
    expect(sampleGradient(grid, stray, 0.5, 0.5)).toBeNull()
  })

  it('solves a 300x200 grid fast enough to rebuild inside a tick', () => {
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 75, maxY: 50 }, 0.25)
    expect([grid.cols, grid.rows]).toEqual([300, 200])
    const blocked = new Uint8Array(cellCount(grid))
    const speed = openSpeed(grid)
    const goal = [cellAt(grid, 1, 1)]

    solveEikonal(grid, blocked, speed, goal) // warm the JIT, as a repeated solve is
    const started = performance.now()
    const potential = solveEikonal(grid, blocked, speed, goal)
    const elapsed = performance.now() - started

    expect(valueAt(grid, potential, 74, 49)).toBeGreaterThan(0)
    // A linear-scan narrow band would take minutes here; the budget is loose
    // enough to survive a busy CI box and still catch that.
    expect(elapsed).toBeLessThan(250)
  })
})

describe('sampleField', () => {
  it('interpolates between cell centres', () => {
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 4, maxY: 4 }, 1)
    const field = new Float32Array(cellCount(grid))
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) field[gridIndex(grid, col, row)] = col * 2
    }

    expect(sampleField(grid, field, 1.5, 1.5, -1)).toBeCloseTo(2, 6)
    expect(sampleField(grid, field, 2, 1.5, -1)).toBeCloseTo(3, 6)
    // The outer half-cell holds the edge value rather than falling off.
    expect(sampleField(grid, field, 0.1, 2, -1)).toBeCloseTo(0, 6)
    expect(sampleField(grid, field, 3.9, 2, -1)).toBeCloseTo(6, 6)
  })

  it('returns the fallback outside the grid', () => {
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 4, maxY: 4 }, 1)
    const field = new Float32Array(cellCount(grid)).fill(5)
    expect(sampleField(grid, field, -0.01, 2, -1)).toBe(-1)
    expect(sampleField(grid, field, 4.01, 2, -1)).toBe(-1)
    expect(sampleField(grid, field, 2, 4.01, -1)).toBe(-1)
    expect(sampleField(grid, field, 2, 2, -1)).toBe(5)
  })

  it('ignores unreachable corners instead of returning NaN', () => {
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 2, maxY: 2 }, 1)
    const field = new Float32Array([1, Infinity, 3, 5])
    const sample = sampleField(grid, field, 1, 1, -1)
    expect(Number.isFinite(sample)).toBe(true)
    expect(sample).toBeCloseTo(3, 6)
    expect(sampleField(grid, new Float32Array(4).fill(Infinity), 1, 1, -1)).toBe(-1)
  })
})

describe('sampleGradient', () => {
  it('keeps the direction true at the grid border', () => {
    // A planar potential: the downhill direction is the same at every point, so
    // any deviation is the sampler's own. `sampleField` holds the outer half-cell
    // at the edge cell's value, so a probe pair straddling the border reads one
    // cell twice — the component across the border cancels, and steering either
    // slides along the border or reads flat outright at a corner.
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 0.25)
    const field = new Float32Array(cellCount(grid))
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const centre = cellCenter(grid, col, row)
        field[gridIndex(grid, col, row)] = 0.6 * centre.x + 0.8 * centre.y
      }
    }

    const onTheEdge: Vec2[] = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 4.3 },
      { x: 4.3, y: 0 },
      { x: 10, y: 4.3 },
      { x: 4.3, y: 10 },
      { x: 0.05, y: 6.7 }, // inside the clamped outer half-cell
      { x: 5, y: 5 }, // interior control
    ]
    for (const p of onTheEdge) {
      const sample = sampleGradient(grid, field, p.x, p.y)
      expect(sample).not.toBeNull()
      expect(sample!.dx).toBeCloseTo(-0.6, 5)
      expect(sample!.dy).toBeCloseTo(-0.8, 5)
    }

    // A hair outside is still off the grid, not a clamped reading.
    expect(sampleGradient(grid, field, -0.001, 5)).toBeNull()
    expect(sampleGradient(grid, field, 5, 10.001)).toBeNull()
  })

  it('reads flat where the field genuinely is', () => {
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 4, maxY: 4 }, 0.5)
    const flat = new Float32Array(cellCount(grid)).fill(3)
    expect(sampleGradient(grid, flat, 2, 2)).toEqual({ dx: 0, dy: 0, value: 3 })
    expect(sampleGradient(grid, flat, 0, 0)).toEqual({ dx: 0, dy: 0, value: 3 })
  })
})
