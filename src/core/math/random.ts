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

  constructor(seed: number | string = 1) {
    const numeric = typeof seed === 'string' ? hashString(seed) : Math.floor(seed)
    this.state = numeric >>> 0 || 0x9e3779b9
  }

  /** A generator whose stream is derived from this one's seed and a label. */
  branch(label: string): Rng {
    return new Rng((this.state ^ hashString(label)) >>> 0)
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

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]
  }

  /** Index into `weights`, chosen proportionally. Returns 0 when all are zero. */
  weightedIndex(weights: readonly number[]): number {
    let total = 0
    for (const w of weights) total += Math.max(0, w)
    if (total <= 0) return 0
    let target = this.next() * total
    for (let i = 0; i < weights.length; i++) {
      target -= Math.max(0, weights[i])
      if (target <= 0) return i
    }
    return weights.length - 1
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

export const distributionMean = (dist: Distribution): number => dist.mean
