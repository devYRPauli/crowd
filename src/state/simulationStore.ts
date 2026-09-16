/**
 * Simulation state on the main thread.
 *
 * Owns the worker, the current frame, the recorded time series and the saved
 * runs used for comparison. Frames arrive as transferable buffers and are kept
 * as typed-array views — nothing is copied into JavaScript objects per person,
 * which is what keeps playback smooth with a few thousand of them.
 */

import { create } from 'zustand'
import type { CrowdDocument } from '../core/model/types'
import type { RunSummary, SimStats } from '../sim/types'
import { AGENT_STRIDE } from '../sim/types'
import type { DoneMessage, ReadyMessage, WorkerRequest, WorkerResponse } from '../worker/protocol'
import { decodeDensity } from '../worker/protocol'

export type RunPhase = 'idle' | 'preparing' | 'running' | 'paused' | 'done' | 'error'

export interface GridInfo {
  originX: number
  originY: number
  cellSize: number
  cols: number
  rows: number
}

export interface Frame {
  time: number
  count: number
  agents: Float32Array
  density: Float32Array
  stats: SimStats
}

export interface SeriesData {
  time: Float32Array
  active: Float32Array
  completed: Float32Array
  meanSpeed: Float32Array
  peakDensity: Float32Array
  queueTotal: Float32Array
}

export interface SavedRun {
  id: string
  label: string
  at: string
  summary: RunSummary
  series: SeriesData
  /** The document the run was produced from, so a comparison can explain itself. */
  document: CrowdDocument
}

interface SimulationState {
  phase: RunPhase
  runId: string | null
  runLabel: string
  progress: number
  frame: Frame | null
  grid: GridInfo | null
  summary: RunSummary | null
  series: SeriesData | null
  warnings: string[]
  error: string | null
  speed: number
  totalPeople: number
  savedRuns: SavedRun[]
  comparisonId: string | null

  run: (doc: CrowdDocument, label?: string) => void
  pause: () => void
  resume: () => void
  stop: () => void
  setSpeed: (speed: number) => void
  saveCurrentRun: (label: string, doc: CrowdDocument) => void
  removeRun: (id: string) => void
  setComparison: (id: string | null) => void
  clearError: () => void
}

let worker: Worker | null = null
let densityBuffer: Float32Array = new Float32Array(0)
let runCounter = 0

const ensureWorker = (onMessage: (message: WorkerResponse) => void): Worker => {
  if (worker) return worker
  worker = new Worker(new URL('../worker/simulation.worker.ts', import.meta.url), {
    type: 'module',
  })
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => onMessage(event.data)
  worker.onerror = (event) => {
    onMessage({
      type: 'error',
      runId: '',
      message: event.message || 'The simulation worker failed.',
    })
  }
  return worker
}

const send = (request: WorkerRequest): void => {
  worker?.postMessage(request)
}

export const useSimulation = create<SimulationState>()((set, get) => {
  const handle = (message: WorkerResponse): void => {
    const state = get()
    switch (message.type) {
      case 'ready': {
        const ready = message as ReadyMessage
        if (ready.runId !== state.runId) return
        densityBuffer = new Float32Array(ready.grid.cols * ready.grid.rows)
        set({
          grid: ready.grid,
          warnings: ready.warnings,
          totalPeople: ready.totalPeople,
          phase: 'running',
        })
        break
      }
      case 'frame': {
        if (message.runId !== get().runId) return
        const density = new Uint8Array(message.density)
        if (densityBuffer.length !== density.length)
          densityBuffer = new Float32Array(density.length)
        decodeDensity(density, densityBuffer)
        set({
          frame: {
            time: message.time,
            count: message.count,
            agents: new Float32Array(message.agents, 0, message.count * AGENT_STRIDE),
            density: densityBuffer,
            stats: message.stats,
          },
          progress: message.progress,
        })
        break
      }
      case 'done': {
        const done = message as DoneMessage
        if (done.runId !== get().runId) return
        set({ phase: 'done', summary: done.summary, series: done.series, progress: 1 })
        break
      }
      case 'progress':
        if (message.runId === get().runId) set({ progress: message.progress })
        break
      case 'error':
        // A start that threw is stamped with its own run's id, and building the
        // nav grid is slow enough that it can land long after the user moved
        // on. An empty id is the worker itself dying, which belongs to whatever
        // is on screen.
        if (message.runId && message.runId !== get().runId) return
        set({ phase: 'error', error: message.message })
        break
    }
  }

  return {
    phase: 'idle',
    runId: null,
    runLabel: '',
    progress: 0,
    frame: null,
    grid: null,
    summary: null,
    series: null,
    warnings: [],
    error: null,
    speed: 4,
    totalPeople: 0,
    savedRuns: [],
    comparisonId: null,

    run: (doc, label = 'Run') => {
      ensureWorker(handle)
      const runId = `run-${++runCounter}`
      set({
        phase: 'preparing',
        runId,
        runLabel: label,
        progress: 0,
        frame: null,
        summary: null,
        series: null,
        warnings: [],
        error: null,
      })
      send({
        type: 'start',
        runId,
        plan: doc.plan,
        scenario: doc.scenario,
        frameIntervalS: 0.2,
        speed: get().speed,
      })
    },

    pause: () => {
      const { runId, phase } = get()
      if (!runId || phase !== 'running') return
      send({ type: 'pause', runId })
      set({ phase: 'paused' })
    },

    resume: () => {
      const { runId, phase } = get()
      if (!runId || phase !== 'paused') return
      send({ type: 'resume', runId })
      set({ phase: 'running' })
    },

    stop: () => {
      const { runId } = get()
      if (runId) send({ type: 'stop', runId })
      // The findings go with the crowd. Stopping is also the first half of
      // opening a project or a template, so results left behind would be read
      // against the plan that arrives next — and saved as its baseline.
      set({
        phase: 'idle',
        runId: null,
        progress: 0,
        frame: null,
        summary: null,
        series: null,
        warnings: [],
        totalPeople: 0,
      })
    },

    setSpeed: (speed) => {
      const { runId } = get()
      set({ speed })
      if (runId) send({ type: 'speed', runId, speed })
    },

    saveCurrentRun: (label, doc) => {
      const { summary, series } = get()
      if (!summary || !series) return
      const saved: SavedRun = {
        id: `saved-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
        label,
        at: new Date().toISOString(),
        summary,
        series,
        document: doc,
      }
      set((state) => {
        const savedRuns = [saved, ...state.savedRuns].slice(0, 12)
        // The cap can push the baseline itself off the list. The panel looks
        // the baseline up by id, so an id left pointing at nothing takes every
        // "vs baseline" delta off the panel without saying why.
        const kept = savedRuns.some((run) => run.id === state.comparisonId)
        return { savedRuns, comparisonId: kept ? state.comparisonId : null }
      })
    },

    removeRun: (id) =>
      set((state) => ({
        savedRuns: state.savedRuns.filter((run) => run.id !== id),
        comparisonId: state.comparisonId === id ? null : state.comparisonId,
      })),

    setComparison: (id) => set({ comparisonId: id }),

    clearError: () => set({ error: null, phase: 'idle' }),
  }
})
