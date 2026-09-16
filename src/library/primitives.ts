/**
 * A tiny declarative shape language for furniture.
 *
 * Catalog items describe themselves as a list of primitives rather than as
 * imported meshes. That keeps the whole product self-contained (no asset
 * downloads, instant load), lets every item resize sensibly, and gives one
 * consistent art direction across the catalog. The renderer turns these into
 * merged `BufferGeometry` once per catalog entry and instances them.
 *
 * Local axes: +X right (width), +Z forward/depth, +Y up. `y` is the centre of
 * each primitive, matching Three.js geometry origins. An item's own origin sits
 * at the centre of its footprint on the floor.
 */

export type MaterialRole =
  | 'wood'
  | 'woodDark'
  | 'woodLight'
  | 'metal'
  | 'metalDark'
  | 'chrome'
  | 'fabric'
  | 'fabricAlt'
  | 'leather'
  | 'glass'
  | 'screen'
  | 'emissive'
  | 'plastic'
  | 'stone'
  | 'white'
  | 'dark'
  | 'plant'
  | 'plantDark'
  | 'accent'
  | 'paper'
  | 'carpet'

interface PrimBase {
  color: MaterialRole
  x?: number
  y?: number
  z?: number
  /** Rotation about the local Y axis, in radians. */
  rot?: number
  /** Rotation about the local X axis, applied before `rot`. */
  tilt?: number
}

export interface BoxPrim extends PrimBase {
  type: 'box'
  w: number
  h: number
  d: number
}

export interface CylinderPrim extends PrimBase {
  type: 'cyl'
  /** Radius at the top. */
  r: number
  h: number
  /** Radius at the bottom; defaults to `r`. */
  r2?: number
  seg?: number
  open?: boolean
}

export interface SpherePrim extends PrimBase {
  type: 'sphere'
  r: number
  /** Vertical scale applied to the sphere. */
  squash?: number
  seg?: number
}

export interface TorusPrim extends PrimBase {
  type: 'torus'
  r: number
  tube: number
  seg?: number
  /** Sweep angle in radians; defaults to a full turn. */
  arc?: number
}

export type Prim = BoxPrim | CylinderPrim | SpherePrim | TorusPrim

export const box = (
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  d: number,
  color: MaterialRole,
  rot = 0,
): BoxPrim => ({ type: 'box', x, y, z, w, h, d, color, rot })

export const cyl = (
  x: number,
  y: number,
  z: number,
  r: number,
  h: number,
  color: MaterialRole,
  seg = 20,
): CylinderPrim => ({ type: 'cyl', x, y, z, r, h, color, seg })

export const cone = (
  x: number,
  y: number,
  z: number,
  rTop: number,
  rBottom: number,
  h: number,
  color: MaterialRole,
  seg = 16,
): CylinderPrim => ({ type: 'cyl', x, y, z, r: rTop, r2: rBottom, h, color, seg })

export const sphere = (
  x: number,
  y: number,
  z: number,
  r: number,
  color: MaterialRole,
  squash = 1,
  seg = 12,
): SpherePrim => ({ type: 'sphere', x, y, z, r, color, squash, seg })

export const torus = (
  x: number,
  y: number,
  z: number,
  r: number,
  tube: number,
  color: MaterialRole,
  seg = 20,
): TorusPrim => ({ type: 'torus', x, y, z, r, tube, color, seg })

/** Four legs inset from the corners of a `w × d` footprint. */
export const legs = (
  w: number,
  d: number,
  height: number,
  color: MaterialRole,
  thickness = 0.06,
  inset = 0.06,
): Prim[] => {
  // Pulled in to the centre line rather than past each other on a top narrower
  // than its own insets. Unclamped, the near pair crosses behind the far one
  // and then walks outside the footprint entirely — and the navigation grid
  // takes its footprint from the item's declared size, so that is steel the
  // renderer draws and people walk straight through.
  const hx = Math.max(0, w / 2 - inset - thickness / 2)
  const hz = Math.max(0, d / 2 - inset - thickness / 2)
  return [
    [-hx, -hz],
    [hx, -hz],
    [hx, hz],
    [-hx, hz],
  ].map(([x, z]) => box(x, height / 2, z, thickness, height, thickness, color))
}

/** A cylindrical pedestal base with a column and a foot disc. */
export const pedestal = (
  height: number,
  topRadius: number,
  color: MaterialRole,
  footColor: MaterialRole = color,
): Prim[] => [
  cyl(0, height / 2, 0, topRadius * 0.12 + 0.025, height, color, 14),
  cyl(0, 0.015, 0, topRadius * 0.45, 0.03, footColor, 20),
]

/** Translate a group of primitives. */
export const translated = (prims: Prim[], dx: number, dy: number, dz: number): Prim[] =>
  prims.map((p) => ({ ...p, x: (p.x ?? 0) + dx, y: (p.y ?? 0) + dy, z: (p.z ?? 0) + dz }))

/**
 * Rotate a group of primitives about the local Y axis.
 *
 * The angle is measured the way the rest of the product measures one — +X
 * toward +Z, as the catalog's rings and `planBuilder` do — but `rot` goes
 * straight to a Three.js Euler, where a positive Y rotation runs the other way.
 * So the part's own turn takes the angle negated: adding it to both mirrors
 * every copy about its own radius, and a ring of chairs comes out facing back
 * across the hub.
 */
export const rotated = (prims: Prim[], angle: number): Prim[] => {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return prims.map((p) => {
    const x = p.x ?? 0
    const z = p.z ?? 0
    return { ...p, x: x * c - z * s, z: x * s + z * c, rot: (p.rot ?? 0) - angle }
  })
}

/** Repeat a group `count` times, evenly spaced around the Y axis. */
export const radial = (prims: Prim[], count: number, startAngle = 0): Prim[] => {
  const out: Prim[] = []
  for (let i = 0; i < count; i++) {
    out.push(...rotated(prims, startAngle + (i / count) * Math.PI * 2))
  }
  return out
}
