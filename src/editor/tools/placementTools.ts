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
import { rectPolygon } from '../../core/math/geometry'
import { addFurniture, addOpening, addServicePoint } from '../../core/document/mutations'
import { makeFurniture, nearestWall, wallAlignedPlacement } from '../geometryHelpers'
import { resolveCatalogItem } from '../../library/catalog'
import { newId } from '../../core/model/ids'
import { formatLength } from '../../core/model/units'
import { wallLength } from '../../core/model/planGeometry'

const PREVIEW_COLOR = '#f08a3c'

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

  private resolve(info: PointerInfo, ctx: ToolContext): { position: Vec2; rotation: number } | null {
    if (!info.ground) return null
    const entry = resolveCatalogItem(ctx.options.catalogId)
    const aligned = wallAlignedPlacement(ctx.document, info.ground, entry.size.depth, 1.0)
    if (aligned) {
      return { position: aligned.position, rotation: aligned.rotation + this.rotation }
    }
    const snapped = ctx.snap(info.ground)
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
    const facing = fromAngle(this.preview.rotation - Math.PI / 2, entry.size.depth / 2 + 0.3)
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
    ctx.apply((doc) => addFurniture(doc, [item]), `Place ${resolveCatalogItem(ctx.options.catalogId).name}`)
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
      this.rotation += (event.shiftKey ? Math.PI / 2 : Math.PI / 12) * (event.altKey ? -1 : 1)
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

  protected preview: { wallId: string; offset: number; position: Vec2; angle: number } | null = null

  protected abstract width(ctx: ToolContext): number
  protected abstract build(ctx: ToolContext, wallId: string, offset: number): Parameters<typeof addOpening>[1]

  onDeactivate(ctx: ToolContext): void {
    this.preview = null
    ctx.setDraft([])
    ctx.setLabels([])
  }

  private resolve(info: PointerInfo, ctx: ToolContext) {
    if (!info.ground) return null
    const near = nearestWall(ctx.document, info.ground, 1.2)
    if (!near) return null
    const width = this.width(ctx)
    const length = wallLength(near.wall)
    const offset = Math.min(Math.max(near.offset, width / 2), Math.max(width / 2, length - width / 2))
    const direction = normalize(sub(near.wall.b, near.wall.a))
    return {
      wallId: near.wall.id,
      offset,
      position: add(near.wall.a, scale(direction, offset)),
      angle: angleOf(direction),
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
                text: 'Move onto a wall',
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
    const width = this.width(ctx)
    ctx.setDraft([
      {
        kind: 'rect',
        points: rectPolygon(this.preview.position, width, wall.thickness + 0.14, this.preview.angle),
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
      ctx.toast('Doors and windows are placed on a wall — move onto one first.', 'warn')
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
      height: 2.1,
      sill: 0,
      kind: ctx.options.doorWidth >= 1.4 ? ('double-door' as const) : ('door' as const),
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
      height: 1.2,
      sill: 0.9,
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
    if (aligned) return { position: aligned.position, rotation: aligned.rotation + this.rotation }
    return { position: ctx.snap(info.ground).point, rotation: this.rotation }
  }

  onPointerMove(info: PointerInfo, ctx: ToolContext): void {
    this.preview = this.resolve(info, ctx)
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
      this.rotation += event.shiftKey ? Math.PI / 2 : Math.PI / 12
      return true
    }
    return false
  }
}

/** Edit the waiting line of a service point by dragging its points. */
export class QueueTool implements Tool {
  readonly id = 'queue' as const
  readonly hint = 'Drag a queue point to reshape the line · Click the line to add a point · Alt-click to remove'
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
      const capacity = Math.floor(
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
          (doc) => ({
            ...doc,
            plan: {
              ...doc.plan,
              servicePoints: doc.plan.servicePoints.map((s) =>
                s.id === queue.id ? { ...s, queue: points } : s,
              ),
            },
          }),
          'Remove queue point',
        )
        ctx.seal()
        this.refresh(ctx)
        return
      }
      this.dragging = { serviceId: queue.id, index }
      return
    }
    // Insert a point on the nearest segment.
    let bestIndex = -1
    let bestDistance = tolerance * 1.5
    for (let i = 1; i < queue.points.length; i++) {
      const a = queue.points[i - 1]
      const b = queue.points[i]
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const d = distance(mid, info.ground)
      if (d < bestDistance) {
        bestDistance = d
        bestIndex = i
      }
    }
    if (bestIndex > 0) {
      const points = [...queue.points]
      points.splice(bestIndex, 0, ctx.snap(info.ground).point)
      ctx.apply(
        (doc) => ({
          ...doc,
          plan: {
            ...doc.plan,
            servicePoints: doc.plan.servicePoints.map((s) =>
              s.id === queue.id ? { ...s, queue: points } : s,
            ),
          },
        }),
        'Add queue point',
      )
      ctx.seal()
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
      (doc) => ({
        ...doc,
        plan: {
          ...doc.plan,
          servicePoints: doc.plan.servicePoints.map((s) =>
            s.id === serviceId ? { ...s, queue: points } : s,
          ),
        },
      }),
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
