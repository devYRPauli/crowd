/**
 * Architectural geometry: floors, walls, and the openings cut into them.
 *
 * Openings are not cut with a CSG boolean. A wall is drawn as the solid spans
 * between its openings plus a lintel over each door and a sill under each
 * window — which is both how a builder would describe it and how the
 * simulation already models the wall, so the two can never drift apart.
 */

import { BoxGeometry, BufferGeometry, Matrix4, Shape, ShapeGeometry, Euler } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Opening, Plan, Wall } from '../../core/model/types'
import { isWalkableOpening, solidSpans, wallAngle, wallLength } from '../../core/model/planGeometry'
import type { Vec2 } from '../../core/math/vec2'
import type { Polygon } from '../../core/math/geometry'

const matrix = new Matrix4()
const euler = new Euler()

/** A box aligned to a wall, positioned by distance along it. */
const wallBox = (
  wall: Wall,
  start: number,
  end: number,
  bottom: number,
  top: number,
  thickness = wall.thickness,
): BufferGeometry | null => {
  const length = end - start
  const height = top - bottom
  if (length <= 1e-4 || height <= 1e-4) return null
  const geometry = new BoxGeometry(length, height, thickness)
  const angle = wallAngle(wall)
  const mid = start + length / 2
  euler.set(0, -angle, 0)
  matrix.makeRotationFromEuler(euler)
  matrix.setPosition(
    wall.a.x + Math.cos(angle) * mid,
    bottom + height / 2,
    wall.a.y + Math.sin(angle) * mid,
  )
  geometry.applyMatrix4(matrix)
  geometry.deleteAttribute('uv')
  return geometry
}

export interface WallMeshes {
  solid: BufferGeometry | null
  glass: BufferGeometry | null
}

/** Build the opaque and glazed geometry for every wall in the plan. */
export const buildWallGeometry = (plan: Plan): WallMeshes => {
  const solidParts: BufferGeometry[] = []
  const glassParts: BufferGeometry[] = []

  for (const wall of plan.walls) {
    const length = wallLength(wall)
    if (length <= 1e-4) continue
    const target = wall.kind === 'glass' ? glassParts : solidParts
    const openings = plan.openings.filter((o) => o.wallId === wall.id)

    for (const span of solidSpans(wall, plan.openings)) {
      const piece = wallBox(wall, span.start, span.end, 0, wall.height)
      if (piece) target.push(piece)
    }

    for (const opening of openings) {
      const start = Math.max(0, opening.offset - opening.width / 2)
      const end = Math.min(length, opening.offset + opening.width / 2)
      if (end <= start) continue
      if (isWalkableOpening(opening)) {
        // Lintel above a doorway.
        const lintel = wallBox(wall, start, end, Math.min(opening.height, wall.height), wall.height)
        if (lintel) target.push(lintel)
      } else {
        const sillTop = Math.min(opening.sill, wall.height)
        const headBottom = Math.min(opening.sill + opening.height, wall.height)
        const sill = wallBox(wall, start, end, 0, sillTop)
        if (sill) target.push(sill)
        const head = wallBox(wall, start, end, headBottom, wall.height)
        if (head) target.push(head)
        const pane = wallBox(wall, start + 0.02, end - 0.02, sillTop, headBottom, wall.thickness * 0.3)
        if (pane) glassParts.push(pane)
      }
    }
  }

  return {
    solid: solidParts.length ? mergeGeometries(solidParts, false) : null,
    glass: glassParts.length ? mergeGeometries(glassParts, false) : null,
  }
}

/** Door leaves and window frames, drawn as thin slabs. */
export const buildOpeningGeometry = (plan: Plan): BufferGeometry | null => {
  const parts: BufferGeometry[] = []
  for (const opening of plan.openings) {
    const wall = plan.walls.find((w) => w.id === opening.wallId)
    if (!wall) continue
    if (opening.kind === 'opening') continue
    const angle = wallAngle(wall)
    const half = opening.width / 2
    if (opening.kind === 'window') {
      const frame = new BoxGeometry(opening.width, 0.05, wall.thickness * 0.5)
      euler.set(0, -angle, 0)
      matrix.makeRotationFromEuler(euler)
      matrix.setPosition(
        wall.a.x + Math.cos(angle) * opening.offset,
        opening.sill + opening.height,
        wall.a.y + Math.sin(angle) * opening.offset,
      )
      frame.applyMatrix4(matrix)
      frame.deleteAttribute('uv')
      parts.push(frame)
      continue
    }
    // A door leaf, hinged open at 80 degrees so the swing reads in plan.
    const leaves = opening.kind === 'double-door' ? 2 : 1
    for (let i = 0; i < leaves; i++) {
      const leafWidth = opening.width / leaves - 0.03
      const side = leaves === 1 ? (opening.swing === 'right' ? 1 : -1) : i === 0 ? -1 : 1
      const hinge = opening.offset + side * half
      const swing = 1.4 * -side
      const leaf = new BoxGeometry(leafWidth, Math.min(opening.height, wall.height) - 0.04, 0.045)
      const local = new Matrix4()
      local.makeTranslation((leafWidth / 2) * -side, 0, 0)
      const rot = new Matrix4().makeRotationY(swing)
      const place = new Matrix4()
      euler.set(0, -angle, 0)
      place.makeRotationFromEuler(euler)
      place.setPosition(
        wall.a.x + Math.cos(angle) * hinge,
        (Math.min(opening.height, wall.height) - 0.04) / 2 + 0.02,
        wall.a.y + Math.sin(angle) * hinge,
      )
      leaf.applyMatrix4(local)
      leaf.applyMatrix4(rot)
      leaf.applyMatrix4(place)
      leaf.deleteAttribute('uv')
      parts.push(leaf)
    }
  }
  return parts.length ? mergeGeometries(parts, false) : null
}

/** A flat, horizontal polygon at the given height. */
export const polygonGeometry = (polygon: readonly Vec2[], height = 0): BufferGeometry => {
  const shape = new Shape()
  polygon.forEach((p, index) => {
    if (index === 0) shape.moveTo(p.x, p.y)
    else shape.lineTo(p.x, p.y)
  })
  shape.closePath()
  const geometry = new ShapeGeometry(shape)
  geometry.rotateX(Math.PI / 2)
  geometry.translate(0, height, 0)
  geometry.deleteAttribute('uv')
  return geometry
}

/** Merge a set of polygons into one flat floor geometry. */
export const buildFloorGeometry = (polygons: readonly Polygon[], height = 0): BufferGeometry | null => {
  const parts = polygons.filter((p) => p.length >= 3).map((p) => polygonGeometry(p, height))
  if (parts.length === 0) return null
  const merged = mergeGeometries(parts, false)
  for (const part of parts) part.dispose()
  return merged
}

/** The centre point and facing of each opening, for labels and markers. */
export const openingMarkers = (
  plan: Plan,
): Array<{ opening: Opening; position: Vec2; angle: number; wall: Wall }> => {
  const out: Array<{ opening: Opening; position: Vec2; angle: number; wall: Wall }> = []
  for (const opening of plan.openings) {
    const wall = plan.walls.find((w) => w.id === opening.wallId)
    if (!wall) continue
    const angle = wallAngle(wall)
    out.push({
      opening,
      wall,
      angle,
      position: {
        x: wall.a.x + Math.cos(angle) * opening.offset,
        y: wall.a.y + Math.sin(angle) * opening.offset,
      },
    })
  }
  return out
}
