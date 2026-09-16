/**
 * Select, move, rotate and resize.
 *
 * Direct manipulation without a 3D gizmo: handles are projected to screen space
 * and hit-tested there, so they behave identically in plan view and in a tilted
 * perspective view, and they never disappear behind geometry. Modifiers follow
 * the conventions people bring with them — Shift adds to the selection, Alt
 * duplicates, Shift while dragging constrains to an axis.
 */

import type { Tool, ToolContext } from '../types'
import { HANDLE_HIT_PX, type Handle } from '../types'
import type { PointerInfo } from '../../render/Viewport'
import type { CrowdDocument, PlanObjectRef, Wall } from '../../core/model/types'
import type { Vec2 } from '../../core/math/vec2'
import { add, angleOf, distance, rotate as rotateVec, sub } from '../../core/math/vec2'
import {
  boundsOf,
  closestPointOnSegment,
  distanceToSegment,
  pointInPolygon,
  polygonCentroid,
  segmentsIntersect,
} from '../../core/math/geometry'
import { objectFootprint, wallMidpoint } from '../geometryHelpers'
import {
  isLocked,
  updateFurniture,
  updateServicePoint,
  updateWall,
  updateZone,
  updateBackdrop,
} from '../../core/document/mutations'
import { newId } from '../../core/model/ids'
import { formatLength } from '../../core/model/units'
import { wallLength } from '../../core/model/planGeometry'

type Mode =
  | { kind: 'idle' }
  | { kind: 'maybe-drag'; start: Vec2; ref: PlanObjectRef; additive: boolean; duplicate: boolean }
  | {
      kind: 'move'
      start: Vec2
      origin: Map<string, Vec2>
      duplicate: boolean
      axis: 'free' | 'x' | 'y'
    }
  /**
   * `base` is the plan as it stood when the ring was taken hold of. Every frame
   * of a turn is computed from it rather than from the document the last frame
   * wrote: a wall and a zone carry no rotation field, so their corners would
   * otherwise be spun by the whole delta again on every move, and a pointer
   * that pauses on its way round would keep turning them.
   */
  | { kind: 'rotate'; center: Vec2; startAngle: number; base: CrowdDocument }
  | { kind: 'wall-endpoint'; wallId: string; end: 'a' | 'b'; other: Vec2 }
  | { kind: 'vertex'; zoneId: string; index: number }
  | { kind: 'marquee'; start: Vec2; current: Vec2 }

const ROTATE_HANDLE_OFFSET_PX = 46

/**
 * How close to a zone's outline a double-click has to land to add a corner to
 * it — roughly twice the handle hit radius, so aiming at an edge is forgiving
 * while a click in the body of a zone is plainly not aimed at one.
 */
const ADD_VERTEX_REACH_PX = 24

/** Selection centre, used as the pivot for rotation. */
const selectionCenter = (doc: CrowdDocument, refs: readonly PlanObjectRef[]): Vec2 | null => {
  const points: Vec2[] = []
  for (const ref of refs) {
    const polygon = objectFootprint(doc, ref.kind, ref.id)
    if (polygon) points.push(...polygon)
  }
  if (points.length === 0) return null
  const b = boundsOf(points)
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
}

/**
 * Does a footprint meet the rubber band?
 *
 * Corner containment alone misses the object most worth catching: a long wall
 * drawn straight across the band has neither end inside it, and the user who
 * just rubber-banded it has no way to tell why it was left behind. Crossing
 * edges catch it. A band drawn wholly inside a large footprint still catches
 * nothing, which is deliberate — it is how a row of tables standing on a
 * waiting zone is lifted off without taking the zone with them.
 */
const meetsBand = (polygon: readonly Vec2[], band: readonly Vec2[]): boolean => {
  if (polygon.some((p) => pointInPolygon(p, band))) return true
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]
    const b = polygon[(i + 1) % polygon.length]
    for (let j = 0; j < band.length; j++) {
      if (segmentsIntersect(a, b, band[j], band[(j + 1) % band.length])) return true
    }
  }
  return false
}

const positionOf = (doc: CrowdDocument, ref: PlanObjectRef): Vec2 | null => {
  switch (ref.kind) {
    case 'furniture':
      return doc.plan.furniture.find((f) => f.id === ref.id)?.position ?? null
    case 'service':
      return doc.plan.servicePoints.find((s) => s.id === ref.id)?.position ?? null
    case 'wall': {
      const wall = doc.plan.walls.find((w) => w.id === ref.id)
      return wall ? wallMidpoint(wall) : null
    }
    case 'zone': {
      const zone = doc.plan.zones.find((z) => z.id === ref.id)
      return zone ? polygonCentroid(zone.polygon) : null
    }
    case 'backdrop':
      return doc.plan.backdrop?.position ?? null
    default:
      return null
  }
}

const rotationOf = (doc: CrowdDocument, ref: PlanObjectRef): number => {
  switch (ref.kind) {
    case 'furniture':
      return doc.plan.furniture.find((f) => f.id === ref.id)?.rotation ?? 0
    case 'service':
      return doc.plan.servicePoints.find((s) => s.id === ref.id)?.rotation ?? 0
    case 'backdrop':
      return doc.plan.backdrop?.rotation ?? 0
    default:
      return 0
  }
}

/** Move one object by a delta, dispatching on its kind. */
const moveObject = (
  doc: CrowdDocument,
  ref: PlanObjectRef,
  from: Vec2,
  delta: Vec2,
): CrowdDocument => {
  const target = { x: from.x + delta.x, y: from.y + delta.y }
  switch (ref.kind) {
    case 'furniture':
      return updateFurniture(doc, ref.id, { position: target })
    case 'service': {
      const point = doc.plan.servicePoints.find((s) => s.id === ref.id)
      if (!point) return doc
      // A queue drawn by hand is a world-space centreline belonging to this
      // counter, so it travels with it — as it already does through a paste.
      // Left behind, people walk to where the till used to be and the queue
      // length the study reports is measured along a line nobody stands on.
      const shift = sub(target, point.position)
      return updateServicePoint(doc, ref.id, {
        position: target,
        ...(point.queue ? { queue: point.queue.map((p) => add(p, shift)) } : {}),
      })
    }
    case 'wall': {
      const wall = doc.plan.walls.find((w) => w.id === ref.id)
      if (!wall) return doc
      const mid = wallMidpoint(wall)
      const shift = { x: target.x - mid.x, y: target.y - mid.y }
      return updateWall(doc, ref.id, {
        a: { x: wall.a.x + shift.x, y: wall.a.y + shift.y },
        b: { x: wall.b.x + shift.x, y: wall.b.y + shift.y },
      })
    }
    case 'zone': {
      const zone = doc.plan.zones.find((z) => z.id === ref.id)
      if (!zone) return doc
      const center = polygonCentroid(zone.polygon)
      const shift = { x: target.x - center.x, y: target.y - center.y }
      return updateZone(doc, ref.id, {
        polygon: zone.polygon.map((p) => ({ x: p.x + shift.x, y: p.y + shift.y })),
      })
    }
    case 'backdrop':
      return updateBackdrop(doc, { position: target })
    default:
      return doc
  }
}

/**
 * Turn one object by `delta` about `pivot`.
 *
 * Everything is read out of `base` — the plan as it was when the gesture
 * started — and written into `doc`, so re-running the same angle lands on the
 * same place however many frames it takes. `orbit` carries the whole object
 * round the pivot; a lone object turns on the spot instead.
 */
const rotateObject = (
  doc: CrowdDocument,
  base: CrowdDocument,
  ref: PlanObjectRef,
  pivot: Vec2,
  delta: number,
  orbit: boolean,
): CrowdDocument => {
  const spin = (p: Vec2): Vec2 => add(pivot, rotateVec(sub(p, pivot), delta))
  const rotation = rotationOf(base, ref) + delta
  const basePosition = orbit ? positionOf(base, ref) : null
  const spun = basePosition ? spin(basePosition) : null
  switch (ref.kind) {
    case 'furniture':
      return updateFurniture(doc, ref.id, {
        rotation,
        ...(spun ? { position: spun } : {}),
      })
    case 'service':
      return updateServicePoint(doc, ref.id, {
        rotation,
        ...(spun ? { position: spun } : {}),
      })
    case 'backdrop':
      return updateBackdrop(doc, {
        rotation,
        ...(spun ? { position: spun } : {}),
      })
    case 'wall': {
      const wall = base.plan.walls.find((w) => w.id === ref.id)
      if (!wall) return doc
      return updateWall(doc, ref.id, { a: spin(wall.a), b: spin(wall.b) })
    }
    case 'zone': {
      const zone = base.plan.zones.find((z) => z.id === ref.id)
      if (!zone) return doc
      return updateZone(doc, ref.id, { polygon: zone.polygon.map(spin) })
    }
    default:
      return doc
  }
}

/** Copy the selected objects, returning the document and the new references. */
const duplicateSelection = (
  doc: CrowdDocument,
  refs: readonly PlanObjectRef[],
): { doc: CrowdDocument; refs: PlanObjectRef[] } => {
  let next = doc
  const created: PlanObjectRef[] = []
  for (const ref of refs) {
    if (ref.kind === 'furniture') {
      const item = next.plan.furniture.find((f) => f.id === ref.id)
      if (!item) continue
      const copy = { ...item, id: newId('item'), locked: false }
      next = { ...next, plan: { ...next.plan, furniture: [...next.plan.furniture, copy] } }
      created.push({ kind: 'furniture', id: copy.id })
    } else if (ref.kind === 'wall') {
      const wall = next.plan.walls.find((w) => w.id === ref.id)
      if (!wall) continue
      const copy = { ...wall, id: newId('wall'), locked: false }
      next = { ...next, plan: { ...next.plan, walls: [...next.plan.walls, copy] } }
      created.push({ kind: 'wall', id: copy.id })
    } else if (ref.kind === 'zone') {
      const zone = next.plan.zones.find((z) => z.id === ref.id)
      if (!zone) continue
      const copy = {
        ...zone,
        id: newId('zone'),
        polygon: zone.polygon.map((p) => ({ ...p })),
        locked: false,
      }
      next = { ...next, plan: { ...next.plan, zones: [...next.plan.zones, copy] } }
      created.push({ kind: 'zone', id: copy.id })
    } else if (ref.kind === 'service') {
      const point = next.plan.servicePoints.find((s) => s.id === ref.id)
      if (!point) continue
      const copy = {
        ...point,
        id: newId('svc'),
        locked: false,
        ...(point.queue ? { queue: point.queue.map((p) => ({ ...p })) } : {}),
      }
      next = { ...next, plan: { ...next.plan, servicePoints: [...next.plan.servicePoints, copy] } }
      created.push({ kind: 'service', id: copy.id })
    }
  }
  return { doc: next, refs: created }
}

export class SelectTool implements Tool {
  readonly id = 'select' as const
  readonly hint =
    'Click to select · Drag to move · Alt-drag to duplicate · Shift adds · Drag the ring to rotate'

  private mode: Mode = { kind: 'idle' }
  private lastInfo: PointerInfo | null = null

  /** Handles for the current selection, in world coordinates. */
  private handles(ctx: ToolContext): Handle[] {
    const doc = ctx.document
    const refs = ctx.selection
    if (refs.length === 0) return []
    const out: Handle[] = []

    if (refs.length === 1) {
      const ref = refs[0]
      if (ref.kind === 'wall') {
        const wall = doc.plan.walls.find((w) => w.id === ref.id)
        if (wall && !wall.locked) {
          out.push({ id: 'wall-a', position: wall.a, kind: 'endpoint' })
          out.push({ id: 'wall-b', position: wall.b, kind: 'endpoint' })
        }
      } else if (ref.kind === 'zone') {
        const zone = doc.plan.zones.find((z) => z.id === ref.id)
        if (zone && !zone.locked) {
          zone.polygon.forEach((point, index) =>
            out.push({ id: `vertex-${index}`, position: point, kind: 'vertex' }),
          )
        }
      }
    }

    // No ring over a selection that is locked solid. The endpoint and vertex
    // handles already go when an object is locked; a ring that stays, reads out
    // a quarter turn and leaves the wall where it was is a control that lies.
    const center = this.movable(ctx).length > 0 ? selectionCenter(doc, refs) : null
    if (center) {
      const points: Vec2[] = []
      for (const ref of refs) {
        const polygon = objectFootprint(doc, ref.kind, ref.id)
        if (polygon) points.push(...polygon)
      }
      const b = boundsOf(points)
      const offset = ROTATE_HANDLE_OFFSET_PX * ctx.scale
      out.push({
        id: 'rotate',
        position: { x: center.x, y: b.minY - offset },
        kind: 'rotate',
      })
    }
    return out
  }

  private handleAt(ctx: ToolContext, info: PointerInfo): Handle | null {
    for (const handle of this.handles(ctx)) {
      const screen = ctx.worldToScreen(handle.position)
      if (Math.hypot(screen.x - info.screenX, screen.y - info.screenY) <= HANDLE_HIT_PX) {
        return handle
      }
    }
    return null
  }

  /**
   * Ids to keep out of the snap candidates: a dragged object must not snap to
   * where it used to be. Nothing to do with the lock, despite the old name.
   */
  private selectedIds(ctx: ToolContext): Set<string> {
    const ids = new Set<string>()
    for (const ref of ctx.selection) ids.add(ref.id)
    return ids
  }

  /**
   * The part of the selection an edit is allowed to move.
   *
   * A locked object could be selected, dragged, rotated and nudged like any
   * other; only deleting it was refused. That makes the lock worse than no lock,
   * because it reads as protection and is not: the usual reason to lock a
   * traced backdrop or a finished shell is to stop knocking it out of place
   * while drawing over it, which is exactly what it did not prevent.
   *
   * Selecting a locked object is still allowed — the inspector is where you go
   * to unlock it — and so is dragging a mixed selection, which moves everything
   * in it that is not locked.
   */
  private movable(ctx: ToolContext): PlanObjectRef[] {
    return ctx.selection.filter((ref) => !isLocked(ctx.document, ref))
  }

  onPointerDown(info: PointerInfo, ctx: ToolContext): void {
    this.lastInfo = info
    if (!info.ground) return

    const handle = this.handleAt(ctx, info)
    if (handle) {
      if (handle.kind === 'rotate') {
        const center = selectionCenter(ctx.document, ctx.selection)
        if (!center) return
        this.mode = {
          kind: 'rotate',
          center,
          startAngle: angleOf(sub(info.ground, center)),
          base: ctx.document,
        }
        return
      }
      if (handle.kind === 'endpoint' && ctx.selection[0]?.kind === 'wall') {
        const wall = ctx.document.plan.walls.find((w) => w.id === ctx.selection[0].id)
        if (!wall) return
        const end = handle.id === 'wall-a' ? 'a' : 'b'
        this.mode = {
          kind: 'wall-endpoint',
          wallId: wall.id,
          end,
          other: end === 'a' ? wall.b : wall.a,
        }
        return
      }
      if (handle.kind === 'vertex' && ctx.selection[0]?.kind === 'zone') {
        this.mode = {
          kind: 'vertex',
          zoneId: ctx.selection[0].id,
          index: Number(handle.id.split('-')[1]),
        }
        return
      }
    }

    const hit = info.hit
    if (!hit) {
      if (!info.shiftKey) ctx.setSelection([])
      this.mode = { kind: 'marquee', start: info.ground, current: info.ground }
      return
    }

    const alreadySelected = ctx.selection.some(
      (ref) => ref.id === hit.ref.id && ref.kind === hit.ref.kind,
    )
    if (info.shiftKey) {
      ctx.toggleSelection(hit.ref)
      return
    }
    if (!alreadySelected) ctx.setSelection([hit.ref])
    this.mode = {
      kind: 'maybe-drag',
      start: info.ground,
      ref: hit.ref,
      additive: info.shiftKey,
      duplicate: info.altKey,
    }
  }

  onPointerMove(info: PointerInfo, ctx: ToolContext): void {
    this.lastInfo = info
    if (!info.ground) return

    switch (this.mode.kind) {
      case 'idle': {
        const handle = this.handleAt(ctx, info)
        ctx.setDraft(this.decorations(ctx, handle))
        return
      }
      case 'maybe-drag': {
        if (distance(info.ground, this.mode.start) < info.scale * 4) return
        const refs: PlanObjectRef[] = ctx.selection.length ? [...ctx.selection] : [this.mode.ref]
        let doc = ctx.document
        let working = refs
        if (this.mode.duplicate) {
          const copy = duplicateSelection(doc, refs)
          doc = copy.doc
          working = copy.refs
          ctx.apply(() => doc, 'Duplicate', 'duplicate')
          ctx.setSelection(working)
        }
        const origin = new Map<string, Vec2>()
        for (const ref of working) {
          const position = positionOf(doc, ref)
          if (position) origin.set(ref.id, { ...position })
        }
        this.mode = {
          kind: 'move',
          start: this.mode.start,
          origin,
          duplicate: this.mode.duplicate,
          axis: 'free',
        }
        return
      }
      case 'move': {
        const raw = sub(info.ground, this.mode.start)
        let delta = raw
        if (info.shiftKey) {
          delta = Math.abs(raw.x) > Math.abs(raw.y) ? { x: raw.x, y: 0 } : { x: 0, y: raw.y }
        }
        // Snap the leading object, then move everything by the resulting delta.
        const refs = ctx.selection
        const lead = refs[0]
        const leadOrigin = lead ? this.mode.origin.get(lead.id) : undefined
        if (leadOrigin) {
          const desired = add(leadOrigin, delta)
          const snapped = ctx.snap(desired, { exclude: this.selectedIds(ctx) })
          delta = sub(snapped.point, leadOrigin)
          ctx.setDraft([
            ...snapped.guides.map((guide) => ({
              kind: 'polyline' as const,
              points: [guide.from, guide.to],
              color: '#2f7df6',
            })),
          ])
        }
        const moving = this.movable(ctx)
        // An alt-drag is one gesture, so the copy and the move that carries it
        // off share the copy's key: undone as two steps, the first undo puts
        // the copy back exactly on top of the original, which looks like
        // nothing happened while the plan quietly holds two of everything.
        const duplicating = this.mode.duplicate
        ctx.apply(
          (doc) => {
            let next = doc
            for (const ref of moving) {
              const origin = this.mode.kind === 'move' ? this.mode.origin.get(ref.id) : undefined
              if (!origin) continue
              next = moveObject(next, ref, origin, delta)
            }
            return next
          },
          duplicating ? 'Duplicate' : 'Move',
          duplicating ? 'duplicate' : 'move-selection',
        )
        ctx.setLabels([
          {
            id: 'move-delta',
            text: `${formatLength(Math.hypot(delta.x, delta.y), ctx.document.settings.units)}`,
            x: info.ground.x,
            y: 0.5,
            z: info.ground.y,
            variant: 'dimension',
          },
        ])
        return
      }
      case 'rotate': {
        const current = angleOf(sub(info.ground, this.mode.center))
        let delta = current - this.mode.startAngle
        const step = info.shiftKey ? Math.PI / 36 : Math.PI / 12
        if (!info.altKey) delta = Math.round(delta / step) * step
        const refs = this.movable(ctx)
        const pivot = this.mode.center
        const base = this.mode.base
        ctx.apply(
          (doc) => {
            let next = doc
            for (const ref of refs) {
              next = rotateObject(next, base, ref, pivot, delta, refs.length > 1)
            }
            return next
          },
          'Rotate',
          'rotate-selection',
        )
        ctx.setLabels([
          {
            id: 'rotate-delta',
            text: `${((delta * 180) / Math.PI).toFixed(0)}°`,
            x: this.mode.center.x,
            y: 0.6,
            z: this.mode.center.y,
            variant: 'dimension',
          },
        ])
        return
      }
      case 'wall-endpoint': {
        const snapped = ctx.snap(info.ground, {
          anchor: this.mode.other,
          angleSnapDeg: ctx.document.settings.angleSnapDeg,
          exclude: new Set([this.mode.wallId]),
        })
        const end = this.mode.end
        const wallId = this.mode.wallId
        ctx.apply(
          (doc) => updateWall(doc, wallId, { [end]: snapped.point } as Partial<Wall>),
          'Edit wall',
          `wall-endpoint-${wallId}`,
        )
        const wall = ctx.document.plan.walls.find((w) => w.id === wallId)
        if (wall) {
          ctx.setLabels([
            {
              id: 'wall-length',
              text: formatLength(wallLength(wall), ctx.document.settings.units),
              x: (wall.a.x + wall.b.x) / 2,
              y: 0.4,
              z: (wall.a.y + wall.b.y) / 2,
              variant: 'dimension',
            },
          ])
        }
        ctx.setDraft(
          snapped.guides.map((guide) => ({
            kind: 'polyline' as const,
            points: [guide.from, guide.to],
            color: '#2f7df6',
          })),
        )
        return
      }
      case 'vertex': {
        const snapped = ctx.snap(info.ground, { exclude: new Set([this.mode.zoneId]) })
        const zoneId = this.mode.zoneId
        const index = this.mode.index
        ctx.apply(
          (doc) => {
            const zone = doc.plan.zones.find((z) => z.id === zoneId)
            if (!zone) return doc
            const polygon = zone.polygon.map((p, i) => (i === index ? snapped.point : p))
            return updateZone(doc, zoneId, { polygon })
          },
          'Reshape zone',
          `zone-vertex-${zoneId}-${index}`,
        )
        return
      }
      case 'marquee': {
        this.mode = { ...this.mode, current: info.ground }
        const rect = [
          {
            x: Math.min(this.mode.start.x, info.ground.x),
            y: Math.min(this.mode.start.y, info.ground.y),
          },
          {
            x: Math.max(this.mode.start.x, info.ground.x),
            y: Math.min(this.mode.start.y, info.ground.y),
          },
          {
            x: Math.max(this.mode.start.x, info.ground.x),
            y: Math.max(this.mode.start.y, info.ground.y),
          },
          {
            x: Math.min(this.mode.start.x, info.ground.x),
            y: Math.max(this.mode.start.y, info.ground.y),
          },
        ]
        ctx.setDraft([{ kind: 'rect', points: rect, filled: true, color: '#2f7df6' }])
        return
      }
    }
  }

  onPointerUp(info: PointerInfo, ctx: ToolContext): void {
    if (this.mode.kind === 'marquee' && info.ground) {
      const minX = Math.min(this.mode.start.x, info.ground.x)
      const maxX = Math.max(this.mode.start.x, info.ground.x)
      const minY = Math.min(this.mode.start.y, info.ground.y)
      const maxY = Math.max(this.mode.start.y, info.ground.y)
      if (maxX - minX > info.scale * 4 || maxY - minY > info.scale * 4) {
        const rect = [
          { x: minX, y: minY },
          { x: maxX, y: minY },
          { x: maxX, y: maxY },
          { x: minX, y: maxY },
        ]
        const picked: PlanObjectRef[] = []
        const doc = ctx.document
        const consider = (kind: PlanObjectRef['kind'], id: string) => {
          const polygon = objectFootprint(doc, kind, id)
          if (!polygon) return
          if (meetsBand(polygon, rect)) picked.push({ kind, id })
        }
        for (const wall of doc.plan.walls) consider('wall', wall.id)
        for (const item of doc.plan.furniture) consider('furniture', item.id)
        for (const zone of doc.plan.zones) consider('zone', zone.id)
        for (const point of doc.plan.servicePoints) consider('service', point.id)
        if (info.shiftKey) {
          // A band over something already held adds nothing. Twice in the
          // selection is twice duplicated by the next alt-drag, and two objects
          // where the inspector and every count should see one.
          const held = ctx.selection
          const added = picked.filter(
            (p) => !held.some((have) => have.id === p.id && have.kind === p.kind),
          )
          ctx.setSelection([...held, ...added])
        } else {
          ctx.setSelection(picked)
        }
      }
    }
    if (this.mode.kind !== 'idle') ctx.seal()
    this.mode = { kind: 'idle' }
    ctx.setDraft(this.decorations(ctx, null))
    ctx.setLabels([])
  }

  onDoubleClick(info: PointerInfo, ctx: ToolContext): void {
    // Double-clicking near a zone's outline adds a corner to it.
    if (!info.hit || info.hit.ref.kind !== 'zone' || !info.ground) return
    const hit = info.hit.ref
    // A measurement zone is locked precisely so that clicking about on top of
    // it cannot change what it counts.
    if (isLocked(ctx.document, hit)) return
    const zone = ctx.document.plan.zones.find((z) => z.id === hit.id)
    if (!zone || zone.polygon.length === 0) return
    const point = info.ground

    // The nearest edge, and the point *on* that edge. Taking the nearest edge
    // midpoint and keeping the raw click would cut a notch from an edge all
    // the way in to the pointer, and a zone is a counted region: a fold like
    // that quietly changes who it says was inside it.
    let bestIndex = 0
    let bestDistance = Infinity
    for (let i = 0; i < zone.polygon.length; i++) {
      const a = zone.polygon[i]
      const b = zone.polygon[(i + 1) % zone.polygon.length]
      const d = distanceToSegment(point, a, b)
      if (d < bestDistance) {
        bestDistance = d
        bestIndex = i
      }
    }
    // Deep inside the zone the click was aimed at something standing on it,
    // not at the outline, so it adds nothing rather than a corner nobody can
    // see and an undo step nobody asked for.
    if (bestDistance > ADD_VERTEX_REACH_PX * ctx.scale) return
    const zoneId = zone.id
    const onEdge = closestPointOnSegment(
      point,
      zone.polygon[bestIndex],
      zone.polygon[(bestIndex + 1) % zone.polygon.length],
    )
    ctx.apply((doc) => {
      const current = doc.plan.zones.find((z) => z.id === zoneId)
      if (!current) return doc
      const polygon = [...current.polygon]
      polygon.splice(bestIndex + 1, 0, onEdge)
      return updateZone(doc, zoneId, { polygon })
    }, 'Add zone point')
  }

  onKeyDown(event: KeyboardEvent, ctx: ToolContext): boolean {
    const step = event.shiftKey ? 1 : ctx.document.settings.gridSize
    const nudge = (dx: number, dy: number) => {
      const refs = this.movable(ctx)
      if (refs.length === 0) return
      ctx.apply(
        (doc) => {
          let next = doc
          for (const ref of refs) {
            const position = positionOf(doc, ref)
            if (!position) continue
            next = moveObject(next, ref, position, { x: dx, y: dy })
          }
          return next
        },
        'Nudge',
        'nudge',
      )
    }
    switch (event.key) {
      case 'ArrowLeft':
        nudge(-step, 0)
        return true
      case 'ArrowRight':
        nudge(step, 0)
        return true
      case 'ArrowUp':
        nudge(0, -step)
        return true
      case 'ArrowDown':
        nudge(0, step)
        return true
      case '[':
      case ']': {
        const delta = (event.key === '[' ? -1 : 1) * (event.shiftKey ? Math.PI / 180 : Math.PI / 12)
        // Over the movable part of the selection, like every other edit here: a
        // keystroke that walks past the lock is the easiest way to knock a
        // finished shell out of true while drawing over it.
        const refs = this.movable(ctx)
        const center = refs.length > 0 ? selectionCenter(ctx.document, ctx.selection) : null
        if (!center) return false
        ctx.apply(
          (doc) => {
            let next = doc
            for (const ref of refs) {
              next = rotateObject(next, doc, ref, center, delta, refs.length > 1)
            }
            return next
          },
          'Rotate',
          'rotate-key',
        )
        return true
      }
      default:
        return false
    }
  }

  /** Handles and hover affordances drawn as draft geometry. */
  private decorations(
    ctx: ToolContext,
    active: Handle | null,
  ): Array<{
    kind: 'polygon'
    points: Vec2[]
    color: string
    filled: boolean
  }> {
    const out: Array<{ kind: 'polygon'; points: Vec2[]; color: string; filled: boolean }> = []
    for (const handle of this.handles(ctx)) {
      const size = (handle.id === active?.id ? 8 : 5.5) * ctx.scale
      const color = handle.kind === 'rotate' ? '#8a5cf6' : '#2f7df6'
      if (handle.kind === 'rotate') {
        out.push({
          kind: 'polygon',
          color,
          filled: handle.id === active?.id,
          points: Array.from({ length: 16 }, (_, i) => {
            const a = (i / 16) * Math.PI * 2
            return {
              x: handle.position.x + Math.cos(a) * size,
              y: handle.position.y + Math.sin(a) * size,
            }
          }),
        })
      } else {
        out.push({
          kind: 'polygon',
          color,
          filled: true,
          points: [
            { x: handle.position.x - size, y: handle.position.y - size },
            { x: handle.position.x + size, y: handle.position.y - size },
            { x: handle.position.x + size, y: handle.position.y + size },
            { x: handle.position.x - size, y: handle.position.y + size },
          ],
        })
      }
    }
    return out
  }

  onActivate(ctx: ToolContext): void {
    ctx.setDraft(this.decorations(ctx, null))
  }

  onDeactivate(ctx: ToolContext): void {
    this.mode = { kind: 'idle' }
    ctx.setDraft([])
    ctx.setLabels([])
  }

  onPointerLeave(ctx: ToolContext): void {
    if (this.mode.kind === 'idle') ctx.setDraft(this.decorations(ctx, null))
    void this.lastInfo
  }
}

export { duplicateSelection, selectionCenter }
