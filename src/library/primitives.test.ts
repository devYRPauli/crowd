/**
 * The shape language every catalog entry is drawn in.
 *
 * Nothing here draws anything by itself: each helper returns plain data that
 * `render/builders/furnitureGeometry.ts` merges into one geometry, placing a
 * part at `x, y, z` — with `y` the centre of its own extent — and handing `rot`
 * to a Three.js Euler as a rotation about Y. These tests hold the helpers to
 * that contract, because a dimension in the wrong slot here is a lamp shade
 * upside down or a leg through the floor in every entry that uses it, with
 * nothing in the catalog data a review could catch.
 *
 * Nothing here is measured against `core/model/standards.ts`. That module holds
 * the sizes a building is ordered in — doors, windows, wall thickness — and
 * this one holds none: a 60 mm leg and a 30 mm foot disc are art direction, not
 * a size anybody orders a venue in.
 */

import { describe, expect, it } from 'vitest'
import type { BoxPrim, CylinderPrim, Prim } from './primitives'
import {
  box,
  cone,
  cyl,
  legs,
  pedestal,
  radial,
  rotated,
  sphere,
  torus,
  translated,
} from './primitives'

const TAU = Math.PI * 2

/** The smallest width or depth the inspector lets anybody type for an item. */
const MIN_EDITABLE = 0.1

const px = (prim: Prim): number => prim.x ?? 0
const py = (prim: Prim): number => prim.y ?? 0
const pz = (prim: Prim): number => prim.z ?? 0

const asBox = (prim: Prim): BoxPrim => {
  if (prim.type !== 'box') throw new Error(`expected a box, got a ${prim.type}`)
  return prim
}

const asCyl = (prim: Prim): CylinderPrim => {
  if (prim.type !== 'cyl') throw new Error(`expected a cylinder, got a ${prim.type}`)
  return prim
}

const underside = (prim: BoxPrim | CylinderPrim): number => py(prim) - prim.h / 2
const topside = (prim: BoxPrim | CylinderPrim): number => py(prim) + prim.h / 2

/**
 * Which way a part ends up pointing once the renderer turns `rot` into a
 * rotation about Y: its own +Z, in the item's floor plane.
 *
 * A Y rotation of θ carries +Z to (sin θ, cos θ) and +X to (cos θ, -sin θ), so
 * `rot` runs the opposite way round from every angle the plan itself measures —
 * the catalog's rings step +X toward +Z, and `PlanRenderer` negates a plan angle
 * on its way into Three (`makeRotationY(-item.rotation)`). Nothing negates
 * anything inside an item, which is the trap the last test in this file is
 * about.
 */
const heading = (prim: Prim): { x: number; z: number } => {
  const rot = prim.rot ?? 0
  return { x: Math.sin(rot), z: Math.cos(rot) }
}

/** Where a part sits around the axis, measured the way the catalog measures angles. */
const bearing = (prim: Prim): number => Math.atan2(pz(prim), px(prim))

const radius = (prim: Prim): number => Math.hypot(px(prim), pz(prim))

/**
 * How squarely a part faces away from the axis it sits on: 1 is straight out,
 * 0 is edge on, -1 is facing back across the axis.
 */
const outwardness = (prim: Prim): number =>
  (heading(prim).x * px(prim) + heading(prim).z * pz(prim)) / radius(prim)

const wrapped = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle))

describe('the parts a piece of furniture is drawn from', () => {
  it('hangs a part on the centre of its own extent', () => {
    const top = box(0, 0.73, 0, 1.6, 0.04, 0.8, 'wood')
    expect(top).toEqual({
      type: 'box',
      x: 0,
      y: 0.73,
      z: 0,
      w: 1.6,
      h: 0.04,
      d: 0.8,
      color: 'wood',
      rot: 0,
    })
    // Every table in the catalog draws its top at `height - 0.02` and stands it
    // on a base `height - 0.04` tall. Both land flush only because `y` is the
    // middle of the 40 mm board, not its underside.
    expect(underside(top)).toBeCloseTo(0.71, 12)
    expect(topside(top)).toBeCloseTo(0.75, 12)

    // The last argument turns a part about Y and leaves its extents alone. Were
    // it to land in `tilt`, which the renderer applies about X, the part would
    // lie down rather than turn.
    const turned = box(0.4, 0.5, -0.2, 0.9, 1, 0.1, 'metal', Math.PI / 4)
    expect([turned.rot, turned.tilt]).toEqual([Math.PI / 4, undefined])
    expect([turned.w, turned.h, turned.d]).toEqual([0.9, 1, 0.1])
  })

  it('tapers a cone from the radius at its top down to the one at its foot', () => {
    const shade = asCyl(cone(0, 1.2, 0, 0.09, 0.14, 0.36, 'glass', 14))
    expect(shade.r).toBeCloseTo(0.09, 12)
    expect(shade.r2).toBeCloseTo(0.14, 12)
    expect(shade.h).toBeCloseTo(0.36, 12)
    // The renderer feeds `r` to CylinderGeometry as the radius at the *top*.
    // Swap the pair and every shade, plant pot and waste bin in the catalog
    // stands on its rim.
    expect(shade.r).toBeLessThan(shade.r2 ?? shade.r)

    const post = cyl(0, 0.35, 0, 0.055, 0.7, 'metalDark')
    // A plain cylinder must leave the second radius alone rather than pin it,
    // so the renderer's own `r2 ?? r` keeps the sides parallel.
    expect(post.r2).toBeUndefined()
    expect(post.h).toBeCloseTo(0.7, 12)
  })

  it('gives every round part a facet count of its own rather than the renderer default', () => {
    // furnitureGeometry falls back to 16 sides (12 for a sphere) for a part
    // that names none, so dropping a default here silently re-meshes every item
    // built from it — in a catalog drawn as one merged buffer per entry, that
    // is vertex count nobody asked for.
    expect([
      cyl(0, 0, 0, 0.2, 1, 'metal').seg,
      cone(0, 0, 0, 0.1, 0.2, 0.4, 'stone').seg,
      sphere(0, 0, 0, 0.3, 'plant').seg,
      torus(0, 0, 0, 0.4, 0.02, 'chrome').seg,
    ]).toEqual([20, 16, 12, 20])

    const ring = torus(0, 0.2, 0, 0.44, 0.018, 'chrome', 16)
    expect([ring.r, ring.tube]).toEqual([0.44, 0.018])
    // Left unset rather than written out: the renderer reads a missing `arc` as
    // a full turn and a missing `open` as a capped cylinder, so a default of 0
    // spelled in here is a ring that draws nothing.
    expect(ring.arc).toBeUndefined()
    expect(cyl(0, 0, 0, 0.2, 1, 'metal').open).toBeUndefined()

    // A sphere is squashed by scaling it, so the neutral value is 1: a default
    // of 0 flattens every cushion and pot plant in the catalog to a disc.
    expect(sphere(0, 1, 0, 0.3, 'plant').squash).toBe(1)
    expect(sphere(0, 1, 0, 0.3, 'plant', 1.3, 8)).toMatchObject({ squash: 1.3, seg: 8, r: 0.3 })
  })
})

describe('legs under a top', () => {
  it('stands four legs on the floor, one at each corner of the footprint', () => {
    const height = 0.71
    const four = legs(1.2, 0.8, height, 'metal').map(asBox)
    expect(four).toHaveLength(4)
    for (const leg of four) {
      // 60 mm square, 60 mm in from both edges, unless the caller says otherwise.
      expect([leg.w, leg.d]).toEqual([0.06, 0.06])
      expect(Math.abs(px(leg)) + leg.w / 2).toBeCloseTo(0.54, 12)
      expect(Math.abs(pz(leg)) + leg.d / 2).toBeCloseTo(0.34, 12)
      // Tables pass `height - 0.04` and meet the underside of the board exactly,
      // so a leg any shorter leaves the top floating and any longer lifts it off
      // the height the item declares.
      expect(underside(leg)).toBeCloseTo(0, 12)
      expect(topside(leg)).toBeCloseTo(height, 12)
    }
    // One leg per quadrant: a doubled corner and a missing one read as four
    // legs in every count but the picture.
    expect(new Set(four.map((leg) => `${Math.sign(px(leg))}${Math.sign(pz(leg))}`)).size).toBe(4)
  })

  it('measures the inset from the edge of the top to the outside face of the leg', () => {
    // The trestle table's own settings. Measured to the leg's centre line
    // instead, half a leg hangs past the edge of the top at all four corners —
    // and on the 0.76 m depth that is a third of the way out from under it.
    const trestle = legs(1.83, 0.76, 0.71, 'metal', 0.05, 0.1).map(asBox)
    for (const leg of trestle) {
      expect(Math.abs(px(leg)) + leg.w / 2).toBeCloseTo(1.83 / 2 - 0.1, 12)
      expect(Math.abs(pz(leg)) + leg.d / 2).toBeCloseTo(0.76 / 2 - 0.1, 12)
    }
  })

  it('crosses its legs over once the top is narrower than the inset it is given', () => {
    // SUSPECTED BUG. `hz = d / 2 - inset - thickness / 2` is never clamped, so
    // it goes negative below `2 * inset + thickness` and the near pair of legs
    // is emitted behind the far pair; below `inset + thickness` the pairs are
    // outside the top altogether. Both thresholds — 0.25 m and 0.15 m on the
    // trestle table's own leg settings, and it resizes freely — are above the
    // 0.1 m the inspector's Depth field accepts, so this is a size a user can
    // type rather than a fuzzed one. At that depth 50 mm of steel stands proud
    // of each long edge, outside the footprint the navigation grid takes from
    // the item's declared size, so people are routed straight through it. I
    // would expect the corners to be pulled in to meet at the centre line
    // instead. Asserting what it does now.
    const crossed = legs(1.83, 0.24, 0.71, 'metal', 0.05, 0.1).map(asBox)
    expect(pz(crossed[0])).toBeCloseTo(0.005, 12)
    expect(pz(crossed[2])).toBeCloseTo(-0.005, 12)
    // Crossed but still hidden under a 0.24 m top, which is why nothing shows
    // until the top is narrower still.
    expect(Math.abs(pz(crossed[0])) + crossed[0].d / 2).toBeLessThan(0.24 / 2)

    const pinched = legs(1.83, MIN_EDITABLE, 0.71, 'metal', 0.05, 0.1).map(asBox)
    for (const leg of pinched) {
      expect(Math.abs(pz(leg)) + leg.d / 2 - MIN_EDITABLE / 2).toBeCloseTo(0.05, 12)
      // The long axis is untouched: only the pinched one folds through itself.
      expect(Math.abs(px(leg)) + leg.w / 2).toBeCloseTo(1.83 / 2 - 0.1, 12)
    }
  })
})

describe('a pedestal base', () => {
  it('runs a column from the floor to the underside of the top, on a foot that hides under it', () => {
    // A 6 ft banquet round: tables pass `height - 0.04`, the underside of the
    // 40 mm top they draw at `height - 0.02`.
    const [column, foot] = pedestal(0.71, 0.915, 'metalDark').map(asCyl)
    expect(underside(column)).toBeCloseTo(0, 12)
    expect(topside(column)).toBeCloseTo(0.71, 12)
    expect(underside(foot)).toBeCloseTo(0, 12)
    expect(foot.h).toBeCloseTo(0.03, 12)
    // A foot wider than the top it carries is the thing every guest at a
    // banquet round kicks, and it is drawn outside a footprint the navigation
    // grid took from the table.
    expect(foot.r).toBeCloseTo(0.41175, 12)
    expect(foot.r).toBeGreaterThan(column.r)
    // The column thickens with the top rather than staying a fixed stick, but
    // never thins away to nothing on a small one.
    expect(column.r).toBeCloseTo(0.1348, 12)
    expect(asCyl(pedestal(0.71, 0.25, 'chrome')[0]).r).toBeCloseTo(0.055, 12)

    // The foot takes the column's material unless it is given its own, which is
    // what lets a chrome poseur table stand on a dark disc.
    expect(foot.color).toBe('metalDark')
    expect(pedestal(0.71, 0.5, 'chrome', 'dark').map((part) => part.color)).toEqual([
      'chrome',
      'dark',
    ])
  })

  it('stands a small top on a foot narrower than its own column', () => {
    // SUSPECTED BUG. The column is `0.12 r + 0.025` and the foot a plain
    // `0.45 r`, so the foot loses the race below a top radius of 76 mm and the
    // base comes out wider where it meets the table than where it meets the
    // floor. A round table resizes uniformly, so the 0.1 m width the inspector
    // accepts is a 0.05 m radius: a 31 mm column balanced on a 22.5 mm disc,
    // rather than the "column and foot disc" the helper documents. I would
    // expect the foot to have a floor of its own, as the column has. Asserting
    // what it does.
    const [column, foot] = pedestal(0.71, MIN_EDITABLE / 2, 'metalDark').map(asCyl)
    expect(column.r).toBeCloseTo(0.031, 12)
    expect(foot.r).toBeCloseTo(0.0225, 12)
    expect(foot.r).toBeLessThan(column.r)

    // Twice that width and the base is the right way up again — no catalog
    // entry is anywhere near the crossover at its own size.
    const [wider, widerFoot] = pedestal(0.71, MIN_EDITABLE, 'metalDark').map(asCyl)
    expect(widerFoot.r).toBeGreaterThan(wider.r)
  })
})

describe('moving a sub-assembly around', () => {
  it('shifts every part of a group without disturbing the group it was handed', () => {
    const shell = [
      box(0, 0.45, 0, 0.45, 0.06, 0.45, 'fabric'),
      cyl(0.1, 0.2, -0.1, 0.02, 0.4, 'metal', 12),
    ]
    const [seat, post] = translated(shell, 1.5, 0, -0.25)

    expect([px(seat), py(seat), pz(seat)]).toEqual([1.5, 0.45, -0.25])
    expect(px(post)).toBeCloseTo(1.6, 12)
    expect(py(post)).toBeCloseTo(0.2, 12)
    expect(pz(post)).toBeCloseTo(-0.35, 12)
    // Everything that is not a position rides along untouched: a translate that
    // dropped `seg` or a colour would re-mesh and repaint the copy.
    expect(asCyl(post).seg).toBe(12)
    expect(post.color).toBe('metal')

    // Catalog entries share sub-assemblies — one `chairShell` builds several
    // items — so a translate that wrote through its input would drag the parts
    // of every item built after the first along with it.
    expect(shell.map(px)).toEqual([0, 0.1])
    expect(seat).not.toBe(shell[0])

    // A part authored without coordinates starts at the origin, as the renderer
    // reads it, rather than shifting to NaN and taking the whole merged
    // geometry's bounding sphere with it.
    const [bare] = translated([{ type: 'box', w: 1, h: 1, d: 1, color: 'white' }], 0.5, 0.25, -0.5)
    expect([px(bare), py(bare), pz(bare)]).toEqual([0.5, 0.25, -0.5])
  })
})

describe('repeating a sub-assembly around the axis', () => {
  it('swings a part around the axis at the height and radius it was drawn at', () => {
    const arm = box(0.6, 0.02, 0, 1.0, 0.04, 0.05, 'metal')
    const [quarter] = rotated([arm], Math.PI / 2)

    // Angles in item space run the way the rest of the product measures them —
    // the catalog's own leaf rings and the seat rings in `planBuilder` step +X
    // toward +Z — so a quarter turn carries a part from +X to +Z.
    expect(px(quarter)).toBeCloseTo(0, 12)
    expect(pz(quarter)).toBeCloseTo(0.6, 12)
    // A ring of parts stays on the floor it was drawn at; lifting one is a
    // spoke that no longer meets its hub.
    expect(py(quarter)).toBeCloseTo(0.02, 12)
    expect(radius(quarter)).toBeCloseTo(0.6, 12)
    expect(px(arm)).toBe(0.6)

    const twice = rotated(rotated([arm], 0.4), 0.9)[0]
    const once = rotated([arm], 1.3)[0]
    expect(px(twice)).toBeCloseTo(px(once), 12)
    expect(pz(twice)).toBeCloseTo(pz(once), 12)
    // The part's own turn is added to, not replaced: a pre-rotated part in a
    // group would otherwise snap square the moment the group was repeated.
    expect(twice.rot).toBeCloseTo(1.3, 12)

    // A hub part authored without coordinates stays on the axis rather than
    // being swung to NaN.
    const [hub] = rotated([{ type: 'cyl', y: 0.35, r: 0.04, h: 0.7, color: 'metal' }], 1.1)
    expect([px(hub), py(hub), pz(hub)]).toEqual([0, 0.35, 0])
  })

  it('turns each part against the arc it swings it along', () => {
    // SUSPECTED BUG. The positions turn one way and the parts turn the other.
    // `rotated` swings x,z from +X toward +Z — the convention the catalog's
    // rings and `planBuilder` use — but adds the same angle to `rot`, which the
    // renderer hands to a Three.js Euler, where a positive Y rotation takes +X
    // toward -Z. Every copy therefore comes out mirrored about its own radius,
    // twisted by twice the step. Negating the angle added to `rot` would make
    // this a rigid turn. Nothing in the catalog calls `rotated` or `radial`
    // today, which is why no item shows it. Asserting what it does now.
    const step = 0.4
    const outward = box(0, 0.5, 1.0, 0.4, 0.5, 0.06, 'fabric')
    expect(outwardness(outward)).toBeCloseTo(1, 12)

    const [swung] = rotated([outward], step)
    expect(radius(swung)).toBeCloseTo(1, 12)
    expect(outwardness(swung)).toBeCloseTo(Math.cos(2 * step), 12)

    // `radial` inherits it, so the one helper meant for rings of chairs, spokes
    // and hub fittings cannot draw one: a quarter of the way round, a part that
    // faced away from the axis faces straight back across it. Half a turn puts
    // it right again, which is how a ring of four hides the fault in two of its
    // copies.
    const ring = radial([outward], 4)
    expect(px(ring[1])).toBeCloseTo(-1, 12)
    expect(pz(ring[1])).toBeCloseTo(0, 12)
    expect(outwardness(ring[1])).toBeCloseTo(-1, 12)
    expect(outwardness(ring[2])).toBeCloseTo(1, 12)
  })

  it('repeats a group evenly around the axis from the angle it is given', () => {
    const spoke = [
      box(0.5, 0.02, 0, 0.9, 0.04, 0.04, 'metal'),
      cyl(0.9, 0.2, 0, 0.03, 0.4, 'metal', 8),
    ]
    const ring = radial(spoke, 4, Math.PI / 4)

    expect(ring).toHaveLength(8)
    for (let copy = 0; copy < 4; copy++) {
      const [arm, foot] = ring.slice(copy * 2, copy * 2 + 2)
      expect(wrapped(bearing(arm) - Math.PI / 4 - (copy * TAU) / 4)).toBeCloseTo(0, 12)
      // The group keeps its shape as it goes round: a copy whose parts drift
      // apart is a spoke that has come off its own foot.
      expect(radius(arm)).toBeCloseTo(radius(spoke[0]), 12)
      expect(Math.hypot(px(arm) - px(foot), pz(arm) - pz(foot))).toBeCloseTo(0.4, 12)
      expect(py(foot)).toBeCloseTo(0.2, 12)
    }

    // Without a start angle the first copy is the group exactly as authored, so
    // a builder can hand `radial` its own layout and get it back.
    const [first] = radial(spoke, 6)
    expect([px(first), pz(first)]).toEqual([0.5, 0])
    expect(radial(spoke, 6)).toHaveLength(12)
    expect(radial(spoke, 1).map((part) => [px(part), py(part), pz(part)])).toEqual(
      spoke.map((part) => [px(part), py(part), pz(part)]),
    )

    // Repeated no times is nothing drawn, not a divide by zero smeared through
    // the merged geometry as NaN positions.
    expect(radial(spoke, 0)).toEqual([])
    expect(spoke.map(px)).toEqual([0.5, 0.9])
  })
})
