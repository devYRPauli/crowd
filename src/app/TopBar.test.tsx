/**
 * @vitest-environment jsdom
 */

/**
 * Document actions and view controls.
 *
 * Everything on this bar either changes the document or changes how it is
 * looked at, and the two must not be confused: switching to the plan view is
 * not an edit and must not cost an undo step, while renaming the project is an
 * edit and must be undoable. The bar is also the only way into a run of the
 * open-a-file path, which is where a project can be lost.
 */

import { useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TopBar } from './TopBar'
import type { ViewportHandle } from './ViewportHost'
import { useEditor } from '../state/editorStore'
import { useSimulation, type Frame } from '../state/simulationStore'
import { createHistory } from '../core/document/history'
import { createDocument } from '../core/model/defaults'
import { PlanBuilder } from '../library/planBuilder'
import { planBounds } from '../core/model/planGeometry'
import { documentFileName, serializeDocument } from '../core/document/serialize'
import { downloadText, readFileAsText, saveProject } from '../core/document/storage'
import type * as Storage from '../core/document/storage'
import { AGENT_STRIDE } from '../sim/types'
import type { SimStats } from '../sim/types'
import type { CrowdDocument } from '../core/model/types'

// The download anchor and IndexedDB are not available here and are not what
// this bar is responsible for; what it is responsible for is handing them the
// document the user is looking at.
vi.mock('../core/document/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof Storage>()
  return {
    ...actual,
    downloadText: vi.fn(),
    saveProject: vi.fn(() => Promise.resolve()),
    // The real reader, except where a test needs the read itself to fail.
    readFileAsText: vi.fn(actual.readFileAsText),
  }
})

const venue = (name = 'Riverside Hall'): CrowdDocument => {
  const b = new PlanBuilder()
  const room = b.room(0, 0, 12, 8)
  b.door(room.south, 6)
  b.place('table-round-6', 4, 4)
  const base = createDocument(name)
  return { ...base, plan: b.build() }
}

const editor = () => useEditor.getState()
const defaults = useEditor.getInitialState()

let hall = venue()
let frame: ReturnType<typeof vi.fn>

const mount = () => {
  const onToggleHeatmap = vi.fn()
  const onOpenTemplates = vi.fn()
  const onOpenProjects = vi.fn()
  const onOpenShortcuts = vi.fn()
  frame = vi.fn()

  const Shell = ({ showHeatmap = false }: { showHeatmap?: boolean }) => {
    const viewportRef = useRef<ViewportHandle>({
      viewport: { frame } as unknown as ViewportHandle['viewport'],
      controller: null,
    })
    return (
      <TopBar
        viewportRef={viewportRef}
        showHeatmap={showHeatmap}
        onToggleHeatmap={onToggleHeatmap}
        onOpenTemplates={onOpenTemplates}
        onOpenProjects={onOpenProjects}
        onOpenShortcuts={onOpenShortcuts}
      />
    )
  }

  const result = render(<Shell />)
  return { ...result, Shell, onToggleHeatmap, onOpenTemplates, onOpenProjects, onOpenShortcuts }
}

const stats = (): SimStats => ({
  time: 0,
  spawned: 0,
  active: 9,
  completed: 0,
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

beforeEach(() => {
  vi.clearAllMocks()
  hall = venue()
  useEditor.setState({
    history: createHistory(hall),
    document: hall,
    selection: [],
    hover: null,
    tool: defaults.tool,
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
  })
})

describe('the project name', () => {
  it('costs one undo step per keystroke', () => {
    mount()
    const field = screen.getByLabelText('Project name')

    for (const value of ['Riverside Hall A', 'Riverside Hall Au', 'Riverside Hall Aug']) {
      fireEvent.change(field, { target: { value } })
    }

    // SUSPECTED BUG (src/app/TopBar.tsx:95-97). `apply` is called with no
    // coalesceKey, so every character typed into the name is its own history
    // entry: renaming a venue to "Riverside Hall — August rehearsal" leaves
    // thirty-odd steps in the undo stack, and the edit the user actually wants
    // back is thirty presses of ⌘Z away. AGENTS.md is explicit that a gesture
    // is one undo step; typing a name is a gesture and should pass a
    // coalesceKey while it runs and seal on blur, exactly as a drag does — and
    // exactly as the inspector's own number fields already do by committing on
    // blur rather than on change. Its two name fields (InspectorPanel.tsx:461
    // and :533) are written the same way as this one, so the fix belongs to
    // all three.
    expect(editor().history.past).toHaveLength(3)
    editor().undo()
    expect(editor().document.name).toBe('Riverside Hall Au')
  })

  it('shows the unsaved badge only once there is something unsaved', () => {
    mount()
    expect(screen.queryByText('Unsaved')).toBeNull()

    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Hall B' } })
    expect(screen.queryByText('Unsaved')).not.toBeNull()

    act(() => editor().markSaved())
    expect(screen.queryByText('Unsaved')).toBeNull()
  })
})

describe('undo and redo', () => {
  it('stays out of reach until there is an edit, and names the edit it will undo', () => {
    mount()
    expect(screen.getByTitle('Undo')).toHaveProperty('disabled', true)
    expect(screen.getByTitle('Redo')).toHaveProperty('disabled', true)

    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Hall B' } })

    // The tooltip says what is about to be given back, so a user who has been
    // away from the keyboard knows before they press it.
    const undo = screen.getByTitle('Undo Rename project')
    expect(undo).toHaveProperty('disabled', false)
    expect(screen.getByTitle('Redo')).toHaveProperty('disabled', true)

    fireEvent.click(undo)
    expect(editor().document).toBe(hall)
    expect(screen.getByTitle('Undo')).toHaveProperty('disabled', true)

    fireEvent.click(screen.getByTitle('Redo Rename project'))
    expect(editor().document.name).toBe('Hall B')
  })
})

describe('view controls', () => {
  it('switches camera without touching the document or its history', () => {
    mount()
    const before = editor().document

    fireEvent.click(screen.getByTitle('Front view'))
    expect(editor().view.preset).toBe('front')
    expect(screen.getByTitle('Front view').className).toContain('is-active')
    expect(screen.getByTitle('3D view').className).not.toContain('is-active')

    // Looking at a venue from somewhere else is not an edit to it.
    expect(editor().document).toBe(before)
    expect(editor().history.past).toHaveLength(0)
    expect(editor().dirty).toBe(false)
  })

  it('frames the whole plan with a margin when asked to fit', () => {
    mount()
    fireEvent.click(screen.getByTitle('Fit the plan in view (.)'))
    expect(frame).toHaveBeenCalledWith(planBounds(hall.plan, 3))
  })

  it('shows whether the heat map is on and asks the app to flip it', () => {
    const { onToggleHeatmap, rerender, Shell } = mount()
    const heat = () => screen.getByTitle('Density heat map (H)')
    expect(heat().className).not.toContain('is-active')

    fireEvent.click(heat())
    expect(onToggleHeatmap).toHaveBeenCalledTimes(1)
    // The bar does not own the flag; the app does, and the bar reflects it.
    expect(heat().className).not.toContain('is-active')

    rerender(<Shell showHeatmap />)
    expect(heat().className).toContain('is-active')
  })

  it('switches the side panel and marks the one on show', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Results' }))
    expect(editor().panel).toBe('results')
    expect(screen.getByRole('button', { name: 'Results' }).className).toContain('is-active')

    const panels = screen.getByRole('group', { name: 'Panels' })
    expect(panels.querySelectorAll('.is-active')).toHaveLength(1)
  })

  it('opens the templates, the projects and the shortcut sheet for the app to show', () => {
    const { onOpenTemplates, onOpenProjects, onOpenShortcuts } = mount()
    fireEvent.click(screen.getByTitle('Start from a template'))
    fireEvent.click(screen.getByRole('button', { name: 'Projects' }))
    fireEvent.click(screen.getByTitle('Keyboard shortcuts (?)'))
    expect(onOpenTemplates).toHaveBeenCalledTimes(1)
    expect(onOpenProjects).toHaveBeenCalledTimes(1)
    expect(onOpenShortcuts).toHaveBeenCalledTimes(1)
  })
})

describe('getting a project in and out', () => {
  it('downloads the venue under a filename made from the name it has now', async () => {
    mount()
    // Renamed first: what leaves the app is the venue as it stands, not the one
    // the bar was handed when it mounted.
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'Riverside Hall — August rehearsal' },
    })
    fireEvent.click(screen.getByTitle('Download this project'))

    const current = editor().document
    // Punctuation a file system would argue about is dropped, spaces become
    // hyphens, and the extension says what kind of file it is.
    expect(documentFileName(current)).toBe('riverside-hall-august-rehearsal.crowd.json')
    expect(vi.mocked(downloadText)).toHaveBeenCalledWith(
      'riverside-hall-august-rehearsal.crowd.json',
      serializeDocument(current),
    )
    // Downloading also banks it locally, so the copy on disk and the copy in
    // the browser are the same version — and the Unsaved badge goes with it.
    expect(vi.mocked(saveProject)).toHaveBeenCalledWith(current)
    expect(editor().toasts.at(-1)?.message).toBe('Project downloaded.')
    await waitFor(() => expect(editor().dirty).toBe(false))
    expect(screen.queryByText('Unsaved')).toBeNull()
  })

  it('opens a saved venue and clears the crowd that was walking through the old one', async () => {
    const { container } = mount()
    act(() => useSimulation.setState({ phase: 'running', runId: 'run-live', frame: liveFrame() }))

    const other = venue('Concourse')
    const file = new File([serializeDocument(other)], 'concourse.crowd.json', {
      type: 'application/json',
    })
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(editor().document.name).toBe('Concourse'))

    // Results belong to the plan they were measured on. Leaving them up beside
    // a different venue invites reading one against the other.
    expect(useSimulation.getState().phase).toBe('idle')
    expect(useSimulation.getState().frame).toBeNull()
    expect(frame).toHaveBeenCalledWith(planBounds(editor().document.plan, 3))
    expect(editor().toasts.at(-1)?.message).toBe('Opened Concourse.')
    // Opening starts a history rather than extending one: there is no undoing
    // back into the venue that was on screen.
    expect(editor().history.past).toHaveLength(0)
    expect(editor().canUndo()).toBe(false)
  })

  it('throws the open venue away when the file turns out not to be one', async () => {
    const { container } = mount()
    act(() => useSimulation.setState({ phase: 'running', runId: 'run-live', frame: liveFrame() }))

    const file = new File(['this is not a venue'], 'notes.txt', { type: 'text/plain' })
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(editor().toasts.at(-1)?.message).toBe('Opened Untitled venue.'))

    // SUSPECTED BUG (src/app/TopBar.tsx:72-83). `parseDocumentJson` is
    // deliberately lenient — it never throws, and a file it cannot read at all
    // comes back as an empty venue carrying warnings that say so. The bar
    // treats that as a successful open: it stops the run, replaces the
    // document and resets the history, so picking the wrong file in the
    // chooser destroys the plan on screen — and the run that was going on over
    // it — with no undo left to get either back, and then reports "Opened
    // Untitled venue." as a success. The `catch` arm and its "That file could
    // not be opened." never fire for this, the case a user will actually hit;
    // they cover only a read that fails outright, as the test below shows. A
    // result whose warnings say it was not a CROWD document should be refused
    // before `replaceDocument`, not after.
    const messages = editor().toasts.map((toast) => toast.message)
    expect(messages).toContain('That file is not valid JSON.')
    expect(messages).toContain('The file did not contain a CROWD document; started empty.')
    expect(messages).not.toContain('That file could not be opened.')
    expect(editor().document.name).toBe('Untitled venue')
    expect(editor().document.plan.walls).toHaveLength(0)
    expect(editor().canUndo()).toBe(false)
    expect(useSimulation.getState().phase).toBe('idle')
  })

  it('leaves the venue alone when the file cannot be read at all', async () => {
    const { container } = mount()
    // A file picked from a stick that was then pulled out, or one the browser
    // refuses to read. This is the only path that reaches the `catch`.
    vi.mocked(readFileAsText).mockRejectedValueOnce(new Error('the file has gone'))

    const file = new File([serializeDocument(venue('Concourse'))], 'concourse.crowd.json')
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() =>
      expect(editor().toasts.at(-1)?.message).toBe('That file could not be opened.'),
    )
    // Nothing was replaced, so the venue on screen survived — which is exactly
    // what the unreadable-contents path above fails to do.
    expect(editor().toasts.at(-1)?.tone).toBe('error')
    expect(editor().document).toBe(hall)
    expect(frame).not.toHaveBeenCalled()
  })
})
