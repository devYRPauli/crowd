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
import { boundsOf, pointInPolygon, polygonCentroid } from '../../core/math/geometry'
import { objectFootprint, wallMidpoint } from '../geometryHelpers'
import {
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
  | { kind: 'rotate'; center: Vec2; startAngle: number; origin: Map<string, number> }
  | { kind: 'wall-endpoint'; wallId: string; end: 'a' | 'b'; other: Vec2 }
  | { kind: 'vertex'; zoneId: string; index: number }
  | { kind: 'marquee'; start: Vec2; current: Vec2 }

const ROTATE_HANDLE_OFFSET_PX = 46

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
    case 'service':
      return updateServicePoint(doc, ref.id, { position: target })
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

const rotateObject = (
  doc: CrowdDocument,
  ref: PlanObjectRef,
  pivot: Vec2,
  delta: number,
  baseRotation: number,
  basePosition: Vec2 | null,
): CrowdDocument => {
  const spun = basePosition ? add(pivot, rotateVec(sub(basePosition, pivot), delta)) : null
  switch (ref.kind) {
    case 'furniture':
      return updateFurniture(doc, ref.id, {
        rotation: baseRotation + delta,
        ...(spun ? { position: spun } : {}),
      })
    case 'service':
      return updateServicePoint(doc, ref.id, {
        rotation: baseRotation + delta,
        ...(spun ? { position: spun } : {}),
      })
    case 'backdrop':
      return updateBackdrop(doc, {
        rotation: baseRotation + delta,
        ...(spun ? { position: spun } : {}),
      })
    case 'wall': {
      const wall = doc.plan.walls.find((w) => w.id === ref.id)
      if (!wall) return doc
      return updateWall(doc, ref.id, {
        a: add(pivot, rotateVec(sub(wall.a, pivot), delta)),
        b: add(pivot, rotateVec(sub(wall.b, pivot), delta)),
      })
    }
    case 'zone': {
      const zone = doc.plan.zones.find((z) => z.id === ref.id)
      if (!zone) return doc
      return updateZone(doc, ref.id, {
        polygon: zone.polygon.map((p) => add(pivot, rotateVec(sub(p, pivot), delta))),
      })
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

    const center = selectionCenter(doc, refs)
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

  private lockedRefs(ctx: ToolContext): Set<string> {
    const ids = new Set<string>()
    for (const ref of ctx.selection) ids.add(ref.id)
    return ids
  }

  onPointerDown(info: PointerInfo, ctx: ToolContext): void {
    this.lastInfo = info
    if (!info.ground) return

    const handle = this.handleAt(ctx, info)
    if (handle) {
      if (handle.kind === 'rotate') {
        const center = selectionCenter(ctx.document, ctx.selection)
        if (!center) return
        const origin = new Map<string, number>()
        for (const ref of ctx.selection) origin.set(ref.id, rotationOf(ctx.document, ref))
        this.mode = {
          kind: 'rotate',
          center,
          startAngle: angleOf(sub(info.ground, center)),
          origin,
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
          const snapped = ctx.snap(desired, { exclude: this.lockedRefs(ctx) })
          delta = sub(snapped.point, leadOrigin)
          ctx.setDraft([
            ...snapped.guides.map((guide) => ({
              kind: 'polyline' as const,
              points: [guide.from, guide.to],
              color: '#2f7df6',
            })),
          ])
        }
        ctx.apply(
          (doc) => {
            let next = doc
            for (const ref of refs) {
              const origin = this.mode.kind === 'move' ? this.mode.origin.get(ref.id) : undefined
              if (!origin) continue
              next = moveObject(next, ref, origin, delta)
            }
            return next
          },
          'Move',
          'move-selection',
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
        const refs = ctx.selection
        const pivot = this.mode.center
        const origin = this.mode.origin
        ctx.apply(
          (doc) => {
            let next = doc
            for (const ref of refs) {
              next = rotateObject(
                next,
                ref,
                pivot,
                delta,
                origin.get(ref.id) ?? 0,
                refs.length > 1 ? positionOf(doc, ref) : null,
              )
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
          if (polygon.some((p) => pointInPolygon(p, rect))) picked.push({ kind, id })
        }
        for (const wall of doc.plan.walls) consider('wall', wall.id)
        for (const item of doc.plan.furniture) consider('furniture', item.id)
        for (const zone of doc.plan.zones) consider('zone', zone.id)
        for (const point of doc.plan.servicePoints) consider('service', point.id)
        ctx.setSelection(info.shiftKey ? [...ctx.selection, ...picked] : picked)
      }
    }
    if (this.mode.kind !== 'idle') ctx.seal()
    this.mode = { kind: 'idle' }
    ctx.setDraft(this.decorations(ctx, null))
    ctx.setLabels([])
  }

  onDoubleClick(info: PointerInfo, ctx: ToolContext): void {
    // Double-clicking a zone adds a vertex at that point along its outline.
    if (!info.hit || info.hit.ref.kind !== 'zone' || !info.ground) return
    const zoneId = info.hit.ref.id
    const point = info.ground
    ctx.apply((doc) => {
      const zone = doc.plan.zones.find((z) => z.id === zoneId)
      if (!zone) return doc
      let bestIndex = 0
      let bestDistance = Infinity
      for (let i = 0; i < zone.polygon.length; i++) {
        const a = zone.polygon[i]
        const b = zone.polygon[(i + 1) % zone.polygon.length]
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        const d = distance(mid, point)
        if (d < bestDistance) {
          bestDistance = d
          bestIndex = i
        }
      }
      const polygon = [...zone.polygon]
      polygon.splice(bestIndex + 1, 0, point)
      return updateZone(doc, zoneId, { polygon })
    }, 'Add zone point')
  }

  onKeyDown(event: KeyboardEvent, ctx: ToolContext): boolean {
    const step = event.shiftKey ? 1 : ctx.document.settings.gridSize
    const nudge = (dx: number, dy: number) => {
      const refs = ctx.selection
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
        const center = selectionCenter(ctx.document, ctx.selection)
        if (!center) return false
        const refs = ctx.selection
        ctx.apply(
          (doc) => {
            let next = doc
            for (const ref of refs) {
              next = rotateObject(
                next,
                ref,
                center,
                delta,
                rotationOf(doc, ref),
                refs.length > 1 ? positionOf(doc, ref) : null,
              )
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
