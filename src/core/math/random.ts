/**
 * Deterministic pseudo-random numbers.
 *
 * Every stochastic decision in a run flows through one of these generators so
 * that a scenario replayed with the same seed produces an identical result.
 * `Rng` is a small class rather than a closure so it can be cheaply cloned and
 * branched: sub-streams keep one part of the model from shifting another's
 * draws when an unrelated setting changes.
 */

const UINT32 = 4294967296

/** 32-bit string hash (FNV-1a), used to derive named sub-streams. */
export const hashString = (value: string): number => {
  let h = 2166136261 >>> 0
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

export class Rng {
  private state: number
  private spare: number | null = null
  /** The seed the stream started from, kept because `branch` derives from it. */
  private readonly seed: number

  constructor(seed: number | string = 1) {
    const numeric = typeof seed === 'string' ? hashString(seed) : Math.floor(seed)
    this.seed = numeric >>> 0 || 0x9e3779b9
    this.state = this.seed
  }

  /**
   * A generator whose stream is derived from this one's seed and a label.
   *
   * From the seed, never from the live state: a stream is named after a thing's
   * position in the plan, and a name resolved against the state would mean a
   * different stream the moment the parent drew once itself. `buildSchedule`
   * branches `groups` and `arrivals` off the population generator and then
   * draws entrances and profile picks from it, so moving one of those branches
   * below the loop — a refactor that reads as changing nothing — would move
   * every arrival time in the run, and a comparison against a baseline would
   * measure the edit rather than the layout.
   */
  branch(label: string): Rng {
    return new Rng((this.seed ^ hashString(label)) >>> 0)
  }

  /** Uniform in [0, 1). mulberry32 — fast, and adequate for crowd sampling. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / UINT32
  }

  /** Uniform in [min, max). */
  uniform(min = 0, max = 1): number {
    return min + this.next() * (max - min)
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(min + this.next() * (max - min + 1))
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability
  }

  /** Standard normal via the polar Box–Muller transform, caching the spare. */
  normal(mean = 0, sd = 1): number {
    if (this.spare !== null) {
      const value = this.spare
      this.spare = null
      return mean + value * sd
    }
    let u: number
    let v: number
    let s: number
    do {
      u = this.next() * 2 - 1
      v = this.next() * 2 - 1
      s = u * u + v * v
    } while (s >= 1 || s === 0)
    const factor = Math.sqrt((-2 * Math.log(s)) / s)
    this.spare = v * factor
    return mean + u * factor * sd
  }

  /** Normal truncated to [min, max] by resampling, then clamped as a backstop. */
  truncatedNormal(mean: number, sd: number, min: number, max: number): number {
    for (let attempt = 0; attempt < 16; attempt++) {
      const value = this.normal(mean, sd)
      if (value >= min && value <= max) return value
    }
    return Math.min(Math.max(mean, min), max)
  }

  exponential(rate: number): number {
    return -Math.log(1 - this.next()) / rate
  }

  /** Log-normal with the given mean and standard deviation of the *value*. */
  logNormal(mean: number, sd: number): number {
    if (mean <= 0) return 0
    const variance = Math.log(1 + (sd * sd) / (mean * mean))
    const mu = Math.log(mean) - variance / 2
    return Math.exp(this.normal(mu, Math.sqrt(variance)))
  }

  triangular(min: number, mode: number, max: number): number {
    const u = this.next()
    const c = (mode - min) / (max - min)
    return u < c
      ? min + Math.sqrt(u * (max - min) * (mode - min))
      : max - Math.sqrt((1 - u) * (max - min) * (max - mode))
  }

  /** An item chosen uniformly, or `undefined` when there is nothing to pick. */
  pick<T>(items: readonly T[]): T | undefined {
    return items[Math.floor(this.next() * items.length)]
  }

  /**
   * Index into `weights`, chosen proportionally. Returns 0 when all are zero.
   *
   * An entry with no weight is skipped rather than tested: its band has no
   * width, and a draw landing exactly on the bottom of the interval would
   * otherwise be handed to it — a profile the user set to 0% of the crowd
   * turning up in the crowd.
   */
  weightedIndex(weights: readonly number[]): number {
    let total = 0
    for (const w of weights) total += Math.max(0, w)
    if (total <= 0) return 0
    let target = this.next() * total
    let last = 0
    for (let i = 0; i < weights.length; i++) {
      const weight = Math.max(0, weights[i])
      if (weight <= 0) continue
      last = i
      target -= weight
      if (target <= 0) return i
    }
    return last
  }

  /** In-place Fisher–Yates shuffle. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1))
      const tmp = items[i]
      items[i] = items[j]
      items[j] = tmp
    }
    return items
  }

  /** A point drawn uniformly from the unit disc. */
  inUnitDisc(): { x: number; y: number } {
    const angle = this.next() * Math.PI * 2
    const radius = Math.sqrt(this.next())
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
  }
}

/** Parameterised duration used for service and dwell times. */
export interface Distribution {
  kind: 'constant' | 'normal' | 'lognormal' | 'exponential' | 'uniform' | 'triangular'
  /** Mean (or the fixed value for `constant`, or the lower bound for `uniform`). */
  mean: number
  /** Standard deviation, or the half-range for `uniform`/`triangular`. */
  sd?: number
  min?: number
  max?: number
}

export const sampleDistribution = (rng: Rng, dist: Distribution): number => {
  const sd = dist.sd ?? 0
  let value: number
  switch (dist.kind) {
    case 'constant':
      value = dist.mean
      break
    case 'normal':
      value = rng.normal(dist.mean, sd)
      break
    case 'lognormal':
      value = rng.logNormal(dist.mean, sd || dist.mean * 0.35)
      break
    case 'exponential':
      value = dist.mean > 0 ? rng.exponential(1 / dist.mean) : 0
      break
    case 'uniform':
      value = rng.uniform(dist.min ?? Math.max(0, dist.mean - sd), dist.max ?? dist.mean + sd)
      break
    case 'triangular':
      value = rng.triangular(dist.min ?? 0, dist.mean, dist.max ?? dist.mean * 2)
      break
  }
  const min = dist.min ?? 0
  const max = dist.max ?? Infinity
  return Math.min(Math.max(value, min), max)
}

/**
 * The average duration the distribution actually draws.
 *
 * `chooseQueue` multiplies this by the length of a line to guess the wait
 * behind a counter, so it has to be the mean of the samples and not of the
 * `mean` field: bounds are part of the shape for two kinds. A uniform never
 * reads `mean` at all and draws between its bounds, and a triangular reads it
 * as the mode — a 120-600 s desk reported 300 s when its people cost 360, and
 * the desk was chosen on a wait under-read by a fifth. A clamped normal or
 * exponential still reports its nominal mean, because the exact answer needs
 * the distribution's CDF; holding the result inside the bounds keeps it to
 * something the desk can actually produce.
 */
export const distributionMean = (dist: Distribution): number => {
  const sd = dist.sd ?? 0
  let mean: number
  switch (dist.kind) {
    case 'uniform':
      mean = ((dist.min ?? Math.max(0, dist.mean - sd)) + (dist.max ?? dist.mean + sd)) / 2
      break
    case 'triangular':
      mean = ((dist.min ?? 0) + dist.mean + (dist.max ?? dist.mean * 2)) / 3
      break
    default:
      mean = dist.mean
  }
  return Math.min(Math.max(mean, dist.min ?? 0), dist.max ?? Infinity)
}
