import { describe, expect, it } from 'vitest'
import type { Bounds, Polygon } from './geometry'
import {
  EMPTY_BOUNDS,
  boundsCenter,
  boundsContain,
  boundsOf,
  boundsOverlap,
  boundsValid,
  circlePolygon,
  clampToBounds,
  closestPointOnPolyline,
  closestPointOnSegment,
  convexHull,
  convexPolygonsOverlap,
  distanceToPolygonEdge,
  distanceToSegment,
  distanceToSegmentSq,
  ensureWinding,
  expandBounds,
  isCounterClockwise,
  offsetPolygon,
  pointAlongPolyline,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  polygonEdges,
  polylineLength,
  projectOnSegment,
  raySegmentIntersection,
  rectPolygon,
  samplePolyline,
  segmentsIntersect,
  signedArea,
  signedDistanceToPolygon,
  tangentAlongPolyline,
  unionBounds,
} from './geometry'
import type { Vec2 } from './vec2'
import { cross, sub } from './vec2'

const p = (x: number, y: number): Vec2 => ({ x, y })

const poly = (...pairs: Array<[number, number]>): Polygon => pairs.map(([x, y]) => p(x, y))

const expectPoint = (actual: Vec2, x: number, y: number, digits = 9): void => {
  expect(actual.x).toBeCloseTo(x, digits)
  expect(actual.y).toBeCloseTo(y, digits)
}

const expectPolygon = (actual: readonly Vec2[], expected: Array<[number, number]>): void => {
  expect(actual).toHaveLength(expected.length)
  actual.forEach((v, i) => expectPoint(v, expected[i][0], expected[i][1]))
}

/** A 4 m × 4 m room at the origin, wound counter-clockwise. */
const ROOM = poly([0, 0], [4, 0], [4, 4], [0, 4])
const ROOM_CW = [...ROOM].reverse()

/** A room with a bite out of its top-left: 4×2 along the bottom plus a 2×2 tower. */
const L_ROOM = poly([0, 0], [4, 0], [4, 4], [2, 4], [2, 2], [0, 2])

/** Two walls crossing themselves — the shape a careless polygon tool produces. */
const BOWTIE = poly([0, 0], [4, 0], [0, 4], [4, 4])

describe('bounds', () => {
  it('grows to hold every point it is shown', () => {
    const b = boundsOf([p(2, -3), p(-1, 5), p(7, 0)])
    expect(b).toEqual({ minX: -1, minY: -3, maxX: 7, maxY: 5 })
    expect(boundsCenter(b)).toEqual({ x: 3, y: 1 })
    // A single point is a valid, zero-sized box, not an empty one.
    expect(boundsOf([p(2, 3)])).toEqual({ minX: 2, minY: 3, maxX: 2, maxY: 3 })
    expect(boundsValid(boundsOf([p(2, 3)]))).toBe(true)
  })

  it('reports an empty plan as having no extent at all', () => {
    expect(boundsOf([])).toEqual(EMPTY_BOUNDS)
    expect(boundsValid(boundsOf([]))).toBe(false)
    // EMPTY_BOUNDS is a shared object that `boundsOf` starts from a copy of.
    // Accumulating into it rather than into the copy would poison the extent of
    // every plan opened afterwards, so measure a real one and check it survived.
    expect(boundsOf([p(-9, -2), p(9, 2)])).toEqual({ minX: -9, minY: -2, maxX: 9, maxY: 2 })
    expect(EMPTY_BOUNDS).toEqual({
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
    })
    // Nothing overlaps an empty extent, which is what stops a broad-phase pass
    // over a plan with no geometry in it reporting a hit on everything.
    expect(boundsOverlap(EMPTY_BOUNDS, { minX: 0, minY: 0, maxX: 1, maxY: 1 })).toBe(false)
  })

  it('unions the empty box as if it were not there', () => {
    const b: Bounds = { minX: 1, minY: 2, maxX: 3, maxY: 4 }
    expect(unionBounds(EMPTY_BOUNDS, b)).toEqual(b)
    expect(unionBounds(b, { minX: -5, minY: 3, maxX: 0, maxY: 9 })).toEqual({
      minX: -5,
      minY: 2,
      maxX: 3,
      maxY: 9,
    })
  })

  it('counts the edge of a box as part of it', () => {
    // Bounds are the cheap first pass for picking and for broad-phase overlap.
    // Excluding the boundary makes a wall you cannot click on its own outline.
    const b: Bounds = { minX: 0, minY: 0, maxX: 2, maxY: 2 }
    expect(boundsContain(b, p(0, 0))).toBe(true)
    expect(boundsContain(b, p(2, 1))).toBe(true)
    expect(boundsContain(b, p(2.0001, 1))).toBe(false)
    expect(boundsOverlap(b, { minX: 2, minY: 2, maxX: 3, maxY: 3 })).toBe(true)
    expect(boundsOverlap(b, { minX: 2.0001, minY: 0, maxX: 3, maxY: 3 })).toBe(false)
  })

  it('turns inside-out when shrunk past nothing, and says so', () => {
    const b: Bounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 }
    expect(expandBounds(b, 0.5)).toEqual({ minX: -0.5, minY: -0.5, maxX: 1.5, maxY: 1.5 })
    const overshrunk = expandBounds(b, -2)
    expect(overshrunk).toEqual({ minX: 2, minY: 2, maxX: -1, maxY: -1 })
    // The caller has to check: an inverted box contains nothing and overlaps
    // nothing, which is the honest answer, but boundsValid is how you find out.
    expect(boundsValid(overshrunk)).toBe(false)
    expect(boundsContain(overshrunk, p(0.5, 0.5))).toBe(false)
  })

  it('pulls a stray point back inside the box', () => {
    const b: Bounds = { minX: 0, minY: 0, maxX: 10, maxY: 5 }
    expect(clampToBounds(p(-3, 99), b)).toEqual({ x: 0, y: 5 })
    expect(clampToBounds(p(4, 2), b)).toEqual({ x: 4, y: 2 })
    // An inverted box collapses everything onto its max corner.
    expect(clampToBounds(p(5, 5), { minX: 2, minY: 2, maxX: 0, maxY: 0 })).toEqual({ x: 0, y: 0 })
  })
})

describe('polygon area and winding', () => {
  it('reads counter-clockwise as positive and clockwise as negative, same floor either way', () => {
    expect(signedArea(ROOM)).toBe(16)
    expect(signedArea(ROOM_CW)).toBe(-16)
    expect(polygonArea(ROOM)).toBe(16)
    expect(polygonArea(ROOM_CW)).toBe(16)
    expect(isCounterClockwise(ROOM)).toBe(true)
    expect(isCounterClockwise(ROOM_CW)).toBe(false)
    expect(signedArea(poly([0, 0], [4, 0], [0, 3]))).toBe(6)
    expect(signedArea(L_ROOM)).toBe(12)
  })

  it('keeps the interior of a counter-clockwise polygon on the left of every edge', () => {
    // This is the whole content of the sign convention: anything that derives a
    // direction from winding — an outward normal, a wall face, an offset — reads
    // it this way, so the sign and the geometry must not drift apart.
    const inside = polygonCentroid(L_ROOM)
    for (const edge of polygonEdges(L_ROOM)) {
      expect(cross(sub(edge.b, edge.a), sub(inside, edge.a))).toBeGreaterThan(0)
    }
    for (const edge of polygonEdges([...L_ROOM].reverse())) {
      expect(cross(sub(edge.b, edge.a), sub(inside, edge.a))).toBeLessThan(0)
    }
  })

  it('reports no floor at all for a room whose own walls cross', () => {
    // The two lobes wind opposite ways and cancel. Occupancy is people per
    // square metre, so a zero-area room reads as infinitely crowded or as
    // holding nobody, depending on which way the division falls.
    expect(signedArea(BOWTIE)).toBe(0)
    expect(polygonArea(BOWTIE)).toBe(0)
    expect(signedArea([...BOWTIE].reverse())).toBe(0)
  })

  it('gives a polygon too small to enclose anything zero area', () => {
    expect(signedArea([])).toBe(0)
    expect(signedArea([p(3, 3)])).toBe(0)
    expect(signedArea(poly([0, 0], [4, 0]))).toBe(0)
    expect(polygonArea(poly([0, 0], [1, 0], [2, 0]))).toBe(0)
  })

  it('hands back the very same polygon when the winding already matches', () => {
    // The renderer diffs by array identity; rewinding a polygon that was
    // already correct would rebuild its mesh on every recompute.
    expect(ensureWinding(ROOM, true)).toBe(ROOM)
    expect(ensureWinding(ROOM_CW, false)).toBe(ROOM_CW)
    const flipped = ensureWinding(ROOM_CW, true)
    expect(flipped).not.toBe(ROOM_CW)
    expect(isCounterClockwise(flipped)).toBe(true)
    expectPolygon(flipped, [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ])
    // Reversing in place would rewind the polygon the caller still holds — for a
    // plan that is a document array the renderer and the engine both read.
    expectPolygon(ROOM_CW, [
      [0, 4],
      [4, 4],
      [4, 0],
      [0, 0],
    ])
  })

  it('hands a collapsed polygon straight back rather than flipping it forever', () => {
    // A zone drawn as three collinear clicks has no winding to report, so asking
    // for counter-clockwise used to reverse it every time and never settle. Put
    // that through a rebuild and the polygon is a new array on every pass, which
    // is what the identity diff behind structural sharing reads as a change.
    const flat = poly([0, 0], [1, 0], [2, 0])
    expect(ensureWinding(flat, true)).toBe(flat)
    expect(ensureWinding(flat, false)).toBe(flat)
    // The rule is "no area to wind", not "collinear": a bow tie's lobes cancel.
    expect(ensureWinding(BOWTIE, true)).toBe(BOWTIE)
    const single = poly([3, 3])
    expect(ensureWinding(single, true)).toBe(single)
  })
})

describe('polygon centroid', () => {
  it('puts the centre of a room where its floor actually is', () => {
    // A zone label and the point the simulation aims people at both come from
    // here; the middle of the bounding box would sit in the missing corner.
    expectPoint(polygonCentroid(L_ROOM), 7 / 3, 5 / 3)
    expect(boundsCenter(boundsOf(L_ROOM))).toEqual({ x: 2, y: 2 })
    expectPoint(polygonCentroid(ROOM), 2, 2)
    expectPoint(polygonCentroid(ROOM_CW), 2, 2)
  })

  it('falls back to the middle of the bounding box when there is no area to weigh', () => {
    expectPoint(polygonCentroid(BOWTIE), 2, 2)
    expectPoint(polygonCentroid(poly([0, 0], [1, 0], [2, 0])), 1, 0)
    expectPoint(polygonCentroid([p(3, 7)]), 3, 7)
    expectPoint(polygonCentroid(poly([0, 0], [4, 2])), 2, 1)
  })

  it('puts the centre of a polygon with no points at the origin', () => {
    // The zero-area fallback goes through the bounding box, and the box of
    // nothing is inside out, so this used to come back NaN. A NaN centre is a
    // NaN destination: the agent sent to one never arrives and never shows up in
    // the results. The origin is what the rest of this module answers for
    // geometry that is not there.
    expect(polygonCentroid([])).toEqual({ x: 0, y: 0 })
  })
})

describe('point in polygon', () => {
  it('gives the same answer whichever way round the room was drawn', () => {
    for (const q of [p(2, 2), p(0.001, 0.001), p(-1, 2), p(2, 9), p(3.999, 3.999)]) {
      expect(pointInPolygon(q, ROOM)).toBe(pointInPolygon(q, ROOM_CW))
    }
    expect(pointInPolygon(p(2, 2), ROOM)).toBe(true)
    expect(pointInPolygon(p(-1, 2), ROOM)).toBe(false)
  })

  it('claims somebody standing on a shared wall for exactly one of the rooms', () => {
    // The source says a point exactly on an edge may come back either way, so
    // the half-open rule below — bottom and left in, top and right out — is
    // characterisation. What a plan depends on is the consequence: two rooms
    // sharing a wall claim a person on it once between them, never twice and
    // never neither, in whichever direction the wall runs.
    expect(pointInPolygon(p(2, 0), ROOM)).toBe(true)
    expect(pointInPolygon(p(0, 2), ROOM)).toBe(true)
    expect(pointInPolygon(p(2, 4), ROOM)).toBe(false)
    expect(pointInPolygon(p(4, 2), ROOM)).toBe(false)

    const above = poly([0, 4], [4, 4], [4, 8], [0, 8])
    const beside = poly([4, 0], [8, 0], [8, 4], [4, 4])
    for (const t of [0.5, 2, 3.5]) {
      const onTheHorizontalWall = [pointInPolygon(p(t, 4), ROOM), pointInPolygon(p(t, 4), above)]
      expect(onTheHorizontalWall.filter(Boolean)).toHaveLength(1)
      const onTheVerticalWall = [pointInPolygon(p(4, t), ROOM), pointInPolygon(p(4, t), beside)]
      expect(onTheVerticalWall.filter(Boolean)).toHaveLength(1)
    }
  })

  it('claims a corner exactly once too', () => {
    expect(pointInPolygon(p(0, 0), ROOM)).toBe(true)
    expect(pointInPolygon(p(4, 0), ROOM)).toBe(false)
    expect(pointInPolygon(p(4, 4), ROOM)).toBe(false)
    expect(pointInPolygon(p(0, 4), ROOM)).toBe(false)
  })

  it('lets people stand in both lobes of a self-crossing room that measures zero', () => {
    // Even-odd counts both triangles as interior while the signed areas cancel,
    // so a plan can hold a crowd in a room the inspector says has no floor.
    expect(pointInPolygon(p(2, 1), BOWTIE)).toBe(true)
    expect(pointInPolygon(p(2, 3), BOWTIE)).toBe(true)
    expect(pointInPolygon(p(1, 2), BOWTIE)).toBe(false)
    expect(pointInPolygon(p(3, 2), BOWTIE)).toBe(false)
    expect(pointInPolygon(p(2, 2), BOWTIE)).toBe(false)
    expect(polygonArea(BOWTIE)).toBe(0)
  })

  it('ignores a repeated vertex', () => {
    // Snapping a drag back onto the previous point leaves a zero-length edge in
    // the polygon; it must not toggle the ray crossing count.
    const doubled = poly([0, 0], [4, 0], [4, 0], [4, 4], [0, 4])
    expect(pointInPolygon(p(2, 2), doubled)).toBe(true)
    expect(pointInPolygon(p(5, 2), doubled)).toBe(false)
    expect(polygonArea(doubled)).toBe(16)
  })

  it('finds nobody inside a polygon with no inside', () => {
    expect(pointInPolygon(p(1, 1), [])).toBe(false)
    expect(pointInPolygon(p(1, 1), [p(1, 1)])).toBe(false)
    expect(pointInPolygon(p(1, 1), circlePolygon(p(1, 1), 0, 16))).toBe(false)
  })
})

describe('distance to segments and polygons', () => {
  it('measures to the nearest point on the segment and no further along it', () => {
    const a = p(0, 0)
    const b = p(4, 0)
    expectPoint(closestPointOnSegment(p(1, 3), a, b), 1, 0)
    expectPoint(closestPointOnSegment(p(-5, 3), a, b), 0, 0)
    expectPoint(closestPointOnSegment(p(9, -3), a, b), 4, 0)
    expect(projectOnSegment(p(1, 3), a, b)).toBeCloseTo(0.25, 12)
    expect(projectOnSegment(p(-5, 0), a, b)).toBe(0)
    expect(projectOnSegment(p(50, 0), a, b)).toBe(1)
    expect(distanceToSegment(p(1, 3), a, b)).toBeCloseTo(3, 12)
    expect(distanceToSegmentSq(p(1, 3), a, b)).toBeCloseTo(9, 12)
    expect(distanceToSegment(p(-4, 0), a, b)).toBeCloseTo(4, 12)
  })

  it('treats a wall dragged onto itself as the point it sits on', () => {
    // A wall whose ends coincide is reachable from a single click-and-release;
    // dividing by its length would NaN the snap and the avoidance step alike.
    const a = p(1, 1)
    expectPoint(closestPointOnSegment(p(9, -3), a, p(1, 1)), 1, 1)
    expect(projectOnSegment(p(9, -3), a, p(1, 1))).toBe(0)
    expect(distanceToSegment(p(4, 5), a, p(1, 1))).toBeCloseTo(5, 12)
  })

  it('returns a fresh point rather than one of the endpoints it was given', () => {
    // Callers move the returned point around (snap offsets, avoidance pushes);
    // aliasing an endpoint would edit the wall it came from.
    const a = p(1, 1)
    const b = p(5, 1)
    expect(closestPointOnSegment(p(-9, 1), a, b)).not.toBe(a)
    expect(closestPointOnSegment(p(99, 1), a, b)).not.toBe(b)
    expect(closestPointOnSegment(p(0, 0), a, a)).not.toBe(a)
  })

  it('reports clearance to the nearest wall from either side', () => {
    expect(distanceToPolygonEdge(p(2, 2), ROOM)).toBeCloseTo(2, 12)
    expect(distanceToPolygonEdge(p(0.25, 2), ROOM)).toBeCloseTo(0.25, 12)
    expect(distanceToPolygonEdge(p(0, 0), ROOM)).toBeCloseTo(0, 12)
    expect(distanceToPolygonEdge(p(-3, -4), ROOM)).toBeCloseTo(5, 12)
    // The sign is what turns a clearance into "inside the table" or "beside it".
    expect(signedDistanceToPolygon(p(0.25, 2), ROOM)).toBeCloseTo(-0.25, 12)
    expect(signedDistanceToPolygon(p(-3, -4), ROOM)).toBeCloseTo(5, 12)
    expect(signedDistanceToPolygon(p(2, 4), ROOM)).toBeCloseTo(0, 12)
    expect(distanceToPolygonEdge(p(2, 2), [])).toBe(Infinity)
    expect(signedDistanceToPolygon(p(2, 2), [])).toBe(Infinity)
  })
})

describe('segment intersection', () => {
  it('sees walls that cross, that tee into each other, and that meet at a tip', () => {
    // Room detection splits walls wherever they touch; a missed touch leaves
    // the face open and the room it should have closed disappears.
    expect(segmentsIntersect(p(0, 0), p(2, 2), p(0, 2), p(2, 0))).toBe(true)
    expect(segmentsIntersect(p(0, 0), p(2, 0), p(1, 0), p(1, 1))).toBe(true)
    expect(segmentsIntersect(p(0, 0), p(2, 0), p(2, 0), p(2, 2))).toBe(true)
    expect(segmentsIntersect(p(0, 0), p(2, 0), p(0, 1), p(2, 1))).toBe(false)
    expect(segmentsIntersect(p(0, 0), p(2, 0), p(3, -1), p(3, 1))).toBe(false)
  })

  it('sees collinear walls that overlap but not ones that merely line up', () => {
    expect(segmentsIntersect(p(0, 0), p(2, 0), p(1, 0), p(3, 0))).toBe(true)
    expect(segmentsIntersect(p(0, 0), p(2, 0), p(2, 0), p(4, 0))).toBe(true)
    expect(segmentsIntersect(p(0, 0), p(4, 0), p(1, 0), p(2, 0))).toBe(true)
    expect(segmentsIntersect(p(0, 0), p(1, 0), p(2, 0), p(3, 0))).toBe(false)
  })

  it('sees a point that lies on a wall and not one beside it', () => {
    // A zero-length segment is how a degenerate wall or a bare click arrives.
    expect(segmentsIntersect(p(1, 1), p(1, 1), p(0, 0), p(2, 2))).toBe(true)
    expect(segmentsIntersect(p(1, 0), p(1, 0), p(0, 0), p(2, 2))).toBe(false)
    expect(segmentsIntersect(p(1, 1), p(1, 1), p(1, 1), p(1, 1))).toBe(true)
    expect(segmentsIntersect(p(0, 0), p(0, 0), p(1, 1), p(1, 1))).toBe(false)
  })
})

describe('ray casting', () => {
  it('reports the hit in multiples of the direction vector, not in metres', () => {
    // Callers pass an unnormalised direction to ask "does anything block me
    // between here and there?" and compare t against 1. Normalising inside
    // would silently change what that comparison means.
    const unit = raySegmentIntersection(p(0, 0), p(1, 0), p(3, -1), p(3, 1))
    expect(unit?.t).toBeCloseTo(3, 12)
    expect(unit?.point.x).toBeCloseTo(3, 12)
    expect(unit?.point.y).toBeCloseTo(0, 12)
    const doubled = raySegmentIntersection(p(0, 0), p(2, 0), p(3, -1), p(3, 1))
    expect(doubled?.t).toBeCloseTo(1.5, 12)
    expect(doubled?.point.x).toBeCloseTo(3, 12)
    expect(doubled?.point.y).toBeCloseTo(0, 12)
  })

  it('ignores what is behind the origin and stops at the far end of the wall', () => {
    expect(raySegmentIntersection(p(0, 0), p(-1, 0), p(3, -1), p(3, 1))).toBeNull()
    expect(raySegmentIntersection(p(3, 0), p(1, 0), p(3, -1), p(3, 1))?.t).toBe(0)
    // The wall's own endpoint still blocks: u = 1 is inside the segment.
    expect(raySegmentIntersection(p(0, 0), p(1, 0), p(3, -2), p(3, 0))?.t).toBeCloseTo(3, 12)
    expect(raySegmentIntersection(p(0, 0), p(1, 0), p(3, -2), p(3, -1e-9))).toBeNull()
  })

  it('misses a wall it runs exactly along, and anything with no length', () => {
    // A sight line grazing a wall face reports clear. That is the right answer
    // for visibility — you can see along a wall — but it means a caller cannot
    // use this to detect a ray sliding inside a collinear obstacle.
    expect(raySegmentIntersection(p(0, 0), p(1, 0), p(1, 0), p(5, 0))).toBeNull()
    expect(raySegmentIntersection(p(0, 0), p(1, 0), p(1, 1), p(5, 1))).toBeNull()
    expect(raySegmentIntersection(p(0, 0), p(0, 0), p(1, -1), p(1, 1))).toBeNull()
    expect(raySegmentIntersection(p(0, 0), p(1, 0), p(3, 0), p(3, 0))).toBeNull()
  })
})

describe('rectangles and circles', () => {
  it('builds a counter-clockwise rectangle of the size asked for, at any angle', () => {
    expectPolygon(rectPolygon(p(5, 5), 3, 1), [
      [3.5, 4.5],
      [6.5, 4.5],
      [6.5, 5.5],
      [3.5, 5.5],
    ])
    expect(signedArea(rectPolygon(p(5, 5), 3, 1))).toBeCloseTo(3, 12)
    // Rotation turns the footprint without changing its area or its winding.
    const turned = rectPolygon(p(0, 0), 2, 4, Math.PI / 2)
    expect(signedArea(turned)).toBeCloseTo(8, 12)
    expect(isCounterClockwise(rectPolygon(p(5, 5), 3, 1, 0.7))).toBe(true)
    const b = boundsOf(turned)
    expect(b.maxX - b.minX).toBeCloseTo(4, 12)
    expect(b.maxY - b.minY).toBeCloseTo(2, 12)
  })

  it('collapses a zero-size rectangle onto its centre', () => {
    expectPolygon(rectPolygon(p(1, 1), 0, 0), [
      [1, 1],
      [1, 1],
      [1, 1],
      [1, 1],
    ])
    expect(polygonArea(rectPolygon(p(1, 1), 0, 0))).toBe(0)
    expect(polygonArea(rectPolygon(p(1, 1), 3, 0))).toBe(0)
  })

  it('keeps its winding when a size arrives negative', () => {
    // A negative size names the same rectangle but emits the corners in reverse,
    // and the clockwise footprint that came out lied to `isCounterClockwise`:
    // anything taking an outward direction from the winding faced into the
    // object. `servicePolygon` puts a counter's width through here with no lower
    // bound under it, so a document can reach this.
    expectPolygon(rectPolygon(p(0, 0), -2, 4), [
      [-1, -2],
      [1, -2],
      [1, 2],
      [-1, 2],
    ])
    expect(signedArea(rectPolygon(p(0, 0), -2, 4))).toBeCloseTo(8, 12)
    expect(isCounterClockwise(rectPolygon(p(0, 0), -2, 4))).toBe(true)
    expect(isCounterClockwise(rectPolygon(p(0, 0), -2, -4))).toBe(true)
  })

  it('approximates a circle from the inside, counter-clockwise', () => {
    const c = circlePolygon(p(0, 0), 2, 16)
    expect(c).toHaveLength(16)
    expect(isCounterClockwise(c)).toBe(true)
    // A 16-gon inscribed in the circle: 12.246 m² against the true 12.566 m².
    // The rasteriser sees a column 2.6% smaller than the one that got ordered.
    expect(polygonArea(c)).toBeCloseTo(12.2458698, 6)
    expect(polygonArea(c)).toBeLessThan(Math.PI * 4)
    expectPoint(c[0], 2, 0)
    expect(pointInPolygon(p(0, 0), c)).toBe(true)
    // The polygon touches the circle at its vertices and cuts inside it between
    // them, so how much of a round column it covers depends on the bearing: at
    // 2 m the vertex direction is still inside, the mid-chord one is already out.
    const midChord = Math.PI / 16
    expect(pointInPolygon(p(1.999, 0), c)).toBe(true)
    expect(pointInPolygon(p(1.98 * Math.cos(midChord), 1.98 * Math.sin(midChord)), c)).toBe(false)
    expect(pointInPolygon(p(1.95 * Math.cos(midChord), 1.95 * Math.sin(midChord)), c)).toBe(true)
  })

  it('degenerates quietly on a zero or negative radius and on no segments', () => {
    expect(circlePolygon(p(1, 1), 0, 16).every((v) => v.x === 1 && v.y === 1)).toBe(true)
    expect(polygonArea(circlePolygon(p(1, 1), 0, 16))).toBe(0)
    expect(circlePolygon(p(0, 0), 1, 0)).toEqual([])
    // A negative radius is the same ring started half a turn round, so it still
    // encloses the centre and still winds counter-clockwise.
    const flipped = circlePolygon(p(0, 0), -2, 16)
    expect(polygonArea(flipped)).toBeCloseTo(12.2458698, 6)
    expect(isCounterClockwise(flipped)).toBe(true)
    expect(pointInPolygon(p(0, 0), flipped)).toBe(true)
  })

  it('walks the edges of a polygon in order and closes the loop', () => {
    const triangle = poly([0, 0], [1, 0], [0, 1])
    const edges = polygonEdges(triangle)
    expect(edges).toHaveLength(3)
    expect(edges[2].a).toEqual({ x: 0, y: 1 })
    expect(edges[2].b).toEqual({ x: 0, y: 0 })
    // Edges point at the polygon's own vertices instead of copying them, which
    // is what keeps this cheap enough for the simulation's inner loop — and
    // means nothing may write through an edge endpoint.
    expect(edges[0].a).toBe(triangle[0])
    expect(edges[2].b).toBe(triangle[0])
    expect(polygonEdges([])).toEqual([])
  })
})

describe('polylines', () => {
  const PATH = poly([0, 0], [3, 0], [3, 4])

  it('measures a path corner to corner', () => {
    expect(polylineLength(PATH)).toBe(7)
    expect(polylineLength([])).toBe(0)
    expect(polylineLength([p(3, 3)])).toBe(0)
  })

  it('walks a given distance along the path and stops dead at both ends', () => {
    expectPoint(pointAlongPolyline(PATH, 0), 0, 0)
    expectPoint(pointAlongPolyline(PATH, 3), 3, 0)
    expectPoint(pointAlongPolyline(PATH, 5), 3, 2)
    // Clamped, not extrapolated: a queue longer than its line stacks at the end
    // rather than marching people off into the wall behind it.
    expectPoint(pointAlongPolyline(PATH, 99), 3, 4)
    expectPoint(pointAlongPolyline(PATH, -3), 0, 0)
    expectPoint(pointAlongPolyline([], 3), 0, 0)
    expectPoint(pointAlongPolyline([p(2, 2)], 3), 2, 2)
  })

  it('copies the point it lands on rather than handing back the path vertex', () => {
    expect(pointAlongPolyline(PATH, 0)).not.toBe(PATH[0])
    expect(pointAlongPolyline(PATH, 99)).not.toBe(PATH[2])
  })

  it('survives a repeated waypoint without producing a NaN position', () => {
    // A queue line snapped to a single point is easy to draw. Dividing by its
    // zero length would put every person in that queue at NaN, and a NaN
    // position never collides, never arrives and never shows up in the results.
    expectPoint(pointAlongPolyline(poly([0, 0], [0, 0]), 0.5), 0, 0)
    expectPoint(pointAlongPolyline(poly([1, 1], [1, 1], [5, 1]), 2), 3, 1)
    expectPoint(tangentAlongPolyline(poly([0, 0], [0, 0]), 0), 1, 0)
  })

  it('samples from the head and leaves the tail short when the spacing does not divide', () => {
    // Queue slots are laid out this way. The last stretch of the line goes
    // unused when it is shorter than one slot — people bunch at the head end.
    expectPolygon(samplePolyline(poly([0, 0], [10, 0]), 3), [
      [0, 0],
      [3, 0],
      [6, 0],
      [9, 0],
    ])
    expectPolygon(samplePolyline(poly([0, 0], [6, 0]), 2), [
      [0, 0],
      [2, 0],
      [4, 0],
      [6, 0],
    ])
  })

  it('lays out no slots at all for a spacing of nothing', () => {
    // `floor(total / 0) + 1` is Infinity and the loop that fills the samples
    // never comes back: a queue line with a spacing of zero hung the tab. The
    // live caller clamps to 0.35 m and passes a count besides, so this was the
    // one input that locked up instead of answering.
    expect(samplePolyline(poly([0, 0], [6, 0]), 0)).toEqual([])
    expect(samplePolyline(poly([0, 0], [6, 0]), -2)).toEqual([])
    expect(samplePolyline(poly([2, 2], [2, 2]), 0)).toEqual([])
  })

  it('lays out the number of slots it was given whatever the spacing says', () => {
    expectPolygon(samplePolyline(poly([0, 0], [6, 0]), 0, 3), [
      [0, 0],
      [0, 0],
      [0, 0],
    ])
    // More slots than the line is long: the surplus all sit on the tail.
    expectPolygon(samplePolyline(poly([0, 0], [6, 0]), 4, 3), [
      [0, 0],
      [4, 0],
      [6, 0],
    ])
    expect(samplePolyline(poly([0, 0], [6, 0]), 2, 0)).toEqual([])
  })

  it('finds the closest point on a path along with how far along it that is', () => {
    const near = closestPointOnPolyline(PATH, p(5, 3))
    expectPoint(near.point, 3, 3)
    expect(near.arc).toBeCloseTo(6, 12)
    expect(near.distance).toBeCloseTo(2, 12)
    const past = closestPointOnPolyline(poly([0, 0], [4, 0]), p(9, 0))
    expectPoint(past.point, 4, 0)
    expect(past.arc).toBeCloseTo(4, 12)
    expect(past.distance).toBeCloseTo(5, 12)
  })

  it('breaks a tie towards the head of the path', () => {
    // Somebody standing equidistant from two parts of a queue line joins the
    // earlier one, so their place in the queue cannot flicker between the two.
    const square = poly([0, 0], [2, 0], [2, 2], [0, 2])
    const tie = closestPointOnPolyline(square, p(1, 1))
    expectPoint(tie.point, 1, 0)
    expect(tie.arc).toBeCloseTo(1, 12)
    expect(tie.distance).toBeCloseTo(1, 12)
  })

  it('has nothing to be close to on an empty path', () => {
    const none = closestPointOnPolyline([], p(1, 1))
    expect(none.distance).toBe(Infinity)
    expectPoint(none.point, 0, 0)
    const single = closestPointOnPolyline([p(3, 4)], p(0, 0))
    expectPoint(single.point, 3, 4)
    expect(single.arc).toBe(0)
    expect(single.distance).toBeCloseTo(5, 12)
  })

  it('reads the direction of travel and holds the last heading past the end', () => {
    expectPoint(tangentAlongPolyline(PATH, 1), 1, 0)
    expectPoint(tangentAlongPolyline(PATH, 5), 0, 1)
    expectPoint(tangentAlongPolyline(PATH, 99), 0, 1)
    // At a corner the walker is still on the leg they arrived by.
    expectPoint(tangentAlongPolyline(PATH, 3), 1, 0)
    expectPoint(tangentAlongPolyline([p(5, 5)], 0), 1, 0)
  })
})

describe('convex hull', () => {
  it('wraps the outliers counter-clockwise and drops what is inside', () => {
    const hull = convexHull([p(0, 0), p(4, 0), p(4, 4), p(0, 4), p(2, 2), p(1, 3)])
    expect(isCounterClockwise(hull)).toBe(true)
    expectPolygon(hull, [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ])
    expect(polygonArea(hull)).toBe(16)
  })

  it('drops a point that only sits along an edge', () => {
    // Collinear points are dead weight in a footprint: every edge they add is
    // another separating axis to test and another vertex to transform.
    expectPolygon(convexHull([p(0, 0), p(2, 0), p(4, 0), p(4, 4), p(0, 4)]), [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ])
  })

  it('winds a triangle counter-clockwise whichever order it arrived in', () => {
    const expected: Array<[number, number]> = [
      [0, 0],
      [4, 0],
      [0, 4],
    ]
    expectPolygon(convexHull([p(0, 0), p(4, 0), p(0, 4)]), expected)
    expectPolygon(convexHull([p(0, 0), p(0, 4), p(4, 0)]), expected)
  })

  it('degenerates to a line or a point rather than to a polygon', () => {
    expect(convexHull([])).toEqual([])
    expectPolygon(convexHull([p(1, 2)]), [[1, 2]])
    expectPolygon(convexHull([p(1, 1), p(2, 2)]), [
      [1, 1],
      [2, 2],
    ])
    expectPolygon(convexHull([p(0, 0), p(1, 0), p(2, 0)]), [
      [0, 0],
      [2, 0],
    ])
    expectPolygon(convexHull([p(1, 1), p(1, 1), p(1, 1), p(1, 1)]), [
      [1, 1],
      [1, 1],
    ])
  })

  it('copies a degenerate hull but shares the vertices of a real one', () => {
    // Nothing may write to a hull vertex: past two points they are the caller's
    // own objects, which for a plan footprint are the document's own points.
    const few = [p(0, 0), p(1, 0)]
    expect(convexHull(few)[0]).not.toBe(few[0])
    const many = [p(0, 0), p(4, 0), p(0, 4)]
    expect(convexHull(many).every((v) => many.includes(v))).toBe(true)
    // It sorts a copy: sorting the caller's array in place would reorder the
    // vertices of the very polygon the hull was taken from.
    const unsorted = [p(4, 4), p(0, 0), p(4, 0), p(0, 4)]
    convexHull(unsorted)
    expectPolygon(unsorted, [
      [4, 4],
      [0, 0],
      [4, 0],
      [0, 4],
    ])
  })
})

describe('outward offset', () => {
  it('pushes every wall of a rectangle out by the distance asked, either winding', () => {
    // This is a clearance band around a footprint; a corner that lands short
    // leaves a gap somebody can be pushed into.
    expectPolygon(offsetPolygon(ROOM, 1), [
      [-1, -1],
      [5, -1],
      [5, 5],
      [-1, 5],
    ])
    expect(polygonArea(offsetPolygon(ROOM, 1))).toBeCloseTo(36, 9)
    expect(polygonArea(offsetPolygon(ROOM_CW, 1))).toBeCloseTo(36, 9)
    expectPolygon(offsetPolygon(ROOM, -1), [
      [1, 1],
      [3, 1],
      [3, 3],
      [1, 3],
    ])
  })

  it('carries a reflex corner inward the same amount the convex ones go out', () => {
    expectPolygon(offsetPolygon(L_ROOM, 0.5), [
      [-0.5, -0.5],
      [4.5, -0.5],
      [4.5, 4.5],
      [1.5, 4.5],
      [1.5, 2.5],
      [-0.5, 2.5],
    ])
  })

  it('keeps a vertex that sits mid-edge on the offset edge', () => {
    expectPolygon(offsetPolygon(poly([0, 0], [2, 0], [4, 0], [4, 4], [0, 4]), 1), [
      [-1, -1],
      [2, -1],
      [5, -1],
      [5, 5],
      [-1, 5],
    ])
  })

  it('caps the spike on a needle-sharp corner at four times the offset', () => {
    // The true miter at a near-zero angle runs away to infinity. Capping it
    // keeps a sliver of furniture from throwing a clearance spike across the
    // room; the cost is that the tip of a very sharp wedge is under-offset.
    const needle = poly([0, 0], [10, 0.2], [10, -0.2])
    const offset = offsetPolygon(needle, 1)
    expectPoint(offset[0], -4, 0, 6)
    expect(offset[1].x).toBeCloseTo(11, 6)
    expect(offset[2].x).toBeCloseTo(11, 6)
  })

  it('leaves the polygon alone when there is nothing to offset', () => {
    const triangle = poly([0, 0], [4, 0], [4, 4])
    expectPolygon(offsetPolygon(triangle, 0), [
      [0, 0],
      [4, 0],
      [4, 4],
    ])
    expect(offsetPolygon(triangle, 0)[0]).not.toBe(triangle[0])
    expectPolygon(offsetPolygon(poly([0, 0], [4, 0]), 1), [
      [0, 0],
      [4, 0],
    ])
  })

  // Decided and left as it is: an inset deeper than the polygon's narrowest
  // half-span turns it inside out instead of collapsing it, and the result is
  // still wound counter-clockwise and still reports a plausible area. This is a
  // per-vertex miter push, and a miter has no idea when its neighbours have
  // walked through each other; noticing would mean a straight-skeleton or
  // clipper inset, which is a great deal of machinery for a helper whose job is
  // the clearance band around a near-rectangular footprint — every call it has
  // ever had offsets outward. The guard a future inset caller needs is the
  // assertion below: a negative offset that grew the polygon consumed it, and
  // what came back is not floor. The doc comment now says so.
  it('turns a small polygon inside out when the inset eats it', () => {
    const small = poly([0, 0], [2, 0], [2, 2], [0, 2])
    const inverted = offsetPolygon(small, -3)
    expect(polygonArea(small)).toBe(4)
    expect(polygonArea(inverted)).toBeCloseTo(16, 9)
    expect(polygonArea(inverted)).toBeGreaterThan(polygonArea(small))
    expect(isCounterClockwise(inverted)).toBe(true)
    // Every corner has crossed to the far side of the polygon's centre.
    expectPolygon(inverted, [
      [3, 3],
      [-1, 3],
      [-1, -1],
      [3, -1],
    ])
  })
})

describe('convex overlap', () => {
  it('counts two footprints pushed up against each other as overlapping', () => {
    // Two tables sharing an edge are touching, and placement treats touching as
    // occupied — there is no room between them for anybody to stand.
    expect(convexPolygonsOverlap(ROOM, poly([4, 0], [8, 0], [8, 4], [4, 4]))).toBe(true)
    expect(convexPolygonsOverlap(ROOM, poly([4.001, 0], [8, 0], [8, 4], [4.001, 4]))).toBe(false)
    expect(convexPolygonsOverlap(ROOM, ROOM)).toBe(true)
    expect(convexPolygonsOverlap(ROOM, poly([1, 1], [2, 1], [2, 2], [1, 2]))).toBe(true)
    expect(convexPolygonsOverlap(ROOM_CW, poly([1, 1], [2, 1], [2, 2], [1, 2]))).toBe(true)
  })

  it('separates shapes along an axis no bounding box would find', () => {
    // A rotated table beside a square one: their bounding boxes overlap, the
    // shapes do not, and refusing the placement would be wrong.
    const square = poly([0, 0], [2, 0], [2, 2], [0, 2])
    expect(convexPolygonsOverlap(square, poly([3, 1], [4, 0], [5, 1], [4, 2]))).toBe(false)
    expect(convexPolygonsOverlap(square, poly([2.5, 1], [3.5, 0], [4.5, 1], [3.5, 2]))).toBe(false)
    expect(convexPolygonsOverlap(square, poly([1.5, 1], [2.5, 0], [3.5, 1], [2.5, 2]))).toBe(true)
  })

  it('claims an overlap that is not there once a footprint is concave', () => {
    // Documented: the separating-axis test needs convex input. The notch of an
    // L-shaped counter reads as solid, so a chair tucked into it is refused.
    const lCounter = poly([0, 0], [4, 0], [4, 4], [2, 4], [2, 1], [0, 1])
    const inTheNotch = poly([0.5, 2], [1.5, 2], [1.5, 3], [0.5, 3])
    expect(inTheNotch.some((v) => pointInPolygon(v, lCounter))).toBe(false)
    expect(convexPolygonsOverlap(lCounter, inTheNotch)).toBe(true)
  })

  it('separates two footprints that have no edges between them by where they are', () => {
    // A footprint of one point, or of none, has no edge to raise an axis from:
    // every axis it offered was (0, 0), every projection onto one was 0, and no
    // separation could be found, so two points metres apart read as overlapping
    // and a placement check handed one would refuse every position on the floor.
    expect(convexPolygonsOverlap([p(9, 9)], [p(1, 1)])).toBe(false)
    expect(convexPolygonsOverlap([p(9, 9)], [p(9, 9)])).toBe(true)
    expect(convexPolygonsOverlap([], [])).toBe(false)
    expect(convexPolygonsOverlap([], [p(1, 1)])).toBe(false)
    // One real polygon supplies enough axes to get the right answer back.
    expect(convexPolygonsOverlap([p(2, 2)], ROOM)).toBe(true)
    expect(convexPolygonsOverlap([p(9, 9)], ROOM)).toBe(false)
    expect(convexPolygonsOverlap([], ROOM)).toBe(false)
    expect(convexPolygonsOverlap(ROOM, [])).toBe(false)
  })
})
