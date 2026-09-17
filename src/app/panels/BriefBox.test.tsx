/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { BriefBox } from './BriefBox'
import { useEditor } from '../../state/editorStore'
import { createDocument } from '../../core/model/defaults'
import { BRIEF_EXAMPLES } from '../../core/analysis/brief'
import type { CrowdDocument, ServicePoint } from '../../core/model/types'

const bar: ServicePoint = {
  id: 'svc-1',
  name: 'Bar',
  position: { x: 0, y: 0 },
  rotation: 0,
  width: 2,
  depth: 0.7,
  servers: 1,
  serviceTime: { kind: 'lognormal', mean: 30, sd: 10 },
  queueSpacing: 0.6,
}

const openWith = (): CrowdDocument => {
  const base = createDocument('Test venue')
  const doc: CrowdDocument = { ...base, plan: { ...base.plan, servicePoints: [bar] } }
  useEditor.getState().replaceDocument(doc)
  return doc
}

const doc = () => useEditor.getState().document
const group = () => doc().scenario.populations[0]
const counter = () => doc().plan.servicePoints[0]

const write = (text: string) =>
  fireEvent.change(screen.getByLabelText('Describe the event in plain words'), {
    target: { value: text },
  })

/** What the parser says it understood, as the list shows it. */
const readings = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll('.list-row .label')).map((node) => node.textContent ?? '')

beforeEach(() => {
  useEditor.setState({ selection: [], hover: null, toasts: [] })
})

describe('reading a brief', () => {
  it('lists every reading beside the words it came from, and changes nothing yet', () => {
    openWith()
    const before = doc()
    const { container } = render(<BriefBox />)

    write('200 guests arriving over 45 minutes, three staff on the bar, a minute each')

    expect(readings(container)).toEqual([
      '200 people — “200 guests”',
      'Arrivals spread over 45 minutes — “arriving over 45 minutes”',
      '3 staff on Bar — “three staff”',
      '60 seconds to serve each person — “a minute each”',
    ])
    // Nothing is applied until the user says so: a parser that edits the plan
    // as you type is one you cannot check before you trust it.
    expect(doc()).toBe(before)
    expect(group().count).toBe(120)
  })

  it('applies the whole reading as one change and empties the box', () => {
    openWith()
    render(<BriefBox />)

    write('200 guests arriving over 45 minutes, three staff on the bar, a minute each')
    fireEvent.click(screen.getByText('Apply 4 changes'))

    expect(group().count).toBe(200)
    expect(group().arrival.windowS).toBe(2700)
    expect(group().arrival.startS).toBe(0)
    expect(counter().servers).toBe(3)
    expect(counter().serviceTime.mean).toBe(60)

    // Four settings, one sentence, one step back.
    expect(useEditor.getState().undoLabel()).toBe('Apply brief')
    useEditor.getState().undo()
    expect(group().count).toBe(120)
    expect(counter().servers).toBe(1)

    expect(
      (screen.getByLabelText('Describe the event in plain words') as HTMLTextAreaElement).value,
    ).toBe('')
    expect(useEditor.getState().toasts.at(-1)?.message).toBe('Applied 4 changes from the brief.')
  })

  it('drops a reading the user does not want and applies only the rest', () => {
    openWith()
    const { container } = render(<BriefBox />)

    write('200 guests arriving over 45 minutes, three staff on the bar, a minute each')

    const skips = screen.getAllByTitle('Ignore this reading')
    expect(skips).toHaveLength(4)
    fireEvent.click(skips[0])

    expect(readings(container).some((line) => line.startsWith('200 people'))).toBe(false)
    fireEvent.click(screen.getByText('Apply 3 changes'))

    // The headcount was skipped, so it must be exactly as it was.
    expect(group().count).toBe(120)
    expect(group().arrival.windowS).toBe(2700)
    expect(counter().servers).toBe(3)
  })

  it('names the part of the sentence it could not read instead of ignoring it', () => {
    openWith()
    const { container } = render(<BriefBox />)

    write('200 guests and a 20 minute queue at the cloakroom')

    expect(readings(container)).toEqual(['200 people — “200 guests”'])
    expect(screen.getByText(/Not understood: “a 20 minute queue at the cloakroom”/)).toBeDefined()
  })

  it('offers an example when it recognised nothing at all', () => {
    openWith()
    render(<BriefBox />)

    write('it will be quite busy I think')

    expect(screen.getByText(/nothing recognised yet/i)).toBeDefined()
    expect(screen.queryByText(/^Apply/)).toBeNull()
  })

  it('says nothing while the box is empty', () => {
    openWith()
    render(<BriefBox />)

    expect(screen.queryByText(/nothing recognised yet/i)).toBeNull()
    expect(screen.queryByText(/not understood/i)).toBeNull()
    // The placeholder carries a worked example instead, so the box is never a
    // blank field with no clue what goes in it — and it is one of the shipped
    // examples rather than improvised text, because the parser is only promised
    // to read those shapes.
    const box = screen.getByLabelText('Describe the event in plain words')
    expect(BRIEF_EXAMPLES).toContain(box.getAttribute('placeholder'))
  })

  it('reads every example it offers as a placeholder', () => {
    openWith()
    render(<BriefBox />)

    // Which example a document shows is chosen by its id, so all five have to
    // work. An example the parser cannot read is worse than no example: it is
    // the one sentence a new user is invited to copy.
    for (const example of BRIEF_EXAMPLES) {
      write(example)
      expect(screen.queryByText(/nothing recognised yet/i)).toBeNull()
      expect(screen.getByText(/^Apply \d+ changes?$/)).toBeDefined()
    }
  })
})
