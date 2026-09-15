/**
 * Spatial index over static obstacle edges.
 *
 * ORCA needs the obstacle vertices near each agent, and scanning every wall in
 * the venue for every agent on every tick is the easiest way to make a crowd
 * simulation quadratic. Edges are bucketed once when the world is built, then
 * queried by bounding box.
 */

import type { OrcaObstacle } from './orca'

export class ObstacleIndex {
  private readonly cellSize: number
  private readonly invCell: number
  private readonly originX: number
  private readonly originY: number
  private readonly cols: number
  private readonly rows: number
  private readonly buckets: number[][]

  constructor(
    obstacles: readonly OrcaObstacle[],
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    cellSize = 2,
  ) {
    this.cellSize = cellSize
    this.invCell = 1 / cellSize
    this.originX = bounds.minX
    this.originY = bounds.minY
    this.cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) * this.invCell) + 1)
    this.rows = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) * this.invCell) + 1)
    this.buckets = Array.from({ length: this.cols * this.rows }, () => [])

    obstacles.forEach((obstacle, index) => {
      const next = obstacle.nextIndex >= 0 ? obstacles[obstacle.nextIndex] : obstacle
      const minX = Math.min(obstacle.point.x, next.point.x)
      const maxX = Math.max(obstacle.point.x, next.point.x)
      const minY = Math.min(obstacle.point.y, next.point.y)
      const maxY = Math.max(obstacle.point.y, next.point.y)
      const c0 = this.clampCol(minX)
      const c1 = this.clampCol(maxX)
      const r0 = this.clampRow(minY)
      const r1 = this.clampRow(maxY)
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) this.buckets[row * this.cols + col].push(index)
      }
    })
  }

  private clampCol(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, ((x - this.originX) * this.invCell) | 0))
  }

  private clampRow(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, ((y - this.originY) * this.invCell) | 0))
  }

  /** Indices of obstacle vertices whose edge may lie within `radius` of the point. */
  query(x: number, y: number, radius: number, out: number[]): number[] {
    out.length = 0
    const c0 = this.clampCol(x - radius)
    const c1 = this.clampCol(x + radius)
    const r0 = this.clampRow(y - radius)
    const r1 = this.clampRow(y + radius)
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        for (const index of this.buckets[row * this.cols + col]) {
          if (!out.includes(index)) out.push(index)
        }
      }
    }
    return out
  }

  get cell(): number {
    return this.cellSize
  }
}
