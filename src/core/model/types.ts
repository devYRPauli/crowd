/**
 * The CROWD scene document.
 *
 * A document is a plain, serialisable description of a venue (`plan`) and of
 * what happens in it (`scenario`). It holds no derived geometry, no renderer
 * state and no simulation results: everything downstream is a pure function of
 * this object plus a seed, which is what makes runs reproducible and
 * comparable.
 *
 * Units throughout: metres, radians (counter-clockwise, 0 = +X), seconds.
 * The plan lives on the XZ ground plane; `Vec2.y` is world Z.
 */

import type { Vec2 } from '../math/vec2'
import type { Distribution } from '../math/random'

export const SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type WallKind = 'wall' | 'partition' | 'glass' | 'barrier' | 'rail'

/** A straight structural element between two plan points. */
export interface Wall {
  id: string
  a: Vec2
  b: Vec2
  /** Total thickness, centred on the a→b centreline. */
  thickness: number
  height: number
  kind: WallKind
  color?: string
  locked?: boolean
}

export type OpeningKind = 'door' | 'double-door' | 'opening' | 'window' | 'gate'

/** A hole cut into a wall. Only openings with `sill === 0` are walkable. */
export interface Opening {
  id: string
  wallId: string
  /** Distance of the opening centre from the wall's `a` end, in metres. */
  offset: number
  width: number
  height: number
  /** Height of the lower edge above the floor; doors are 0. */
  sill: number
  kind: OpeningKind
  /** Hinge side and swing direction, for drawing door leaves. */
  swing?: 'left' | 'right' | 'both' | 'none'
  /**
   * Whether people arrive through this door, leave through it, or both.
   *
   * A venue's ways in and out are doors, and saying so here rather than by
   * drawing a zone near one means the door's own clear width meters the flow —
   * which is the number every egress calculation turns on. Omitted, the opening
   * is just a hole people may walk through on their way somewhere else.
   */
  use?: 'entry' | 'exit' | 'both'
  locked?: boolean
}

/** An instance of a catalog item placed in the plan. */
export interface FurnitureItem {
  id: string
  catalogId: string
  position: Vec2
  rotation: number
  /** Optional per-instance footprint override, in metres. */
  size?: { width: number; depth: number; height: number }
  name?: string
  color?: string
  locked?: boolean
  /** Overrides the catalog default; `false` lets people walk through. */
  blocking?: boolean
}

export type ZoneKind =
  'entry' | 'exit' | 'waypoint' | 'obstacle' | 'keep-clear' | 'seating' | 'measure'

/** A polygonal region of the floor carrying a role in the simulation. */
export interface Zone {
  id: string
  kind: ZoneKind
  name: string
  polygon: Vec2[]
  color?: string
  locked?: boolean
  /**
   * For `keep-clear`: how strongly routing avoids the region. 1 is a mild
   * preference, 10 makes it a near-obstacle. Ignored for other kinds.
   */
  cost?: number
  /** For `waypoint`: how long people linger, in seconds. */
  dwell?: Distribution
  /** For `waypoint`: how many people can occupy it at once; 0 means unlimited. */
  capacity?: number
}

/** A staffed counter with its own queue. */
export interface ServicePoint {
  id: string
  name: string
  /** Centre of the counter face. */
  position: Vec2
  /** Counter facing; people are served from the +rotation normal side. */
  rotation: number
  /** Counter extent along its face. */
  width: number
  depth: number
  /** Number of simultaneously staffed positions. */
  servers: number
  serviceTime: Distribution
  /**
   * Queue centreline from the head (nearest the counter) to the tail. When
   * omitted a straight line is generated away from the counter face.
   */
  queue?: Vec2[]
  /** Distance between people standing in the queue. */
  queueSpacing: number
  color?: string
  locked?: boolean
  /** Counters can open late or close early, in seconds from run start. */
  opensAt?: number
  closesAt?: number
}

/** A reference floor plan image traced over in the editor. */
export interface Backdrop {
  /** Data URL of the bitmap. */
  src: string
  /** World position of the image centre. */
  position: Vec2
  rotation: number
  /** World width and depth of the image, in metres. */
  width: number
  depth: number
  opacity: number
  visible: boolean
  locked?: boolean
}

export interface Plan {
  walls: Wall[]
  openings: Opening[]
  furniture: FurnitureItem[]
  zones: Zone[]
  servicePoints: ServicePoint[]
  backdrop?: Backdrop
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

/** Locomotion characteristics of a kind of person. */
export interface AgentProfile {
  id: string
  name: string
  /** Body radius used for collision; a typical adult is 0.23 m. */
  radius: number
  /** Free-flow walking speed, sampled per person. */
  speed: { mean: number; sd: number; min: number; max: number }
  /** Multiplier on the neighbour-avoidance time horizon; cautious > 1. */
  caution: number
  /** 0 disables queue-jumping tolerance; higher values accept tighter gaps. */
  assertiveness: number
  color: string
  /** Scales the rendered character height. */
  heightScale: number
  /** Shown in the UI; wheelchair users need wider clearances. */
  mobility: 'walking' | 'assisted' | 'wheelchair'
}

export type ArrivalKind = 'uniform' | 'poisson' | 'waves' | 'front-loaded' | 'peak' | 'all-at-once'

/** How a population's arrivals are spread over time. */
export interface ArrivalProfile {
  kind: ArrivalKind
  /** Arrivals begin at this offset from run start, in seconds. */
  startS: number
  /** Arrivals are spread over this window, in seconds. */
  windowS: number
  /** For `waves`: number of discrete batches. */
  waves?: number
  /** For `peak`: where the peak sits in the window, 0–1. */
  peakAt?: number
  /** For `peak`: spread of the peak as a fraction of the window. */
  spread?: number
}

export type ItineraryStepKind = 'goto' | 'service' | 'dwell' | 'seat' | 'exit'

/** One leg of a person's journey through the venue. */
export interface ItineraryStep {
  id: string
  kind: ItineraryStepKind
  /** Zone id for `goto`/`dwell`/`seat`, service point id for `service`. */
  targetId?: string
  /**
   * Alternatives for a `service` step. When several counters can serve the
   * same purpose, people pick the one they expect to get through soonest —
   * which is what balances parallel desks instead of queueing them all at one.
   */
  targetIds?: string[]
  /** Probability the step is performed at all, 0–1. Defaults to 1. */
  probability?: number
  /** For `dwell`/`seat`: how long the person stays. */
  duration?: Distribution
  /** Free-text label shown in the timeline and inspector. */
  label?: string
}

/** A group of people who share arrivals, an itinerary and a profile mix. */
export interface Population {
  id: string
  name: string
  count: number
  color: string
  /** Entry zone ids; people are distributed across them evenly. */
  entryIds: string[]
  arrival: ArrivalProfile
  /** Weighted mix of agent profiles. */
  profileMix: Array<{ profileId: string; weight: number }>
  itinerary: ItineraryStep[]
  /** People arrive in groups of this size and try to stay together. */
  groupSize?: { min: number; max: number }
}

export interface Scenario {
  name: string
  /** Simulated seconds to run. */
  durationS: number
  seed: number
  populations: Population[]
  profiles: AgentProfile[]
  /** Global multiplier on walking speed, for sensitivity sweeps. */
  speedFactor: number
  /**
   * Congestion-aware routing. When enabled people re-plan around crowding
   * instead of all following the geometrically shortest path.
   */
  routing: {
    adaptive: boolean
    /** How strongly local density inflates path cost, 0–1. */
    congestionWeight: number
    /** Seconds between flow-field refreshes. */
    replanIntervalS: number
    /** Per-person random variation in route preference, 0–1. */
    routeVariety: number
  }
  /** An unannounced evacuation at this time, in seconds; null disables it. */
  evacuationAtS: number | null
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export type UnitSystem = 'metric' | 'imperial'

export interface DocumentSettings {
  units: UnitSystem
  /** Editor snap grid spacing, in metres. */
  gridSize: number
  snapToGrid: boolean
  snapToObjects: boolean
  /** Angle snap increment in degrees while drawing; 0 disables it. */
  angleSnapDeg: number
  defaultWallHeight: number
  defaultWallThickness: number
  defaultDoorWidth: number
  defaultDoorHeight: number
  defaultWindowWidth: number
  defaultWindowHeight: number
  defaultWindowSill: number
}

export interface CrowdDocument {
  schemaVersion: number
  id: string
  name: string
  createdAt: string
  updatedAt: string
  settings: DocumentSettings
  plan: Plan
  scenario: Scenario
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export type PlanObjectKind = 'wall' | 'opening' | 'furniture' | 'zone' | 'service' | 'backdrop'

export interface PlanObjectRef {
  kind: PlanObjectKind
  id: string
}

export type PlanObject = Wall | Opening | FurnitureItem | Zone | ServicePoint | Backdrop
