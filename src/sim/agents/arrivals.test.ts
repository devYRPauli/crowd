/**
 * Arrival schedules.
 *
 * The count is the easy half. The shape is the half the product is sold on: the
 * same 600 people arriving evenly, in five coach-loads or in a pre-session peak
 * queue completely differently, and a profile that has quietly flattened into
 * another one makes the comparison between them meaningless. So most of what
 * follows measures where the mass sits and how far it spreads, in bins wide
 * enough that only a real change of shape moves them.
 *
 * Every draw comes from a seeded Rng, so nothing here is sampled twice hoping
 * for a different answer: the numbers below are the numbers the engine gets.
 */

import { describe, expect, it, vi } from 'vitest'
import { scheduleArrivals, splitIntoGroups } from './arrivals'
import { Rng } from '../../core/math/random'
import type { ArrivalKind, ArrivalProfile } from '../../core/model/types'

const WINDOW = 1200

/**
 * Keyed by the union rather than listed loose, so adding a profile stops the
 * build here. A new arrival shape that nothing in this file has ever run is
 * exactly the kind of thing that ships broken.
 */
const ALL_KINDS = Object.keys({
  uniform: true,
  poisson: true,
  waves: true,
  'front-loaded': true,
  peak: true,
  'all-at-once': true,
} satisfies Record<ArrivalKind, true>) as ArrivalKind[]

/** Profiles that draw from the rng, so a new seed must move them. */
const STOCHASTIC_KINDS: ArrivalKind[] = ['poisson', 'waves', 'front-loaded', 'peak']

/** Profiles that are pure arithmetic, so the seed must not reach them at all. */
const DETERMINISTIC_KINDS: ArrivalKind[] = ['uniform', 'all-at-once']

const profileFor = (
  kind: ArrivalKind,
  overrides: Partial<ArrivalProfile> = {},
): ArrivalProfile => ({
  kind,
  startS: 0,
  windowS: WINDOW,
  ...overrides,
})

/** Position in the window, 0–1, which is how every shape assertion is phrased. */
const fractions = (times: number[]): number[] => times.map((t) => t / WINDOW)

const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length

/** Times come back sorted, so the middle element is the median. */
const median = (values: number[]): number => values[Math.floor(values.length / 2)]

/** How many arrivals fall in each of `bins` equal slices of the window. */
const histogram = (times: number[], bins: number): number[] => {
  const counts = new Array<number>(bins).fill(0)
  for (const f of fractions(times)) {
    const bin = Math.floor(f * bins)
    if (bin >= 0 && bin < bins) counts[bin]++
  }
  return counts
}

describe('every arrival profile', () => {
  it.each(ALL_KINDS)('delivers exactly the headcount the population asked for (%s)', (kind) => {
    expect(scheduleArrivals(profileFor(kind), 137, new Rng(11))).toHaveLength(137)
  })

  it.each(ALL_KINDS)('hands the engine the arrivals in the order they happen (%s)', (kind) => {
    // The engine walks the schedule alongside the group split, giving the nth
    // person the nth time and a whole group its first member's time. Out of
    // order, a group would be spawned before the people ahead of it.
    const times = scheduleArrivals(profileFor(kind), 300, new Rng(11))
    expect(times.every((t, i) => i === 0 || times[i - 1] <= t)).toBe(true)
  })

  it.each(ALL_KINDS)('lets nobody in before the doors open (%s)', (kind) => {
    const times = scheduleArrivals(profileFor(kind, { startS: 900 }), 300, new Rng(11))
    expect(Math.min(...times)).toBeGreaterThanOrEqual(900)
  })

  it.each(ALL_KINDS)(
    'offsets the whole schedule by startS rather than reshaping it (%s)',
    (kind) => {
      // A later doors-open time must move the queue, not redraw it: the same seed
      // has to spend its draws on the same shape either way.
      const atZero = scheduleArrivals(profileFor(kind), 200, new Rng(31))
      const shifted = scheduleArrivals(profileFor(kind, { startS: 450 }), 200, new Rng(31))
      shifted.forEach((t, i) => expect(t - 450).toBeCloseTo(atZero[i], 9))
    },
  )

  it.each(ALL_KINDS)(
    'treats an empty or negative headcount as nobody, not as a crash (%s)',
    (kind) => {
      expect(scheduleArrivals(profileFor(kind), 0, new Rng(11))).toEqual([])
      expect(scheduleArrivals(profileFor(kind), -5, new Rng(11))).toEqual([])
    },
  )

  it.each(ALL_KINDS)(
    'clamps a negative start and window instead of scheduling the past (%s)',
    (kind) => {
      const times = scheduleArrivals(
        profileFor(kind, { startS: -60, windowS: -30 }),
        5,
        new Rng(11),
      )
      expect(times).toHaveLength(5)
      expect(times.every((t) => t >= 0 && Number.isFinite(t))).toBe(true)
    },
  )
})

describe('staying inside the window', () => {
  // Poisson and waves are left out on purpose: both overrun, and each has a
  // test of its own below saying by how much.
  const BOUNDED: ArrivalKind[] = ['uniform', 'front-loaded', 'peak', 'all-at-once']

  it.each(BOUNDED)('keeps every arrival between start and start + window (%s)', (kind) => {
    const times = scheduleArrivals(profileFor(kind, { startS: 300 }), 2000, new Rng(19))
    expect(Math.min(...times)).toBeGreaterThanOrEqual(300)
    expect(Math.max(...times)).toBeLessThanOrEqual(300 + WINDOW)
  })

  it.each([...BOUNDED, 'poisson' as ArrivalKind])(
    'collapses a zero-length window onto the start instant (%s)',
    (kind) => {
      // Poisson's rate is count / window, so this is also the division by zero.
      const times = scheduleArrivals(profileFor(kind, { startS: 120, windowS: 0 }), 12, new Rng(7))
      expect(times).toEqual(new Array(12).fill(120))
    },
  )
})

describe('uniform arrivals', () => {
  it('spaces people evenly with a half gap at each end', () => {
    const count = 8
    const times = scheduleArrivals(profileFor('uniform'), count, new Rng(3))
    const gap = WINDOW / count
    expect(times[0]).toBeCloseTo(gap / 2, 9)
    expect(times[count - 1]).toBeCloseTo(WINDOW - gap / 2, 9)
    // Half a gap at each end is what keeps the flow rate constant across two
    // back-to-back windows instead of doubling up on the seam.
    times.slice(1).forEach((t, i) => expect(t - times[i]).toBeCloseTo(gap, 9))
  })

  it('is perfectly flat: every tenth of the window gets the same number', () => {
    expect(histogram(scheduleArrivals(profileFor('uniform'), 600, new Rng(3)), 10)).toEqual(
      new Array(10).fill(60),
    )
  })
})

describe('all-at-once arrivals', () => {
  it('puts everyone on the start instant and ignores the window', () => {
    const times = scheduleArrivals(profileFor('all-at-once', { startS: 90 }), 250, new Rng(3))
    expect(times).toEqual(new Array(250).fill(90))
  })
})

describe('poisson arrivals', () => {
  it('draws gaps at the rate the count and window imply', () => {
    const count = 2000
    const nominal = WINDOW / count
    const gapMeans = Array.from({ length: 12 }, (_, i) => {
      const times = scheduleArrivals(profileFor('poisson'), count, new Rng(i + 1))
      return mean(times.slice(1).map((t, j) => t - times[j]))
    })
    for (const gapMean of gapMeans) {
      expect(gapMean).toBeGreaterThan(nominal * 0.9)
      expect(gapMean).toBeLessThan(nominal * 1.1)
    }
    expect(mean(gapMeans)).toBeGreaterThan(nominal * 0.95)
    expect(mean(gapMeans)).toBeLessThan(nominal * 1.05)
  })

  it('is genuinely bursty rather than uniform with jitter', () => {
    // Flat would put exactly 60 in every tenth and space everyone 2 s apart.
    // Choosing poisson over uniform buys the busy tenths and the lulls, which
    // are what make a queue build and clear at all.
    for (let seed = 1; seed <= 20; seed++) {
      const times = scheduleArrivals(profileFor('poisson'), 600, new Rng(seed))
      const gaps = times.slice(1).map((t, i) => t - times[i])
      expect(Math.max(...histogram(times, 10))).toBeGreaterThan(60)
      expect(Math.max(...gaps)).toBeGreaterThan(mean(gaps) * 3)
    }
  })

  it('still finishes roughly when the window says it should', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const times = scheduleArrivals(profileFor('poisson'), 600, new Rng(seed))
      const last = times[times.length - 1] / WINDOW
      expect(last).toBeGreaterThan(0.8)
      expect(last).toBeLessThan(1.3)
    }
  })

  it('lets people turn up after the window it was given has closed', () => {
    // SUSPECTED BUG: the schedule is a running sum of exponential gaps, so
    // nothing bounds it by the window — "600 people over 20 minutes" delivers
    // its last arrivals after the 20 minutes are up about half the time, and
    // this profile then disagrees with every bounded one about what windowS
    // means. Anyone past the scenario duration never enters the venue at all,
    // so a comparison against a uniform baseline is quietly short of people.
    // Asserting current behaviour; correct would be to scale the draws onto
    // the window (or to thin the process to it) and keep the burstiness.
    let overran = 0
    for (let seed = 1; seed <= 50; seed++) {
      const times = scheduleArrivals(profileFor('poisson'), 200, new Rng(seed))
      if (times[times.length - 1] > WINDOW) overran++
    }
    expect(overran).toBeGreaterThan(10)
  })
})

describe('wave arrivals', () => {
  /** Which wave a time belongs to, given that the unload only runs forwards. */
  const waveOf = (times: number[], gap: number): number[] => times.map((t) => Math.floor(t / gap))

  const countPerWave = (times: number[], waves: number): number[] => {
    const counts = new Array<number>(waves).fill(0)
    for (const wave of waveOf(times, WINDOW / (waves - 1))) counts[wave]++
    return counts
  }

  it('splits the headcount as evenly across the waves as it divides', () => {
    const even = scheduleArrivals(profileFor('waves', { waves: 5 }), 100, new Rng(3))
    expect(countPerWave(even, 5)).toEqual([20, 20, 20, 20, 20])

    // Ten people off four coaches cannot be even, but no coach may arrive empty
    // and none may be left carrying the rounding error for all the others.
    const odd = scheduleArrivals(profileFor('waves', { waves: 4 }), 10, new Rng(8))
    expect(countPerWave(odd, 4)).toEqual([3, 2, 3, 2])
  })

  it('defaults to four waves', () => {
    expect(countPerWave(scheduleArrivals(profileFor('waves'), 100, new Rng(8)), 4)).toEqual([
      25, 25, 25, 25,
    ])
  })

  it('lands each wave on its nominal time plus a short unload', () => {
    const gap = WINDOW / 4
    const times = scheduleArrivals(profileFor('waves', { waves: 5 }), 400, new Rng(12))
    const offsets = times.map((t) => t - Math.floor(t / gap) * gap)
    expect(Math.min(...offsets)).toBeGreaterThanOrEqual(0)
    // A coach does not empty instantly, but it does empty: capped at 45 s so
    // the waves stay distinguishable instead of smearing into a uniform run.
    expect(Math.max(...offsets)).toBeLessThanOrEqual(45)
    expect(Math.max(...offsets)).toBeGreaterThan(30)
  })

  it('clamps a wave count below one to a single batch', () => {
    for (const waves of [0, -3, 0.4]) {
      const times = scheduleArrivals(profileFor('waves', { waves }), 40, new Rng(8))
      expect(times).toHaveLength(40)
      // One wave means no gap to spread over, so the unload floor is all there is.
      expect(Math.max(...times)).toBeLessThanOrEqual(10)
    }
  })

  it('does not fabricate a wave it has nobody for', () => {
    const times = scheduleArrivals(profileFor('waves', { waves: 10 }), 3, new Rng(8))
    expect(times).toHaveLength(3)
    expect(new Set(waveOf(times, WINDOW / 9)).size).toBe(3)
  })

  it('runs the last wave and its unload past the end of the window', () => {
    // SUSPECTED BUG: the final wave starts at exactly start + window and only
    // then has its unload spread added, so a wave schedule always overruns by
    // up to 45 s. Correct would be to fit the waves so the last one has emptied
    // by the end of the window; as it stands "in waves" and "evenly spread"
    // over the same window are not over the same window.
    const times = scheduleArrivals(profileFor('waves', { waves: 5 }), 200, new Rng(3))
    expect(Math.max(...times)).toBeGreaterThan(WINDOW)
    expect(Math.max(...times)).toBeLessThanOrEqual(WINDOW + 45)
  })

  it('still spreads arrivals over ten seconds when the window is zero', () => {
    // SUSPECTED BUG: the unload spread has a flat 10 s floor that does not
    // scale with the window, so a zero-length wave window is the one profile
    // where "everybody at once" is not at once. Correct would be to cap the
    // spread by the window as well as by 45 s.
    const times = scheduleArrivals(profileFor('waves', { startS: 120, windowS: 0 }), 20, new Rng(3))
    expect(Math.min(...times)).toBeGreaterThan(120)
    expect(Math.max(...times)).toBeLessThanOrEqual(130)
  })
})

describe('front-loaded arrivals', () => {
  const positions = fractions(scheduleArrivals(profileFor('front-loaded'), 3000, new Rng(13)))

  it('puts more than half the crowd in the first quarter and a trickle in the last', () => {
    expect(positions.filter((f) => f < 0.25).length / positions.length).toBeGreaterThan(0.5)
    expect(positions.filter((f) => f >= 0.75).length / positions.length).toBeLessThan(0.2)
  })

  it('sits well before the midpoint a uniform profile would give', () => {
    // u^2.2 has median 0.5^2.2 ~= 0.22 and mean 1/3.2 ~= 0.31. A median near
    // 0.5 would mean the exponent has been lost and this is uniform in disguise.
    expect(median(positions)).toBeLessThan(0.25)
    expect(mean(positions)).toBeGreaterThan(0.28)
    expect(mean(positions)).toBeLessThan(0.34)
  })

  it('thins out steadily rather than stopping dead', () => {
    const bins = histogram(scheduleArrivals(profileFor('front-loaded'), 3000, new Rng(13)), 4)
    expect(bins[0]).toBeGreaterThan(bins[1])
    expect(bins[1]).toBeGreaterThan(bins[2])
    expect(bins[2]).toBeGreaterThan(bins[3])
    expect(bins[3]).toBeGreaterThan(0)
  })
})

describe('peak arrivals', () => {
  it('centres the crowd on the requested peak', () => {
    for (const peakAt of [0.2, 0.5, 0.8]) {
      const positions = fractions(
        scheduleArrivals(profileFor('peak', { peakAt, spread: 0.08 }), 2000, new Rng(5)),
      )
      expect(median(positions)).toBeCloseTo(peakAt, 1)
      expect(mean(positions)).toBeCloseTo(peakAt, 1)
    }
  })

  it('defaults to a mid-window peak that holds most of the crowd', () => {
    const positions = fractions(scheduleArrivals(profileFor('peak'), 3000, new Rng(5)))
    expect(mean(positions)).toBeCloseTo(0.5, 1)
    // One standard deviation of a normal holds ~68% of the mass. Too little and
    // the peak has flattened into a uniform run; too much and it is a spike.
    const withinOneSpread = positions.filter((f) => Math.abs(f - 0.5) <= 0.18).length
    expect(withinOneSpread / positions.length).toBeGreaterThan(0.6)
    expect(withinOneSpread / positions.length).toBeLessThan(0.78)
  })

  it('concentrates harder as the spread narrows', () => {
    const wide = fractions(scheduleArrivals(profileFor('peak', { spread: 0.3 }), 2000, new Rng(5)))
    const tight = fractions(
      scheduleArrivals(profileFor('peak', { spread: 0.04 }), 2000, new Rng(5)),
    )
    const nearPeak = (f: number[]) => f.filter((x) => Math.abs(x - 0.5) <= 0.05).length
    expect(nearPeak(tight)).toBeGreaterThan(nearPeak(wide) * 2)
  })

  it('floors a zero spread so the peak is sampled rather than degenerate', () => {
    const positions = fractions(
      scheduleArrivals(profileFor('peak', { spread: 0 }), 2000, new Rng(5)),
    )
    const range = Math.max(...positions) - Math.min(...positions)
    expect(range).toBeGreaterThan(0)
    // The floor is 0.02 of the window, so a few sigma either side at most.
    expect(range).toBeLessThan(0.2)
  })

  it('clamps a peak outside the window to its edge', () => {
    const late = fractions(scheduleArrivals(profileFor('peak', { peakAt: 3 }), 2000, new Rng(5)))
    const early = fractions(scheduleArrivals(profileFor('peak', { peakAt: -3 }), 2000, new Rng(5)))
    expect(median(late)).toBeGreaterThan(0.75)
    expect(Math.max(...late)).toBeLessThanOrEqual(1)
    expect(median(early)).toBeLessThan(0.25)
    expect(Math.min(...early)).toBeGreaterThanOrEqual(0)
  })

  it('stacks a quarter of the crowd on one instant when the spread is very wide', () => {
    // SUSPECTED BUG: truncatedNormal resamples 16 times and then gives up and
    // returns the clamped *mean*, so a spread wide enough that most samples
    // miss [0, 1] hands hundreds of people the identical arrival second — a
    // fake surge in the very profile meant to model a gentle one. A spread over
    // 1 has no UI control but survives a load: parseArrival passes it through
    // unclamped. Correct would be to clamp the failed sample, or the spread.
    const times = scheduleArrivals(profileFor('peak', { spread: 5 }), 2000, new Rng(5))
    const onTheDot = times.filter((t) => t === WINDOW * 0.5)
    expect(onTheDot.length).toBeGreaterThan(300)
    // At a spread the UI can produce, nobody shares an instant with anybody.
    const sane = scheduleArrivals(profileFor('peak'), 2000, new Rng(5))
    expect(sane.filter((t) => t === WINDOW * 0.5)).toHaveLength(0)
  })
})

describe('reproducibility', () => {
  it.each(ALL_KINDS)('replays a scenario identically for the same seed (%s)', (kind) => {
    const profile = profileFor(kind, { waves: 3, peakAt: 0.4, spread: 0.1 })
    expect(scheduleArrivals(profile, 200, new Rng(1234))).toEqual(
      scheduleArrivals(profile, 200, new Rng(1234)),
    )
  })

  it.each(STOCHASTIC_KINDS)('actually moves when the seed changes (%s)', (kind) => {
    const profile = profileFor(kind, { waves: 3, peakAt: 0.4, spread: 0.1 })
    expect(scheduleArrivals(profile, 200, new Rng(1234))).not.toEqual(
      scheduleArrivals(profile, 200, new Rng(4321)),
    )
  })

  it.each(DETERMINISTIC_KINDS)('ignores the seed, having no random draws to make (%s)', (kind) => {
    expect(scheduleArrivals(profileFor(kind), 40, new Rng(1))).toEqual(
      scheduleArrivals(profileFor(kind), 40, new Rng(999999)),
    )
  })

  it('never reaches for Math.random', () => {
    // One Math.random in here and a scenario stops replaying, which is the
    // engine-wide claim the whole validation suite rests on.
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('arrivals must draw from the seeded Rng')
    })
    try {
      for (const kind of ALL_KINDS) {
        expect(() =>
          scheduleArrivals(profileFor(kind, { waves: 3, peakAt: 0.3 }), 500, new Rng(2)),
        ).not.toThrow()
      }
      expect(() => splitIntoGroups(500, { min: 2, max: 5 }, new Rng(2))).not.toThrow()
    } finally {
      random.mockRestore()
    }
  })
})

describe('splitting a headcount into groups', () => {
  it('accounts for every person exactly once', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const groups = splitIntoGroups(97, { min: 2, max: 6 }, new Rng(seed))
      expect(groups.reduce((a, b) => a + b, 0)).toBe(97)
    }
  })

  it('sends people in on their own when nobody is grouped', () => {
    expect(splitIntoGroups(4, undefined, new Rng(1))).toEqual([1, 1, 1, 1])
    expect(splitIntoGroups(4, { min: 1, max: 1 }, new Rng(1))).toEqual([1, 1, 1, 1])
  })

  it('keeps every group inside the configured size but for the remainder', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const groups = splitIntoGroups(97, { min: 3, max: 6 }, new Rng(seed))
      expect(groups.slice(0, -1).every((size) => size >= 3 && size <= 6)).toBe(true)
      expect(Math.max(...groups)).toBeLessThanOrEqual(6)
      expect(Math.min(...groups)).toBeGreaterThanOrEqual(1)
    }
  })

  it('lets the last group be short rather than inventing a person', () => {
    // Padding the tail up to `min` would add people the scenario never asked
    // for; dropping it would lose the ones it did.
    const shortTail = Array.from({ length: 40 }, (_, i) =>
      splitIntoGroups(50, { min: 3, max: 6 }, new Rng(i + 1)),
    ).some((groups) => groups[groups.length - 1] < 3)
    expect(shortTail).toBe(true)
  })

  it('makes about as many groups as the mean group size implies', () => {
    const counts = Array.from(
      { length: 40 },
      (_, i) => splitIntoGroups(400, { min: 2, max: 6 }, new Rng(i + 1)).length,
    )
    expect(mean(counts)).toBeGreaterThan(90)
    expect(mean(counts)).toBeLessThan(112)
  })

  it('splits a headcount of zero into no groups', () => {
    expect(splitIntoGroups(0, { min: 2, max: 4 }, new Rng(1))).toEqual([])
    expect(splitIntoGroups(0, undefined, new Rng(1))).toEqual([])
  })

  it('gives a lone person their own group even where groups are large', () => {
    expect(splitIntoGroups(1, { min: 4, max: 8 }, new Rng(1))).toEqual([1])
  })

  it('raises an inverted size range to a fixed size instead of looping forever', () => {
    // max below min would make rng.int draw from an empty range and return
    // sizes of zero, which never empties `remaining`.
    expect(splitIntoGroups(20, { min: 5, max: 2 }, new Rng(1))).toEqual([5, 5, 5, 5])
  })

  it('floors the minimum at one so the split always terminates', () => {
    for (const min of [0, -4]) {
      const groups = splitIntoGroups(30, { min, max: 3 }, new Rng(1))
      expect(groups.reduce((a, b) => a + b, 0)).toBe(30)
      expect(Math.min(...groups)).toBeGreaterThanOrEqual(1)
    }
  })

  it('rounds a fractional size range to whole people', () => {
    const groups = splitIntoGroups(60, { min: 2.4, max: 3.6 }, new Rng(1))
    expect(Math.min(...groups.slice(0, -1))).toBeGreaterThanOrEqual(2)
    expect(Math.max(...groups)).toBeLessThanOrEqual(4)
  })

  it('replays identically for the same seed and differs for another', () => {
    expect(splitIntoGroups(50, { min: 3, max: 6 }, new Rng(77))).toEqual(
      splitIntoGroups(50, { min: 3, max: 6 }, new Rng(77)),
    )
    expect(splitIntoGroups(50, { min: 3, max: 6 }, new Rng(77))).not.toEqual(
      splitIntoGroups(50, { min: 3, max: 6 }, new Rng(78)),
    )
  })
})
