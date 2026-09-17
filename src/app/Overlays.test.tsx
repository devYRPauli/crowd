/**
 * @vitest-environment jsdom
 */

/**
 * The modal overlays.
 *
 * Two of the three are how a first-time user gets a venue on screen at all, so
 * what matters is that choosing one really does open it — plan, scenario and
 * camera — and that it cannot leave the previous venue half in place. The
 * shortcut sheet is a promise about the keyboard, and a promise is only worth
 * testing against the thing it is a promise about.
 */

import { useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ShortcutSheet, TemplatePicker, Welcome } from './Overlays'
import { ToolRail } from './ToolRail'
import { useKeyboard } from './useKeyboard'
import type { ViewportHandle } from './ViewportHost'
import { useEditor } from '../state/editorStore'
import { useSimulation, type Frame } from '../state/simulationStore'
import { createHistory } from '../core/document/history'
import { createDocument } from '../core/model/defaults'
import { PlanBuilder } from '../library/planBuilder'
import { planBounds } from '../core/model/planGeometry'
import { TEMPLATES } from '../library/templates'
import { AGENT_STRIDE } from '../sim/types'
import type { SimStats } from '../sim/types'
import type { CrowdDocument } from '../core/model/types'

const editor = () => useEditor.getState()
const sim = () => useSimulation.getState()
const defaults = useEditor.getInitialState()

const venue = (): CrowdDocument => {
  const b = new PlanBuilder()
  b.room(0, 0, 12, 8)
  const base = createDocument('Riverside Hall')
  return { ...base, plan: b.build() }
}

const stats = (): SimStats => ({
  time: 60,
  spawned: 40,
  active: 9,
  completed: 31,
  meanDensity: 0.4,
  peakDensity: 0.9,
  meanSpeed: 1.1,
  meanWalkingSpeed: 1.2,
  walking: 9,
  stoppedShare: 0,
  meanWait: 0,
  maxWait: 0,
  queueLengths: [],
  worstLos: 'B',
})

const liveFrame = (): Frame => ({
  time: 60,
  count: 9,
  agents: new Float32Array(9 * AGENT_STRIDE),
  density: new Float32Array(4),
  stats: stats(),
})

let hall = venue()
let frame: ReturnType<typeof vi.fn>

beforeEach(() => {
  hall = venue()
  useEditor.setState({
    history: createHistory(hall),
    document: hall,
    selection: [],
    tool: 'select',
    view: { ...defaults.view },
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
  })
})

const Picker = ({ onClose }: { onClose: () => void }) => {
  const viewportRef = useRef<ViewportHandle>({
    viewport: { frame } as unknown as ViewportHandle['viewport'],
    controller: null,
  })
  return <TemplatePicker onClose={onClose} viewportRef={viewportRef} />
}

describe('the template picker', () => {
  beforeEach(() => {
    frame = vi.fn()
  })

  it('shows every starter venue, what it is and what it is for', () => {
    const { container } = render(<Picker onClose={() => undefined} />)
    const cards = Array.from(container.querySelectorAll('.template-card'))
    expect(TEMPLATES.length).toBeGreaterThan(1)
    expect(cards).toHaveLength(TEMPLATES.length)

    cards.forEach((card, index) => {
      const template = TEMPLATES[index]
      // All three lines belong to the same card, in that order: the summary
      // says what the room is, and "teaches" says why you would open this one
      // rather than the one beside it. Shuffled or split across cards they
      // describe the wrong venue.
      expect(card.textContent).toBe(`${template.name}${template.summary}${template.teaches}`)
    })
  })

  it('opens the venue complete, and clears the run that was going on in the last one', () => {
    const onClose = vi.fn()
    render(<Picker onClose={onClose} />)
    act(() => useSimulation.setState({ phase: 'running', runId: 'run-live', frame: liveFrame() }))

    // Deliberately not the first card, and not the one the app boots into: a
    // picker that built whichever template it liked would still look right.
    const template = TEMPLATES[TEMPLATES.length - 1]
    expect(template.id).not.toBe(TEMPLATES[0].id)
    fireEvent.click(screen.getByText(template.name).closest('button') as HTMLElement)

    const opened = editor().document
    expect(opened.name).toBe(template.name)
    // A template is a whole venue, not an empty grid: a plan to look at and a
    // crowd to press Run on.
    expect(opened.plan.walls.length).toBeGreaterThan(0)
    expect(opened.scenario.populations.length).toBeGreaterThan(0)
    expect(frame).toHaveBeenCalledWith(planBounds(opened.plan, 3))

    // The crowd from the previous venue would otherwise still be standing on
    // the new floor, and its findings would be read against the new plan.
    expect(sim().phase).toBe('idle')
    expect(sim().frame).toBeNull()

    // Opening starts a history rather than extending one.
    expect(editor().canUndo()).toBe(false)
    expect(editor().toasts.at(-1)?.message).toBe(
      `Opened ${template.name}. Press Run to see it work.`,
    )
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on escape and on the close button without opening anything', () => {
    const onClose = vi.fn()
    const { unmount } = render(<Picker onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(2)

    // Nothing was chosen, so the venue on screen is the one that was there.
    expect(editor().document).toBe(hall)
    unmount()
  })
})

describe('the shortcut sheet', () => {
  interface Row {
    label: string
    keys: string[]
  }

  /** Every row of one group of the sheet, in the order it is printed. */
  const rowsOf = (container: HTMLElement, group: string): Row[] => {
    const section = Array.from(container.querySelectorAll('.shortcut-group')).find(
      (el) => el.querySelector('h3')?.textContent === group,
    )
    return Array.from(section?.querySelectorAll('.shortcut-row') ?? []).map((row) => ({
      label: row.firstElementChild?.textContent ?? '',
      keys: Array.from(row.querySelectorAll('.kbd')).map((kbd) => kbd.textContent ?? ''),
    }))
  }

  const keysFor = (rows: Row[], label: string): string[][] =>
    rows.filter((row) => row.label === label).map((row) => row.keys)

  /** The sheet writes keys for people to read; a KeyboardEvent names them otherwise. */
  const EVENT_KEY: Record<string, string> = { Space: ' ', Esc: 'Escape' }

  /** The global keyboard map, live, with nothing else of the app around it. */
  const Keyboard = ({
    onFrame,
    onToggleHeatmap,
    onShowShortcuts,
  }: {
    onFrame: () => void
    onToggleHeatmap: () => void
    onShowShortcuts: () => void
  }) => {
    const viewportRef = useRef<ViewportHandle>({
      viewport: { frame: onFrame } as unknown as ViewportHandle['viewport'],
      controller: null,
    })
    useKeyboard({ viewportRef, onToggleHeatmap, onShowShortcuts, overlayOpen: false })
    return null
  }

  /**
   * Presses whatever the sheet printed against the live keyboard map, rather
   * than whatever the test author believed it printed. A row promising two
   * bare keys is rejected here: it could not be typed as one chord anyway.
   */
  const pressAsPrinted = (rows: Row[], label: string): void => {
    const printed = keysFor(rows, label)
    expect(printed, `"${label}" is not a row on the sheet`).toHaveLength(1)
    const keys = printed[0]
    const named = keys.filter((key) => key !== '⌘' && key !== '⇧')
    expect(named, `"${label}" names ${named.length} keys, not one`).toHaveLength(1)
    fireEvent.keyDown(window.document.body, {
      key: EVENT_KEY[named[0]] ?? named[0],
      metaKey: keys.includes('⌘'),
      shiftKey: keys.includes('⇧'),
    })
  }

  const withKeyboard = () => {
    const sheet = render(<ShortcutSheet onClose={() => undefined} />)
    const stubs = { frame: vi.fn(), toggleHeatmap: vi.fn(), showShortcuts: vi.fn() }
    render(
      <Keyboard
        onFrame={stubs.frame}
        onToggleHeatmap={stubs.toggleHeatmap}
        onShowShortcuts={stubs.showShortcuts}
      />,
    )
    return { sheet, stubs }
  }

  it('prints the same key for a tool as the tool rail does', () => {
    const sheet = render(<ShortcutSheet onClose={() => undefined} />)
    const promised = new Map(rowsOf(sheet.container, 'Tools').map((row) => [row.label, row.keys]))

    const rail = render(<ToolRail />)
    const buttons = Array.from(rail.container.querySelectorAll('button'))
    expect(buttons.length).toBeGreaterThan(0)

    for (const button of buttons) {
      const label = button.getAttribute('aria-label') ?? ''
      const onTheRail = /\(([^)]+)\)\s*$/.exec(button.getAttribute('title') ?? '')?.[1]
      // The rail's tooltip and the sheet are the only two places a shortcut is
      // written down. If they disagree, one of them is teaching the wrong key.
      expect(promised.get(label), `${label} is missing from the shortcut sheet`).toEqual([
        onTheRail,
      ])
    }

    // And the sheet lists nothing the rail does not offer.
    expect(promised.size).toBe(buttons.length)
  })

  it('names the keys the transport and the editor actually bind', () => {
    const { container } = render(<ShortcutSheet onClose={() => undefined} />)
    const run = rowsOf(container, 'Run')
    const edit = rowsOf(container, 'Edit')
    const navigate = rowsOf(container, 'Navigate')

    expect(keysFor(run, 'Run, pause or resume')).toEqual([['Space']])
    expect(keysFor(run, 'Stop and clear')).toEqual([['⇧', 'Space']])
    expect(keysFor(run, 'Save the project')).toEqual([['⌘', 'S']])
    expect(keysFor(run, 'This list')).toEqual([['?']])
    expect(keysFor(edit, 'Undo')).toEqual([['⌘', 'Z']])
    expect(keysFor(edit, 'Redo')).toEqual([['⌘', '⇧', 'Z']])
    expect(keysFor(edit, 'Duplicate')).toEqual([['⌘', 'D']])
    expect(keysFor(navigate, 'Fit the plan in view')).toEqual([['.']])
    expect(keysFor(navigate, 'Plan / 3D view')).toEqual([['Tab']])
    expect(keysFor(navigate, 'Density heat map')).toEqual([['H']])

    // The left mouse button belongs to the active tool, always, so the two ways
    // of panning the sheet offers are the middle button and Space-drag — never
    // a bare left drag. Both rows have to be printed, not one.
    //
    // SUSPECTED BUG (src/app/Overlays.tsx:117). The rows are keyed on their
    // label, and these two share one, so React logs "Encountered two children
    // with the same key, `Pan`" and warns that duplicates may be omitted. They
    // both render today; the key should be the group and the keys, not the
    // label, before a React version makes good on the warning.
    expect(keysFor(navigate, 'Orbit')).toEqual([['right-drag']])
    expect(keysFor(navigate, 'Pan')).toEqual([['middle-drag'], ['Space', 'drag']])
  })

  it('promises nothing about editing that the keyboard does not do', () => {
    const { sheet } = withKeyboard()
    const edit = rowsOf(sheet.container, 'Edit')
    const walls = hall.plan.walls.length
    expect(walls).toBeGreaterThan(0)

    pressAsPrinted(edit, 'Select everything')
    expect(editor().selection).toHaveLength(walls)

    pressAsPrinted(edit, 'Delete')
    expect(editor().document.plan.walls).toHaveLength(0)

    pressAsPrinted(edit, 'Undo')
    expect(editor().document).toBe(hall)
    pressAsPrinted(edit, 'Redo')
    expect(editor().document.plan.walls).toHaveLength(0)

    act(() => editor().setTool('wall'))
    pressAsPrinted(edit, 'Cancel the current action')
    expect(editor().tool).toBe('select')
    expect(editor().selection).toHaveLength(0)
  })

  it('promises nothing about the camera or the run that the keyboard does not do', () => {
    const { sheet, stubs } = withKeyboard()
    const navigate = rowsOf(sheet.container, 'Navigate')
    const run = rowsOf(sheet.container, 'Run')

    pressAsPrinted(navigate, 'Fit the plan in view')
    expect(stubs.frame).toHaveBeenCalledWith(planBounds(hall.plan, 3))

    expect(editor().view.preset).toBe('iso')
    pressAsPrinted(navigate, 'Plan / 3D view')
    expect(editor().view.preset).toBe('plan')

    pressAsPrinted(navigate, 'Density heat map')
    expect(stubs.toggleHeatmap).toHaveBeenCalledTimes(1)

    pressAsPrinted(run, 'This list')
    expect(stubs.showShortcuts).toHaveBeenCalledTimes(1)

    // The run is pretended into flight rather than started: a real one needs a
    // worker, and what is being checked is the key, not the simulation.
    act(() => useSimulation.setState({ phase: 'running', runId: 'run-live' }))
    pressAsPrinted(run, 'Run, pause or resume')
    expect(sim().phase).toBe('paused')
    pressAsPrinted(run, 'Stop and clear')
    expect(sim().phase).toBe('idle')
  })
})

describe('the welcome', () => {
  it('hands a first-time user straight to a venue', () => {
    const onClose = vi.fn()
    const onTemplates = vi.fn()
    render(<Welcome onClose={onClose} onTemplates={onTemplates} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open a venue' }))

    // The welcome has to go before the picker arrives, or two dialogs are open
    // at once and the keyboard belongs to neither.
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onTemplates).toHaveBeenCalledTimes(1)
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(
      onTemplates.mock.invocationCallOrder[0],
    )
  })

  it('gets out of the way for somebody who wants to start drawing', () => {
    const onClose = vi.fn()
    const onTemplates = vi.fn()
    render(<Welcome onClose={onClose} onTemplates={onTemplates} />)

    fireEvent.click(screen.getByRole('button', { name: 'Start with an empty plan' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onTemplates).not.toHaveBeenCalled()
  })
})
