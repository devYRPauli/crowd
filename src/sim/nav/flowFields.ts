/**
 * Route planning.
 *
 * People do not all walk the geometrically shortest line. Two things here make
 * them diverge, and both matter for the answers this product gives:
 *
 *  - Every destination carries two potentials. The *static* one solves for the
 *    shortest path; the *congested* one re-solves periodically with local
 *    density lowering the traversal speed, so its gradient bends around a
 *    crowd. Each person follows one or the other according to how
 *    congestion-aware they are, which is what produces genuine route splits at
 *    a bottleneck rather than one thick column.
 *  - Density is measured with a smoothed kernel, so a field does not thrash
 *    between two routes as a single person crosses a cell boundary.
 *
 * Fields are recomputed on a budget: at most a couple per tick, oldest first.
 * A venue with a dozen destinations therefore refreshes every route a few times
 * a minute of simulated time without ever stalling a frame.
 */

import type { Vec2 } from '../../core/math/vec2'
import type { NavGrid } from './eikonal'
import { sampleGradient, solveEikonal } from './eikonal'
import { weidmannFactor } from '../metrics/los'

export interface RouteField {
  id: string
  goalCells: number[]
  /** Shortest-path potential; recomputed only when the plan changes. */
  staticPotential: Float32Array
  /** Congestion-aware potential; recomputed on the replan interval. */
  congestedPotential: Float32Array
  /** Simulation time the congested field was last solved. */
  refreshedAt: number
}

export interface RouteDirection {
  dx: number
  dy: number
  /** Remaining travel cost to the goal, in seconds. */
  cost: number
}

export interface FlowFieldOptions {
  /** How strongly density lowers traversal speed, 0–1. */
  congestionWeight: number
  /** Seconds between refreshes of a congested field. */
  replanIntervalS: number
  /** Fields recomputed per tick, to bound the cost of a single step. */
  budgetPerTick: number
}

export const DEFAULT_FLOW_OPTIONS: FlowFieldOptions = {
  congestionWeight: 0.55,
  replanIntervalS: 2,
  budgetPerTick: 2,
}

/**
 * Traversal speed falls with density, following Weidmann's relation. Using the
 * same curve for routing cost and for how fast people actually walk keeps the
 * two consistent: a corridor that costs more to cross is one people really are
 * crossing more slowly.
 */
export const speedFromDensity = (density: number): number => weidmannFactor(density)

export class FlowFieldCache {
  private fields = new Map<string, RouteField>()
  private speedScratch: Float32Array
  private queue: string[] = []

  constructor(
    private grid: NavGrid,
    private blocked: Uint8Array,
    private baseSpeed: Float32Array,
    private options: FlowFieldOptions = DEFAULT_FLOW_OPTIONS,
  ) {
    this.speedScratch = new Float32Array(grid.cols * grid.rows)
  }

  setOptions(options: Partial<FlowFieldOptions>): void {
    this.options = { ...this.options, ...options }
  }

  /** Register a destination. Its shortest-path field is solved immediately. */
  ensure(id: string, goalCells: readonly number[]): RouteField {
    const existing = this.fields.get(id)
    if (existing) return existing
    const cells = [...goalCells]
    const staticPotential = solveEikonal(this.grid, this.blocked, this.baseSpeed, cells)
    const field: RouteField = {
      id,
      goalCells: cells,
      staticPotential,
      congestedPotential: staticPotential.slice(),
      refreshedAt: -Infinity,
    }
    this.fields.set(id, field)
    this.queue.push(id)
    return field
  }

  get(id: string): RouteField | undefined {
    return this.fields.get(id)
  }

  has(id: string): boolean {
    return this.fields.has(id)
  }

  /**
   * Refresh the congested fields that are most overdue, up to the per-tick
   * budget. `density` is persons per square metre, per cell.
   */
  update(time: number, density: Float32Array): void {
    if (this.options.congestionWeight <= 0) return
    const due = this.queue
      .map((id) => this.fields.get(id))
      .filter((field): field is RouteField => Boolean(field))
      .filter((field) => time - field.refreshedAt >= this.options.replanIntervalS)
      .sort((a, b) => a.refreshedAt - b.refreshedAt)
      .slice(0, this.options.budgetPerTick)
    if (due.length === 0) return

    const weight = this.options.congestionWeight
    const cells = this.grid.cols * this.grid.rows
    for (let i = 0; i < cells; i++) {
      const crowdFactor = speedFromDensity(density[i])
      this.speedScratch[i] = this.baseSpeed[i] * (1 - weight + weight * crowdFactor)
    }
    for (const field of due) {
      field.congestedPotential = solveEikonal(
        this.grid,
        this.blocked,
        this.speedScratch,
        field.goalCells,
      )
      field.refreshedAt = time
    }
  }

  /**
   * Direction of travel towards a destination.
   *
   * `awareness` blends the two potentials: 0 follows the shortest path, 1
   * follows the congestion-aware one. Blending the *directions* rather than the
   * potentials keeps the result a sensible heading even when the two fields
   * disagree completely.
   */
  direction(id: string, point: Vec2, awareness: number): RouteDirection | null {
    const field = this.fields.get(id)
    if (!field) return null
    const shortest = sampleGradient(this.grid, field.staticPotential, point.x, point.y)
    // Standing inside the destination leaves nothing to descend: the potential
    // is flat and the gradient is zero. That is not a direction, so say so and
    // let the caller steer at whatever exact spot it was aiming for.
    if (shortest && shortest.dx === 0 && shortest.dy === 0) return null
    if (awareness <= 0.01 || field.refreshedAt === -Infinity) {
      return shortest ? { dx: shortest.dx, dy: shortest.dy, cost: shortest.value } : null
    }
    const congested = sampleGradient(this.grid, field.congestedPotential, point.x, point.y)
    if (!congested)
      return shortest ? { dx: shortest.dx, dy: shortest.dy, cost: shortest.value } : null
    if (!shortest) return { dx: congested.dx, dy: congested.dy, cost: congested.value }
    const dx = shortest.dx * (1 - awareness) + congested.dx * awareness
    const dy = shortest.dy * (1 - awareness) + congested.dy * awareness
    const length = Math.hypot(dx, dy)
    if (length < 1e-6) return { dx: shortest.dx, dy: shortest.dy, cost: shortest.value }
    return { dx: dx / length, dy: dy / length, cost: shortest.value }
  }

  /** Remaining travel time to a destination, in seconds. */
  cost(id: string, point: Vec2): number {
    const field = this.fields.get(id)
    if (!field) return Infinity
    const sample = sampleGradient(this.grid, field.staticPotential, point.x, point.y)
    return sample ? sample.value : Infinity
  }

  /** Drop fields for destinations that no longer exist. */
  retain(ids: ReadonlySet<string>): void {
    for (const id of [...this.fields.keys()]) {
      if (!ids.has(id)) this.fields.delete(id)
    }
    this.queue = this.queue.filter((id) => ids.has(id))
  }

  get size(): number {
    return this.fields.size
  }
}

/**
 * Crowd density.
 *
 * Density has to be measured over an area a person actually occupies, not over
 * one grid cell: at a 0.3 m cell size a single person alone in a hall would
 * otherwise read as eleven persons per square metre and be told to stop
 * walking. Each person is therefore spread with a Gaussian kernel of about
 * 0.7 m — the standard estimator in the pedestrian-dynamics literature — which
 * puts a lone walker at roughly 0.3 persons/m² and a tightly packed crowd near
 * five, both of which match observation.
 *
 * The kernel is precomputed once as a stamp of cell offsets and weights, so
 * depositing a person costs a fixed handful of adds.
 */
/**
 * How far ahead of themselves a walker judges their pace on, in metres.
 *
 * Density has to be read in the direction of travel, not in a ring around the
 * walker, and the difference is not a detail. A ring counts the people *behind*
 * you, and a person at the front of a bunch — with open floor ahead and the
 * bunch at their back — is then told to slow down, which closes the gap behind
 * them and makes the bunch tighter. That is a feedback loop with the sign the
 * wrong way round: run a corridor at a steady 1.5 persons/m² with a ring and it
 * does not stay steady, it clots into platoons that each report 2.7 persons/m²
 * to the people inside them, and the whole crowd walks at the pace of a crowd
 * twice as dense. Read the space you are walking into instead and the front of
 * a bunch pulls away, which is what dissolves it — and what real pedestrians
 * visibly do.
 *
 * Three quarters of a metre is about one stride, and close enough to the 0.7 m
 * kernel width that the two describe the same patch of floor.
 */
export const PACE_LOOKAHEAD = 0.45

/** Body radius of a typical adult, and the one the estimator is calibrated on. */
export const NOMINAL_BODY_RADIUS = 0.23

/**
 * How much a kernel density estimate under-reads a crowd of solid bodies, and
 * the factor that puts it right.
 *
 * A kernel estimator is unbiased for points that may lie anywhere, including on
 * top of one another. People may not: nobody else's centre can come closer than
 * two body radii, so a disc of that radius around everybody is guaranteed
 * empty. The kernel still expects to find people in it, and what it expects is
 * a known share of its mass — for a Gaussian, `1 − exp(−(2r)²/2σ²)`, which for
 * a 0.23 m body and a 0.7 m bandwidth is 19% of the total. So the estimate
 * comes back about a fifth light, at every density, the shortfall being
 * proportional to how many people there are.
 *
 * The periodic-corridor sweep measures the shortfall at 11–16% once the crowd
 * is dense enough to have one: a little less than the 19% this predicts,
 * because the derivation assumes people are otherwise uniformly arranged and
 * bodies packed to contact are not — they pile extra mass just outside the
 * exclusion disc, which gives part of the shortfall back.
 *
 * It matters well beyond the speed law. This field is what the heat map paints,
 * what Fruin's bands classify and what the crowd-safety overlay fires on, so
 * uncorrected it puts a 4.0 persons/m² crush on screen as 3.2 and says nothing
 * — and disagrees by that much with the per-area figures in the same report,
 * which count heads inside a polygon and need no correction of any kind.
 */
export function hardCoreCorrection(bodyRadius: number, bandwidth: number): number {
  const contact = 2 * bodyRadius
  return Math.exp((contact * contact) / (2 * bandwidth * bandwidth))
}

export class DensityField {
  readonly values: Float32Array
  private accumulator: Float32Array
  private stampOffsets: Int32Array
  private stampWeights: Float32Array
  private stampCols: Int32Array
  private stampRows: Int32Array
  /**
   * Fraction of each cell's kernel that lands on floor somebody could stand on.
   *
   * Without this a corridor under-reports its own density: the kernel is 0.7 m
   * wide, so for anyone within that of a wall a large part of it falls inside
   * the wall, where there is nobody — and the crowd reads as thinner than it
   * is. In a 3 m corridor that is most of the crowd. Dividing by the walkable
   * coverage makes the number what Fruin's bands actually mean: persons per
   * square metre *of usable floor*.
   */
  private coverage: Float32Array
  /** Weight a person deposits at their own cell, before the coverage division. */
  private peakWeight = 0
  /** Kernel standard deviation, kept so a walker's own weight can be re-evaluated. */
  private readonly bandwidth: number

  constructor(
    private grid: NavGrid,
    /** Kernel standard deviation in metres. */
    bandwidth = 0.7,
    /** 1 where a cell is solid. Omitted, every cell counts as walkable. */
    blocked?: Uint8Array,
    /** Body radius the hard-core correction is calibrated on. */
    bodyRadius = NOMINAL_BODY_RADIUS,
  ) {
    this.bandwidth = bandwidth
    const cells = grid.cols * grid.rows
    this.values = new Float32Array(cells)
    this.accumulator = new Float32Array(cells)

    const reach = Math.ceil((bandwidth * 2.2) / grid.cellSize)
    const offsets: number[] = []
    const weights: number[] = []
    const cols: number[] = []
    const rows: number[] = []
    const norm =
      (1 / (2 * Math.PI * bandwidth * bandwidth)) * hardCoreCorrection(bodyRadius, bandwidth)
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const distanceSq = (dx * dx + dy * dy) * grid.cellSize * grid.cellSize
        const weight = norm * Math.exp(-distanceSq / (2 * bandwidth * bandwidth))
        if (weight < norm * 0.01) continue
        offsets.push(dy * grid.cols + dx)
        weights.push(weight)
        cols.push(dx)
        rows.push(dy)
      }
    }
    this.stampOffsets = Int32Array.from(offsets)
    this.stampWeights = Float32Array.from(weights)
    this.stampCols = Int32Array.from(cols)
    this.stampRows = Int32Array.from(rows)

    let total = 0
    for (const weight of this.stampWeights) total += weight
    for (let k = 0; k < this.stampOffsets.length; k++) {
      if (this.stampCols[k] === 0 && this.stampRows[k] === 0) this.peakWeight = this.stampWeights[k]
    }
    this.coverage = new Float32Array(cells)
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const index = row * grid.cols + col
        let walkable = 0
        for (let k = 0; k < this.stampOffsets.length; k++) {
          const c = col + this.stampCols[k]
          const r = row + this.stampRows[k]
          if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) continue
          if (blocked && blocked[r * grid.cols + c]) continue
          walkable += this.stampWeights[k]
        }
        // Floor the correction: a cell almost entirely enclosed would otherwise
        // divide by nearly nothing and report an absurd density.
        this.coverage[index] = Math.max(0.3, walkable / total)
      }
    }
  }

  /** Rebuild from the current positions, blended towards the previous value. */
  update(positions: Float32Array, count: number, smoothing = 0.35): void {
    this.accumulator.fill(0)
    const { cols, rows, cellSize, originX, originY } = this.grid
    for (let i = 0; i < count; i++) {
      const col = Math.round((positions[i * 2] - originX) / cellSize - 0.5)
      const row = Math.round((positions[i * 2 + 1] - originY) / cellSize - 0.5)
      if (col < 0 || row < 0 || col >= cols || row >= rows) continue
      const base = row * cols + col
      for (let k = 0; k < this.stampOffsets.length; k++) {
        const c = col + this.stampCols[k]
        const r = row + this.stampRows[k]
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue
        this.accumulator[base + this.stampOffsets[k]] += this.stampWeights[k]
      }
    }
    for (let i = 0; i < this.values.length; i++) {
      const corrected = this.accumulator[i] / this.coverage[i]
      this.values[i] += (corrected - this.values[i]) * (1 - smoothing)
    }
  }

  /**
   * Density of *other* people at a point.
   *
   * What slows somebody down is the crowd around them, not their own body. The
   * field deliberately includes everyone — a person standing alone still
   * occupies space, and level of service is about area per person — but when
   * the number is used to decide how fast to walk, the walker's own
   * contribution has to come off first. It is not small: the kernel peaks at
   * 0.32 persons/m² at its own centre, and against a wall the coverage
   * correction doubles that, which was enough to slow a lone walker in an empty
   * corridor below their free speed.
   *
   * `distance` is how far the sample point sits from the walker, so that a
   * walker reading the floor ahead of them (`PACE_LOOKAHEAD`) has the right
   * amount of themselves taken off rather than all of it.
   */
  othersAt(x: number, y: number, sampled: number, distance = 0): number {
    const { cols, rows, cellSize, originX, originY } = this.grid
    const col = Math.round((x - originX) / cellSize - 0.5)
    const row = Math.round((y - originY) / cellSize - 0.5)
    if (col < 0 || row < 0 || col >= cols || row >= rows) return Math.max(0, sampled)
    const own =
      this.peakWeight * Math.exp(-(distance * distance) / (2 * this.bandwidth * this.bandwidth))
    return Math.max(0, sampled - own / this.coverage[row * cols + col])
  }

  reset(): void {
    this.values.fill(0)
    this.accumulator.fill(0)
  }
}
