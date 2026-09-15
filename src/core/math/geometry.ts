/**
 * Polygon and segment geometry used by both the editor and the simulation.
 *
 * Everything here is pure and allocation-light; the simulation calls into it
 * inside its inner loops.
 */

import type { Vec2 } from './vec2'
import { cross, distanceSq, dot, sub } from './vec2'

export type Polygon = Vec2[]

export interface Segment {
  a: Vec2
  b: Vec2
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export const EMPTY_BOUNDS: Bounds = {
  minX: Infinity,
  minY: Infinity,
  maxX: -Infinity,
  maxY: -Infinity,
}

export const boundsOf = (points: readonly Vec2[]): Bounds => {
  const b = { ...EMPTY_BOUNDS }
  for (const p of points) {
    if (p.x < b.minX) b.minX = p.x
    if (p.y < b.minY) b.minY = p.y
    if (p.x > b.maxX) b.maxX = p.x
    if (p.y > b.maxY) b.maxY = p.y
  }
  return b
}

export const expandBounds = (b: Bounds, margin: number): Bounds => ({
  minX: b.minX - margin,
  minY: b.minY - margin,
  maxX: b.maxX + margin,
  maxY: b.maxY + margin,
})

export const unionBounds = (a: Bounds, b: Bounds): Bounds => ({
  minX: Math.min(a.minX, b.minX),
  minY: Math.min(a.minY, b.minY),
  maxX: Math.max(a.maxX, b.maxX),
  maxY: Math.max(a.maxY, b.maxY),
})

export const boundsValid = (b: Bounds): boolean => b.maxX >= b.minX && b.maxY >= b.minY

export const boundsContain = (b: Bounds, p: Vec2): boolean =>
  p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY

export const boundsOverlap = (a: Bounds, b: Bounds): boolean =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY

export const boundsCenter = (b: Bounds): Vec2 => ({
  x: (b.minX + b.maxX) / 2,
  y: (b.minY + b.maxY) / 2,
})

/** Signed area; positive for counter-clockwise winding. */
export const signedArea = (poly: readonly Vec2[]): number => {
  let sum = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    sum += (poly[j].x - poly[i].x) * (poly[j].y + poly[i].y)
  }
  return sum / 2
}

export const polygonArea = (poly: readonly Vec2[]): number => Math.abs(signedArea(poly))

export const isCounterClockwise = (poly: readonly Vec2[]): boolean => signedArea(poly) > 0

export const ensureWinding = (poly: Vec2[], counterClockwise: boolean): Vec2[] =>
  isCounterClockwise(poly) === counterClockwise ? poly : [...poly].reverse()

export const polygonCentroid = (poly: readonly Vec2[]): Vec2 => {
  let area = 0
  let cx = 0
  let cy = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j].x * poly[i].y - poly[i].x * poly[j].y
    area += f
    cx += (poly[j].x + poly[i].x) * f
    cy += (poly[j].y + poly[i].y) * f
  }
  if (Math.abs(area) < 1e-12) {
    const b = boundsOf(poly)
    return boundsCenter(b)
  }
  return { x: cx / (3 * area), y: cy / (3 * area) }
}

/** Ray-casting point-in-polygon test. Points exactly on an edge may return either result. */
export const pointInPolygon = (p: Vec2, poly: readonly Vec2[]): boolean => {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]
    const pj = poly[j]
    if (pi.y > p.y !== pj.y > p.y) {
      const t = (p.y - pi.y) / (pj.y - pi.y)
      if (p.x < pi.x + t * (pj.x - pi.x)) inside = !inside
    }
  }
  return inside
}

/** Closest point to `p` on segment `a→b`. */
export const closestPointOnSegment = (p: Vec2, a: Vec2, b: Vec2): Vec2 => {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const lenSq = abx * abx + aby * aby
  if (lenSq < 1e-18) return { x: a.x, y: a.y }
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return { x: a.x + abx * t, y: a.y + aby * t }
}

/** Parameter in [0,1] of the projection of `p` onto segment `a→b`. */
export const projectOnSegment = (p: Vec2, a: Vec2, b: Vec2): number => {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const lenSq = abx * abx + aby * aby
  if (lenSq < 1e-18) return 0
  const t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq
  return t < 0 ? 0 : t > 1 ? 1 : t
}

export const distanceToSegmentSq = (p: Vec2, a: Vec2, b: Vec2): number =>
  distanceSq(p, closestPointOnSegment(p, a, b))

export const distanceToSegment = (p: Vec2, a: Vec2, b: Vec2): number =>
  Math.sqrt(distanceToSegmentSq(p, a, b))

export const distanceToPolygonEdge = (p: Vec2, poly: readonly Vec2[]): number => {
  let best = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const d = distanceToSegmentSq(p, poly[j], poly[i])
    if (d < best) best = d
  }
  return Math.sqrt(best)
}

/** Signed distance: negative inside the polygon, positive outside. */
export const signedDistanceToPolygon = (p: Vec2, poly: readonly Vec2[]): number => {
  const d = distanceToPolygonEdge(p, poly)
  return pointInPolygon(p, poly) ? -d : d
}

const orientation = (a: Vec2, b: Vec2, c: Vec2): number => {
  const v = cross(sub(b, a), sub(c, a))
  return v > 1e-12 ? 1 : v < -1e-12 ? -1 : 0
}

const onSegment = (a: Vec2, b: Vec2, p: Vec2): boolean =>
  Math.min(a.x, b.x) - 1e-12 <= p.x &&
  p.x <= Math.max(a.x, b.x) + 1e-12 &&
  Math.min(a.y, b.y) - 1e-12 <= p.y &&
  p.y <= Math.max(a.y, b.y) + 1e-12

/** Proper or improper intersection of segments `p1→p2` and `p3→p4`. */
export const segmentsIntersect = (p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean => {
  const o1 = orientation(p1, p2, p3)
  const o2 = orientation(p1, p2, p4)
  const o3 = orientation(p3, p4, p1)
  const o4 = orientation(p3, p4, p2)
  if (o1 !== o2 && o3 !== o4) return true
  if (o1 === 0 && onSegment(p1, p2, p3)) return true
  if (o2 === 0 && onSegment(p1, p2, p4)) return true
  if (o3 === 0 && onSegment(p3, p4, p1)) return true
  if (o4 === 0 && onSegment(p3, p4, p2)) return true
  return false
}

export interface RayHit {
  t: number
  point: Vec2
}

/** Intersect ray `origin + dir·t` (t ≥ 0) with segment `a→b`. */
export const raySegmentIntersection = (
  origin: Vec2,
  dir: Vec2,
  a: Vec2,
  b: Vec2,
): RayHit | null => {
  const seg = sub(b, a)
  const denom = cross(dir, seg)
  if (Math.abs(denom) < 1e-12) return null
  const diff = sub(a, origin)
  const t = cross(diff, seg) / denom
  const u = cross(diff, dir) / denom
  if (t < 0 || u < 0 || u > 1) return null
  return { t, point: { x: origin.x + dir.x * t, y: origin.y + dir.y * t } }
}

/** Axis-aligned rectangle as a counter-clockwise polygon. */
export const rectPolygon = (center: Vec2, width: number, depth: number, rotation = 0): Polygon => {
  const hw = width / 2
  const hd = depth / 2
  const c = Math.cos(rotation)
  const s = Math.sin(rotation)
  const corners: Array<[number, number]> = [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ]
  return corners.map(([x, y]) => ({
    x: center.x + x * c - y * s,
    y: center.y + x * s + y * c,
  }))
}

export const circlePolygon = (center: Vec2, radius: number, segments = 16): Polygon => {
  const out: Polygon = []
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2
    out.push({ x: center.x + Math.cos(a) * radius, y: center.y + Math.sin(a) * radius })
  }
  return out
}

export const polygonEdges = (poly: readonly Vec2[]): Segment[] => {
  const edges: Segment[] = []
  for (let i = 0; i < poly.length; i++) {
    edges.push({ a: poly[i], b: poly[(i + 1) % poly.length] })
  }
  return edges
}

export const polylineLength = (points: readonly Vec2[]): number => {
  let total = 0
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  return total
}

/** Point at arc-length `s` along a polyline, clamped to its ends. */
export const pointAlongPolyline = (points: readonly Vec2[], s: number): Vec2 => {
  if (points.length === 0) return { x: 0, y: 0 }
  if (points.length === 1 || s <= 0) return { ...points[0] }
  let remaining = s
  for (let i = 1; i < points.length; i++) {
    const segLen = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
    if (remaining <= segLen || i === points.length - 1) {
      const t = segLen < 1e-9 ? 0 : Math.min(1, remaining / segLen)
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
      }
    }
    remaining -= segLen
  }
  return { ...points[points.length - 1] }
}

/** Sample a polyline every `spacing` metres, starting at its head. */
export const samplePolyline = (points: readonly Vec2[], spacing: number, count?: number): Vec2[] => {
  const total = polylineLength(points)
  const n = count ?? Math.floor(total / spacing) + 1
  const out: Vec2[] = []
  for (let i = 0; i < n; i++) out.push(pointAlongPolyline(points, i * spacing))
  return out
}

/** Direction of travel at arc-length `s` along a polyline. */
export const tangentAlongPolyline = (points: readonly Vec2[], s: number): Vec2 => {
  if (points.length < 2) return { x: 1, y: 0 }
  let remaining = s
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x
    const dy = points[i].y - points[i - 1].y
    const segLen = Math.hypot(dx, dy)
    if (remaining <= segLen || i === points.length - 1) {
      return segLen < 1e-9 ? { x: 1, y: 0 } : { x: dx / segLen, y: dy / segLen }
    }
    remaining -= segLen
  }
  return { x: 1, y: 0 }
}

/** Convex hull (monotone chain), counter-clockwise, without collinear points. */
export const convexHull = (points: readonly Vec2[]): Polygon => {
  if (points.length < 3) return points.map((p) => ({ ...p }))
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const build = (src: Vec2[]): Vec2[] => {
    const stack: Vec2[] = []
    for (const p of src) {
      while (
        stack.length >= 2 &&
        cross(sub(stack[stack.length - 1], stack[stack.length - 2]), sub(p, stack[stack.length - 2])) <= 0
      ) {
        stack.pop()
      }
      stack.push(p)
    }
    stack.pop()
    return stack
  }
  return [...build(sorted), ...build([...sorted].reverse())]
}

/**
 * Offset a convex-ish polygon outward by `d` metres by pushing each vertex along
 * the bisector of its adjacent edge normals. Adequate for the near-rectangular
 * footprints the editor produces; not a general straight-skeleton offset.
 */
export const offsetPolygon = (poly: readonly Vec2[], d: number): Polygon => {
  const n = poly.length
  if (n < 3 || Math.abs(d) < 1e-9) return poly.map((p) => ({ ...p }))
  const ccw = isCounterClockwise(poly)
  const sign = ccw ? 1 : -1
  const out: Polygon = []
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n]
    const cur = poly[i]
    const next = poly[(i + 1) % n]
    const e1 = sub(cur, prev)
    const e2 = sub(next, cur)
    const l1 = Math.hypot(e1.x, e1.y) || 1
    const l2 = Math.hypot(e2.x, e2.y) || 1
    // Outward normals for the given winding.
    const n1 = { x: (e1.y / l1) * sign, y: (-e1.x / l1) * sign }
    const n2 = { x: (e2.y / l2) * sign, y: (-e2.x / l2) * sign }
    let bis = { x: n1.x + n2.x, y: n1.y + n2.y }
    const bl = Math.hypot(bis.x, bis.y)
    if (bl < 1e-9) {
      bis = n2
    } else {
      bis = { x: bis.x / bl, y: bis.y / bl }
    }
    const cosHalf = Math.max(0.25, dot(bis, n2))
    out.push({ x: cur.x + (bis.x * d) / cosHalf, y: cur.y + (bis.y * d) / cosHalf })
  }
  return out
}

/** True when the polygons overlap, using the separating-axis test (convex inputs). */
export const convexPolygonsOverlap = (a: readonly Vec2[], b: readonly Vec2[]): boolean => {
  for (const poly of [a, b]) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const axis = { x: -(poly[i].y - poly[j].y), y: poly[i].x - poly[j].x }
      let minA = Infinity
      let maxA = -Infinity
      let minB = Infinity
      let maxB = -Infinity
      for (const p of a) {
        const v = p.x * axis.x + p.y * axis.y
        if (v < minA) minA = v
        if (v > maxA) maxA = v
      }
      for (const p of b) {
        const v = p.x * axis.x + p.y * axis.y
        if (v < minB) minB = v
        if (v > maxB) maxB = v
      }
      if (maxA < minB || maxB < minA) return false
    }
  }
  return true
}

export const clampToBounds = (p: Vec2, b: Bounds): Vec2 => ({
  x: Math.min(Math.max(p.x, b.minX), b.maxX),
  y: Math.min(Math.max(p.y, b.minY), b.maxY),
})
