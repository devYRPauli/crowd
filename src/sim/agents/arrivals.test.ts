/**
 * Arrival schedules.
 *
 * The count is the easy half. The shape is the half the product is actually
 * sold on: the same 600 people arriving evenly, in five coach-loads, or in a
 * pre-session peak queue completely differently, and a profile that quietly
 * flattens into another one makes those comparisons meaningless. So most of
 * what is below measures shape — where the mass sits, how spread out it is,
 * whether it stays inside the window it was given — rather than just counting.
 *
 * Determinism is checked per profile because AGENTS.md makes it a whole-engine
 * invariant: the same seed must replay exactly, and a different seed must
 * actually move the stochastic profiles rather than silently doing nothing.
 */

import { describe, expect, it, vi } from 'vitest'
import { scheduleArrivals, splitIntoGroups } from './arrivals'
import { Rng } from '../../core/math/random'
import type { ArrivalKind, ArrivalProfile } from '../../core/model/types'

const WINDOW = 1200

const ALL_KINDS: ArrivalKind[] = [
  'uniform',
  'poisson',
  'waves',
  'front-loaded',
  'peak',
  'all-at-once',
]

/** Profiles that draw from the rng, so a new seed must change the answer. */
const STOCHASTIC_KINDS: ArrivalKind[] = ['poisson', 'waves', 'front-loaded', 'peak']

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
const fractions = (times: number[], start = 0, window = WINDOW): number[] =>
  times.map((t) => (t - start) / window)

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
  it.each(ALL_KINDS)('produces exactly the headcount it was asked for (%s)', (kind) => {
    expect(scheduleArrivals(profileFor(kind), 137, new Rng(11))).toHaveLength(137)
  })

  it.each(ALL_KINDS)('returns times sorted ascending (%s)', (kind) => {
    const times = scheduleArrivals(profileFor(kind), 300, new Rng(11))
    expect(times.every((t, i) => i === 0 || times[i - 1] <= t)).toBe(true)
  })

  it.each(ALL_KINDS)('never seats anybody before the doors open (%s)', (kind) => {
    const times = scheduleArrivals(profileFor(kind, { startS: 900 }), 300, new Rng(11))
    expect(Math.min(...times)).toBeGreaterThanOrEqual(900)
  })

  it.each(ALL_KINDS)(
    'offsets the whole schedule by startS rather than reshaping it (%s)',
    (kind) => {
      const atZero = scheduleArrivals(profileFor(kind), 200, new Rng(31))
      const shifted = scheduleArrivals(profileFor(kind, { startS: 450 }), 200, new Rng(31))
      shifted.forEach((t, i) => expect(t - 450).toBeCloseTo(atZero[i], 9))
    },
  )

  it.each(ALL_KINDS)('treats a headcount of zero as nobody, not as a crash (%s)', (kind) => {
    expect(scheduleArrivals(profileFor(kind), 0, new Rng(11))).toEqual([])
  })

  it.each(ALL_KINDS)('treats a negative headcount as nobody (%s)', (kind) => {
    expect(scheduleArrivals(profileFor(kind), -5, new Rng(11))).toEqual([])
  })

  it.each(ALL_KINDS)('clamps a negative start and window to zero (%s)', (kind) => {
    const times = scheduleArrivals(profileFor(kind, { startS: -60, windowS: -30 }), 5, new Rng(11))
    expect(times).toHaveLength(5)
    expect(times.every((t) => t >= 0 && Number.isFinite(t))).toBe(true)
  })
})

describe('staying inside the window', () => {
  // Poisson and waves are excluded on purpose — both overrun, and each has its
  // own test below saying by how much.
  const BOUNDED: ArrivalKind[] = ['uniform', 'front-loaded', 'peak', 'all-at-once']

  it.each(BOUNDED)('keeps every arrival between start and start + window (%s)', (kind) => {
    const times = scheduleArrivals(profileFor(kind, { startS: 300 }), 2000, new Rng(19))
    expect(Math.min(...times)).toBeGreaterThanOrEqual(300)
    expect(Math.max(...times)).toBeLessThanOrEqual(300 + WINDOW)
  })

  it.each(['uniform', 'poisson', 'front-loaded', 'peak', 'all-at-once'] as ArrivalKind[])(
    'collapses a zero-length window onto the start instant (%s)',
    (kind) => {
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
    // Equal half gaps at both ends are what keep the flow rate constant across
    // a run made of back-to-back uniform windows.
    times.slice(1).forEach((t, i) => expect(t - times[i]).toBeCloseTo(gap, 9))
  })

  it('is perfectly flat: every tenth of the window gets the same number', () => {
    expect(histogram(scheduleArrivals(profileFor('uniform'), 600, new Rng(3)), 10)).toEqual(
      new Array(10).fill(60),
    )
  })

  it('ignores the seed, because it makes no random draws at all', () => {
    expect(scheduleArrivals(profileFor('uniform'), 40, new Rng(1))).toEqual(
      scheduleArrivals(profileFor('uniform'), 40, new Rng(999999)),
    )
  })
})

describe('all-at-once arrivals', () => {
  it('puts everyone on the start instant and ignores the window', () => {
    const times = scheduleArrivals(profileFor('all-at-once', { startS: 90 }), 250, new Rng(3))
    expect(times).toEqual(new Array(250).fill(90))
  })

  it('ignores the seed, because it makes no random draws at all', () => {
    expect(scheduleArrivals(profileFor('all-at-once'), 40, new Rng(1))).toEqual(
      scheduleArrivals(profileFor('all-at-once'), 40, new Rng(999999)),
    )
  })
})

describe('poisson arrivals', () => {
  it('draws gaps at the rate the count and window imply', () => {
    const count = 4000
    const times = scheduleArrivals(profileFor('poisson'), count, new Rng(9))
    const gaps = times.slice(1).map((t, i) => t - times[i])
    expect(mean(gaps)).toBeCloseTo(WINDOW / count, 2)
  })

  it('is genuinely bursty rather than uniform with jitter', () => {
    // A flat schedule of 600 puts exactly 60 in every tenth of the window. The
    // whole point of choosing poisson over uniform is that some tenths are
    // busier than others, which is what makes a queue form and clear.
    for (let seed = 1; seed <= 20; seed++) {
      const busiest = Math.max(
        ...histogram(scheduleArrivals(profileFor('poisson'), 600, new Rng(seed)), 10),
      )
      expect(busiest).toBeGreaterThan(60)
    }
  })

  it('finishes near the end of the window on average', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const times = scheduleArrivals(profileFor('poisson'), 600, new Rng(seed))
      const last = times[times.length - 1] / WINDOW
      expect(last).toBeGreaterThan(0.8)
      expect(last).toBeLessThan(1.3)
    }
  })

  it('SUSPECTED BUG: lets people turn up after the window has closed', () => {
    // Current behaviour, asserted rather than fixed. The schedule is a running
    // sum of exponential gaps, so nothing bounds it by the window: "600 people
    // over 20 minutes" routinely delivers its last arrival minutes after the
    // 20 minutes are up, and every other bounded profile disagrees with it
    // about what windowS means.
    let overran = 0
    for (let seed = 1; seed <= 50; seed++) {
      const times = scheduleArrivals(profileFor('poisson'), 200, new Rng(seed))
      if (times[times.length - 1] > WINDOW) overran++
    }
    expect(overran).toBeGreaterThan(10)
  })
})

describe('wave arrivals', () => {
  /** Wave index of each time, given that the spread only ever runs forwards. */
  const waveOf = (times: number[], gap: number): number[] => times.map((t) => Math.floor(t / gap))

  it('splits the headcount evenly across the requested number of waves', () => {
    const times = scheduleArrivals(profileFor('waves', { waves: 5 }), 100, new Rng(3))
    const counts = new Array<number>(5).fill(0)
    for (const wave of waveOf(times, WINDOW / 4)) counts[wave]++
    expect(counts).toEqual([20, 20, 20, 20, 20])
  })

  it('defaults to four waves', () => {
    const times = scheduleArrivals(profileFor('waves'), 100, new Rng(8))
    const counts = new Array<number>(4).fill(0)
    for (const wave of waveOf(times, WINDOW / 3)) counts[wave]++
    expect(counts).toEqual([25, 25, 25, 25])
  })

  it('lands each wave on its nominal time plus a short unload', () => {
    const gap = WINDOW / 4
    const times = scheduleArrivals(profileFor('waves', { waves: 5 }), 400, new Rng(12))
    const offsets = times.map((t) => t - Math.floor(t / gap) * gap)
    expect(Math.min(...offsets)).toBeGreaterThanOrEqual(0)
    // A coach does not empty instantly, but it does empty: the spread is capped
    // at 45 s, so waves stay separate rather than smearing into a uniform run.
    expect(Math.max(...offsets)).toBeLessThanOrEqual(45)
    expect(Math.max(...offsets)).toBeGreaterThan(30)
  })

  it('clamps a waves count below one to a single batch', () => {
    for (const waves of [0, -3, 0.4]) {
      const times = scheduleArrivals(profileFor('waves', { waves }), 40, new Rng(8))
      expect(times).toHaveLength(40)
      // One wave means no gap, so everyone lands in the first unload window.
      expect(Math.max(...times)).toBeLessThanOrEqual(10)
    }
  })

  it('does not fabricate a wave it has nobody for', () => {
    const times = scheduleArrivals(profileFor('waves', { waves: 10 }), 3, new Rng(8))
    expect(times).toHaveLength(3)
    expect(new Set(times.map((t) => Math.floor(t / (WINDOW / 9)))).size).toBe(3)
  })

  it('SUSPECTED BUG: the last wave and its unload both run past the window', () => {
    // Current behaviour, asserted rather than fixed. The final wave starts at
    // exactly start + window and only then gets its unload spread added, so a
    // wave schedule always overruns its window by up to 45 s.
    const times = scheduleArrivals(profileFor('waves', { waves: 5 }), 200, new Rng(3))
    expect(Math.max(...times)).toBeGreaterThan(WINDOW)
    expect(Math.max(...times)).toBeLessThanOrEqual(WINDOW + 45)
  })

  it('SUSPECTED BUG: a zero-length window still spreads arrivals over 10 s', () => {
    // Current behaviour, asserted rather than fixed. The unload spread has a
    // 10 s floor that does not scale with the window, so "everyone at once" via
    // a zero-length wave window is not actually at once — unlike every other
    // profile, which collapses onto the start instant.
    const times = scheduleArrivals(profileFor('waves', { startS: 120, windowS: 0 }), 20, new Rng(3))
    expect(Math.min(...times)).toBeGreaterThan(120)
    expect(Math.max(...times)).toBeLessThanOrEqual(130)
  })
})

describe('front-loaded arrivals', () => {
  const times = scheduleArrivals(profileFor('front-loaded'), 3000, new Rng(13))
  const positions = fractions(times)

  it('puts more than half the crowd in the first quarter of the window', () => {
    expect(positions.filter((f) => f < 0.25).length / positions.length).toBeGreaterThan(0.5)
  })

  it('leaves only a trickle in the last quarter', () => {
    expect(positions.filter((f) => f >= 0.75).length / positions.length).toBeLessThan(0.2)
  })

  it('has its median well before the midpoint a uniform profile would give', () => {
    // u^2.2 has median 0.5^2.2 ~= 0.218 and mean 1/3.2 = 0.3125. Anything near
    // 0.5 means the exponent has been lost and this is uniform in disguise.
    expect(median(positions)).toBeLessThan(0.25)
    expect(mean(positions)).toBeGreaterThan(0.28)
    expect(mean(positions)).toBeLessThan(0.34)
  })

  it('decays monotonically across the window', () => {
    const bins = histogram(times, 4)
    expect(bins[0]).toBeGreaterThan(bins[1])
    expect(bins[1]).toBeGreaterThan(bins[2])
    expect(bins[2]).toBeGreaterThan(bins[3])
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

  it('defaults to a mid-window peak with an 0.18 spread', () => {
    const positions = fractions(scheduleArrivals(profileFor('peak'), 3000, new Rng(5)))
    expect(mean(positions)).toBeCloseTo(0.5, 1)
    // One standard deviation of a normal holds ~68% of the mass; this is the
    // assertion that catches a "peak" that has quietly flattened out.
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

  it('floors the spread so a zero spread is still sampled, not degenerate', () => {
    const positions = fractions(
      scheduleArrivals(profileFor('peak', { spread: 0 }), 2000, new Rng(5)),
    )
    expect(Math.max(...positions) - Math.min(...positions)).toBeGreaterThan(0)
    // 0.02 of the window, so a few sigma either side of the peak at most.
    expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(0.2)
  })

  it('clamps a peak outside the window to its edge', () => {
    const late = fractions(scheduleArrivals(profileFor('peak', { peakAt: 3 }), 2000, new Rng(5)))
    const early = fractions(scheduleArrivals(profileFor('peak', { peakAt: -3 }), 2000, new Rng(5)))
    expect(median(late)).toBeGreaterThan(0.75)
    expect(Math.max(...late)).toBeLessThanOrEqual(1)
    expect(median(early)).toBeLessThan(0.25)
    expect(Math.min(...early)).toBeGreaterThanOrEqual(0)
  })
})

describe('reproducibility', () => {
  it.each(ALL_KINDS)('replays identically for the same seed (%s)', (kind) => {
    const args = profileFor(kind, { waves: 3, peakAt: 0.4, spread: 0.1 })
    expect(scheduleArrivals(args, 200, new Rng(1234))).toEqual(
      scheduleArrivals(args, 200, new Rng(1234)),
    )
  })

  it.each(STOCHASTIC_KINDS)('actually moves when the seed changes (%s)', (kind) => {
    const args = profileFor(kind, { waves: 3, peakAt: 0.4, spread: 0.1 })
    expect(scheduleArrivals(args, 200, new Rng(1234))).not.toEqual(
      scheduleArrivals(args, 200, new Rng(4321)),
    )
  })

  it('never reaches for Math.random', () => {
    // AGENTS.md: every stochastic decision draws from the seeded Rng. One
    // Math.random anywhere in here and a scenario stops replaying.
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

  it('returns singletons when no group size is configured', () => {
    expect(splitIntoGroups(4, undefined, new Rng(1))).toEqual([1, 1, 1, 1])
  })

  it('returns singletons when the maximum group is one person', () => {
    expect(splitIntoGroups(4, { min: 1, max: 1 }, new Rng(1))).toEqual([1, 1, 1, 1])
  })

  it('never exceeds the maximum group size', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const groups = splitIntoGroups(120, { min: 2, max: 5 }, new Rng(seed))
      expect(Math.max(...groups)).toBeLessThanOrEqual(5)
      expect(Math.min(...groups)).toBeGreaterThanOrEqual(1)
    }
  })

  it('holds every group but the last to the minimum size', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const groups = splitIntoGroups(97, { min: 3, max: 6 }, new Rng(seed))
      expect(groups.slice(0, -1).every((size) => size >= 3 && size <= 6)).toBe(true)
    }
  })

  it('lets the remainder be smaller than the minimum rather than inventing a person', () => {
    // The tail group takes whatever is left. Padding it up to `min` would add
    // people the scenario did not ask for; rounding it away would lose some.
    const shortTail = Array.from({ length: 40 }, (_, i) =>
      splitIntoGroups(50, { min: 3, max: 6 }, new Rng(i + 1)),
    ).some((groups) => groups[groups.length - 1] < 3)
    expect(shortTail).toBe(true)
  })

  it('produces about as many groups as the mean group size implies', () => {
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

  it('gives a lone person their own group even when groups are large', () => {
    expect(splitIntoGroups(1, { min: 4, max: 8 }, new Rng(1))).toEqual([1])
  })

  it('raises an inverted range to a fixed size instead of looping forever', () => {
    // max < min would make rng.int draw from an empty range; the guard pulls
    // max up to min so every group is exactly that size.
    const groups = splitIntoGroups(20, { min: 5, max: 2 }, new Rng(1))
    expect(groups).toEqual([5, 5, 5, 5])
  })

  it('floors the minimum at one so the loop always makes progress', () => {
    // A min of 0 would let rng.int return 0, and `remaining` would never fall.
    for (const min of [0, -4]) {
      const groups = splitIntoGroups(30, { min, max: 3 }, new Rng(1))
      expect(groups.reduce((a, b) => a + b, 0)).toBe(30)
      expect(Math.min(...groups)).toBeGreaterThanOrEqual(1)
    }
  })

  it('rounds fractional group bounds', () => {
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
