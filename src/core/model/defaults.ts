/**
 * Defaults and profile presets.
 *
 * The numbers here are the product's opinions. They come from event-industry
 * practice (counter heights, aisle widths) and from the pedestrian-dynamics
 * literature: free-flow walking speeds follow Weidmann's review, which puts the
 * mean adult at about 1.34 m/s with a standard deviation near 0.26 m/s.
 */

import type {
  AgentProfile,
  DocumentSettings,
  ItineraryStep,
  Population,
  Scenario,
  Plan,
  CrowdDocument,
} from './types'
import { SCHEMA_VERSION } from './types'
import { newDocumentId, newId } from './ids'

export const DEFAULT_SETTINGS: DocumentSettings = {
  units: 'metric',
  gridSize: 0.5,
  snapToGrid: true,
  snapToObjects: true,
  angleSnapDeg: 15,
  defaultWallHeight: 3.0,
  defaultWallThickness: 0.15,
  defaultDoorWidth: 0.9,
}

export const AGENT_PROFILES: AgentProfile[] = [
  {
    id: 'adult',
    name: 'Adult',
    radius: 0.23,
    speed: { mean: 1.34, sd: 0.26, min: 0.7, max: 2.0 },
    caution: 1.0,
    assertiveness: 0.5,
    color: '#4c7dd4',
    heightScale: 1.0,
    mobility: 'walking',
  },
  {
    id: 'hurried',
    name: 'In a hurry',
    radius: 0.22,
    speed: { mean: 1.65, sd: 0.2, min: 1.1, max: 2.3 },
    caution: 0.75,
    assertiveness: 0.85,
    color: '#d4694c',
    heightScale: 1.0,
    mobility: 'walking',
  },
  {
    id: 'senior',
    name: 'Older adult',
    radius: 0.24,
    speed: { mean: 0.97, sd: 0.19, min: 0.5, max: 1.4 },
    caution: 1.35,
    assertiveness: 0.25,
    color: '#8a7fb8',
    heightScale: 0.96,
    mobility: 'walking',
  },
  {
    id: 'child',
    name: 'Child',
    radius: 0.17,
    speed: { mean: 1.1, sd: 0.3, min: 0.5, max: 1.8 },
    caution: 0.9,
    assertiveness: 0.4,
    color: '#49a884',
    heightScale: 0.72,
    mobility: 'walking',
  },
  {
    id: 'wheelchair',
    name: 'Wheelchair user',
    radius: 0.38,
    speed: { mean: 0.89, sd: 0.15, min: 0.4, max: 1.3 },
    caution: 1.4,
    assertiveness: 0.3,
    color: '#c9a227',
    heightScale: 0.76,
    mobility: 'wheelchair',
  },
  {
    id: 'staff',
    name: 'Staff',
    radius: 0.23,
    speed: { mean: 1.4, sd: 0.15, min: 0.9, max: 1.9 },
    caution: 0.9,
    assertiveness: 0.7,
    color: '#3f9ab0',
    heightScale: 1.0,
    mobility: 'walking',
  },
  {
    id: 'luggage',
    name: 'With luggage',
    radius: 0.32,
    speed: { mean: 1.1, sd: 0.2, min: 0.6, max: 1.6 },
    caution: 1.2,
    assertiveness: 0.4,
    color: '#a8785a',
    heightScale: 1.0,
    mobility: 'assisted',
  },
]

export const DEFAULT_PROFILE_MIX: Population['profileMix'] = [
  { profileId: 'adult', weight: 62 },
  { profileId: 'hurried', weight: 12 },
  { profileId: 'senior', weight: 12 },
  { profileId: 'child', weight: 8 },
  { profileId: 'luggage', weight: 4 },
  { profileId: 'wheelchair', weight: 2 },
]

export const POPULATION_COLORS = ['#4c7dd4', '#d4694c', '#49a884', '#c9a227', '#8a7fb8', '#3f9ab0']

export const createItineraryStep = (
  kind: ItineraryStep['kind'],
  targetId?: string,
): ItineraryStep => ({ id: newId('step'), kind, targetId })

export const createPopulation = (index = 0): Population => ({
  id: newId('pop'),
  name: index === 0 ? 'Attendees' : `Group ${index + 1}`,
  count: 120,
  color: POPULATION_COLORS[index % POPULATION_COLORS.length],
  entryIds: [],
  arrival: { kind: 'uniform', startS: 0, windowS: 600 },
  profileMix: DEFAULT_PROFILE_MIX.map((entry) => ({ ...entry })),
  itinerary: [createItineraryStep('exit')],
})

export const createScenario = (): Scenario => ({
  name: 'Baseline',
  durationS: 1800,
  seed: 1,
  populations: [createPopulation(0)],
  profiles: AGENT_PROFILES.map((profile) => ({ ...profile })),
  speedFactor: 1,
  routing: {
    adaptive: true,
    congestionWeight: 0.55,
    replanIntervalS: 2,
    routeVariety: 0.25,
  },
  evacuationAtS: null,
})

export const createEmptyPlan = (): Plan => ({
  walls: [],
  openings: [],
  furniture: [],
  zones: [],
  servicePoints: [],
})

export const createDocument = (name = 'Untitled venue'): CrowdDocument => {
  const now = new Date().toISOString()
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newDocumentId(),
    name,
    createdAt: now,
    updatedAt: now,
    settings: { ...DEFAULT_SETTINGS },
    plan: createEmptyPlan(),
    scenario: createScenario(),
  }
}

/** Zone colours are fixed so the plan reads the same way in every document. */
export const ZONE_COLORS: Record<string, string> = {
  entry: '#3fb27f',
  exit: '#e0603f',
  waypoint: '#4c7dd4',
  obstacle: '#6b7280',
  'keep-clear': '#e8b33a',
  seating: '#8a7fb8',
  measure: '#38bdf8',
}

export const ZONE_LABELS: Record<string, string> = {
  entry: 'Entry',
  exit: 'Exit',
  waypoint: 'Destination',
  obstacle: 'Blocked area',
  'keep-clear': 'Keep clear',
  seating: 'Seating area',
  measure: 'Measurement area',
}
