/**
 * Placement tools: furniture, doors and windows, and service points.
 *
 * Everything placed here previews in full before it is committed, and orients
 * itself against nearby geometry: a chair placed against a wall turns to face
 * the room, a door follows the wall it lands on, a counter faces the space it
 * serves. Getting that automatic and correct is most of what makes placing
 * objects feel quick rather than fiddly.
 */

import type { Tool, ToolContext } from '../types'
import type { PointerInfo } from '../../render/Viewport'
import type { Vec2 } from '../../core/math/vec2'
import { angleOf, distance, fromAngle, sub, add, scale, normalize } from '../../core/math/vec2'
import { distanceToSegment, rectPolygon } from '../../core/math/geometry'
import {
  addFurniture,
  addOpening,
  addServicePoint,
  updateServicePoint,
} from '../../core/document/mutations'
import { makeFurniture, nearestWall, wallAlignedPlacement } from '../geometryHelpers'
import { resolveCatalogItem } from '../../library/catalog'
import { newId } from '../../core/model/ids'
import { formatLength } from '../../core/model/units'
import { wallLength } from '../../core/model/planGeometry'
import { DOUBLE_DOOR_FROM, OPENING_JAMB } from '../../core/model/standards'

const PREVIEW_COLOR = '#f08a3c'
/** How far from a wall the door and window tools still take hold of it. */
const OPENING_REACH = 1.2

export class FurnitureTool implements Tool {
  readonly id = 'furniture' as const
  readonly hint =
    'Click to place · R rotates 15° · Shift-R rotates 90° · Objects snap against nearby walls · Esc to stop'
  readonly cursor = 'copy'

  private rotation = 0
  private preview: { position: Vec2; rotation: number } | null = null

  onActivate(): void {
    this.rotation = 0
  }

  onDeactivate(ctx: ToolContext): void {
    this.preview = null
    ctx.setDraft([])
    ctx.setLabels([])
  }

  private resolve(
    info: PointerInfo,
    ctx: ToolContext,
  ): { position: Vec2; rotation: number } | null {
    if (!info.ground) return null
    const entry = resolveCatalogItem(ctx.options.catalogId)
    // Holding Alt places the item exactly where the cursor is, ignoring both the
    // grid and the pull of a nearby wall.
    if (!info.altKey) {
      const aligned = wallAlignedPlacement(ctx.document, info.ground, entry.size.depth, 1.0)
      if (aligned) {
        return { position: aligned.position, rotation: aligned.rotation + this.rotation }
      }
    }
    const snapped = ctx.snap(info.ground, { disabled: info.altKey })
    return { position: snapped.point, rotation: this.rotation }
  }

  onPointerMove(info: PointerInfo, ctx: ToolContext): void {
    this.preview = this.resolve(info, ctx)
    this.refresh(ctx)
  }

  private refresh(ctx: ToolContext): void {
    if (!this.preview) {
      ctx.setDraft([])
      ctx.setLabels([])
      return
    }
    const entry = resolveCatalogItem(ctx.options.catalogId)
    const polygon = rectPolygon(
      this.preview.position,
      entry.size.width,
      entry.size.depth,
      this.preview.rotation,
    )
    // Local +Z is the front — what `wallAlignedPlacement` turns towards the room
    // — so the whisker has to leave the item that way, not through its back.
    const facing = fromAngle(this.preview.rotation + Math.PI / 2, entry.size.depth / 2 + 0.3)
    ctx.setDraft([
      { kind: 'rect', points: polygon, color: PREVIEW_COLOR, filled: true },
      {
        kind: 'polyline',
        points: [this.preview.position, add(this.preview.position, facing)],
        color: PREVIEW_COLOR,
      },
    ])
    const units = ctx.document.settings.units
    ctx.setLabels([
      {
        id: 'place-info',
        text: `${entry.name}\n${formatLength(entry.size.width, units)} × ${formatLength(entry.size.depth, units)}`,
        x: this.preview.position.x,
        y: entry.size.height + 0.3,
        z: this.preview.position.y,
        variant: 'name',
      },
    ])
  }

  onPointerDown(info: PointerInfo, ctx: ToolContext): void {
    const resolved = this.resolve(info, ctx)
    if (!resolved) return
    const item = makeFurniture(ctx.options.catalogId, resolved.position, resolved.rotation)
    ctx.apply(
      (doc) => addFurniture(doc, [item]),
      `Place ${resolveCatalogItem(ctx.options.catalogId).name}`,
    )
    ctx.seal()
    // Stay armed so a row of chairs is one gesture per chair, not three.
    if (!info.shiftKey) ctx.setSelection([{ kind: 'furniture', id: item.id }])
  }

  onKeyDown(event: KeyboardEvent, ctx: ToolContext): boolean {
    if (event.key === 'Escape') {
      ctx.setTool('select')
      return true
    }
    if (event.key.toLowerCase() === 'r') {
      const step = (event.shiftKey ? Math.PI / 2 : Math.PI / 12) * (event.altKey ? -1 : 1)
      this.rotation += step
      // The preview carries the angle resolved at the last pointer move, wall
      // alignment included. Turning it here rather than re-resolving keeps that
      // alignment and makes the item on the cursor turn while the mouse is still.
      if (this.preview) this.preview = { ...this.preview, rotation: this.preview.rotation + step }
      this.refresh(ctx)
      return true
    }
    return false
  }
}

/** Shared behaviour for the door and window tools. */
abstract class OpeningTool implements Tool {
  abstract readonly id: 'door' | 'window'
  abstract readonly hint: string
  readonly cursor = 'crosshair'

  protected preview: {
    wallId: string
    offset: number
    position: Vec2
    angle: number
    /** What the wall will let through, which is not always what was asked for. */
    width: number
  } | null = null

  protected abstract width(ctx: ToolContext): number
  protected abstract build(
    ctx: ToolContext,
    wallId: string,
    offset: number,
  ): Parameters<typeof addOpening>[1]

  onDeactivate(ctx: ToolContext): void {
    this.preview = null
    ctx.setDraft([])
    ctx.setLabels([])
  }

  private resolve(info: PointerInfo, ctx: ToolContext) {
    if (!info.ground) return null
    const near = nearestWall(ctx.document, info.ground, OPENING_REACH)
    if (!near) return null
    const length = wallLength(near.wall)
    // A wall with no room left between its two jambs cannot carry an opening at
    // all: `addOpening` would fit one anyway, at the 50 mm floor it keeps so a
    // width box can never eat a whole wall — and the narrowest door in the plan
    // is what sizes the navigation grid, so that slot costs the whole run.
    if (length <= 2 * OPENING_JAMB) return null
    // Everything below fits the opening the way `addOpening` will, jambs and
    // all, so the door lands inside the green rectangle the user clicked on.
    const width = Math.min(this.width(ctx), length - 2 * OPENING_JAMB)
    const half = width / 2
    const nearestEnd = Math.min(half + OPENING_JAMB, length / 2)
    const offset = Math.min(
      Math.max(near.offset, nearestEnd),
      Math.max(nearestEnd, length - half - OPENING_JAMB),
    )
    const direction = normalize(sub(near.wall.b, near.wall.a))
    return {
      wallId: near.wall.id,
      offset,
      position: add(near.wall.a, scale(direction, offset)),
      angle: angleOf(direction),
      width,
    }
  }

  /** Why there is nowhere here to cut an opening, said briefly and then in full. */
  private refusal(info: PointerInfo, ctx: ToolContext): { hint: string; toast: string } {
    const near = info.ground ? nearestWall(ctx.document, info.ground, OPENING_REACH) : null
    return near
      ? {
          hint: 'This wall is too short',
          toast: 'That wall is too short for an opening — it has to keep a jamb either side.',
        }
      : {
          hint: 'Move onto a wall',
          toast: 'Doors and windows are placed on a wall — move onto one first.',
        }
  }

  onPointerMove(info: PointerInfo, ctx: ToolContext): void {
    this.preview = this.resolve(info, ctx)
    if (!this.preview) {
      ctx.setDraft([])
      ctx.setLabels([
        ...(info.ground
          ? [
              {
                id: 'opening-hint',
                text: this.refusal(info, ctx).hint,
                x: info.ground.x,
                y: 0.6,
                z: info.ground.y,
                variant: 'warning' as const,
              },
            ]
          : []),
      ])
      return
    }
    const wall = ctx.document.plan.walls.find((w) => w.id === this.preview!.wallId)
    if (!wall) return
    const width = this.preview.width
    ctx.setDraft([
      {
        kind: 'rect',
        points: rectPolygon(
          this.preview.position,
          width,
          wall.thickness + 0.14,
          this.preview.angle,
        ),
        color: '#3fb27f',
        filled: true,
      },
    ])
    ctx.setLabels([
      {
        id: 'opening-size',
        text: formatLength(width, ctx.document.settings.units),
        x: this.preview.position.x,
        y: 0.6,
        z: this.preview.position.y,
        variant: 'dimension',
      },
    ])
  }

  onPointerDown(info: PointerInfo, ctx: ToolContext): void {
    const resolved = this.resolve(info, ctx)
    if (!resolved) {
      ctx.toast(this.refusal(info, ctx).toast, 'warn')
      return
    }
    const opening = this.build(ctx, resolved.wallId, resolved.offset)
    ctx.apply((doc) => addOpening(doc, opening), this.id === 'door' ? 'Add door' : 'Add window')
    ctx.seal()
    ctx.setSelection([{ kind: 'opening', id: opening.id }])
  }

  onKeyDown(event: KeyboardEvent, ctx: ToolContext): boolean {
    if (event.key === 'Escape') {
      ctx.setTool('select')
      return true
    }
    return false
  }
}

export class DoorTool extends OpeningTool {
  readonly id = 'door' as const
  readonly hint = 'Move onto a wall and click to cut a doorway · Esc to stop'

  protected width(ctx: ToolContext): number {
    return ctx.options.doorWidth
  }

  protected build(ctx: ToolContext, wallId: string, offset: number) {
    return {
      id: newId('open'),
      wallId,
      offset,
      width: ctx.options.doorWidth,
      height: ctx.options.doorHeight,
      sill: 0,
      kind:
        ctx.options.doorWidth >= DOUBLE_DOOR_FROM ? ('double-door' as const) : ('door' as const),
      swing: 'left' as const,
    }
  }
}

export class WindowTool extends OpeningTool {
  readonly id = 'window' as const
  readonly hint = 'Move onto a wall and click to add a window · Esc to stop'

  protected width(ctx: ToolContext): number {
    return ctx.options.windowWidth
  }

  protected build(ctx: ToolContext, wallId: string, offset: number) {
    return {
      id: newId('open'),
      wallId,
      offset,
      width: ctx.options.windowWidth,
      height: ctx.options.windowHeight,
      sill: ctx.options.windowSill,
      kind: 'window' as const,
    }
  }
}

export class ServiceTool implements Tool {
  readonly id = 'service' as const
  readonly hint = 'Click to place a counter · R rotates · The queue is created facing the room'
  readonly cursor = 'copy'

  private rotation = 0
  private preview: { position: Vec2; rotation: number } | null = null

  onDeactivate(ctx: ToolContext): void {
    this.preview = null
    ctx.setDraft([])
    ctx.setLabels([])
  }

  private resolve(info: PointerInfo, ctx: ToolContext) {
    if (!info.ground) return null
    const aligned = wallAlignedPlacement(ctx.document, info.ground, 0.7, 1.4)
    // `wallAlignedPlacement` turns an object's front — its local +Z — into the
    // room, but a counter is served from the other side (`serviceFacing`): staff
    // work against the wall and the queue forms in the room. Half a turn is the
    // whole difference between the two conventions, and without it the line runs
    // through the wall the counter was just snapped to.
    if (aligned) {
      return { position: aligned.position, rotation: aligned.rotation + Math.PI + this.rotation }
    }
    return { position: ctx.snap(info.ground).point, rotation: this.rotation }
  }

  onPointerMove(info: PointerInfo, ctx: ToolContext): void {
    this.preview = this.resolve(info, ctx)
    this.refresh(ctx)
  }

  private refresh(ctx: ToolContext): void {
    if (!this.preview) return
    const width = 1.8
    const depth = 0.7
    const outward = fromAngle(this.preview.rotation - Math.PI / 2)
    const head = add(this.preview.position, scale(outward, depth / 2 + 1))
    const tail = add(head, scale(outward, 6))
    ctx.setDraft([
      {
        kind: 'rect',
        points: rectPolygon(this.preview.position, width, depth, this.preview.rotation),
        color: '#3f9ab0',
        filled: true,
      },
      { kind: 'polyline', points: [head, tail], color: '#3f9ab0' },
    ])
    ctx.setLabels([
      {
        id: 'service-preview',
        text: 'Service point\nqueue forms this way',
        x: tail.x,
        y: 0.6,
        z: tail.y,
        variant: 'name',
      },
    ])
  }

  onPointerDown(info: PointerInfo, ctx: ToolContext): void {
    const resolved = this.resolve(info, ctx)
    if (!resolved) return
    const index = ctx.document.plan.servicePoints.length + 1
    const point = {
      id: newId('svc'),
      name: `Service point ${index}`,
      position: resolved.position,
      rotation: resolved.rotation,
      width: 1.8,
      depth: 0.7,
      servers: 2,
      serviceTime: { kind: 'lognormal' as const, mean: 20, sd: 7, min: 2 },
      queueSpacing: 0.6,
    }
    ctx.apply((doc) => addServicePoint(doc, point), 'Add service point')
    ctx.seal()
    ctx.setSelection([{ kind: 'service', id: point.id }])
    ctx.setTool('select')
  }

  onKeyDown(event: KeyboardEvent, ctx: ToolContext): boolean {
    if (event.key === 'Escape') {
      ctx.setTool('select')
      return true
    }
    if (event.key.toLowerCase() === 'r') {
      const step = event.shiftKey ? Math.PI / 2 : Math.PI / 12
      this.rotation += step
      // Turn what is already on the cursor as well as the next placement, so the
      // counter and its queue whisker answer the key without waiting for a move.
      if (this.preview) this.preview = { ...this.preview, rotation: this.preview.rotation + step }
      this.refresh(ctx)
      return true
    }
    return false
  }
}

/** Edit the waiting line of a service point by dragging its points. */
export class QueueTool implements Tool {
  readonly id = 'queue' as const
  readonly hint =
    'Drag a queue point to reshape the line · Click the line to add a point · Alt-click to remove'
  readonly cursor = 'crosshair'

  private dragging: { serviceId: string; index: number } | null = null

  private activeService(ctx: ToolContext) {
    const ref = ctx.selection.find((r) => r.kind === 'service')
    const id = ref?.id ?? ctx.document.plan.servicePoints[0]?.id
    return ctx.document.plan.servicePoints.find((s) => s.id === id) ?? null
  }

  private queueOf(ctx: ToolContext): { id: string; points: Vec2[] } | null {
    const service = this.activeService(ctx)
    if (!service) return null
    if (service.queue && service.queue.length >= 2) return { id: service.id, points: service.queue }
    const outward = fromAngle(service.rotation - Math.PI / 2)
    const head = add(service.position, scale(outward, service.depth / 2 + 1))
    return { id: service.id, points: [head, add(head, scale(outward, 6))] }
  }

  onActivate(ctx: ToolContext): void {
    this.refresh(ctx)
  }

  onDeactivate(ctx: ToolContext): void {
    this.dragging = null
    ctx.setDraft([])
    ctx.setLabels([])
  }

  private refresh(ctx: ToolContext): void {
    const queue = this.queueOf(ctx)
    if (!queue) {
      ctx.setDraft([])
      ctx.setLabels([])
      return
    }
    const handleSize = 6 * ctx.scale
    ctx.setDraft([
      { kind: 'polyline', points: queue.points, color: '#3f9ab0' },
      ...queue.points.map((p) => ({
        kind: 'rect' as const,
        color: '#3f9ab0',
        filled: true,
        points: [
          { x: p.x - handleSize, y: p.y - handleSize },
          { x: p.x + handleSize, y: p.y - handleSize },
          { x: p.x + handleSize, y: p.y + handleSize },
          { x: p.x - handleSize, y: p.y + handleSize },
        ],
      })),
    ])
    const service = this.activeService(ctx)
    if (service) {
      const capacity =
        Math.floor(
          queue.points.reduce(
            (sum, p, i) => (i === 0 ? 0 : sum + distance(queue.points[i - 1], p)),
            0,
          ) / service.queueSpacing,
        ) + 1
      ctx.setLabels([
        {
          id: 'queue-capacity',
          text: `${service.name}\nholds about ${capacity} people`,
          x: queue.points[queue.points.length - 1].x,
          y: 0.7,
          z: queue.points[queue.points.length - 1].y,
          variant: 'name',
        },
      ])
    }
  }

  onPointerDown(info: PointerInfo, ctx: ToolContext): void {
    const queue = this.queueOf(ctx)
    if (!queue || !info.ground) return
    const tolerance = 12 * ctx.scale
    const index = queue.points.findIndex((p) => distance(p, info.ground!) <= tolerance)
    if (index >= 0) {
      if (info.altKey && queue.points.length > 2) {
        const points = queue.points.filter((_, i) => i !== index)
        ctx.apply(
          (doc) => updateServicePoint(doc, queue.id, { queue: points }),
          'Remove queue point',
        )
        ctx.seal()
        this.refresh(ctx)
        return
      }
      this.dragging = { serviceId: queue.id, index }
      return
    }
    // Insert a point on the nearest segment — measured to the segment, because
    // the hint offers the whole line and a user aims at the part of it they want
    // the bend in, which on a six-metre queue is nowhere near its midpoint.
    let bestIndex = -1
    let bestDistance = tolerance * 1.5
    for (let i = 1; i < queue.points.length; i++) {
      const d = distanceToSegment(info.ground, queue.points[i - 1], queue.points[i])
      if (d < bestDistance) {
        bestDistance = d
        bestIndex = i
      }
    }
    if (bestIndex > 0) {
      const points = [...queue.points]
      points.splice(bestIndex, 0, ctx.snap(info.ground).point)
      // The same key the drag below uses: clicking the line and dragging the new
      // point where you wanted it is one gesture, so it is one undo step, and
      // `onPointerUp` seals it whether or not the pointer moved at all.
      ctx.apply(
        (doc) => updateServicePoint(doc, queue.id, { queue: points }),
        'Add queue point',
        `queue-${queue.id}-${bestIndex}`,
      )
      this.dragging = { serviceId: queue.id, index: bestIndex }
    }
    this.refresh(ctx)
  }

  onPointerMove(info: PointerInfo, ctx: ToolContext): void {
    if (!this.dragging || !info.ground) {
      this.refresh(ctx)
      return
    }
    const queue = this.queueOf(ctx)
    if (!queue) return
    const snapped = ctx.snap(info.ground, { exclude: new Set([this.dragging.serviceId]) })
    const index = this.dragging.index
    const serviceId = this.dragging.serviceId
    const points = queue.points.map((p, i) => (i === index ? snapped.point : p))
    ctx.apply(
      (doc) => updateServicePoint(doc, serviceId, { queue: points }),
      'Reshape queue',
      `queue-${serviceId}-${index}`,
    )
    this.refresh(ctx)
  }

  onPointerUp(_info: PointerInfo, ctx: ToolContext): void {
    if (this.dragging) ctx.seal()
    this.dragging = null
    this.refresh(ctx)
  }

  onKeyDown(event: KeyboardEvent, ctx: ToolContext): boolean {
    if (event.key === 'Escape') {
      ctx.setTool('select')
      return true
    }
    return false
  }
}
