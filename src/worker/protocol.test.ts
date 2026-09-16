import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DENSITY_SCALE, decodeDensity, encodeDensity } from './protocol'
import type {
  BatchRequest,
  ControlRequest,
  DoneMessage,
  ErrorMessage,
  FrameMessage,
  ProgressMessage,
  ReadyMessage,
  SpeedRequest,
  StartRequest,
  WorkerRequest,
  WorkerResponse,
} from './protocol'
import { AGENT_FIELD, AGENT_STATE_ORDER, AGENT_STRIDE } from '../sim/types'
import { CROWD_SAFETY, WALKWAY_LOS, crowdSafetyLevel, losIndex } from '../sim/metrics/los'
import { Simulation } from '../sim/engine'
import { createScenario } from '../core/model/defaults'
import type { Plan, Scenario } from '../core/model/types'

/**
 * A venue using every part of the plan, so that a field added to the document
 * without thought for the worker boundary shows up here rather than as a
 * `DataCloneError` the first time somebody presses Run.
 */
const furnishedPlan = (): Plan => ({
  walls: [
    { id: 'w1', a: { x: 0, y: 0 }, b: { x: 12, y: 0 }, thickness: 0.15, height: 3, kind: 'wall' },
    { id: 'w2', a: { x: 12, y: 0 }, b: { x: 12, y: 8 }, thickness: 0.15, height: 3, kind: 'glass' },
    { id: 'w3', a: { x: 12, y: 8 }, b: { x: 0, y: 8 }, thickness: 0.1, height: 1.1, kind: 'rail' },
  ],
  openings: [
    {
      id: 'o1',
      wallId: 'w1',
      offset: 3,
      width: 0.91,
      height: 2.03,
      sill: 0,
      kind: 'door',
      swing: 'left',
      use: 'entry',
    },
  ],
  furniture: [
    {
      id: 'f1',
      catalogId: 'table-round-900',
      position: { x: 4, y: 4 },
      rotation: Math.PI / 4,
      size: { width: 0.9, depth: 0.9, height: 0.74 },
      blocking: true,
    },
  ],
  zones: [
    {
      id: 'z1',
      kind: 'waypoint',
      name: 'Bar',
      polygon: [
        { x: 1, y: 1 },
        { x: 3, y: 1 },
        { x: 3, y: 3 },
      ],
      dwell: { kind: 'lognormal', mean: 90, sd: 30, min: 10, max: 600 },
      capacity: 12,
    },
  ],
  servicePoints: [
    {
      id: 's1',
      name: 'Box office',
      position: { x: 8, y: 2 },
      rotation: 0,
      width: 1.8,
      depth: 0.6,
      servers: 2,
      serviceTime: { kind: 'exponential', mean: 30 },
      queue: [
        { x: 8, y: 3 },
        { x: 8, y: 7 },
      ],
      queueSpacing: 0.45,
      opensAt: 0,
      closesAt: 3600,
    },
  ],
  backdrop: {
    src: 'data:image/png;base64,iVBORw0KGgo=',
    position: { x: 6, y: 4 },
    rotation: 0,
    width: 12,
    depth: 8,
    opacity: 0.4,
    visible: true,
  },
})

const startRequest = (): StartRequest => ({
  type: 'start',
  runId: 'run-1',
  plan: furnishedPlan(),
  scenario: createScenario(),
  options: { cellSize: 0.25, timeStep: 0.05 },
  frameIntervalS: 0.2,
  speed: 4,
})

describe('requests crossing to the worker', () => {
  it('carries a whole venue over without losing a field', () => {
    const request = startRequest()
    const arrived = structuredClone(request)

    expect(arrived).toEqual(request)
    // A copy all the way down, not the same objects: the editor keeps mutating
    // its own document while the run plays, and the worker must not see those
    // edits land halfway through a step.
    expect(arrived.plan).not.toBe(request.plan)
    expect(arrived.plan.walls[0].a).not.toBe(request.plan.walls[0].a)
    expect(arrived.plan.servicePoints[0].queue?.[1]).toEqual({ x: 8, y: 7 })
    expect(arrived.plan.servicePoints[0].queue?.[1]).not.toBe(
      request.plan.servicePoints[0].queue?.[1],
    )
    expect(arrived.scenario.populations[0]).not.toBe(request.scenario.populations[0])
    expect(arrived.plan.zones[0].dwell).toEqual({
      kind: 'lognormal',
      mean: 90,
      sd: 30,
      min: 10,
      max: 600,
    })
    expect(arrived.plan.backdrop?.src).toBe('data:image/png;base64,iVBORw0KGgo=')
  })

  it('keeps an unlimited playback speed unlimited', () => {
    const request: StartRequest = { ...startRequest(), speed: Infinity }

    expect(structuredClone(request).speed).toBe(Infinity)
    // Infinity is the protocol's "as fast as it can"; routing the request
    // through JSON instead would quietly turn it into a stall.
    expect(JSON.parse(JSON.stringify(request)).speed).toBeNull()
  })

  it('will not carry a document that has picked up something live', () => {
    const plan = furnishedPlan() as Plan & { mesh?: unknown }
    plan.mesh = () => 'a renderer object that crept into the document'

    expect(() => structuredClone({ type: 'start', plan })).toThrow(/could not be cloned/)
  })

  it('names the run on every request, so a stale reply can be told apart', () => {
    const requests: WorkerRequest[] = [
      startRequest(),
      { type: 'pause', runId: 'run-1' } satisfies ControlRequest,
      { type: 'resume', runId: 'run-1' } satisfies ControlRequest,
      { type: 'stop', runId: 'run-1' } satisfies ControlRequest,
      { type: 'speed', runId: 'run-1', speed: 16 } satisfies SpeedRequest,
      {
        type: 'batch',
        runId: 'run-2',
        plan: furnishedPlan(),
        scenario: createScenario(),
        frameIntervalS: 1,
      } satisfies BatchRequest,
    ]

    const kinds = requests.map((request) => structuredClone(request).type)
    expect(kinds).toEqual(['start', 'pause', 'resume', 'stop', 'speed', 'batch'])
    // The worker reads `runId` back off whatever arrived — to guard a control
    // message against a run that has moved on, and to name the run in an error.
    for (const request of requests) expect(structuredClone(request).runId).toMatch(/^run-\d$/)
  })
})

describe('responses crossing to the main thread', () => {
  const frame = (count: number): FrameMessage => {
    const agents = new Float32Array(count * AGENT_STRIDE)
    for (let i = 0; i < count; i++) agents[i * AGENT_STRIDE + AGENT_FIELD.x] = i + 0.5
    return {
      type: 'frame',
      runId: 'run-1',
      time: 12.5,
      count,
      agents: agents.buffer,
      density: new Uint8Array([0, 40, 255]).buffer,
      stats: {
        time: 12.5,
        spawned: count,
        active: count,
        completed: 0,
        meanDensity: 1.2,
        peakDensity: 3.4,
        meanSpeed: 0.9,
        meanWalkingSpeed: 1.1,
        walking: count,
        stoppedShare: 0.1,
        meanWait: 0,
        maxWait: 0,
        queueLengths: [{ id: 's1', name: 'Box office', waiting: 3, served: 9, meanWait: 22 }],
        worstLos: 'C',
      },
      progress: 0.5,
    }
  }

  it('hands a frame over rather than copying it', () => {
    const message = frame(3)
    const arrived = structuredClone(message, { transfer: [message.agents, message.density] })

    expect(new Float32Array(arrived.agents)[AGENT_FIELD.x]).toBeCloseTo(0.5, 6)
    expect(arrived.stats.queueLengths[0].waiting).toBe(3)
    // Handing over detaches: the worker's copy is gone, which is why it builds
    // a fresh buffer for every frame instead of reusing the engine's.
    expect(message.agents.byteLength).toBe(0)
    expect(message.density.byteLength).toBe(0)
  })

  it('names the packed people as a buffer, because a view of one cannot be handed over', () => {
    const message = frame(2)
    const view = new Float32Array(message.agents)

    // This is why `FrameMessage.agents` is an `ArrayBuffer` and the store, not
    // the worker, is the end that builds the Float32Array over it.
    expect(() => structuredClone(message, { transfer: [view as unknown as Transferable] })).toThrow(
      /transferList/,
    )
  })

  it('copies the time series, which cannot be handed over', () => {
    const done: DoneMessage = {
      type: 'done',
      runId: 'run-1',
      summary: {
        durationS: 300,
        seed: 1,
        totalPeople: 2,
        completed: 2,
        meanJourney: 31.5,
        p95Journey: 40,
        meanWait: 0,
        maxWait: 0,
        meanQueueTime: 0,
        clearanceTime: 42,
        walkableArea: 96,
        peakOccupancy: 2,
        peakDensity: 0.4,
        losShare: { A: 0.9, B: 0.1 },
        services: [],
        areas: [],
        warnings: ['Two exits share a doorway'],
      },
      series: {
        time: Float32Array.from([0, 1, 2]),
        active: Float32Array.from([2, 2, 1]),
        completed: Float32Array.from([0, 0, 1]),
        meanSpeed: Float32Array.from([0, 1.2, 1.1]),
        peakDensity: Float32Array.from([0, 0.4, 0.3]),
        queueTotal: Float32Array.from([0, 0, 0]),
      },
    }

    const arrived = structuredClone(done)
    expect(Array.from(arrived.series.active)).toEqual([2, 2, 1])
    expect(arrived.summary.warnings).toEqual(['Two exits share a doorway'])
    expect(arrived.summary.losShare.A).toBeCloseTo(0.9, 6)
    // The series are views, not buffers, so a transfer list would reject them —
    // the worker posts this message without one, and the store keeps the arrays
    // for as long as the run is on screen.
    expect(() =>
      structuredClone(done, { transfer: [done.series.time as unknown as Transferable] }),
    ).toThrow(/transferList/)
  })
})

describe('the density stream', () => {
  const roundTrip = (values: number[]): number[] => {
    const field = Float32Array.from(values)
    const bytes = encodeDensity(field, new Uint8Array(field.length))
    return Array.from(decodeDensity(bytes, new Float32Array(field.length)))
  }

  it('redraws the heat map to within half a byte of the real crowd', () => {
    const field = new Float32Array(601)
    for (let i = 0; i < field.length; i++) field[i] = i / 100

    const back = decodeDensity(
      encodeDensity(field, new Uint8Array(field.length)),
      new Float32Array(field.length),
    )
    for (let i = 0; i < field.length; i++) {
      // Half a step is 0.012 persons/m², a tenth of the narrowest Fruin band.
      // The extra slack is single-precision storage, not the quantiser.
      expect(Math.abs(back[i] - field[i])).toBeLessThanOrEqual(DENSITY_SCALE / 2 + 1e-6)
    }
    expect(roundTrip([0, 6])).toEqual([0, 6])
  })

  it('saturates a crush instead of wrapping it round to an empty floor', () => {
    // 9 persons/m² is 382 steps: left to truncate into a byte it would arrive as
    // 127 and paint the worst cell in the venue as comfortable.
    expect(roundTrip([9])[0]).toBe(6)
    expect(roundTrip([1e6])[0]).toBe(6)
  })

  it('reads a negative sliver of noise as empty floor, not as a crush', () => {
    // Truncating -0.5 into a byte gives 235, which is 5.5 persons/m² — a red
    // cell on floor nobody is standing on.
    expect(roundTrip([-0.5, -1e-6])).toEqual([0, 0])
  })

  it('still reports a stewarding-level crowd as one after quantising', () => {
    for (const density of [3.9, CROWD_SAFETY.warnDensity, 4.6, CROWD_SAFETY.criticalDensity, 5.8]) {
      expect(crowdSafetyLevel(roundTrip([density])[0])).toBe(crowdSafetyLevel(density))
    }
    // The price of the byte, stated rather than hidden: a cell within half a
    // step of a threshold is reported on whichever side it rounds to. 3.99
    // persons/m² arrives as exactly 4 and trips the stewarding overlay — 0.012
    // persons/m² of error on one cell, which is the resolution the heat map is
    // honest to.
    expect(crowdSafetyLevel(3.99)).toBe('safe')
    expect(roundTrip([3.99])[0]).toBe(CROWD_SAFETY.warnDensity)
    expect(crowdSafetyLevel(roundTrip([3.99])[0])).toBe('warn')
  })

  it('keeps the level of service of any cell not sitting on a band edge', () => {
    for (const band of WALKWAY_LOS) {
      if (!Number.isFinite(band.maxDensity)) continue
      const inside = band.maxDensity - DENSITY_SCALE
      expect(losIndex(roundTrip([inside])[0])).toBe(losIndex(inside))
    }
  })

  it('writes into the buffers it is handed instead of allocating new ones', () => {
    const bytes = new Uint8Array(4)
    const floats = new Float32Array(4)

    // The worker hands the byte buffer straight to postMessage and the store
    // decodes into one buffer for the whole run; allocating per frame would
    // make playback churn garbage sixty times a second.
    expect(encodeDensity(Float32Array.from([1, 2, 3, 4]), bytes)).toBe(bytes)
    expect(decodeDensity(bytes, floats)).toBe(floats)
    expect(floats[3]).toBeCloseTo(4, 2)
  })

  it('fills exactly as many cells as the field has, and leaves the rest alone', () => {
    // Both ends size their buffer from the grid the `ready` message described;
    // a mismatch would show as a heat map that is stale down one edge rather
    // than as an error, so the codec's behaviour here is worth pinning.
    const bytes = new Uint8Array(4).fill(200)
    encodeDensity(Float32Array.from([3, 3]), bytes)
    expect(Array.from(bytes)).toEqual([128, 128, 200, 200])

    const floats = new Float32Array(3).fill(9)
    decodeDensity(new Uint8Array([255]), floats)
    expect(Array.from(floats)).toEqual([6, 9, 9])
  })

  it('reads a cell that has gone to NaN as empty floor', () => {
    // Nothing in the engine should produce one, and neither clamp catches it —
    // NaN compares false against both. It survives only because storing NaN in
    // a byte array writes zero, so the cell reads as empty rather than as a
    // random colour on the heat map.
    expect(roundTrip([NaN])).toEqual([0])
  })
})

// ---------------------------------------------------------------------------
// The other end of the contract: what the worker actually posts.
// ---------------------------------------------------------------------------

interface Posted {
  /** The message as the worker built it; its buffers are detached after posting. */
  sent: WorkerResponse
  transfer: Transferable[]
  /** What the main thread receives, having crossed the boundary for real. */
  arrived: WorkerResponse
}

const posted: Posted[] = []

const workerSelf = {
  onmessage: null as ((event: MessageEvent<WorkerRequest>) => void) | null,
  postMessage(message: WorkerResponse, transfer: Transferable[] = []): void {
    // Crossing for real: anything the worker cannot clone or hand over fails
    // here, at the moment it posts it, exactly as it would in a browser.
    posted.push({ sent: message, transfer, arrived: structuredClone(message, { transfer }) })
  },
}

const send = (request: WorkerRequest): void => {
  workerSelf.onmessage?.({ data: request } as unknown as MessageEvent<WorkerRequest>)
}

/** Sends a request and returns everything the worker posted before it returned. */
const deliver = (request: WorkerRequest): Posted[] => {
  posted.length = 0
  send(request)
  return [...posted]
}

/** Lets the paced worker run for a stretch of wall clock and collects the result. */
const overWallClock = (ms: number): Posted[] => {
  posted.length = 0
  vi.advanceTimersByTime(ms)
  return [...posted]
}

const framesOf = (messages: Posted[]): FrameMessage[] =>
  messages
    .filter((entry) => entry.arrived.type === 'frame')
    .map((entry) => entry.arrived as FrameMessage)

const frameTimes = (messages: Posted[]): number[] => framesOf(messages).map((frame) => frame.time)

const lastMessage = (messages: Posted[]): WorkerResponse => messages[messages.length - 1].arrived

const corridorPlan = (): Plan => ({
  walls: [
    { id: 'n', a: { x: 0, y: 0 }, b: { x: 12, y: 0 }, thickness: 0.15, height: 3, kind: 'wall' },
    { id: 's', a: { x: 0, y: 3 }, b: { x: 12, y: 3 }, thickness: 0.15, height: 3, kind: 'wall' },
    { id: 'w', a: { x: 0, y: 0 }, b: { x: 0, y: 3 }, thickness: 0.15, height: 3, kind: 'wall' },
    { id: 'e', a: { x: 12, y: 0 }, b: { x: 12, y: 3 }, thickness: 0.15, height: 3, kind: 'wall' },
  ],
  openings: [],
  furniture: [],
  zones: [
    {
      id: 'entry',
      kind: 'entry',
      name: 'Doors',
      polygon: [
        { x: 0.6, y: 0.6 },
        { x: 2, y: 0.6 },
        { x: 2, y: 2.4 },
        { x: 0.6, y: 2.4 },
      ],
    },
    {
      id: 'exit',
      kind: 'exit',
      name: 'Way out',
      polygon: [
        { x: 10, y: 0.6 },
        { x: 11.4, y: 0.6 },
        { x: 11.4, y: 2.4 },
        { x: 10, y: 2.4 },
      ],
    },
  ],
  servicePoints: [],
})

const PROFILE_TOP_SPEED = 1.8

const corridorScenario = (): Scenario => {
  const base = createScenario()
  return {
    ...base,
    durationS: 60,
    seed: 7,
    profiles: [
      {
        id: 'adult',
        name: 'Adult',
        radius: 0.23,
        speed: { mean: 1.3, sd: 0.15, min: 0.8, max: PROFILE_TOP_SPEED },
        caution: 1,
        assertiveness: 0.5,
        color: '#4c7dd4',
        heightScale: 1,
        mobility: 'walking',
      },
    ],
    populations: [
      {
        ...base.populations[0],
        count: 6,
        entryIds: ['entry'],
        arrival: { kind: 'all-at-once', startS: 0, windowS: 0 },
        profileMix: [{ profileId: 'adult', weight: 1 }],
        itinerary: [{ id: 'step-exit', kind: 'exit' }],
      },
    ],
  }
}

const watchedRun = (): StartRequest => ({
  type: 'start',
  runId: 'watched',
  plan: corridorPlan(),
  scenario: corridorScenario(),
  options: { cellSize: 0.25 },
  frameIntervalS: 2,
  // Unpaced: with the clock frozen below, the whole run arrives in one go.
  speed: Infinity,
})

describe('what the worker sends', () => {
  beforeAll(async () => {
    vi.stubGlobal('self', workerSelf)
    await import('./simulation.worker')
  })

  beforeEach(() => {
    // Freezing the clock defeats the worker's per-tick time budget, so an
    // unpaced run lands synchronously instead of over a string of timers, and
    // a paced one advances only when the test moves the clock. Nothing in this
    // file depends on how fast the machine running it is.
    vi.useFakeTimers()
  })

  afterEach(() => {
    deliver({ type: 'stop', runId: 'watched' })
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('describes the grid before it sends anything to draw on it', () => {
    const messages = deliver(watchedRun())
    const ready = messages[0].arrived as ReadyMessage

    expect(ready.type).toBe('ready')
    expect(ready.runId).toBe('watched')
    expect(ready.grid.cellSize).toBeCloseTo(0.25, 6)
    // The store paints the heat map over exactly this rectangle, so it has to
    // cover the venue: a grid that stopped short would leave the far end of the
    // corridor permanently uncoloured.
    expect(ready.grid.originX).toBeLessThanOrEqual(0)
    expect(ready.grid.originY).toBeLessThanOrEqual(0)
    expect(ready.grid.originX + ready.grid.cols * ready.grid.cellSize).toBeGreaterThanOrEqual(12)
    expect(ready.grid.originY + ready.grid.rows * ready.grid.cellSize).toBeGreaterThanOrEqual(3)
    expect(ready.walkableArea).toBeGreaterThan(20)
    expect(ready.totalPeople).toBe(6)
    // The store sizes its decode buffer from this message, so a frame arriving
    // first would be decoded into a buffer of the wrong length.
    expect(messages.findIndex((entry) => entry.arrived.type === 'frame')).toBe(1)
    expect(messages[0].transfer).toEqual([])
  })

  it('hands each frame over as the two buffers it named', () => {
    const messages = deliver(watchedRun())
    const ready = messages[0].arrived as ReadyMessage
    const cells = ready.grid.cols * ready.grid.rows
    const frames = messages.filter((entry) => entry.sent.type === 'frame')

    expect(frames.length).toBeGreaterThan(2)
    for (const { sent, transfer, arrived } of frames) {
      const before = sent as FrameMessage
      const frame = arrived as FrameMessage
      expect(transfer).toEqual([before.agents, before.density])
      // The store builds a view of exactly count × stride floats over this
      // buffer; a buffer any shorter throws and playback dies mid-run.
      expect(frame.agents.byteLength).toBe(frame.count * AGENT_STRIDE * 4)
      expect(frame.density.byteLength).toBe(cells)
    }
  })

  it('paints a heat map on every frame people are on the floor', () => {
    const frames = framesOf(deliver(watchedRun()))
    const peakOf = (frame: FrameMessage): number =>
      Math.max(
        ...decodeDensity(new Uint8Array(frame.density), new Float32Array(frame.density.byteLength)),
      )

    // A worker that posted the density buffer without encoding the field into
    // it would pass every size check above and still leave the heat map blank.
    for (const frame of frames) {
      if (frame.count === 0) continue
      expect(peakOf(frame)).toBeGreaterThan(0)
    }
    // A run ends on an empty venue, which is how the renderer is told to clear
    // the crowd rather than leave the last people standing there. The field is
    // smoothed towards each step, so a trace of them is still on the heat map —
    // but below level of service A, reading as empty floor and not as people.
    const last = frames[frames.length - 1]
    expect(last.count).toBe(0)
    expect(peakOf(last)).toBeLessThan(WALKWAY_LOS[0].maxDensity)
  })

  it('keeps the next frame intact after the last one has been handed over', () => {
    const messages = deliver(watchedRun())
    const frames = messages.filter((entry) => entry.sent.type === 'frame')

    // Each posted frame is detached at the boundary, so a worker that posted
    // the engine's own packed buffer, or its own reused density bytes, would
    // starve every frame after the first.
    for (const { sent } of frames) {
      expect((sent as FrameMessage).agents.byteLength).toBe(0)
      expect((sent as FrameMessage).density.byteLength).toBe(0)
    }
    for (const frame of framesOf(messages)) {
      if (frame.count === 0) continue
      expect(new Float32Array(frame.agents).some((value) => value !== 0)).toBe(true)
    }
    expect(framesOf(messages).filter((frame) => frame.count > 0).length).toBeGreaterThan(1)
  })

  it('packs people the renderer can read straight out of the buffer', () => {
    const frames = framesOf(deliver(watchedRun()))
    const frame = frames[1]
    const agents = new Float32Array(frame.agents, 0, frame.count * AGENT_STRIDE)
    const ids = new Set<number>()

    expect(frame.count).toBe(6)
    for (let i = 0; i < frame.count; i++) {
      const base = i * AGENT_STRIDE
      // Inside the corridor walls: a person the renderer draws inside a wall is
      // the first thing anybody notices, and the packed record is where a
      // stride or field mix-up would show up as exactly that.
      expect(agents[base + AGENT_FIELD.x]).toBeGreaterThan(0.15)
      expect(agents[base + AGENT_FIELD.x]).toBeLessThan(11.85)
      expect(agents[base + AGENT_FIELD.y]).toBeGreaterThan(0.15)
      expect(agents[base + AGENT_FIELD.y]).toBeLessThan(2.85)
      expect(agents[base + AGENT_FIELD.radius]).toBeCloseTo(0.23, 6)
      expect(agents[base + AGENT_FIELD.speed]).toBeGreaterThan(0)
      expect(agents[base + AGENT_FIELD.speed]).toBeLessThanOrEqual(PROFILE_TOP_SPEED)
      expect(Number.isFinite(agents[base + AGENT_FIELD.heading])).toBe(true)
      expect(AGENT_STATE_ORDER[agents[base + AGENT_FIELD.state]]).toBe('walking')
      expect(agents[base + AGENT_FIELD.waited]).toBe(0)
      ids.add(agents[base + AGENT_FIELD.id])
    }
    // The renderer keys its instances by id; two people sharing one would leave
    // a body behind when the crowd thins.
    expect(ids.size).toBe(6)
  })

  it('records one sample of every series for each frame it sent', () => {
    const messages = deliver(watchedRun())
    const done = lastMessage(messages) as DoneMessage

    expect(done.type).toBe('done')
    const lengths = Object.values(done.series).map((series) => series.length)
    // The charts read these six as columns of one table against the frame
    // times; a short one silently plots the wrong moment against a value.
    expect(new Set(lengths).size).toBe(1)
    const times = frameTimes(messages)
    expect(lengths[0]).toBe(times.length)
    // Sampled at the moment each frame was built, and carried as float32 for
    // the charts rather than as the double the frame quotes.
    times.forEach((time, i) => expect(done.series.time[i]).toBeCloseTo(time, 5))
    expect(done.series.completed[done.series.completed.length - 1]).toBe(done.summary.completed)
    expect(messages[messages.length - 1].transfer).toEqual([])
  })

  it('finishes a run everybody could walk out of', () => {
    const messages = deliver(watchedRun())
    const ready = messages[0].arrived as ReadyMessage
    const done = lastMessage(messages) as DoneMessage
    const frames = framesOf(messages)

    expect(done.summary.completed).toBe(6)
    expect(done.summary.walkableArea).toBeCloseTo(ready.walkableArea, 6)
    // Frame time and progress only ever move forwards — the playback head and
    // the progress bar are driven straight off them.
    expect(frameTimes(messages)).toEqual([...frameTimes(messages)].sort((a, b) => a - b))
    for (const frame of frames) {
      expect(frame.progress).toBeGreaterThanOrEqual(0)
      expect(frame.progress).toBeLessThanOrEqual(1)
      expect(frame.stats.completed + frame.stats.active).toBeLessThanOrEqual(ready.totalPeople)
    }
    expect(done.summary.clearanceTime).toBeLessThanOrEqual(frames[frames.length - 1].time)
  })

  it('says how many people were asked for as well as how many it could run', () => {
    const messages = deliver({ ...watchedRun(), options: { cellSize: 0.25, maxAgents: 2 } })
    const ready = messages[0].arrived as ReadyMessage
    const done = lastMessage(messages) as DoneMessage

    // These two are deliberately different numbers. `ready.totalPeople` is the
    // headcount the scenario asked for; the summary's is how many the engine
    // would run. The findings panel subtracts one from the other to tell the
    // user the run was capped, so making them agree would hide the cap.
    expect(ready.totalPeople).toBe(6)
    expect(done.summary.totalPeople).toBe(2)
    expect(ready.warnings).toEqual(['This scenario asks for 6 people; the run was capped at 2.'])
  })

  it('warns before the first frame that nobody can get out, and never claims they did', () => {
    const plan = corridorPlan()
    plan.zones = plan.zones.filter((zone) => zone.kind !== 'exit')
    const messages = deliver({
      ...watchedRun(),
      plan,
      scenario: { ...corridorScenario(), durationS: 12 },
    })
    const ready = messages[0].arrived as ReadyMessage
    const done = lastMessage(messages) as DoneMessage

    // The warning has to travel with `ready`, which is what the store shows
    // while the run plays: told afterwards, the user has already watched six
    // people mill about and drawn their own conclusion.
    expect(ready.warnings).toEqual(['No exit areas: people stay in the venue once they finish.'])
    expect(done.summary.completed).toBe(0)
    expect(done.series.active[done.series.active.length - 1]).toBe(6)
    expect(done.summary.warnings.some((warning) => /had not left/.test(warning))).toBe(true)
  })

  it('reaches the same numbers in the background as it did on screen', () => {
    const watched = deliver(watchedRun())
    const watchedDone = lastMessage(watched) as DoneMessage

    const compared = deliver({
      type: 'batch',
      runId: 'compared',
      plan: corridorPlan(),
      scenario: corridorScenario(),
      options: { cellSize: 0.25 },
      frameIntervalS: 1,
    })
    const comparedDone = lastMessage(compared) as DoneMessage

    // A comparison run is only worth anything if streaming frames to the screen
    // does not change the result, so the two paths must agree exactly.
    expect(comparedDone.summary).toEqual(watchedDone.summary)
    expect(framesOf(compared)).toEqual([])
    expect(compared[0].arrived.type).toBe('ready')
    expect(comparedDone.series.time.length).toBeGreaterThan(0)
  })

  it('reports how far a background run has got while it is still running', () => {
    // The chunk loop measures its own 30 ms budget with Date.now, so a clock
    // that moves six milliseconds a reading gives every machine the same number
    // of steps per chunk and the same messages.
    let elapsed = 0
    vi.spyOn(Date, 'now').mockImplementation(() => (elapsed += 6))

    deliver({
      type: 'batch',
      runId: 'compared',
      plan: corridorPlan(),
      scenario: corridorScenario(),
      options: { cellSize: 0.25 },
      frameIntervalS: 1,
    })
    vi.runAllTimers()
    const reported = posted
      .filter((entry) => entry.arrived.type === 'progress')
      .map((entry) => (entry.arrived as ProgressMessage).progress)

    // Nothing else tells the user a comparison is alive: without these the
    // background run is an unmoving bar until it finishes.
    expect(reported.length).toBeGreaterThan(5)
    expect(reported).toEqual([...reported].sort((a, b) => a - b))
    expect(Math.min(...reported)).toBeGreaterThan(0)
    expect(Math.max(...reported)).toBeLessThanOrEqual(1)
    expect(lastMessage(posted).type).toBe('done')
    expect(
      posted.every((entry) => 'runId' in entry.arrived && entry.arrived.runId === 'compared'),
    ).toBe(true)
  })

  it('plays a run back at the speed it was asked for', () => {
    const paced: StartRequest = { ...watchedRun(), frameIntervalS: 0.5, speed: 1 }
    deliver(paced)

    const firstSecond = frameTimes(overWallClock(1000))
    // "Speed" is simulated seconds per wall-clock second: one second of the
    // clock has to be about one second of the crowd, or the clock on screen and
    // the people under it disagree.
    expect(firstSecond[firstSecond.length - 1]).toBeGreaterThanOrEqual(1)
    expect(firstSecond[firstSecond.length - 1]).toBeLessThan(1.5)

    send({ type: 'speed', runId: 'watched', speed: 4 })
    const fasterSecond = frameTimes(overWallClock(1000))
    const advanced = fasterSecond[fasterSecond.length - 1] - firstSecond[firstSecond.length - 1]
    expect(advanced).toBeGreaterThan(3)
    expect(advanced).toBeLessThan(5)
  })

  it('freezes the crowd where it is while a run is paused', () => {
    deliver({ ...watchedRun(), frameIntervalS: 0.5, speed: 1 })
    const before = frameTimes(overWallClock(1000))

    send({ type: 'pause', runId: 'watched' })
    // Not merely "stops painting": a paused run must not step the simulation
    // either, or the crowd teleports the moment it is resumed.
    expect(overWallClock(5000)).toEqual([])

    send({ type: 'resume', runId: 'watched' })
    const after = frameTimes(overWallClock(1000))
    // It picks up where it stopped. Had the five paused seconds counted, the
    // next frame would be six simulated seconds in, not one and a half.
    expect(after[0] - before[before.length - 1]).toBeLessThanOrEqual(0.6)
    expect(after[after.length - 1]).toBeLessThan(2.5)
  })

  it('will not stream frames faster than the screen can use them', () => {
    // `frameIntervalS` is a simulated interval, and the store asks for 0.2 s.
    // Asked for zero, a 50 ms floor still holds — each frame is a copy of the
    // crowd and a copy of the heat map, and posting one per physics step would
    // spend the run's budget on postMessage.
    const times = frameTimes(
      deliver({ ...watchedRun(), frameIntervalS: 0, options: { cellSize: 0.3, timeStep: 0.02 } }),
    )
    const span = times[times.length - 1] - times[0]

    const steps = span / 0.02
    expect(times.length).toBeGreaterThan(2)
    expect(span / (times.length - 1)).toBeCloseTo(0.05, 2)
    expect(times.length).toBeLessThan(steps / 2)
  })

  it('answers a request it cannot run with an error naming the run', () => {
    const brokenPlan = { walls: [] } as unknown as Plan
    let reason = 'the engine accepted a plan with nothing in it'
    try {
      new Simulation(brokenPlan, corridorScenario(), { cellSize: 0.25 })
    } catch (error) {
      reason = (error as Error).message
    }

    const broken = deliver({ ...watchedRun(), runId: 'broken', plan: brokenPlan })
    const failed = lastMessage(broken) as ErrorMessage

    expect(failed.type).toBe('error')
    expect(failed.runId).toBe('broken')
    // The reason the engine gave, not a swallowed "the simulation failed": it
    // is the only thing the error panel has to show.
    expect(failed.message).toBe(reason)
    // The run must be dropped too, and the worker must still take the next one:
    // a half-built run left ticking would post frames for a run the store has
    // already put into its error state.
    expect(deliver({ type: 'resume', runId: 'broken' })).toEqual([])
    expect(deliver(watchedRun())[0].arrived.type).toBe('ready')
  })

  it('leaves the run on screen alone when a control message names another run', () => {
    deliver({ ...watchedRun(), frameIntervalS: 0.5, speed: 1 })

    send({ type: 'pause', runId: 'a-run-that-ended' })
    send({ type: 'speed', runId: 'a-run-that-ended', speed: 60 })
    const carriedOn = frameTimes(overWallClock(1000))
    // Both are guarded by run id, so a message meant for a run that has gone
    // can neither freeze the current one nor wind its speed up.
    expect(carriedOn.length).toBe(2)
    expect(carriedOn[carriedOn.length - 1]).toBeLessThan(1.5)

    send({ type: 'stop', runId: 'a-run-that-ended' })
    // `stop` is the exception: it carries a run id but ends whatever is
    // running, whoever it names. Nothing can send a stale one today — the store
    // forgets the run in the same breath as it stops it — but a sender that
    // did would leave the phase on 'running' with no frames and no error.
    expect(overWallClock(5000)).toEqual([])
  })

  it('drops the run it was watching when a new one starts', () => {
    deliver({ ...watchedRun(), runId: 'first', frameIntervalS: 0.5, speed: 1 })
    overWallClock(1000)

    const second = deliver({ ...watchedRun(), runId: 'second', frameIntervalS: 0.5, speed: 1 })
    expect(second.map((entry) => entry.arrived.type)).toEqual(['ready', 'frame'])

    // One run at a time. Two tick chains alive at once would interleave frames
    // from two different crowds into the one buffer the store draws.
    const afterwards = overWallClock(3000)
    expect(afterwards.length).toBeGreaterThan(0)
    expect(
      afterwards.every((entry) => 'runId' in entry.arrived && entry.arrived.runId === 'second'),
    ).toBe(true)
  })
})
