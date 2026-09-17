/**
 * @vitest-environment jsdom
 */

/**
 * The global keyboard map.
 *
 * Every shortcut in the product is bound in one listener on `window`, which
 * makes this the one place a key can be stolen from somewhere it belongs — from
 * a tool mid-gesture, from a dialog, or from a number field somebody is part
 * way through typing a door width into. Most of what follows is about who does
 * *not* get the keystroke.
 */

import { useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useKeyboard } from './useKeyboard'
import type { ViewportHandle } from './ViewportHost'
import { useEditor, type ToolId } from '../state/editorStore'
import { useSimulation } from '../state/simulationStore'
import { createHistory } from '../core/document/history'
import { createDocument } from '../core/model/defaults'
import { renameDocument } from '../core/document/mutations'
import { PlanBuilder } from '../library/planBuilder'
import { planBounds } from '../core/model/planGeometry'
import { documentFileName, serializeDocument } from '../core/document/serialize'
import { downloadText, saveProject } from '../core/document/storage'
import type * as Storage from '../core/document/storage'
import type { CrowdDocument, PlanObjectRef } from '../core/model/types'

// Saving reaches IndexedDB and a download anchor, neither of which exists here
// and neither of which is what these tests are about: what matters is that the
// chord reaches them at all, with the document the user is looking at.
vi.mock('../core/document/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof Storage>()
  return { ...actual, downloadText: vi.fn(), saveProject: vi.fn(() => Promise.resolve()) }
})

/** No real worker: the space bar is under test, not the simulation. */
class StubWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}
vi.stubGlobal('Worker', StubWorker)

/** A hall with four walls, a door, a table, a fire exit and a bar. */
const venue = () => {
  const b = new PlanBuilder()
  const room = b.room(0, 0, 10, 8)
  const door = b.door(room.south, 5)
  const table = b.place('table-round-6', 3, 3)
  const exit = b.zone('exit', 8, 0.2, 9.8, 1.2, 'Fire exit')
  const bar = b.service('Bar', 2, 7, -Math.PI / 2, 2, { kind: 'normal' as const, mean: 40, sd: 8 })
  const base = createDocument('Riverside Hall')
  const document: CrowdDocument = { ...base, plan: b.build() }
  return { document, room, door, table, exit, bar }
}

const editor = () => useEditor.getState()
const sim = () => useSimulation.getState()
const refTo = (kind: PlanObjectRef['kind'], id: string): PlanObjectRef => ({ kind, id })

const defaults = useEditor.getInitialState()
let hall = venue()

beforeEach(() => {
  vi.clearAllMocks()
  hall = venue()
  useEditor.setState({
    history: createHistory(hall.document),
    document: hall.document,
    selection: [],
    hover: null,
    tool: defaults.tool,
    toolOptions: { ...defaults.toolOptions },
    view: { ...defaults.view },
    panel: defaults.panel,
    toasts: [],
    hint: null,
    dirty: false,
  })
  useSimulation.setState({
    phase: 'idle',
    runId: null,
    progress: 0,
    frame: null,
    summary: null,
    series: null,
    warnings: [],
    error: null,
    speed: 4,
    totalPeople: 0,
  })
})

interface Chord {
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}

/** A keystroke on the page itself, the way one arrives when nothing is focused. */
const press = (key: string, chord: Chord = {}): void => {
  fireEvent.keyDown(window.document.body, { key, ...chord })
}

/** False when the editor swallowed the key, so the browser never sees it. */
const reachedTheBrowser = (key: string, chord: Chord = {}): boolean =>
  fireEvent.keyDown(window.document.body, { key, ...chord })

const mount = (options: { overlayOpen?: boolean; toolConsumes?: boolean } = {}) => {
  const frame = vi.fn()
  const handleKeyDown = vi.fn(() => options.toolConsumes ?? false)
  const onToggleHeatmap = vi.fn()
  const onShowShortcuts = vi.fn()

  const Harness = () => {
    const viewportRef = useRef<ViewportHandle>({
      viewport: { frame } as unknown as ViewportHandle['viewport'],
      controller: { handleKeyDown } as unknown as ViewportHandle['controller'],
    })
    useKeyboard({
      viewportRef,
      onToggleHeatmap,
      onShowShortcuts,
      overlayOpen: options.overlayOpen ?? false,
    })
    return (
      <>
        <input aria-label="Door width" defaultValue="0.9" />
        <textarea aria-label="Notes" />
        <select aria-label="Units">
          <option value="metric">Metres</option>
        </select>
        <button type="button">Somewhere that is not a field</button>
      </>
    )
  }

  render(<Harness />)
  return { frame, handleKeyDown, onToggleHeatmap, onShowShortcuts }
}

const TOOL_KEYS: Array<[string, ToolId]> = [
  ['v', 'select'],
  ['w', 'wall'],
  ['r', 'room'],
  ['d', 'door'],
  ['n', 'window'],
  ['f', 'furniture'],
  ['z', 'zone'],
  ['s', 'service'],
  ['q', 'queue'],
  ['m', 'measure'],
]

describe('choosing a tool from the keyboard', () => {
  it('puts every drawing tool one key away', () => {
    mount()
    for (const [key, tool] of TOOL_KEYS) {
      editor().setTool(tool === 'select' ? 'wall' : 'select')
      press(key)
      expect(editor().tool).toBe(tool)
    }

    // Caps Lock reports an upper-case key with no shift held. Somebody who
    // left it on still has to be able to draw.
    editor().setTool('select')
    press('W')
    expect(editor().tool).toBe('wall')
  })

  it('leaves shifted and alted letters to the tools that use them', () => {
    mount()
    editor().setTool('measure')

    // Shift constrains a drag to an axis and Alt duplicates while dragging, so
    // neither may double as "switch tool" underneath the user's hand.
    press('W', { shiftKey: true })
    press('w', { altKey: true })
    expect(editor().tool).toBe('measure')
  })
})

describe('keys that belong to somebody else', () => {
  it('leaves the keyboard alone while a dimension is being typed', () => {
    mount()
    editor().setTool('wall')
    editor().setSelection([refTo('furniture', hall.table.id)])
    const before = editor().document

    for (const label of ['Door width', 'Notes', 'Units']) {
      const field = screen.getByLabelText(label)
      field.focus()
      // "r" is the room tool, Delete removes the selection and ⌘Z is undo. A
      // width of 0.9 m is typed with none of that happening.
      for (const key of ['r', 'Delete', 'Backspace']) fireEvent.keyDown(field, { key })
      fireEvent.keyDown(field, { key: 'z', metaKey: true })
    }

    expect(editor().tool).toBe('wall')
    expect(editor().selection).toHaveLength(1)
    expect(editor().document).toBe(before)

    // And the same key pressed anywhere that is not a field does switch tool,
    // so the guard above is the reason nothing happened, not a dead listener.
    screen.getByRole('button').focus()
    press('r')
    expect(editor().tool).toBe('room')
  })

  it('leaves the keyboard alone inside an editable label too', () => {
    mount()
    editor().setTool('wall')

    // jsdom implements neither `contentEditable` nor `isContentEditable`, so
    // the property is put on the element by hand; the branch it guards is real
    // and a room label typed in place has to be able to contain an "r".
    const label = window.document.createElement('div')
    Object.defineProperty(label, 'isContentEditable', { value: true })
    window.document.body.appendChild(label)
    fireEvent.keyDown(label, { key: 'r' })
    label.remove()

    expect(editor().tool).toBe('wall')
  })

  it('hands the keyboard to a dialog for as long as one is open', () => {
    mount({ overlayOpen: true })
    editor().setSelection([refTo('furniture', hall.table.id)])

    press('r')
    press('Escape')
    press(' ')

    // Escape is the one that matters: the editor would clear the selection and
    // the dialog would never close.
    expect(editor().tool).toBe('select')
    expect(editor().selection).toHaveLength(1)
    expect(sim().phase).toBe('idle')
  })

  it('gives the tool mid-gesture first refusal on every key', () => {
    const { handleKeyDown } = mount({ toolConsumes: true })
    editor().setSelection([refTo('furniture', hall.table.id)])
    editor().apply((doc) => renameDocument(doc, 'Riverside Hall B'), 'Rename project')
    const edited = editor().document

    expect(reachedTheBrowser('Escape')).toBe(false)
    expect(reachedTheBrowser('r')).toBe(false)
    // The chords go through the tool first as well, so a tool that has claimed
    // ⌘Z to step back one point of a wall chain is not undone whole underneath
    // the user's hand.
    expect(reachedTheBrowser('z', { metaKey: true })).toBe(false)

    // A wall chain half drawn owns Escape and Enter; the editor must not clear
    // the selection, change tool, or roll the document back out from under it.
    expect(handleKeyDown).toHaveBeenCalledTimes(3)
    expect(editor().selection).toHaveLength(1)
    expect(editor().tool).toBe('select')
    expect(editor().document).toBe(edited)
  })

  it('lets the browser keep the chords it never claimed', () => {
    const { onToggleHeatmap } = mount()
    // ⌘P prints, ⌘W closes the tab and ⌘H hides the window. Swallowing any of
    // them — or worse, letting ⌘W fall through to the wall tool or ⌘H to the
    // heat map — is a shortcut the editor stole.
    expect(reachedTheBrowser('p', { metaKey: true })).toBe(true)
    expect(reachedTheBrowser('w', { metaKey: true })).toBe(true)
    expect(reachedTheBrowser('h', { metaKey: true })).toBe(true)
    expect(editor().tool).toBe('select')
    expect(onToggleHeatmap).not.toHaveBeenCalled()
  })
})

describe('editing from the keyboard', () => {
  it('reaches undo and redo by either platform convention', () => {
    mount()
    const before = editor().document
    editor().apply((doc) => renameDocument(doc, 'Riverside Hall B'), 'Rename project')
    const edited = editor().document

    press('z', { metaKey: true })
    expect(editor().document).toBe(before)
    press('z', { metaKey: true, shiftKey: true })
    expect(editor().document).toBe(edited)
    press('z', { ctrlKey: true })
    expect(editor().document).toBe(before)
    // ⌘Y is the Windows redo; without it a Windows user has no redo at all.
    press('y', { ctrlKey: true })
    expect(editor().document).toBe(edited)
  })

  it('selects everything that can be moved and leaves openings to their walls', () => {
    mount()
    press('a', { metaKey: true })

    const selection = editor().selection
    // Four walls, a table, a zone and the bar. The door is deliberately absent:
    // an opening has no position of its own, it rides at an offset along the
    // wall it is cut into, and deleting the wall takes it with it.
    expect(selection).toHaveLength(7)
    expect(selection.filter((ref) => ref.kind === 'wall')).toHaveLength(4)
    expect(selection.some((ref) => ref.kind === 'opening')).toBe(false)
  })

  it('deletes the selection on either delete key', () => {
    mount()
    editor().setSelection([refTo('furniture', hall.table.id)])
    press('Backspace')
    expect(editor().document.plan.furniture).toHaveLength(0)

    editor().setSelection([refTo('zone', hall.exit.id)])
    press('Delete')
    expect(editor().document.plan.zones).toHaveLength(0)
  })

  it('stands everything down on escape', () => {
    mount()
    editor().setTool('wall')
    editor().setSelection([refTo('furniture', hall.table.id)])

    press('Escape')

    expect(editor().selection).toHaveLength(0)
    expect(editor().tool).toBe('select')
  })
})

describe('the clipboard', () => {
  // This test has to stay the first in the file that presses ⌘V. The clipboard
  // is module-level in `useKeyboard.ts` — deliberately, so a copy survives
  // switching project — and nothing can empty it again, so this is the only
  // moment in the run at which "never copied anything" is the real state. A
  // reorder that put a copy before it fails here loudly rather than passing
  // for the wrong reason.
  it('leaves ⌘V to the browser until something has been copied', () => {
    mount()
    const before = editor().document

    // Otherwise the editor swallows the paste of the text, the image or the
    // file the user actually had on the system clipboard, and does nothing
    // with it.
    expect(reachedTheBrowser('v', { metaKey: true })).toBe(true)
    expect(editor().document).toBe(before)
    expect(editor().tool).toBe('select')
  })

  it('pastes clear of the original and steps further out each time', () => {
    mount()
    const grid = hall.document.settings.gridSize
    editor().setSelection([refTo('furniture', hall.table.id)])

    press('c', { metaKey: true })
    expect(editor().toasts.at(-1)?.message).toBe('Copied 1 object.')

    press('v', { metaKey: true })
    const first = editor().document.plan.furniture.at(-1)
    expect(first?.position.x).toBeCloseTo(hall.table.position.x + grid, 9)
    expect(first?.position.y).toBeCloseTo(hall.table.position.y + grid, 9)
    // The copy is selected, so the next drag moves it and not the original.
    expect(editor().selection).toEqual([refTo('furniture', first?.id ?? '')])

    press('v', { metaKey: true })
    const second = editor().document.plan.furniture.at(-1)
    // Landing a second copy on the first would look like nothing happened.
    expect(second?.position.x).toBeCloseTo(hall.table.position.x + 2 * grid, 9)
    expect(editor().document.plan.furniture).toHaveLength(3)
  })

  it('counts what it copied, in the plural when there is more than one', () => {
    mount()
    editor().setSelection([refTo('furniture', hall.table.id), refTo('zone', hall.exit.id)])
    press('c', { metaKey: true })
    expect(editor().toasts.at(-1)?.message).toBe('Copied 2 objects.')
  })

  it('cuts the objects away and keeps them for pasting back', () => {
    mount()
    editor().setSelection([refTo('service', hall.bar.id)])

    press('x', { metaKey: true })
    expect(editor().document.plan.servicePoints).toHaveLength(0)

    press('v', { metaKey: true })
    const pasted = editor().document.plan.servicePoints.at(-1)
    expect(pasted?.name).toBe('Bar copy')
    expect(pasted?.servers).toBe(hall.bar.servers)
  })

  it('duplicates without clobbering what was copied', () => {
    mount()
    editor().setSelection([refTo('furniture', hall.table.id)])
    press('c', { metaKey: true })

    editor().setSelection([refTo('service', hall.bar.id)])
    press('d', { metaKey: true })
    expect(editor().document.plan.servicePoints).toHaveLength(2)
    expect(editor().selection).toEqual([
      refTo('service', editor().document.plan.servicePoints[1].id),
    ])

    // A duplicate that quietly overwrote the clipboard would lose a copy the
    // user made minutes ago and is about to paste.
    press('v', { metaKey: true })
    expect(editor().document.plan.furniture).toHaveLength(2)
    expect(editor().document.plan.servicePoints).toHaveLength(2)
  })

  it('costs one undo step per paste, and undoes back past the copy', () => {
    mount()
    const original = editor().document
    editor().setSelection([refTo('furniture', hall.table.id)])
    press('c', { metaKey: true })
    press('v', { metaKey: true })
    press('v', { metaKey: true })

    // Each paste is a deliberate act, not a drag, so each is its own step.
    expect(editor().history.past).toHaveLength(2)
    press('z', { metaKey: true })
    press('z', { metaKey: true })
    expect(editor().document).toBe(original)
  })

  it('does nothing on copy, cut or duplicate with nothing selected', () => {
    mount()
    const before = editor().document

    expect(reachedTheBrowser('c', { metaKey: true })).toBe(true)
    expect(reachedTheBrowser('x', { metaKey: true })).toBe(true)
    expect(reachedTheBrowser('d', { metaKey: true })).toBe(true)

    expect(editor().document).toBe(before)
    expect(editor().toasts).toHaveLength(0)
    // ⌘D is bookmark-this-page and ⌘C is the browser's own copy; with nothing
    // selected the editor has no business taking either.
    expect(editor().tool).toBe('select')
  })
})

describe('the view and the run', () => {
  it('toggles between plan and 3D, and comes back to plan from any other view', () => {
    mount()
    expect(editor().view.preset).toBe('iso')

    press('Tab')
    expect(editor().view.preset).toBe('plan')
    press('Tab')
    expect(editor().view.preset).toBe('iso')

    editor().setView({ preset: 'eye' })
    press('Tab')
    expect(editor().view.preset).toBe('plan')

    // Tab is focus traversal everywhere else on the web. Taking it for the view
    // means also stopping it, or the camera swings and the focus ring walks off
    // into the panel behind at the same time.
    expect(reachedTheBrowser('Tab')).toBe(false)
  })

  it('fits the whole plan in view with a margin around it', () => {
    const { frame } = mount()
    press('.')
    // Three metres of margin, so the venue is not pressed against the edges.
    expect(frame).toHaveBeenCalledWith(planBounds(hall.document.plan, 3))
  })

  it('opens the shortcut sheet and toggles the heat map', () => {
    const { onShowShortcuts, onToggleHeatmap } = mount()

    // "?" never arrives without Shift held, and Caps Lock sends "H" without it,
    // so both have to work whatever the shift key is doing.
    press('?', { shiftKey: true })
    press('h')
    press('H')

    expect(onShowShortcuts).toHaveBeenCalledTimes(1)
    expect(onToggleHeatmap).toHaveBeenCalledTimes(2)
    // Neither letter belongs to a tool, so neither may leave the user drawing.
    expect(editor().tool).toBe('select')
  })

  it('drives the whole transport from the space bar', () => {
    mount()
    press(' ')
    expect(sim().phase).toBe('preparing')

    // The stub worker never answers, so the phase it would have moved the run
    // into when the navigation grid was ready is set by hand here.
    useSimulation.setState({ phase: 'running' })
    press(' ')
    expect(sim().phase).toBe('paused')
    press(' ')
    expect(sim().phase).toBe('running')

    // Shift is stop, and stopping takes the results with the crowd.
    press(' ', { shiftKey: true })
    expect(sim().phase).toBe('idle')
    expect(sim().runId).toBeNull()
  })

  it('runs the venue on screen, under its own name', () => {
    mount()
    editor().apply((doc) => renameDocument(doc, 'Riverside Hall B'), 'Rename project')
    press(' ')
    expect(sim().runLabel).toBe('Riverside Hall B')
  })

  it('lets the run it already started finish preparing when space is pressed again', () => {
    mount()
    press(' ')
    const first = sim().runId
    press(' ')

    // Building the navigation grid is seconds of work on a large venue. A
    // second press that started again would throw that away and begin the wait
    // over, so an impatient user could keep the run permanently a moment from
    // starting — and the transport offers no such button while it is preparing.
    expect(sim().runId).toBe(first)
    expect(sim().phase).toBe('preparing')

    // Shift is still how a prepare that is taking too long is called off.
    press(' ', { shiftKey: true })
    expect(sim().phase).toBe('idle')
    expect(sim().runId).toBeNull()
  })
})

describe('saving', () => {
  it('downloads and stores the project, and says so', () => {
    mount()
    press('s', { metaKey: true })

    const doc = editor().document
    expect(vi.mocked(downloadText)).toHaveBeenCalledWith(
      documentFileName(doc),
      serializeDocument(doc),
    )
    expect(vi.mocked(saveProject)).toHaveBeenCalledWith(doc)
    expect(editor().toasts.at(-1)?.message).toBe('Project saved.')
    // "s" on its own is the service-point tool; with the modifier held it must
    // not also change tool underneath the save.
    expect(editor().tool).toBe('select')
  })
})
