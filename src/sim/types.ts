/**
 * Types shared between the simulation, the worker protocol and the UI.
 */

import type { Distribution } from '../core/math/random'

export type AgentState = 'walking' | 'queuing' | 'waiting' | 'served' | 'seated' | 'dwelling' | 'done'

export const AGENT_STATE_ORDER: AgentState[] = [
  'walking',
  'queuing',
  'waiting',
  'served',
  'seated',
  'dwelling',
  'done',
]

export const agentStateIndex = (state: AgentState): number => AGENT_STATE_ORDER.indexOf(state)

/** Packed per-agent record in a snapshot. Keep in step with `AGENT_STRIDE`. */
export const AGENT_STRIDE = 10
export const AGENT_FIELD = {
  x: 0,
  y: 1,
  heading: 2,
  speed: 3,
  state: 4,
  profile: 5,
  population: 6,
  /** Seconds this person has spent waiting so far. */
  waited: 7,
  radius: 8,
  id: 9,
} as const

export interface SimStats {
  time: number
  spawned: number
  active: number
  completed: number
  /** Persons per square metre, averaged over occupied floor. */
  meanDensity: number
  peakDensity: number
  meanSpeed: number
  /** Mean speed of people currently trying to get somewhere. */
  meanWalkingSpeed: number
  /** How many people are currently trying to get somewhere. */
  walking: number
  /** Share of those people moving below 0.3 m/s — the congestion indicator. */
  stoppedShare: number
  meanWait: number
  maxWait: number
  queueLengths: Array<{ id: string; name: string; waiting: number; served: number; meanWait: number }>
  /** Fruin level of service of the busiest measured area. */
  worstLos: string
}

export interface AgentJourney {
  id: number
  populationId: string
  profileId: string
  spawnedAt: number
  finishedAt: number | null
  /** Total path length in metres. */
  distance: number
  /** Time spent below 0.3 m/s, in seconds. */
  stoppedTime: number
  /** Time spent queueing, in seconds. */
  queueTime: number
  /** Time from spawn to leaving, in seconds. */
  totalTime: number | null
  /** Straight-line distance travelled divided by path length; 1 is a direct walk. */
  directness: number
}

export interface ServiceSummary {
  id: string
  name: string
  servers: number
  served: number
  meanWait: number
  maxWait: number
  meanService: number
  /** Share of run time the counters were busy. */
  utilisation: number
  maxQueue: number
  /** People still waiting when the run ended. */
  unserved: number
}

export interface RunSummary {
  durationS: number
  seed: number
  totalPeople: number
  completed: number
  /** Mean time from arrival to leaving. */
  meanJourney: number
  p95Journey: number
  meanWait: number
  maxWait: number
  meanQueueTime: number
  /** Time by which 95% of people had left, in seconds. */
  clearanceTime: number
  walkableArea: number
  peakOccupancy: number
  peakDensity: number
  /** Share of simulated person-seconds spent in each level of service. */
  losShare: Record<string, number>
  services: ServiceSummary[]
  warnings: string[]
}

export interface SimOptions {
  /** Physics timestep, in seconds. */
  timeStep: number
  /** Navigation grid resolution, in metres. */
  cellSize: number
  /** Cap on simulated people, to keep a browser tab responsive. */
  maxAgents: number
}

export const DEFAULT_SIM_OPTIONS: SimOptions = {
  timeStep: 0.1,
  cellSize: 0.3,
  maxAgents: 6000,
}

export interface DwellSpec {
  duration: Distribution
}
