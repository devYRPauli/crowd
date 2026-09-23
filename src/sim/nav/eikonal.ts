/**
 * Navigation fields on a uniform grid: clearance, cost-to-goal, and its gradient.
 *
 * Agents steer by descending a potential rather than by chasing waypoints, so
 * the potential has to be smooth. A plain Dijkstra flood quantises directions to
 * multiples of 45° and makes crowds fan out along the grid axes, so the solver
 * here is a fast-marching method using the 2-D Godunov upwind quadratic: that
 * update is exact wherever the arrival-time field is locally planar, which is
 * everywhere except the immediate neighbourhood of a source, and it therefore
 * recovers true Euclidean directions. The narrow band is a binary heap with
 * lazy deletion — a superseded entry is discarded when it surfaces — which is
 * cheaper than maintaining the index needed for decrease-key.
 *
 * `clearanceField` uses the Felzenszwalb–Huttenlocher lower-envelope transform:
 * exact Euclidean and still O(cells), where a chamfer mask would bake its ~2%
 * anisotropy straight into how closely agents shave past corners.
 *
 * Fields are flat typed arrays in row-major order, sized cols*rows, so a solve
 * can be handed across the worker boundary as a transferable buffer.
 */

import type { Vec2 } from '../../core/math/vec2'
import type { Bounds } from '../../core/math/geometry'

/** A uniform square grid covering a rectangular region of the plan. */
export interface NavGrid {
  readonly originX: number
  readonly originY: number
  readonly cellSize: number
  readonly cols: number
  readonly rows: number
}

export const createNavGrid = (bounds: Bounds, cellSize: number): NavGrid => {
  const size = Math.max(cellSize, 1e-6)
  return {
    originX: bounds.minX,
    originY: bounds.minY,
    cellSize: size,
    cols: Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / size)),
    rows: Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / size)),
  }
}

export const gridIndex = (grid: NavGrid, col: number, row: number): number => row * grid.cols + col

/**
 * Cell containing a world point, clamped to the grid: an out-of-range index
 * would read `undefined` out of a typed array and poison every sum downstream.
 */
export const worldToCell = (grid: NavGrid, x: number, y: number): { col: number; row: number } => {
  const col = Math.floor((x - grid.originX) / grid.cellSize)
  const row = Math.floor((y - grid.originY) / grid.cellSize)
  return {
    col: col < 0 ? 0 : col > grid.cols - 1 ? grid.cols - 1 : col,
    row: row < 0 ? 0 : row > grid.rows - 1 ? grid.rows - 1 : row,
  }
}

export const cellCenter = (grid: NavGrid, col: number, row: number): Vec2 => ({
  x: grid.originX + (col + 0.5) * grid.cellSize,
  y: grid.originY + (row + 0.5) * grid.cellSize,
})

/** Stands in for Infinity in the lower-envelope pass, where Inf − Inf would be NaN. */
const EDT_FAR = 1e20

/** One 1-D pass of the Felzenszwalb–Huttenlocher squared distance transform. */
const edtPass = (
  f: Float64Array,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array,
  n: number,
): void => {
  let k = 0
  v[0] = 0
  z[0] = -Infinity
  z[1] = Infinity
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = Infinity
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const dq = q - v[k]
    d[q] = dq * dq + f[v[k]]
  }
}

/** Squared Euclidean distance (in cells) from every cell to the nearest seed, in place. */
const squaredEdt = (field: Float64Array, cols: number, rows: number): void => {
  const n = Math.max(cols, rows)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  for (let r = 0; r < rows; r++) {
    const base = r * cols
    for (let c = 0; c < cols; c++) f[c] = field[base + c]
    edtPass(f, d, v, z, cols)
    for (let c = 0; c < cols; c++) field[base + c] = d[c]
  }
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) f[r] = field[r * cols + c]
    edtPass(f, d, v, z, rows)
    for (let r = 0; r < rows; r++) field[r * cols + c] = d[r]
  }
}

/**
 * Exact Euclidean distance from each free cell to the nearest blocked cell, in
 * metres. `blocked` is a Uint8Array of grid.cols*grid.rows, 1 = solid. Cells
 * outside the grid count as solid. Blocked cells carry the negated depth to the
 * nearest free cell, so the field is signed and callers can push a body out of
 * a solid it has been shoved into instead of dividing by a flat zero.
 */
export const clearanceField = (grid: NavGrid, blocked: Uint8Array): Float32Array => {
  const { cols, rows, cellSize } = grid
  const count = cols * rows
  const toSolid = new Float64Array(count)
  const toFree = new Float64Array(count)
  let anyFree = false
  for (let i = 0; i < count; i++) {
    const solid = blocked[i] !== 0
    toSolid[i] = solid ? 0 : EDT_FAR
    toFree[i] = solid ? EDT_FAR : 0
    if (!solid) anyFree = true
  }
  squaredEdt(toSolid, cols, rows)
  squaredEdt(toFree, cols, rows)

  const out = new Float32Array(count)
  const span = Math.hypot(cols, rows)
  for (let r = 0; r < rows; r++) {
    // Solid ground beyond every border is a half-plane, so its nearest cell is
    // always the perpendicular one and a plain min against it stays exact.
    const borderRow = Math.min(r + 1, rows - r)
    const base = r * cols
    for (let c = 0; c < cols; c++) {
      const i = base + c
      if (blocked[i] !== 0) {
        out[i] = -(anyFree ? Math.sqrt(toFree[i]) : span) * cellSize
      } else {
        const border = Math.min(borderRow, c + 1, cols - c)
        out[i] = Math.min(Math.sqrt(toSolid[i]), border) * cellSize
      }
    }
  }
  return out
}

/** Binary min-heap over (cell, key) pairs, backed by typed arrays. */
class CellHeap {
  private ids: Int32Array
  private keys: Float64Array
  private count = 0

  constructor(capacity: number) {
    const cap = Math.max(16, capacity)
    this.ids = new Int32Array(cap)
    this.keys = new Float64Array(cap)
  }

  push(id: number, key: number): void {
    if (this.count === this.ids.length) this.grow()
    const ids = this.ids
    const keys = this.keys
    let i = this.count++
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (keys[parent] <= key) break
      ids[i] = ids[parent]
      keys[i] = keys[parent]
      i = parent
    }
    ids[i] = id
    keys[i] = key
  }

  /** Cell with the smallest key, or -1 when the heap is empty. */
  pop(): number {
    if (this.count === 0) return -1
    const ids = this.ids
    const keys = this.keys
    const top = ids[0]
    const last = --this.count
    if (last > 0) {
      const id = ids[last]
      const key = keys[last]
      let i = 0
      for (;;) {
        let child = 2 * i + 1
        if (child >= last) break
        if (child + 1 < last && keys[child + 1] < keys[child]) child++
        if (keys[child] >= key) break
        ids[i] = ids[child]
        keys[i] = keys[child]
        i = child
      }
      ids[i] = id
      keys[i] = key
    }
    return top
  }

  private grow(): void {
    const ids = new Int32Array(this.ids.length * 2)
    const keys = new Float64Array(this.keys.length * 2)
    ids.set(this.ids)
    keys.set(this.keys)
    this.ids = ids
    this.keys = keys
  }
}

/** Radius in cells of the analytically seeded disc around each goal cell. */
const SEED_RADIUS = 3

/**
 * True when every cell of the rectangle spanned by two cells is free and runs
 * at one speed. A filled rectangle is convex, so this is a cheap sufficient
 * test for line of sight; requiring one speed as well makes a straight-line
 * arrival time across it exact rather than a guess at a line integral.
 */
const boxIsOpen = (
  blocked: Uint8Array,
  speed: Float32Array,
  cols: number,
  c0: number,
  r0: number,
  c1: number,
  r1: number,
): boolean => {
  const cLo = c0 < c1 ? c0 : c1
  const cHi = c0 < c1 ? c1 : c0
  const rLo = r0 < r1 ? r0 : r1
  const rHi = r0 < r1 ? r1 : r0
  const s = speed[r0 * cols + c0]
  for (let r = rLo; r <= rHi; r++) {
    const base = r * cols
    for (let c = cLo; c <= cHi; c++) {
      if (blocked[base + c] !== 0 || speed[base + c] !== s) return false
    }
  }
  return true
}

/**
 * Fast-marching solve of |grad T| = 1 / speed, from the given goal cells outward.
 * - `speed` is a per-cell traversal speed multiplier in (0, 1]; 0 or blocked cells are impassable.
 * - Returns T (arrival time / cost-to-goal) in a Float32Array; unreachable cells are Infinity.
 * - Goal cells that are themselves impassable are ignored rather than seeded, which would let
 *   the wave escape through the obstacle containing them.
 */
export const solveEikonal = (
  grid: NavGrid,
  blocked: Uint8Array,
  speed: Float32Array,
  goalCells: readonly number[],
): Float32Array => {
  const { cols, rows, cellSize } = grid
  const count = cols * rows
  const time = new Float32Array(count).fill(Infinity)
  const frozen = new Uint8Array(count)
  const heap = new CellHeap(Math.min(count, 4096))

  const relax = (c: number, r: number): void => {
    const i = r * cols + c
    if (frozen[i] !== 0 || blocked[i] !== 0) return
    const s = speed[i]
    if (!(s > 0)) return

    // Upwind values: the smallest frozen arrival time on each axis.
    let a = Infinity
    if (c > 0 && frozen[i - 1] !== 0) a = time[i - 1]
    if (c + 1 < cols && frozen[i + 1] !== 0 && time[i + 1] < a) a = time[i + 1]
    let b = Infinity
    if (r > 0 && frozen[i - cols] !== 0) b = time[i - cols]
    if (r + 1 < rows && frozen[i + cols] !== 0 && time[i + cols] < b) b = time[i + cols]

    const f = cellSize / s
    let candidate: number
    if (b === Infinity) {
      candidate = a + f
    } else if (a === Infinity) {
      candidate = b + f
    } else {
      const diff = a - b
      // When the two upwind values differ by more than one cell's cost, no
      // characteristic passes through both and the wave arrives along the
      // nearer axis alone.
      candidate =
        Math.abs(diff) >= f ? Math.min(a, b) + f : (a + b + Math.sqrt(2 * f * f - diff * diff)) / 2
    }
    if (candidate < time[i]) {
      time[i] = candidate
      // Push the stored float32, so heap order cannot disagree with the field.
      heap.push(i, time[i])
    }
  }

  for (const cell of goalCells) {
    if (cell < 0 || cell >= count || blocked[cell] !== 0 || !(speed[cell] > 0)) continue
    time[cell] = 0
    heap.push(cell, 0)
  }

  // Pre-lower a small disc around each goal to the exact straight-line arrival
  // time. The update above is exact for a planar arrival-time field but reads
  // 20% long on the diagonal neighbour of a point source, and because it is
  // exact thereafter that error rides outward undiminished — it is what makes a
  // naively seeded solve come out several percent long on the diagonals. These
  // cells enter the band like any other, so nothing here can strand a region:
  // the goal cells themselves are queued above and relax all of their own
  // neighbours when they thaw.
  for (const cell of goalCells) {
    if (cell < 0 || cell >= count || time[cell] !== 0) continue
    const col = cell % cols
    const row = (cell - col) / cols
    const cost = cellSize / speed[cell]
    const rLo = Math.max(0, row - SEED_RADIUS)
    const rHi = Math.min(rows - 1, row + SEED_RADIUS)
    const cLo = Math.max(0, col - SEED_RADIUS)
    const cHi = Math.min(cols - 1, col + SEED_RADIUS)
    for (let r = rLo; r <= rHi; r++) {
      for (let c = cLo; c <= cHi; c++) {
        const i = r * cols + c
        if (blocked[i] !== 0) continue
        const dc = c - col
        const dr = r - row
        const span = Math.sqrt(dc * dc + dr * dr)
        if (span > SEED_RADIUS) continue
        const candidate = span * cost
        if (candidate >= time[i]) continue
        if (!boxIsOpen(blocked, speed, cols, col, row, c, r)) continue
        time[i] = candidate
        heap.push(i, time[i])
      }
    }
  }

  for (;;) {
    const cell = heap.pop()
    if (cell < 0) break
    if (frozen[cell] !== 0) continue // superseded entry
    frozen[cell] = 1
    const col = cell % cols
    const row = (cell - col) / cols
    if (col > 0) relax(col - 1, row)
    if (col + 1 < cols) relax(col + 1, row)
    if (row > 0) relax(col, row - 1)
    if (row + 1 < rows) relax(col, row + 1)
  }
  return time
}

/**
 * Bilinear blend that drops non-finite corners and renormalises the weights.
 * Unreachable cells hold Infinity; without this every sample within a cell of
 * one would be NaN and the steering built on it would go undefined.
 */
const blendFinite = (
  v00: number,
  v10: number,
  v01: number,
  v11: number,
  tx: number,
  ty: number,
  fallback: number,
): number => {
  let sum = 0
  let weight = 0
  const w00 = (1 - tx) * (1 - ty)
  if (w00 > 0 && Number.isFinite(v00)) {
    sum += v00 * w00
    weight += w00
  }
  const w10 = tx * (1 - ty)
  if (w10 > 0 && Number.isFinite(v10)) {
    sum += v10 * w10
    weight += w10
  }
  const w01 = (1 - tx) * ty
  if (w01 > 0 && Number.isFinite(v01)) {
    sum += v01 * w01
    weight += w01
  }
  const w11 = tx * ty
  if (w11 > 0 && Number.isFinite(v11)) {
    sum += v11 * w11
    weight += w11
  }
  return weight > 0 ? sum / weight : fallback
}

/**
 * Bilinear sample of any Float32Array field over the grid. Out-of-range returns
 * `fallback`. Cells set in `excluded` are left out, as unreachable cells are.
 */
export const sampleField = (
  grid: NavGrid,
  field: Float32Array,
  x: number,
  y: number,
  fallback: number,
  excluded?: Uint8Array,
): number => {
  const { cols, rows, cellSize } = grid
  const gx = (x - grid.originX) / cellSize - 0.5
  const gy = (y - grid.originY) / cellSize - 0.5
  if (gx < -0.5 || gy < -0.5 || gx > cols - 0.5 || gy > rows - 0.5) return fallback

  // The outer half-cell has no second sample to interpolate against, so clamping
  // holds the edge value there rather than dropping out to `fallback`.
  const cx = gx < 0 ? 0 : gx > cols - 1 ? cols - 1 : gx
  const cy = gy < 0 ? 0 : gy > rows - 1 ? rows - 1 : gy
  const c0 = Math.floor(cx)
  const r0 = Math.floor(cy)
  const c1 = c0 + 1 < cols ? c0 + 1 : c0
  const r1 = r0 + 1 < rows ? r0 + 1 : r0
  const tx = cx - c0
  const ty = cy - r0

  const base0 = r0 * cols
  const base1 = r1 * cols
  const v00 = excluded?.[base0 + c0] ? Infinity : field[base0 + c0]
  const v10 = excluded?.[base0 + c1] ? Infinity : field[base0 + c1]
  const v01 = excluded?.[base1 + c0] ? Infinity : field[base1 + c0]
  const v11 = excluded?.[base1 + c1] ? Infinity : field[base1 + c1]
  const top = v00 + (v10 - v00) * tx
  const bottom = v01 + (v11 - v01) * tx
  const value = top + (bottom - top) * ty
  return Number.isFinite(value) ? value : blendFinite(v00, v10, v01, v11, tx, ty, fallback)
}

/**
 * Clamp a world coordinate onto the band spanned by the cell centres of one
 * axis — the same clamp `sampleField` applies internally.
 */
const centreBand = (v: number, origin: number, cellSize: number, n: number): number => {
  const lo = origin + cellSize * 0.5
  const hi = origin + (n - 0.5) * cellSize
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Bilinearly sample the potential and return the downhill unit direction at a
 * world point (the direction of travel towards the goal), plus the sampled
 * potential. Returns null when the sample point sits in an unreachable region;
 * the direction is (0, 0) where the potential is flat, such as on the goal itself.
 * Cells set in `excluded` are read as unreachable, so the gradient runs along
 * them the way it runs along a wall.
 */
export const sampleGradient = (
  grid: NavGrid,
  potential: Float32Array,
  x: number,
  y: number,
  excluded?: Uint8Array,
): { dx: number; dy: number; value: number } | null => {
  const value = sampleField(grid, potential, x, y, Infinity, excluded)
  if (!Number.isFinite(value)) return null

  const { originX, originY, cellSize, cols, rows } = grid
  // Half a cell: wide enough to step off the bilinear kink at a cell boundary,
  // narrow enough not to reach across a wall into an unrelated corridor.
  const h = cellSize * 0.5
  // Probe from the cell-centre band rather than from the raw point. `sampleField`
  // holds the outer half-cell at the edge cell's value, so a probe pair straddling
  // the border reads the same cell twice: the perpendicular component would cancel
  // to zero and steering would slide along the border instead of turning inward.
  const px = centreBand(x, originX, cellSize, cols)
  const py = centreBand(y, originY, cellSize, rows)
  const xw = centreBand(px - h, originX, cellSize, cols)
  const xe = centreBand(px + h, originX, cellSize, cols)
  const ys = centreBand(py - h, originY, cellSize, rows)
  const yn = centreBand(py + h, originY, cellSize, rows)

  const west = sampleField(grid, potential, xw, py, Infinity, excluded)
  const east = sampleField(grid, potential, xe, py, Infinity, excluded)
  const south = sampleField(grid, potential, px, ys, Infinity, excluded)
  const north = sampleField(grid, potential, px, yn, Infinity, excluded)

  // One-sided wherever the far side is walled off, or where the band ran out and
  // the probe collapsed back onto the sample point. Each difference is divided by
  // the span it actually covers, which that clamp can shorten.
  const hasWest = xw < px && Number.isFinite(west)
  const hasEast = xe > px && Number.isFinite(east)
  let gx = 0
  if (hasWest && hasEast) gx = (east - west) / (xe - xw)
  else if (hasEast) gx = (east - value) / (xe - px)
  else if (hasWest) gx = (value - west) / (px - xw)

  const hasSouth = ys < py && Number.isFinite(south)
  const hasNorth = yn > py && Number.isFinite(north)
  let gy = 0
  if (hasSouth && hasNorth) gy = (north - south) / (yn - ys)
  else if (hasNorth) gy = (north - value) / (yn - py)
  else if (hasSouth) gy = (value - south) / (py - ys)

  const len = Math.hypot(gx, gy)
  if (len < 1e-9) return { dx: 0, dy: 0, value }
  return { dx: -gx / len, dy: -gy / len, value }
}

const ascending = (a: number, b: number): number => a - b

/** Squared point-segment distance in scalars; the dilation loop must not box a Vec2 per cell. */
const segmentDistSq = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number => {
  const abx = bx - ax
  const aby = by - ay
  const lenSq = abx * abx + aby * aby
  let t = lenSq < 1e-18 ? 0 : ((px - ax) * abx + (py - ay) * aby) / lenSq
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const dx = px - (ax + abx * t)
  const dy = py - (ay + aby * t)
  return dx * dx + dy * dy
}

/**
 * Rasterise a filled polygon into a Uint8Array mask (scanline fill, with an
 * optional dilation in metres). Cells are sampled at their centres, so a
 * feature thinner than a cell can fall between samples and mark nothing —
 * dilate by at least half a cell wherever the mask has to be conservative,
 * as a nav mask does.
 */
export const rasterizePolygon = (
  grid: NavGrid,
  polygon: readonly Vec2[],
  out: Uint8Array,
  value = 1,
  dilate = 0,
): void => {
  const n = polygon.length
  if (n < 2) return
  const { cols, rows, cellSize, originX, originY } = grid
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of polygon) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }

  if (n >= 3) {
    // Scanline: one sorted crossing list per row, rather than a point-in-polygon
    // test per cell, keeps this linear in the polygon's area.
    const rowLo = Math.max(0, Math.ceil((minY - originY) / cellSize - 0.5))
    const rowHi = Math.min(rows - 1, Math.floor((maxY - originY) / cellSize - 0.5))
    const crossings: number[] = []
    for (let r = rowLo; r <= rowHi; r++) {
      const y = originY + (r + 0.5) * cellSize
      crossings.length = 0
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const pi = polygon[i]
        const pj = polygon[j]
        if (pi.y > y !== pj.y > y) {
          crossings.push(pi.x + ((y - pi.y) / (pj.y - pi.y)) * (pj.x - pi.x))
        }
      }
      if (crossings.length < 2) continue
      crossings.sort(ascending)
      const base = r * cols
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const colLo = Math.max(0, Math.ceil((crossings[k] - originX) / cellSize - 0.5))
        const colHi = Math.min(cols - 1, Math.floor((crossings[k + 1] - originX) / cellSize - 0.5))
        for (let c = colLo; c <= colHi; c++) out[base + c] = value
      }
    }
  }

  if (dilate <= 0) return
  const dilateSq = dilate * dilate
  const rowLo = Math.max(0, Math.ceil((minY - dilate - originY) / cellSize - 0.5))
  const rowHi = Math.min(rows - 1, Math.floor((maxY + dilate - originY) / cellSize - 0.5))
  const colLo = Math.max(0, Math.ceil((minX - dilate - originX) / cellSize - 0.5))
  const colHi = Math.min(cols - 1, Math.floor((maxX + dilate - originX) / cellSize - 0.5))
  for (let r = rowLo; r <= rowHi; r++) {
    const py = originY + (r + 0.5) * cellSize
    const base = r * cols
    for (let c = colLo; c <= colHi; c++) {
      const i = base + c
      if (out[i] === value) continue
      const px = originX + (c + 0.5) * cellSize
      for (let k = 0, j = n - 1; k < n; j = k++) {
        if (
          segmentDistSq(px, py, polygon[j].x, polygon[j].y, polygon[k].x, polygon[k].y) <= dilateSq
        ) {
          out[i] = value
          break
        }
      }
    }
  }
}
