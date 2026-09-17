import { describe, expect, it, vi } from 'vitest'
import { Box3, BufferGeometry, Vector3 } from 'three'
import {
  buildFloorGeometry,
  buildOpeningGeometry,
  buildWallGeometry,
  openingMarkers,
  polygonGeometry,
} from './planMeshes'
import type { Opening, Plan, Wall } from '../../core/model/types'
import type { Vec2 } from '../../core/math/vec2'

let counter = 0

const wall = (ax: number, ay: number, bx: number, by: number, extra: Partial<Wall> = {}): Wall => ({
  id: `w${counter++}`,
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
  thickness: 0.2,
  height: 3,
  kind: 'wall',
  ...extra,
})

/** A 3'0" x 6'8" leaf — the stock entry door, and what the editor defaults to. */
const LEAF = 0.914
const HEAD = 2.032

/** How far the leaf is swung open, and how thick it is drawn, per planMeshes. */
const SWING = 1.4
const LEAF_HALF_THICKNESS = 0.0225

const door = (host: Wall, offset: number, extra: Partial<Opening> = {}): Opening => ({
  id: `o${counter++}`,
  wallId: host.id,
  offset,
  width: LEAF,
  height: HEAD,
  sill: 0,
  kind: 'door',
  ...extra,
})

const plan = (walls: Wall[], openings: Opening[] = []): Plan => ({
  walls,
  openings,
  furniture: [],
  zones: [],
  servicePoints: [],
})

const points = (geometry: BufferGeometry): Vector3[] => {
  const attribute = geometry.getAttribute('position')
  const out: Vector3[] = []
  for (let i = 0; i < attribute.count; i++) {
    out.push(new Vector3().fromBufferAttribute(attribute, i))
  }
  return out
}

/** Every box contributes 24 vertices, so this counts the slabs in a merged wall. */
const slabCount = (geometry: BufferGeometry): number => geometry.getAttribute('position').count / 24

/** The merged geometry split back into the boxes it was built from. */
const slabs = (geometry: BufferGeometry): Box3[] => {
  const all = points(geometry)
  const out: Box3[] = []
  for (let i = 0; i < all.length; i += 24) {
    out.push(new Box3().setFromPoints(all.slice(i, i + 24)))
  }
  return out
}

/**
 * Is there wall material at this world point? Only meaningful for walls run
 * along an axis, where a slab's bounding box is the slab.
 */
const solidAt = (geometry: BufferGeometry, x: number, y: number, z = 0): boolean =>
  slabs(geometry).some((slab) => slab.containsPoint(new Vector3(x, y, z)))

const bounds = (geometry: BufferGeometry): Box3 => new Box3().setFromPoints(points(geometry))

describe('wall geometry', () => {
  it('cuts a doorway out of the wall and hangs a lintel over it', () => {
    const run = wall(0, 0, 6, 0)
    const { solid, glass } = buildWallGeometry(plan([run], [door(run, 3)]))
    expect(solid).not.toBeNull()
    // An opaque wall contributes nothing to the glazed pass.
    expect(glass).toBeNull()

    // Two solid spans either side of the leaf, plus the lintel over it.
    expect(slabCount(solid!)).toBe(3)
    expect(solidAt(solid!, 3, 1.0)).toBe(false)
    expect(solidAt(solid!, 3, HEAD + 0.3)).toBe(true)
    // The hole is exactly the leaf, so the jambs land on the opening's edges.
    const belowHead = points(solid!).filter((p) => p.y < HEAD - 1e-6)
    expect(Math.max(...belowHead.filter((p) => p.x < 3).map((p) => p.x))).toBeCloseTo(
      3 - LEAF / 2,
      6,
    )
    expect(Math.min(...belowHead.filter((p) => p.x > 3).map((p) => p.x))).toBeCloseTo(
      3 + LEAF / 2,
      6,
    )
    // The lintel bridges the doorway from its head to the top of the wall.
    const lintel = slabs(solid!).find((slab) => slab.min.x > 2 && slab.max.x < 4)!
    expect(lintel.min.y).toBeCloseTo(HEAD, 6)
    expect(lintel.max.y).toBeCloseTo(3, 6)

    const box = bounds(solid!)
    // The run keeps its full length and height, centred on its own centreline.
    expect(box.min.x).toBeCloseTo(0, 6)
    expect(box.max.x).toBeCloseTo(6, 6)
    expect(box.max.y).toBeCloseTo(3, 6)
    expect(box.min.z).toBeCloseTo(-0.1, 6)
    expect(box.max.z).toBeCloseTo(0.1, 6)
  })

  it('leaves only a lintel when the door reaches the end of its wall', () => {
    const run = wall(0, 0, 6, 0)
    // Centred at 0.3 the leaf runs off the end, so it is clipped there.
    const { solid } = buildWallGeometry(plan([run], [door(run, 0.3)]))
    expect(slabCount(solid!)).toBe(2)
    expect(solidAt(solid!, 0.1, 1)).toBe(false)
    expect(bounds(solid!).min.x).toBeCloseTo(0, 6)
    const jamb = points(solid!).filter((p) => p.y < 1)
    expect(Math.min(...jamb.map((p) => p.x))).toBeCloseTo(0.3 + LEAF / 2, 6)
  })

  it('merges two overlapping doors into one hole', () => {
    const run = wall(0, 0, 8, 0)
    const pair = [door(run, 3, { width: 1 }), door(run, 3.5, { width: 1 })]
    const { solid } = buildWallGeometry(plan([run], pair))
    // Two spans and a lintel per opening; the lintels overlap, the hole is one.
    expect(slabCount(solid!)).toBe(4)
    for (const x of [2.6, 3.25, 3.9]) expect(solidAt(solid!, x, 1)).toBe(false)
    expect(solidAt(solid!, 2.4, 1)).toBe(true)
    expect(solidAt(solid!, 4.1, 1)).toBe(true)
  })

  it('clips an opening wider than the wall it is cut into', () => {
    const run = wall(0, 0, 2, 0)
    const { solid } = buildWallGeometry(plan([run], [door(run, 1, { width: 10 })]))
    // Nothing solid is left at floor level, only the lintel across the whole run.
    expect(slabCount(solid!)).toBe(1)
    const box = bounds(solid!)
    expect(box.min.x).toBeCloseTo(0, 6)
    expect(box.max.x).toBeCloseTo(2, 6)
    expect(box.min.y).toBeCloseTo(HEAD, 6)
  })

  it('drops an opening taller than the wall rather than building a lintel of nothing', () => {
    const run = wall(0, 0, 6, 0, { height: 2 })
    const { solid } = buildWallGeometry(plan([run], [door(run, 3, { height: 2.4 })]))
    expect(slabCount(solid!)).toBe(2)
    expect(bounds(solid!).max.y).toBeCloseTo(2, 6)
  })

  it('glazes a window and frames it above and below', () => {
    const run = wall(0, 0, 6, 0)
    const opening = door(run, 3, { kind: 'window', width: 1.2, height: 1.2, sill: 0.9 })
    const { solid, glass } = buildWallGeometry(plan([run], [opening]))

    expect(glass).not.toBeNull()
    expect(slabCount(glass!)).toBe(1)
    const pane = bounds(glass!)
    expect(pane.min.y).toBeCloseTo(0.9, 6)
    expect(pane.max.y).toBeCloseTo(2.1, 6)
    // The pane is thinner than the wall and set in from the reveal, so it does
    // not z-fight with the masonry around it.
    expect(pane.max.z - pane.min.z).toBeCloseTo(0.2 * 0.3, 6)
    expect(pane.min.x).toBeCloseTo(2.4 + 0.02, 6)
    expect(pane.max.x).toBeCloseTo(3.6 - 0.02, 6)

    // A window is not a way through, so the wall below the sill stays solid.
    expect(solidAt(solid!, 3, 0.4)).toBe(true)

    // SUSPECTED BUG: the glazed band is never cut out of the wall. `solidSpans`
    // only opens up walkable openings (planGeometry.ts:93-96, via
    // `isWalkableOpening` at :27-28), so the span across a window is built at
    // full height (planMeshes.ts:64-67) and the sill and head slabs
    // (planMeshes.ts:78-83) are laid over solid wall. The pane is buried inside
    // that span: a window renders as blank wall, and the plan carries three
    // slabs of geometry nobody can see. The fix is to split the spans around
    // every opening, not just the walkable ones, and let the sill and head fill
    // the rest of the reveal.
    const glazedBand = [1.0, 1.5, 2.0]
    for (const y of glazedBand) expect(solidAt(solid!, 3, y)).toBe(true)
    // One full-height span plus the sill and head laid over it, instead of the
    // two spans and two reveal slabs a cut-out window would give.
    expect(slabCount(solid!)).toBe(3)
    expect(bounds(solid!).max.x).toBeCloseTo(6, 6)
    expect(bounds(solid!).min.x).toBeCloseTo(0, 6)
  })

  it('draws a wall of glass entirely in the glazed pass', () => {
    const run = wall(0, 0, 6, 0, { kind: 'glass' })
    const { solid, glass } = buildWallGeometry(plan([run], [door(run, 3)]))
    // Nothing opaque: a glass wall that also drew a solid mesh would be lit twice.
    expect(solid).toBeNull()
    expect(slabCount(glass!)).toBe(3)
  })

  it('builds a wall running north across its thickness, not along it', () => {
    const run = wall(0, 0, 0, 6, { thickness: 0.3 })
    const { solid } = buildWallGeometry(plan([run]))
    const box = bounds(solid!)
    // Plan y is world z; the thickness has to end up on the other axis.
    expect(box.min.x).toBeCloseTo(-0.15, 6)
    expect(box.max.x).toBeCloseTo(0.15, 6)
    expect(box.min.z).toBeCloseTo(0, 6)
    expect(box.max.z).toBeCloseTo(6, 6)
    expect(box.max.y).toBeCloseTo(3, 6)
  })

  it('keeps an angled wall on its own centreline', () => {
    const run = wall(0, 0, 4, 4)
    const { solid } = buildWallGeometry(plan([run]))
    const direction = new Vector3(1, 0, 1).normalize()
    let maxOffset = 0
    let minAlong = Infinity
    let maxAlong = -Infinity
    for (const p of points(solid!)) {
      const flat = new Vector3(p.x, 0, p.z)
      const along = flat.dot(direction)
      minAlong = Math.min(minAlong, along)
      maxAlong = Math.max(maxAlong, along)
      maxOffset = Math.max(maxOffset, flat.clone().addScaledVector(direction, -along).length())
    }
    // A wall drawn at an angle has to stay the thickness it was drawn at; a
    // rotation applied on the wrong axis fattens it by up to root two.
    expect(maxOffset).toBeCloseTo(0.1, 6)
    expect(minAlong).toBeCloseTo(0, 6)
    expect(maxAlong).toBeCloseTo(Math.hypot(4, 4), 6)
  })

  it('returns every wall in the plan as one mesh', () => {
    // The whole plan's masonry is one draw call, so four walls of three
    // different bearings have to merge — which they only can while every piece
    // carries the same attributes. A builder that left the uvs on one of them
    // would fail here rather than silently at the first render.
    const north = wall(0, 0, 6, 0)
    const east = wall(6, 0, 6, 4)
    const south = wall(6, 4, 0, 4)
    const west = wall(0, 4, 0, 0)
    const { solid } = buildWallGeometry(plan([north, east, south, west], [door(north, 3)]))

    // Two spans and a lintel where the door is, one slab for each other wall.
    expect(slabCount(solid!)).toBe(6)
    const box = bounds(solid!)
    expect(box.min.x).toBeCloseTo(-0.1, 6)
    expect(box.max.x).toBeCloseTo(6.1, 6)
    expect(box.min.z).toBeCloseTo(-0.1, 6)
    expect(box.max.z).toBeCloseTo(4.1, 6)
    // The doorway is still a hole once its wall is one of four.
    expect(solidAt(solid!, 3, 1)).toBe(false)
    expect(solidAt(solid!, 3, HEAD + 0.3)).toBe(true)
  })

  it('draws nothing for a wall of no length, or a plan with no walls', () => {
    const degenerate = wall(2, 2, 2, 2)
    expect(buildWallGeometry(plan([degenerate]))).toEqual({ solid: null, glass: null })
    expect(buildWallGeometry(plan([]))).toEqual({ solid: null, glass: null })
  })
})

describe('opening geometry', () => {
  it('hangs a door leaf from its jamb, swung clear of the doorway', () => {
    const run = wall(0, 0, 6, 0)
    const leaf = buildOpeningGeometry(plan([run], [door(run, 3, { swing: 'left' })]))
    expect(leaf).not.toBeNull()
    expect(slabCount(leaf!)).toBe(1)

    const box = bounds(leaf!)
    // Hinged at the left jamb, not at the centre of the opening: a leaf that
    // pivots about the middle of its own doorway reads as a turnstile.
    expect(box.min.x).toBeCloseTo(3 - LEAF / 2 - LEAF_HALF_THICKNESS * Math.sin(SWING), 6)
    // Swung 80 degrees into the room, so the swing reads in plan.
    expect(box.min.z).toBeCloseTo(
      -((LEAF - 0.03) * Math.sin(SWING) + LEAF_HALF_THICKNESS * Math.cos(SWING)),
      6,
    )
    // A 20 mm gap under the leaf, and the top just clear of the head.
    expect(box.min.y).toBeCloseTo(0.02, 6)
    expect(box.max.y).toBeCloseTo(HEAD - 0.02, 6)
  })

  it('hangs a right-hung door from the other jamb', () => {
    const run = wall(0, 0, 6, 0)
    const left = bounds(buildOpeningGeometry(plan([run], [door(run, 3, { swing: 'left' })]))!)
    const right = bounds(buildOpeningGeometry(plan([run], [door(run, 3, { swing: 'right' })]))!)
    expect(right.max.x).toBeCloseTo(3 + LEAF / 2 + LEAF_HALF_THICKNESS * Math.sin(SWING), 6)
    // Both open the same way; the hinge side is what the swing names.
    expect(right.min.z).toBeCloseTo(left.min.z, 6)
    expect(right.max.x - 3).toBeCloseTo(3 - left.min.x, 6)
  })

  it('splits a pair of doors into two leaves hinged at opposite jambs', () => {
    const run = wall(0, 0, 6, 0)
    const pair = door(run, 3, { kind: 'double-door', width: 1.8 })
    const geometry = buildOpeningGeometry(plan([run], [pair]))
    expect(slabCount(geometry!)).toBe(2)

    const [first, second] = slabs(geometry!)
    // Each leaf covers half the pair, less the 30 mm meeting gap, and neither
    // crosses the centre of the opening into the other's half.
    const half = 1.8 / 2 - 0.03
    expect(first.max.x).toBeLessThan(3)
    expect(second.min.x).toBeGreaterThan(3)
    // The pair is symmetric about the centre of the opening; a swing composed
    // in the wrong order leaves one leaf further out than the other.
    expect(3 - first.max.x).toBeCloseTo(second.min.x - 3, 9)
    // Both swing the same way, so the pair opens into one room rather than one
    // leaf each way.
    expect(first.min.z).toBeCloseTo(second.min.z, 9)
    expect(first.min.z).toBeCloseTo(
      -(half * Math.sin(SWING) + LEAF_HALF_THICKNESS * Math.cos(SWING)),
      6,
    )
  })

  it('never lets a leaf poke through the head of its wall', () => {
    const run = wall(0, 0, 6, 0, { height: 2.4 })
    const geometry = buildOpeningGeometry(plan([run], [door(run, 3, { height: 2.6 })]))
    expect(bounds(geometry!).max.y).toBeLessThanOrEqual(2.4)
  })

  it('frames a window at the head of its glazing and gives it no leaf', () => {
    const run = wall(0, 0, 6, 0)
    const opening = door(run, 3, { kind: 'window', width: 1.2, height: 1.2, sill: 0.9 })
    const geometry = buildOpeningGeometry(plan([run], [opening]))
    expect(slabCount(geometry!)).toBe(1)
    const box = bounds(geometry!)
    expect(box.max.y).toBeCloseTo(2.1 + 0.025, 6)
    expect(box.min.y).toBeCloseTo(2.1 - 0.025, 6)
    expect(box.max.x - box.min.x).toBeCloseTo(1.2, 6)
  })

  it('draws no leaf for a plain hole in a wall', () => {
    const run = wall(0, 0, 6, 0)
    expect(buildOpeningGeometry(plan([run], [door(run, 3, { kind: 'opening' })]))).toBeNull()
  })

  it('ignores an opening whose wall has gone', () => {
    const run = wall(0, 0, 6, 0)
    const orphan = { ...door(run, 3), wallId: 'deleted' }
    // Openings outlive their wall for as long as one undo step; the renderer
    // must not throw in between.
    expect(buildOpeningGeometry(plan([run], [orphan]))).toBeNull()
    expect(openingMarkers(plan([run], [orphan]))).toEqual([])
  })
})

describe('opening markers', () => {
  it('puts a marker on the centre of each opening, facing along its wall', () => {
    const run = wall(1, 1, 5, 5)
    const opening = door(run, Math.hypot(2, 2))
    const [marker] = openingMarkers(plan([run], [opening]))
    expect(marker.opening).toBe(opening)
    expect(marker.wall).toBe(run)
    expect(marker.angle).toBeCloseTo(Math.PI / 4, 9)
    // Two metres along a 45 degree wall from (1, 1).
    expect(marker.position.x).toBeCloseTo(3, 9)
    expect(marker.position.y).toBeCloseTo(3, 9)
  })
})

describe('floor geometry', () => {
  const square = (x: number, z: number, w: number, d: number): Vec2[] => [
    { x, y: z },
    { x: x + w, y: z },
    { x: x + w, y: z + d },
    { x, y: z + d },
  ]

  it('lays a room flat at the height it is given', () => {
    const geometry = polygonGeometry(square(0, 0, 4, 2), 0.05)
    const box = bounds(geometry)
    // Plan y becomes world z, so a room keeps its footprint.
    expect(box.min.x).toBeCloseTo(0, 6)
    expect(box.min.z).toBeCloseTo(0, 6)
    expect(box.max.x).toBeCloseTo(4, 6)
    expect(box.max.z).toBeCloseTo(2, 6)
    expect(box.min.y).toBeCloseTo(0.05, 6)
    expect(box.max.y).toBeCloseTo(0.05, 6)
    expect(geometry.getAttribute('uv')).toBeUndefined()
  })

  it('merges the rooms into one floor and frees the pieces it merged', () => {
    const dispose = vi.spyOn(BufferGeometry.prototype, 'dispose')
    const merged = buildFloorGeometry([square(0, 0, 4, 2), square(6, 0, 4, 2)])
    // A plan is rebuilt on every edit. Holding the per-room pieces would leak
    // one geometry per room per keystroke over an editing session.
    expect(dispose).toHaveBeenCalledTimes(2)
    dispose.mockRestore()

    const box = bounds(merged!)
    expect(box.min.x).toBeCloseTo(0, 6)
    expect(box.max.x).toBeCloseTo(10, 6)
  })

  it('skips polygons that are not rooms, and builds nothing from none', () => {
    expect(buildFloorGeometry([])).toBeNull()
    expect(
      buildFloorGeometry([
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      ]),
    ).toBeNull()
    const geometry = buildFloorGeometry([
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      square(0, 0, 2, 2),
    ])
    expect(geometry).not.toBeNull()
    expect(bounds(geometry!).max.x).toBeCloseTo(2, 6)
  })

  it('faces the floor away from the camera that looks at it', () => {
    // SUSPECTED BUG: `polygonGeometry` turns the plan into the ground plane with
    // rotateX(+PI/2) (planMeshes.ts:164), which maps plan y to world z but
    // leaves the shape's +Z face pointing down. Both the normals and the
    // triangle winding come out downward, so the floor is back-facing from
    // above — and `MaterialLibrary.floor()` is a front-side material, which is
    // what `PlanRenderer.rebuildFloors` hands it. The rest of the renderer uses
    // rotateX(-PI/2) for exactly this job (GroundGrid.ts:81,
    // DensityOverlay.ts:100). It costs the room floors: they are culled from the
    // only viewpoint the editor has, and lit from underneath if they are not.
    // The fix is to face the plane up and mirror the shape, not to rotate the
    // other way, which would flip every room about the x axis.
    const geometry = polygonGeometry(square(0, 0, 4, 2))
    const normal = geometry.getAttribute('normal')
    expect(normal.getY(0)).toBeCloseTo(-1, 6)

    const index = geometry.index!
    const corner = (i: number) =>
      new Vector3().fromBufferAttribute(geometry.getAttribute('position'), index.getX(i))
    const facing = new Vector3()
      .subVectors(corner(1), corner(0))
      .cross(new Vector3().subVectors(corner(2), corner(0)))
      .normalize()
    expect(facing.y).toBeCloseTo(-1, 6)
  })
})
