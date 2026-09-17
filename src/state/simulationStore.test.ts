import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDocument } from '../core/model/defaults'
import { DENSITY_SCALE } from '../worker/protocol'
import type {
  DoneMessage,
  FrameMessage,
  ReadyMessage,
  StartRequest,
  WorkerRequest,
  WorkerResponse,
} from '../worker/protocol'
import { AGENT_FIELD, AGENT_STRIDE } from '../sim/types'
import type { RunSummary, SimStats } from '../sim/types'
import type { CrowdDocument } from '../core/model/types'
import type * as SimulationStore from './simulationStore'

/**
 * No worker is ever spawned here. The store is what is under test, and a real
 * worker would make every assertion race a simulation; this stub records what
 * the store asks for and hands replies back the way `onmessage` would.
 */
class StubWorker {
  static instances: StubWorker[] = []
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null
  readonly sent: WorkerRequest[] = []

  constructor(
    readonly url: URL,
    readonly options: { type?: string } = {},
  ) {
    StubWorker.instances.push(this)
  }

  postMessage(request: WorkerRequest): void {
    this.sent.push(request)
  }

  terminate(): void {}
}

let store: typeof SimulationStore

beforeEach(async () => {
  StubWorker.instances = []
  vi.stubGlobal('Worker', StubWorker)
  // The worker handle, the density decode buffer and the run counter all live
  // at module scope, so only a fresh module is genuinely a fresh store.
  vi.resetModules()
  store = await import('./simulationStore')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const sim = () => store.useSimulation.getState()
const spawned = (): StubWorker => StubWorker.instances[0]
const sent = (): WorkerRequest[] => spawned()?.sent ?? []
const starts = (): StartRequest[] =>
  sent().filter((request): request is StartRequest => request.type === 'start')

const deliver = (message: WorkerResponse): void => {
  spawned().onmessage?.({ data: message } as MessageEvent<WorkerResponse>)
}

/** The id of the run in flight, so a reply can name the run the store is showing. */
const inFlight = (): string => {
  const runId = sim().runId
  if (!runId) throw new Error('no run is in flight')
  return runId
}

const venue = (name: string): CrowdDocument => {
  const doc = createDocument(name)
  return { ...doc, scenario: { ...doc.scenario, durationS: 300 } }
}

const stats = (patch: Partial<SimStats> = {}): SimStats => ({
  time: 0,
  spawned: 0,
  active: 0,
  completed: 0,
  meanDensity: 0.4,
  peakDensity: 1.4,
  meanSpeed: 1.1,
  meanWalkingSpeed: 1.2,
  walking: 0,
  stoppedShare: 0,
  meanWait: 0,
  maxWait: 0,
  queueLengths: [],
  worstLos: 'B',
  ...patch,
})

const ready = (runId: string, patch: Partial<ReadyMessage> = {}): ReadyMessage => ({
  type: 'ready',
  runId,
  grid: { originX: -1, originY: -1, cellSize: 0.25, cols: 2, rows: 2 },
  walkableArea: 96,
  warnings: [],
  totalPeople: 240,
  ...patch,
})

const frame = (
  runId: string,
  options: {
    time?: number
    count?: number
    /** People the buffer has room for, which need not be the people in it. */
    capacity?: number
    density?: number[]
    progress?: number
  } = {},
): FrameMessage => {
  const count = options.count ?? 3
  const capacity = options.capacity ?? count
  const agents = new Float32Array(capacity * AGENT_STRIDE)
  for (let i = 0; i < capacity; i++) agents[i * AGENT_STRIDE + AGENT_FIELD.x] = i + 1
  const time = options.time ?? 0
  return {
    type: 'frame',
    runId,
    time,
    count,
    agents: agents.buffer,
    density: Uint8Array.from(options.density ?? [0, 128, 255, 64]).buffer,
    stats: stats({ time, spawned: count, active: count }),
    progress: options.progress ?? 0.5,
  }
}

const summaryOf = (patch: Partial<RunSummary> = {}): RunSummary => ({
  durationS: 300,
  seed: 7,
  totalPeople: 240,
  completed: 240,
  meanJourney: 96,
  p95Journey: 180,
  meanWait: 12,
  maxWait: 40,
  meanQueueTime: 9,
  clearanceTime: 240,
  walkableArea: 96,
  peakOccupancy: 120,
  peakDensity: 1.8,
  losShare: { A: 0.6, B: 0.4 },
  services: [],
  areas: [],
  warnings: [],
  ...patch,
})

const done = (
  runId: string,
  patch: Partial<RunSummary> = {},
  active: number[] = [12, 6, 0],
): DoneMessage => ({
  type: 'done',
  runId,
  summary: summaryOf(patch),
  series: {
    time: Float32Array.from(active, (_, i) => i * 10),
    active: Float32Array.from(active),
    completed: Float32Array.from(active, (_, i) => i * 8),
    meanSpeed: Float32Array.from(active, () => 1.2),
    peakDensity: Float32Array.from(active, () => 1.8),
    queueTotal: Float32Array.from(active, () => 0),
  },
})

/** Runs a venue to the end so there is something to save, compare or stop. */
const playToTheEnd = (doc: CrowdDocument, patch: Partial<RunSummary> = {}): string => {
  sim().run(doc, doc.name)
  const runId = inFlight()
  deliver(ready(runId))
  deliver(frame(runId, { time: 290, progress: 0.97 }))
  deliver(done(runId, patch))
  return runId
}

describe('starting a run', () => {
  it('holds the run at preparing until the worker has the venue ready', () => {
    const doc = venue('Foyer')
    sim().run(doc, 'Doors open')

    expect(sim().phase).toBe('preparing')
    expect(sim().runLabel).toBe('Doors open')
    expect(sim().frame).toBeNull()

    const start = starts()[0]
    expect(start.runId).toBe(sim().runId)
    expect(start.plan).toBe(doc.plan)
    expect(start.scenario).toBe(doc.scenario)
    expect(start.speed).toBe(sim().speed)
    expect(start.frameIntervalS).toBeCloseTo(0.2, 6)

    deliver(ready(start.runId, { warnings: ['The north exit is only 0.8 m wide'] }))

    expect(sim().phase).toBe('running')
    expect(sim().grid?.cols).toBe(2)
    expect(sim().totalPeople).toBe(240)
    expect(sim().warnings).toEqual(['The north exit is only 0.8 m wide'])
    // The grid is not a crowd: nothing is drawn until the first frame lands.
    expect(sim().frame).toBeNull()
  })

  it('gives the second run a name of its own on the one worker', () => {
    sim().run(venue('Foyer'), 'One door')
    const first = inFlight()
    const rebuilt = venue('Foyer with two doors')
    sim().run(rebuilt, 'Two doors')

    // Spawning a worker per run would pay module startup every time the user
    // presses Run, and leave the old one simulating in the background.
    expect(StubWorker.instances).toHaveLength(1)
    expect(spawned().options.type).toBe('module')
    expect(sim().runLabel).toBe('Two doors')

    const [before, after] = starts()
    expect(before.runId).toBe(first)
    expect(after.runId).toBe(sim().runId)
    // Ids no run shares are the whole basis of dropping the replies of a run
    // the user has walked away from.
    expect(after.runId).not.toBe(first)
    expect(after.plan).toBe(rebuilt.plan)
    // No stop is sent for the run being replaced: `start` ends the current run
    // inside the worker, and a stop racing behind it would kill the new one.
    expect(sent()).toHaveLength(2)
  })
})

describe('the transport controls', () => {
  it('do nothing until there is a run, but keep the speed the user picked', () => {
    sim().pause()
    sim().resume()
    sim().stop()
    sim().setSpeed(16)

    // Nothing has started, so there is no worker to talk to and no frame to
    // jump to — but the speed the user picked has to survive until there is.
    expect(StubWorker.instances).toHaveLength(0)
    expect(sim().phase).toBe('idle')
    expect(sim().frame).toBeNull()
    expect(sim().progress).toBe(0)
    expect(sim().speed).toBe(16)

    sim().run(venue('Foyer'))
    expect(starts()[0].speed).toBe(16)
  })

  it('pauses and resumes the run in flight, and stays quiet when pressed twice', () => {
    sim().run(venue('Foyer'))
    const runId = inFlight()

    // Pausing while the worker is still building the nav grid would read
    // "paused" on screen over a venue that is very much still being prepared.
    sim().pause()
    expect(sim().phase).toBe('preparing')

    deliver(ready(runId))
    sim().pause()
    expect(sim().phase).toBe('paused')
    sim().pause()
    sim().resume()
    expect(sim().phase).toBe('running')
    sim().resume()

    // A second resume must not reach the worker: it would start a second timer
    // chain on the same run and play the crowd back at double speed.
    expect(sent().map((request) => request.type)).toEqual(['start', 'pause', 'resume'])
  })

  it('changes the speed of the run in flight without disturbing it', () => {
    sim().run(venue('Foyer'))
    const runId = inFlight()
    deliver(ready(runId))
    deliver(frame(runId, { time: 30, progress: 0.1 }))

    sim().setSpeed(60)

    expect(sim().speed).toBe(60)
    expect(sent().at(-1)).toEqual({ type: 'speed', runId, speed: 60 })
    expect(sim().phase).toBe('running')
    expect(sim().frame?.time).toBeCloseTo(30, 6)
  })

  it('takes the crowd off the screen when the run is stopped, and ignores what is still in flight', () => {
    sim().run(venue('Foyer'))
    const runId = inFlight()
    deliver(ready(runId))
    deliver(frame(runId, { time: 42, progress: 0.4 }))
    expect(sim().frame?.count).toBe(3)

    sim().stop()

    expect(sent().at(-1)).toEqual({ type: 'stop', runId })
    expect(sim().phase).toBe('idle')
    expect(sim().runId).toBeNull()
    expect(sim().frame).toBeNull()
    expect(sim().progress).toBe(0)
    // The heat map is the other half of what is on screen, and it does not go
    // with the frame: the overlay is shown while a grid exists and keeps the
    // last density it was handed, so a grid left behind painted the stopped
    // run's crowd on the floor after its people had gone — and, because a stop
    // is the first half of opening a project, over the next venue's plan.
    expect(sim().grid).toBeNull()

    // Replies posted before the stop arrived are still on their way; replaying
    // one would put a crowd back on a plan the user is already editing, or —
    // for a late `ready` — announce a run that nobody can pause or stop.
    deliver(ready(runId, { totalPeople: 999 }))
    deliver(frame(runId, { time: 43, progress: 0.5 }))
    deliver(done(runId))

    expect(sim().phase).toBe('idle')
    expect(sim().frame).toBeNull()
    expect(sim().grid).toBeNull()
    expect(sim().summary).toBeNull()
    expect(sim().progress).toBe(0)
    // The stop emptied the readout; the late `ready` must not refill it with a
    // crowd size for a run that is over.
    expect(sim().totalPeople).toBe(0)

    // Clearing it is not the same as losing it: the next run describes its own
    // grid, and the overlay is sized from that rather than from whatever the
    // last venue happened to need.
    sim().run(venue('Foyer with two doors'))
    const restarted = ready(inFlight(), {
      grid: { originX: 0, originY: 0, cellSize: 0.3, cols: 3, rows: 3 },
    })
    deliver(restarted)
    expect(sim().grid).toBe(restarted.grid)
  })
})

describe('frames streaming back from the worker', () => {
  it('shows the people the frame says are there rather than the whole buffer', () => {
    sim().run(venue('Foyer'))
    const runId = inFlight()
    deliver(ready(runId))
    const arrived = frame(runId, { count: 3, capacity: 8 })
    deliver(arrived)

    const shown = sim().frame
    expect(shown?.count).toBe(3)
    // A buffer sized for the whole crowd outlives the people in it; drawing all
    // of it would leave ghosts standing at the origin after everyone left.
    expect(shown?.agents).toHaveLength(3 * AGENT_STRIDE)
    expect(shown?.agents[AGENT_FIELD.x]).toBeCloseTo(1, 6)
    expect(shown?.agents[2 * AGENT_STRIDE + AGENT_FIELD.x]).toBeCloseTo(3, 6)
    // A view onto the buffer that came across, never a copy: copying per person
    // on the main thread is the one thing playback cannot afford.
    expect(shown?.agents.buffer).toBe(arrived.agents)

    deliver(frame(runId, { time: 8, count: 0, capacity: 8 }))
    expect(sim().frame?.agents).toHaveLength(0)
  })

  it('decodes the heat map into one buffer per grid, rewritten every frame', () => {
    sim().run(venue('Foyer'))
    const first = inFlight()
    deliver(ready(first))
    deliver(frame(first, { density: [0, 128, 255, 64] }))

    const early = sim().frame
    expect(early?.density).toHaveLength(4)
    expect(early?.density[1]).toBeCloseTo(128 * DENSITY_SCALE, 6)
    expect(early?.density[2]).toBeCloseTo(6, 6)

    deliver(frame(first, { time: 1, density: [255, 0, 0, 0] }))
    const later = sim().frame

    expect(later).not.toBe(early)
    // One buffer for the whole run: the renderer uploads it the moment the
    // frame lands, and a new array five times a second would churn megabytes.
    // The price is that the earlier frame's heat map is gone with it, so
    // anything wanting to keep one has to copy it.
    expect(later?.density).toBe(early?.density)
    expect(early?.density[0]).toBeCloseTo(6, 6)

    sim().run(venue('Longer foyer'))
    const second = inFlight()
    deliver(ready(second, { grid: { originX: 0, originY: 0, cellSize: 0.3, cols: 3, rows: 3 } }))
    deliver(frame(second, { density: [255, 0, 0, 0, 0, 0, 0, 0, 128] }))

    expect(sim().frame?.density).toHaveLength(9)
    expect(sim().frame?.density[8]).toBeCloseTo(128 * DENSITY_SCALE, 6)
  })

  it('sizes the heat map from the frame when one overtakes the ready message', () => {
    sim().run(venue('Foyer'))
    const runId = inFlight()

    // No grid has been described yet, so the decode buffer is still empty. The
    // frame has to land anyway rather than throw or paint a blank heat map.
    deliver(frame(runId, { density: [255, 0, 128] }))

    expect(sim().frame?.density).toHaveLength(3)
    expect(sim().frame?.density[0]).toBeCloseTo(6, 6)
    expect(sim().frame?.density[2]).toBeCloseTo(128 * DENSITY_SCALE, 6)
    expect(sim().phase).toBe('preparing')
  })

  it('ignores everything still arriving for a run the user has replaced', () => {
    sim().run(venue('Foyer'))
    const first = inFlight()
    deliver(ready(first))
    deliver(frame(first, { time: 12, progress: 0.3 }))

    sim().run(venue('Foyer with two doors'))
    const second = inFlight()

    deliver(ready(first, { totalPeople: 999, warnings: ['the old venue'] }))
    deliver(frame(first, { time: 99, progress: 0.9 }))
    deliver(done(first, { completed: 1 }))
    deliver({ type: 'progress', runId: first, progress: 0.8 })

    expect(sim().phase).toBe('preparing')
    expect(sim().frame).toBeNull()
    expect(sim().summary).toBeNull()
    expect(sim().progress).toBe(0)
    expect(sim().warnings).toEqual([])
    expect(sim().totalPeople).toBe(240)

    deliver(ready(second))
    deliver(frame(second, { time: 3, progress: 0.05 }))
    const shown = sim().frame

    expect(sim().phase).toBe('running')
    expect(shown?.time).toBeCloseTo(3, 6)
    expect(sim().progress).toBeCloseTo(0.05, 6)

    deliver({ type: 'progress', runId: second, progress: 0.31 })

    // Progress can arrive between frames; the bar moves, and the crowd on
    // screen must be the same object so nothing is re-uploaded to draw it.
    expect(sim().progress).toBeCloseTo(0.31, 6)
    expect(sim().frame).toBe(shown)
  })
})

describe('reaching the end of the scenario', () => {
  it('stops at the end instead of playing past it', () => {
    sim().run(venue('Foyer'))
    const runId = inFlight()
    deliver(ready(runId))
    deliver(frame(runId, { time: 296, progress: 0.97 }))
    deliver(done(runId, { completed: 238, clearanceTime: 284 }))

    expect(sim().phase).toBe('done')
    // The last frame lands a tick short of the duration; the bar reads full
    // because the run is over, not because the clock reached 300 s.
    expect(sim().progress).toBe(1)
    expect(sim().summary?.completed).toBe(238)
    expect(Array.from(sim().series?.active ?? [])).toEqual([12, 6, 0])
    // The last moment of the run stays on screen to be looked at.
    expect(sim().frame?.time).toBeCloseTo(296, 6)

    sim().pause()
    sim().resume()

    expect(sim().phase).toBe('done')
    expect(sent().map((request) => request.type)).toEqual(['start'])
  })

  it('clears the finished numbers the moment the next run starts', () => {
    const before = venue('Foyer')
    sim().run(before, before.name)
    const runId = inFlight()
    deliver(ready(runId, { warnings: ['The north exit is only 0.8 m wide'] }))
    deliver(frame(runId, { time: 296, progress: 0.97 }))
    deliver(done(runId))

    sim().run(venue('Foyer with two doors'), 'Foyer with two doors')

    // Until the new run reports, the results panel must have nothing to show
    // rather than the old venue's numbers under the new venue's name.
    expect(sim().phase).toBe('preparing')
    expect(sim().summary).toBeNull()
    expect(sim().series).toBeNull()
    expect(sim().frame).toBeNull()
    expect(sim().warnings).toEqual([])
    expect(sim().error).toBeNull()
    expect(sim().progress).toBe(0)
    // The heat map is one of those numbers and the longest-lived: the overlay
    // is shown while a grid exists and keeps the last density it was given, and
    // building the nav grid is the slow half of a run. Left behind, the previous
    // run's density stayed painted across the whole of "preparing" — over a plan
    // the user had just edited, which is the reason they pressed Run again.
    expect(sim().grid).toBeNull()
  })

  it('takes the findings off the panel with the crowd when the run is stopped', () => {
    const doc = venue('Foyer')
    sim().run(doc, doc.name)
    const runId = inFlight()
    deliver(ready(runId, { warnings: ['The north exit is only 0.8 m wide'] }))
    deliver(frame(runId, { time: 296, progress: 0.97 }))
    deliver(done(runId, { completed: 238 }))

    sim().stop()

    expect(sim().phase).toBe('idle')
    expect(sim().frame).toBeNull()
    expect(sim().summary).toBeNull()
    expect(sim().series).toBeNull()
    expect(sim().warnings).toEqual([])
    expect(sim().totalPeople).toBe(0)

    // Stopping is the first half of opening a project or a template, so numbers
    // that outlived it would be read against whatever plan arrives next — and
    // "Save as baseline" is offered whenever there is a summary, which would
    // pair the closed venue's results with the new document for good.
    const opened = venue('Foyer with two doors')
    sim().saveCurrentRun(opened.name, opened)
    expect(sim().savedRuns).toEqual([])
  })
})

describe('the baseline a run is compared against', () => {
  it('holds the saved run and the live one apart', () => {
    const before = venue('Foyer')
    playToTheEnd(before, { meanJourney: 96, clearanceTime: 240 })
    sim().saveCurrentRun('Before the extra doors', before)

    const after = venue('Foyer with two doors')
    sim().run(after, after.name)
    const second = inFlight()
    deliver(ready(second))
    deliver(done(second, { meanJourney: 61, clearanceTime: 150 }, [12, 2, 0]))

    const [baseline] = sim().savedRuns
    expect(sim().savedRuns).toHaveLength(1)
    expect(baseline.label).toBe('Before the extra doors')
    expect(baseline.summary.meanJourney).toBeCloseTo(96, 6)
    expect(Array.from(baseline.series.active)).toEqual([12, 6, 0])
    // The saved run carries the plan it was produced from, so the comparison
    // can say what changed rather than only by how much.
    expect(baseline.document).toBe(before)

    expect(sim().summary?.meanJourney).toBeCloseTo(61, 6)
    expect(Array.from(sim().series?.active ?? [])).toEqual([12, 2, 0])

    sim().setComparison(baseline.id)
    const chosen = sim().savedRuns.find((run) => run.id === sim().comparisonId)
    expect(chosen?.summary.clearanceTime).toBeCloseTo(240, 6)
  })

  it('will not save a baseline before the run has produced one', () => {
    const doc = venue('Foyer')
    sim().saveCurrentRun('Nothing yet', doc)

    sim().run(doc, doc.name)
    const runId = inFlight()
    deliver(ready(runId))
    deliver(frame(runId, { time: 40, progress: 0.13 }))
    // A run halfway through has frames but no summary; saving one would put a
    // baseline of zeros on the panel and every later run would beat it.
    sim().saveCurrentRun('Halfway', doc)
    expect(sim().savedRuns).toEqual([])

    deliver(done(runId))
    sim().saveCurrentRun('Baseline', doc)

    expect(sim().savedRuns).toHaveLength(1)
    expect(sim().savedRuns[0].label).toBe('Baseline')
    expect(sim().savedRuns[0].summary).toBe(sim().summary)

    // The next run wipes the live numbers; the baseline keeps its own.
    sim().run(doc, doc.name)
    expect(sim().summary).toBeNull()
    expect(sim().savedRuns[0].summary.completed).toBe(240)
  })

  it('forgets the comparison when the run it pointed at is thrown away', () => {
    const doc = venue('Foyer')
    playToTheEnd(doc)
    sim().saveCurrentRun('One door', doc)
    sim().saveCurrentRun('Two doors', doc)

    const [newest, oldest] = sim().savedRuns
    expect(newest.label).toBe('Two doors')
    sim().setComparison(oldest.id)

    sim().removeRun(newest.id)
    expect(sim().comparisonId).toBe(oldest.id)

    sim().removeRun(oldest.id)
    // Comparing against a run that no longer exists would quietly drop every
    // delta on the panel with nothing to say why.
    expect(sim().comparisonId).toBeNull()
    expect(sim().savedRuns).toEqual([])
  })

  it('keeps the last dozen saved runs, newest first', () => {
    const doc = venue('Foyer')
    playToTheEnd(doc)
    for (let option = 1; option <= 13; option++) sim().saveCurrentRun(`Option ${option}`, doc)

    const saved = sim().savedRuns
    expect(saved).toHaveLength(12)
    expect(saved[0].label).toBe('Option 13')
    expect(saved.at(-1)?.label).toBe('Option 2')
    expect(saved.some((run) => run.label === 'Option 1')).toBe(false)
  })

  it('forgets the comparison when a thirteenth save pushes that baseline off the list', () => {
    const doc = venue('Foyer')
    playToTheEnd(doc)
    for (let option = 1; option <= 12; option++) sim().saveCurrentRun(`Option ${option}`, doc)

    const oldest = sim().savedRuns[11]
    sim().setComparison(oldest.id)
    sim().saveCurrentRun('Option 13', doc)

    // The panel finds the baseline by id. An id left pointing at a run the cap
    // evicted takes every "vs baseline" delta off the panel, with nothing on
    // screen able to say where they went.
    expect(sim().savedRuns.some((run) => run.id === oldest.id)).toBe(false)
    expect(sim().comparisonId).toBeNull()

    const survivor = sim().savedRuns[1]
    sim().setComparison(survivor.id)
    sim().saveCurrentRun('Option 14', doc)

    // A baseline still on the list is left where the user put it.
    expect(sim().comparisonId).toBe(survivor.id)
  })
})

describe('a worker that fails', () => {
  it('surfaces what went wrong and lets the user start again', () => {
    sim().run(venue('Foyer'))
    const runId = inFlight()
    deliver(ready(runId))
    deliver(frame(runId, { time: 18, progress: 0.06 }))
    deliver({ type: 'error', runId, message: 'No exit is reachable from the entrance' })

    expect(sim().phase).toBe('error')
    expect(sim().error).toBe('No exit is reachable from the entrance')
    // The crowd stops where it fell over rather than vanishing: it is the
    // evidence for the message. Running again or stopping clears it.
    expect(sim().frame?.time).toBeCloseTo(18, 6)

    sim().clearError()
    expect(sim().phase).toBe('idle')
    expect(sim().error).toBeNull()
    // App.tsx toasts the message and clears it in the same effect, so every
    // error the user ever reads is read after this call. Taking the crowd down
    // here would leave the toast describing an empty floor.
    expect(sim().frame?.time).toBeCloseTo(18, 6)
    expect(sim().grid?.cols).toBe(2)

    // A worker that dies outright reports through `onerror`, which names no run
    // and carries no message of its own when the module simply failed to load.
    spawned().onerror?.({ message: '' })
    expect(sim().phase).toBe('error')
    expect(sim().error).toBe('The simulation worker failed.')
  })

  it('keeps quiet about a run the user has already walked away from', () => {
    sim().run(venue('Foyer'))
    const abandoned = inFlight()
    sim().stop()
    expect(sim().phase).toBe('idle')

    deliver({ type: 'error', runId: abandoned, message: 'No exit is reachable from the entrance' })

    // Building the nav grid is the slow part, so a start that threw lands long
    // after the user has moved on — and a stop is the first half of opening
    // another venue. App.tsx toasts whatever error is here and then forces the
    // phase to idle, so an abandoned run's failure would be reported against
    // the plan now on screen and would interrupt the run replacing it.
    expect(sim().phase).toBe('idle')
    expect(sim().error).toBeNull()

    sim().run(venue('Foyer with two doors'))
    const live = inFlight()
    deliver({ type: 'error', runId: abandoned, message: 'No exit is reachable from the entrance' })
    expect(sim().phase).toBe('preparing')

    // A worker that dies outright names no run, because there is none to name.
    // That has to reach the screen whatever is in flight.
    spawned().onerror?.({ message: '' })
    expect(sim().phase).toBe('error')
    expect(sim().error).toBe('The simulation worker failed.')

    sim().clearError()
    deliver({ type: 'error', runId: live, message: 'No exit is reachable from the entrance' })
    expect(sim().phase).toBe('error')
    expect(sim().error).toBe('No exit is reachable from the entrance')
  })
})
