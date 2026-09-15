import { describe, expect, it } from 'vitest'
import type { Vec2 } from './vec2'
import {
  add,
  addScaled,
  angleDelta,
  angleOf,
  clampLength,
  clone,
  cross,
  distance,
  distanceSq,
  dot,
  equals,
  fromAngle,
  length,
  lengthSq,
  lerp,
  negate,
  normalize,
  perp,
  rotate,
  scale,
  sub,
  vec2,
} from './vec2'

const v = (x: number, y: number): Vec2 => ({ x, y })

describe('vector arithmetic', () => {
  it('reaches an origin from a corner and back again', () => {
    const a = v(3, -4)
    const b = v(-1, 2)
    expect(add(a, b)).toEqual({ x: 2, y: -2 })
    expect(sub(a, b)).toEqual({ x: 4, y: -6 })
    expect(scale(a, -0.5)).toEqual({ x: -1.5, y: 2 })
    expect(negate(a)).toEqual({ x: -3, y: 4 })
    expect(add(sub(a, b), b)).toEqual(a)
  })

  it('steps a distance along a direction in one call', () => {
    const position = v(2, 2)
    const heading = v(0.6, 0.8)
    expect(addScaled(position, heading, 5)).toEqual(add(position, scale(heading, 5)))
    expect(addScaled(position, heading, 0)).toEqual(position)
  })

  it('never writes back into the vectors it was handed', () => {
    // Plan vectors live in the immutable document; an in-place update here
    // would edit a wall the user never touched and slip past undo.
    const a = v(1, 2)
    const b = v(3, 4)
    for (const result of [
      add(a, b),
      sub(a, b),
      scale(a, 3),
      addScaled(a, b, 2),
      lerp(a, b, 0.5),
      rotate(a, 1),
      normalize(a),
      perp(a),
      negate(a),
      clone(a),
      clampLength(a, 0.1),
    ]) {
      expect(result).not.toBe(a)
      expect(result).not.toBe(b)
    }
    expect(a).toEqual({ x: 1, y: 2 })
    expect(b).toEqual({ x: 3, y: 4 })
  })

  it('starts a fresh vector at the origin', () => {
    expect(vec2()).toEqual({ x: 0, y: 0 })
    expect(vec2(1.5)).toEqual({ x: 1.5, y: 0 })
  })

  it('reads a projection through the dot product and a turn through the cross', () => {
    expect(dot(v(3, 4), v(3, 4))).toBe(25)
    expect(dot(v(1, 0), v(0, 1))).toBe(0)
    expect(dot(v(1, 0), v(-2, 0))).toBe(-2)
    // Positive cross means `b` is counter-clockwise of `a`: it is the sign that
    // decides which side of a wall somebody is standing on.
    expect(cross(v(1, 0), v(0, 1))).toBe(1)
    expect(cross(v(0, 1), v(1, 0))).toBe(-1)
    expect(cross(v(2, 2), v(4, 4))).toBe(0)
  })
})

describe('length and direction', () => {
  it('measures the same length squared or not', () => {
    expect(length(v(3, 4))).toBe(5)
    expect(lengthSq(v(3, 4))).toBe(25)
    expect(distance(v(1, 1), v(4, 5))).toBe(5)
    expect(distanceSq(v(1, 1), v(4, 5))).toBe(25)
    expect(distanceSq(v(7, 7), v(7, 7))).toBe(0)
  })

  it('normalises a vector far too long to square', () => {
    // `length` and `distance` go through Math.hypot for this reason; swapping
    // in a sqrt of the squared length would hand back NaN here instead.
    expect(lengthSq(v(1e200, 0))).toBe(Infinity)
    expect(length(v(1e200, 0))).toBe(1e200)
    expect(normalize(v(1e200, 0))).toEqual({ x: 1, y: 0 })
  })

  it('hands back no direction at all rather than NaN for a vector of no length', () => {
    // A NaN direction becomes a NaN position on the next step and the person is
    // lost from the simulation for good, so the zero case has to be silent.
    expect(normalize(v(0, 0))).toEqual({ x: 0, y: 0 })
    expect(normalize(v(1e-13, 0))).toEqual({ x: 0, y: 0 })
    expect(normalize(v(1e-11, 0))).toEqual({ x: 1, y: 0 })
  })

  it('normalises to unit length in whichever quadrant the vector points', () => {
    for (const a of [v(3, 4), v(-3, 4), v(3, -4), v(-0.001, -0.001)]) {
      const unit = normalize(a)
      expect(length(unit)).toBeCloseTo(1, 12)
      expect(cross(a, unit)).toBeCloseTo(0, 12)
      expect(dot(a, unit)).toBeGreaterThan(0)
    }
  })

  it('caps a step at the distance allowed and leaves a shorter one alone', () => {
    expect(clampLength(v(3, 4), 2.5)).toEqual({ x: 1.5, y: 2 })
    expect(clampLength(v(3, 4), 5)).toEqual({ x: 3, y: 4 })
    expect(clampLength(v(3, 4), 99)).toEqual({ x: 3, y: 4 })
    // A stopped walker must survive a zero cap without picking up a direction.
    expect(clampLength(v(3, 4), 0)).toEqual({ x: 0, y: 0 })
    expect(clampLength(v(0, 0), 5)).toEqual({ x: 0, y: 0 })
  })

  // SUSPECTED BUG: `clampLength` documents that it preserves direction, but a
  // negative cap reverses it — a walker handed a negative speed limit turns
  // round and walks backwards at that speed instead of stopping. A negative
  // `max` should clamp to zero, as `max === 0` already does.
  it('turns a vector round when the cap is negative', () => {
    expect(clampLength(v(3, 0), -2).x).toBe(-2)
    expect(dot(clampLength(v(3, 0), -2), v(3, 0))).toBeLessThan(0)
    // Anything already shorter than the magnitude of the cap slips through whole.
    expect(clampLength(v(1, 0), -2)).toEqual({ x: 1, y: 0 })
  })
})

describe('angles', () => {
  it('reads a heading back out of the direction it built', () => {
    for (const radians of [0, 0.75, Math.PI / 2, 2.5, -2.5, Math.PI - 1e-6]) {
      const d = fromAngle(radians, 3)
      expect(length(d)).toBeCloseTo(3, 12)
      expect(angleOf(d)).toBeCloseTo(radians, 12)
    }
    expect(fromAngle(0)).toEqual({ x: 1, y: 0 })
  })

  it('points a negative radius the opposite way', () => {
    expect(fromAngle(0, -3).x).toBe(-3)
    expect(fromAngle(0, -3).y).toBeCloseTo(0, 12)
    expect(angleOf(fromAngle(0.4, -2))).toBeCloseTo(0.4 - Math.PI, 12)
  })

  it('faces along +x rather than nowhere when there is no direction to read', () => {
    // Somebody standing still still has to be drawn facing somewhere.
    expect(angleOf(v(0, 0))).toBe(0)
  })

  it('turns a quarter circle the same way whether you rotate or take the perpendicular', () => {
    const a = v(3, 1)
    const turned = rotate(a, Math.PI / 2)
    expect(perp(a)).toEqual({ x: -1, y: 3 })
    expect(turned.x).toBeCloseTo(-1, 12)
    expect(turned.y).toBeCloseTo(3, 12)
    expect(cross(a, perp(a))).toBeGreaterThan(0)
  })

  it('comes back to where it started after a full turn', () => {
    const back = rotate(v(1, 0), Math.PI * 2)
    expect(back.x).toBeCloseTo(1, 12)
    expect(back.y).toBeCloseTo(0, 12)
    const twice = rotate(rotate(v(2, -1), 0.7), -0.7)
    expect(twice.x).toBeCloseTo(2, 12)
    expect(twice.y).toBeCloseTo(-1, 12)
  })

  it('takes the short way round the back of the compass', () => {
    // Someone facing 179° who wants to face -179° turns two degrees, not 358.
    expect(angleDelta(3.1, -3.1)).toBeCloseTo(0.0831853, 6)
    expect(angleDelta(-3.1, 3.1)).toBeCloseTo(-0.0831853, 6)
    expect(angleDelta(0.5, 0.75)).toBeCloseTo(0.25, 12)
    expect(angleDelta(0, Math.PI * 2)).toBeCloseTo(0, 12)
    expect(Math.abs(angleDelta(0, 7 * Math.PI))).toBeLessThanOrEqual(Math.PI)
  })

  it('lands on +π rather than -π at the exact half turn', () => {
    // The range is (-π, π]; letting both ends through would make a turn of
    // exactly 180° flip sign from frame to frame and jitter the facing.
    expect(angleDelta(0, Math.PI)).toBeCloseTo(Math.PI, 12)
    expect(angleDelta(0, -Math.PI)).toBeCloseTo(Math.PI, 12)
    expect(angleDelta(0, -3 * Math.PI)).toBeCloseTo(Math.PI, 12)
  })
})

describe('interpolation and equality', () => {
  it('slides between two points and keeps going past them', () => {
    const a = v(0, 0)
    const b = v(10, -4)
    expect(lerp(a, b, 0)).toEqual({ x: 0, y: 0 })
    expect(lerp(a, b, 1)).toEqual({ x: 10, y: -4 })
    expect(lerp(a, b, 0.25)).toEqual({ x: 2.5, y: -1 })
    // Not clamped: callers that need a segment have to clamp `t` themselves.
    expect(lerp(a, b, 1.5)).toEqual({ x: 15, y: -6 })
    expect(lerp(a, b, -1)).toEqual({ x: -10, y: 4 })
  })

  it('treats two points a nanometre apart as the same point', () => {
    // Snapping and room detection both round to millimetres; a comparison
    // tighter than float noise would tear a closed loop of walls open.
    expect(equals(v(1, 1), v(1 + 1e-10, 1))).toBe(true)
    expect(equals(v(1, 1), v(1 + 1e-7, 1))).toBe(false)
    expect(equals(v(1, 1), v(1.0005, 1), 1e-3)).toBe(true)
    expect(equals(v(1, 1), v(1 + 1e-12, 1), 0)).toBe(false)
    expect(equals(v(1, 1), v(1, 1), 0)).toBe(true)
  })

  it('copies a point instead of sharing it', () => {
    const a = v(4, 5)
    const copy = clone(a)
    expect(copy).toEqual(a)
    expect(copy).not.toBe(a)
  })
})
