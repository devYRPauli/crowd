/**
 * A uniform spatial hash for neighbour queries.
 *
 * Rebuilt every tick from scratch: with a few thousand agents that is cheaper
 * and far simpler than maintaining an incremental structure, and it keeps the
 * simulation free of stale-index bugs. Backed by typed arrays with a
 * counting-sort layout so a query touches contiguous memory.
 */

export class SpatialHash {
  private readonly invCell: number
  private cols = 0
  private rows = 0
  private originX = 0
  private originY = 0
  private cellStart: Int32Array = new Int32Array(0)
  private cellCount: Int32Array = new Int32Array(0)
  private entries: Int32Array = new Int32Array(0)
  private count = 0

  /** `cellSize` should be about the largest query radius. */
  constructor(cellSize: number) {
    this.invCell = 1 / cellSize
  }

  /** Discard the previous contents and size the grid to the given extent. */
  reset(minX: number, minY: number, maxX: number, maxY: number, capacity: number): void {
    this.originX = minX
    this.originY = minY
    this.cols = Math.max(1, Math.ceil((maxX - minX) * this.invCell) + 1)
    this.rows = Math.max(1, Math.ceil((maxY - minY) * this.invCell) + 1)
    const cells = this.cols * this.rows
    if (this.cellCount.length < cells) {
      this.cellCount = new Int32Array(cells)
      this.cellStart = new Int32Array(cells + 1)
    } else {
      this.cellCount.fill(0, 0, cells)
    }
    if (this.entries.length < capacity) this.entries = new Int32Array(capacity)
    this.count = 0
  }

  private cellOf(x: number, y: number): number {
    const col = Math.min(this.cols - 1, Math.max(0, ((x - this.originX) * this.invCell) | 0))
    const row = Math.min(this.rows - 1, Math.max(0, ((y - this.originY) * this.invCell) | 0))
    return row * this.cols + col
  }

  /**
   * Two-pass build. Call `count` for every item, then `finalize`, then `place`
   * for every item in the same order.
   */
  countAt(x: number, y: number): void {
    this.cellCount[this.cellOf(x, y)]++
    this.count++
  }

  finalize(): void {
    const cells = this.cols * this.rows
    let running = 0
    for (let i = 0; i < cells; i++) {
      this.cellStart[i] = running
      running += this.cellCount[i]
      this.cellCount[i] = 0
    }
    this.cellStart[cells] = running
  }

  placeAt(x: number, y: number, id: number): void {
    const cell = this.cellOf(x, y)
    this.entries[this.cellStart[cell] + this.cellCount[cell]] = id
    this.cellCount[cell]++
  }

  /**
   * Visit every id within `radius` of the point. The callback may be called for
   * items slightly outside.
   *
   * The bounds are floored rather than truncated with `| 0`, which is ToInt32:
   * that turned a span reaching past two billion cells — an infinite radius,
   * most obviously — into the grid's first cell, and answered with whoever
   * happened to be standing in the venue's bottom-left corner. A near-miss a
   * caller cannot tell from an empty stretch of floor is the one thing this
   * contract forbids. Floored, an unbounded span clamps to the whole grid and
   * a bound that is not a number leaves the loops with nothing to walk.
   */
  query(x: number, y: number, radius: number, visit: (id: number) => void): void {
    if (this.count === 0) return
    const minCol = Math.min(
      this.cols - 1,
      Math.max(0, Math.floor((x - radius - this.originX) * this.invCell)),
    )
    const maxCol = Math.min(
      this.cols - 1,
      Math.max(0, Math.floor((x + radius - this.originX) * this.invCell)),
    )
    const minRow = Math.min(
      this.rows - 1,
      Math.max(0, Math.floor((y - radius - this.originY) * this.invCell)),
    )
    const maxRow = Math.min(
      this.rows - 1,
      Math.max(0, Math.floor((y + radius - this.originY) * this.invCell)),
    )
    for (let row = minRow; row <= maxRow; row++) {
      const base = row * this.cols
      for (let col = minCol; col <= maxCol; col++) {
        const cell = base + col
        const start = this.cellStart[cell]
        const end = start + this.cellCount[cell]
        for (let i = start; i < end; i++) visit(this.entries[i])
      }
    }
  }
}
