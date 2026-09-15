/**
 * Arrival schedules.
 *
 * Turning "120 people over 20 minutes" into 120 specific arrival times. The
 * shape matters as much as the count: the same headcount arriving uniformly, in
 * five coach-loads, or in a pre-session peak produces completely different
 * queues, and being able to compare those is the point of the product.
 */

import type { ArrivalProfile } from '../../core/model/types'
import type { Rng } from '../../core/math/random'

/** Arrival times in seconds from run start, sorted ascending. */
export const scheduleArrivals = (profile: ArrivalProfile, count: number, rng: Rng): number[] => {
  if (count <= 0) return []
  const start = Math.max(0, profile.startS)
  const window = Math.max(0, profile.windowS)
  const times: number[] = []

  switch (profile.kind) {
    case 'all-at-once':
      for (let i = 0; i < count; i++) times.push(start)
      break

    case 'uniform':
      for (let i = 0; i < count; i++) {
        times.push(start + (window * (i + 0.5)) / count)
      }
      break

    case 'poisson': {
      // A homogeneous Poisson process, conditioned on delivering exactly `count`
      // arrivals inside the window — which is what the setting promises.
      //
      // Summing `count` exponential gaps is the unconditioned process, and its
      // last arrival lands after the window about half the time, because the
      // total is a random sum whose mean is the window itself. "600 people over
      // 20 minutes" then quietly delivered some of them late, anybody past the
      // scenario duration never entered the venue at all, and the profile
      // disagreed with every bounded one about what `windowS` meant — so a
      // comparison against a uniform baseline was short of people.
      //
      // Given that a homogeneous process produced exactly `count` events in the
      // window, those events are distributed as the order statistics of `count`
      // uniform draws on it. So this is the same process, with none of the
      // clustering smoothed away, and it ends when the window does.
      for (let i = 0; i < count; i++) {
        times.push(start + (window > 0 ? rng.next() * window : 0))
      }
      break
    }

    case 'waves': {
      const waves = Math.max(1, Math.round(profile.waves ?? 4))
      const gap = waves > 1 ? window / (waves - 1) : 0
      // A coach does not empty instantly. Capped by the window as well as by
      // 45 s, so that a zero-length window is everybody at once here as it is
      // in every other profile — it used to spread them over 10 s regardless,
      // which made "waves" the one profile where at once was not at once.
      //
      // The last wave lands on the end of the window and then unloads, so a
      // wave schedule can still run up to `unload` past it. That is deliberate:
      // the coach arriving on time is what the window describes, and the people
      // getting off it afterwards are real.
      const unload = Math.min(45, window, gap * 0.25 + 10)
      for (let i = 0; i < count; i++) {
        const wave = Math.floor((i * waves) / count)
        times.push(start + wave * gap + rng.uniform(0, unload))
      }
      break
    }

    case 'front-loaded':
      for (let i = 0; i < count; i++) {
        times.push(start + window * Math.pow(rng.next(), 2.2))
      }
      break

    case 'peak': {
      const peakAt = Math.min(1, Math.max(0, profile.peakAt ?? 0.5))
      const spread = Math.max(0.02, profile.spread ?? 0.18)
      for (let i = 0; i < count; i++) {
        times.push(start + window * rng.truncatedNormal(peakAt, spread, 0, 1))
      }
      break
    }
  }

  return times.sort((a, b) => a - b)
}

/** Split a headcount into groups of the requested size. */
export const splitIntoGroups = (
  count: number,
  groupSize: { min: number; max: number } | undefined,
  rng: Rng,
): number[] => {
  if (!groupSize || groupSize.max <= 1) return Array.from({ length: count }, () => 1)
  const min = Math.max(1, Math.round(groupSize.min))
  const max = Math.max(min, Math.round(groupSize.max))
  const groups: number[] = []
  let remaining = count
  while (remaining > 0) {
    const size = Math.min(remaining, rng.int(min, max))
    groups.push(size)
    remaining -= size
  }
  return groups
}
