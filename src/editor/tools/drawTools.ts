/**
 * Drawing tools: walls, rooms, zones and measurements.
 *
 * All four share the same shape: an anchor, a live preview that reports its own
 * dimensions, and a commit. The wall tool additionally accepts typed input —
 * start a wall, type `4.5`, press Enter — which is the fastest way to lay out a
 * room you already have measurements for, and the thing people miss most when
 * a plan editor lacks it.
 */

import type { Tool, ToolContext } from '../types'
import type { PointerInfo } from '../../render/Viewport'
import type { Vec2 } from '../../core/math/vec2'
import { add, angleOf, distance, fromAngle, sub } from '../../core/math/vec2'
import { polygonArea } from '../../core/math/geometry'
import { addWall, addWalls, addZone } from '../../core/document/mutations'
import { makeRoomWalls, makeWall, rectangleFrom } from '../geometryHelpers'
import { formatArea, formatLength, parseLength } from '../../core/model/units'
import { newId } from '../../core/model/ids'
import { ZONE_COLORS, ZONE_LABELS } from '../../core/model/defaults'

const DRAFT_COLOR = '#f08a3c'

/** Shared preview label placed at the midpoint of a segment. */
const segmentLabels = (ctx: ToolContext, a: Vec2, b: Vec2, prefix = '') => {
  const length = distance(a, b)
  const angle = ((angleOf(sub(b, a)) * 180) / Math.PI + 360) % 360
  return [
    {
      id: 'draw-length',
      text: `${prefix}${formatLength(length, ctx.document.settings.units)}  ·  ${angle.toFixed(0)}°`,
      x: (a.x + b.x) / 2,
      y: 0.45,
      z: (a.y + b.y) / 2,
      variant: 'dimension' as const,
    },
  ]
}

export class WallTool implements Tool {
  readonly id = 'wall' as const
  readonly hint =
    'Click to start · Click again to continue · Type a length and press Enter · Esc or double-click to finish'
  readonly cursor = 'crosshair'

  private points: Vec2[] = []
  private preview: Vec2 | null = null
  private typed = ''

  onActivate(ctx: ToolContext): void {
    this.reset(ctx)
  }

  onDeactivate(ctx: ToolContext): void {
    this.reset(ctx)
  }

  private reset(ctx: ToolContext): void {
    this.points = []
    this.preview = null
    this.typed = ''
    ctx.setDraft([])
    ctx.setLabels([])
  }

  private anchor(): Vec2 | null {
    return this.points.length ? this.points[this.points.length - 1] : null
  }

  private resolvePoint(info: PointerInfo, ctx: ToolContext): Vec2 | null {
    if (!info.ground) return null
    const anchor = this.anchor()
    if (anchor && this.typed) {
      const length = parseLength(this.typed, ctx.document.settings.units)
      if (length !== null && length > 0) {
        const direction = fromAngle(angleOf(sub(info.ground, anchor)))
        const step = ctx.document.settings.angleSnapDeg
        const angle = step > 0
          ? Math.round(angleOf(direction) / ((step * Math.PI) / 180)) * ((step * Math.PI) / 180)
          : angleOf(direction)
        return add(anchor, fromAngle(angle, length))
      }
    }
    return ctx.snap(info.ground, {
      anchor,
      angleSnapDeg: ctx.document.settings.angleSnapDeg,
    }).point
  }

  onPointerMove(info: PointerInfo, ctx: ToolContext): void {
    const point = this.resolvePoint(info, ctx)
    if (!point) return
    this.preview = point
    this.refresh(ctx, info)
  }

  private refresh(ctx: ToolContext, info: PointerInfo | null): void {
    const anchor = this.anchor()
    const shapes: Array<{ kind: 'polyline'; points: Vec2[]; color: string }> = []
    if (this.points.length >= 2) {
      shapes.push({ kind: 'polyline', points: [...this.points], color: DRAFT_COLOR })
    }
    if (anchor && this.preview) {
      shapes.push({ kind: 'polyline', points: [anchor, this.preview], color: DRAFT_COLOR })
    }
    if (info?.ground && !anchor) {
      shapes.push({ kind: 'polyline', points: [this.preview ?? info.ground, this.preview ?? info.ground], color: DRAFT_COLOR })
    }
    if (info && this.preview) {
      const snapped = ctx.snap(info.ground ?? this.preview, {
        anchor,
        angleSnapDeg: ctx.document.settings.angleSnapDeg,
      })
      for (const guide of snapped.guides) {
        shapes.push({ kind: 'polyline', points: [guide.from, guide.to], color: '#2f7df6' })
      }
    }
    ctx.setDraft(shapes)
    if (anchor && this.preview) {
      ctx.setLabels(segmentLabels(ctx, anchor, this.preview, this.typed ? `${this.typed} → ` : ''))
    } else {
      ctx.setLabels([])
    }
  }

  onPointerDown(info: PointerInfo, ctx: ToolContext): void {
    const point = this.resolvePoint(info, ctx)
    if (!point) return
    const anchor = this.anchor()
    if (anchor) {
      if (distance(anchor, point) < 0.05) return
      this.commitSegment(ctx, anchor, point)
    }
    this.points.push(point)
    this.typed = ''
    this.preview = point
    this.refresh(ctx, info)
  }

  private commitSegment(ctx: ToolContext, a: Vec2, b: Vec2): void {
    const { wallThickness, wallHeight, wallKind } = ctx.options
    ctx.apply(
      (doc) => addWall(doc, makeWall(a, b, { thickness: wallThickness, height: wallHeight, kind: wallKind })),
      'Draw wall',
    )
    ctx.seal()
  }

  onDoubleClick(_info: PointerInfo, ctx: ToolContext): void {
    this.reset(ctx)
  }

  onKeyDown(event: KeyboardEvent, ctx: ToolContext): boolean {
    if (event.key === 'Escape') {
      if (this.points.length) {
        this.reset(ctx)
        return true
      }
      return false
    }
    if (event.key === 'Enter') {
      if (this.anchor() && this.preview && this.typed) {
        const anchor = this.anchor()!
        this.commitSegment(ctx, anchor, this.preview)
        this.points.push(this.preview)
        this.typed = ''
        this.refresh(ctx, null)
        return true
      }
      this.reset(ctx)
      return true
    }
    if (event.key === 'Backspace') {
      if (this.typed) {
        this.typed = this.typed.slice(0, -1)
        this.refresh(ctx, null)
        return true
      }
      if (this.points.length) {
        this.points.pop()
        this.refresh(ctx, null)
        return true
      }
      return false
    }
    if (/^[0-9.]$/.test(event.key) && this.anchor()) {
      this.typed += event.key
      this.refresh(ctx, null)
      return true
    }
    if (/^[a-z]$/i.test(event.key) && this.typed) {
      // Allow typing a unit suffix such as `cm` or `ft`.
      this.typed += event.key
      this.refresh(ctx, null)
      return true
    }
    return false
  }
}

export class RoomTool implements Tool {
  readonly id = 'room' as const
  readonly hint = 'Drag to draw a rectangular room · Shift keeps it square'
  readonly cursor = 'crosshair'

  private start: Vec2 | null = null
  private current: Vec2 | null = null

  onDeactivate(ctx: ToolContext): void {
    this.start = null
    this.current = null
    ctx.setDraft([])
    ctx.setLabels([])
  }

  onPointerDown(info: PointerInfo, ctx: ToolContext): void {
    if (!info.ground) return
    this.start = ctx.snap(info.ground).point
    this.current = this.start
  }

  onPointerMove(info: PointerInfo, ctx: ToolContext): void {
    if (!info.ground) return
    if (!this.start) return
    let point = ctx.snap(info.ground, { anchor: this.start }).point
    if (info.shiftKey) {
      const dx = point.x - this.start.x
      const dy = point.y - this.start.y
      const side = Math.max(Math.abs(dx), Math.abs(dy))
      point = { x: this.start.x + Math.sign(dx) * side, y: this.start.y + Math.sign(dy) * side }
    }
    this.current = point
    const polygon = rectangleFrom(this.start, point)
    ctx.setDraft([{ kind: 'rect', points: polygon, color: DRAFT_COLOR, filled: true }])
    const width = Math.abs(point.x - this.start.x)
    const depth = Math.abs(point.y - this.start.y)
    const units = ctx.document.settings.units
    ctx.setLabels([
      {
        id: 'room-size',
        text: `${formatLength(width, units)} × ${formatLength(depth, units)}\n${formatArea(width * depth, units)}`,
        x: (this.start.x + point.x) / 2,
        y: 0.5,
        z: (this.start.y + point.y) / 2,
        variant: 'dimension',
      },
    ])
  }

  onPointerUp(_info: PointerInfo, ctx: ToolContext): void {
    if (!this.start || !this.current) return
    const width = Math.abs(this.current.x - this.start.x)
    const depth = Math.abs(this.current.y - this.start.y)
    if (width > 0.3 && depth > 0.3) {
      const { wallThickness, wallHeight, wallKind } = ctx.options
      const walls = makeRoomWalls(this.start, this.current, {
        thickness: wallThickness,
        height: wallHeight,
        kind: wallKind,
      })
      ctx.apply((doc) => addWalls(doc, walls), 'Draw room')
      ctx.seal()
      ctx.setTool('select')
    }
    this.start = null
    this.current = null
    ctx.setDraft([])
    ctx.setLabels([])
  }

  onKeyDown(event: KeyboardEvent, ctx: ToolContext): boolean {
    if (event.key === 'Escape') {
      this.onDeactivate(ctx)
      return true
    }
    return false
  }
}

export class ZoneTool implements Tool {
  readonly id = 'zone' as const
  readonly hint = 'Drag to place an area · Double-click to finish a free-form outline'
  readonly cursor = 'crosshair'

  private start: Vec2 | null = null
  private current: Vec2 | null = null
  private polygon: Vec2[] = []

  onDeactivate(ctx: ToolContext): void {
    this.start = null
    this.current = null
    this.polygon = []
    ctx.setDraft([])
    ctx.setLabels([])
  }

  private color(ctx: ToolContext): string {
    return ZONE_COLORS[ctx.options.zoneKind] ?? DRAFT_COLOR
  }

  onPointerDown(info: PointerInfo, ctx: ToolContext): void {
    if (!info.ground) return
    const point = ctx.snap(info.ground).point
    if (this.polygon.length > 0) {
      this.polygon.push(point)
      this.refreshPolygon(ctx)
      return
    }
    this.start = point
    this.current = point
  }

  onPointerMove(info: PointerInfo, ctx: ToolContext): void {
    if (!info.ground) return
    const point = ctx.snap(info.ground).point
    if (this.polygon.length > 0) {
      this.current = point
      this.refreshPolygon(ctx)
      return
    }
    if (!this.start) return
    this.current = point
    const polygon = rectangleFrom(this.start, point)
    ctx.setDraft([{ kind: 'rect', points: polygon, color: this.color(ctx), filled: true }])
    const units = ctx.document.settings.units
    ctx.setLabels([
      {
        id: 'zone-size',
        text: `${ZONE_LABELS[ctx.options.zoneKind]}\n${formatArea(polygonArea(polygon), units)}`,
        x: (this.start.x + point.x) / 2,
        y: 0.4,
        z: (this.start.y + point.y) / 2,
        variant: 'dimension',
      },
    ])
  }

  private refreshPolygon(ctx: ToolContext): void {
    const points = this.current ? [...this.polygon, this.current] : [...this.polygon]
    ctx.setDraft([{ kind: 'polygon', points, color: this.color(ctx), filled: true }])
    ctx.setLabels(
      points.length >= 3
        ? [
            {
              id: 'zone-size',
              text: formatArea(polygonArea(points), ctx.document.settings.units),
              x: points.reduce((s, p) => s + p.x, 0) / points.length,
              y: 0.4,
              z: points.reduce((s, p) => s + p.y, 0) / points.length,
              variant: 'dimension',
            },
          ]
        : [],
    )
  }

  onPointerUp(info: PointerInfo, ctx: ToolContext): void {
    if (this.polygon.length > 0) return
    if (!this.start || !this.current) return
    const width = Math.abs(this.current.x - this.start.x)
    const depth = Math.abs(this.current.y - this.start.y)
    if (width < 0.2 || depth < 0.2) {
      // A click rather than a drag starts a free-form outline.
      this.polygon = [this.start]
      this.current = info.ground
      this.start = null
      this.refreshPolygon(ctx)
      return
    }
    this.commit(ctx, rectangleFrom(this.start, this.current))
  }

  onDoubleClick(_info: PointerInfo, ctx: ToolContext): void {
    if (this.polygon.length >= 3) this.commit(ctx, [...this.polygon])
    else this.onDeactivate(ctx)
  }

  private commit(ctx: ToolContext, polygon: Vec2[]): void {
    const kind = ctx.options.zoneKind
    const existing = ctx.document.plan.zones.filter((z) => z.kind === kind).length
    ctx.apply(
      (doc) =>
        addZone(doc, {
          id: newId('zone'),
          kind,
          name: `${ZONE_LABELS[kind]} ${existing + 1}`,
          polygon,
          ...(kind === 'keep-clear' ? { cost: 4 } : {}),
        }),
      `Add ${ZONE_LABELS[kind].toLowerCase()}`,
    )
    ctx.seal()
    this.onDeactivate(ctx)
  }

  onKeyDown(event: KeyboardEvent, ctx: ToolContext): boolean {
    if (event.key === 'Escape') {
      this.onDeactivate(ctx)
      return true
    }
    if (event.key === 'Enter' && this.polygon.length >= 3) {
      this.commit(ctx, [...this.polygon])
      return true
    }
    if (event.key === 'Backspace' && this.polygon.length > 0) {
      this.polygon.pop()
      this.refreshPolygon(ctx)
      return true
    }
    return false
  }
}

export class MeasureTool implements Tool {
  readonly id = 'measure' as const
  readonly hint = 'Click to start measuring · Click again to add points · Esc to clear'
  readonly cursor = 'crosshair'

  private points: Vec2[] = []
  private preview: Vec2 | null = null

  onDeactivate(ctx: ToolContext): void {
    this.points = []
    this.preview = null
    ctx.setDraft([])
    ctx.setLabels([])
  }

  onPointerDown(info: PointerInfo, ctx: ToolContext): void {
    if (!info.ground) return
    this.points.push(ctx.snap(info.ground, { anchor: this.points[this.points.length - 1] ?? null, angleSnapDeg: ctx.document.settings.angleSnapDeg }).point)
    this.refresh(ctx)
  }

  onPointerMove(info: PointerInfo, ctx: ToolContext): void {
    if (!info.ground) return
    this.preview = ctx.snap(info.ground, {
      anchor: this.points[this.points.length - 1] ?? null,
      angleSnapDeg: ctx.document.settings.angleSnapDeg,
    }).point
    this.refresh(ctx)
  }

  private refresh(ctx: ToolContext): void {
    const points = this.preview ? [...this.points, this.preview] : [...this.points]
    if (points.length < 2) {
      ctx.setDraft(points.length ? [{ kind: 'marker', points, color: '#8a5cf6' }] : [])
      ctx.setLabels([])
      return
    }
    ctx.setDraft([{ kind: 'polyline', points, color: '#8a5cf6' }])
    const units = ctx.document.settings.units
    const labels = []
    let total = 0
    for (let i = 1; i < points.length; i++) {
      const length = distance(points[i - 1], points[i])
      total += length
      labels.push({
        id: `measure-${i}`,
        text: formatLength(length, units),
        x: (points[i - 1].x + points[i].x) / 2,
        y: 0.4,
        z: (points[i - 1].y + points[i].y) / 2,
        variant: 'dimension' as const,
      })
    }
    if (points.length > 2) {
      labels.push({
        id: 'measure-total',
        text: `Total ${formatLength(total, units)}`,
        x: points[points.length - 1].x,
        y: 0.9,
        z: points[points.length - 1].y,
        variant: 'accent' as const,
      })
    }
    ctx.setLabels(labels)
  }

  onDoubleClick(_info: PointerInfo, ctx: ToolContext): void {
    this.preview = null
    this.refresh(ctx)
  }

  onKeyDown(event: KeyboardEvent, ctx: ToolContext): boolean {
    if (event.key === 'Escape') {
      this.onDeactivate(ctx)
      return true
    }
    return false
  }
}
