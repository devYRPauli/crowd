/**
 * Two-dimensional vector helpers.
 *
 * The plan is authored in metres on the XZ ground plane; `y` here is the world
 * Z axis. Vectors are plain objects so they serialise directly into the scene
 * document and cross the worker boundary without adapters.
 */

export interface Vec2 {
  x: number
  y: number
}

export const vec2 = (x = 0, y = 0): Vec2 => ({ x, y })

export const clone = (a: Vec2): Vec2 => ({ x: a.x, y: a.y })

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y })

export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })

export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k })

export const addScaled = (a: Vec2, b: Vec2, k: number): Vec2 => ({
  x: a.x + b.x * k,
  y: a.y + b.y * k,
})

export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y

/** Z component of the 3D cross product; positive when `b` is counter-clockwise of `a`. */
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x

export const lengthSq = (a: Vec2): number => a.x * a.x + a.y * a.y

export const length = (a: Vec2): number => Math.hypot(a.x, a.y)

export const distanceSq = (a: Vec2, b: Vec2): number => {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y)

export const normalize = (a: Vec2): Vec2 => {
  const len = Math.hypot(a.x, a.y)
  return len > 1e-12 ? { x: a.x / len, y: a.y / len } : { x: 0, y: 0 }
}

/** Rotate 90° counter-clockwise. */
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x })

export const negate = (a: Vec2): Vec2 => ({ x: -a.x, y: -a.y })

export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
})

export const rotate = (a: Vec2, radians: number): Vec2 => {
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c }
}

export const fromAngle = (radians: number, radius = 1): Vec2 => ({
  x: Math.cos(radians) * radius,
  y: Math.sin(radians) * radius,
})

export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x)

export const equals = (a: Vec2, b: Vec2, epsilon = 1e-9): boolean =>
  Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon

/** Shorten `a` to at most `max` metres, preserving direction. */
export const clampLength = (a: Vec2, max: number): Vec2 => {
  const lenSq = a.x * a.x + a.y * a.y
  if (lenSq <= max * max || lenSq < 1e-24) return { x: a.x, y: a.y }
  const k = max / Math.sqrt(lenSq)
  return { x: a.x * k, y: a.y * k }
}

/** Smallest signed rotation from `from` to `to`, in (-π, π]. */
export const angleDelta = (from: number, to: number): number => {
  let d = (to - from) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d <= -Math.PI) d += Math.PI * 2
  return d
}
