/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SettingsPanel } from './SettingsPanel'
import { useEditor } from '../../state/editorStore'
import { createDocument } from '../../core/model/defaults'
import { DEFAULT_WALL_HEIGHT, DEFAULT_WALL_THICKNESS } from '../../core/model/standards'
import type { CrowdDocument, Wall } from '../../core/model/types'

const drawnWall: Wall = {
  id: 'wall-1',
  a: { x: 0, y: 0 },
  b: { x: 4, y: 0 },
  thickness: DEFAULT_WALL_THICKNESS,
  height: DEFAULT_WALL_HEIGHT,
  kind: 'wall',
}

const openWith = (): CrowdDocument => {
  const base = createDocument('Test venue')
  const doc: CrowdDocument = { ...base, plan: { ...base.plan, walls: [drawnWall] } }
  useEditor.getState().replaceDocument(doc)
  return doc
}

const doc = () => useEditor.getState().document
const settings = () => doc().settings

const control = (label: RegExp): HTMLInputElement => {
  const field = screen.getByText(label).closest('.field')
  if (!field) throw new Error(`No field is labelled ${label}`)
  const element = field.querySelector('input')
  if (!element) throw new Error(`The field labelled ${label} has no control`)
  return element
}

const typeAndLeave = (label: RegExp, text: string) => {
  const input = control(label)
  fireEvent.change(input, { target: { value: text } })
  fireEvent.blur(input)
}

beforeEach(() => {
  useEditor.setState({ selection: [], hover: null, toasts: [] })
})

describe('units', () => {
  it('changes what lengths look like without changing what the plan holds', () => {
    openWith()
    render(<SettingsPanel />)

    expect(control(/^grid spacing$/i).value).toBe('50 cm')

    fireEvent.click(screen.getByText('Imperial'))

    // The plan is always stored in metres; half a metre is still half a metre.
    expect(settings().units).toBe('imperial')
    expect(settings().gridSize).toBe(0.5)
    expect(doc().plan.walls[0].height).toBe(DEFAULT_WALL_HEIGHT)
    expect(control(/^grid spacing$/i).value).toBe(`1' 7.7"`)

    // And a bare number now means feet, so the same keystrokes mean different
    // sizes in the two systems — which is the reason the box echoes what it
    // stored rather than what was typed.
    typeAndLeave(/^grid spacing$/i, '2')
    expect(settings().gridSize).toBeCloseTo(0.6096, 6)
    expect(control(/^grid spacing$/i).value).toBe(`2' 0"`)
  })

  it('puts a unit change in the undo history, because it is part of the document', () => {
    openWith()
    render(<SettingsPanel />)

    fireEvent.click(screen.getByText('Imperial'))
    expect(useEditor.getState().undoLabel()).toBe('Change units')

    useEditor.getState().undo()
    expect(settings().units).toBe('metric')
  })

  it('keeps the theme out of the document, because it belongs to the person not the venue', () => {
    openWith()
    const before = doc()
    render(<SettingsPanel />)

    fireEvent.click(screen.getByText('Dark'))

    expect(useEditor.getState().view.theme).toBe('dark')
    // A venue emailed to somebody must not arrive in the sender's theme, and
    // switching the lights must not mark the project unsaved.
    expect(doc()).toBe(before)
    expect(useEditor.getState().dirty).toBe(false)
  })
})

describe('snapping', () => {
  it('holds the grid spacing between sizes worth snapping to', () => {
    openWith()
    render(<SettingsPanel />)

    typeAndLeave(/^grid spacing$/i, '50 m')
    expect(settings().gridSize).toBe(10)

    // A 1 cm grid is finer than anything the editor can usefully snap to and
    // would draw a grid nobody can see through.
    typeAndLeave(/^grid spacing$/i, '1cm')
    expect(settings().gridSize).toBeCloseTo(0.05, 6)
  })

  it('reads an angle snap of zero as off rather than as a zero-degree step', () => {
    openWith()
    render(<SettingsPanel />)

    expect(screen.getByText('15°')).toBeDefined()

    fireEvent.change(screen.getByRole('slider'), { target: { value: '0' } })
    expect(settings().angleSnapDeg).toBe(0)
    expect(screen.getByText('off')).toBeDefined()
  })

  it('undoes each snapping switch on its own, though both carry the same label', () => {
    openWith()
    render(<SettingsPanel />)

    fireEvent.click(screen.getByLabelText('Snap to the grid'))
    expect(settings().snapToGrid).toBe(false)
    expect(settings().snapToObjects).toBe(true)

    fireEvent.click(screen.getByLabelText('Snap to walls and objects'))
    expect(settings().snapToObjects).toBe(false)

    // Both edits commit under "Change snapping". History only merges steps that
    // share a coalesce key, and neither passes one — if that ever changed,
    // turning object snapping off would silently take grid snapping back with it.
    expect(useEditor.getState().undoLabel()).toBe('Change snapping')
    useEditor.getState().undo()
    expect(settings().snapToObjects).toBe(true)
    expect(settings().snapToGrid).toBe(false)
    useEditor.getState().undo()
    expect(settings().snapToGrid).toBe(true)
  })
})

describe('new wall defaults', () => {
  it('changes what the next wall will be, and leaves the drawn ones alone', () => {
    openWith()
    render(<SettingsPanel />)

    typeAndLeave(/^height$/i, '3.6')

    expect(settings().defaultWallHeight).toBeCloseTo(3.6, 6)
    // Editing a default is not a retrospective edit of the venue.
    expect(doc().plan.walls[0].height).toBe(DEFAULT_WALL_HEIGHT)
  })
})

describe('tracing a floor plan', () => {
  it('stores a chosen image inside the project and says what to do with it next', async () => {
    openWith()
    const { container } = render(<SettingsPanel />)

    const picker = container.querySelector('input[type="file"]')
    if (!picker) throw new Error('No file input')
    const file = new File(['fake-png-bytes'], 'survey.png', { type: 'image/png' })
    fireEvent.change(picker, { target: { files: [file] } })

    await waitFor(() => expect(doc().plan.backdrop).toBeDefined())

    // The image goes into the document as a data URL, so a project that opens
    // on another machine still has the plan it was traced from.
    expect(doc().plan.backdrop?.src.startsWith('data:image/png;base64,')).toBe(true)
    expect(doc().plan.backdrop?.visible).toBe(true)
    expect(useEditor.getState().undoLabel()).toBe('Add reference image')
    expect(useEditor.getState().toasts.at(-1)?.tone).toBe('success')
  })
})
