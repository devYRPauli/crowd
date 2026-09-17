/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { LibraryPanel } from './LibraryPanel'
import { useEditor } from '../../state/editorStore'
import { createDocument } from '../../core/model/defaults'
import { CATALOG } from '../../library/catalog'
import {
  DEFAULT_DOOR_WIDTH,
  DEFAULT_DOUBLE_DOOR_WIDTH,
  DOOR_WIDTHS,
  DOUBLE_DOOR_FROM,
  isStandard,
} from '../../core/model/standards'
import type { ToolId } from '../../state/editorStore'

const openWith = (tool: ToolId) => {
  useEditor.getState().replaceDocument(createDocument('Test venue'))
  useEditor.getState().setTool(tool)
}

const options = () => useEditor.getState().toolOptions

const control = (label: RegExp): HTMLInputElement | HTMLSelectElement => {
  const field = screen.getByText(label).closest('.field')
  if (!field) throw new Error(`No field is labelled ${label}`)
  const element = field.querySelector('input, select')
  if (!element) throw new Error(`The field labelled ${label} has no control`)
  return element as HTMLInputElement | HTMLSelectElement
}

beforeEach(() => {
  useEditor.setState({
    selection: [],
    hover: null,
    toasts: [],
    toolOptions: {
      ...useEditor.getState().toolOptions,
      catalogId: 'table-round-6',
      doorWidth: DEFAULT_DOOR_WIDTH,
      wallThickness: 0.165,
      wallHeight: 2.743,
      zoneKind: 'entry',
      wallKind: 'wall',
    },
  })
})

describe('the furniture catalog', () => {
  it('arms the furniture tool with the item that was picked', () => {
    openWith('select')
    const { container } = render(<LibraryPanel />)

    // The badge is the library's own count and the grid is what can actually be
    // reached; an entry the browser quietly drops is one nobody can place.
    expect(screen.getByText(`${CATALOG.length} items`)).toBeDefined()
    expect(container.querySelectorAll('.catalog-item')).toHaveLength(CATALOG.length)

    fireEvent.click(screen.getByText('Stacking chair'))

    // Picking something in the library is how people start placing it; leaving
    // the select tool active would swallow the next click.
    expect(options().catalogId).toBe('chair-stacking')
    expect(useEditor.getState().tool).toBe('furniture')
    // And the panel keeps saying what is in hand, because the plan gives no
    // other clue before the first click.
    expect(screen.getByText(/click in the plan to place/i).textContent).toContain('Stacking chair')
  })

  it('searches by what a room is called, not only by the item name', () => {
    openWith('select')
    render(<LibraryPanel />)

    const search = screen.getByLabelText('Search the furniture catalog')
    fireEvent.change(search, { target: { value: 'wedding' } })

    // "wedding" appears nowhere in the item's name; it is a keyword, which is
    // how somebody laying out a reception actually looks for the table.
    expect(screen.getByText('Banquet round (8)')).toBeDefined()
    expect(screen.queryByText('Round table (6)')).toBeNull()
    expect(screen.queryByText('Stacking chair')).toBeNull()
  })

  it('says what to try instead when a search matches nothing', () => {
    openWith('select')
    render(<LibraryPanel />)

    fireEvent.change(screen.getByLabelText('Search the furniture catalog'), {
      target: { value: 'helicopter' },
    })

    expect(screen.getByText(/nothing matches/i)).toBeDefined()
    expect(screen.getByText(/try a room name/i)).toBeDefined()
  })

  it('narrows to one category and back again', () => {
    openWith('select')
    render(<LibraryPanel />)

    fireEvent.click(screen.getByText('Seating'))
    expect(screen.getByText('Stacking chair')).toBeDefined()
    expect(screen.queryByText('Round table (6)')).toBeNull()

    fireEvent.click(screen.getByText('All'))
    expect(screen.getByText('Round table (6)')).toBeDefined()
  })
})

describe('the options of the tool in hand', () => {
  it('shows the wall settings instead of the catalog while a wall is being drawn', () => {
    openWith('wall')
    render(<LibraryPanel />)

    expect(screen.queryByLabelText('Search the furniture catalog')).toBeNull()
    expect(screen.getByText('Browse furniture')).toBeDefined()

    const thickness = control(/^thickness$/i)
    fireEvent.change(thickness, { target: { value: '5 m' } })
    fireEvent.blur(thickness)

    // Two metres of wall is already a vault; beyond that it is a typing slip.
    expect(options().wallThickness).toBe(2)

    fireEvent.click(screen.getByText('Browse furniture'))
    expect(useEditor.getState().tool).toBe('furniture')
  })

  it('places a door at a width a supplier actually lists', () => {
    openWith('door')
    render(<LibraryPanel />)

    fireEvent.click(screen.getByText('Double'))

    // These buttons used to write 0.9 m and 1.8 m literals while the catalogue
    // the rest of the editor draws on calls a single leaf 0.914 m (3'0") and a
    // pair 1.829 m (6'0"). Every door placed with the tool came out 14 mm
    // narrow, the inspector flagged it as "not a stock size" the moment it was
    // selected, and the egress width it contributed was short of the leaf
    // somebody would order. A dimension literal belongs in standards.ts.
    expect(options().doorWidth).toBe(DEFAULT_DOUBLE_DOOR_WIDTH)
    expect(isStandard(DOOR_WIDTHS, options().doorWidth)).toBe(true)

    fireEvent.click(screen.getByText('Single'))
    expect(options().doorWidth).toBe(DEFAULT_DOOR_WIDTH)
    expect(isStandard(DOOR_WIDTHS, options().doorWidth)).toBe(true)
  })

  it('only calls an opening a pair at a width the plan will draw as one', () => {
    openWith('door')
    render(<LibraryPanel />)

    const width = control(/^width$/i)
    fireEvent.change(width, { target: { value: '1.51' } })
    fireEvent.blur(width)

    // The toggle used to decide it was showing a pair from 1.5 m while the tool
    // that places the opening splits it into two leaves only from
    // `DOUBLE_DOOR_FROM` (1.524 m, the smallest pair anybody hangs). Between
    // the two the panel said "Double" and the plan got a single leaf — wider
    // than the 4'0" maximum a single egress leaf is allowed, so a door that
    // could not be hung. Both read the same constant now.
    expect(options().doorWidth).toBeCloseTo(1.51, 6)
    expect(options().doorWidth).toBeLessThan(DOUBLE_DOOR_FROM)
    expect(screen.getByText('Single').className).toBe('is-active')

    // And at the threshold itself it is a pair, in the panel and in the plan.
    fireEvent.change(width, { target: { value: String(DOUBLE_DOOR_FROM) } })
    fireEvent.blur(width)
    expect(screen.getByText('Double').className).toBe('is-active')
  })

  it('explains what each kind of area does as it is chosen', () => {
    openWith('zone')
    render(<LibraryPanel />)

    expect(screen.getByText(/people appear inside an entry area/i)).toBeDefined()

    fireEvent.click(screen.getByText('Keep clear'))
    expect(options().zoneKind).toBe('keep-clear')
    // A keep-clear area is not a wall, and the difference is the whole reason
    // the kind exists.
    expect(
      screen.getByText(/routing avoids a keep-clear area without treating it as a wall/i),
    ).toBeDefined()
  })
})
