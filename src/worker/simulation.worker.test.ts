/**
 * The worker's message loop.
 *
 * `simulation.worker.ts` exports nothing: it installs `self.onmessage` when it
 * loads. So these tests stand a `self` up, import the module for that side
 * effect, and then speak the protocol to it exactly as the store does — one
 * message in, whatever the worker posts back out.
 *
 * Every reply is put through `structuredClone` at the moment it is posted,
 * because a value that cannot be cloned cannot leave a worker at all: it throws
 * inside `postMessage` and the main thread simply never hears from the run
 * again. Cloning here fails in the same place, with a test name attached.
 *
 * `protocol.test.ts` covers the shape of what crosses and the happy path of a
 * watched run. This file is about the seams: stopping, the playback controls,
 * messages that name a run which has moved on, the progress the bar is driven
 * from, and what happens when the engine throws.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createScenario } from '../core/model/defaults'
import { WALKWAY_LOS } from '../sim/metrics/los'
import type * as SimEngine from '../sim/engine'
import type { Plan, Scenario } from '../core/model/types'
import type {
  BatchRequest,
  DoneMessage,
  ErrorMessage,
  FrameMessage,
  StartRequest,
  WorkerRequest,
  WorkerResponse,
} from './protocol'

/**
 * A fuse in the engine.
 *
 * Nothing in a well-formed plan makes a healthy simulation throw partway
 * through a run, and "the tenth step blew up" is precisely the case the
 * worker's error path exists for — so the real engine is subclassed and given
 * one place to fail on demand. Everything else about it is the shipped engine,
 * and with the fuse unset every test below runs against the real thing.
 */
const failure = vi.hoisted(() => ({ afterSteps: null as number | null, thrown: null as unknown }))

vi.mock('../sim/engine', async () => {
  const actual = await vi.importActual<typeof SimEngine>('../sim/engine')
  class FusedSimulation extends actual.Simulation {
    private taken = 0
    override step(dt?: number): void {
      if (failure.afterSteps !== null && this.taken === failure.afterSteps) throw failure.thrown
      this.taken++
      super.step(dt)
    }
  }
  return { ...actual, Simulation: FusedSimulation }
})

interface Posted {
  /** The message as the worker built it; its buffers are detached after posting. */
  sent: WorkerResponse
  /** What the main thread receives, having crossed the boundary for real. */
  arrived: WorkerResponse
}

/** Everything the worker has posted since the current test began. */
const posted: Posted[] = []

const workerSelf = {
  onmessage: null as ((event: MessageEvent<WorkerRequest>) => void) | null,
  postMessage(message: WorkerResponse, transfer: Transferable[] = []): void {
    posted.push({ sent: message, arrived: structuredClone(message, { transfer }) })
  },
}

const send = (request: WorkerRequest): void => {
  workerSelf.onmessage?.({ data: request } as unknown as MessageEvent<WorkerRequest>)
}

/** Sends a request and returns everything the worker posted before it returned. */
const deliver = (request: WorkerRequest): Posted[] => {
  const from = posted.length
  send(request)
  return posted.slice(from)
}

/** Lets a paced run have a stretch of wall clock and collects what it posted. */
const overWallClock = (ms: number): Posted[] => {
  const from = posted.length
  vi.advanceTimersByTime(ms)
  return posted.slice(from)
}

const arrivals = (messages: Posted[]): WorkerResponse[] => messages.map((entry) => entry.arrived)

const kindsOf = (messages: Posted[]): string[] => arrivals(messages).map((message) => message.type)

const framesOf = (messages: Posted[]): FrameMessage[] =>
  arrivals(messages).filter((message): message is FrameMessage => message.type === 'frame')

const frameTimes = (messages: Posted[]): number[] => framesOf(messages).map((frame) => frame.time)

const lastMessage = (messages: Posted[]): WorkerResponse => messages[messages.length - 1].arrived

const runIdsIn = (messages: Posted[]): string[] =>
  arrivals(messages).map((message) => ('runId' in message ? message.runId : ''))

/** A hall people cross from one end to the other, and can be shut in. */
const hall = (): Plan => ({
  walls: [
    { id: 'n', a: { x: 0, y: 0 }, b: { x: 14, y: 0 }, thickness: 0.15, height: 3, kind: 'wall' },
    { id: 'e', a: { x: 14, y: 0 }, b: { x: 14, y: 6 }, thickness: 0.15, height: 3, kind: 'wall' },
    { id: 's', a: { x: 14, y: 6 }, b: { x: 0, y: 6 }, thickness: 0.15, height: 3, kind: 'wall' },
    { id: 'w', a: { x: 0, y: 6 }, b: { x: 0, y: 0 }, thickness: 0.15, height: 3, kind: 'wall' },
  ],
  openings: [],
  furniture: [],
  zones: [
    {
      id: 'entry',
      kind: 'entry',
      name: 'Front doors',
      polygon: [
        { x: 0.8, y: 1 },
        { x: 2.6, y: 1 },
        { x: 2.6, y: 5 },
        { x: 0.8, y: 5 },
      ],
    },
    {
      id: 'exit',
      kind: 'exit',
      name: 'Way out',
      polygon: [
        { x: 11.4, y: 1 },
        { x: 13.2, y: 1 },
        { x: 13.2, y: 5 },
        { x: 11.4, y: 5 },
      ],
    },
  ],
  servicePoints: [],
})

const crossing = (): Scenario => {
  const base = createScenario()
  return {
    ...base,
    durationS: 40,
    seed: 3,
    populations: [
      {
        ...base.populations[0],
        count: 8,
        entryIds: ['entry'],
        arrival: { kind: 'all-at-once', startS: 0, windowS: 0 },
        itinerary: [{ id: 'leave', kind: 'exit' }],
      },
    ],
  }
}

/** Unpaced: with the clock frozen below, the whole run lands in one call. */
const wholeRun = (runId = 'run-1'): StartRequest => ({
  type: 'start',
  runId,
  plan: hall(),
  scenario: crossing(),
  options: { cellSize: 0.25 },
  frameIntervalS: 1,
  speed: Infinity,
})

/** Paced at one simulated second per second, which is how a run is watched. */
const watchedRun = (runId = 'run-1'): StartRequest => ({
  ...wholeRun(runId),
  frameIntervalS: 0.5,
  speed: 1,
})

/** The same crowd again, run to the end off screen for a comparison. */
const backgroundRun = (frameIntervalS = 1, runId = 'compared'): BatchRequest => ({
  type: 'batch',
  runId,
  plan: hall(),
  scenario: crossing(),
  options: { cellSize: 0.25 },
  frameIntervalS,
})

beforeAll(async () => {
  vi.stubGlobal('self', workerSelf)
  await import('./simulation.worker')
})

beforeEach(() => {
  // Freezing the clock defeats the worker's per-tick wall-clock budget, so an
  // unpaced run finishes synchronously and a paced one moves only when a test
  // moves the clock. Nothing here depends on how fast the machine is.
  vi.useFakeTimers()
  posted.length = 0
  failure.afterSteps = null
  failure.thrown = null
})

afterEach(() => {
  // `stop` ends whatever is running whatever run it names, so this clears the
  // worker for the next test without it having to know what was left behind.
  send({ type: 'stop', runId: 'whatever-is-left' })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('stopping a run', () => {
  it('leaves the crowd where it stood and never calls the run finished', () => {
    deliver(watchedRun())
    const watched = overWallClock(1000)
    expect(frameTimes(watched).length).toBe(2)

    send({ type: 'stop', runId: 'run-1' })
    // Not "stops painting": the pending timer has to be cancelled and the run
    // let go of, or the next tick posts frames for a run the user has already
    // abandoned. Thirty seconds is more than the whole run needs to finish.
    expect(overWallClock(30_000)).toEqual([])
    // And no `done` anywhere in the run's whole life, not merely after the
    // stop: one arriving late would open the results panel on a summary of a
    // run nobody waited for, and the store keeps no phase that refuses it.
    expect(kindsOf(posted)).not.toContain('done')
  })

  it('cannot be talked back into life once it has been stopped', () => {
    deliver(watchedRun())
    overWallClock(1000)
    send({ type: 'stop', runId: 'run-1' })

    // Nothing should be able to find the stopped run again. The store forgets
    // it in the same breath as it stops it, so these only arrive from a slow
    // click or a keyboard shortcut in flight — and each must be a no-op, not a
    // frame from a run whose window has gone.
    expect(deliver({ type: 'resume', runId: 'run-1' })).toEqual([])
    expect(deliver({ type: 'pause', runId: 'run-1' })).toEqual([])
    expect(deliver({ type: 'speed', runId: 'run-1', speed: 8 })).toEqual([])
    expect(deliver({ type: 'stop', runId: 'run-1' })).toEqual([])
    expect(overWallClock(5000)).toEqual([])

    // And the worker is still good for the next run.
    expect(kindsOf(deliver(wholeRun('run-2')))[0]).toBe('ready')
  })

  it('abandons a background comparison instead of running it to the end', () => {
    // The chunk loop measures its own 30 ms budget with Date.now, so a clock
    // that moves six milliseconds a reading gives every machine the same
    // number of steps per chunk.
    let elapsed = 0
    vi.spyOn(Date, 'now').mockImplementation(() => (elapsed += 6))

    const first = deliver(backgroundRun())
    // Still mid-run when the stop arrives: a comparison that had already
    // finished would prove nothing about cancelling one.
    expect(kindsOf(first)).toEqual(['ready', 'progress'])

    send({ type: 'stop', runId: 'compared' })
    // A comparison is the one run the user cannot see, so nothing but this
    // stops it. Left going it would burn a core for the rest of the session
    // and then post a `done` for a comparison the user had cancelled.
    const from = posted.length
    for (let i = 0; i < 5; i++) vi.advanceTimersToNextTimer()
    expect(posted.slice(from)).toEqual([])
  })
})

describe('a message the worker has no case for', () => {
  it('ignores a request it does not recognise and keeps the run going', () => {
    deliver(watchedRun())

    // The worker is fetched by URL and can be a cached build behind the page
    // that opened it, so a request kind it has never heard of is a real
    // arrival. Ignoring it is right — answering with an error would put a
    // perfectly healthy run into the store's error state.
    expect(deliver({ type: 'rewind', runId: 'run-1' } as unknown as WorkerRequest)).toEqual([])
    expect(frameTimes(overWallClock(1000)).length).toBe(2)
  })

  it('ignores a payload that is not a request at all', () => {
    deliver(watchedRun())

    // The worker hears every `postMessage` aimed at it, and anything else on
    // the page can hand it a string or nothing at all. Reading `.type` off one
    // of those threw inside the try, and the catch threw a second time
    // applying `in` to the same payload — out of the catch and out of
    // `onmessage`, so the store heard `worker.onerror` with an empty run id,
    // read that as the worker itself dying, and put a run that was perfectly
    // healthy into its error state.
    expect(deliver(undefined as unknown as WorkerRequest)).toEqual([])
    expect(deliver(null as unknown as WorkerRequest)).toEqual([])
    expect(deliver('stop' as unknown as WorkerRequest)).toEqual([])

    // Silence rather than an error, for the same reason an unknown request
    // kind is ignored: an error is what puts the run on screen into the
    // store's error state, and nothing has happened to it.
    expect(kindsOf(posted)).not.toContain('error')
    expect(frameTimes(overWallClock(1000)).length).toBe(2)
  })
})

describe('a message that names a run which has moved on', () => {
  it('will not revive a run that a newer one replaced', () => {
    deliver(watchedRun('first'))
    overWallClock(1000)
    deliver(watchedRun('second'))

    send({ type: 'resume', runId: 'first' })
    send({ type: 'speed', runId: 'first', speed: 60 })
    send({ type: 'pause', runId: 'first' })
    const after = overWallClock(1000)

    // `resume` is the dangerous one: unguarded it starts a second tick chain,
    // and two chains alive at once interleave frames from two different crowds
    // into the one buffer the renderer draws. Two frames is one chain: the
    // stale pause did not freeze the new run and the stale 60x did not wind it
    // up. And the times are the replacement's own clock, which starts at zero,
    // a second behind where the run it replaced had got to.
    const times = frameTimes(after)
    expect(new Set(runIdsIn(after))).toEqual(new Set(['second']))
    expect(times.length).toBe(2)
    expect(times[0]).toBeCloseTo(0.5, 6)
    expect(times[1]).toBeCloseTo(1.1, 6)
  })

  it('will not restart a run that has already finished', () => {
    const messages = deliver(wholeRun('finished'))
    expect(lastMessage(messages).type).toBe('done')

    // The run is still the current one — nothing stopped it, it ran out of
    // people. Resuming it would step a finished simulation and post a second
    // `done`, and the store adds the completed count of each into its results.
    expect(deliver({ type: 'resume', runId: 'finished' })).toEqual([])
    expect(deliver({ type: 'pause', runId: 'finished' })).toEqual([])
    expect(overWallClock(10_000)).toEqual([])
  })
})

describe('the playback controls', () => {
  it('changes the speed of a paused run without setting it going again', () => {
    deliver(watchedRun('held'))
    const before = frameTimes(overWallClock(1000))
    send({ type: 'pause', runId: 'held' })

    // `setSpeed` has no phase guard — the store sends a speed for as long as it
    // holds a run id — so dragging the playback speed while paused is an
    // ordinary thing to do. It must not start the crowd walking again: the
    // Play button would still read as paused while the run played on.
    expect(overWallClock(5000)).toEqual([])
    send({ type: 'speed', runId: 'held', speed: 16 })
    expect(overWallClock(5000)).toEqual([])

    send({ type: 'resume', runId: 'held' })
    const after = overWallClock(1000)
    const resumed = frameTimes(after)
    // It picks up where it stopped, not ten seconds on, and at the speed set
    // while it was held: sixteen simulated seconds in one wall second carries
    // the rest of this run, so `done` lands inside the same second.
    expect(before[before.length - 1]).toBeCloseTo(1.1, 6)
    expect(resumed[0]).toBeCloseTo(1.5, 6)
    expect(resumed[resumed.length - 1] - resumed[0]).toBeGreaterThan(10)
    expect(lastMessage(after).type).toBe('done')
  })

  it('keeps to one speed however many times it is told to resume', () => {
    deliver(watchedRun('doubled'))
    const playing = frameTimes(overWallClock(1000))

    // A resume for a run that never paused used to start a second tick chain
    // beside the one already pending, and `tick` overwrites `run.timer` with
    // whatever it schedules, so the older chain could no longer be cancelled:
    // the crowd walked at twice the speed the playback controls reported, and
    // three times after another resume. The store cannot send that today — its
    // own `resume` returns unless the phase is `paused` — but the timer is the
    // worker's, and the speed a crowd plays back at is too central to rest on
    // a guard in the one caller.
    send({ type: 'resume', runId: 'doubled' })
    const resumed = frameTimes(overWallClock(1000))
    send({ type: 'resume', runId: 'doubled' })
    const resumedAgain = frameTimes(overWallClock(1000))

    // At one simulated second per second and a frame every half second, one
    // chain is two frames a wall second, and the crowd's clock keeps pace with
    // them: three wall seconds is three simulated seconds, not six.
    expect([playing.length, resumed.length, resumedAgain.length]).toEqual([2, 2, 2])
    const reached = [playing, resumed, resumedAgain].map((frames) => frames[frames.length - 1])
    expect(reached[0]).toBeCloseTo(1.1, 6)
    expect(reached[1]).toBeCloseTo(2, 6)
    expect(reached[2]).toBeCloseTo(3, 6)

    // And the run is still the single thing a stop has to end.
    send({ type: 'stop', runId: 'doubled' })
    expect(overWallClock(5000)).toEqual([])
  })
})

describe('how far along a run says it is', () => {
  it('fills the bar exactly full when the clock runs out on people still inside', () => {
    const plan = hall()
    plan.zones = plan.zones.filter((zone) => zone.kind !== 'exit')
    const messages = deliver({
      ...wholeRun('penned-in'),
      plan,
      scenario: { ...crossing(), durationS: 6 },
    })
    const progress = framesOf(messages).map((frame) => frame.progress)

    expect(progress.length).toBeGreaterThan(2)
    // The bar is driven straight off this number and it never goes backwards,
    // even across the last step, which overshoots the duration by a fraction
    // of a timestep and would otherwise report more than a full bar.
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
    expect(progress[0]).toBe(0)
    expect(progress[progress.length - 1]).toBe(1)
    expect(lastMessage(messages).type).toBe('done')
    // A run that had to be cut off says so in the summary rather than reading
    // as eight people who got out.
    const done = lastMessage(messages) as DoneMessage
    expect(done.summary.completed).toBe(0)
    expect(done.summary.warnings).toContain(
      '8 people had not left when the run ended; extend the duration for a complete picture.',
    )
  })

  it('stops the bar short when everybody got out early', () => {
    const messages = deliver(wholeRun('early'))
    const frames = framesOf(messages)
    const progress = frames.map((frame) => frame.progress)
    const done = lastMessage(messages) as DoneMessage

    expect(done.type).toBe('done')
    expect(done.summary.completed).toBe(8)
    // A run ends when the last person leaves, not when the clock says so, and
    // a forty-second scenario emptied in a fraction of that ends with the bar
    // part-filled. Anything watching for progress to reach one to know the run
    // is over would sit on a spinner for every run that worked.
    expect(progress[progress.length - 1]).toBeLessThan(0.6)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
    expect(frames[frames.length - 1].time / 40).toBeCloseTo(progress[progress.length - 1], 6)
  })
})

describe('a simulation that throws', () => {
  it('names the run it could not finish, and takes the next one', () => {
    failure.afterSteps = 0
    failure.thrown = new Error('the flow field could not be built')

    const messages = deliver(wholeRun('doomed'))
    const failed = lastMessage(messages) as ErrorMessage

    // The grid and the first frame are already on screen by the time the first
    // step runs, so the store has a run in progress to put into its error
    // state — which it does only for an error naming that run.
    expect(kindsOf(messages)).toEqual(['ready', 'frame', 'error'])
    expect(failed.runId).toBe('doomed')
    expect(failed.message).toBe('the flow field could not be built')

    // The half-built run has to be let go of as well: left ticking it would
    // post frames for a run the store has already given up on.
    expect(overWallClock(10_000)).toEqual([])
    failure.afterSteps = null
    expect(kindsOf(deliver(wholeRun('next')))[0]).toBe('ready')
  })

  it('turns a thrown value that could not itself cross the boundary into words', () => {
    failure.afterSteps = 0
    failure.thrown = 'the navigation grid has no walkable cells'
    expect((lastMessage(deliver(wholeRun('a'))) as ErrorMessage).message).toBe(
      'the navigation grid has no walkable cells',
    )

    // Not everything thrown is an `Error`, and something thrown from a library
    // can carry anything at all. Posting it on as it stands throws inside
    // `postMessage`, and then the failure that killed the run is itself lost —
    // the store would hear nothing and sit on a run that had already died.
    const unclonable = { retry: () => undefined, toString: () => 'the world was never built' }
    failure.thrown = unclonable
    expect(() => structuredClone(unclonable)).toThrow(/could not be cloned/)

    const failed = lastMessage(deliver(wholeRun('b'))) as ErrorMessage
    expect(failed.type).toBe('error')
    expect(failed.message).toBe('the world was never built')
    expect(failed.runId).toBe('b')
  })

  it('lets a crash on a later tick out to the worker itself rather than reporting it', () => {
    failure.afterSteps = 2
    failure.thrown = new Error('an agent walked off the grid')
    deliver(watchedRun('mid-run'))

    // Only the message handler is wrapped in a catch, and every step after the
    // first is taken from a timer instead. So this one escapes to the worker's
    // global scope, where `worker.onerror` on the main thread turns it into an
    // error against whatever is on screen — the run's own id is lost, and the
    // worker keeps holding the run that died. Not filed as a bug: the store
    // reads an empty run id as the worker itself dying and shows it, which is
    // the honest reading of a crash it cannot attribute.
    expect(() => vi.advanceTimersByTime(1000)).toThrow('an agent walked off the grid')
    expect(kindsOf(posted)).not.toContain('error')
  })
})

describe('what a finished run hands back', () => {
  /** Every number anywhere in a value, so none of them can hide. */
  const numbersIn = (value: unknown, path = ''): Array<[string, number]> => {
    if (typeof value === 'number') return [[path, value]]
    if (Array.isArray(value)) return value.flatMap((item, i) => numbersIn(item, `${path}[${i}]`))
    if (value && typeof value === 'object') {
      return Object.entries(value).flatMap(([key, item]) => numbersIn(item, `${path}.${key}`))
    }
    return []
  }

  it('reports only plain numbers the results panel can save as well as show', () => {
    const messages = deliver(wholeRun('saved'))
    const done = lastMessage(messages) as DoneMessage

    // A summary goes into the project file as well as onto the screen, and
    // JSON has no Infinity and no NaN: a divide-by-zero anywhere in the engine
    // would reach the user as `null` in a saved run and as "NaN" on screen.
    for (const [path, value] of numbersIn(done.summary, 'summary')) {
      expect([path, Number.isFinite(value)]).toEqual([path, true])
    }
    for (const frame of framesOf(messages)) {
      for (const [path, value] of numbersIn(frame.stats, `stats@${frame.time}`)) {
        expect([path, Number.isFinite(value)]).toEqual([path, true])
      }
    }
    expect(JSON.parse(JSON.stringify(done.summary))).toStrictEqual(done.summary)

    // The share of the run spent at each level of service is a proportion of
    // one run, so the bands have to partition it: a missing band or a total
    // that is not one would be read straight off the findings panel as a
    // venue that spent time nowhere.
    expect(Object.keys(done.summary.losShare)).toEqual(WALKWAY_LOS.map((band) => band.level))
    const share = Object.values(done.summary.losShare)
    expect(share.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6)
    expect(Math.min(...share)).toBeGreaterThanOrEqual(0)

    // The series is saved with the summary and plotted as six columns of one
    // table. A plain array would survive the crossing and fail only where it
    // is plotted, and a NaN in a column draws as a hole in the curve.
    const columns = Object.values(done.series)
    expect(columns.every((column) => column instanceof Float32Array)).toBe(true)
    for (const column of columns) {
      expect(Array.from(column).filter((value) => !Number.isFinite(value))).toEqual([])
    }
  })

  it('sends the instant a run ends on once, even when it lands on a frame boundary', () => {
    const plan = hall()
    plan.zones = plan.zones.filter((zone) => zone.kind !== 'exit')
    const messages = deliver({
      ...wholeRun('penned-in'),
      plan,
      scenario: { ...crossing(), durationS: 6 },
    })
    const done = lastMessage(messages) as DoneMessage
    const frames = framesOf(messages)
    const [penultimate, last] = frames.slice(-2)

    // The step that ends a run can cross a frame boundary as well, and this
    // one does: cut off at six seconds, on the step that carries the clock
    // past the last boundary. The closing frame used to go out regardless of
    // the frame the loop had just sent, so the same instant crossed twice and
    // every series carried the sample twice — the run reads as one frame
    // longer than it was, the charts draw its last point on top of itself, and
    // the series the results panel writes out ends on the same row printed
    // twice.
    expect(last.time).toBeCloseTo(6.1, 6)
    expect(last.time - penultimate.time).toBeCloseTo(1, 6)
    // Still the instant the clock ran out, with all eight shut in: it is the
    // repeat that has gone, not the end of the run.
    expect([last.count, last.stats.active]).toEqual([8, 8])
    expect(last.progress).toBe(1)
    // One sample per frame sent, and the charts are plotted against those
    // times, so the last two are a second apart there too.
    expect(done.series.time.length).toBe(frames.length)
    expect(Array.from(done.series.active)).toEqual([0, 8, 8, 8, 8, 8, 8])

    // A run that empties between boundaries still gets its closing frame: the
    // last thing on screen has to be the floor emptying, not the frame before.
    const early = framesOf(deliver(wholeRun('early')))
    expect(early[early.length - 1].time).not.toBe(early[early.length - 2].time)
    expect(early[early.length - 1].stats.active).toBe(0)
  })

  it('draws a background comparison on the same curve the screen was shown', () => {
    const watched = deliver(wholeRun('watched'))
    const watchedDone = lastMessage(watched) as DoneMessage
    const compared = deliver(backgroundRun())
    const comparedDone = lastMessage(compared) as DoneMessage

    expect(kindsOf(compared)).toEqual(['ready', 'done'])
    expect(comparedDone.summary).toEqual(watchedDone.summary)

    // The whole product of a run nobody watched is its summary and its series,
    // and the series is only worth anything plotted against the run it is
    // being compared with — so the two are sampled on one grid: the crowd
    // before the first step, then every interval, then the instant the run
    // ended. The chunk loop used to start at the first step and stop at the
    // last whole interval, which left the two curves a step out of step at one
    // end, and left the comparison ending on seven people out against its own
    // summary of eight at the other. Nothing sends `batch` yet — the store
    // compares saved runs — so it cost nothing until the first comparison was
    // run off screen, and then it cost the whole shape of the curve.
    expect(Array.from(comparedDone.series.time)).toEqual(Array.from(watchedDone.series.time))
    expect(Array.from(comparedDone.series.completed)).toEqual(
      Array.from(watchedDone.series.completed),
    )
    expect(comparedDone.series.time[0]).toBe(0)
    const completed = comparedDone.series.completed
    expect(completed[completed.length - 1]).toBe(8)
    expect(comparedDone.summary.completed).toBe(8)
  })

  it('records a background comparison no finer than a quarter of a second', () => {
    const done = lastMessage(deliver(backgroundRun(0))) as DoneMessage
    const times = Array.from(done.series.time)
    const gaps = times.slice(1).map((time, i) => time - times[i])

    // The floor is five times the one a watched run gets, because the series
    // is the whole product of a run nobody is looking at: asked for zero it
    // would record every physics step, and a saved comparison of a long run
    // would carry tens of thousands of points into the project file.
    expect(times.length).toBeGreaterThan(50)
    expect(times.length).toBeLessThan(times[times.length - 1] / 0.2)
    // Samples land on the 0.1 s step grid, so a quarter-second floor spaces
    // them two or three steps apart and never one. The instant a run ends on
    // is sampled whatever the floor says — it is the end of the curve, not a
    // point on the grid — and this crowd empties on one of the grid's own
    // instants, so every gap here is a spacing the floor chose.
    expect(Math.min(...gaps)).toBeGreaterThan(0.19)
    expect(Math.max(...gaps)).toBeLessThan(0.31)
  })
})
