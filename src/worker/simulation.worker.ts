/**
 * Simulation worker.
 *
 * Owns one `Simulation` at a time and drives it on a timer, pacing simulated
 * time against wall-clock time so playback speed means something. Frames are
 * posted at a fixed *simulated* interval, so the recording is the same whether
 * the machine kept up or not.
 */

import { Simulation } from '../sim/engine'
import { encodeDensity } from './protocol'
import type {
  BatchRequest,
  DoneMessage,
  FrameMessage,
  ReadyMessage,
  StartRequest,
  WorkerRequest,
} from './protocol'
import type { SimStats } from '../sim/types'

interface RunState {
  id: string
  sim: Simulation
  frameIntervalS: number
  speed: number
  running: boolean
  nextFrameAt: number
  durationS: number
  timer: ReturnType<typeof setTimeout> | null
  series: {
    time: number[]
    active: number[]
    completed: number[]
    meanSpeed: number[]
    peakDensity: number[]
    queueTotal: number[]
  }
  densityBytes: Uint8Array
}

let current: RunState | null = null

const post = (message: unknown, transfer: Transferable[] = []): void => {
  ;(self as unknown as Worker).postMessage(message, transfer)
}

const emptySeries = () => ({
  time: [] as number[],
  active: [] as number[],
  completed: [] as number[],
  meanSpeed: [] as number[],
  peakDensity: [] as number[],
  queueTotal: [] as number[],
})

const recordSeries = (run: RunState, stats: SimStats): void => {
  run.series.time.push(stats.time)
  run.series.active.push(stats.active)
  run.series.completed.push(stats.completed)
  run.series.meanSpeed.push(stats.meanSpeed)
  run.series.peakDensity.push(stats.peakDensity)
  run.series.queueTotal.push(stats.queueLengths.reduce((sum, q) => sum + q.waiting, 0))
}

const sendFrame = (run: RunState): void => {
  const snapshot = run.sim.snapshot()
  const agents = new Float32Array(snapshot.agents.length)
  agents.set(snapshot.agents)
  const density = run.densityBytes.slice()
  encodeDensity(run.sim.densityField, density)
  recordSeries(run, snapshot.stats)
  const message: FrameMessage = {
    type: 'frame',
    runId: run.id,
    time: snapshot.time,
    count: snapshot.count,
    agents: agents.buffer,
    density: density.buffer,
    stats: snapshot.stats,
    progress: Math.min(1, snapshot.time / run.durationS),
  }
  post(message, [agents.buffer, density.buffer])
}

const sendDone = (run: RunState): void => {
  const message: DoneMessage = {
    type: 'done',
    runId: run.id,
    summary: run.sim.summary(),
    series: {
      time: Float32Array.from(run.series.time),
      active: Float32Array.from(run.series.active),
      completed: Float32Array.from(run.series.completed),
      meanSpeed: Float32Array.from(run.series.meanSpeed),
      peakDensity: Float32Array.from(run.series.peakDensity),
      queueTotal: Float32Array.from(run.series.queueTotal),
    },
  }
  post(message)
}

const sendReady = (run: RunState, warnings: string[], totalPeople: number): void => {
  const grid = run.sim.world.grid
  const message: ReadyMessage = {
    type: 'ready',
    runId: run.id,
    grid: {
      originX: grid.originX,
      originY: grid.originY,
      cellSize: grid.cellSize,
      cols: grid.cols,
      rows: grid.rows,
    },
    walkableArea: run.sim.world.stats.walkableArea,
    warnings,
    totalPeople,
  }
  post(message)
}

/** Advance simulated time, capped so a slow machine degrades instead of freezing. */
const tick = (run: RunState): void => {
  if (!run.running || current !== run) return
  const step = run.sim.options.timeStep
  const budgetMs = 12
  const started = Date.now()
  const target = Number.isFinite(run.speed) ? run.speed * (budgetMs / 1000) : Infinity
  let advanced = 0

  while (!run.sim.isFinished) {
    run.sim.step(step)
    advanced += step
    if (run.sim.currentTime >= run.nextFrameAt) {
      sendFrame(run)
      run.nextFrameAt += run.frameIntervalS
    }
    if (advanced >= target) break
    if (Date.now() - started >= budgetMs) break
  }

  if (run.sim.isFinished) {
    sendFrame(run)
    sendDone(run)
    run.running = false
    return
  }
  const delay = Number.isFinite(run.speed) ? Math.max(0, (advanced / run.speed) * 1000 - (Date.now() - started)) : 0
  run.timer = setTimeout(() => tick(run), delay)
}

const start = (request: StartRequest): void => {
  stop()
  const sim = new Simulation(request.plan, request.scenario, request.options)
  const cells = sim.world.grid.cols * sim.world.grid.rows
  const run: RunState = {
    id: request.runId,
    sim,
    frameIntervalS: Math.max(0.05, request.frameIntervalS),
    speed: request.speed,
    running: true,
    nextFrameAt: 0,
    durationS: request.scenario.durationS,
    timer: null,
    series: emptySeries(),
    densityBytes: new Uint8Array(cells),
  }
  current = run
  sendReady(run, sim.summary().warnings, request.scenario.populations.reduce((s, p) => s + p.count, 0))
  sendFrame(run)
  run.nextFrameAt = run.frameIntervalS
  tick(run)
}

/** Run to completion without pacing; used to produce a comparison in the background. */
const batch = (request: BatchRequest): void => {
  stop()
  const sim = new Simulation(request.plan, request.scenario, request.options)
  const cells = sim.world.grid.cols * sim.world.grid.rows
  const run: RunState = {
    id: request.runId,
    sim,
    frameIntervalS: Math.max(0.25, request.frameIntervalS),
    speed: Infinity,
    running: true,
    nextFrameAt: 0,
    durationS: request.scenario.durationS,
    timer: null,
    series: emptySeries(),
    densityBytes: new Uint8Array(cells),
  }
  current = run
  sendReady(run, sim.summary().warnings, request.scenario.populations.reduce((s, p) => s + p.count, 0))

  const chunk = () => {
    if (current !== run || !run.running) return
    const started = Date.now()
    while (!sim.isFinished && Date.now() - started < 30) {
      sim.step(sim.options.timeStep)
      if (sim.currentTime >= run.nextFrameAt) {
        recordSeries(run, sim.stats())
        run.nextFrameAt += run.frameIntervalS
      }
    }
    if (sim.isFinished) {
      sendDone(run)
      run.running = false
      return
    }
    post({ type: 'progress', runId: run.id, progress: Math.min(1, sim.currentTime / run.durationS) })
    setTimeout(chunk, 0)
  }
  chunk()
}

const stop = (): void => {
  if (current?.timer) clearTimeout(current.timer)
  if (current) current.running = false
  current = null
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  try {
    switch (request.type) {
      case 'start':
        start(request)
        break
      case 'batch':
        batch(request)
        break
      case 'pause':
        if (current && current.id === request.runId) {
          current.running = false
          if (current.timer) clearTimeout(current.timer)
        }
        break
      case 'resume':
        if (current && current.id === request.runId && !current.sim.isFinished) {
          current.running = true
          tick(current)
        }
        break
      case 'speed':
        if (current && current.id === request.runId) current.speed = request.speed
        break
      case 'stop':
        stop()
        break
    }
  } catch (error) {
    post({
      type: 'error',
      runId: 'runId' in request ? request.runId : '',
      message: error instanceof Error ? error.message : String(error),
    })
    stop()
  }
}
