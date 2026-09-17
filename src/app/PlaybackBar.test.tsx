/**
 * @vitest-environment jsdom
 */

/**
 * The transport.
 *
 * The playback bar is the only control surface for a run, so it has to show
 * exactly the state the simulation store is in and ask it only for transitions
 * it will accept. A button that offers a transition the store refuses is worse
 * than a missing button: the user presses it and concludes the product is
 * broken.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { PlaybackBar } from './PlaybackBar'
import { useEditor } from '../state/editorStore'
import { useSimulation, type Frame, type SeriesData } from '../state/simulationStore'
import { createHistory } from '../core/document/history'
import { createDocument, createPopulation } from '../core/model/defaults'
import { PlanBuilder } from '../library/planBuilder'
import { AGENT_STRIDE } from '../sim/types'
import type { SimStats } from '../sim/types'
import type { CrowdDocument } from '../core/model/types'
import type { ReadyMessage, StartRequest, WorkerRequest, WorkerResponse } from '../worker/protocol'

/**
 * No real worker. A run that actually simulated would race every assertion,
 * and what is under test is the conversation between the bar and the store.
 */
const posted: WorkerRequest[] = []

class StubWorker {
  static current: StubWorker | null = null
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null

  constructor() {
    StubWorker.current = this
  }

  postMessage(request: WorkerRequest): void {
    posted.push(request)
  }

  terminate(): void {}
}
vi.stubGlobal('Worker', StubWorker)

const venue = (): CrowdDocument => {
  const b = new PlanBuilder()
  b.room(0, 0, 12, 8)
  const base = createDocument('Riverside Hall')
  return {
    ...base,
    plan: b.build(),
    scenario: {
      ...base.scenario,
      durationS: 900,
      populations: [
        { ...createPopulation(0), count: 80 },
        { ...createPopulation(1), count: 45 },
      ],
    },
  }
}

const stats = (patch: Partial<SimStats> = {}): SimStats => ({
  time: 0,
  spawned: 0,
  active: 0,
  completed: 0,
  meanDensity: 0.4,
  peakDensity: 1.4,
  meanSpeed: 1.1,
  meanWalkingSpeed: 1.176,
  walking: 0,
  stoppedShare: 0,
  meanWait: 0,
  maxWait: 0,
  queueLengths: [],
  worstLos: 'E',
  ...patch,
})

const frameAt = (time: number, patch: Partial<SimStats> = {}): Frame => ({
  time,
  count: 2,
  agents: new Float32Array(2 * AGENT_STRIDE),
  density: new Float32Array(4),
  stats: stats({ time, ...patch }),
})

/** A recorded run: how many people were inside at each reading. */
const seriesOf = (time: number[], active: number[]): SeriesData => ({
  time: new Float32Array(time),
  active: new Float32Array(active),
  completed: new Float32Array(active.length),
  meanSpeed: new Float32Array(active.length),
  peakDensity: new Float32Array(active.length),
  queueTotal: new Float32Array(active.length),
})

const sim = () => useSimulation.getState()
const starts = (): StartRequest[] =>
  posted.filter((request): request is StartRequest => request.type === 'start')

/** Reply the way the worker does once the navigation grid is built. */
const workerIsReady = (): void => {
  const message: ReadyMessage = {
    type: 'ready',
    runId: sim().runId ?? '',
    grid: { originX: 0, originY: 0, cellSize: 0.2, cols: 2, rows: 2 },
    walkableArea: 96,
    warnings: [],
    totalPeople: 125,
  }
  act(() => {
    StubWorker.current?.onmessage?.({ data: message } as MessageEvent<WorkerResponse>)
  })
}

let hall = venue()

beforeEach(() => {
  posted.length = 0
  hall = venue()
  useEditor.setState({ history: createHistory(hall), document: hall, toasts: [] })
  useSimulation.setState({
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
  })
})

const primary = (): HTMLElement => screen.getByRole('button', { name: /Run|Pause|Resume/ })

describe('starting and stopping a run', () => {
  it('runs the venue on screen, at the speed the transport is showing', () => {
    render(<PlaybackBar />)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))

    expect(sim().phase).toBe('preparing')
    expect(starts()).toHaveLength(1)
    // The plan and the scenario go over by reference to the document in the
    // editor, not a copy made when the bar mounted: pressing Run must simulate
    // the venue as it is now.
    expect(starts()[0].plan).toBe(hall.plan)
    expect(starts()[0].scenario).toBe(hall.scenario)
    expect(starts()[0].speed).toBe(4)
    expect(sim().runLabel).toBe('Riverside Hall')
  })

  it('offers pause and stop only once there is a run to pause or stop', () => {
    render(<PlaybackBar />)
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    workerIsReady()
    expect(sim().phase).toBe('running')
    expect(primary()).toHaveProperty('textContent', 'Pause')

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(sim().phase).toBe('idle')
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Run' })).toBeDefined()
  })

  it('pauses and resumes the same run rather than starting another', () => {
    render(<PlaybackBar />)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    workerIsReady()
    const runId = sim().runId

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(sim().phase).toBe('paused')
    expect(posted.at(-1)).toEqual({ type: 'pause', runId })

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(sim().phase).toBe('running')
    expect(posted.at(-1)).toEqual({ type: 'resume', runId })
    // One run from start to finish; a resume that restarted would throw away
    // everything already simulated and silently change the answer.
    expect(starts()).toHaveLength(1)
    expect(sim().runId).toBe(runId)
  })

  it('offers nothing to press on the primary while the navigation grid is built', () => {
    render(<PlaybackBar />)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(sim().phase).toBe('preparing')
    const runId = sim().runId

    // The store refuses resume in any phase but 'paused', so a live play button
    // here would take the press and do nothing for as long as the grid takes —
    // seconds on a large venue — and read as a product that has hung.
    expect(primary()).toHaveProperty('disabled', true)
    fireEvent.click(primary())
    expect(posted.some((request) => request.type === 'resume')).toBe(false)
    expect(sim().phase).toBe('preparing')

    // The ring says something is happening, and Stop is what cancels it.
    expect(screen.getByLabelText('Preparing')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(sim().phase).toBe('idle')
    expect(posted.at(-1)).toEqual({ type: 'stop', runId })
  })

  it('invites another run once the last one finished', () => {
    render(<PlaybackBar />)
    act(() => useSimulation.setState({ phase: 'done', progress: 1 }))
    // "Run" again on a finished run reads as though nothing happened; "Run
    // again" says the previous answer is about to be replaced.
    expect(screen.getByRole('button', { name: 'Run again' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Run again' }))
    expect(sim().phase).toBe('preparing')
  })

  it('empties the readout when the run is stopped', () => {
    const { container } = render(<PlaybackBar />)
    act(() =>
      useSimulation.setState({
        phase: 'running',
        runId: 'run-live',
        progress: 0.5,
        frame: frameAt(185, { active: 12, completed: 34 }),
      }),
    )
    expect(container.querySelector('.clock')?.textContent).toBe('3:05')

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))

    // Stopping takes the findings with the crowd, so a stale "12 inside" left
    // beside an empty floor cannot be read against the next plan.
    expect(container.querySelector('.clock')?.textContent).toBe('0:00')
    expect(container.querySelector('.live-stats')?.textContent).toContain('0 inside')
    expect(container.querySelector('.timeline-fill')?.getAttribute('style')).toBe('width: 0%;')
  })
})

describe('the live readout', () => {
  it('reports the frame on screen, in the language of the decision', () => {
    const { container } = render(<PlaybackBar />)
    act(() =>
      useSimulation.setState({
        phase: 'running',
        runId: 'run-live',
        progress: 0.25,
        frame: frameAt(185, { active: 12, completed: 34, peakDensity: 1.4 }),
      }),
    )

    expect(container.querySelector('.clock')?.textContent).toBe('3:05')
    const live = container.querySelector('.live-stats')?.textContent ?? ''
    expect(live).toContain('12 inside')
    expect(live).toContain('34 left')
    // Mean *walking* speed, rounded the way the rest of the product rounds it.
    expect(live).toContain('1.18 m/s')
    // 1.4 persons/m² is Fruin walkway E — shuffling, at capacity. The band has
    // to come from the measured peak, not from the summary's worst-so-far.
    expect(live).toContain('LOS')
    expect(screen.getByText('E')).toBeDefined()
  })

  it('says how many people and how long before anybody has pressed Run', () => {
    const { container } = render(<PlaybackBar />)
    // Two populations, 80 and 45. The header adds them up so the scale of the
    // run is legible before it starts.
    expect(container.querySelector('.timeline-meta')?.textContent).toContain('125 people')
    expect(container.querySelector('.timeline-meta')?.textContent).toContain('15:00')
    expect(container.querySelector('.clock')?.textContent).toBe('0:00')
    // Nothing has been measured, so there is no level of service to report. A
    // band shown before a run would be a number the product did not measure.
    expect(container.querySelector('.live-stats')?.textContent).not.toContain('LOS')
  })

  it('draws how the crowd built up once there is more than a couple of readings', () => {
    const { container } = render(<PlaybackBar />)
    act(() =>
      useSimulation.setState({
        phase: 'running',
        runId: 'run-live',
        series: seriesOf([0, 12], [0, 40]),
      }),
    )
    // Two readings is a straight line between two points; it says nothing about
    // the shape of the arrival and is not worth the space beside the track.
    expect(container.querySelector('.timeline-spark')).toBeNull()

    act(() => useSimulation.setState({ series: seriesOf([0, 12, 24, 36], [0, 40, 96, 61]) }))

    const chart = screen.getByRole('img', { name: 'People inside' })
    // The peak the chart is scaled to is 96 people inside — the series the bar
    // hands over is how many are *in* the venue over time, not how many have
    // left and not the density, either of which would draw a different curve
    // under the same label.
    expect(chart.textContent).toBe('96.0')
    expect(container.querySelector('.timeline-track')?.contains(chart)).toBe(true)
  })

  it('never lets the progress bar run past its own track', () => {
    const { container } = render(<PlaybackBar />)
    act(() => useSimulation.setState({ phase: 'running', runId: 'run-live', progress: 0.4 }))
    expect(container.querySelector('.timeline-fill')?.getAttribute('style')).toBe('width: 40%;')

    // An evacuation that overruns its scheduled duration reports a progress
    // above one; the head must stop at the end of the track, not leave it.
    act(() => useSimulation.setState({ progress: 1.4 }))
    expect(container.querySelector('.timeline-fill')?.getAttribute('style')).toBe('width: 100%;')
    expect(container.querySelector('.timeline-head')?.getAttribute('style')).toBe('left: 100%;')
  })
})

describe('playback speed', () => {
  it('marks the speed in force and changes it on a click', () => {
    render(<PlaybackBar />)
    const speeds = screen.getByRole('group', { name: 'Playback speed' })
    const button = (label: string) => screen.getByRole('button', { name: label })

    expect(button('4×').className).toContain('is-active')
    expect(speeds.querySelectorAll('.is-active')).toHaveLength(1)

    fireEvent.click(button('16×'))
    expect(sim().speed).toBe(16)
    expect(button('16×').className).toContain('is-active')
    expect(button('4×').className).not.toContain('is-active')
  })

  it('takes the new speed to a run already in flight', () => {
    render(<PlaybackBar />)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    workerIsReady()
    const runId = sim().runId

    fireEvent.click(screen.getByRole('button', { name: '60×' }))
    // Changing speed mid-run must reach the worker, or the bar and the crowd
    // disagree about how fast time is passing.
    expect(posted.at(-1)).toEqual({ type: 'speed', runId, speed: 60 })

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    // The choice is the user's, not the run's: it survives the run it was made
    // during and is what the next Run starts at.
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(starts().at(-1)?.speed).toBe(60)
  })
})
