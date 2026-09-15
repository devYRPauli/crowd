import { describe, expect, it } from 'vitest'
import type { Distribution } from './random'
import { Rng, distributionMean, hashString, sampleDistribution } from './random'

const draws = (rng: Rng, count: number): number[] => {
  const values: number[] = []
  for (let i = 0; i < count; i++) values.push(rng.next())
  return values
}

interface Summary {
  mean: number
  sd: number
  min: number
  max: number
  finite: boolean
}

const summarise = (values: readonly number[]): Summary => {
  let total = 0
  let min = Infinity
  let max = -Infinity
  for (const value of values) {
    total += value
    if (value < min) min = value
    if (value > max) max = value
  }
  const mean = total / values.length
  let squares = 0
  for (const value of values) squares += (value - mean) ** 2
  return {
    mean,
    sd: Math.sqrt(squares / values.length),
    min,
    max,
    finite: values.every((value) => Number.isFinite(value)),
  }
}

/**
 * Every statistical test draws a fixed count from a fixed seed, so the numbers
 * below are the same on every machine and every run. They are checked against
 * the shape's expectation with room to spare, but nothing here can flake.
 */
const BATCH = 20000

const sample = (seed: string, draw: (rng: Rng) => number, count = BATCH): Summary => {
  const rng = new Rng(seed)
  const values: number[] = []
  for (let i = 0; i < count; i++) values.push(draw(rng))
  return summarise(values)
}

/** A generator whose draw lands exactly on the bottom of the unit interval. */
class LowestDraw extends Rng {
  override next(): number {
    return 0
  }
}

describe('a seeded generator', () => {
  it('replays the same run draw for draw from the same seed', () => {
    const first = draws(new Rng(20240401), 500)
    const second = draws(new Rng(20240401), 500)
    expect(second).toEqual(first)
  })

  it('sends a run with the next seed along a completely different sequence', () => {
    const first = draws(new Rng(20240401), 500)
    const second = draws(new Rng(20240402), 500)
    const shared = first.filter((value, i) => value === second[i]).length
    expect(shared).toBe(0)
    // Adjacent seeds must not merely lag each other by a draw or two.
    expect(second.slice(0, 20)).not.toEqual(first.slice(1, 21))
  })

  it('treats a seed written as a name as the seed its hash gives', () => {
    expect(draws(new Rng('atrium'), 20)).toEqual(draws(new Rng(hashString('atrium')), 20))
    expect(draws(new Rng('atrium'), 5)).not.toEqual(draws(new Rng('Atrium'), 5))
  })

  it('still produces a usable stream for the seed zero', () => {
    const zero = summarise(draws(new Rng(0), 2000))
    expect(zero.min).toBeGreaterThanOrEqual(0)
    expect(zero.max).toBeLessThan(1)
    expect(zero.mean).toBeCloseTo(0.5, 1)
    // 0 is swapped for a fixed constant, so seed 0 and that constant are one run.
    expect(draws(new Rng(0), 5)).toEqual(draws(new Rng(0x9e3779b9), 5))
  })

  it('reads a fractional seed as the whole number below it', () => {
    expect(draws(new Rng(7.9), 5)).toEqual(draws(new Rng(7), 5))
  })
})

describe('named streams', () => {
  it('hands the same name the same stream every time the plan is run', () => {
    const run = () => new Rng(4242).branch('population:0').branch('arrivals')
    expect(draws(run(), 50)).toEqual(draws(run(), 50))
  })

  it('sends two positions in the plan down unrelated sequences', () => {
    const root = new Rng(4242)
    const groups = draws(root.branch('population:0').branch('groups'), 50)
    const arrivals = draws(root.branch('population:0').branch('arrivals'), 50)
    expect(arrivals.filter((value, i) => value === groups[i]).length).toBe(0)
    expect(draws(root.branch('agent:0'), 20)).not.toEqual(draws(root.branch('agent:1'), 20))
  })

  it('leaves a stream untouched however much its siblings draw', () => {
    const population = () => new Rng(4242).branch('population:0')
    const quiet = population()
    const arrivals = quiet.branch('arrivals')
    const groups = quiet.branch('groups')

    const busy = population()
    const busyArrivals = busy.branch('arrivals')
    const busyGroups = busy.branch('groups')
    // The group sizes change when the user edits group size; the arrival times
    // must not move with them, or every comparison against a baseline is noise.
    for (let i = 0; i < 500; i++) busyGroups.next()

    expect(draws(busyArrivals, 50)).toEqual(draws(arrivals, 50))
    expect(draws(groups, 5)).toEqual(draws(population().branch('groups'), 5))
  })

  it('does not care in what order the streams were named', () => {
    const early = new Rng(4242).branch('population:0')
    const first = early.branch('arrivals')
    early.branch('groups')

    const late = new Rng(4242).branch('population:0')
    late.branch('groups')
    const second = late.branch('arrivals')

    expect(draws(second, 50)).toEqual(draws(first, 50))
  })

  // SUSPECTED BUG: `branch` mixes the label into the generator's *current*
  // state, not into its seed as the doc comment claims. A generator therefore
  // renames all of its streams the moment it draws once itself, and
  // `buildSchedule` does draw from the population generator it also branches.
  // Moving a `rng.branch(...)` below the loop that calls `rng.int(...)` — a
  // refactor that changes no behaviour — would silently change every arrival
  // time in the run, so a comparison against a baseline would measure the edit
  // rather than the layout. Deriving from the seed would make a name mean one
  // stream for the generator's whole life.
  it('renames every stream under a generator as soon as that generator draws', () => {
    const untouched = new Rng(4242).branch('population:0')
    const drawnFrom = new Rng(4242).branch('population:0')
    drawnFrom.int(0, 3)

    expect(draws(drawnFrom.branch('arrivals'), 20)).not.toEqual(
      draws(untouched.branch('arrivals'), 20),
    )
  })

  // SUSPECTED BUG: the label is XORed into the state and XOR is commutative, so
  // a stream is named by the unordered set of labels on the way to it rather
  // than by the path. Two different structural positions therefore share one
  // stream and draw identical numbers, which is the correlation between
  // unrelated decisions that naming streams after position exists to prevent.
  // Folding the parent's state through the hash (or hashing the joined path)
  // would give each position its own stream.
  it('gives two positions the same stream when their names are swapped', () => {
    const root = new Rng(7)
    expect(draws(root.branch('population:0').branch('groups'), 20)).toEqual(
      draws(root.branch('groups').branch('population:0'), 20),
    )
  })
})

describe('uniform draws', () => {
  it('stays inside the unit interval and covers it evenly', () => {
    const rng = new Rng('uniform')
    const buckets = new Array<number>(10).fill(0)
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < 50000; i++) {
      const value = rng.next()
      if (value < min) min = value
      if (value > max) max = value
      buckets[Math.floor(value * 10)] += 1
    }
    expect(min).toBeGreaterThanOrEqual(0)
    expect(max).toBeLessThan(1)
    for (const count of buckets) {
      expect(count).toBeGreaterThan(4500)
      expect(count).toBeLessThan(5500)
    }
  })

  it('spreads a ranged draw across the whole range', () => {
    const summary = sample('range', (rng) => rng.uniform(120, 600))
    expect(summary.mean).toBeCloseTo(360, 0)
    expect(summary.sd).toBeCloseTo(480 / Math.sqrt(12), -1)
    expect(summary.min).toBeGreaterThanOrEqual(120)
    expect(summary.min).toBeLessThan(121)
    expect(summary.max).toBeLessThan(600)
    expect(summary.max).toBeGreaterThan(599)
    expect(new Rng('range').uniform(2, 2)).toBe(2)
  })

  it('reaches both ends of an integer range and no further', () => {
    const rng = new Rng('dice')
    const counts = new Map<number, number>()
    for (let i = 0; i < 12000; i++) {
      const value = rng.int(1, 6)
      expect(Number.isInteger(value)).toBe(true)
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
    expect([...counts.keys()].sort()).toEqual([1, 2, 3, 4, 5, 6])
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(1800)
      expect(count).toBeLessThan(2200)
    }
    // One entrance in the plan means everybody comes through entrance 0.
    expect(rng.int(5, 5)).toBe(5)
  })

  it('turns a probability into that share of yeses, and takes 0 and 1 literally', () => {
    const rng = new Rng('coin')
    let yes = 0
    for (let i = 0; i < 12000; i++) if (rng.bool(0.3)) yes += 1
    expect(yes / 12000).toBeCloseTo(0.3, 1)

    for (let i = 0; i < 100; i++) {
      expect(rng.bool(0)).toBe(false)
      expect(rng.bool(1)).toBe(true)
    }
  })
})

describe('normal draws', () => {
  it('puts walking speeds around the mean with the spread asked for', () => {
    const summary = sample('speed', (rng) => rng.normal(1.34, 0.2))
    expect(summary.finite).toBe(true)
    expect(summary.mean).toBeCloseTo(1.34, 1)
    expect(summary.sd).toBeCloseTo(0.2, 1)
    // A Box-Muller tail that never reaches 3 sd would quietly remove the slow
    // and the fast walkers the whole distribution is there to model.
    expect(summary.min).toBeLessThan(1.34 - 3 * 0.2)
    expect(summary.max).toBeGreaterThan(1.34 + 3 * 0.2)
  })

  it('carries the spare draw over unscaled, so every second value gets its own spread', () => {
    const paired = new Rng('spare')
    paired.normal(0, 1)
    const spare = paired.normal(0, 1)

    const rescaled = new Rng('spare')
    rescaled.normal(0, 1)
    // Half of all normal values come from the cached spare. If it were stored
    // already scaled, half of every population's speeds would carry the spread
    // of whatever distribution was sampled before them.
    expect(rescaled.normal(10, 2)).toBeCloseTo(10 + 2 * spare, 12)
  })

  it('keeps a truncated draw inside the limits the profile sets', () => {
    const summary = sample('truncated', (rng) => rng.truncatedNormal(1.34, 0.6, 0.7, 2))
    expect(summary.min).toBeGreaterThanOrEqual(0.7)
    expect(summary.max).toBeLessThanOrEqual(2)
    expect(summary.mean).toBeCloseTo(1.35, 1)
    // Cutting the tails off narrows the spread; it must still be a spread.
    expect(summary.sd).toBeGreaterThan(0.25)
    expect(summary.sd).toBeLessThan(0.6)
  })

  it('falls back to the nearest allowed value when the mean is outside the limits', () => {
    expect(new Rng('backstop').truncatedNormal(5, 0.5, 0, 1)).toBe(1)
    expect(new Rng('backstop').truncatedNormal(-5, 0.5, 0, 1)).toBe(0)
    // A profile with no spread gives everybody exactly the mean.
    expect(new Rng('backstop').truncatedNormal(1.3, 0, 0.5, 2)).toBe(1.3)
  })
})

describe('the sampling shapes', () => {
  it('spaces Poisson arrivals at the rate they were asked for', () => {
    const summary = sample('poisson', (rng) => rng.exponential(0.5))
    expect(summary.finite).toBe(true)
    expect(summary.mean).toBeCloseTo(2, 1)
    // An exponential's spread equals its mean; a gap is never negative.
    expect(summary.sd).toBeCloseTo(2, 1)
    expect(summary.min).toBeGreaterThanOrEqual(0)
  })

  it('keeps a log-normal service time positive and on the mean it was given', () => {
    const summary = sample('service', (rng) => rng.logNormal(20, 7))
    expect(summary.finite).toBe(true)
    expect(summary.mean).toBeCloseTo(20, 0)
    expect(summary.sd).toBeCloseTo(7, 0)
    expect(summary.min).toBeGreaterThan(0)
    // A counter with no service time at all must not throw a log of zero.
    expect(new Rng('service').logNormal(0, 5)).toBe(0)
    expect(new Rng('service').logNormal(20, 0)).toBeCloseTo(20, 9)
  })

  it('leans a triangular draw towards its mode and stays between its ends', () => {
    const summary = sample('triangular', (rng) => rng.triangular(0, 1, 4))
    expect(summary.mean).toBeCloseTo((0 + 1 + 4) / 3, 1)
    expect(summary.min).toBeGreaterThanOrEqual(0)
    expect(summary.max).toBeLessThanOrEqual(4)
    // A collapsed range must give the value, not a division by zero.
    expect(new Rng('triangular').triangular(5, 5, 5)).toBe(5)
  })

  it('chooses from a profile mix in proportion to its weights', () => {
    const rng = new Rng('mix')
    const counts = [0, 0, 0]
    for (let i = 0; i < 12000; i++) counts[rng.weightedIndex([3, 1, 0])] += 1
    expect(counts[0] / 12000).toBeCloseTo(0.75, 1)
    expect(counts[1] / 12000).toBeCloseTo(0.25, 1)
    expect(counts[2]).toBe(0)
    expect(rng.weightedIndex([2, -5, 2])).not.toBe(1)
    // A mix the user emptied still has to name somebody.
    expect(rng.weightedIndex([0, 0, 0])).toBe(0)
    expect(rng.weightedIndex([])).toBe(0)
  })

  // SUSPECTED BUG: the running total is compared with `target <= 0` before the
  // weight at that index is known to be non-zero, so a draw that lands exactly
  // on zero returns index 0 even when index 0 was given no weight at all — a
  // profile the user set to 0% of the crowd then appears in it. The draw has to
  // be exactly 0 (or rounding has to leave the last subtraction just above it),
  // so this is rare rather than harmless; skipping zero-weight entries fixes it.
  it('can choose a profile that was given no share of the crowd', () => {
    expect(new LowestDraw(1).weightedIndex([0, 1])).toBe(0)
  })

  it('shuffles in place, keeping every element exactly once', () => {
    const queue = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    const returned = new Rng('shuffle').shuffle(queue)
    expect(returned).toBe(queue)
    expect([...queue].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(queue).not.toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

    const again = new Rng('shuffle').shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(again).toEqual(queue)
    expect(new Rng('other').shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])).not.toEqual(queue)
    expect(new Rng('shuffle').shuffle([7])).toEqual([7])
    expect(new Rng('shuffle').shuffle([])).toEqual([])
  })

  it('picks every entry of a list and never runs off its end', () => {
    const rng = new Rng('pick')
    const doors = ['north', 'south', 'east'] as const
    const counts = new Map<string, number>()
    for (let i = 0; i < 9000; i++) {
      const door = rng.pick(doors)
      counts.set(door, (counts.get(door) ?? 0) + 1)
    }
    expect([...counts.keys()].sort()).toEqual(['east', 'north', 'south'])
    for (const count of counts.values()) expect(count).toBeGreaterThan(2700)
  })

  // SUSPECTED BUG: `pick` is typed as returning T but hands back undefined for
  // an empty list, so a caller picking from a filtered set of exits gets an
  // object-shaped undefined that the type checker has promised cannot happen,
  // and the failure surfaces somewhere else entirely.
  it('returns nothing at all when there is nothing to pick from', () => {
    expect(new Rng('pick').pick([])).toBeUndefined()
  })

  it('fills the unit disc evenly rather than crowding its centre', () => {
    const rng = new Rng('disc')
    const points = Array.from({ length: BATCH }, () => rng.inUnitDisc())
    const radii = summarise(points.map((p) => Math.hypot(p.x, p.y)))
    expect(radii.max).toBeLessThanOrEqual(1)
    // Uniform over area means a mean radius of 2/3; sampling the radius
    // directly would give 1/2 and pile everybody up in the middle of the entry.
    expect(radii.mean).toBeCloseTo(2 / 3, 1)
    const inner = points.filter((p) => Math.hypot(p.x, p.y) <= Math.SQRT1_2).length
    expect(inner / BATCH).toBeCloseTo(0.5, 1)
    expect(summarise(points.map((p) => p.x)).mean).toBeCloseTo(0, 1)
    expect(summarise(points.map((p) => p.y)).mean).toBeCloseTo(0, 1)
  })
})

describe('durations from a distribution', () => {
  const kinds: Distribution[] = [
    { kind: 'constant', mean: 30 },
    { kind: 'normal', mean: 30, sd: 8 },
    { kind: 'lognormal', mean: 20, sd: 7 },
    { kind: 'exponential', mean: 20 },
    { kind: 'uniform', mean: 300, min: 120, max: 600 },
    { kind: 'triangular', mean: 30, min: 10, max: 90 },
  ]

  it('gives every kind a finite, replayable duration', () => {
    for (const dist of kinds) {
      const first = new Rng('service:0')
      const second = new Rng('service:0')
      const values = Array.from({ length: 200 }, () => sampleDistribution(first, dist))
      expect(values.every((value) => Number.isFinite(value))).toBe(true)
      expect(Array.from({ length: 200 }, () => sampleDistribution(second, dist))).toEqual(values)
    }
  })

  it('never hands the engine a negative duration', () => {
    const rng = new Rng('negatives')
    for (let i = 0; i < 500; i++) {
      expect(sampleDistribution(rng, { kind: 'normal', mean: -5, sd: 10 })).toBeGreaterThanOrEqual(
        0,
      )
      expect(sampleDistribution(rng, { kind: 'normal', mean: 2, sd: 20 })).toBeGreaterThanOrEqual(0)
    }
    expect(sampleDistribution(rng, { kind: 'constant', mean: -9 })).toBe(0)
    expect(sampleDistribution(rng, { kind: 'exponential', mean: 0 })).toBe(0)
  })

  it('holds a duration to the limits the user set, whatever the spread', () => {
    const rng = new Rng('limits')
    const dist: Distribution = { kind: 'normal', mean: 30, sd: 50, min: 5, max: 60 }
    const summary = summarise(Array.from({ length: 2000 }, () => sampleDistribution(rng, dist)))
    expect(summary.min).toBe(5)
    expect(summary.max).toBe(60)
    expect(sampleDistribution(rng, { kind: 'constant', mean: 50, max: 30 })).toBe(30)
  })

  it('spreads a uniform duration across the bounds and ignores its mean', () => {
    const rng = new Rng('dwell')
    const dist: Distribution = { kind: 'uniform', mean: 300, min: 120, max: 600 }
    const summary = summarise(Array.from({ length: BATCH }, () => sampleDistribution(rng, dist)))
    expect(summary.min).toBeGreaterThanOrEqual(120)
    expect(summary.max).toBeLessThanOrEqual(600)
    expect(summary.mean).toBeCloseTo(360, -1)
  })

  it('gives a lognormal with no stated spread a spread of its own', () => {
    const rng = new Rng('lognormal')
    const dist: Distribution = { kind: 'lognormal', mean: 20 }
    const summary = summarise(Array.from({ length: BATCH }, () => sampleDistribution(rng, dist)))
    expect(summary.mean).toBeCloseTo(20, 0)
    expect(summary.sd).toBeCloseTo(7, 0)
  })

  // SUSPECTED BUG: `distributionMean` reports the `mean` field, but for a
  // uniform or triangular duration given explicit bounds the sampler never
  // looks at that field: {mean: 300, min: 120, max: 600} averages 360, and
  // {mean: 30, min: 10, max: 90} averages (10+30+90)/3 = 43.3. The engine uses
  // this number as the service time when it estimates how long each queue will
  // take (engine.ts, `serviceMean`), so a templated counter sends people to the
  // wrong desk on a wait it has under-read by a fifth. The mean of a bounded
  // uniform is (min+max)/2 and of a triangular (min+mode+max)/3.
  it('reports a mean for a bounded duration that its own samples do not have', () => {
    const uniform: Distribution = { kind: 'uniform', mean: 300, min: 120, max: 600 }
    const triangular: Distribution = { kind: 'triangular', mean: 30, min: 10, max: 90 }
    const rng = new Rng('mean')
    const drawn = (dist: Distribution) =>
      summarise(Array.from({ length: BATCH }, () => sampleDistribution(rng, dist))).mean

    expect(distributionMean(uniform)).toBe(300)
    expect(drawn(uniform)).toBeCloseTo(360, -1)
    expect(distributionMean(triangular)).toBe(30)
    expect(drawn(triangular)).toBeCloseTo(43.3, 0)
  })
})
