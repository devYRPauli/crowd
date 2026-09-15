/**
 * Reading and writing `.crowd.json` files.
 *
 * Parsing is defensive on purpose: a document may come from an older build, a
 * hand edit or a different machine. Rather than trusting the input or throwing
 * on the first surprise, we coerce every field towards something the rest of
 * the app can work with and collect what we had to repair, so the UI can tell
 * the user what happened.
 */

import type {
  ArrivalProfile,
  CrowdDocument,
  FurnitureItem,
  ItineraryStep,
  Opening,
  Plan,
  Population,
  Scenario,
  ServicePoint,
  Wall,
  Zone,
} from '../model/types'
import { SCHEMA_VERSION } from '../model/types'
import {
  AGENT_PROFILES,
  DEFAULT_PROFILE_MIX,
  DEFAULT_SETTINGS,
  createScenario,
} from '../model/defaults'
import { newDocumentId, newId } from '../model/ids'
import type { Vec2 } from '../math/vec2'
import type { Distribution } from '../math/random'

export interface ParseResult {
  document: CrowdDocument
  warnings: string[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const str = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.length > 0 ? value : fallback

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const point = (value: unknown, fallback: Vec2 = { x: 0, y: 0 }): Vec2 => {
  if (Array.isArray(value) && value.length >= 2) {
    return { x: num(value[0], fallback.x), y: num(value[1], fallback.y) }
  }
  if (isObject(value)) return { x: num(value.x, fallback.x), y: num(value.y, fallback.y) }
  return { ...fallback }
}

const points = (value: unknown): Vec2[] => (Array.isArray(value) ? value.map((p) => point(p)) : [])

const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const DISTRIBUTION_KINDS = [
  'constant',
  'normal',
  'lognormal',
  'exponential',
  'uniform',
  'triangular',
] as const

const parseDistribution = (value: unknown, fallbackMean: number): Distribution | undefined => {
  if (!isObject(value)) return undefined
  const kind = DISTRIBUTION_KINDS.includes(value.kind as never)
    ? (value.kind as Distribution['kind'])
    : 'lognormal'
  return {
    kind,
    mean: Math.max(0, num(value.mean, fallbackMean)),
    ...(typeof value.sd === 'number' ? { sd: Math.max(0, value.sd) } : {}),
    ...(typeof value.min === 'number' ? { min: value.min } : {}),
    ...(typeof value.max === 'number' ? { max: value.max } : {}),
  }
}

const parseWall = (raw: unknown): Wall | null => {
  if (!isObject(raw)) return null
  const a = point(raw.a)
  const b = point(raw.b)
  if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-4) return null
  return {
    id: str(raw.id, newId('wall')),
    a,
    b,
    thickness: Math.max(0.02, num(raw.thickness, DEFAULT_SETTINGS.defaultWallThickness)),
    height: Math.max(0.05, num(raw.height, DEFAULT_SETTINGS.defaultWallHeight)),
    kind: (['wall', 'partition', 'glass', 'barrier', 'rail'] as const).includes(raw.kind as never)
      ? (raw.kind as Wall['kind'])
      : 'wall',
    ...(typeof raw.color === 'string' ? { color: raw.color } : {}),
    ...(raw.locked === true ? { locked: true } : {}),
  }
}

const parseOpening = (raw: unknown, wallIds: Set<string>): Opening | null => {
  if (!isObject(raw)) return null
  const wallId = str(raw.wallId, '')
  if (!wallIds.has(wallId)) return null
  const kind = (['door', 'double-door', 'opening', 'window', 'gate'] as const).includes(
    raw.kind as never,
  )
    ? (raw.kind as Opening['kind'])
    : 'door'
  return {
    id: str(raw.id, newId('open')),
    wallId,
    offset: Math.max(0, num(raw.offset, 1)),
    width: Math.max(
      0.1,
      num(
        raw.width,
        kind === 'window' ? DEFAULT_SETTINGS.defaultWindowWidth : DEFAULT_SETTINGS.defaultDoorWidth,
      ),
    ),
    height: Math.max(
      0.1,
      num(
        raw.height,
        kind === 'window'
          ? DEFAULT_SETTINGS.defaultWindowHeight
          : DEFAULT_SETTINGS.defaultDoorHeight,
      ),
    ),
    sill: Math.max(0, num(raw.sill, kind === 'window' ? DEFAULT_SETTINGS.defaultWindowSill : 0)),
    kind,
    ...(typeof raw.swing === 'string' ? { swing: raw.swing as Opening['swing'] } : {}),
    ...(raw.locked === true ? { locked: true } : {}),
  }
}

const parseFurniture = (raw: unknown): FurnitureItem | null => {
  if (!isObject(raw)) return null
  const catalogId = str(raw.catalogId, '')
  if (!catalogId) return null
  const size = isObject(raw.size)
    ? {
        width: Math.max(0.05, num(raw.size.width, 1)),
        depth: Math.max(0.05, num(raw.size.depth, 1)),
        height: Math.max(0.02, num(raw.size.height, 1)),
      }
    : undefined
  return {
    id: str(raw.id, newId('item')),
    catalogId,
    position: point(raw.position),
    rotation: num(raw.rotation, 0),
    ...(size ? { size } : {}),
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    ...(typeof raw.color === 'string' ? { color: raw.color } : {}),
    ...(raw.locked === true ? { locked: true } : {}),
    ...(typeof raw.blocking === 'boolean' ? { blocking: raw.blocking } : {}),
  }
}

const parseZone = (raw: unknown): Zone | null => {
  if (!isObject(raw)) return null
  const polygon = points(raw.polygon)
  if (polygon.length < 3) return null
  const kind = (
    ['entry', 'exit', 'waypoint', 'obstacle', 'keep-clear', 'seating', 'measure'] as const
  ).includes(raw.kind as never)
    ? (raw.kind as Zone['kind'])
    : 'waypoint'
  return {
    id: str(raw.id, newId('zone')),
    kind,
    name: str(raw.name, 'Zone'),
    polygon,
    ...(typeof raw.color === 'string' ? { color: raw.color } : {}),
    ...(raw.locked === true ? { locked: true } : {}),
    ...(typeof raw.cost === 'number' ? { cost: raw.cost } : {}),
    ...(parseDistribution(raw.dwell, 60) ? { dwell: parseDistribution(raw.dwell, 60) } : {}),
    ...(typeof raw.capacity === 'number' ? { capacity: raw.capacity } : {}),
  }
}

const parseServicePoint = (raw: unknown): ServicePoint | null => {
  if (!isObject(raw)) return null
  const queue = points(raw.queue)
  return {
    id: str(raw.id, newId('svc')),
    name: str(raw.name, 'Service point'),
    position: point(raw.position),
    rotation: num(raw.rotation, 0),
    width: Math.max(0.3, num(raw.width, 1.8)),
    depth: Math.max(0.2, num(raw.depth, 0.7)),
    servers: Math.max(1, Math.round(num(raw.servers, 1))),
    serviceTime: parseDistribution(raw.serviceTime, 20) ?? { kind: 'lognormal', mean: 20, sd: 6 },
    ...(queue.length >= 2 ? { queue } : {}),
    queueSpacing: Math.max(0.3, num(raw.queueSpacing, 0.6)),
    ...(typeof raw.color === 'string' ? { color: raw.color } : {}),
    ...(raw.locked === true ? { locked: true } : {}),
    ...(typeof raw.opensAt === 'number' ? { opensAt: raw.opensAt } : {}),
    ...(typeof raw.closesAt === 'number' ? { closesAt: raw.closesAt } : {}),
  }
}

const parseArrival = (raw: unknown): ArrivalProfile => {
  if (!isObject(raw)) return { kind: 'uniform', startS: 0, windowS: 600 }
  const kind = (
    ['uniform', 'poisson', 'waves', 'front-loaded', 'peak', 'all-at-once'] as const
  ).includes(raw.kind as never)
    ? (raw.kind as ArrivalProfile['kind'])
    : 'uniform'
  return {
    kind,
    startS: Math.max(0, num(raw.startS, 0)),
    windowS: Math.max(0, num(raw.windowS, 600)),
    ...(typeof raw.waves === 'number' ? { waves: Math.max(1, Math.round(raw.waves)) } : {}),
    ...(typeof raw.peakAt === 'number' ? { peakAt: raw.peakAt } : {}),
    ...(typeof raw.spread === 'number' ? { spread: raw.spread } : {}),
  }
}

const parseItineraryStep = (raw: unknown): ItineraryStep | null => {
  if (!isObject(raw)) return null
  const kind = (['goto', 'service', 'dwell', 'seat', 'exit'] as const).includes(raw.kind as never)
    ? (raw.kind as ItineraryStep['kind'])
    : null
  if (!kind) return null
  return {
    id: str(raw.id, newId('step')),
    kind,
    ...(typeof raw.targetId === 'string' ? { targetId: raw.targetId } : {}),
    ...(Array.isArray(raw.targetIds)
      ? { targetIds: raw.targetIds.filter((v): v is string => typeof v === 'string') }
      : {}),
    ...(typeof raw.probability === 'number' ? { probability: raw.probability } : {}),
    ...(parseDistribution(raw.duration, 60)
      ? { duration: parseDistribution(raw.duration, 60) }
      : {}),
    ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
  }
}

const parsePopulation = (raw: unknown, index: number): Population | null => {
  if (!isObject(raw)) return null
  const mix = array(raw.profileMix)
    .filter(isObject)
    .map((entry) => ({
      profileId: str(entry.profileId, 'adult'),
      weight: Math.max(0, num(entry.weight, 1)),
    }))
  return {
    id: str(raw.id, newId('pop')),
    name: str(raw.name, `Group ${index + 1}`),
    count: Math.max(0, Math.round(num(raw.count, 100))),
    color: str(raw.color, '#4c7dd4'),
    entryIds: array(raw.entryIds).filter((v): v is string => typeof v === 'string'),
    arrival: parseArrival(raw.arrival),
    profileMix: mix.length ? mix : DEFAULT_PROFILE_MIX.map((m) => ({ ...m })),
    itinerary: array(raw.itinerary)
      .map(parseItineraryStep)
      .filter((s): s is ItineraryStep => s !== null),
    ...(isObject(raw.groupSize)
      ? {
          groupSize: {
            min: Math.max(1, Math.round(num(raw.groupSize.min, 1))),
            max: Math.max(1, Math.round(num(raw.groupSize.max, 1))),
          },
        }
      : {}),
  }
}

const parseScenario = (raw: unknown): Scenario => {
  const base = createScenario()
  if (!isObject(raw)) return base
  const populations = array(raw.populations)
    .map(parsePopulation)
    .filter((p): p is Population => p !== null)
  const profiles = array(raw.profiles).filter(isObject).length
    ? array(raw.profiles)
        .filter(isObject)
        .map((p) => ({
          id: str(p.id, newId('profile')),
          name: str(p.name, 'Profile'),
          radius: Math.max(0.05, num(p.radius, 0.23)),
          speed: isObject(p.speed)
            ? {
                mean: Math.max(0.1, num(p.speed.mean, 1.34)),
                sd: Math.max(0, num(p.speed.sd, 0.26)),
                min: Math.max(0.05, num(p.speed.min, 0.6)),
                max: Math.max(0.1, num(p.speed.max, 2.0)),
              }
            : { mean: 1.34, sd: 0.26, min: 0.6, max: 2.0 },
          caution: Math.max(0.1, num(p.caution, 1)),
          assertiveness: Math.min(1, Math.max(0, num(p.assertiveness, 0.5))),
          color: str(p.color, '#4c7dd4'),
          heightScale: Math.max(0.3, num(p.heightScale, 1)),
          mobility: (['walking', 'assisted', 'wheelchair'] as const).includes(p.mobility as never)
            ? (p.mobility as 'walking' | 'assisted' | 'wheelchair')
            : 'walking',
        }))
    : AGENT_PROFILES.map((p) => ({ ...p }))
  const routing = isObject(raw.routing) ? raw.routing : {}
  return {
    name: str(raw.name, base.name),
    durationS: Math.max(10, num(raw.durationS, base.durationS)),
    seed: Math.max(0, Math.round(num(raw.seed, base.seed))),
    populations: populations.length ? populations : base.populations,
    profiles,
    speedFactor: Math.max(0.1, num(raw.speedFactor, 1)),
    routing: {
      adaptive: bool(routing.adaptive, true),
      congestionWeight: Math.min(1, Math.max(0, num(routing.congestionWeight, 0.55))),
      replanIntervalS: Math.max(0.25, num(routing.replanIntervalS, 2)),
      routeVariety: Math.min(1, Math.max(0, num(routing.routeVariety, 0.25))),
    },
    evacuationAtS:
      typeof raw.evacuationAtS === 'number' && Number.isFinite(raw.evacuationAtS)
        ? raw.evacuationAtS
        : null,
  }
}

/** Parse anything into a usable document, reporting what had to be repaired. */
export const parseDocument = (input: unknown): ParseResult => {
  const warnings: string[] = []
  let raw = isObject(input) ? input : {}
  // An exported report carries the document it came from. Opening one should
  // restore that plan rather than fail, because a report is what gets emailed.
  if (raw.format === 'crowd-report' && isObject(raw.document)) {
    raw = raw.document
  }
  if (!isObject(input)) warnings.push('The file did not contain a CROWD document; started empty.')

  const version = num(raw.schemaVersion, 0)
  if (version > SCHEMA_VERSION) {
    warnings.push(
      `This file was saved by a newer version of CROWD (schema ${version}). Unknown settings were ignored.`,
    )
  }

  const planRaw = isObject(raw.plan) ? raw.plan : {}
  const walls = array(planRaw.walls)
    .map(parseWall)
    .filter((w): w is Wall => w !== null)
  const wallIds = new Set(walls.map((w) => w.id))
  const openingsRaw = array(planRaw.openings)
  const openings = openingsRaw
    .map((o) => parseOpening(o, wallIds))
    .filter((o): o is Opening => o !== null)
  if (openings.length !== openingsRaw.length) {
    warnings.push(
      `${openingsRaw.length - openings.length} opening(s) referenced a missing wall and were dropped.`,
    )
  }

  const plan: Plan = {
    walls,
    openings,
    furniture: array(planRaw.furniture)
      .map(parseFurniture)
      .filter((f): f is FurnitureItem => f !== null),
    zones: array(planRaw.zones)
      .map(parseZone)
      .filter((z): z is Zone => z !== null),
    servicePoints: array(planRaw.servicePoints)
      .map(parseServicePoint)
      .filter((s): s is ServicePoint => s !== null),
  }
  if (isObject(planRaw.backdrop) && typeof planRaw.backdrop.src === 'string') {
    plan.backdrop = {
      src: planRaw.backdrop.src,
      position: point(planRaw.backdrop.position),
      rotation: num(planRaw.backdrop.rotation, 0),
      width: Math.max(0.1, num(planRaw.backdrop.width, 20)),
      depth: Math.max(0.1, num(planRaw.backdrop.depth, 14)),
      opacity: Math.min(1, Math.max(0, num(planRaw.backdrop.opacity, 0.6))),
      visible: bool(planRaw.backdrop.visible, true),
      ...(planRaw.backdrop.locked === true ? { locked: true } : {}),
    }
  }

  const settingsRaw = isObject(raw.settings) ? raw.settings : {}
  const now = new Date().toISOString()

  return {
    document: {
      schemaVersion: SCHEMA_VERSION,
      id: str(raw.id, newDocumentId()),
      name: str(raw.name, 'Untitled venue'),
      createdAt: str(raw.createdAt, now),
      updatedAt: now,
      settings: {
        units: settingsRaw.units === 'imperial' ? 'imperial' : 'metric',
        gridSize: Math.max(0.05, num(settingsRaw.gridSize, DEFAULT_SETTINGS.gridSize)),
        snapToGrid: bool(settingsRaw.snapToGrid, true),
        snapToObjects: bool(settingsRaw.snapToObjects, true),
        angleSnapDeg: Math.max(0, num(settingsRaw.angleSnapDeg, 15)),
        defaultWallHeight: Math.max(
          0.5,
          num(settingsRaw.defaultWallHeight, DEFAULT_SETTINGS.defaultWallHeight),
        ),
        defaultWallThickness: Math.max(
          0.02,
          num(settingsRaw.defaultWallThickness, DEFAULT_SETTINGS.defaultWallThickness),
        ),
        defaultDoorWidth: Math.max(
          0.3,
          num(settingsRaw.defaultDoorWidth, DEFAULT_SETTINGS.defaultDoorWidth),
        ),
        defaultDoorHeight: Math.max(
          0.5,
          num(settingsRaw.defaultDoorHeight, DEFAULT_SETTINGS.defaultDoorHeight),
        ),
        defaultWindowWidth: Math.max(
          0.1,
          num(settingsRaw.defaultWindowWidth, DEFAULT_SETTINGS.defaultWindowWidth),
        ),
        defaultWindowHeight: Math.max(
          0.1,
          num(settingsRaw.defaultWindowHeight, DEFAULT_SETTINGS.defaultWindowHeight),
        ),
        defaultWindowSill: Math.max(
          0,
          num(settingsRaw.defaultWindowSill, DEFAULT_SETTINGS.defaultWindowSill),
        ),
      },
      plan,
      scenario: parseScenario(raw.scenario),
    },
    warnings,
  }
}

export const parseDocumentJson = (text: string): ParseResult => {
  try {
    return parseDocument(JSON.parse(text))
  } catch {
    const result = parseDocument(null)
    result.warnings.unshift('That file is not valid JSON.')
    return result
  }
}

export const serializeDocument = (doc: CrowdDocument): string => JSON.stringify(doc, null, 2)

export const documentFileName = (doc: CrowdDocument): string =>
  `${
    doc.name
      .replace(/[^\w\- ]+/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .toLowerCase() || 'venue'
  }.crowd.json`
