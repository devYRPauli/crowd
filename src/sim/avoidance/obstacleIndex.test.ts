import { describe, expect, it } from 'vitest'
import { ObstacleIndex } from './obstacleIndex'
import { buildObstacles } from './orca'
import type { Vec2 } from '../../core/math/vec2'

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
]

const bounds = { minX: -10, minY: -10, maxX: 30, maxY: 30 }

describe('ObstacleIndex', () => {
  it('finds the edges of a nearby wall and skips distant ones', () => {
    const obstacles = buildObstacles([rect(0, 0, 10, 0.2), rect(0, 20, 10, 20.2)])
    const index = new ObstacleIndex(obstacles, bounds, 2)
    const out: number[] = []
    index.query(5, 1, 3, out)
    expect(out.length).toBeGreaterThan(0)
    // Nothing from the wall twenty metres away.
    for (const i of out) expect(obstacles[i].point.y).toBeLessThan(10)
  })

  it('returns edges nearest first, which ORCA pruning depends on', () => {
    // A thick wall: the near face at y = 1, the far face at y = 3.
    const obstacles = buildObstacles([rect(0, 1, 10, 3)])
    const index = new ObstacleIndex(obstacles, bounds, 2)
    const out: number[] = []
    index.query(5, 0, 6, out)
    expect(out.length).toBeGreaterThan(1)

    const distanceTo = (i: number) => {
      const a = obstacles[i].point
      const b = obstacles[obstacles[i].nextIndex].point
      const dx = b.x - a.x
      const dy = b.y - a.y
      const lengthSq = dx * dx + dy * dy
      const t =
        lengthSq > 0 ? Math.max(0, Math.min(1, ((5 - a.x) * dx + (0 - a.y) * dy) / lengthSq)) : 0
      return Math.hypot(a.x + dx * t - 5, a.y + dy * t - 0)
    }
    const distances = out.map(distanceTo)
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i]).toBeGreaterThanOrEqual(distances[i - 1] - 1e-9)
    }
    // The first edge returned must be the face we are standing in front of.
    expect(distanceTo(out[0])).toBeCloseTo(1, 5)
  })

  it('returns each edge only once even when it spans several buckets', () => {
    const obstacles = buildObstacles([rect(0, 0, 20, 0.2)])
    const index = new ObstacleIndex(obstacles, bounds, 2)
    const out: number[] = []
    index.query(10, 1, 12, out)
    expect(new Set(out).size).toBe(out.length)
  })

  it('reuses the output array without leaking results between queries', () => {
    const obstacles = buildObstacles([rect(0, 0, 4, 0.2), rect(20, 20, 24, 20.2)])
    const index = new ObstacleIndex(obstacles, bounds, 2)
    const out: number[] = []
    index.query(2, 1, 3, out)
    const first = [...out]
    index.query(22, 21, 3, out)
    expect(out).not.toEqual(first)
    expect(out.length).toBeGreaterThan(0)
  })
})
