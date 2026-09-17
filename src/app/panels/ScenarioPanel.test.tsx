/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ScenarioPanel } from './ScenarioPanel'
import { Simulation } from '../../sim/engine'
import { useEditor } from '../../state/editorStore'
import { createDocument } from '../../core/model/defaults'
import type { CrowdDocument, Plan, Population, ServicePoint, Zone } from '../../core/model/types'

const rectangle = (x: number, y: number): Zone['polygon'] => [
  { x, y },
  { x: x + 2, y },
  { x: x + 2, y: y + 2 },
  { x, y: y + 2 },
]

const entry: Zone = { id: 'zone-in', kind: 'entry', name: 'Main doors', polygon: rectangle(0, 0) }
const exit: Zone = { id: 'zone-out', kind: 'exit', name: 'Fire exit', polygon: rectangle(8, 0) }
const stand: Zone = {
  id: 'zone-stand',
  kind: 'waypoint',
  name: 'Merch stand',
  polygon: rectangle(4, 0),
}

const counter = (id: string, name: string): ServicePoint => ({
  id,
  name,
  position: { x: 0, y: 0 },
  rotation: 0,
  width: 2,
  depth: 0.7,
  servers: 2,
  serviceTime: { kind: 'lognormal', mean: 60, sd: 20 },
  queueSpacing: 0.6,
})

const openWith = (plan: Partial<Plan> = {}, populations?: Population[]): CrowdDocument => {
  const base = createDocument('Test venue')
  const doc: CrowdDocument = {
    ...base,
    plan: { ...base.plan, ...plan },
    scenario: populations ? { ...base.scenario, populations } : base.scenario,
  }
  useEditor.getState().replaceDocument(doc)
  return doc
}

const doc = () => useEditor.getState().document
const scenario = () => doc().scenario
const group = (index = 0) => scenario().populations[index]

const control = (label: RegExp): HTMLInputElement | HTMLSelectElement => {
  const field = screen.getByText(label).closest('.field')
  if (!field) throw new Error(`No field is labelled ${label}`)
  const element = field.querySelector('input, select')
  if (!element) throw new Error(`The field labelled ${label} has no control`)
  return element as HTMLInputElement | HTMLSelectElement
}

const typeAndLeave = (label: RegExp, text: string) => {
  const input = control(label)
  fireEvent.change(input, { target: { value: text } })
  fireEvent.blur(input)
}

beforeEach(() => {
  useEditor.setState({ selection: [], hover: null, toasts: [] })
})

describe('the numbers a run depends on', () => {
  it('leaves the headcount alone when what was typed is not a number', () => {
    openWith()
    render(<ScenarioPanel />)

    typeAndLeave(/^people$/i, '2.5.5')

    // A scenario carrying NaN people builds a crowd the engine cannot size.
    expect(group().count).toBe(120)
    expect(screen.getByText('120 people')).toBeDefined()
  })

  it('leaves the headcount alone when the box is emptied or filled with words', () => {
    openWith()
    render(<ScenarioPanel />)

    typeAndLeave(/^people$/i, 'a full house')

    expect(group().count).toBe(120)
    expect(screen.getByText('120 people')).toBeDefined()

    // The likelier path, and the one that used to empty the venue: select the
    // figure, hit Delete, click away. An empty box is somebody part-way through
    // typing, not a request to simulate nobody.
    typeAndLeave(/^people$/i, '500')
    expect(group().count).toBe(500)
    typeAndLeave(/^people$/i, '')
    expect(group().count).toBe(500)
    expect(control(/^people$/i).value).toBe('500')
  })

  it('holds the headcount inside the range the engine will build a crowd for', () => {
    openWith()
    render(<ScenarioPanel />)

    typeAndLeave(/^people$/i, '90000')
    expect(group().count).toBe(6000)

    typeAndLeave(/^people$/i, '-40')
    expect(group().count).toBe(0)
  })

  it('lifts a run too short to be worth running up to the shortest one that is', () => {
    openWith()
    render(<ScenarioPanel />)

    typeAndLeave(/^run length$/i, '5')

    // 30 s, not the 1800 it was: the figure is clamped rather than rejected, so
    // the box has to show what was actually stored or the next run is not the
    // one on screen.
    expect(scenario().durationS).toBe(30)
    expect(control(/^run length$/i).value).toBe('30')
  })

  it('keeps the seed a whole number, because the run is named by it', () => {
    openWith()
    render(<ScenarioPanel />)

    typeAndLeave(/^seed$/i, '2.7')

    // Same seed, same people: a seed that is not the integer it displays makes
    // "run it again with seed 3" reproduce something else.
    expect(scenario().seed).toBe(3)
  })
})

describe('groups of people', () => {
  it('will not let the last group be removed, and totals the ones there are', () => {
    openWith()
    render(<ScenarioPanel />)

    // There is nothing to simulate without a group, so the only one has no
    // remove button at all.
    expect(screen.queryByTitle('Remove this group')).toBeNull()

    fireEvent.click(screen.getByText('Add another group'))
    expect(scenario().populations).toHaveLength(2)
    expect(screen.getByText('240 people')).toBeDefined()

    const removers = screen.getAllByTitle('Remove this group')
    expect(removers).toHaveLength(2)
    fireEvent.click(removers[1])
    expect(scenario().populations).toHaveLength(1)
    expect(screen.queryByTitle('Remove this group')).toBeNull()
  })

  it('gives a new group its own identity rather than a copy of the first', () => {
    openWith()
    render(<ScenarioPanel />)

    fireEvent.click(screen.getByText('Add another group'))

    const [first, second] = scenario().populations
    expect(second.id).not.toBe(first.id)
    expect(second.color).not.toBe(first.color)
    expect(second.name).toBe('Group 2')
    // Every group needs a way out or nobody in it ever finishes.
    expect(second.itinerary.map((step) => step.kind)).toEqual(['exit'])
  })

  it('records which doors a group comes in through', () => {
    openWith({ zones: [entry, exit] })
    render(<ScenarioPanel />)

    fireEvent.click(screen.getByLabelText('Main doors'))
    expect(group().entryIds).toEqual(['zone-in'])

    fireEvent.click(screen.getByLabelText('Main doors'))
    expect(group().entryIds).toEqual([])
  })

  it('says there is nowhere to come in, rather than offering the way out', () => {
    openWith({ zones: [exit] })
    render(<ScenarioPanel />)

    expect(screen.getByText('Draw an entry area to choose one.')).toBeDefined()
    // People appearing at the fire exit would walk the venue backwards and every
    // journey time would be measured along the wrong route.
    expect(screen.queryByLabelText('Fire exit')).toBeNull()
    expect(group().entryIds).toEqual([])
  })

  it('drops the arrival window when everybody arrives at once', () => {
    openWith()
    render(<ScenarioPanel />)

    expect(control(/^over$/i).value).toBe('600')

    fireEvent.change(screen.getByDisplayValue('Evenly spread'), {
      target: { value: 'all-at-once' },
    })

    // Asking when a single instant starts and how long it lasts is noise.
    expect(group().arrival.kind).toBe('all-at-once')
    expect(screen.queryByText(/^over$/i)).toBeNull()
    expect(screen.queryByText(/^starting at$/i)).toBeNull()
  })
})

describe('the itinerary', () => {
  it('keeps the way out at the end when a step is added in front of it', () => {
    openWith({ zones: [entry, exit, stand] })
    render(<ScenarioPanel />)

    expect(group().itinerary.map((step) => step.kind)).toEqual(['exit'])

    fireEvent.click(screen.getByTitle('Add a step'))

    // A step added after the exit would never be reached: people leave on it.
    expect(group().itinerary.map((step) => step.kind)).toEqual(['goto', 'exit'])
    expect(group().itinerary[0].targetId).toBe('zone-stand')
  })

  it('offers only destinations that exist in the plan, and says so when none do', () => {
    openWith({ zones: [entry] })
    render(<ScenarioPanel />)

    // The one step is an exit step and nothing on the plan is an exit.
    expect(screen.getByText(/nothing in the plan can be a leave by target yet/i)).toBeDefined()

    fireEvent.change(screen.getByDisplayValue('Leave by'), { target: { value: 'goto' } })
    expect(screen.getByText(/nothing in the plan can be a go to target yet/i)).toBeDefined()
  })

  it('lets one queueing step name several counters so parallel desks share the line', () => {
    openWith({
      zones: [entry, exit],
      servicePoints: [counter('svc-1', 'Bar'), counter('svc-2', 'Kiosk')],
    })
    render(<ScenarioPanel />)

    fireEvent.change(screen.getByDisplayValue('Leave by'), { target: { value: 'service' } })

    // The list arrives with nothing ticked: a counter ticked on the planner's
    // behalf would be added to whichever desk they then tick, so "queue at the
    // kiosk" would come out as both desks sharing the line.
    expect((screen.getByLabelText('Bar') as HTMLInputElement).checked).toBe(false)

    fireEvent.click(screen.getByLabelText('Bar'))
    fireEvent.click(screen.getByLabelText('Kiosk'))

    const step = group().itinerary[0]
    expect(step.targetIds).toEqual(['svc-1', 'svc-2'])
    // `targetId` is the single-target shape the engine falls back to, so it has
    // to stay in step with the list rather than pointing at a counter nobody
    // ticked.
    expect(step.targetId).toBe('svc-1')
  })

  it('holds the destination it shows when a step is changed to another kind', () => {
    openWith({ zones: [entry, exit, stand], servicePoints: [counter('svc-1', 'Bar')] })
    render(<ScenarioPanel />)

    fireEvent.change(screen.getByDisplayValue('Leave by'), { target: { value: 'service' } })

    // The old target means nothing to the new kind, so it goes — but a step
    // reading "Queue at → Bar" while the document names no counter is skipped
    // outright by the engine, and the results then show a bar nobody visited
    // with nothing on screen to say why.
    expect(screen.getByDisplayValue('Bar')).toBeDefined()
    expect(group().itinerary[0].kind).toBe('service')
    expect(group().itinerary[0].targetId).toBe('svc-1')

    // Every kind goes the same way, so it is not something about counters.
    fireEvent.change(screen.getByDisplayValue('Queue at'), { target: { value: 'goto' } })
    expect(screen.getByDisplayValue('Merch stand')).toBeDefined()
    expect(group().itinerary[0].targetId).toBe('zone-stand')
  })

  it('lets a queueing step be left pointing at no counter at all', () => {
    openWith({
      zones: [entry, exit],
      servicePoints: [counter('svc-1', 'Bar'), counter('svc-2', 'Kiosk')],
    })
    render(<ScenarioPanel />)

    fireEvent.change(screen.getByDisplayValue('Leave by'), { target: { value: 'service' } })
    fireEvent.click(screen.getByLabelText('Bar'))
    fireEvent.click(screen.getByLabelText('Bar'))

    // Unticking the last counter leaves a step headed "Queue at" that the
    // engine steps straight past, and that is allowed on purpose: the empty
    // list is on screen, so the panel is not showing a counter it has not
    // stored. Refusing the last untick would mean one counter nobody can clear,
    // and it would fight the gesture used to swap one desk for another —
    // clearing the list before ticking the desks actually wanted.
    expect(group().itinerary[0].targetIds).toEqual([])
    expect(group().itinerary[0].targetId).toBeUndefined()
    expect(screen.getByText('Queue at')).toBeDefined()
    expect((screen.getByLabelText('Bar') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText('Kiosk') as HTMLInputElement).checked).toBe(false)
  })

  it('removes the step the user asked to remove, not the one beside it', () => {
    openWith({ zones: [entry, exit, stand] })
    render(<ScenarioPanel />)

    fireEvent.click(screen.getByTitle('Add a step'))
    const added = group().itinerary[0].id

    fireEvent.click(screen.getAllByTitle('Remove this step')[0])

    expect(group().itinerary.map((step) => step.kind)).toEqual(['exit'])
    expect(group().itinerary.some((step) => step.id === added)).toBe(false)
  })
})

describe('the evacuation', () => {
  it('puts the alarm inside the run when it is switched on, and clears it again', () => {
    openWith()
    render(<ScenarioPanel />)

    fireEvent.click(screen.getByLabelText(/evacuate partway through/i))

    // 60% of a 30-minute run, so people are in the venue when it sounds.
    expect(scenario().evacuationAtS).toBe(1080)
    expect(scenario().durationS).toBe(1800)

    fireEvent.click(screen.getByLabelText(/evacuate partway through/i))
    expect(scenario().evacuationAtS).toBeNull()
  })

  it('takes an alarm set for after the run ends, and the run says it never sounded', () => {
    openWith({ zones: [entry, exit] })
    render(<ScenarioPanel />)

    fireEvent.click(screen.getByLabelText(/evacuate partway through/i))
    typeAndLeave(/^alarm at$/i, '9000')

    // The field is deliberately not capped at the run length: planners set the
    // drill time first and stretch the run to fit it, and a box that silently
    // rewrote 9000 to 1800 would be the same lie in the other direction. The
    // honesty belongs in the results, where a run that ended before the alarm
    // must not come back looking like a clean evacuation.
    expect(scenario().evacuationAtS).toBe(9000)
    expect(scenario().durationS).toBe(1800)
    expect(control(/^alarm at$/i).value).toBe('9000')

    const warnings = () => new Simulation(doc().plan, scenario()).summary().warnings
    expect(warnings()).toContain(
      'The evacuation is set for 9000 s but the run ends at 1800 s, so the alarm never sounds.',
    )

    // Brought back inside the run, the drill happens and the warning goes.
    typeAndLeave(/^alarm at$/i, '600')
    expect(warnings().join(' ')).not.toMatch(/never sounds/)
  })
})
