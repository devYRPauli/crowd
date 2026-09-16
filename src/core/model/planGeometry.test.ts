import { describe, expect, it } from 'vitest'
import {
  furniturePolygon,
  furnitureVisualPolygon,
  isWalkableOpening,
  openingThreshold,
  planSeats,
  pointOnWall,
  serverPositions,
  servicePolygon,
  servicePositions,
  serviceQueue,
  solidSpans,
  wallAngle,
  wallDirection,
  wallLength,
} from './planGeometry'
import type { FurnitureItem, Opening, ServicePoint, Wall } from './types'
import { boundsOf, pointInPolygon, polygonArea, polygonCentroid } from '../math/geometry'
import { add, distance, dot, fromAngle, normalize, perp, scale, sub } from '../math/vec2'
import { PlanBuilder } from '../../library/planBuilder'

let counter = 0

const wall = (ax: number, ay: number, bx: number, by: number, thickness = 0.15): Wall => ({
  id: `w${counter++}`,
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
  thickness,
  height: 3,
  kind: 'wall',
})

/** Six metres of wall leaving (-1, 4) at `angle`, for the off-axis cases. */
const wallAt = (angle: number, thickness = 0.2): Wall => {
  const a = { x: -1, y: 4 }
  const b = add(a, fromAngle(angle, 6))
  return wall(a.x, a.y, b.x, b.y, thickness)
}

/** A 3'0" leaf — the entry door standard, and what the editor defaults to. */
const LEAF = 0.914

const door = (host: Wall, offset: number, width = LEAF, extra: Partial<Opening> = {}): Opening => ({
  id: `o${counter++}`,
  wallId: host.id,
  offset,
  width,
  height: 2.032,
  sill: 0,
  kind: 'door',
  ...extra,
})

const furniture = (
  catalogId: string,
  rotation = 0,
  size?: FurnitureItem['size'],
): FurnitureItem => ({
  id: `f${counter++}`,
  catalogId,
  position: { x: 2, y: -3 },
  rotation,
  ...(size ? { size } : {}),
})

const counterAt = (rotation: number, options: Partial<ServicePoint> = {}): ServicePoint => ({
  id: `svc${counter++}`,
  name: 'Bar',
  position: { x: 2, y: -1 },
  rotation,
  width: 1.8,
  depth: 0.7,
  servers: 2,
  serviceTime: { kind: 'constant', mean: 30 },
  queueSpacing: 0.65,
  ...options,
})

describe('wall metrics', () => {
  it('measures along the centreline, so thickness never shifts an offset', () => {
    // Opening offsets, solid spans and obstacle segments are all distances from
    // `a` along this line; if length included the footprint they would mean
    // different things to the renderer and to the engine.
    const w = wall(1, 2, 4, 6, 0.4)
    expect(wallLength(w)).toBeCloseTo(5, 12)
    expect(wallDirection(w)).toEqual({ x: 0.6, y: 0.8 })
    expect(wallAngle(w)).toBeCloseTo(Math.atan2(4, 3), 12)
    expect(pointOnWall(w, wallLength(w))).toEqual({ x: 4, y: 6 })
  })

  it('survives a zero-length wall rather than emitting NaN geometry', () => {
    // Dragging one endpoint onto the other is not blocked anywhere, and a NaN
    // direction would spread silently from here into planBounds and the nav
    // grid — which is why `normalize` returns the zero vector instead.
    const w = wall(3, 3, 3, 3)
    expect(wallLength(w)).toBe(0)
    expect(wallDirection(w)).toEqual({ x: 0, y: 0 })
    expect(solidSpans(w, [])).toEqual([])
  })
})

describe('solidSpans', () => {
  it('leaves a wall whole when nothing is cut into it', () => {
    const w = wall(0, 0, 6, 0)
    const elsewhere = wall(0, 5, 6, 5)
    // An opening carries its wall's id; after a delete-and-redraw the document
    // can still hold one pointing at a different wall.
    expect(solidSpans(w, [door(elsewhere, 3)])).toEqual([{ start: 0, end: 6 }])
  })

  it('opens exactly the door leaf, measured along the wall', () => {
    const w = wall(0, 0, 6, 0)
    const spans = solidSpans(w, [door(w, 3)])
    expect(spans).toHaveLength(2)
    expect(spans[0]).toEqual({ start: 0, end: 3 - LEAF / 2 })
    expect(spans[1]).toEqual({ start: 3 + LEAF / 2, end: 6 })
    // Every egress number turns on this width being the door's, not a rounding
    // of it.
    expect(spans[1].start - spans[0].end).toBeCloseTo(LEAF, 12)
  })

  it('merges overlapping openings instead of reporting a wall between them', () => {
    const w = wall(0, 0, 6, 0)
    const spans = solidSpans(w, [door(w, 2, 1.2), door(w, 2.8, 1.2)])
    expect(spans).toEqual([
      { start: 0, end: 1.4 },
      { start: 3.4, end: 6 },
    ])
  })

  it('reads two leaves hung side by side as one opening of their combined width', () => {
    // A 2'8" and a 3'0" that exactly abut are one hole people walk through. A
    // zero-width pier reported between them would be a solid stretch the nav
    // grid has to resolve, and the pair would meter as two narrow doors.
    const w = wall(0, 0, 6, 0)
    const spans = solidSpans(w, [door(w, 2, 0.813), door(w, 2 + (0.813 + 0.914) / 2, 0.914)])
    expect(spans).toHaveLength(2)
    expect(spans[1].start - spans[0].end).toBeCloseTo(0.813 + 0.914, 9)
  })

  it('clamps an opening at either end without emitting an empty span', () => {
    const w = wall(0, 0, 6, 0)
    expect(solidSpans(w, [door(w, 6)])).toEqual([{ start: 0, end: 6 - LEAF / 2 }])
    expect(solidSpans(w, [door(w, 0)])).toEqual([{ start: LEAF / 2, end: 6 }])
    // Entirely past the end: nothing is cut, and no reversed span appears.
    expect(solidSpans(w, [door(w, 9)])).toEqual([{ start: 0, end: 6 }])
  })

  it('reports no solid stretch when the opening swallows the wall', () => {
    const w = wall(0, 0, 6, 0)
    expect(solidSpans(w, [door(w, 3, 8)])).toEqual([])
  })

  it('keeps the wall solid under a window, which is a hole but not a way through', () => {
    const w = wall(0, 0, 6, 0)
    const glazing = door(w, 3, 1.524, { kind: 'window', sill: 0.914, height: 1.219 })
    expect(solidSpans(w, [glazing])).toEqual([{ start: 0, end: 6 }])
    // Even a shopfront glazed to the floor is glass, not a doorway.
    const shopfront = door(w, 3, 1.524, { kind: 'window', sill: 0 })
    expect(solidSpans(w, [shopfront])).toEqual([{ start: 0, end: 6 }])
  })
})

describe('isWalkableOpening', () => {
  it('lets people through anything at floor level except glass', () => {
    const w = wall(0, 0, 6, 0)
    expect(isWalkableOpening(door(w, 3))).toBe(true)
    expect(isWalkableOpening(door(w, 3, 2, { kind: 'opening' }))).toBe(true)
    // A gate is only impassable once it is raised: it is the sill that decides,
    // not the kind.
    expect(isWalkableOpening(door(w, 3, 2, { kind: 'gate' }))).toBe(true)
    expect(isWalkableOpening(door(w, 3, 2, { kind: 'gate', sill: 1.1 }))).toBe(false)
    expect(isWalkableOpening(door(w, 3, 1.5, { kind: 'window', sill: 0 }))).toBe(false)
  })

  it('tolerates a threshold strip but not a step', () => {
    const w = wall(0, 0, 6, 0)
    expect(isWalkableOpening(door(w, 3, LEAF, { sill: 0.02 }))).toBe(true)
    expect(isWalkableOpening(door(w, 3, LEAF, { sill: 0.05 }))).toBe(false)
  })
})

describe('openingThreshold', () => {
  const ANGLES = [0, Math.PI / 2, Math.PI, -Math.PI / 2, 2.3, -0.7]

  it.each(ANGLES)('stands on the doorway itself at %f rad', (angle) => {
    const w = wallAt(angle)
    const o = door(w, 2.5)
    const poly = openingThreshold(w, o)
    // As wide as the leaf and deep enough to stand on both sides of it: the
    // door's own clear width is then what meters the flow through it.
    expect(polygonArea(poly)).toBeCloseTo(o.width * (w.thickness + 0.8), 12)
    const centre = polygonCentroid(poly)
    const expected = pointOnWall(w, o.offset)
    expect(centre.x).toBeCloseTo(expected.x, 12)
    expect(centre.y).toBeCloseTo(expected.y, 12)
  })

  it('reaches equally far either side of the wall and no wider than the leaf', () => {
    // Skew on purpose: an axis-aligned wall hides a swapped direction/normal.
    const w = wallAt(1.1)
    const o = door(w, 2.5)
    const poly = openingThreshold(w, o)
    const centre = pointOnWall(w, o.offset)
    const along = wallDirection(w)
    const across = perp(along)
    const halfDepth = w.thickness / 2 + 0.4
    for (const side of [-1, 1]) {
      expect(pointInPolygon(add(centre, scale(across, side * (halfDepth - 0.01))), poly)).toBe(true)
      expect(pointInPolygon(add(centre, scale(across, side * (halfDepth + 0.01))), poly)).toBe(
        false,
      )
      expect(pointInPolygon(add(centre, scale(along, side * (o.width / 2 - 0.01))), poly)).toBe(
        true,
      )
      expect(pointInPolygon(add(centre, scale(along, side * (o.width / 2 + 0.01))), poly)).toBe(
        false,
      )
    }
  })

  it('deepens with reach but never widens', () => {
    const w = wallAt(0.4)
    const o = door(w, 2.5)
    const along = wallDirection(w)
    const widthAlongWall = (reach: number) => {
      const ts = openingThreshold(w, o, reach).map((p) => dot(sub(p, w.a), along))
      return Math.max(...ts) - Math.min(...ts)
    }
    // Reach is how far out people may stand, not how much door there is.
    expect(widthAlongWall(0)).toBeCloseTo(o.width, 12)
    expect(widthAlongWall(1.2)).toBeCloseTo(o.width, 12)
    expect(polygonArea(openingThreshold(w, o, 0))).toBeCloseTo(o.width * w.thickness, 12)
    expect(polygonArea(openingThreshold(w, o, 1.2))).toBeCloseTo(o.width * (w.thickness + 2.4), 12)
  })

  it('still spans the full leaf for a door at the wall end, though half of it is solid', () => {
    // Recorded decision. `solidSpans` clamps a gap to the wall it is cut in;
    // this does not, so a door hung on the very end of a wall describes a
    // doorway twice as wide as the hole, half of it open floor beside the wall,
    // and people sent there walk round the door rather than through it.
    // Clamping here would hide the real fault rather than fix it: an opening
    // that does not fit its wall. `fitToWall` in core/document/mutations.ts is
    // what keeps every opening the inspector and the tools produce on its wall
    // with a jamb either side, and the paths that still skip it — the plan
    // builder, and a plan arriving from a file — are where the fit belongs. A
    // threshold that quietly shrank instead would leave the drawing, the
    // document and the simulation each with a different door.
    const w = wall(0, 0, 6, 0, 0.2)
    const o = door(w, 6)
    expect(solidSpans(w, [o])).toEqual([{ start: 0, end: 6 - LEAF / 2 }])
    const poly = openingThreshold(w, o)
    expect(polygonArea(poly)).toBeCloseTo(LEAF * 1.0, 12)
    expect(boundsOf(poly).maxX).toBeCloseTo(6 + LEAF / 2, 12)
  })
})

describe('furniturePolygon', () => {
  it('trims the collision footprint by the catalog inset', () => {
    // A chair tucks under the table it belongs to. Blocking its visual box
    // would ring a banquet round with obstacles and seal the table off.
    const chair = furniture('chair')
    expect(polygonArea(furniturePolygon(chair))).toBeCloseTo((0.46 - 0.2) * (0.5 - 0.2), 12)
    expect(polygonArea(furnitureVisualPolygon(chair))).toBeCloseTo(0.46 * 0.5, 12)
  })

  it('turns with the item', () => {
    const b = boundsOf(furniturePolygon(furniture('chair', Math.PI / 2)))
    expect(b.maxX - b.minX).toBeCloseTo(0.5 - 0.2, 9)
    expect(b.maxY - b.minY).toBeCloseTo(0.46 - 0.2, 9)
  })

  it('gives a round table a circle of its own diameter', () => {
    const table = furniture('table-round-4')
    const poly = furniturePolygon(table)
    expect(poly).toHaveLength(14)
    for (const p of poly) expect(distance(p, table.position)).toBeCloseTo(0.5, 12)
    // Inflating for body clearance grows the radius, not the diameter.
    for (const p of furniturePolygon(table, 0.25))
      expect(distance(p, table.position)).toBeCloseTo(0.75, 12)
  })

  it('keeps a footprint for an item resized below twice its inset', () => {
    // The resize handles let a user pull a chair narrower than the 0.1 m inset
    // trims from each side; without the floor the rectangle would come back
    // mirrored, with the wrong extent.
    const narrow = furniture('chair', 0, { width: 0.15, depth: 0.5, height: 0.86 })
    expect(polygonArea(furniturePolygon(narrow))).toBeCloseTo(0.02 * 0.3, 12)
    const b = boundsOf(furniturePolygon(narrow))
    expect(b.maxX - b.minX).toBeCloseTo(0.02, 12)
  })

  it('still blocks for a catalog item this build does not have', () => {
    // Documents outlive builds; an unknown id must not become a hole in the
    // obstacle set that people walk through.
    const poly = furniturePolygon(furniture('sedan-chair-1710'))
    expect(polygonArea(poly)).toBeCloseTo(0.36, 12)
    expect(pointInPolygon({ x: 2, y: -3 }, poly)).toBe(true)
  })
})

describe('planSeats', () => {
  it('rotates a seat and the direction it faces together', () => {
    const b = new PlanBuilder()
    const table = b.place('table-round-4', 3, -2, 0.7)
    const seats = planSeats(b.build())
    expect(seats).toHaveLength(4)
    for (const seat of seats) {
      expect(seat.furnitureId).toBe(table.id)
      // 1.0 m top plus the 0.42 m the catalog leaves for a chair.
      expect(distance(seat.position, table.position)).toBeCloseTo(0.92, 12)
      // Rotating the position but not the facing (or either the wrong way)
      // seats the whole table looking outwards, which no test of the position
      // alone would catch.
      expect(
        dot(normalize(sub(table.position, seat.position)), fromAngle(seat.facing)),
      ).toBeCloseTo(1, 12)
    }
  })

  it('lays seats out from the per-instance size, not the catalog default', () => {
    // A resized round must push its chairs out with it, or the renderer draws
    // people sitting inside the table top.
    const b = new PlanBuilder()
    b.place('table-round-8', 0, 0, 0, { size: { width: 3, depth: 3, height: 0.75 } })
    const seats = planSeats(b.build())
    expect(seats).toHaveLength(8)
    for (const seat of seats)
      expect(distance(seat.position, { x: 0, y: 0 })).toBeCloseTo(1.5 + 0.42, 12)
  })

  it('skips furniture with no seats and keys the rest by item and slot', () => {
    const b = new PlanBuilder()
    b.place('column-round', 0, 0)
    const first = b.place('table-poseur', 1, 0)
    const second = b.place('table-poseur', 4, 0)
    const seats = planSeats(b.build())
    expect(seats).toHaveLength(8)
    // The engine assigns places by these ids; two identical tables sharing one
    // would put two people in the same spot.
    expect(new Set(seats.map((s) => s.id)).size).toBe(8)
    expect(seats[0].id).toBe(`${first.id}:0`)
    expect(seats.filter((s) => s.furnitureId === second.id)).toHaveLength(4)
    // A poseur is somewhere to lean, not to sit, and the kind carries through.
    expect(seats.every((s) => s.kind === 'lean')).toBe(true)
  })
})

describe('service points', () => {
  it.each([0, Math.PI / 2, -2.4])(
    'serves from the far side of the counter at %f rad',
    (rotation) => {
      const point = counterAt(rotation)
      const staff = serverPositions(point)
      const served = servicePositions(point)
      const face = servicePolygon(point)
      expect(staff).toHaveLength(2)
      expect(served).toHaveLength(2)
      for (let i = 0; i < staff.length; i++) {
        // Opposite sides, stated without reference to the facing helper all three
        // share: a sign flip there would otherwise pass unnoticed.
        expect(dot(sub(staff[i], point.position), sub(served[i], point.position))).toBeLessThan(0)
        expect(pointInPolygon(staff[i], face)).toBe(false)
        expect(pointInPolygon(served[i], face)).toBe(false)
        expect(distance(staff[i], served[i])).toBeGreaterThan(point.depth)
        // Same station, so the pair faces each other across the counter rather
        // than standing at different points along it.
        expect(dot(sub(served[i], staff[i]), fromAngle(rotation))).toBeCloseTo(0, 12)
      }
      // The queue forms on the customers' side, behind the person being served.
      const [head] = serviceQueue(point)
      expect(dot(sub(head, point.position), sub(served[0], point.position))).toBeGreaterThan(0)
      expect(dot(sub(head, point.position), sub(staff[0], point.position))).toBeLessThan(0)
    },
  )

  it('spreads stations along the counter face and keeps them on it', () => {
    const point = counterAt(0, { servers: 3 })
    const along = fromAngle(point.rotation)
    const offsets = servicePositions(point).map((p) => dot(sub(p, point.position), along))
    expect(offsets).toHaveLength(3)
    expect(offsets[0]).toBeCloseTo(-0.6, 12)
    expect(offsets[1]).toBeCloseTo(0, 12)
    expect(offsets[2]).toBeCloseTo(0.6, 12)
    for (const t of offsets) expect(Math.abs(t)).toBeLessThan(point.width / 2)
  })

  it('still offers one station for a counter with no staff on it', () => {
    // The engine counts servers as `max(1, floor(servers))`; the geometry has to
    // agree or it indexes a station that does not exist.
    expect(servicePositions(counterAt(0, { servers: 0 }))).toHaveLength(1)
    expect(serverPositions(counterAt(0, { servers: 2.5 }))).toHaveLength(2)
  })

  it('stacks two stations on top of each other on a counter 0.6 m wide', () => {
    // Recorded decision. The 0.6 m is elbow room: the end station stands that
    // much in from the counter's corner instead of on it, which is what makes
    // a normal bar read right. A 0.6 m counter is barely one person wide, so
    // two staffed positions on it is a plan that could not be built, and the
    // spread has nothing left to give — both stations land on the centre, and
    // narrower still the spread goes negative and the two mirror. Nobody ends
    // up inside anybody: a station is the mark a customer is sent to, not where
    // a body is placed, and contact resolution keeps the pair apart when they
    // arrive. Spreading over a fixed fraction of the width instead would move
    // every station on every counter under 1.2 m wide to tidy up one no venue
    // has.
    const [a, b] = servicePositions(counterAt(0, { width: 0.6 }))
    expect(a).toEqual(b)
    const narrow = servicePositions(counterAt(0, { width: 0.4 }))
    const along = fromAngle(0)
    expect(dot(sub(narrow[0], { x: 2, y: -1 }), along)).toBeCloseTo(0.1, 12)
  })
})
