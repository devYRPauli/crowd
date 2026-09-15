/**
 * Copy, paste and duplicate.
 *
 * The clipboard holds plan objects, not a serialised blob, so a paste into a
 * different project still works. Pasted objects get fresh ids and are offset,
 * so a paste is always visible rather than landing exactly on the original and
 * looking like nothing happened.
 *
 * Openings travel with their wall: copying a wall that has a door in it and
 * pasting it should give you a wall with a door in it.
 */

import type {
  CrowdDocument,
  FurnitureItem,
  Opening,
  PlanObjectRef,
  ServicePoint,
  Wall,
  Zone,
} from '../model/types'
import { newId } from '../model/ids'
import type { Vec2 } from '../math/vec2'

export interface Clipboard {
  walls: Wall[]
  openings: Opening[]
  furniture: FurnitureItem[]
  zones: Zone[]
  servicePoints: ServicePoint[]
}

export const emptyClipboard = (): Clipboard => ({
  walls: [],
  openings: [],
  furniture: [],
  zones: [],
  servicePoints: [],
})

export const clipboardSize = (clipboard: Clipboard): number =>
  clipboard.walls.length +
  clipboard.furniture.length +
  clipboard.zones.length +
  clipboard.servicePoints.length

/** Gather the selected objects, deep-copied so later edits cannot reach them. */
export const copySelection = (doc: CrowdDocument, refs: readonly PlanObjectRef[]): Clipboard => {
  const wallIds = new Set(refs.filter((r) => r.kind === 'wall').map((r) => r.id))
  const clipboard: Clipboard = {
    walls: doc.plan.walls.filter((wall) => wallIds.has(wall.id)).map(cloneWall),
    // Doors and windows come along with the wall they are cut into.
    openings: doc.plan.openings
      .filter((opening) => wallIds.has(opening.wallId))
      .map((o) => ({ ...o })),
    furniture: doc.plan.furniture
      .filter((item) => refs.some((r) => r.kind === 'furniture' && r.id === item.id))
      .map((item) => ({ ...item, position: { ...item.position } })),
    zones: doc.plan.zones
      .filter((zone) => refs.some((r) => r.kind === 'zone' && r.id === zone.id))
      .map((zone) => ({ ...zone, polygon: zone.polygon.map((p) => ({ ...p })) })),
    servicePoints: doc.plan.servicePoints
      .filter((point) => refs.some((r) => r.kind === 'service' && r.id === point.id))
      .map((point) => ({
        ...point,
        position: { ...point.position },
        ...(point.queue ? { queue: point.queue.map((p) => ({ ...p })) } : {}),
      })),
  }
  return clipboard
}

const cloneWall = (wall: Wall): Wall => ({ ...wall, a: { ...wall.a }, b: { ...wall.b } })

const shift = (point: Vec2, offset: Vec2): Vec2 => ({
  x: point.x + offset.x,
  y: point.y + offset.y,
})

/**
 * Insert the clipboard at an offset, returning the new document and references
 * to what was created so the caller can select it.
 */
export const paste = (
  doc: CrowdDocument,
  clipboard: Clipboard,
  offset: Vec2,
): { document: CrowdDocument; refs: PlanObjectRef[] } => {
  if (clipboardSize(clipboard) === 0) return { document: doc, refs: [] }

  const refs: PlanObjectRef[] = []
  const wallIdMap = new Map<string, string>()

  const walls = clipboard.walls.map((wall) => {
    const id = newId('wall')
    wallIdMap.set(wall.id, id)
    refs.push({ kind: 'wall', id })
    return {
      ...cloneWall(wall),
      id,
      a: shift(wall.a, offset),
      b: shift(wall.b, offset),
      locked: false,
    }
  })

  const openings = clipboard.openings
    .filter((opening) => wallIdMap.has(opening.wallId))
    .map((opening) => ({
      ...opening,
      id: newId('open'),
      wallId: wallIdMap.get(opening.wallId) as string,
      locked: false,
    }))

  const furniture = clipboard.furniture.map((item) => {
    const id = newId('item')
    refs.push({ kind: 'furniture', id })
    return { ...item, id, position: shift(item.position, offset), locked: false }
  })

  const zones = clipboard.zones.map((zone) => {
    const id = newId('zone')
    refs.push({ kind: 'zone', id })
    return {
      ...zone,
      id,
      name: `${zone.name} copy`,
      polygon: zone.polygon.map((p) => shift(p, offset)),
      locked: false,
    }
  })

  const servicePoints = clipboard.servicePoints.map((point) => {
    const id = newId('svc')
    refs.push({ kind: 'service', id })
    return {
      ...point,
      id,
      name: `${point.name} copy`,
      position: shift(point.position, offset),
      ...(point.queue ? { queue: point.queue.map((p) => shift(p, offset)) } : {}),
      locked: false,
    }
  })

  return {
    document: {
      ...doc,
      plan: {
        ...doc.plan,
        walls: [...doc.plan.walls, ...walls],
        openings: [...doc.plan.openings, ...openings],
        furniture: [...doc.plan.furniture, ...furniture],
        zones: [...doc.plan.zones, ...zones],
        servicePoints: [...doc.plan.servicePoints, ...servicePoints],
      },
      updatedAt: new Date().toISOString(),
    },
    refs,
  }
}
