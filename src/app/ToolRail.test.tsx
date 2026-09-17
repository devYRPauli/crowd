/**
 * @vitest-environment jsdom
 */

/**
 * The tool strip.
 *
 * It is the only place the drawing tools are named to the user, and each name
 * comes with the key that selects it. The rail is therefore two claims at once:
 * that clicking it changes tool, and that the letter printed beside the tool is
 * the letter that works. Both are tested here, because a tooltip that lies
 * about a shortcut is worse than no tooltip.
 */

import { useRef } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ToolRail } from './ToolRail'
import { useKeyboard } from './useKeyboard'
import type { ViewportHandle } from './ViewportHost'
import { useEditor, type ToolId } from '../state/editorStore'

const editor = () => useEditor.getState()

beforeEach(() => {
  useEditor.setState({ tool: 'select', hint: null, selection: [], dirty: false })
})

/** The rail with the global keyboard map live behind it, as in the real app. */
const Shell = () => {
  const viewportRef = useRef<ViewportHandle>({ viewport: null, controller: null })
  useKeyboard({
    viewportRef,
    onToggleHeatmap: () => undefined,
    onShowShortcuts: () => undefined,
    overlayOpen: false,
  })
  return <ToolRail />
}

const RAIL: Array<{ label: string; tool: ToolId }> = [
  { label: 'Select and move', tool: 'select' },
  { label: 'Draw walls', tool: 'wall' },
  { label: 'Draw a room', tool: 'room' },
  { label: 'Add a doorway', tool: 'door' },
  { label: 'Add a window', tool: 'window' },
  { label: 'Place furniture', tool: 'furniture' },
  { label: 'Draw an area', tool: 'zone' },
  { label: 'Place a service point', tool: 'service' },
  { label: 'Reshape a queue', tool: 'queue' },
  { label: 'Tape measure', tool: 'measure' },
]

const button = (label: string): HTMLElement => screen.getByRole('button', { name: label })

describe('the tool rail', () => {
  it('offers every tool the editor has, and picks the one that was clicked', () => {
    render(<ToolRail />)
    expect(screen.getAllByRole('button')).toHaveLength(RAIL.length)

    for (const { label, tool } of RAIL) {
      fireEvent.click(button(label))
      expect(editor().tool).toBe(tool)
    }
  })

  it('shows one tool held down at a time, and follows a tool chosen elsewhere', () => {
    render(<ToolRail />)

    // The keyboard, the inspector and a tool that finishes its gesture all set
    // the tool without going near the rail; the rail reads the store, so it
    // cannot drift out of step with what the pointer is actually doing.
    act(() => useEditor.setState({ tool: 'door' }))
    expect(button('Add a doorway').getAttribute('aria-pressed')).toBe('true')
    expect(
      screen.getAllByRole('button').filter((el) => el.getAttribute('aria-pressed') === 'true'),
    ).toHaveLength(1)

    act(() => useEditor.setState({ tool: 'measure' }))
    expect(button('Add a doorway').getAttribute('aria-pressed')).toBe('false')
    expect(button('Tape measure').getAttribute('aria-pressed')).toBe('true')
  })

  it('advertises the key that really does select the tool', () => {
    render(<Shell />)

    for (const { label, tool } of RAIL) {
      const title = button(label).getAttribute('title') ?? ''
      // The tooltip is the tool's own name followed by exactly one upper-case
      // letter in brackets. A "(⇧W)" or a "(Ctrl D)" would be a promise the
      // keyboard map cannot keep: it binds bare letters and refuses shifted and
      // alted ones outright.
      const promised = /^(.+?)\s+\(([A-Z])\)$/.exec(title)
      expect(promised?.[1], `${label} has no shortcut in its tooltip`).toBe(label)
      const key = promised?.[2] ?? ''

      // Start somewhere else, so a tooltip that names the wrong key cannot pass
      // by leaving the tool where it already was.
      act(() => useEditor.setState({ tool: tool === 'select' ? 'wall' : 'select' }))
      fireEvent.keyDown(window.document.body, { key: key.toLowerCase() })
      expect(editor().tool, `${label} promises ${key}`).toBe(tool)
      expect(button(label).getAttribute('aria-pressed')).toBe('true')
    }
  })

  it('picks up a tool without touching the venue or losing what is selected', () => {
    render(<ToolRail />)
    const before = editor().document
    const steps = editor().history.past.length
    act(() => useEditor.setState({ selection: [{ kind: 'wall', id: 'wall-1' }] }))

    fireEvent.click(button('Draw walls'))
    fireEvent.click(button('Place furniture'))

    // Reaching for a tool is not an edit, so it must not appear in the undo
    // stack or mark the project unsaved — and the wall the user has selected
    // stays selected, because the inspector beside the rail is where its
    // thickness is about to be changed.
    expect(editor().document).toBe(before)
    expect(editor().history.past).toHaveLength(steps)
    expect(editor().dirty).toBe(false)
    expect(editor().selection).toEqual([{ kind: 'wall', id: 'wall-1' }])
  })

  it('clears the tool hint when the tool changes', () => {
    render(<ToolRail />)
    // The status strip belongs to the tool that wrote it. Carrying "click to
    // place the second point" over into the tape measure is a stale
    // instruction for a gesture that no longer exists.
    act(() => useEditor.setState({ tool: 'wall', hint: 'Click to start a wall.' }))
    fireEvent.click(button('Tape measure'))
    expect(editor().hint).toBeNull()
  })
})
