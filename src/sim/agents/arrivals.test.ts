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

const sd = (values: number[]): number => {
  const m = mean(values)
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)))
}

/** Times come back sorted, so the middle element is the median. */
const median = (values: number[]): number => values[Math.floor(values.length / 2)]

/** The wait between one arrival and the next. */
const gapsOf = (times: number[]): number[] => times.slice(1).map((t, i) => t - times[i])

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
    expect(times).toEqual([...times].sort((a, b) => a - b))
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

  it.each(ALL_KINDS)('schedules a population of one without dividing by it (%s)', (kind) => {
    // Uniform and waves both divide by the headcount to place somebody, and a
    // population of one is a perfectly ordinary way to model a single VIP.
    const [only] = scheduleArrivals(profileFor(kind, { startS: 60 }), 1, new Rng(11))
    expect(only).toBeGreaterThanOrEqual(60)
    expect(only).toBeLessThanOrEqual(60 + WINDOW)
  })

  it.each(ALL_KINDS)('pulls a negative start and window up to the run start (%s)', (kind) => {
    // The clock starts at zero, so a person scheduled before it is a person the
    // run never reaches. A loaded document can carry either number negative.
    const times = scheduleArrivals(profileFor(kind, { startS: -60, windowS: -30 }), 5, new Rng(11))
    expect(times).toEqual([0, 0, 0, 0, 0])
  })
})

describe('staying inside the window', () => {
  // Waves is the exception, and owns a test of its own below: the last coach
  // lands on the end of the window and only then unloads.
  const BOUNDED = ALL_KINDS.filter((kind) => kind !== 'waves')

  it.each(BOUNDED)('keeps every arrival between start and start + window (%s)', (kind) => {
    const times = scheduleArrivals(profileFor(kind, { startS: 300 }), 2000, new Rng(19))
    expect(Math.min(...times)).toBeGreaterThanOrEqual(300)
    expect(Math.max(...times)).toBeLessThanOrEqual(300 + WINDOW)
  })

  it.each(ALL_KINDS)('collapses a zero-length window onto the start instant (%s)', (kind) => {
    // Waves used to be the one exception: its unload spread had a flat 10 s
    // floor that ignored the window, so "in waves, over no time at all" still
    // trickled people in for ten seconds while every other profile opened the
    // doors once. This is also where poisson would divide by the window.
    const times = scheduleArrivals(profileFor(kind, { startS: 120, windowS: 0 }), 12, new Rng(7))
    expect(times).toEqual(new Array(12).fill(120))
  })
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
    gapsOf(times).forEach((g) => expect(g).toBeCloseTo(gap, 9))
    // The same rule taken to its limit: one person waits until mid-window.
    expect(scheduleArrivals(profileFor('uniform'), 1, new Rng(3))).toEqual([WINDOW / 2])
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
  it('holds one average rate from one end of the window to the other', () => {
    // Averaged over enough runs the tenths even out at 60 apiece, which is what
    // makes a poisson run comparable with the uniform baseline at all: same
    // people, same window, same average rate, different bunching. A sagging or
    // rising average here would be a different process wearing the name.
    const runs = Array.from({ length: 24 }, (_, i) =>
      histogram(scheduleArrivals(profileFor('poisson'), 600, new Rng(i + 1)), 10),
    )
    const averaged = runs[0].map((_, bin) => mean(runs.map((run) => run[bin])))
    for (const count of averaged) {
      expect(count).toBeGreaterThan(55)
      expect(count).toBeLessThan(65)
    }
    // Averaging is the only place 60s belong: no single run may come out flat.
    expect(runs.some((run) => run.every((count) => count === 60))).toBe(false)
  })

  it('is genuinely bursty rather than uniform with jitter', () => {
    // The busy tenths and the lulls are what make a queue build and clear at
    // all, and they are the whole reason to pick this over evenly spread. Gaps
    // in a Poisson process are exponential, so they scatter about as widely as
    // they are long — a ratio near 1, against a ratio of 0 for even spacing.
    for (const seed of [3, 7, 19]) {
      const times = scheduleArrivals(profileFor('poisson'), 400, new Rng(seed))
      const spacing = gapsOf(times)
      expect(Math.max(...histogram(times, 10))).toBeGreaterThan(44)
      expect(Math.max(...spacing)).toBeGreaterThan(mean(spacing) * 3)
      expect(sd(spacing) / mean(spacing)).toBeGreaterThan(0.8)
      expect(sd(spacing) / mean(spacing)).toBeLessThan(1.3)
    }
    const even = gapsOf(scheduleArrivals(profileFor('uniform'), 400, new Rng(7)))
    expect(sd(even) / mean(even)).toBeLessThan(0.01)
  })

  it('delivers everybody inside the window, and keeps arriving until it closes', () => {
    // This used to be a running sum of exponential gaps, a total whose mean is
    // the window itself — so about half of all runs put their last arrivals
    // after the doors had shut, and anybody past the scenario duration never
    // entered the venue at all. A poisson run was then quietly short of people
    // against the uniform baseline it was being compared with. Bounding it must
    // not make it finish early either: 200 people over twenty minutes are still
    // turning up in the last two of them.
    for (let seed = 1; seed <= 50; seed++) {
      const times = scheduleArrivals(profileFor('poisson'), 200, new Rng(seed))
      expect(times).toHaveLength(200)
      expect(times[0]).toBeGreaterThanOrEqual(0)
      expect(times[0]).toBeLessThan(WINDOW * 0.1)
      expect(times[199]).toBeGreaterThan(WINDOW * 0.9)
      expect(times[199]).toBeLessThanOrEqual(WINDOW)
    }
  })
})

describe('wave arrivals', () => {
  const nominalGap = (waves: number): number => WINDOW / (waves - 1)

  /** Which wave a time belongs to, given that the unload only runs forwards. */
  const waveOf = (times: number[], gap: number): number[] => times.map((t) => Math.floor(t / gap))

  const countPerWave = (times: number[], waves: number): number[] => {
    const counts = new Array<number>(waves).fill(0)
    for (const wave of waveOf(times, nominalGap(waves))) counts[wave]++
    return counts
  }

  /** Runs of arrivals with a real lull between them — coaches, as seen from the door. */
  const coachesSeen = (times: number[], gap: number): number =>
    1 + gapsOf(times).filter((g) => g > gap / 4).length

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

  it('arrives as separate coach-loads rather than as a steady stream', () => {
    // Five coaches have to read as five arrivals with quiet between them: the
    // unload is capped at 45 s so the batches stay distinguishable instead of
    // smearing into the uniform profile, which is the point of choosing this.
    const times = scheduleArrivals(profileFor('waves', { waves: 5 }), 400, new Rng(12))
    expect(coachesSeen(times, nominalGap(5))).toBe(5)

    const offsets = times.map((t) => t % nominalGap(5))
    expect(Math.min(...offsets)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...offsets)).toBeLessThanOrEqual(45)
    // A coach does not empty instantly either, or this would be all-at-once
    // five times over.
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
    expect(new Set(waveOf(times, nominalGap(10))).size).toBe(3)
  })

  it('lets the last coach finish unloading after the window has closed', () => {
    // The final wave lands on the end of the window and only then unloads, so a
    // wave schedule overruns by up to the unload. That is the coach arriving on
    // time and the people getting off it afterwards, but it does mean "in
    // waves" and "evenly spread" over the same window do not finish together,
    // and anyone past the scenario duration never gets in at all.
    const times = scheduleArrivals(profileFor('waves', { waves: 5 }), 200, new Rng(3))
    expect(Math.max(...times)).toBeGreaterThan(WINDOW)
    expect(Math.max(...times)).toBeLessThanOrEqual(WINDOW + 45)
  })

  it('runs its coaches together into one stream when the window is short', () => {
    // SUSPECTED BUG: the unload is `min(45, window, gap / 4 + 10)`, and that
    // 10 s floor does not shrink with the gap — so once the coaches are under
    // ~13 s apart, each is still unloading when the next pulls up. Twelve waves
    // (the slider's maximum) over two minutes then reads as a continuous flow:
    // three distinguishable arrivals here instead of twelve, where the same
    // twelve over twenty minutes read as exactly twelve. That is the one
    // setting where "in waves" and "evenly spread" produce the same schedule,
    // which is the comparison the profile exists to make. Correct would be to
    // cap the unload by the gap as well as by the window and 45 s.
    const short = scheduleArrivals(
      profileFor('waves', { waves: 12, windowS: 120 }),
      240,
      new Rng(3),
    )
    expect(coachesSeen(short, 120 / 11)).toBeLessThan(6)

    const long = scheduleArrivals(profileFor('waves', { waves: 12 }), 240, new Rng(3))
    expect(coachesSeen(long, nominalGap(12))).toBe(12)
  })
})

describe('front-loaded arrivals', () => {
  const times = scheduleArrivals(profileFor('front-loaded'), 3000, new Rng(13))
  const positions = fractions(times)

  it('puts more than half the crowd in the first quarter and a trickle in the last', () => {
    expect(positions.filter((f) => f < 0.25).length / positions.length).toBeGreaterThan(0.5)
    expect(positions.filter((f) => f >= 0.75).length / positions.length).toBeLessThan(0.2)
  })

  it('sits well before the midpoint a uniform profile would give', () => {
    // u^2.2 has median 0.5^2.2 ~= 0.22 and mean 1/3.2 ~= 0.31. A median near 0.5
    // means the exponent has been lost and this is uniform in disguise; a median
    // near 0 means it has grown and this is all-at-once in disguise.
    expect(median(positions)).toBeGreaterThan(0.17)
    expect(median(positions)).toBeLessThan(0.25)
    expect(mean(positions)).toBeGreaterThan(0.28)
    expect(mean(positions)).toBeLessThan(0.34)
  })

  it('thins out steadily rather than stopping dead', () => {
    // The late trickle is what keeps a door staffed after the rush; a profile
    // that ran dry would let every queue clear early and flatter the layout.
    const quarters = histogram(times, 4)
    expect(quarters[0]).toBeGreaterThan(quarters[1])
    expect(quarters[1]).toBeGreaterThan(quarters[2])
    expect(quarters[2]).toBeGreaterThan(quarters[3])
    expect(quarters[3]).toBeGreaterThan(0)
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

  it('keeps a spread of zero from collapsing the peak onto one instant', () => {
    // Floored at 0.02 of the window rather than taken literally, because a
    // spread of nothing is the all-at-once profile, not a peak.
    const positions = fractions(
      scheduleArrivals(profileFor('peak', { spread: 0 }), 2000, new Rng(5)),
    )
    expect(sd(positions)).toBeCloseTo(0.02, 3)
    expect(new Set(positions).size).toBe(2000)
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
    // SUSPECTED BUG: Rng.truncatedNormal resamples 16 times and then gives up
    // and returns the clamped *mean* rather than a clamped sample, so a spread
    // wide enough that most draws miss [0, 1] hands hundreds of people the
    // identical arrival second — a fabricated surge in the one profile meant to
    // model a gentle one. At spread 5, 521 of 2000 land on exactly the peak
    // instant; at spread 2, 59 do; at the 0.18 default, nobody does. There is no
    // slider for spread, but serialize.ts passes a loaded one straight through
    // unclamped, so a hand-edited or third-party document reaches this. Correct
    // would be to clamp the failed sample rather than the mean — in
    // core/math/random.ts, which every other caller of truncatedNormal shares.
    const times = scheduleArrivals(profileFor('peak', { spread: 5 }), 2000, new Rng(5))
    expect(times.filter((t) => t === WINDOW * 0.5).length).toBeGreaterThan(300)
    // At a spread the product can produce, nobody shares an instant with anybody.
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
    // A maximum of nobody means no grouping, whatever the minimum claims.
    expect(splitIntoGroups(4, { min: 5, max: 0 }, new Rng(1))).toEqual([1, 1, 1, 1])
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
    // Sizes 2–6 average 4, so 400 people arrive in about 100 groups. Many more
    // and the sizes have collapsed towards the minimum, which quietly removes
    // most of the grouping the scenario asked for.
    const counts = Array.from(
      { length: 40 },
      (_, i) => splitIntoGroups(400, { min: 2, max: 6 }, new Rng(i + 1)).length,
    )
    expect(mean(counts)).toBeGreaterThan(97)
    expect(mean(counts)).toBeLessThan(104)
    expect(Math.min(...counts)).toBeGreaterThan(80)
    expect(Math.max(...counts)).toBeLessThan(125)
  })

  it('splits a headcount of zero or less into no groups', () => {
    for (const count of [0, -5]) {
      expect(splitIntoGroups(count, { min: 2, max: 4 }, new Rng(1))).toEqual([])
      expect(splitIntoGroups(count, undefined, new Rng(1))).toEqual([])
    }
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
