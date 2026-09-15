/**
 * The worker protocol.
 *
 * The simulation runs off the main thread so the editor stays responsive while
 * a few thousand people walk around. Frames cross the boundary as transferable
 * `ArrayBuffer`s rather than through a `SharedArrayBuffer`: shared memory would
 * require COOP/COEP headers, and that would break the product's central promise
 * of being a single URL with no deployment ceremony.
 */

import type { Plan, Scenario } from '../core/model/types'
import type { RunSummary, SimOptions, SimStats } from '../sim/types'

export interface StartRequest {
  type: 'start'
  runId: string
  plan: Plan
  scenario: Scenario
  options?: Partial<SimOptions>
  /** Simulated seconds between frames sent to the main thread. */
  frameIntervalS: number
  /** Simulated seconds per wall-clock second; Infinity runs as fast as it can. */
  speed: number
}

export interface ControlRequest {
  type: 'pause' | 'resume' | 'stop'
  runId: string
}

export interface SpeedRequest {
  type: 'speed'
  runId: string
  speed: number
}

/** Run to the end without streaming frames; used for background comparisons. */
export interface BatchRequest {
  type: 'batch'
  runId: string
  plan: Plan
  scenario: Scenario
  options?: Partial<SimOptions>
  /** Simulated seconds between recorded frames. */
  frameIntervalS: number
}

export type WorkerRequest = StartRequest | ControlRequest | SpeedRequest | BatchRequest

export interface ReadyMessage {
  type: 'ready'
  runId: string
  /** Navigation grid description, for drawing the heat map. */
  grid: { originX: number; originY: number; cellSize: number; cols: number; rows: number }
  walkableArea: number
  warnings: string[]
  totalPeople: number
}

export interface FrameMessage {
  type: 'frame'
  runId: string
  time: number
  count: number
  /** Packed agent records; see `AGENT_FIELD`. */
  agents: ArrayBuffer
  /** Density per grid cell, quantised to 8 bits over 0–6 persons/m². */
  density: ArrayBuffer
  stats: SimStats
  progress: number
}

export interface DoneMessage {
  type: 'done'
  runId: string
  summary: RunSummary
  /** Time series sampled once per recorded frame. */
  series: {
    time: Float32Array
    active: Float32Array
    completed: Float32Array
    meanSpeed: Float32Array
    peakDensity: Float32Array
    queueTotal: Float32Array
  }
}

export interface ErrorMessage {
  type: 'error'
  runId: string
  message: string
}

export interface ProgressMessage {
  type: 'progress'
  runId: string
  progress: number
}

export type WorkerResponse =
  ReadyMessage | FrameMessage | DoneMessage | ErrorMessage | ProgressMessage

/** Density is streamed as bytes; this is the value one byte represents. */
export const DENSITY_SCALE = 6 / 255

export const encodeDensity = (values: Float32Array, out: Uint8Array): Uint8Array => {
  for (let i = 0; i < values.length; i++) {
    const scaled = Math.round(values[i] / DENSITY_SCALE)
    out[i] = scaled > 255 ? 255 : scaled < 0 ? 0 : scaled
  }
  return out
}

export const decodeDensity = (bytes: Uint8Array, out: Float32Array): Float32Array => {
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] * DENSITY_SCALE
  return out
}
