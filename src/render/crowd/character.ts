/**
 * The character mesh.
 *
 * People are built from boxes rather than loaded from a rigged model: it keeps
 * the product a single download with no asset pipeline, and — more usefully —
 * it lets the whole crowd be one instanced draw call whose limbs are animated
 * in the vertex shader from a handful of per-instance numbers.
 *
 * Every vertex carries which limb it belongs to and which material zone it is
 * (skin, clothing, trousers, hair), so the shader can both pose it and colour
 * it per person without touching the geometry.
 */

import { BoxGeometry, BufferAttribute, BufferGeometry, Matrix4 } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/** Limb indices, matching the pivot table in the shader. */
export const LIMB = {
  body: 0,
  armLeft: 1,
  armRight: 2,
  thighLeft: 3,
  thighRight: 4,
  shinLeft: 5,
  shinRight: 6,
} as const

/** Material zones, used to pick a colour per vertex. */
export const ZONE = {
  skin: 0,
  top: 1,
  legs: 2,
  hair: 3,
} as const

/** Joint positions for a 1.75 m person, in metres. */
export const PIVOTS: Array<[number, number, number]> = [
  [0, 0, 0], // body
  [0.2, 1.38, 0], // left shoulder
  [-0.2, 1.38, 0], // right shoulder
  [0.095, 0.92, 0], // left hip
  [-0.095, 0.92, 0], // right hip
  [0.095, 0.48, 0], // left knee
  [-0.095, 0.48, 0], // right knee
]

interface Part {
  /** Centre of the box. */
  x: number
  y: number
  z: number
  w: number
  h: number
  d: number
  limb: number
  zone: number
}

const PARTS: Part[] = [
  // Pelvis and torso.
  { x: 0, y: 1.0, z: 0, w: 0.33, h: 0.2, d: 0.21, limb: LIMB.body, zone: ZONE.legs },
  { x: 0, y: 1.24, z: 0, w: 0.36, h: 0.32, d: 0.22, limb: LIMB.body, zone: ZONE.top },
  { x: 0, y: 1.42, z: 0, w: 0.3, h: 0.1, d: 0.2, limb: LIMB.body, zone: ZONE.top },
  // Neck and head.
  { x: 0, y: 1.5, z: 0, w: 0.09, h: 0.07, d: 0.09, limb: LIMB.body, zone: ZONE.skin },
  { x: 0, y: 1.63, z: 0, w: 0.19, h: 0.21, d: 0.2, limb: LIMB.body, zone: ZONE.skin },
  { x: 0, y: 1.71, z: -0.01, w: 0.2, h: 0.08, d: 0.21, limb: LIMB.body, zone: ZONE.hair },
  // Arms: upper in the top colour, forearm and hand in skin.
  { x: 0.2, y: 1.22, z: 0, w: 0.1, h: 0.28, d: 0.11, limb: LIMB.armLeft, zone: ZONE.top },
  { x: 0.2, y: 0.98, z: 0, w: 0.085, h: 0.24, d: 0.095, limb: LIMB.armLeft, zone: ZONE.skin },
  { x: -0.2, y: 1.22, z: 0, w: 0.1, h: 0.28, d: 0.11, limb: LIMB.armRight, zone: ZONE.top },
  { x: -0.2, y: 0.98, z: 0, w: 0.085, h: 0.24, d: 0.095, limb: LIMB.armRight, zone: ZONE.skin },
  // Legs.
  { x: 0.095, y: 0.7, z: 0, w: 0.135, h: 0.44, d: 0.145, limb: LIMB.thighLeft, zone: ZONE.legs },
  { x: -0.095, y: 0.7, z: 0, w: 0.135, h: 0.44, d: 0.145, limb: LIMB.thighRight, zone: ZONE.legs },
  { x: 0.095, y: 0.27, z: 0, w: 0.115, h: 0.42, d: 0.125, limb: LIMB.shinLeft, zone: ZONE.legs },
  { x: -0.095, y: 0.27, z: 0, w: 0.115, h: 0.42, d: 0.125, limb: LIMB.shinRight, zone: ZONE.legs },
  { x: 0.095, y: 0.035, z: 0.015, w: 0.12, h: 0.07, d: 0.2, limb: LIMB.shinLeft, zone: ZONE.hair },
  { x: -0.095, y: 0.035, z: 0.015, w: 0.12, h: 0.07, d: 0.2, limb: LIMB.shinRight, zone: ZONE.hair },
]

/** Build the character geometry, with `aLimb` and `aZone` vertex attributes. */
export const buildCharacterGeometry = (detail: 'full' | 'simple' = 'full'): BufferGeometry => {
  const source = detail === 'full' ? PARTS : simplify(PARTS)
  const matrix = new Matrix4()
  const pieces: BufferGeometry[] = []
  for (const part of source) {
    const geometry = new BoxGeometry(part.w, part.h, part.d)
    matrix.makeTranslation(part.x, part.y, part.z)
    geometry.applyMatrix4(matrix)
    geometry.deleteAttribute('uv')
    const count = geometry.getAttribute('position').count
    geometry.setAttribute('aLimb', new BufferAttribute(new Float32Array(count).fill(part.limb), 1))
    geometry.setAttribute('aZone', new BufferAttribute(new Float32Array(count).fill(part.zone), 1))
    pieces.push(geometry)
  }
  const merged = mergeGeometries(pieces, false)
  for (const piece of pieces) piece.dispose()
  if (!merged) return new BufferGeometry()
  merged.computeBoundingSphere()
  return merged
}

/** A cheaper model for people far from the camera: one block per limb, no extremities. */
const simplify = (parts: Part[]): Part[] =>
  parts.filter((part) => part.zone !== ZONE.hair).map((part) => ({ ...part }))

/** Skin tones, sampled by a per-instance value. */
export const SKIN_TONES = [
  '#f2d2b6',
  '#e5b895',
  '#c98f68',
  '#a06a44',
  '#79482c',
  '#5a341f',
]

export const LEG_COLORS = ['#3a4355', '#4a4a52', '#2f3a46', '#5a4e44', '#36455a']
export const HAIR_COLORS = ['#2b2118', '#3f2d20', '#6b4a2a', '#8c8c8c', '#1b1b1f']
