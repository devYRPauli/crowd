/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ScenarioPanel } from './ScenarioPanel'
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

  it('reads a headcount of words, or an emptied box, as nobody at all', () => {
    openWith()
    render(<ScenarioPanel />)

    typeAndLeave(/^people$/i, 'a full house')

    // SUSPECTED BUG: `NumberInput.commit` (src/app/components/ui.tsx:53) strips
    // everything but digits and signs, and `Number('')` is 0 — so text it cannot
    // read is silently replaced by zero rather than refused. The run then
    // finishes instantly with nobody in the venue and reports that as a result,
    // against the project's own rule that a parser which cannot read something
    // says what it lost instead of handing back a default. Note that "2.5.5"
    // above *is* refused, because it survives the strip as NaN — so which
    // mistakes are caught is decided by what the regex happens to leave behind.
    // I believe an unreadable draft should be discarded the way "2.5.5" is,
    // leaving the previous count on screen.
    expect(group().count).toBe(0)
    expect(screen.getByText('0 people')).toBeDefined()

    // The same path, and the likelier one: selecting the box and hitting Delete
    // before typing the new figure, then clicking away.
    typeAndLeave(/^people$/i, '500')
    expect(group().count).toBe(500)
    typeAndLeave(/^people$/i, '')
    expect(group().count).toBe(0)
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
    fireEvent.click(screen.getByLabelText('Bar'))
    fireEvent.click(screen.getByLabelText('Kiosk'))

    const step = group().itinerary[0]
    expect(step.targetIds).toEqual(['svc-1', 'svc-2'])
    // `targetId` is the single-target shape the engine falls back to, so it has
    // to stay in step with the list rather than pointing at a counter nobody
    // ticked.
    expect(step.targetId).toBe('svc-1')
  })

  it('shows a destination on a step that names none, as soon as the kind is changed', () => {
    openWith({ zones: [entry, exit, stand], servicePoints: [counter('svc-1', 'Bar')] })
    render(<ScenarioPanel />)

    fireEvent.change(screen.getByDisplayValue('Leave by'), { target: { value: 'service' } })

    // SUSPECTED BUG: changing a step's kind clears its target
    // (`patchStep(step.id, { kind, targetId: undefined, targetIds: undefined })`,
    // src/app/panels/ScenarioPanel.tsx:126), and the target `<Select>` below then
    // falls back to *displaying* `targets[0]` without ever committing it
    // (ScenarioPanel.tsx:181). The panel therefore reads "Queue at → Bar" while
    // the document holds no target at all, and `Simulation.beginStep`
    // (src/sim/engine.ts:644) finds no queue for it and steps straight past: the
    // bar the whole scenario was built around is skipped, and the results show a
    // desk nobody visited. Nothing on screen distinguishes this from a step that
    // was set on purpose — the fix is to open the select and re-pick the option
    // already showing. I believe changing the kind should commit the first valid
    // target, exactly as the "Add a step" button already does.
    expect(screen.getByDisplayValue('Bar')).toBeDefined()
    expect(group().itinerary[0].kind).toBe('service')
    expect(group().itinerary[0].targetId).toBeUndefined()
    expect(group().itinerary[0].targetIds).toBeUndefined()

    // Re-picking the option that was already on screen is what makes it real.
    fireEvent.change(screen.getByDisplayValue('Bar'), { target: { value: 'svc-1' } })
    expect(group().itinerary[0].targetId).toBe('svc-1')

    // Every kind goes the same way, so it is not something about counters.
    fireEvent.change(screen.getByDisplayValue('Queue at'), { target: { value: 'goto' } })
    expect(screen.getByDisplayValue('Merch stand')).toBeDefined()
    expect(group().itinerary[0].targetId).toBeUndefined()
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

    // The same silent skip reached the other way: with more than one counter the
    // step becomes a list of tickboxes, and unticking the last one leaves it
    // numbered and headed "Queue at" with nothing behind it. Here at least the
    // empty list is on screen, which is why the select above is the worse half.
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

  it('accepts an alarm set for after the run has ended', () => {
    openWith()
    render(<ScenarioPanel />)

    fireEvent.click(screen.getByLabelText(/evacuate partway through/i))
    typeAndLeave(/^alarm at$/i, '9000')

    // SUSPECTED BUG: the run is 1800 s long, so an alarm at 9000 s never fires —
    // `applyEvacuation` (src/sim/engine.ts:1180) returns while `this.time < at`
    // and the run simply ends first. The box takes it because `min` is 0 and
    // there is no `max`, the tickbox still reads as on, and the hint below still
    // promises that everyone drops what they are doing. The engine's
    // "Evacuation triggered at N s" warning is pushed only when the alarm
    // actually fires, so the results carry no trace either: a planner reads a
    // clean evacuation for a drill that never happened, which is the one thing
    // the project says results may never do. I believe the field should be
    // capped at the run length, or the panel should say the alarm falls outside
    // the run.
    expect(scenario().evacuationAtS).toBe(9000)
    expect(scenario().durationS).toBe(1800)
    expect(control(/^alarm at$/i).value).toBe('9000')
    expect(screen.getByLabelText(/evacuate partway through/i)).toHaveProperty('checked', true)
    expect(screen.queryByText(/outside the run|after the run|never fires/i)).toBeNull()
  })
})
