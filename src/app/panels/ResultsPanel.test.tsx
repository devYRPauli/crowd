/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ResultsPanel } from './ResultsPanel'
import { useEditor } from '../../state/editorStore'
import { useSimulation, type SeriesData } from '../../state/simulationStore'
import { createDocument } from '../../core/model/defaults'
import { addWall, updateOpening } from '../../core/document/mutations'
import { DEFAULT_WALL_HEIGHT, DEFAULT_WALL_THICKNESS } from '../../core/model/standards'
import type { CrowdDocument, Opening, Plan, ServicePoint, Wall, Zone } from '../../core/model/types'
import type { RunSummary, ServiceSummary } from '../../sim/types'

const series = (): SeriesData => ({
  time: Float32Array.from([0, 60, 120, 180, 240]),
  active: Float32Array.from([0, 50, 120, 60, 5]),
  completed: Float32Array.from([0, 5, 40, 120, 195]),
  meanSpeed: Float32Array.from([1.34, 1.2, 0.9, 1.1, 1.3]),
  peakDensity: Float32Array.from([0.5, 1.2, 2.0, 1.4, 0.6]),
  queueTotal: Float32Array.from([0, 10, 25, 12, 0]),
})

const bar: ServiceSummary = {
  id: 'svc-1',
  name: 'Bar',
  servers: 2,
  served: 88,
  meanWait: 240,
  maxWait: 520,
  meanService: 55,
  utilisation: 0.8,
  maxQueue: 26,
  unserved: 12,
}

const summary = (patch: Partial<RunSummary> = {}): RunSummary => ({
  durationS: 1800,
  seed: 1,
  totalPeople: 200,
  completed: 195,
  meanJourney: 240,
  p95Journey: 400,
  meanWait: 60,
  maxWait: 520,
  meanQueueTime: 90,
  clearanceTime: 300,
  walkableArea: 180,
  peakOccupancy: 120,
  peakDensity: 2,
  losShare: { A: 0.5, B: 0.3, C: 0.2 },
  services: [bar],
  areas: [],
  warnings: [],
  ...patch,
})

const wall: Wall = {
  id: 'wall-1',
  a: { x: 0, y: 0 },
  b: { x: 6, y: 0 },
  thickness: DEFAULT_WALL_THICKNESS,
  height: DEFAULT_WALL_HEIGHT,
  kind: 'wall',
}

/** A 6'0" pair, which is the commercial entry the standards catalogue names. */
const pair: Opening = {
  id: 'door-1',
  wallId: 'wall-1',
  offset: 3,
  width: 1.829,
  height: 2.032,
  sill: 0,
  kind: 'double-door',
  use: 'exit',
}

/** The counter the run reports on, as it stands in the plan the click leads back to. */
const counterInPlan: ServicePoint = {
  id: 'svc-1',
  name: 'Bar',
  position: { x: 2, y: 2 },
  rotation: 0,
  width: 2,
  depth: 0.7,
  servers: 2,
  serviceTime: { kind: 'lognormal', mean: 55, sd: 18 },
  queueSpacing: 0.6,
}

const exitZone: Zone = {
  id: 'zone-out',
  kind: 'exit',
  name: 'Fire exit',
  polygon: [
    { x: 5, y: 1 },
    { x: 7, y: 1 },
    { x: 7, y: 3 },
    { x: 5, y: 3 },
  ],
}

const openWith = (plan: Partial<Plan> = {}, count = 600): CrowdDocument => {
  const base = createDocument('Atrium')
  const doc: CrowdDocument = {
    ...base,
    plan: { ...base.plan, ...plan },
    scenario: {
      ...base.scenario,
      populations: base.scenario.populations.map((population) => ({ ...population, count })),
    },
  }
  useEditor.getState().replaceDocument(doc)
  return doc
}

const show = () => {
  const onHeatmapFacility = vi.fn()
  const onExportImage = vi.fn()
  const view = render(
    <ResultsPanel
      heatmapFacility="walkway"
      onHeatmapFacility={onHeatmapFacility}
      onExportImage={onExportImage}
    />,
  )
  return { ...view, onHeatmapFacility, onExportImage }
}

/** The headline figure a `Stat` tile is showing, looked up by its caption. */
const statValue = (container: HTMLElement, label: string): string | null => {
  for (const stat of Array.from(container.querySelectorAll('.stat'))) {
    if (stat.querySelector('.label')?.textContent === label) {
      return stat.querySelector('.value')?.textContent ?? null
    }
  }
  return null
}

/** The "vs baseline" line under a tile, and how the panel has coloured it. */
const statDelta = (
  container: HTMLElement,
  label: string,
): { text: string; className: string } | null => {
  for (const stat of Array.from(container.querySelectorAll('.stat'))) {
    if (stat.querySelector('.label')?.textContent !== label) continue
    const delta = stat.querySelector('.delta')
    return delta ? { text: delta.textContent ?? '', className: delta.className } : null
  }
  return null
}

/** A run that has just finished over the plan currently in the editor. */
const finished = (patch: Partial<RunSummary> = {}) =>
  useSimulation.setState({
    phase: 'done',
    summary: summary(patch),
    series: series(),
    totalPeople: 200,
    progress: 1,
    // `run` keeps the document it was handed, and the panel reads it to tell
    // whether the plan on screen is still the one these numbers came from.
    runDocument: useEditor.getState().document,
  })

beforeEach(() => {
  useEditor.setState({ selection: [], hover: null, toasts: [] })
  useSimulation.setState({
    phase: 'idle',
    runId: null,
    progress: 0,
    frame: null,
    grid: null,
    summary: null,
    series: null,
    warnings: [],
    error: null,
    totalPeople: 0,
    savedRuns: [],
    comparisonId: null,
    runDocument: null,
  })
})

describe('before there is anything to report', () => {
  it('invites a run rather than showing an empty table of zeros', () => {
    openWith()
    show()

    expect(screen.getByText(/no results yet/i)).toBeDefined()
    // Fabricated figures are worse than none: nothing numeric may appear.
    expect(screen.queryByText('Mean journey')).toBeNull()
    expect(screen.queryByText('Save as baseline')).toBeNull()
  })

  it('says a run is under way instead of showing the last one', () => {
    openWith()
    useSimulation.setState({ phase: 'running' })
    const { container } = show()

    expect(screen.getByText(/results appear when it finishes/i)).toBeDefined()
    // Half a run is not a result. Nothing may be read off the panel until the
    // summary arrives, so there are no tiles to read a figure from.
    expect(container.querySelectorAll('.stat')).toHaveLength(0)
    expect(screen.queryByText('Save as baseline')).toBeNull()
  })
})

describe('what the run found', () => {
  it('leads with the worst thing that happened and points at the counter it happened to', () => {
    openWith({ servicePoints: [counterInPlan] })
    finished()
    const { container } = show()

    const headlines = Array.from(container.querySelectorAll('.headline')).map(
      (node) => node.textContent,
    )
    expect(headlines[0]).toBe('Bar never cleared its queue')
    expect(screen.getByText(/12 people were still waiting/i)).toBeDefined()

    fireEvent.click(screen.getByText('Bar never cleared its queue'))
    // The finding is only useful if it takes you to the thing to change.
    expect(useEditor.getState().selection).toEqual([{ kind: 'service', id: 'svc-1' }])
  })

  it('reports the figures the run measured, including the people it could not finish', () => {
    openWith()
    finished()
    const { container } = show()

    // 195 of 200 finished, so five are still in the venue and the panel says so
    // rather than rounding the run up to a clean sweep.
    expect(statValue(container, 'Completed')).toBe('195/200')
    expect(statValue(container, 'Mean journey')).toBe('4 min')
    expect(statValue(container, '95th percentile')).toBe('6 min 40 s')
    expect(statValue(container, 'Peak density')).toBe('2.0/m²')

    // The counter's row has to line up with the headings above it — served,
    // mean wait, busy — because every one of those is a number somebody acts on
    // and they are indistinguishable once they are in the wrong column.
    const row = screen.getByText('Bar').closest('tr')
    expect(Array.from(row?.querySelectorAll('td') ?? [], (cell) => cell.textContent)).toEqual([
      'Bar',
      '88',
      '4 min',
      '80%',
    ])
  })

  it('offers the measurement areas as something to draw when there are none', () => {
    openWith()
    finished()
    show()

    expect(screen.getByText(/draw a measurement area/i)).toBeDefined()
    expect(screen.queryByText('Measured areas')).toBeNull()
  })
})

describe('comparing against a saved run', () => {
  const baseline = summary({
    completed: 130,
    meanJourney: 200,
    p95Journey: 500,
    meanWait: 120,
    peakDensity: 2.2,
    clearanceTime: 400,
  })

  it('names the run it is comparing against and says which way each figure moved', () => {
    const venue = openWith()
    finished()
    useSimulation.setState({
      savedRuns: [
        {
          id: 'saved-1',
          label: 'Two doors',
          at: '2026-01-01T00:00:00.000Z',
          summary: baseline,
          series: series(),
          document: venue,
        },
      ],
    })
    show()

    fireEvent.click(screen.getByText('Two doors'))

    expect(screen.getByText('vs Two doors')).toBeDefined()
    // More people finishing is better; a longer journey is not, and the panel
    // has to say which is which rather than just showing a sign.
    expect(screen.getByText('+50% vs baseline').className).toBe('delta is-better')
    expect(screen.getByText('+20% vs baseline').className).toBe('delta is-worse')
    // And the sign on its own settles nothing: clearing in 300 s against 400 is
    // -25% and it is the good direction, while +20% on the journey time is not.
    expect(screen.getByText('-25% vs baseline').className).toBe('delta is-better')

    fireEvent.click(screen.getByText('Two doors'))
    expect(screen.queryByText('vs Two doors')).toBeNull()
  })

  it('will not turn a baseline where nobody finished into a percentage', () => {
    const venue = openWith()
    finished()
    useSimulation.setState({
      savedRuns: [
        {
          id: 'saved-1',
          label: 'One door',
          at: '2026-01-01T00:00:00.000Z',
          summary: summary({ completed: 0, meanJourney: 0, peakDensity: 2.2 }),
          series: series(),
          document: venue,
        },
      ],
      comparisonId: 'saved-1',
    })
    const { container } = show()

    // A gridlocked baseline is exactly the run somebody saves before widening a
    // door, and "+Infinity%" or "+NaN%" against it would be the headline of the
    // comparison. An em dash says there is nothing to divide by.
    expect(statDelta(container, 'Completed')).toEqual({ text: '—', className: 'delta is-same' })
    expect(statDelta(container, 'Mean journey')).toEqual({ text: '—', className: 'delta is-same' })
    // The run's own figures are untouched by a baseline it cannot compare to.
    expect(statValue(container, 'Completed')).toBe('195/200')
    expect(statDelta(container, 'Peak density')).toEqual({
      text: '-9% vs baseline',
      className: 'delta is-better',
    })
  })

  it('takes the comparison off the panel when the run it pointed at is forgotten', () => {
    const venue = openWith()
    finished()
    useSimulation.setState({
      savedRuns: [
        {
          id: 'saved-1',
          label: 'Two doors',
          at: '2026-01-01T00:00:00.000Z',
          summary: baseline,
          series: series(),
          document: venue,
        },
      ],
      comparisonId: 'saved-1',
    })
    show()

    expect(screen.getByText('vs Two doors')).toBeDefined()
    fireEvent.click(screen.getByTitle('Forget this run'))

    // A baseline id left pointing at nothing silently strips every delta.
    expect(useSimulation.getState().comparisonId).toBeNull()
    expect(screen.queryByText('vs Two doors')).toBeNull()
    expect(screen.queryByText('+50% vs baseline')).toBeNull()
  })
})

describe('results and the plan they came from', () => {
  it('keeps the run on screen when the plan is edited, and says the plan has moved under it', () => {
    openWith({ walls: [wall], openings: [pair] }, 600)
    finished()
    const { container } = show()
    expect(statValue(container, 'Completed')).toBe('195/200')
    // 1.829 m of doorway at the Green Guide rate over the default 8 minutes.
    expect(screen.getByText('1199')).toBeDefined()
    expect(screen.queryByText('The plan has changed since this run')).toBeNull()

    // Widen the only way out. Nothing about the run on screen was measured
    // through this door any more.
    act(() =>
      useEditor
        .getState()
        .apply((doc) => updateOpening(doc, 'door-1', { width: 3.658 }), 'Set width'),
    )

    // Decided, having been flagged as a bug: an edit does not throw the run
    // away. The panel is read while the change it argues for is being drawn —
    // widening this door is what the findings asked for — and a run is minutes
    // of nav grid and simulation to get back, with no undo for having cleared
    // it. What is not defensible is saying nothing: the code check below
    // recomputes from the live plan on every render, so the two halves of the
    // panel are answering for different venues the moment anything is moved.
    // The notice is what makes that readable; clearing the run instead would
    // cost the planner the numbers they are acting on.
    expect(screen.getByText('The plan has changed since this run')).toBeDefined()
    expect(statValue(container, 'Completed')).toBe('195/200')
    expect(statValue(container, '95% cleared by')).toBe('5 min')
    expect(screen.getByText('2399')).toBeDefined()
    expect(screen.queryByText('1199')).toBeNull()

    // And running again over the plan as it now stands settles it: the two sets
    // of figures describe one venue, so the notice goes.
    act(() => finished())
    expect(screen.queryByText('The plan has changed since this run')).toBeNull()
  })

  it('saves a baseline against the venue that was run, not the one being drawn now', () => {
    const ran = openWith()
    finished()
    show()

    act(() => useEditor.getState().apply((doc) => addWall(doc, wall), 'Draw wall'))
    fireEvent.click(screen.getByText('Save as baseline'))

    const saved = useSimulation.getState().savedRuns[0]
    expect(saved.summary.completed).toBe(195)
    // A baseline is saved after reading the results, which is to say after the
    // first change has already been tried. The document beside the numbers is
    // what a later comparison explains itself with, so it has to be the plan
    // these 195 journeys were walked through — a wall that went up afterwards
    // would have the baseline describing a venue nobody ever simulated.
    expect(saved.document).toBe(ran)
    expect(saved.document.plan.walls).toHaveLength(0)
    expect(useEditor.getState().document.plan.walls).toHaveLength(1)
  })
})

describe('the code check', () => {
  it('says the figures are model-code indicative every time it shows one', () => {
    openWith({ walls: [wall], openings: [pair] })
    const first = show()

    // It is a hand calculation offered as a cross-check, so it is there before
    // any run — and the disclaimer is what makes that offer honest.
    expect(screen.getByText('Occupant load (IBC)')).toBeDefined()
    expect(screen.getByText(/model-code indicative only/i).textContent).toContain(
      'approval rests with the authority having jurisdiction',
    )

    first.unmount()
    finished()
    show()

    // A run appearing above it must not push the disclaimer off: that is the
    // moment the two sets of figures are most likely to be read as one.
    expect(screen.getByText(/model-code indicative only/i)).toBeDefined()
    expect(screen.getByText('Occupant load (IBC)')).toBeDefined()
  })

  it('counts the exit areas the plan marks, not the doors marked as ways out', () => {
    openWith({ walls: [wall], openings: [pair] }, 600)
    const first = show()

    // The pair is marked `use: 'exit'` in the inspector and still counts for
    // nothing here: `computeCompliance` counts exit *zones*, because only a zone
    // says where "out" is — a door marked "Way out" could open onto another
    // room. The message's "marked on the plan" means something narrower than the
    // inspector's wording does, and a planner who has marked their doors reads
    // zero exits with no clue what it wants.
    expect(pair.use).toBe('exit')
    expect(screen.getByText('600')).toBeDefined()
    expect(
      screen.getByText('3 exits are required for 600 occupants; 0 are marked on the plan.'),
    ).toBeDefined()

    first.unmount()
    openWith({ walls: [wall], openings: [pair], zones: [exitZone] }, 600)
    show()

    expect(
      screen.getByText('3 exits are required for 600 occupants; 1 is marked on the plan.'),
    ).toBeDefined()
  })

  it('recomputes the evacuation capacity from the plan as the target time is changed', () => {
    openWith({ walls: [wall], openings: [pair], zones: [exitZone] }, 600)
    show()

    // Green Guide: 1.829 m of doorway at 82 people per metre per minute.
    expect(screen.getByText('1199')).toBeDefined()

    const minutes = screen.getByText('Egress target').closest('.field')?.querySelector('input')
    if (!minutes) throw new Error('No egress target field')
    fireEvent.change(minutes, { target: { value: '2' } })
    fireEvent.blur(minutes)

    expect(screen.getByText('299')).toBeDefined()
    expect(screen.queryByText('1199')).toBeNull()
  })
})
