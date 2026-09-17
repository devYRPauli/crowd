/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { LayersPanel } from './LayersPanel'
import { useEditor } from '../../state/editorStore'
import { createDocument } from '../../core/model/defaults'
import { DEFAULT_WALL_HEIGHT, DEFAULT_WALL_THICKNESS } from '../../core/model/standards'
import type { Backdrop, CrowdDocument, Plan, Wall } from '../../core/model/types'

const makeWall = (id: string, b: { x: number; y: number }): Wall => ({
  id,
  a: { x: 0, y: 0 },
  b,
  thickness: DEFAULT_WALL_THICKNESS,
  height: DEFAULT_WALL_HEIGHT,
  kind: 'wall',
})

const backdrop: Backdrop = {
  src: 'data:image/png;base64,iVBORw0KGgo=',
  position: { x: 0, y: 0 },
  rotation: 0,
  width: 20,
  depth: 14,
  opacity: 0.55,
  visible: true,
}

const plan: Partial<Plan> = {
  walls: [makeWall('wall-1', { x: 4, y: 0 }), makeWall('wall-2', { x: 0, y: 2.5 })],
  openings: [
    {
      id: 'door-1',
      wallId: 'wall-1',
      offset: 2,
      width: 0.914,
      height: 2.032,
      sill: 0,
      kind: 'door',
      locked: true,
    },
  ],
  zones: [
    {
      id: 'zone-out',
      kind: 'exit',
      name: 'Fire exit',
      polygon: [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 2 },
      ],
    },
  ],
  furniture: [{ id: 'furn-1', catalogId: 'table-round-6', position: { x: 1, y: 1 }, rotation: 0 }],
}

const openWith = (patch: Partial<Plan> = {}): CrowdDocument => {
  const base = createDocument('Test venue')
  const doc: CrowdDocument = { ...base, plan: { ...base.plan, ...patch } }
  useEditor.getState().replaceDocument(doc)
  return doc
}

const doc = () => useEditor.getState().document
const view = () => useEditor.getState().view

const row = (label: string): HTMLElement => {
  const node = screen.getByText(label).closest('.list-row')
  if (!node) throw new Error(`No list row is labelled ${label}`)
  return node as HTMLElement
}

beforeEach(() => {
  useEditor.setState({
    selection: [],
    hover: null,
    toasts: [],
    view: {
      theme: 'light',
      preset: 'iso',
      showGrid: true,
      showZones: true,
      showSeats: false,
      showQueues: true,
      showFurniture: true,
      showRoomLabels: true,
      showDimensions: true,
      wallCutHeight: null,
    },
  })
})

describe('what is shown', () => {
  it('hides furniture without touching the plan it is hiding', () => {
    openWith(plan)
    const before = doc()
    render(<LayersPanel />)

    fireEvent.click(screen.getByLabelText('Furniture'))

    expect(view().showFurniture).toBe(false)
    // What you can see is not part of the venue: turning furniture off must not
    // leave the project unsaved, and must not cost an undo step.
    expect(doc()).toBe(before)
    expect(useEditor.getState().dirty).toBe(false)
    expect(useEditor.getState().canUndo()).toBe(false)
  })

  it('treats the top of the wall-height slider as no cut at all', () => {
    openWith(plan)
    render(<LayersPanel />)

    const slider = screen.getByRole('slider')
    fireEvent.change(slider, { target: { value: '1.5' } })
    expect(view().wallCutHeight).toBe(1.5)
    expect(screen.getByText('1.50 m')).toBeDefined()

    fireEvent.change(screen.getByRole('slider'), { target: { value: '4' } })
    // Null, not 4: a cut at exactly the top of the range would still slice a
    // taller wall.
    expect(view().wallCutHeight).toBeNull()
    expect(screen.getByText('full height')).toBeDefined()
  })
})

describe('the object browser', () => {
  it('counts what is in the plan and measures each thing beside its name', () => {
    openWith(plan)
    render(<LayersPanel />)

    expect(screen.getByText('Walls (2)')).toBeDefined()
    expect(screen.getByText('Openings (1)')).toBeDefined()
    expect(screen.getByText('Areas (1)')).toBeDefined()
    expect(screen.getByText('Furniture (1)')).toBeDefined()
    // Nothing is a worse answer than an empty heading.
    expect(screen.queryByText('Service points (0)')).toBeNull()

    expect(screen.getByText('4.00 m')).toBeDefined()
    expect(screen.getByText('2.50 m')).toBeDefined()
    expect(screen.getByText('91 cm')).toBeDefined()
    expect(screen.getByText('Round table (6)')).toBeDefined()
    expect(screen.getByText('Exit')).toBeDefined()
  })

  it('selects one thing on a click and adds to the selection on a shift-click', () => {
    openWith(plan)
    render(<LayersPanel />)

    fireEvent.click(screen.getByText('Fire exit'))
    expect(useEditor.getState().selection).toEqual([{ kind: 'zone', id: 'zone-out' }])

    fireEvent.click(screen.getByText('Round table (6)'), { shiftKey: true })
    expect(useEditor.getState().selection).toEqual([
      { kind: 'zone', id: 'zone-out' },
      { kind: 'furniture', id: 'furn-1' },
    ])

    // A plain click starts again rather than growing the selection.
    fireEvent.click(screen.getByText('Fire exit'))
    expect(useEditor.getState().selection).toEqual([{ kind: 'zone', id: 'zone-out' }])
  })

  it('takes a row back out of the selection when it is shift-clicked again', () => {
    openWith(plan)
    render(<LayersPanel />)

    fireEvent.click(screen.getByText('Fire exit'), { shiftKey: true })
    fireEvent.click(screen.getByText('Round table (6)'), { shiftKey: true })
    expect(useEditor.getState().selection).toEqual([
      { kind: 'zone', id: 'zone-out' },
      { kind: 'furniture', id: 'furn-1' },
    ])

    fireEvent.click(screen.getByText('Fire exit'), { shiftKey: true })

    // Shift in this list means the same as shift in the 3D view — add or take
    // away — and nothing may end up in the selection twice: the inspector
    // counts what is in it, so a duplicate had it offering "Delete 2 objects"
    // over one area, with no way to click the extra copy back out.
    expect(useEditor.getState().selection).toEqual([{ kind: 'furniture', id: 'furn-1' }])
  })

  it('shows a padlock only against the things that carry one', () => {
    openWith(plan)
    render(<LayersPanel />)

    // A locked object can still be selected — this list is one of the two ways
    // to reach the inspector that unlocks it.
    expect(row('Door').querySelector('svg')).not.toBeNull()
    expect(row('Fire exit').querySelector('svg')).toBeNull()

    fireEvent.click(screen.getByText('Door'))
    expect(useEditor.getState().selection).toEqual([{ kind: 'opening', id: 'door-1' }])
  })
})

describe('a traced floor plan', () => {
  it('offers nothing about a reference image until there is one', () => {
    openWith(plan)
    const { unmount } = render(<LayersPanel />)
    expect(screen.queryByText('Traced plan')).toBeNull()
    expect(screen.queryByText('Remove the image')).toBeNull()

    // And the section is there the moment a plan carries one, so its absence is
    // about the document rather than about a collapsed panel.
    unmount()
    openWith({ ...plan, backdrop })
    render(<LayersPanel />)
    expect(screen.getByText('Traced plan')).toBeDefined()
  })

  it('hides and removes the image through the document, so both can be undone', () => {
    openWith({ ...plan, backdrop })
    render(<LayersPanel />)

    fireEvent.click(screen.getByLabelText('Show the reference image'))
    expect(doc().plan.backdrop?.visible).toBe(false)
    expect(useEditor.getState().undoLabel()).toBe('Toggle backdrop')

    fireEvent.click(screen.getByText('Remove the image'))
    expect(doc().plan.backdrop).toBeUndefined()

    useEditor.getState().undo()
    // Deleting a scan somebody scaled by hand has to be recoverable.
    expect(doc().plan.backdrop?.src).toBe(backdrop.src)
  })
})
