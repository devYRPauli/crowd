/**
 * A small builder for composing plans in code.
 *
 * Used by the starter templates and by the tests. It exists so a venue can be
 * described in roughly the terms a planner would use — "a room this big, a
 * double door on the south wall, eight rounds of ten with chairs" — instead of
 * as a wall of literal coordinates.
 */

import type {
  FurnitureItem,
  ItineraryStep,
  Opening,
  Plan,
  ServicePoint,
  Wall,
  Zone,
} from '../core/model/types'
import type { Distribution } from '../core/math/random'
import type { Vec2 } from '../core/math/vec2'
import { newId } from '../core/model/ids'
import { resolveCatalogItem } from './catalog'
import { ZONE_COLORS, ZONE_LABELS } from '../core/model/defaults'
import {
  DEFAULT_DOOR_HEIGHT,
  DEFAULT_DOOR_WIDTH,
  DEFAULT_WALL_HEIGHT,
  DEFAULT_WALL_THICKNESS,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_SILL,
  DEFAULT_WINDOW_WIDTH,
  DOUBLE_DOOR_FROM,
} from '../core/model/standards'

export interface RoomWalls {
  south: Wall
  east: Wall
  north: Wall
  west: Wall
  all: Wall[]
}

export class PlanBuilder {
  private walls: Wall[] = []
  private openings: Opening[] = []
  private furniture: FurnitureItem[] = []
  private zones: Zone[] = []
  private servicePoints: ServicePoint[] = []

  wall(a: Vec2, b: Vec2, options: Partial<Wall> = {}): Wall {
    const created: Wall = {
      id: newId('wall'),
      a: { ...a },
      b: { ...b },
      thickness: DEFAULT_WALL_THICKNESS,
      height: DEFAULT_WALL_HEIGHT,
      kind: 'wall',
      ...options,
    }
    this.walls.push(created)
    return created
  }

  /** Four walls, counter-clockwise from the south-west corner. */
  room(x0: number, y0: number, x1: number, y1: number, options: Partial<Wall> = {}): RoomWalls {
    const south = this.wall({ x: x0, y: y0 }, { x: x1, y: y0 }, options)
    const east = this.wall({ x: x1, y: y0 }, { x: x1, y: y1 }, options)
    const north = this.wall({ x: x1, y: y1 }, { x: x0, y: y1 }, options)
    const west = this.wall({ x: x0, y: y1 }, { x: x0, y: y0 }, options)
    return { south, east, north, west, all: [south, east, north, west] }
  }

  door(
    wall: Wall,
    offset: number,
    width = DEFAULT_DOOR_WIDTH,
    kind: Opening['kind'] = 'door',
    use?: Opening['use'],
  ): Opening {
    const created: Opening = {
      id: newId('open'),
      wallId: wall.id,
      offset,
      width,
      height: DEFAULT_DOOR_HEIGHT,
      sill: 0,
      kind: width >= DOUBLE_DOOR_FROM && kind === 'door' ? 'double-door' : kind,
      swing: 'left',
      ...(use ? { use } : {}),
    }
    this.openings.push(created)
    return created
  }

  window(wall: Wall, offset: number, width = DEFAULT_WINDOW_WIDTH): Opening {
    const created: Opening = {
      id: newId('open'),
      wallId: wall.id,
      offset,
      width,
      height: DEFAULT_WINDOW_HEIGHT,
      sill: DEFAULT_WINDOW_SILL,
      kind: 'window',
    }
    this.openings.push(created)
    return created
  }

  place(
    catalogId: string,
    x: number,
    y: number,
    rotation = 0,
    options: Partial<FurnitureItem> = {},
  ): FurnitureItem {
    const created: FurnitureItem = {
      id: newId('item'),
      catalogId,
      position: { x, y },
      rotation,
      ...options,
    }
    this.furniture.push(created)
    return created
  }

  /** A table with chairs arranged on its seat positions. */
  tableWithChairs(catalogId: string, x: number, y: number, rotation = 0, chairId = 'chair'): void {
    const table = this.place(catalogId, x, y, rotation)
    const entry = resolveCatalogItem(catalogId)
    const size = table.size ?? entry.size
    const seats = entry.seats?.(size) ?? []
    const c = Math.cos(rotation)
    const s = Math.sin(rotation)
    for (const seat of seats) {
      if (seat.kind !== 'seat') continue
      this.place(
        chairId,
        x + seat.x * c - seat.z * s,
        y + seat.x * s + seat.z * c,
        seat.facing + rotation - Math.PI / 2,
      )
    }
  }

  /** A grid of tables, each with chairs. */
  tableGrid(
    catalogId: string,
    x0: number,
    y0: number,
    columns: number,
    rows: number,
    spacingX: number,
    spacingY: number,
    chairId = 'chair',
  ): void {
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        this.tableWithChairs(catalogId, x0 + column * spacingX, y0 + row * spacingY, 0, chairId)
      }
    }
  }

  /** Rows of theatre seating facing +Y. */
  seatingBlock(x: number, y: number, rowCount: number, width: number, rowSpacing = 0.95): void {
    for (let row = 0; row < rowCount; row++) {
      this.place('seat-row', x, y + row * rowSpacing, Math.PI, {
        size: { width, depth: 0.7, height: 0.95 },
      })
    }
  }

  zone(
    kind: Zone['kind'],
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    name?: string,
    options: Partial<Zone> = {},
  ): Zone {
    const created: Zone = {
      id: newId('zone'),
      kind,
      name: name ?? ZONE_LABELS[kind] ?? 'Zone',
      polygon: [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ],
      color: ZONE_COLORS[kind],
      ...options,
    }
    this.zones.push(created)
    return created
  }

  service(
    name: string,
    x: number,
    y: number,
    rotation: number,
    servers: number,
    serviceTime: Distribution,
    options: Partial<ServicePoint> = {},
  ): ServicePoint {
    const created: ServicePoint = {
      id: newId('svc'),
      name,
      position: { x, y },
      rotation,
      width: 1.8,
      depth: 0.7,
      servers,
      serviceTime,
      queueSpacing: 0.65,
      ...options,
    }
    this.servicePoints.push(created)
    return created
  }

  build(): Plan {
    return {
      walls: this.walls,
      openings: this.openings,
      furniture: this.furniture,
      zones: this.zones,
      servicePoints: this.servicePoints,
    }
  }
}

export const step = (
  kind: ItineraryStep['kind'],
  targetId?: string,
  extra: Partial<ItineraryStep> = {},
): ItineraryStep => ({
  id: newId('step'),
  kind,
  ...(targetId ? { targetId } : {}),
  ...extra,
})
