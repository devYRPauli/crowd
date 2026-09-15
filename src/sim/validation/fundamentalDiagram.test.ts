/**
 * The pedestrian fundamental diagram: the speed–density relation this
 * simulator's locomotion actually produces, measured and compared against
 * Weidmann's calibration curve.
 *
 * What is under test is the **locomotion model, not the whole engine**: ORCA
 * local avoidance (`computeNewVelocity`), the crowd slowdown applied to the
 * preferred speed (`speedFromDensity`) and the Gaussian density estimator,
 * wired together in a corridor whose x axis wraps. `Simulation` cannot be used
 * because it has no periodic boundaries: everything it can express has people
 * entering somewhere and leaving somewhere else, so the density in a corridor
 * is whatever the upstream bottleneck happens to deliver and never settles at a
 * value we chose. Wrapping the corridor holds a chosen density indefinitely,
 * which is the only way to sweep a diagram point by point.
 *
 * The harness draws the line between *physics* and *heuristics* and takes only
 * the physics. In: agent size, free speed, time horizons, reciprocity, the
 * timestep, the 0.7 m density kernel, and the positional passes that stop
 * bodies interpenetrating — `relaxOverlaps` and the push out of a wall that
 * `integrate` does from the clearance field. Those last two are not tuning
 * knobs, they are the engine's statement that people are solid, and without
 * them assertion 6 below would be measuring nothing: ORCA is a velocity-space
 * method, it prevents collisions it can see coming and cannot undo one that
 * already exists. Out: the engine's jam-breaking heuristics — the sidestep, the
 * creep, the time horizon that shortens under pressure, the re-plan. Those
 * exist so a venue never deadlocks; including them would measure the recovery
 * machinery rather than the locomotion model. For the record, with the two
 * positional passes removed as well — ORCA and nothing else — this sweep
 * measures pairs overlapping by up to 99% of their radii and a corridor
 * deadlocked at 0.002 m/s above 3.5 persons/m². That is the known behaviour of
 * bare ORCA in dense packing and it is why the engine has those passes.
 *
 * Two tables come out, because one run is not one point. The per-run table
 * pairs each sweep point's box density with its box speed. The pooled table
 * beneath it bins every tick's local measurement by its own local density,
 * which is how the experimental literature extracts a fundamental diagram and
 * is the estimator that survives a crowd which is not uniform. The assertions
 * are on the per-run sweep; the pooled curve is there so a reader can see which
 * part of any disagreement is the model and which is the estimator.
 *
 * An earlier version of this file recorded a clustering instability here, and
 * it was worth recording. People were slowed at the time by an isotropic
 * kernel, which counts the crowd behind you as much as the crowd in front, so
 * whoever reached the front of a bunch was told to slow down and the bunch
 * grew: a corridor set to a steady 1.5 persons/m² clotted into platoons that
 * reported 2.7 to the people inside them, and the sweep was measuring the
 * platoons. Reading density one stride ahead instead (`PACE_LOOKAHEAD`) removed
 * it. Box density now tracks the density each run was set up to hold across the
 * whole sweep, and the `rho felt` column — the density the walkers themselves
 * act on — is printed beside it so that the two can be seen not to diverge.
 *
 * The printed tables are the point of the file. They go to console.warn so the
 * measured curve shows up in CI output rather than only as a pass/fail tick.
 *
 * Where it stands today, from the run this file's comments quote. Free-flow
 * speed and body exclusion are right: 1.338 m/s in a nearly empty corridor
 * against a free speed of 1.34, and no pair overlapping by more than 0.1% of
 * two radii anywhere in the sweep. Agreement with Weidmann is 0.0418 m/s RMSE
 * per run and 0.0318 m/s pooled over 0.5–4.0 persons/m², and the flow peak —
 * the capacity number this model is most likely to be quoted on — comes out at
 * 1.2327 p/m/s at 1.809 persons/m² against the curve's own 1.2249 at 1.751.
 * Above 3.6 persons/m² the model walks faster than Weidmann, deliberately:
 * `weidmannFactor` floors its multiplier at 0.12 so that a jam shuffles at
 * 0.161 m/s rather than freezing, at densities where the curve has the crowd
 * stopped. Every assertion below now holds. None of the thresholds were
 * loosened to get there; what moved was the model, and the comment on each
 * assertion says what.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { buildObstacles, computeNewVelocity, type OrcaAgentState } from '../avoidance/orca'
import { ObstacleIndex } from '../avoidance/obstacleIndex'
import { SEPARATION, separationScale } from '../avoidance/separation'
import { hardCoreCorrection, PACE_LOOKAHEAD, speedFromDensity } from '../nav/flowFields'
import { weidmannSpeed } from '../metrics/los'
import { Rng } from '../../core/math/random'
import type { Vec2 } from '../../core/math/vec2'

// --- corridor and agent parameters ------------------------------------------

const LENGTH = 20
const WIDTH = 3
const AREA = LENGTH * WIDTH

/** Engine agent parameters: the adult profile, and `DEFAULT_SIM_OPTIONS.timeStep`. */
const RADIUS = 0.23
const FREE_SPEED = 1.34
/** The engine lets people exceed their preferred speed by this much. */
const MAX_SPEED = FREE_SPEED * 1.35
const TIME_HORIZON = 2.2
const TIME_HORIZON_OBST = 0.8
const RESPONSIBILITY = 0.5
const DT = 0.1

/** `DensityField`'s kernel, evaluated directly so that it can wrap with the corridor. */
const BANDWIDTH = 0.7
const KERNEL_NORM =
  (1 / (2 * Math.PI * BANDWIDTH * BANDWIDTH)) * hardCoreCorrection(RADIUS, BANDWIDTH)
const KERNEL_DENOMINATOR = 2 * BANDWIDTH * BANDWIDTH
/** Where the engine's precomputed stamp drops weights below 1% of the peak. */
const DENSITY_RANGE = 2.1

/**
 * The share of the kernel that lands on floor somebody could stand on, for a
 * point `y` metres from the near wall of a corridor `WIDTH` wide.
 *
 * `DensityField` divides by the same quantity, computed from the obstacle mask;
 * here the walls are known analytically, so the exact Gaussian marginal is used.
 * Without it a person standing against a wall reads half the density that is
 * actually around them, because the other half of their kernel is inside the
 * wall where nobody can be. In a 3 m corridor that is most of the crowd, and it
 * is the difference between a model that slows down like a crowd and one that
 * walks too fast.
 */
const erf = (value: number): number => {
  // Abramowitz and Stegun 7.1.26: enough for a normalisation factor.
  const sign = value < 0 ? -1 : 1
  const x = Math.abs(value)
  const t = 1 / (1 + 0.3275911 * x)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x)
  return sign * y
}

const normalCdf = (z: number): number => 0.5 * (1 + erf(z / Math.SQRT2))

const wallCoverage = (y: number): number =>
  Math.max(0.3, normalCdf((WIDTH - y) / BANDWIDTH) - normalCdf(-y / BANDWIDTH))

/**
 * Neighbour search columns. Three adjacent columns cover everything within one
 * column width of any point in the middle one, so the width is the range.
 */
/**
 * Columns for the neighbour search. The three columns around a walker have to
 * hold everyone their density kernel can reach from the point they read it,
 * which sits `PACE_LOOKAHEAD` ahead of them — so a column must be at least
 * `DENSITY_RANGE + PACE_LOOKAHEAD` wide. The test below holds this.
 */
const COLUMNS = 6
const COLUMN_WIDTH = LENGTH / COLUMNS
const NEIGHBOUR_RANGE = COLUMN_WIDTH
/** Matches the engine's cap, except that the nearest are kept, not the first found. */
const MAX_NEIGHBOURS = 12

/** Finer columns for the body-exclusion pass, which only reaches one diameter. */
const FINE_COLUMNS = 40
const FINE_WIDTH = LENGTH / FINE_COLUMNS

/**
 * Central measurement area.
 *
 * Density is counted here rather than globally because a global count divides
 * by floor nobody can stand on — the 0.23 m along each wall that a body centre
 * cannot enter — and that bias is worst exactly where the curve is steepest.
 * Speed is averaged over the people in the same box, not over the whole
 * corridor, because the two numbers have to describe the same crowd: this model
 * clusters, and pairing a local density with a corridor-wide speed reads a
 * jam's density against free-flowing people's speed and invents flows no crowd
 * achieves. The corridor-wide average is measured too and printed beside it,
 * because the gap between the two is the size of that effect.
 */
const BOX_X0 = LENGTH / 2 - 1
const BOX_X1 = LENGTH / 2 + 1
const BOX_Y0 = WIDTH / 2 - 1
const BOX_Y1 = WIDTH / 2 + 1
const BOX_AREA = (BOX_X1 - BOX_X0) * (BOX_Y1 - BOX_Y0)

/** Pooled local diagram: bin width, and the smoothing applied before binning. */
const BIN_WIDTH = 0.25
const BINS = 24
/** 2 s, enough to take the counting noise out of a box holding a handful of people. */
const SMOOTHING_TICKS = 20
/** Below this a bin is a rumour, not a measurement. */
const MIN_BIN_SAMPLES = 60

const SEED = 20260915

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
]

/**
 * The two corridor walls, as counter-clockwise solids of the kind `world.ts`
 * builds from a `Wall`. They overhang both ends of the corridor by far more
 * than the neighbour range so that no agent ever sees a wall end: the corridor
 * wraps, the walls cannot, and a visible end vertex would put a corner in the
 * flow that the real geometry does not have.
 */
const OBSTACLES = buildObstacles([
  rect(-10, -0.4, LENGTH + 10, 0),
  rect(-10, WIDTH, LENGTH + 10, WIDTH + 0.4),
])
const OBSTACLE_INDEX = new ObstacleIndex(
  OBSTACLES,
  { minX: -10, minY: -1, maxX: LENGTH + 10, maxY: WIDTH + 1 },
  2,
)

// --- initial placement -------------------------------------------------------

/**
 * One staggered lattice, sized once for the densest point of the sweep; every
 * run takes a subset of its sites.
 *
 * The top of the sweep sits at the packing limit for 0.23 m discs, so people
 * cannot be scattered at random: a rejection sampler saturates around
 * 3.3 persons/m² and would never terminate, and starting anyone overlapping
 * would hand ORCA a state it is not built to resolve. A lattice guarantees
 * hard-core separation at every density.
 *
 * Rows sit as close together as contact allows — two rows apart in the same
 * column is the binding constraint, so the pitch is half a contact distance.
 * The fine pitch is not about packing, it is about measurement: the row pitch
 * quantises where people can be across the corridor, and a coarse one makes the
 * 2 m measurement window catch a share of the rows that does not match its
 * share of the width. At this pitch the window reads within 2% of the density
 * the corridor holds; at the 0.42 m pitch of a hexagonal packing it read 11%
 * low, which is most of a fundamental diagram's error budget spent on the
 * placement of the starting lattice.
 */
const CONTACT = 2 * RADIUS * 1.02
const Y_LOW = RADIUS + 0.03
const Y_HIGH = WIDTH - RADIUS - 0.03
const LATTICE_ROWS = Math.floor((Y_HIGH - Y_LOW) / (CONTACT / 2)) + 1
const LATTICE_DY = (Y_HIGH - Y_LOW) / (LATTICE_ROWS - 1)
/** Columns wide enough that the half-column stagger still clears the next row. */
const LATTICE_STAGGER = 2 * Math.sqrt(Math.max(0, CONTACT * CONTACT - LATTICE_DY * LATTICE_DY))
const LATTICE_COLS = Math.floor(LENGTH / Math.max(CONTACT, LATTICE_STAGGER))
const LATTICE_DX = LENGTH / LATTICE_COLS
const LATTICE_SITES = LATTICE_ROWS * LATTICE_COLS

/** The engine's clearance push, for a corridor whose clearance is known exactly. */
const pushFromWalls = (y: number): number => {
  const clearance = Math.min(y, WIDTH - y)
  if (clearance >= RADIUS) return y
  const correction = Math.min(RADIUS - clearance, 0.25)
  return y < WIDTH / 2 ? y + correction : y - correction
}

// --- the periodic corridor ---------------------------------------------------

interface CurvePoint {
  /**
   * The density the walkers themselves acted on, averaged over everybody and
   * every measured tick. Printed next to the box density because the two
   * diverging is the signature of a crowd that has clustered, which is a model
   * failure that a speed-against-density table on its own will hide.
   */
  perceived: number
  /** N / 60: the density the run was set up to hold. */
  nominal: number
  /** Time-averaged occupancy of the central 2 m × 2 m box, per m². */
  density: number
  /** Time- and population-averaged forward speed of the people in the box, m/s. */
  speed: number
  /** The same average over the whole corridor, for comparison, m/s. */
  crowdSpeed: number
  /** Weidmann's speed at the measured density, m/s. */
  reference: number
  /** rho · v, persons per metre per second. */
  flow: number
  /** Deepest overlap at any tick, as a fraction of the two radii summed. */
  overlap: number
  /** Closest pair at placement time, m. A harness check, not a result. */
  startSeparation: number
  count: number
  /** Per-bin [samples, summed density, summed speed] for the pooled diagram. */
  bins: Float64Array
}

/**
 * Run one density point and measure it.
 *
 * Velocities are solved for everyone against the previous tick's state and
 * committed together, as in the reference RVO2 implementation, so the answer
 * does not depend on the order agents happen to be stored in.
 */
const runCorridor = (count: number, totalSeconds: number, transientSeconds: number): CurvePoint => {
  if (count > LATTICE_SITES) {
    throw new Error(
      `${count} people do not fit: this corridor holds ${LATTICE_SITES} at contact spacing`,
    )
  }
  const x = new Float64Array(count)
  const y = new Float64Array(count)
  const vx = new Float64Array(count)
  const vy = new Float64Array(count)
  const nextVx = new Float64Array(count)
  const nextVy = new Float64Array(count)
  const shiftX = new Float64Array(count)
  const shiftY = new Float64Array(count)

  const rng = new Rng(SEED)
  // Rows are filled round-robin and the columns within a row are drawn at
  // random. Spreading people evenly across the rows rather than sampling sites
  // freely is the one piece of variance reduction the harness needs: nothing in
  // a one-way corridor mixes the crowd across its width, so a starting draw
  // that happened to favour the middle rows would still be favouring them at
  // the end of the run, and the box would read a density the corridor has not
  // got.
  const columns: Int32Array[] = []
  for (let row = 0; row < LATTICE_ROWS; row++) {
    const shuffled = new Int32Array(LATTICE_COLS)
    for (let i = 0; i < LATTICE_COLS; i++) shuffled[i] = i
    for (let i = LATTICE_COLS - 1; i > 0; i--) {
      const j = rng.int(0, i)
      const swap = shuffled[i]
      shuffled[i] = shuffled[j]
      shuffled[j] = swap
    }
    columns.push(shuffled)
  }
  // Enough jitter to stop a perfect crystal simply translating for two minutes,
  // small enough that no pair can start closer than two radii.
  const slack = Math.min(LATTICE_DX, Math.hypot(LATTICE_DX / 2, LATTICE_DY)) - 2 * RADIUS
  const jitter = Math.max(0, Math.min(0.06, slack * 0.3))
  for (let i = 0; i < count; i++) {
    const row = i % LATTICE_ROWS
    const col = columns[row][Math.floor(i / LATTICE_ROWS)]
    const offset = row % 2 === 0 ? 0 : LATTICE_DX / 2
    x[i] = (col * LATTICE_DX + offset + rng.uniform(-jitter, jitter) + LENGTH) % LENGTH
    y[i] = Y_LOW + row * LATTICE_DY + rng.uniform(-jitter, jitter)
  }

  const buckets: number[][] = Array.from({ length: COLUMNS }, () => [])
  const fine: number[][] = Array.from({ length: FINE_COLUMNS }, () => [])
  const neighbours: OrcaAgentState[] = []
  const makeState = (): OrcaAgentState => ({
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    radius: RADIUS,
    maxSpeed: MAX_SPEED,
    prefVelocity: { x: 0, y: 0 },
    timeHorizon: TIME_HORIZON,
    timeHorizonObst: TIME_HORIZON_OBST,
    responsibility: RESPONSIBILITY,
  })
  const pool: OrcaAgentState[] = []
  for (let i = 0; i < MAX_NEIGHBOURS; i++) pool.push(makeState())
  const self = makeState()
  const obstacleScratch: number[] = []

  const nearD2 = new Float64Array(MAX_NEIGHBOURS)
  const nearId = new Int32Array(MAX_NEIGHBOURS)
  const nearDx = new Float64Array(MAX_NEIGHBOURS)

  let worstOverlap = 0
  let startSeparation = Infinity
  let boxSpeedSum = 0
  let boxSpeedSamples = 0
  let crowdSpeedSum = 0
  let crowdSpeedSamples = 0
  let boxSum = 0
  let boxSamples = 0

  const bins = new Float64Array(BINS * 3)
  const ringCount = new Float64Array(SMOOTHING_TICKS)
  const ringSpeed = new Float64Array(SMOOTHING_TICKS)
  let ringFilled = 0

  const steps = Math.round(totalSeconds / DT)
  const measureFrom = Math.round(transientSeconds / DT)

  /** Shortest signed x separation around the wrap. */
  const wrap = (dx: number): number =>
    dx > LENGTH / 2 ? dx - LENGTH : dx < -LENGTH / 2 ? dx + LENGTH : dx

  /** See `CurvePoint.perceived`. */
  let perceivedSum = 0
  let perceivedSamples = 0
  for (let step = 0; step <= steps; step++) {
    for (const bucket of buckets) bucket.length = 0
    for (let i = 0; i < count; i++) {
      buckets[Math.min(COLUMNS - 1, Math.floor(x[i] / COLUMN_WIDTH))].push(i)
    }

    for (let i = 0; i < count; i++) {
      // Density is read one stride ahead, where the walker is going, exactly as
      // `Simulation.preferredVelocity` reads it. Everyone here walks +x, so the
      // sample point is `PACE_LOOKAHEAD` along x. Only other people slow you
      // down, so the walker's own contribution is never added — which is the
      // same term `DensityField.othersAt` takes off.
      let density = 0
      let nearCount = 0
      const column = Math.min(COLUMNS - 1, Math.floor(x[i] / COLUMN_WIDTH))
      for (let c = -1; c <= 1; c++) {
        for (const j of buckets[(column + c + COLUMNS) % COLUMNS]) {
          if (j === i) continue
          const dxj = wrap(x[j] - x[i])
          const dyj = y[j] - y[i]
          const d2 = dxj * dxj + dyj * dyj
          if (d2 > NEIGHBOUR_RANGE * NEIGHBOUR_RANGE) continue
          const aheadDx = dxj - PACE_LOOKAHEAD
          const aheadD2 = aheadDx * aheadDx + dyj * dyj
          if (aheadD2 <= DENSITY_RANGE * DENSITY_RANGE) {
            density += KERNEL_NORM * Math.exp(-aheadD2 / KERNEL_DENOMINATOR)
          }
          if (j > i) {
            const separation = Math.sqrt(d2)
            const overlap = (2 * RADIUS - separation) / (2 * RADIUS)
            if (overlap > worstOverlap) worstOverlap = overlap
            if (step === 0 && separation < startSeparation) startSeparation = separation
          }
          if (nearCount < MAX_NEIGHBOURS || d2 < nearD2[MAX_NEIGHBOURS - 1]) {
            let slot = Math.min(nearCount, MAX_NEIGHBOURS - 1)
            while (slot > 0 && nearD2[slot - 1] > d2) {
              nearD2[slot] = nearD2[slot - 1]
              nearId[slot] = nearId[slot - 1]
              nearDx[slot] = nearDx[slot - 1]
              slot--
            }
            nearD2[slot] = d2
            nearId[slot] = j
            nearDx[slot] = dxj
            if (nearCount < MAX_NEIGHBOURS) nearCount++
          }
        }
      }
      if (step === steps) continue

      neighbours.length = 0
      for (let n = 0; n < nearCount; n++) {
        const other = pool[n]
        const j = nearId[n]
        // The image of this neighbour on the agent's own side of the wrap.
        other.position.x = x[i] + nearDx[n]
        other.position.y = y[j]
        other.velocity.x = vx[j]
        other.velocity.y = vy[j]
        other.prefVelocity.x = vx[j]
        other.prefVelocity.y = vy[j]
        neighbours.push(other)
      }

      self.position.x = x[i]
      self.position.y = y[i]
      self.velocity.x = vx[i]
      self.velocity.y = vy[i]
      // The preferred velocity is simply "+x, at the density-adjusted free speed".
      // The kernel sum is corrected for the part of it lying inside the walls,
      // exactly as `DensityField` does from the obstacle mask.
      const perceived = density / wallCoverage(y[i])
      if (step >= measureFrom) {
        perceivedSum += perceived
        perceivedSamples++
      }
      self.prefVelocity.x = FREE_SPEED * speedFromDensity(perceived)
      self.prefVelocity.y = 0

      OBSTACLE_INDEX.query(x[i], y[i], NEIGHBOUR_RANGE, obstacleScratch)
      const velocity = computeNewVelocity(self, neighbours, OBSTACLES, obstacleScratch)
      nextVx[i] = velocity.x
      nextVy[i] = velocity.y
    }

    let inBox = 0
    let inBoxSpeed = 0
    for (let i = 0; i < count; i++) {
      if (x[i] >= BOX_X0 && x[i] < BOX_X1 && y[i] >= BOX_Y0 && y[i] < BOX_Y1) {
        inBox++
        inBoxSpeed += vx[i]
      }
    }
    ringCount[step % SMOOTHING_TICKS] = inBox
    ringSpeed[step % SMOOTHING_TICKS] = inBoxSpeed
    if (ringFilled < SMOOTHING_TICKS) ringFilled++

    if (step >= measureFrom) {
      for (let i = 0; i < count; i++) crowdSpeedSum += vx[i]
      crowdSpeedSamples += count
      boxSum += inBox
      boxSpeedSum += inBoxSpeed
      boxSpeedSamples += inBox
      boxSamples++

      if (ringFilled === SMOOTHING_TICKS) {
        let windowCount = 0
        let windowSpeed = 0
        for (let k = 0; k < SMOOTHING_TICKS; k++) {
          windowCount += ringCount[k]
          windowSpeed += ringSpeed[k]
        }
        if (windowCount > 0) {
          const local = windowCount / SMOOTHING_TICKS / BOX_AREA
          const bin = Math.min(BINS - 1, Math.floor(local / BIN_WIDTH))
          bins[bin * 3] += 1
          bins[bin * 3 + 1] += local
          bins[bin * 3 + 2] += windowSpeed / windowCount
        }
      }
    }
    if (step === steps) break

    for (let i = 0; i < count; i++) {
      vx[i] = nextVx[i]
      vy[i] = nextVy[i]
      x[i] += vx[i] * DT
      y[i] = pushFromWalls(y[i] + vy[i] * DT)
      if (x[i] >= LENGTH) x[i] -= LENGTH
      else if (x[i] < 0) x[i] += LENGTH
    }

    // Body exclusion, exactly as `Simulation.relaxOverlaps` does it, down to
    // the pass count and step budget shared with it in `avoidance/separation`:
    // each of a pair gives way equally, each pass re-reads what the last one
    // produced, and the total is capped so a pile eases apart over several
    // ticks rather than exploding in one.
    for (let pass = 0; pass < SEPARATION.iterations; pass++) {
      for (const bucket of fine) bucket.length = 0
      for (let i = 0; i < count; i++) {
        fine[Math.min(FINE_COLUMNS - 1, Math.floor(x[i] / FINE_WIDTH))].push(i)
      }
      shiftX.fill(0)
      shiftY.fill(0)
      for (let i = 0; i < count; i++) {
        const column = Math.min(FINE_COLUMNS - 1, Math.floor(x[i] / FINE_WIDTH))
        for (let c = -1; c <= 1; c++) {
          for (const j of fine[(column + c + FINE_COLUMNS) % FINE_COLUMNS]) {
            if (j <= i) continue
            const dxj = wrap(x[j] - x[i])
            const dyj = y[j] - y[i]
            const minimum = 2 * RADIUS
            const d2 = dxj * dxj + dyj * dyj
            if (d2 >= minimum * minimum || d2 < 1e-12) continue
            const length = Math.sqrt(d2)
            const penetration = (minimum - length) * 0.5
            const nx = (dxj / length) * penetration
            const ny = (dyj / length) * penetration
            shiftX[i] -= nx
            shiftY[i] -= ny
            shiftX[j] += nx
            shiftY[j] += ny
          }
        }
      }
      let resolved = true
      for (let i = 0; i < count; i++) {
        const scale = separationScale(shiftX[i], shiftY[i])
        if (scale === 0) continue
        resolved = false
        x[i] += shiftX[i] * scale
        y[i] = pushFromWalls(y[i] + shiftY[i] * scale)
        if (x[i] >= LENGTH) x[i] -= LENGTH
        else if (x[i] < 0) x[i] += LENGTH
      }
      if (resolved) break
    }
  }

  const density = boxSum / boxSamples / BOX_AREA
  const speed = boxSpeedSum / boxSpeedSamples
  return {
    perceived: perceivedSum / perceivedSamples,
    nominal: count / AREA,
    density,
    speed,
    crowdSpeed: crowdSpeedSum / crowdSpeedSamples,
    reference: weidmannSpeed(density),
    flow: density * speed,
    overlap: worstOverlap,
    startSeparation,
    count,
    bins,
  }
}

// --- the sweep ---------------------------------------------------------------

/**
 * Densities of N/60 from 0.3 to 4.5 persons/m², closely spaced from 1.25 to 2.5
 * so that the flow peak is located rather than interpolated. 14 points at
 * 120 simulated seconds each is about 15 s of wall clock, which is the budget;
 * the determinism check below runs a cut-down sweep for the same reason.
 */
const SWEEP = [18, 30, 45, 60, 75, 90, 105, 120, 135, 150, 180, 210, 240, 270]

const RUN_SECONDS = 120
const TRANSIENT_SECONDS = 60

interface LocalPoint {
  density: number
  speed: number
  reference: number
  flow: number
  samples: number
}

/** Merge every run's bins into one local speed–density relation. */
const poolLocal = (curve: CurvePoint[]): LocalPoint[] => {
  const totals = new Float64Array(BINS * 3)
  for (const point of curve) {
    for (let i = 0; i < totals.length; i++) totals[i] += point.bins[i]
  }
  const points: LocalPoint[] = []
  for (let bin = 0; bin < BINS; bin++) {
    const samples = totals[bin * 3]
    if (samples < MIN_BIN_SAMPLES) continue
    const density = totals[bin * 3 + 1] / samples
    const speed = totals[bin * 3 + 2] / samples
    points.push({
      density,
      speed,
      reference: weidmannSpeed(density),
      flow: density * speed,
      samples,
    })
  }
  return points
}

const format = (value: number, width: number, digits = 3): string =>
  value.toFixed(digits).padStart(width)

const rmse = <T extends { density: number; speed: number; reference: number }>(
  points: readonly T[],
  lower: number,
  upper: number,
): number => {
  const window = points.filter((p) => p.density >= lower && p.density <= upper)
  if (window.length === 0) return NaN
  return Math.sqrt(window.reduce((sum, p) => sum + (p.speed - p.reference) ** 2, 0) / window.length)
}

const peakFlow = <T extends { flow: number }>(points: readonly T[]): T =>
  points.reduce((best, point) => (point.flow > best.flow ? point : best))

const printCurve = (curve: CurvePoint[], local: LocalPoint[]): void => {
  const lines = [
    '',
    'Fundamental diagram — periodic corridor 3 m × 20 m, 120 s per point, first 60 s discarded',
    'Per run, averaged over the measurement window:',
    '   N  rho set  rho box  rho felt   v box  v all  v Weidmann   error  J=rho·v  max overlap',
  ]
  for (const point of curve) {
    lines.push(
      [
        String(point.count).padStart(4),
        format(point.nominal, 8, 2),
        format(point.density, 8),
        format(point.perceived, 9),
        format(point.speed, 7),
        format(point.crowdSpeed, 6),
        format(point.reference, 11),
        format(point.speed - point.reference, 7),
        format(point.flow, 8),
        `${format(point.overlap * 100, 11, 1)}%`,
      ].join(' '),
    )
  }
  const peak = peakFlow(curve)
  lines.push(
    `RMSE vs Weidmann over 0.5–4.0 persons/m²: ${rmse(curve, 0.5, 4.0).toFixed(4)} m/s` +
      `   peak J ${peak.flow.toFixed(4)} p/m/s at ${peak.density.toFixed(3)} p/m²`,
  )
  lines.push(
    '',
    'Pooled: every tick of every measurement window, box density smoothed over 2 s',
    'and binned at 0.25 persons/m². This is the estimator that survives clustering.',
    ' rho box  samples   v meas  v Weidmann   error  J=rho·v',
  )
  for (const point of local) {
    lines.push(
      [
        format(point.density, 8),
        String(point.samples).padStart(8),
        format(point.speed, 8),
        format(point.reference, 11),
        format(point.speed - point.reference, 7),
        format(point.flow, 8),
      ].join(' '),
    )
  }
  const localPeak = peakFlow(local)
  lines.push(
    `RMSE vs Weidmann over 0.5–4.0 persons/m²: ${rmse(local, 0.5, 4.0).toFixed(4)} m/s` +
      `   peak J ${localPeak.flow.toFixed(4)} p/m/s at ${localPeak.density.toFixed(3)} p/m²`,
  )
  console.warn(lines.join('\n'))
}

let curve: CurvePoint[] = []
let local: LocalPoint[] = []

describe('fundamental diagram', () => {
  beforeAll(() => {
    curve = SWEEP.map((count) => runCorridor(count, RUN_SECONDS, TRANSIENT_SECONDS))
    local = poolLocal(curve)
    printCurve(curve, local)
  }, 600000)

  it('starts every run with nobody overlapping, so the overlaps measured are the model’s', () => {
    for (const point of curve) {
      expect(point.startSeparation).toBeGreaterThanOrEqual(2 * RADIUS)
    }
  })

  /**
   * This failed while the corridor still clustered: two of the fourteen points
   * rose instead of falling, because their measurement box spent the window in
   * different phases of a phase-separated crowd and they sat next to each other
   * in density only because the clustering had scrambled the order the counts
   * were meant to impose. With the crowd staying uniform the sweep falls
   * monotonically from 1.338 m/s to 0.161.
   */
  it('slows down monotonically as density rises', () => {
    // Ordered by the density actually measured, not by the count asked for: the
    // crowd is free to cluster, and a run set up for more people can leave the
    // measurement box emptier than one set up for fewer.
    const byDensity = [...curve].sort((a, b) => a.density - b.density)
    // A 0.02 m/s allowance, about 1.5% of free speed, for the noise a finite
    // corridor leaves in a 60 s average. Anything larger would hide a real
    // non-monotonicity.
    const rises: string[] = []
    for (let i = 1; i < byDensity.length; i++) {
      if (byDensity[i].speed > byDensity[i - 1].speed + 0.02) {
        rises.push(
          `${byDensity[i - 1].density.toFixed(2)}→${byDensity[i].density.toFixed(2)}: ` +
            `${byDensity[i - 1].speed.toFixed(3)}→${byDensity[i].speed.toFixed(3)} m/s`,
        )
      }
    }
    expect(rises).toEqual([])
  })

  /**
   * MEASURED 0.0546 m/s RMSE over the eleven per-run points in
   * 0.5–4.0 persons/m², and 0.0500 pooled; TARGET 0.10.
   *
   * Three things closed this, and all three were in how crowding is sensed or
   * how bodies are kept apart rather than in how people walk. Density is read
   * one stride ahead rather than in a ring, which stopped the corridor
   * clustering. The kernel is corrected for the mass it loses into walls, and
   * for the mass it loses into the disc around every person that no other
   * person's centre can enter. And body exclusion runs three passes rather than
   * one, which is what it takes above 3 persons/m²: one pass left bodies
   * interpenetrating by 27% of a radius at 4.7, and a crowd that can pack
   * denser than a real one keeps moving where a real one has stopped.
   */
  it('tracks Weidmann to within 0.10 m/s RMSE over 0.5–4.0 persons/m²', () => {
    expect(rmse(curve, 0.5, 4.0)).toBeLessThanOrEqual(0.1)
  })

  /**
   * MEASURED a peak specific flow of 1.2327 p/m/s per run and 1.2229 pooled;
   * TARGET 1.15–1.35, and Weidmann's own curve peaks at 1.2249. Capacity is the
   * number this model is most likely to be quoted on — how many people an hour
   * a corridor or a doorway will carry — so landing within 1% of the curve it
   * is calibrated against, from both estimators, is the result this file exists
   * to report.
   */
  it('peaks at a specific flow of 1.15–1.35 persons/m/s', () => {
    expect(peakFlow(curve).flow).toBeGreaterThanOrEqual(1.15)
    expect(peakFlow(curve).flow).toBeLessThanOrEqual(1.35)
  })

  /**
   * MEASURED a peak at 1.809 persons/m² per run and 1.882 pooled; TARGET
   * 1.5–2.1, Weidmann's own peak being at 1.751. Where the flow curve turns
   * over is the sharper test of the two: it says the model stops gaining
   * throughput at the density a real crowd stops gaining it, rather than
   * carrying on into densities where a real crowd has shuffled to a stop. This
   * peaked at 3.068 persons/m² before the corridor was stopped from clustering.
   */
  it('peaks at a density of 1.5–2.1 persons/m²', () => {
    expect(peakFlow(curve).density).toBeGreaterThanOrEqual(1.5)
    expect(peakFlow(curve).density).toBeLessThanOrEqual(2.1)
  })

  it('walks at free speed when the corridor is nearly empty', () => {
    const sparsest = [...curve].sort((a, b) => a.density - b.density)[0]
    expect(Math.abs(sparsest.speed - FREE_SPEED) / FREE_SPEED).toBeLessThanOrEqual(0.05)
  })

  /**
   * The neighbour search has to reach everything the density kernel can, from
   * the point one stride ahead where the kernel is centred — otherwise a walker
   * quietly under-feels the crowd in front of them and this whole sweep
   * measures the wrong thing while looking perfectly healthy.
   */
  it('searches far enough to see everything the pace lookahead reads', () => {
    expect(COLUMN_WIDTH).toBeGreaterThanOrEqual(DENSITY_RANGE + PACE_LOOKAHEAD)
  })

  it('never lets two people overlap by more than 15% of their radii', () => {
    const worst = curve.reduce((best, p) => (p.overlap > best.overlap ? p : best))
    expect(worst.overlap).toBeLessThanOrEqual(0.15)
  })
})

describe('fundamental diagram determinism', () => {
  it('measures the same speeds when the sweep is run twice', () => {
    // Two densities and a third of the run length: the sweep above already
    // costs most of this file's budget, and determinism is a property of the
    // integrator and the generator, not of how long or how densely it runs.
    const short = [60, 180]
    const first = short.map((count) => runCorridor(count, 40, 20))
    const second = short.map((count) => runCorridor(count, 40, 20))
    expect(second.map((p) => p.speed)).toEqual(first.map((p) => p.speed))
    expect(second.map((p) => p.density)).toEqual(first.map((p) => p.density))
    expect(second.map((p) => p.overlap)).toEqual(first.map((p) => p.overlap))
  }, 120000)
})
