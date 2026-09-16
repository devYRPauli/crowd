import { describe, expect, it } from 'vitest'
import type { Distribution } from './random'
import { Rng, distributionMean, hashString, sampleDistribution } from './random'

const draws = (rng: Rng, count: number): number[] => {
  const values: number[] = []
  for (let i = 0; i < count; i++) values.push(rng.next())
  return values
}

/** How many draws two streams agree on position for position. */
const sharedDraws = (a: readonly number[], b: readonly number[]): number =>
  a.filter((value, i) => value === b[i]).length

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

const tally = <T>(count: number, draw: () => T): Map<T, number> => {
  const counts = new Map<T, number>()
  for (let i = 0; i < count; i++) {
    const value = draw()
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return counts
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
    expect(sharedDraws(first, second)).toBe(0)
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

  it('folds any number it is handed into a 32-bit seed', () => {
    expect(draws(new Rng(7.9), 5)).toEqual(draws(new Rng(7), 5))
    expect(draws(new Rng(-1), 5)).toEqual(draws(new Rng(4294967295), 5))
    // The seed box in the scenario panel has no upper bound, so a user who
    // types a big number gets a run they have already seen: 2^32 + 5 is 5.
    expect(draws(new Rng(2 ** 32 + 5), 5)).toEqual(draws(new Rng(5), 5))
    expect(draws(new Rng(Number.NaN), 5)).toEqual(draws(new Rng(0), 5))
  })
})

describe('the label a stream is named with', () => {
  it('gives every person in a full venue a stream of their own', () => {
    const root = new Rng(2024)
    const hashes = new Set<number>()
    const openings = new Set<number>()
    for (let i = 0; i < 5000; i++) {
      hashes.add(hashString(`agent:${i}`))
      openings.add(root.branch(`agent:${i}`).next())
    }
    // Two people sharing a hash share every decision they ever make, and the
    // pair is invisible in the results: they simply behave like one person.
    expect(hashes.size).toBe(5000)
    expect(openings.size).toBe(5000)
  })

  it('reads a label as an ordered run of characters, and always as a u32', () => {
    expect(hashString('ab')).not.toBe(hashString('ba'))
    expect(hashString('atrium')).not.toBe(hashString('Atrium'))
    expect(hashString('')).toBe(2166136261)
    // The constructor treats a falsy hash as "no seed" and a negative one would
    // wrap; the hash has to stay a non-negative 32-bit integer for either to be
    // the whole story.
    for (const label of ['', 'a', 'population:0', 'service:3:41:agent-7']) {
      const hash = hashString(label)
      expect(Number.isInteger(hash)).toBe(true)
      expect(hash).toBeGreaterThanOrEqual(0)
      expect(hash).toBeLessThan(2 ** 32)
    }
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
    expect(sharedDraws(groups, arrivals)).toBe(0)
    expect(sharedDraws(draws(root.branch('agent:0'), 50), draws(root.branch('agent:1'), 50))).toBe(
      0,
    )
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

  it('names a stream without spending a draw, so the order of the names is free', () => {
    const early = new Rng(4242).branch('population:0')
    const first = early.branch('arrivals')
    early.branch('groups')

    const late = new Rng(4242).branch('population:0')
    late.branch('groups')
    const second = late.branch('arrivals')
    expect(draws(second, 50)).toEqual(draws(first, 50))

    // `buildSchedule` names its sub-streams and then draws entrances and
    // profiles from the same generator (engine.ts:414-424). If naming spent a
    // draw, adding a stream would move every person to a different door.
    const bare = new Rng(4242).branch('population:0')
    const named = new Rng(4242).branch('population:0')
    named.branch('groups')
    named.branch('arrivals')
    expect(draws(named, 20)).toEqual(draws(bare, 20))
  })

  it('keeps a name on one stream however much the generator above it has drawn', () => {
    const untouched = new Rng(4242).branch('population:0')
    const drawnFrom = new Rng(4242).branch('population:0')
    drawnFrom.int(0, 3)

    // `buildSchedule` (engine.ts:414-426) branches `groups` and `arrivals` off
    // the population generator and then draws entrances and profile picks from
    // that same generator. If a name were read against the live state, moving
    // one of those branches below the loop — a refactor that reads as changing
    // nothing — would move every arrival time in the run, and a comparison
    // against a baseline would measure the edit rather than the layout.
    expect(draws(drawnFrom.branch('arrivals'), 20)).toEqual(draws(untouched.branch('arrivals'), 20))
  })

  // Recorded decision: labels are XORed together, and XOR is commutative and
  // self-inverse, so a stream is named by the multiset of labels on the way to
  // it rather than by the path. Two positions whose names are a rearrangement
  // share a stream, and a label spent twice down one path lands back on the
  // parent's own. The engine's names cannot reach either: `groups` and
  // `arrivals` are the only second level, they hang off `population:N`, and no
  // label repeats down a path. Folding the parent's seed through the hash would
  // give every path its own stream, but it re-seeds every nested stream in the
  // product — group sizes and arrival times all move — and every threshold in
  // src/sim/validation is calibrated against the numbers those produce. The
  // test stands as the record of what the naming scheme does and does not
  // promise, so a new pair of labels is chosen knowing it.
  it('gives unrelated positions one stream when their names are a rearrangement', () => {
    const root = new Rng(7)
    expect(draws(root.branch('population:0').branch('groups'), 20)).toEqual(
      draws(root.branch('groups').branch('population:0'), 20),
    )
    // A label spent twice cancels itself out and lands back on the parent.
    expect(draws(root.branch('groups').branch('groups'), 20)).toEqual(draws(new Rng(7), 20))
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
    // An unargued `uniform()` is the raw draw, not a second transformation of it.
    const bare = new Rng('uniform')
    expect(Array.from({ length: 5 }, () => bare.uniform())).toEqual(draws(new Rng('uniform'), 5))
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
    const counts = tally(12000, () => rng.int(1, 6))
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

    let heads = 0
    for (let i = 0; i < 12000; i++) if (rng.bool()) heads += 1
    expect(heads / 12000).toBeCloseTo(0.5, 1)

    // A step set to "never" or "always" must not be a 1-in-4-billion coin flip.
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

  it('falls back to the nearest allowed value when no draw can satisfy the limits', () => {
    expect(new Rng('backstop').truncatedNormal(5, 0.5, 0, 1)).toBe(1)
    expect(new Rng('backstop').truncatedNormal(-5, 0.5, 0, 1)).toBe(0)
    // A profile pinned to one speed: no draw lands on a point, so the sixteen
    // attempts are spent and the clamp answers. Everybody walks at 1.2 m/s.
    expect(new Rng('backstop').truncatedNormal(1.3, 0.2, 1.2, 1.2)).toBe(1.2)
    // A profile with no spread gives everybody exactly the mean, first try.
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
    // A rate of zero divides by zero. `sampleDistribution` guards `mean > 0`
    // for exactly this, and an arrival gap of Infinity is nobody arriving.
    expect(new Rng('poisson').exponential(0)).toBe(Infinity)
  })

  it('keeps a log-normal service time positive and on the mean it was given', () => {
    const summary = sample('service', (rng) => rng.logNormal(20, 7))
    expect(summary.finite).toBe(true)
    expect(summary.mean).toBeCloseTo(20, 0)
    expect(summary.sd).toBeCloseTo(7, 0)
    expect(summary.min).toBeGreaterThan(0)
    // A counter with no service time at all must not throw a log of zero.
    expect(new Rng('service').logNormal(0, 5)).toBe(0)
    expect(new Rng('service').logNormal(-1, 5)).toBe(0)
    expect(new Rng('service').logNormal(20, 0)).toBeCloseTo(20, 9)
  })

  it('leans a triangular draw towards its mode and stays between its ends', () => {
    const summary = sample('triangular', (rng) => rng.triangular(0, 1, 4))
    expect(summary.mean).toBeCloseTo((0 + 1 + 4) / 3, 1)
    expect(summary.min).toBeGreaterThanOrEqual(0)
    expect(summary.max).toBeLessThanOrEqual(4)
    // A mode sitting on either end is the degenerate case of the same formula,
    // and both halves of the branch have to agree about which end that is.
    expect(sample('mode-low', (rng) => rng.triangular(0, 0, 4)).mean).toBeCloseTo(4 / 3, 1)
    expect(sample('mode-high', (rng) => rng.triangular(0, 4, 4)).mean).toBeCloseTo(8 / 3, 1)
    // A collapsed range must give the value, not a division by zero.
    expect(new Rng('triangular').triangular(5, 5, 5)).toBe(5)
  })

  it('chooses from a profile mix in proportion to its weights', () => {
    const rng = new Rng('mix')
    const counts = tally(12000, () => rng.weightedIndex([3, 1, 0]))
    expect((counts.get(0) ?? 0) / 12000).toBeCloseTo(0.75, 1)
    expect((counts.get(1) ?? 0) / 12000).toBeCloseTo(0.25, 1)
    expect(counts.get(2) ?? 0).toBe(0)

    // A negative weight is a zero, in the total as well as in the walk, so the
    // two real profiles split the crowd evenly rather than 2:-5:2.
    const negatives = tally(12000, () => rng.weightedIndex([2, -5, 2]))
    expect(negatives.get(1) ?? 0).toBe(0)
    expect((negatives.get(0) ?? 0) / 12000).toBeCloseTo(0.5, 1)

    // A mix the user emptied still has to name somebody.
    expect(rng.weightedIndex([0, 0, 0])).toBe(0)
    expect(rng.weightedIndex([])).toBe(0)
  })

  it('never gives the crowd to a profile the user set to no share of it', () => {
    // The lowest draw in the unit interval lands exactly on the bottom of the
    // first band, and a profile set to 0% has a band of no width for it to land
    // in, so the draw belongs to the first profile that does have a share.
    expect(new LowestDraw(1).weightedIndex([0, 1])).toBe(1)
    expect(new LowestDraw(1).weightedIndex([0, 0, 3])).toBe(2)
    // The top of the range belongs to the last profile with a share too, not to
    // the empty ones the user left sitting after it.
    const rng = new Rng('empty-tail')
    for (let i = 0; i < 2000; i++) expect(rng.weightedIndex([3, 0])).toBe(0)
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

  it('deals every ordering of a queue about equally often', () => {
    const rng = new Rng('fisher-yates')
    const orders = tally(6000, () => rng.shuffle([0, 1, 2]).join(''))
    // The classic Fisher-Yates slip — drawing j from [0, i) rather than [0, i]
    // — still returns a permutation and still looks shuffled, but reaches some
    // orderings far more often than others. Only the whole spread catches it.
    expect([...orders.keys()].sort()).toEqual(['012', '021', '102', '120', '201', '210'])
    for (const count of orders.values()) {
      expect(count).toBeGreaterThan(850)
      expect(count).toBeLessThan(1150)
    }
  })

  it('picks every entry of a list and never runs off its end', () => {
    const rng = new Rng('pick')
    const doors = ['north', 'south', 'east'] as const
    const counts = tally(9000, () => rng.pick(doors))
    expect([...counts.keys()].sort()).toEqual(['east', 'north', 'south'])
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(2800)
      expect(count).toBeLessThan(3200)
    }
  })

  it('returns nothing at all when there is nothing to pick from', () => {
    // The empty case is in the type, so a caller picking from a filtered set of
    // exits answers for it where it happens rather than carrying an
    // object-shaped undefined off into the step that reads its position.
    const chosen: string | undefined = new Rng('pick').pick([])
    expect(chosen).toBeUndefined()
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
    // The angle has to cover the circle too: a spawn ring biased to one side
    // pushes an entering group into the wall beside the door.
    const quadrants = [0, 0, 0, 0]
    for (const p of points) quadrants[(p.x < 0 ? 1 : 0) + (p.y < 0 ? 2 : 0)] += 1
    for (const count of quadrants) expect(count / BATCH).toBeCloseTo(0.25, 1)
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

  it('reads the spread as a half-range when a uniform or triangular has no bounds', () => {
    const rng = new Rng('half-range')
    const over = (dist: Distribution) =>
      summarise(Array.from({ length: BATCH }, () => sampleDistribution(rng, dist)))

    const banded = over({ kind: 'uniform', mean: 30, sd: 10 })
    expect(banded.min).toBeGreaterThanOrEqual(20)
    expect(banded.max).toBeLessThanOrEqual(40)
    expect(banded.mean).toBeCloseTo(30, 0)

    // A half-range wider than the mean would put the bottom of the band below
    // zero. The floor is taken before the draw rather than clamped after it, so
    // the band really is [0, 25]: clamping [-15, 25] afterwards would pile a
    // third of the crowd on exactly zero and pull the average down to 7.8 s.
    const wide = over({ kind: 'uniform', mean: 5, sd: 20 })
    expect(wide.min).toBeGreaterThanOrEqual(0)
    expect(wide.max).toBeLessThanOrEqual(25)
    expect(wide.mean).toBeCloseTo(12.5, 0)
    expect(wide.min).toBeLessThan(0.1)

    // An unbounded triangular leans on the mean as its mode, between 0 and 2x.
    const peaked = over({ kind: 'triangular', mean: 30 })
    expect(peaked.min).toBeGreaterThanOrEqual(0)
    expect(peaked.max).toBeLessThanOrEqual(60)
    expect(peaked.mean).toBeCloseTo(30, 0)
  })

  it('gives a lognormal with no stated spread a spread of its own', () => {
    const rng = new Rng('lognormal')
    const dist: Distribution = { kind: 'lognormal', mean: 20 }
    const summary = summarise(Array.from({ length: BATCH }, () => sampleDistribution(rng, dist)))
    expect(summary.mean).toBeCloseTo(20, 0)
    expect(summary.sd).toBeCloseTo(7, 0)
  })

  it('reports the mean a bounded duration really draws, not the mean field', () => {
    const uniform: Distribution = { kind: 'uniform', mean: 300, min: 120, max: 600 }
    const triangular: Distribution = { kind: 'triangular', mean: 30, min: 10, max: 90 }
    const rng = new Rng('mean')
    const drawn = (dist: Distribution) =>
      summarise(Array.from({ length: BATCH }, () => sampleDistribution(rng, dist))).mean

    // The engine multiplies this by the length of a line to guess the wait
    // behind a counter (engine.ts:912). A uniform never reads its mean field
    // and draws between its bounds; a triangular reads it as the mode. Taking
    // the field at its word sent people to a desk on a wait a fifth short.
    expect(distributionMean(uniform)).toBeCloseTo(360, 6)
    expect(drawn(uniform)).toBeCloseTo(360, -1)
    expect(distributionMean(triangular)).toBeCloseTo(43.33, 2)
    expect(drawn(triangular)).toBeCloseTo(43.3, 0)

    // Unbounded, both shapes are symmetric about the mean they were given, and
    // the shapes that draw around that mean keep reporting it either way.
    expect(distributionMean({ kind: 'uniform', mean: 30, sd: 10 })).toBeCloseTo(30, 9)
    expect(distributionMean({ kind: 'triangular', mean: 30 })).toBeCloseTo(30, 9)
    expect(distributionMean({ kind: 'lognormal', mean: 20, sd: 7, min: 2 })).toBe(20)
    expect(distributionMean({ kind: 'exponential', mean: 30 })).toBe(30)
    // A duration the bounds cut down costs what it can cost, not what it asked
    // for: the sampler clamps every kind, so the estimate does too.
    expect(distributionMean({ kind: 'constant', mean: 50, max: 30 })).toBe(30)
    expect(distributionMean({ kind: 'constant', mean: -9 })).toBe(0)
  })
})
