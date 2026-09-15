/**
 * Snapping and alignment guides.
 *
 * This is most of what separates a drawing tool that feels precise from one
 * that feels approximate. Candidates are gathered from the geometry already in
 * the plan — wall ends, wall centrelines, object centres and edges — and the
 * closest one within a *screen-space* tolerance wins, so snapping behaves the
 * same whether the user is zoomed to a whole floor or to a doorway.
 *
 * Priority runs from most specific to least: a wall endpoint beats a wall edge,
 * which beats an alignment guide, which beats the background grid.
 */

import type { Vec2 } from '../core/math/vec2'
import { add, distance, normalize, scale, sub } from '../core/math/vec2'
import { closestPointOnSegment, projectOnSegment } from '../core/math/geometry'
import type { CrowdDocument, Wall } from '../core/model/types'
import { furnitureVisualPolygon, servicePolygon, wallLength } from '../core/model/planGeometry'

export type SnapKind =
  | 'grid'
  | 'endpoint'
  | 'midpoint'
  | 'edge'
  | 'center'
  | 'align-x'
  | 'align-y'
  | 'angle'
  | 'extension'
  | 'none'

export interface SnapGuide {
  from: Vec2
  to: Vec2
  kind: SnapKind
}

export interface SnapResult {
  point: Vec2
  kind: SnapKind
  /** Lines the viewport should draw to explain the snap. */
  guides: SnapGuide[]
  /** Set when the point landed on a wall, for door and window placement. */
  wall?: { wall: Wall; offset: number }
  /** Short description for the status bar. */
  label?: string
}

export interface SnapOptions {
  /** Metres per screen pixel; snapping tolerance is defined in pixels. */
  scale: number
  /** Pixels within which a candidate wins. */
  tolerancePx?: number
  /** Anchor for angle and length constraints while drawing. */
  anchor?: Vec2 | null
  /** Constrain to multiples of this angle from the anchor, in degrees. 0 disables. */
  angleSnapDeg?: number
  /** Ignore these object ids when gathering candidates (e.g. the one being dragged). */
  exclude?: ReadonlySet<string>
  /** Turn off object snapping, leaving only the grid. */
  objectSnap?: boolean
  gridSnap?: boolean
  /** Suspend all snapping for this one move — what holding Alt does. */
  disabled?: boolean
  gridSize?: number
  /** Restrict snapping to points on walls; used by the door tool. */
  wallsOnly?: boolean
}

interface Candidate {
  point: Vec2
  kind: SnapKind
  priority: number
  guides?: SnapGuide[]
  wall?: { wall: Wall; offset: number }
  label?: string
}

const PRIORITY: Record<SnapKind, number> = {
  endpoint: 100,
  midpoint: 90,
  center: 85,
  edge: 70,
  extension: 60,
  'align-x': 50,
  'align-y': 50,
  angle: 40,
  grid: 10,
  none: 0,
}

const GUIDE_LENGTH = 40

/** Apply angle constraint from an anchor, preserving the projected distance. */
export const constrainAngle = (anchor: Vec2, point: Vec2, stepDeg: number): Vec2 => {
  if (stepDeg <= 0) return point
  const dx = point.x - anchor.x
  const dy = point.y - anchor.y
  const length = Math.hypot(dx, dy)
  if (length < 1e-6) return point
  const step = (stepDeg * Math.PI) / 180
  const angle = Math.round(Math.atan2(dy, dx) / step) * step
  return { x: anchor.x + Math.cos(angle) * length, y: anchor.y + Math.sin(angle) * length }
}

export const snapToGrid = (point: Vec2, size: number): Vec2 => ({
  x: Math.round(point.x / size) * size,
  y: Math.round(point.y / size) * size,
})

/** Every point in the plan worth snapping to, plus the walls to snap along. */
const gatherCandidates = (
  doc: CrowdDocument,
  raw: Vec2,
  tolerance: number,
  options: SnapOptions,
): Candidate[] => {
  const exclude = options.exclude ?? new Set<string>()
  const out: Candidate[] = []
  const near = (p: Vec2) => distance(p, raw) <= tolerance

  for (const wall of doc.plan.walls) {
    if (exclude.has(wall.id)) continue
    if (near(wall.a))
      out.push({ point: wall.a, kind: 'endpoint', priority: PRIORITY.endpoint, label: 'Wall end' })
    if (near(wall.b))
      out.push({ point: wall.b, kind: 'endpoint', priority: PRIORITY.endpoint, label: 'Wall end' })
    const mid = { x: (wall.a.x + wall.b.x) / 2, y: (wall.a.y + wall.b.y) / 2 }
    if (!options.wallsOnly && near(mid)) {
      out.push({
        point: mid,
        kind: 'midpoint',
        priority: PRIORITY.midpoint,
        label: 'Wall midpoint',
      })
    }
    const onWall = closestPointOnSegment(raw, wall.a, wall.b)
    if (distance(onWall, raw) <= tolerance + wall.thickness) {
      const t = projectOnSegment(raw, wall.a, wall.b)
      out.push({
        point: onWall,
        kind: 'edge',
        priority: PRIORITY.edge,
        wall: { wall, offset: t * wallLength(wall) },
        label: 'On wall',
      })
    }
    // Extending an existing wall's line is a common intent.
    if (!options.wallsOnly) {
      const dir = normalize(sub(wall.b, wall.a))
      for (const [end, sign] of [
        [wall.b, 1],
        [wall.a, -1],
      ] as Array<[Vec2, number]>) {
        const along = (raw.x - end.x) * dir.x * sign + (raw.y - end.y) * dir.y * sign
        if (along <= 0.05) continue
        const projected = add(end, scale(dir, along * sign))
        if (distance(projected, raw) <= tolerance) {
          out.push({
            point: projected,
            kind: 'extension',
            priority: PRIORITY.extension,
            guides: [{ from: end, to: projected, kind: 'extension' }],
            label: 'Wall extension',
          })
        }
      }
    }
  }

  if (options.wallsOnly) return out

  const considerPolygon = (id: string, polygon: Vec2[], center: Vec2, label: string) => {
    if (exclude.has(id)) return
    if (near(center)) out.push({ point: center, kind: 'center', priority: PRIORITY.center, label })
    for (const corner of polygon) {
      if (near(corner))
        out.push({ point: corner, kind: 'endpoint', priority: PRIORITY.endpoint - 5, label })
    }
  }

  for (const item of doc.plan.furniture) {
    considerPolygon(item.id, furnitureVisualPolygon(item), item.position, 'Furniture')
  }
  for (const point of doc.plan.servicePoints) {
    considerPolygon(point.id, servicePolygon(point), point.position, 'Service point')
  }
  for (const zone of doc.plan.zones) {
    if (exclude.has(zone.id)) continue
    for (const corner of zone.polygon) {
      if (near(corner))
        out.push({
          point: corner,
          kind: 'endpoint',
          priority: PRIORITY.endpoint - 10,
          label: 'Zone corner',
        })
    }
  }

  return out
}

/** Alignment guides: share an X or a Y with something already placed. */
const gatherAlignment = (
  doc: CrowdDocument,
  raw: Vec2,
  tolerance: number,
  exclude: ReadonlySet<string>,
): Candidate[] => {
  const anchors: Vec2[] = []
  for (const item of doc.plan.furniture) if (!exclude.has(item.id)) anchors.push(item.position)
  for (const point of doc.plan.servicePoints)
    if (!exclude.has(point.id)) anchors.push(point.position)
  for (const wall of doc.plan.walls) {
    if (exclude.has(wall.id)) continue
    anchors.push(wall.a, wall.b)
  }

  const out: Candidate[] = []
  let bestX: Vec2 | null = null
  let bestY: Vec2 | null = null
  for (const anchor of anchors) {
    if (Math.abs(anchor.x - raw.x) <= tolerance) {
      if (!bestX || Math.abs(anchor.x - raw.x) < Math.abs(bestX.x - raw.x)) bestX = anchor
    }
    if (Math.abs(anchor.y - raw.y) <= tolerance) {
      if (!bestY || Math.abs(anchor.y - raw.y) < Math.abs(bestY.y - raw.y)) bestY = anchor
    }
  }
  if (bestX) {
    out.push({
      point: { x: bestX.x, y: raw.y },
      kind: 'align-x',
      priority: PRIORITY['align-x'],
      guides: [
        {
          from: { x: bestX.x, y: Math.min(bestX.y, raw.y) - GUIDE_LENGTH },
          to: { x: bestX.x, y: Math.max(bestX.y, raw.y) + GUIDE_LENGTH },
          kind: 'align-x',
        },
      ],
      label: 'Aligned',
    })
  }
  if (bestY) {
    out.push({
      point: { x: raw.x, y: bestY.y },
      kind: 'align-y',
      priority: PRIORITY['align-y'],
      guides: [
        {
          from: { x: Math.min(bestX?.x ?? raw.x, raw.x) - GUIDE_LENGTH, y: bestY.y },
          to: { x: Math.max(raw.x, raw.x) + GUIDE_LENGTH, y: bestY.y },
          kind: 'align-y',
        },
      ],
      label: 'Aligned',
    })
  }
  // Both axes at once: snap to the exact corner they define.
  if (bestX && bestY) {
    out.push({
      point: { x: bestX.x, y: bestY.y },
      kind: 'align-x',
      priority: PRIORITY['align-x'] + 5,
      guides: [
        { from: { x: bestX.x, y: bestY.y }, to: { x: bestX.x, y: bestX.y }, kind: 'align-x' },
        { from: { x: bestX.x, y: bestY.y }, to: { x: bestY.x, y: bestY.y }, kind: 'align-y' },
      ],
      label: 'Aligned both ways',
    })
  }
  return out
}

export const snapPoint = (doc: CrowdDocument, raw: Vec2, options: SnapOptions): SnapResult => {
  if (options.disabled) return { point: raw, kind: 'none', guides: [] }
  const tolerancePx = options.tolerancePx ?? 12
  const tolerance = Math.max(0.02, tolerancePx * options.scale)
  const objectSnap = options.objectSnap ?? doc.settings.snapToObjects
  const gridSnap = options.gridSnap ?? doc.settings.snapToGrid
  const gridSize = options.gridSize ?? doc.settings.gridSize

  const candidates: Candidate[] = []
  if (objectSnap) {
    candidates.push(...gatherCandidates(doc, raw, tolerance, options))
    if (!options.wallsOnly) {
      candidates.push(...gatherAlignment(doc, raw, tolerance * 0.6, options.exclude ?? new Set()))
    }
  }

  if (options.anchor && (options.angleSnapDeg ?? 0) > 0) {
    const constrained = constrainAngle(options.anchor, raw, options.angleSnapDeg ?? 0)
    if (distance(constrained, raw) <= tolerance * 1.6) {
      candidates.push({
        point: constrained,
        kind: 'angle',
        priority: PRIORITY.angle,
        guides: [{ from: options.anchor, to: constrained, kind: 'angle' }],
      })
    }
  }

  if (gridSnap && !options.wallsOnly) {
    const snapped = snapToGrid(raw, gridSize)
    if (distance(snapped, raw) <= tolerance) {
      candidates.push({ point: snapped, kind: 'grid', priority: PRIORITY.grid })
    }
  }

  if (candidates.length === 0) {
    return { point: raw, kind: 'none', guides: [] }
  }

  candidates.sort((a, b) => {
    const priority = b.priority - a.priority
    if (priority !== 0) return priority
    return distance(a.point, raw) - distance(b.point, raw)
  })
  const best = candidates[0]
  return {
    point: best.point,
    kind: best.kind,
    guides: best.guides ?? [],
    ...(best.wall ? { wall: best.wall } : {}),
    ...(best.label ? { label: best.label } : {}),
  }
}

/**
 * Snapping for a point being dragged along with others: the whole selection
 * moves by one delta, so we snap the delta rather than each object.
 */
export const snapDelta = (
  doc: CrowdDocument,
  origin: Vec2,
  desired: Vec2,
  options: SnapOptions,
): { delta: Vec2; result: SnapResult } => {
  const result = snapPoint(doc, desired, options)
  return { delta: sub(result.point, origin), result }
}
