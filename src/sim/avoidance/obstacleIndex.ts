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
  private readonly obstacles: readonly OrcaObstacle[]
  private readonly seen = new Set<number>()
  private readonly distanceScratch = new Map<number, number>()

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
    this.obstacles = obstacles

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

  /**
   * Indices of obstacle edges that may lie within `radius` of the point,
   * **nearest first**.
   *
   * The ordering is not a nicety. ORCA prunes an obstacle edge when an earlier
   * one already covers it, which is only sound if the earlier one is closer:
   * fed in bucket order, the far face of a wall can prune the near face and
   * people end up walking into it. Distances are to the edge segment, not to
   * its first vertex, because a long wall's vertex can be far away while the
   * wall itself is right beside you.
   */
  query(x: number, y: number, radius: number, out: number[]): number[] {
    out.length = 0
    this.seen.clear()
    const c0 = this.clampCol(x - radius)
    const c1 = this.clampCol(x + radius)
    const r0 = this.clampRow(y - radius)
    const r1 = this.clampRow(y + radius)
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        for (const index of this.buckets[row * this.cols + col]) {
          if (this.seen.has(index)) continue
          this.seen.add(index)
          out.push(index)
        }
      }
    }
    if (out.length > 1) {
      const distances = this.distanceScratch
      for (const index of out) distances.set(index, this.distanceToEdgeSq(index, x, y))
      out.sort((a, b) => (distances.get(a) ?? 0) - (distances.get(b) ?? 0))
    }
    return out
  }

  /** Squared distance from a point to obstacle edge `index`. */
  private distanceToEdgeSq(index: number, x: number, y: number): number {
    const obstacle = this.obstacles[index]
    const next = obstacle.nextIndex >= 0 ? this.obstacles[obstacle.nextIndex] : obstacle
    const ax = obstacle.point.x
    const ay = obstacle.point.y
    const bx = next.point.x
    const by = next.point.y
    const dx = bx - ax
    const dy = by - ay
    const lengthSq = dx * dx + dy * dy
    let t = 0
    if (lengthSq > 1e-18) {
      t = ((x - ax) * dx + (y - ay) * dy) / lengthSq
      t = t < 0 ? 0 : t > 1 ? 1 : t
    }
    const px = ax + dx * t - x
    const py = ay + dy * t - y
    return px * px + py * py
  }

  get cell(): number {
    return this.cellSize
  }
}
