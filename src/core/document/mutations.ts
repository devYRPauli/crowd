/**
 * Pure document edits.
 *
 * Every change to a document goes through one of these functions. They return a
 * new document that structurally shares everything they did not touch, which
 * keeps undo snapshots cheap and lets React re-render only what changed.
 */

import type {
  CrowdDocument,
  DocumentSettings,
  FurnitureItem,
  Opening,
  ItineraryStep,
  Plan,
  PlanObjectRef,
  Population,
  Scenario,
  ServicePoint,
  Wall,
  Zone,
  Backdrop,
} from '../model/types'
import { wallLength } from '../model/planGeometry'

type PlanPatch = Partial<Plan>

const withPlan = (doc: CrowdDocument, patch: PlanPatch): CrowdDocument => ({
  ...doc,
  plan: { ...doc.plan, ...patch },
  updatedAt: new Date().toISOString(),
})

const replaceById = <T extends { id: string }>(items: T[], id: string, patch: Partial<T>): T[] => {
  let changed = false
  const next = items.map((item) => {
    if (item.id !== id) return item
    changed = true
    return { ...item, ...patch }
  })
  return changed ? next : items
}

// --- walls -------------------------------------------------------------------

export const addWall = (doc: CrowdDocument, wall: Wall): CrowdDocument =>
  withPlan(doc, { walls: [...doc.plan.walls, wall] })

export const addWalls = (doc: CrowdDocument, walls: Wall[]): CrowdDocument =>
  walls.length === 0 ? doc : withPlan(doc, { walls: [...doc.plan.walls, ...walls] })

export const updateWall = (doc: CrowdDocument, id: string, patch: Partial<Wall>): CrowdDocument => {
  const walls = replaceById(doc.plan.walls, id, patch)
  if (walls === doc.plan.walls) return doc
  // Openings are positioned along the wall; keep them inside a shortened wall.
  const wall = walls.find((w) => w.id === id)
  if (!wall) return withPlan(doc, { walls })
  const length = wallLength(wall)
  const openings = doc.plan.openings.map((opening) => {
    if (opening.wallId !== id) return opening
    const halfWidth = Math.min(opening.width, length) / 2
    const offset = Math.min(
      Math.max(opening.offset, halfWidth),
      Math.max(halfWidth, length - halfWidth),
    )
    const width = Math.min(opening.width, length)
    return offset === opening.offset && width === opening.width
      ? opening
      : { ...opening, offset, width }
  })
  return withPlan(doc, { walls, openings })
}

// --- openings ----------------------------------------------------------------

export const addOpening = (doc: CrowdDocument, opening: Opening): CrowdDocument =>
  withPlan(doc, { openings: [...doc.plan.openings, opening] })

export const updateOpening = (
  doc: CrowdDocument,
  id: string,
  patch: Partial<Opening>,
): CrowdDocument => withPlan(doc, { openings: replaceById(doc.plan.openings, id, patch) })

// --- furniture ---------------------------------------------------------------

export const addFurniture = (doc: CrowdDocument, items: FurnitureItem[]): CrowdDocument =>
  items.length === 0 ? doc : withPlan(doc, { furniture: [...doc.plan.furniture, ...items] })

export const updateFurniture = (
  doc: CrowdDocument,
  id: string,
  patch: Partial<FurnitureItem>,
): CrowdDocument => withPlan(doc, { furniture: replaceById(doc.plan.furniture, id, patch) })

// --- zones -------------------------------------------------------------------

export const addZone = (doc: CrowdDocument, zone: Zone): CrowdDocument =>
  withPlan(doc, { zones: [...doc.plan.zones, zone] })

export const updateZone = (doc: CrowdDocument, id: string, patch: Partial<Zone>): CrowdDocument =>
  withPlan(doc, { zones: replaceById(doc.plan.zones, id, patch) })

// --- service points ----------------------------------------------------------

export const addServicePoint = (doc: CrowdDocument, point: ServicePoint): CrowdDocument =>
  withPlan(doc, { servicePoints: [...doc.plan.servicePoints, point] })

export const updateServicePoint = (
  doc: CrowdDocument,
  id: string,
  patch: Partial<ServicePoint>,
): CrowdDocument => withPlan(doc, { servicePoints: replaceById(doc.plan.servicePoints, id, patch) })

// --- backdrop ----------------------------------------------------------------

export const setBackdrop = (doc: CrowdDocument, backdrop: Backdrop | undefined): CrowdDocument => {
  const plan = { ...doc.plan }
  if (backdrop) plan.backdrop = backdrop
  else delete plan.backdrop
  return { ...doc, plan, updatedAt: new Date().toISOString() }
}

export const updateBackdrop = (doc: CrowdDocument, patch: Partial<Backdrop>): CrowdDocument =>
  doc.plan.backdrop ? setBackdrop(doc, { ...doc.plan.backdrop, ...patch }) : doc

// --- generic -----------------------------------------------------------------

/** Apply a patch to any plan object, dispatching on its kind. */
export const updateObject = (
  doc: CrowdDocument,
  ref: PlanObjectRef,
  patch: Record<string, unknown>,
): CrowdDocument => {
  switch (ref.kind) {
    case 'wall':
      return updateWall(doc, ref.id, patch as Partial<Wall>)
    case 'opening':
      return updateOpening(doc, ref.id, patch as Partial<Opening>)
    case 'furniture':
      return updateFurniture(doc, ref.id, patch as Partial<FurnitureItem>)
    case 'zone':
      return updateZone(doc, ref.id, patch as Partial<Zone>)
    case 'service':
      return updateServicePoint(doc, ref.id, patch as Partial<ServicePoint>)
    case 'backdrop':
      return updateBackdrop(doc, patch as Partial<Backdrop>)
  }
}

/** Remove a set of objects, cascading openings when their wall goes. */
export const removeObjects = (
  doc: CrowdDocument,
  refs: readonly PlanObjectRef[],
): CrowdDocument => {
  if (refs.length === 0) return doc
  const wallIds = new Set(refs.filter((r) => r.kind === 'wall').map((r) => r.id))
  const openingIds = new Set(refs.filter((r) => r.kind === 'opening').map((r) => r.id))
  const furnitureIds = new Set(refs.filter((r) => r.kind === 'furniture').map((r) => r.id))
  const zoneIds = new Set(refs.filter((r) => r.kind === 'zone').map((r) => r.id))
  const serviceIds = new Set(refs.filter((r) => r.kind === 'service').map((r) => r.id))
  const dropBackdrop = refs.some((r) => r.kind === 'backdrop')

  const plan: Plan = {
    walls: doc.plan.walls.filter((w) => !wallIds.has(w.id)),
    openings: doc.plan.openings.filter((o) => !openingIds.has(o.id) && !wallIds.has(o.wallId)),
    furniture: doc.plan.furniture.filter((f) => !furnitureIds.has(f.id)),
    zones: doc.plan.zones.filter((z) => !zoneIds.has(z.id)),
    servicePoints: doc.plan.servicePoints.filter((s) => !serviceIds.has(s.id)),
  }
  if (doc.plan.backdrop && !dropBackdrop) plan.backdrop = doc.plan.backdrop

  // Itineraries and entry lists can reference deleted zones, counters — or
  // doors, since a door marked as a way in or out is a destination in its own
  // right. Openings that go with their wall count as deleted too, which is how
  // a population ends up pointing at a doorway nobody meant to remove.
  const goneOpenings = doc.plan.openings
    .filter((opening) => openingIds.has(opening.id) || wallIds.has(opening.wallId))
    .map((opening) => opening.id)
  const removedTargets = new Set([...zoneIds, ...serviceIds, ...goneOpenings])

  const populations = doc.scenario.populations.map((pop) => {
    const entryIds = pop.entryIds.filter((id) => !removedTargets.has(id))
    let changed = entryIds.length !== pop.entryIds.length
    const itinerary: ItineraryStep[] = []
    for (const step of pop.itinerary) {
      if (step.targetIds) {
        const targetIds = step.targetIds.filter((id) => !removedTargets.has(id))
        if (targetIds.length === step.targetIds.length) {
          itinerary.push(step)
          continue
        }
        changed = true
        // A step that named counters and has none left has nothing to do. The
        // same step written with a single `targetId` is dropped for exactly
        // that reason, and two spellings of one thing must not disagree.
        if (targetIds.length > 0) itinerary.push({ ...step, targetIds })
        continue
      }
      if (step.targetId && removedTargets.has(step.targetId)) {
        changed = true
        continue
      }
      itinerary.push(step)
    }
    // Deciding this on lengths alone missed the case that matters: pruning ids
    // out of a step does not change how many steps there are, so the pruned
    // itinerary was computed and then thrown away, and the plan lost a counter
    // the itinerary still named.
    return changed ? { ...pop, entryIds, itinerary } : pop
  })

  return {
    ...doc,
    plan,
    scenario: { ...doc.scenario, populations },
    updatedAt: new Date().toISOString(),
  }
}

// --- scenario ----------------------------------------------------------------

export const updateScenario = (doc: CrowdDocument, patch: Partial<Scenario>): CrowdDocument => ({
  ...doc,
  scenario: { ...doc.scenario, ...patch },
  updatedAt: new Date().toISOString(),
})

export const updatePopulation = (
  doc: CrowdDocument,
  id: string,
  patch: Partial<Population>,
): CrowdDocument =>
  updateScenario(doc, { populations: replaceById(doc.scenario.populations, id, patch) })

export const addPopulation = (doc: CrowdDocument, population: Population): CrowdDocument =>
  updateScenario(doc, { populations: [...doc.scenario.populations, population] })

export const removePopulation = (doc: CrowdDocument, id: string): CrowdDocument =>
  updateScenario(doc, { populations: doc.scenario.populations.filter((p) => p.id !== id) })

export const updateSettings = (
  doc: CrowdDocument,
  patch: Partial<DocumentSettings>,
): CrowdDocument => ({
  ...doc,
  settings: { ...doc.settings, ...patch },
  updatedAt: new Date().toISOString(),
})

export const renameDocument = (doc: CrowdDocument, name: string): CrowdDocument => ({
  ...doc,
  name,
  updatedAt: new Date().toISOString(),
})

// --- lookup helpers ----------------------------------------------------------

export const findObject = (doc: CrowdDocument, ref: PlanObjectRef) => {
  switch (ref.kind) {
    case 'wall':
      return doc.plan.walls.find((w) => w.id === ref.id)
    case 'opening':
      return doc.plan.openings.find((o) => o.id === ref.id)
    case 'furniture':
      return doc.plan.furniture.find((f) => f.id === ref.id)
    case 'zone':
      return doc.plan.zones.find((z) => z.id === ref.id)
    case 'service':
      return doc.plan.servicePoints.find((s) => s.id === ref.id)
    case 'backdrop':
      return doc.plan.backdrop
  }
}

export const isLocked = (doc: CrowdDocument, ref: PlanObjectRef): boolean => {
  const object = findObject(doc, ref)
  return Boolean(object && 'locked' in object && object.locked)
}
