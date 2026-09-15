import { describe, expect, it } from 'vitest'
import { constrainAngle, snapDelta, snapPoint, snapToGrid } from './snapping'
import { createDocument } from '../core/model/defaults'
import type { CrowdDocument, Plan, ServicePoint, Wall } from '../core/model/types'
import { distance } from '../core/math/vec2'

const wall = (
  id: string,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  thickness = 0.2,
): Wall => ({
  id,
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
  thickness,
  height: 3,
  kind: 'wall',
})

const service = (id: string, x: number, y: number): ServicePoint => ({
  id,
  name: id,
  position: { x, y },
  rotation: 0,
  width: 1.2,
  depth: 0.6,
  servers: 1,
  serviceTime: { kind: 'constant', mean: 30 },
  queueSpacing: 0.6,
})

/** A real document, so the tests run against the shipped defaults (0.5 m grid). */
const docWith = (plan: Partial<Plan>): CrowdDocument => {
  const doc = createDocument('snap fixture')
  return { ...doc, plan: { ...doc.plan, ...plan } }
}

const deg = (radians: number): number => (radians * 180) / Math.PI

describe('snap tolerance is screen pixels, not metres', () => {
  // One vertical wall; the probe sits diagonally off its `a` end so that nothing
  // else (edge, extension, alignment) is in range at the tight zoom.
  const doc = docWith({ walls: [wall('w', 0, 0, 0, 6, 0.1)] })
  const raw = { x: -0.14, y: -0.14 }

  it('snaps the same world point at one zoom and not at another', () => {
    const zoomedOut = snapPoint(doc, raw, { scale: 0.04, tolerancePx: 10, gridSnap: false })
    expect(zoomedOut.kind).toBe('endpoint')
    expect(zoomedOut.point).toEqual({ x: 0, y: 0 })

    const zoomedIn = snapPoint(doc, raw, { scale: 0.004, tolerancePx: 10, gridSnap: false })
    expect(zoomedIn.kind).toBe('none')
    expect(zoomedIn.point).toEqual(raw)
  })

  /** Largest world distance from the wall end at which the endpoint still wins. */
  const endpointRadius = (scale: number, tolerancePx = 10): number => {
    let lo = 0
    let hi = 10
    for (let i = 0; i < 60; i++) {
      const t = (lo + hi) / 2
      const probe = { x: -t * Math.SQRT1_2, y: -t * Math.SQRT1_2 }
      const result = snapPoint(doc, probe, { scale, tolerancePx, gridSnap: false })
      if (result.kind === 'endpoint') lo = t
      else hi = t
    }
    return lo
  }

  it('grows the world-space grab radius in proportion to metres per pixel', () => {
    const fine = endpointRadius(0.004)
    const coarse = endpointRadius(0.04)

    expect(fine).toBeCloseTo(0.04, 6)
    expect(coarse).toBeCloseTo(0.4, 6)
    // Ten times the metres per pixel, ten times the radius: the pixel distance
    // the user has to move the cursor is identical at both zooms.
    expect(coarse / fine).toBeCloseTo(10, 6)
  })

  it('stops shrinking at a 2 cm floor when zoomed right in', () => {
    // Math.max(0.02, …) in snapPoint. Below ~0.002 m/px the tolerance is a fixed
    // world distance again, so the pixel claim holds only above that zoom.
    expect(endpointRadius(0.0001)).toBeCloseTo(0.02, 6)
  })
})

describe('snap priority', () => {
  // One cursor position with an endpoint, a wall edge, an alignment anchor and a
  // grid intersection all inside the tolerance, each at a different point.
  const doc = docWith({
    walls: [wall('end-wall', 2.6, 0.5, 2.6, 5), wall('edge-wall', -5, 0, 5, 0)],
    servicePoints: [service('counter', 2.6, 4)],
  })
  const raw = { x: 2.44, y: 0.06 }
  const options = { scale: 0.05, tolerancePx: 12 }

  it('prefers a wall endpoint to everything else', () => {
    const result = snapPoint(doc, raw, options)
    expect(result.kind).toBe('endpoint')
    expect(result.point).toEqual({ x: 2.6, y: 0.5 })
    expect(result.label).toBe('Wall end')
    // An endpoint is unambiguous, so there is nothing to explain with a guide.
    expect(result.guides).toEqual([])
  })

  it('falls to the wall edge once the endpoint is out of the picture', () => {
    const result = snapPoint(doc, raw, { ...options, exclude: new Set(['end-wall']) })
    expect(result.kind).toBe('edge')
    expect(result.point.x).toBeCloseTo(2.44, 9)
    // The face on the cursor's side, half of the 0.2 m thickness off the centreline.
    expect(result.point.y).toBeCloseTo(0.1, 9)
    // The door and window tools place by offset from the wall's `a` end.
    expect(result.wall?.wall.id).toBe('edge-wall')
    expect(result.wall?.offset).toBeCloseTo(7.44, 9)
  })

  it('falls to an alignment guide once no wall is in range', () => {
    const result = snapPoint(doc, raw, {
      ...options,
      exclude: new Set(['end-wall', 'edge-wall']),
    })
    expect(result.kind).toBe('align-x')
    expect(result.point).toEqual({ x: 2.6, y: 0.06 })
    // The guide is the vertical line the cursor is sharing with the counter.
    expect(result.guides).toHaveLength(1)
    expect(result.guides[0].from.x).toBeCloseTo(2.6, 9)
    expect(result.guides[0].to.x).toBeCloseTo(2.6, 9)
    expect(result.guides[0].from.y).toBeLessThan(0.06)
    expect(result.guides[0].to.y).toBeGreaterThan(4)
  })

  it('falls to the grid last', () => {
    const result = snapPoint(doc, raw, {
      ...options,
      exclude: new Set(['end-wall', 'edge-wall', 'counter']),
    })
    expect(result.kind).toBe('grid')
    expect(result.point).toEqual({ x: 2.5, y: 0 })
  })
})

describe('turning snapping off', () => {
  const doc = docWith({ walls: [wall('w', 2.34, 1.02, 2.34, 5, 0.1)] })
  const raw = { x: 2.3, y: 1.02 }
  const options = { scale: 0.01, tolerancePx: 12 }

  it('snaps to the endpoint by default', () => {
    expect(snapPoint(doc, raw, options).kind).toBe('endpoint')
  })

  it('returns the raw point untouched when disabled — what holding Alt does', () => {
    const result = snapPoint(doc, raw, { ...options, disabled: true })
    expect(result.kind).toBe('none')
    expect(result.point).toEqual(raw)
    expect(result.guides).toEqual([])
    expect(result.wall).toBeUndefined()
  })

  it('leaves only the grid when object snapping is off', () => {
    // The nearest grid node is 0.2 m away and the tolerance is 0.12 m, so with
    // objects out of the running nothing at all is in range.
    const result = snapPoint(doc, raw, { ...options, objectSnap: false })
    expect(result.kind).toBe('none')
    expect(result.point).toEqual(raw)
  })

  it('takes its defaults from the document when the caller does not override', () => {
    const off: CrowdDocument = {
      ...doc,
      settings: { ...doc.settings, snapToGrid: false, snapToObjects: false },
    }
    expect(snapPoint(off, raw, options).kind).toBe('none')
    expect(snapPoint(off, raw, { ...options, objectSnap: true }).kind).toBe('endpoint')
  })
})

describe('nothing in range', () => {
  it('returns the cursor position unchanged', () => {
    const doc = docWith({ walls: [wall('w', 40, 40, 50, 40)] })
    const raw = { x: 0.31, y: 0.19 }
    const result = snapPoint(doc, raw, { scale: 0.005, tolerancePx: 10 })
    expect(result.kind).toBe('none')
    expect(result.point).toEqual(raw)
    expect(result.guides).toEqual([])
    expect(result.wall).toBeUndefined()
    expect(result.label).toBeUndefined()
  })

  it('finds nothing in an empty plan even with every snap enabled', () => {
    const doc = docWith({})
    const result = snapPoint(doc, { x: 3.31, y: -2.19 }, { scale: 0.01, tolerancePx: 12 })
    expect(result.kind).toBe('none')
  })
})

describe('angle snapping while drawing', () => {
  const doc = docWith({})
  const anchor = { x: 0, y: 0 }
  const options = { scale: 0.01, tolerancePx: 12, gridSnap: false }
  const rayAt = (degrees: number, length: number) => ({
    x: Math.cos((degrees * Math.PI) / 180) * length,
    y: Math.sin((degrees * Math.PI) / 180) * length,
  })

  it('pulls a nearly-aligned direction onto the increment and keeps the length', () => {
    const raw = rayAt(12, 3)
    const result = snapPoint(doc, raw, { ...options, anchor, angleSnapDeg: 15 })
    expect(result.kind).toBe('angle')
    expect(deg(Math.atan2(result.point.y, result.point.x))).toBeCloseTo(15, 9)
    expect(distance(anchor, result.point)).toBeCloseTo(3, 9)
    expect(result.guides).toEqual([{ from: anchor, to: result.point, kind: 'angle' }])
  })

  it('leaves a direction alone when the nearest increment is out of tolerance', () => {
    // Half way between 0° and 15° at 3 m is 0.39 m from either, well past the
    // 0.19 m gate — otherwise every drawn line would jump to a multiple of 15°.
    const result = snapPoint(doc, rayAt(7.5, 3), { ...options, anchor, angleSnapDeg: 15 })
    expect(result.kind).toBe('none')
  })

  it('does nothing without an anchor, and an explicit zero overrules the document', () => {
    const raw = rayAt(12, 3)
    expect(snapPoint(doc, raw, { ...options, angleSnapDeg: 15 }).kind).toBe('none')
    expect(snapPoint(doc, raw, { ...options, anchor, angleSnapDeg: 0 }).kind).toBe('none')
  })

  it('takes the increment from the document when a tool passes only an anchor', () => {
    // The room tool in drawTools.ts snaps its far corner with `{ anchor }` and
    // nothing else; without this fallback the document could say 15° while that
    // one tool drew at any angle at all.
    expect(doc.settings.angleSnapDeg).toBe(15)
    const result = snapPoint(doc, rayAt(12, 3), { ...options, anchor })
    expect(result.kind).toBe('angle')
    expect(deg(Math.atan2(result.point.y, result.point.x))).toBeCloseTo(15, 9)
    expect(distance(anchor, result.point)).toBeCloseTo(3, 9)
  })

  it('still loses to a wall endpoint', () => {
    const raw = rayAt(12, 3)
    const withWall = docWith({ walls: [wall('w', raw.x + 0.05, raw.y + 0.02, 8, 8)] })
    const result = snapPoint(withWall, raw, { ...options, anchor, angleSnapDeg: 15 })
    expect(result.kind).toBe('endpoint')
    expect(result.point.x).toBeCloseTo(raw.x + 0.05, 9)
  })
})

describe('wallsOnly, as the door tool uses it', () => {
  const doc = docWith({ walls: [wall('w', 0, 0, 10, 0)] })

  it('reports the offset along the wall for the opening', () => {
    const result = snapPoint(
      doc,
      { x: 3, y: 0.05 },
      { scale: 0.01, tolerancePx: 12, wallsOnly: true },
    )
    expect(result.kind).toBe('edge')
    expect(result.wall?.wall.id).toBe('w')
    expect(result.wall?.offset).toBeCloseTo(3, 9)
    // The cursor is inside the wall body, so the point comes back out onto the
    // face it is nearest rather than sitting on the centreline.
    expect(result.point.x).toBeCloseTo(3, 9)
    expect(result.point.y).toBeCloseTo(0.1, 9)
  })

  it('refuses to snap off a wall, even to the grid', () => {
    const raw = { x: 3.1, y: 5.1 }
    const options = { scale: 0.01, tolerancePx: 20 }
    expect(snapPoint(doc, raw, options).kind).toBe('grid')
    expect(snapPoint(doc, raw, { ...options, wallsOnly: true }).kind).toBe('none')
  })
})

describe('the reach onto a wall is pixels from its face', () => {
  const thin = docWith({ walls: [wall('w', 0, 0, 10, 0, 0.1)] })
  const thick = docWith({ walls: [wall('w', 0, 0, 10, 0, 0.4)] })
  // 0.05 m of tolerance, against faces 0.05 m and 0.2 m off the centreline.
  const options = { scale: 0.005, tolerancePx: 10, gridSnap: false }

  it('reaches as far past a thick wall as past a thin one at the same zoom', () => {
    // 8 px clear of each face: both catch, each on its own face.
    const onThin = snapPoint(thin, { x: 3, y: 0.09 }, options)
    const onThick = snapPoint(thick, { x: 3, y: 0.24 }, options)
    expect(onThin.kind).toBe('edge')
    expect(onThick.kind).toBe('edge')
    expect(onThin.point.y).toBeCloseTo(0.05, 9)
    expect(onThick.point.y).toBeCloseTo(0.2, 9)

    // 12 px clear of each face: neither does.
    expect(snapPoint(thin, { x: 3, y: 0.11 }, options).kind).toBe('none')
    expect(snapPoint(thick, { x: 3, y: 0.26 }, options).kind).toBe('none')

    // The same cursor either side of the comparison: thickness buys no extra
    // reach, so a 0.4 m wall no longer pulls from where a 0.1 m one would not.
    expect(snapPoint(thin, { x: 3, y: 0.3 }, options).kind).toBe('none')
    expect(snapPoint(thick, { x: 3, y: 0.3 }, options).kind).toBe('none')
  })

  it('tightens as you zoom in instead of stopping at a wall thickness', () => {
    const clearOfTheFace = { x: 3, y: 0.3 }
    const zoomedOut = snapPoint(thick, clearOfTheFace, { ...options, scale: 0.02 })
    expect(zoomedOut.kind).toBe('edge')
    expect(zoomedOut.point.x).toBeCloseTo(3, 9)
    expect(zoomedOut.point.y).toBeCloseTo(0.2, 9)

    expect(snapPoint(thick, clearOfTheFace, { ...options, scale: 0.005 }).kind).toBe('none')
    expect(snapPoint(thick, clearOfTheFace, { ...options, scale: 0.0001 }).kind).toBe('none')
  })

  it('treats the body of a thick wall as out of reach when zoomed right in', () => {
    // The price of measuring from the faces: at 5 mm per pixel a cursor 0.1 m
    // inside a 0.4 m wall is 20 px from the nearer face, so it snaps to nothing.
    expect(snapPoint(thick, { x: 3, y: 0.1 }, options).kind).toBe('none')
    expect(snapPoint(thick, { x: 3, y: -0.1 }, options).kind).toBe('none')

    // At a working 30 mm per pixel the whole body is in reach again, and either
    // side of it lands on the face the cursor was nearest.
    const working = { ...options, scale: 0.03 }
    expect(snapPoint(thick, { x: 3, y: 0.1 }, working).point.y).toBeCloseTo(0.2, 9)
    expect(snapPoint(thick, { x: 3, y: -0.1 }, working).point.y).toBeCloseTo(-0.2, 9)
    // Dead on the centreline there is no side to prefer, and it still picks a
    // face: a point half a thickness out, not the centreline itself.
    expect(Math.abs(snapPoint(thick, { x: 3, y: 0 }, working).point.y)).toBeCloseTo(0.2, 9)
  })
})

describe('alignment guides', () => {
  const options = { scale: 0.02, tolerancePx: 12, gridSnap: false }

  it('runs the horizontal guide past the object it claims alignment with', () => {
    // A guide that stops short of its own anchor is a line pointing at nothing:
    // the user cannot see what the cursor has lined up with.
    const doc = docWith({ servicePoints: [service('counter', 60, 3)] })
    const result = snapPoint(doc, { x: 0, y: 3.05 }, options)
    expect(result.kind).toBe('align-y')
    expect(result.point).toEqual({ x: 0, y: 3 })
    expect(result.guides).toEqual([
      { from: { x: -40, y: 3 }, to: { x: 100, y: 3 }, kind: 'align-y' },
    ])
  })

  it('runs the vertical guide past the object above or below the cursor', () => {
    const doc = docWith({ servicePoints: [service('counter', 3, 60)] })
    const result = snapPoint(doc, { x: 3.05, y: 0 }, options)
    expect(result.kind).toBe('align-x')
    expect(result.point).toEqual({ x: 3, y: 0 })
    expect(result.guides).toEqual([
      { from: { x: 3, y: -40 }, to: { x: 3, y: 100 }, kind: 'align-x' },
    ])
  })

  it('draws one guide to each object when both axes line up at once', () => {
    const doc = docWith({
      servicePoints: [service('counter', 60, 3), service('post', 0.1, 50)],
    })
    const result = snapPoint(doc, { x: 0, y: 3.05 }, options)
    expect(result.point).toEqual({ x: 0.1, y: 3 })
    expect(result.label).toBe('Aligned both ways')
    // Each guide starts at the corner and ends on the object that fixed that
    // axis, so the corner reads as the meeting of two known things.
    expect(result.guides).toEqual([
      { from: { x: 0.1, y: 3 }, to: { x: 0.1, y: 50 }, kind: 'align-x' },
      { from: { x: 0.1, y: 3 }, to: { x: 60, y: 3 }, kind: 'align-y' },
    ])
  })
})

describe('snapDelta', () => {
  it('reports the correction a whole selection should move by', () => {
    const doc = docWith({ walls: [wall('w', 4, 4, 4, 9, 0.1)] })
    const origin = { x: 1, y: 1 }
    const { delta, result } = snapDelta(
      doc,
      origin,
      { x: 3.94, y: 4.05 },
      {
        scale: 0.01,
        tolerancePx: 12,
      },
    )
    expect(result.kind).toBe('endpoint')
    expect(delta).toEqual({ x: 3, y: 3 })
  })
})

describe('constrainAngle', () => {
  const anchor = { x: 2, y: -1 }

  it('rounds to the nearest multiple and preserves the distance from the anchor', () => {
    const point = { x: anchor.x + Math.cos(0.7) * 5, y: anchor.y + Math.sin(0.7) * 5 }
    const out = constrainAngle(anchor, point, 45)
    expect(deg(Math.atan2(out.y - anchor.y, out.x - anchor.x))).toBeCloseTo(45, 9)
    expect(distance(anchor, out)).toBeCloseTo(5, 9)
  })

  it('is the identity for a non-positive step or a degenerate length', () => {
    const point = { x: 5, y: 5 }
    expect(constrainAngle(anchor, point, 0)).toBe(point)
    expect(constrainAngle(anchor, point, -15)).toBe(point)
    expect(constrainAngle(anchor, { ...anchor }, 15)).toEqual(anchor)
  })
})

describe('snapToGrid', () => {
  it('rounds each axis to the nearest multiple, negatives included', () => {
    expect(snapToGrid({ x: 2.44, y: 0.06 }, 0.5)).toEqual({ x: 2.5, y: 0 })
    const negative = snapToGrid({ x: -2.44, y: -0.76 }, 0.5)
    expect(negative.x).toBeCloseTo(-2.5, 9)
    expect(negative.y).toBeCloseTo(-1, 9)
  })
})
