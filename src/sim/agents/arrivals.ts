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
      // Homogeneous Poisson process at the rate implied by count and window.
      const rate = window > 0 ? count / window : Infinity
      let t = start
      for (let i = 0; i < count; i++) {
        t += window > 0 ? rng.exponential(rate) : 0
        times.push(t)
      }
      break
    }

    case 'waves': {
      const waves = Math.max(1, Math.round(profile.waves ?? 4))
      const gap = waves > 1 ? window / (waves - 1) : 0
      for (let i = 0; i < count; i++) {
        const wave = Math.floor((i * waves) / count)
        // A little spread inside each wave: a coach does not empty instantly.
        times.push(start + wave * gap + rng.uniform(0, Math.min(45, gap * 0.25 + 10)))
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
