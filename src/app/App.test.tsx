/**
 * @vitest-environment jsdom
 */

/**
 * The application shell.
 *
 * App is a composition root: it owns the handful of things that belong to no
 * single panel — which overlay is open, whether the heat map is on, the handle
 * to the imperative viewport — and wires the two stores to them. So what is
 * tested here is the wiring, not the pieces: that the first run of the app puts
 * a venue on screen, that a dialog really does take the keyboard away from the
 * editor, that a worker's complaint reaches the user exactly once, and that an
 * edit is banked without anybody pressing save.
 *
 * The 3D viewport is stubbed. It needs a WebGL context, which jsdom does not
 * have, and everything App asks of it goes through the handle it is given.
 */

import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ViewportHandle } from './ViewportHost'
import { useEditor } from '../state/editorStore'
import { useSimulation, type Frame } from '../state/simulationStore'
import { planBounds } from '../core/model/planGeometry'
import { AGENT_FIELD, AGENT_STRIDE, agentStateIndex } from '../sim/types'
import { createHistory } from '../core/document/history'
import { createDocument } from '../core/model/defaults'
import { PlanBuilder } from '../library/planBuilder'
import { DEFAULT_TEMPLATE_ID, getTemplate } from '../library/templates'
import {
  loadProject,
  recallLastProject,
  rememberLastProject,
  saveProject,
} from '../core/document/storage'
import type * as Storage from '../core/document/storage'
import type { CrowdDocument } from '../core/model/types'

const stub = vi.hoisted(() => ({
  frame: vi.fn(),
  pickPerson: null as ((index: number | null) => void) | null,
}))

vi.mock('./ViewportHost', () => ({
  ViewportHost: ({
    handleRef,
    onPickPerson,
  }: {
    handleRef: { current: ViewportHandle }
    onPickPerson: (index: number | null) => void
  }) => {
    useEffect(() => {
      handleRef.current = {
        viewport: { frame: stub.frame } as unknown as ViewportHandle['viewport'],
        controller: null,
      }
      stub.pickPerson = onPickPerson
    }, [handleRef, onPickPerson])
    return <div data-testid="viewport" />
  },
}))

// IndexedDB and the download anchor do not exist here; these four are the whole
// of App's conversation with local storage.
vi.mock('../core/document/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof Storage>()
  return {
    ...actual,
    saveProject: vi.fn(() => Promise.resolve()),
    loadProject: vi.fn(() => Promise.resolve(null)),
    recallLastProject: vi.fn((): string | null => null),
    rememberLastProject: vi.fn(),
    listProjects: vi.fn(() => Promise.resolve([])),
    downloadText: vi.fn(),
  }
})

const { App } = await import('./App')

const editor = () => useEditor.getState()
const sim = () => useSimulation.getState()
const defaults = useEditor.getInitialState()

const liveFrame = (peakDensity: number): Frame => ({
  time: 12,
  count: 3,
  agents: new Float32Array(3 * AGENT_STRIDE),
  density: new Float32Array(4),
  stats: {
    time: 12,
    spawned: 3,
    active: 3,
    completed: 0,
    meanDensity: 0.5,
    peakDensity,
    meanSpeed: 1.1,
    meanWalkingSpeed: 1.2,
    walking: 3,
    stoppedShare: 0,
    meanWait: 0,
    maxWait: 0,
    queueLengths: [],
    worstLos: 'E',
  },
})

const savedVenue = (): CrowdDocument => {
  const b = new PlanBuilder()
  b.room(0, 0, 14, 9)
  b.place('table-round-6', 5, 5)
  const base = createDocument('Yesterday’s hall')
  return { ...base, plan: b.build() }
}

beforeEach(() => {
  vi.clearAllMocks()
  // `clearAllMocks` forgets the calls but keeps whatever a test last told these
  // to return, so the boot every test starts from is stated here rather than
  // inherited from the test above it.
  vi.mocked(recallLastProject).mockReturnValue(null)
  vi.mocked(loadProject).mockResolvedValue(null)
  vi.mocked(saveProject).mockResolvedValue(undefined)
  stub.pickPerson = null
  useEditor.setState({
    history: createHistory(defaults.document),
    document: defaults.document,
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
    grid: null,
    summary: null,
    series: null,
    warnings: [],
    error: null,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the first thing anybody sees', () => {
  it('opens a starter venue rather than an empty grid, and says hello', async () => {
    render(<App />)

    const template = getTemplate(DEFAULT_TEMPLATE_ID)
    expect(template).toBeDefined()
    await waitFor(() => expect(editor().document.name).toBe(template?.name))
    expect(editor().document.plan.walls.length).toBeGreaterThan(0)

    // Framed without an animation, because there was nothing on screen to move
    // the camera away from.
    expect(stub.frame).toHaveBeenCalledWith(planBounds(editor().document.plan, 3), false)
    expect(screen.getByRole('dialog', { name: 'CROWD' })).toBeDefined()
  })

  it('reopens the project you were last in, and does not greet you again', async () => {
    const saved = savedVenue()
    vi.mocked(recallLastProject).mockReturnValue(saved.id)
    vi.mocked(loadProject).mockResolvedValue(saved)

    render(<App />)

    await waitFor(() => expect(editor().document).toBe(saved))
    expect(vi.mocked(loadProject)).toHaveBeenCalledWith(saved.id)
    expect(stub.frame).toHaveBeenCalledWith(planBounds(saved.plan, 3))
    // Somebody coming back to yesterday's work does not need the tour again.
    expect(screen.queryByRole('dialog', { name: 'CROWD' })).toBeNull()
    // And it opens as a project, not as an edit to whatever was there.
    expect(editor().canUndo()).toBe(false)
    expect(editor().dirty).toBe(false)
  })

  it('falls back to the starter venue when the last project cannot be read', async () => {
    vi.mocked(recallLastProject).mockReturnValue('project-that-has-gone')
    vi.mocked(loadProject).mockRejectedValue(new Error('storage is blocked'))

    render(<App />)

    // A browser that blocks storage must not leave the user staring at nothing.
    await waitFor(() => expect(editor().document.name).toBe(getTemplate(DEFAULT_TEMPLATE_ID)?.name))
    expect(screen.getByRole('dialog', { name: 'CROWD' })).toBeDefined()
  })
})

describe('what the shell wires together', () => {
  it('takes the keyboard away from the editor for as long as a dialog is up', async () => {
    render(<App />)
    await screen.findByRole('dialog', { name: 'CROWD' })

    // "w" is the wall tool. With the welcome up it belongs to the dialog.
    fireEvent.keyDown(window.document.body, { key: 'w' })
    expect(editor().tool).toBe('select')

    fireEvent.click(screen.getByRole('button', { name: 'Start with an empty plan' }))
    expect(screen.queryByRole('dialog', { name: 'CROWD' })).toBeNull()

    fireEvent.keyDown(window.document.body, { key: 'w' })
    expect(editor().tool).toBe('wall')

    // And again for a dialog the keyboard opened itself: every overlay has to
    // be in the flag `useKeyboard` is handed, not only the one that happens to
    // be up at boot.
    fireEvent.keyDown(window.document.body, { key: '?', shiftKey: true })
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeDefined()
    fireEvent.keyDown(window.document.body, { key: 'v' })
    expect(editor().tool).toBe('wall')

    // Escape is the one that matters: the editor would take it, clear the
    // selection, and the sheet would never close.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull()
    fireEvent.keyDown(window.document.body, { key: 'v' })
    expect(editor().tool).toBe('select')
  })

  it('puts the theme on the root element so the variables cascade everywhere', async () => {
    render(<App />)
    await waitFor(() => expect(window.document.documentElement.dataset.theme).toBe('light'))

    act(() => editor().setView({ theme: 'dark' }))
    expect(window.document.documentElement.dataset.theme).toBe('dark')
  })

  it('reports a failed run once, and reports the next failure too', async () => {
    render(<App />)
    await screen.findByTestId('viewport')

    act(() => useSimulation.setState({ phase: 'error', error: 'The navigation grid is empty.' }))

    expect(editor().toasts.map((toast) => [toast.message, toast.tone])).toEqual([
      ['The navigation grid is empty.', 'error'],
    ])
    // Cleared at once, so a re-render cannot toast the same failure twice…
    expect(sim().error).toBeNull()
    expect(sim().phase).toBe('idle')

    // …and so the same failure happening again is still worth saying.
    act(() => useSimulation.setState({ phase: 'error', error: 'The navigation grid is empty.' }))
    expect(editor().toasts).toHaveLength(2)
  })

  it('passes on what the worker had to warn about', async () => {
    render(<App />)
    await screen.findByTestId('viewport')

    act(() =>
      useSimulation.setState({
        warnings: ['Two exits are unreachable.', 'A queue overlaps a wall.'],
      }),
    )

    expect(editor().toasts.map((toast) => toast.message)).toEqual([
      'Two exits are unreachable.',
      'A queue overlaps a wall.',
    ])
    expect(editor().toasts.every((toast) => toast.tone === 'warn')).toBe(true)
  })

  it('brings the results panel forward as soon as a run starts', async () => {
    render(<App />)
    await screen.findByTestId('viewport')
    expect(editor().panel).toBe('library')

    // The grid is still being built, but the panel the user is about to want is
    // already the one they are looking at.
    act(() => useSimulation.setState({ phase: 'preparing' }))
    expect(editor().panel).toBe('results')

    act(() => editor().setPanel('library'))
    act(() => useSimulation.setState({ phase: 'running' }))
    expect(editor().panel).toBe('results')
  })

  it('offers the crowd controls only once there is a crowd, and bands the density it measured', async () => {
    const { container } = render(<App />)
    await screen.findByTestId('viewport')
    const overlay = () => container.querySelector('.stage-top-right')?.textContent ?? ''
    // Nothing has run, so there is nothing to colour and nothing to classify.
    expect(overlay()).toBe('')

    act(() => useSimulation.setState({ phase: 'running', frame: liveFrame(1.4) }))

    expect(overlay()).toContain('Colour by')
    // 1.4 persons/m² is Fruin walkway E — shuffling, at capacity. The badge
    // carries the number it fired on beside the letter, because a letter on its
    // own is not a measurement.
    expect(overlay()).toContain('E')
    expect(overlay()).toContain('1.4/m²')
    expect(screen.getByLabelText('Crush risk')).toHaveProperty('checked', true)
  })

  it('flips the heat map from the keyboard, with the bar and the stage agreeing', async () => {
    const { container } = render(<App />)
    await screen.findByRole('dialog', { name: 'CROWD' })
    fireEvent.click(screen.getByRole('button', { name: 'Start with an empty plan' }))
    act(() => useSimulation.setState({ phase: 'running', frame: liveFrame(1.4) }))

    const heat = () => screen.getByTitle('Density heat map (H)')
    const stage = () => container.querySelector('.stage-top-right')?.textContent ?? ''
    expect(heat().className).toContain('is-active')
    expect(stage()).toContain('Density')

    // The flag is App's, and the key, the button and the legend over the plan
    // are three views of it. Two of them disagreeing is the map on with the
    // button reading off.
    fireEvent.keyDown(window.document.body, { key: 'h' })
    expect(heat().className).not.toContain('is-active')
    expect(stage()).not.toContain('Density')

    fireEvent.click(heat())
    expect(heat().className).toContain('is-active')
    expect(stage()).toContain('Density')
  })

  it('puts the tool’s own instruction on the stage while it has one', async () => {
    const { container } = render(<App />)
    await screen.findByTestId('viewport')
    const strip = () => container.querySelector('.stage-bottom-left')

    // Nothing is mid-gesture, and a status strip with nothing in it is a box
    // sitting over the plan for no reason.
    expect(strip()).toBeNull()

    act(() => editor().setHint('Click to place the second point.'))
    expect(strip()?.textContent).toBe('Click to place the second point.')

    act(() => editor().setHint(null))
    expect(strip()).toBeNull()
  })

  it('reads the picked person out of the live frame', async () => {
    render(<App />)
    await screen.findByTestId('viewport')

    const frame = liveFrame(0.9)
    // The second person in the frame: queueing, barely moving, and two and a
    // half minutes into the wait.
    const base = 1 * AGENT_STRIDE
    frame.agents[base + AGENT_FIELD.speed] = 0.42
    frame.agents[base + AGENT_FIELD.state] = agentStateIndex('queuing')
    frame.agents[base + AGENT_FIELD.waited] = 150
    frame.agents[base + AGENT_FIELD.profile] = 1
    act(() => useSimulation.setState({ phase: 'running', frame }))
    act(() => stub.pickPerson?.(1))

    const scenario = editor().document.scenario
    // Every number is read out of that person's slot in the packed frame, at a
    // stride the card has to agree with the engine about; read one field along
    // and the card confidently reports somebody else's speed.
    expect(screen.getByText('0.42')).toBeDefined()
    expect(screen.getByText('2 min 30 s')).toBeDefined()
    expect(screen.getByText('Queueing')).toBeDefined()
    expect(screen.getByText(scenario.profiles[1].name)).toBeDefined()
    expect(screen.getByText(`${scenario.profiles[1].speed.mean.toFixed(2)} m/s`)).toBeDefined()
    expect(screen.getByText(scenario.populations[0].name)).toBeDefined()
  })

  it('says so when the person being inspected has already left', async () => {
    render(<App />)
    await screen.findByTestId('viewport')

    // The viewport picks people out of the live frame; with the run stopped
    // there is no frame left, and the inspector must not show stale numbers.
    act(() => stub.pickPerson?.(7))
    expect(screen.getByText('That person has left the venue.')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Back to the inspector' }))
    expect(screen.queryByText('That person has left the venue.')).toBeNull()
  })
})

describe('autosave', () => {
  it('banks an edit a couple of seconds after the user stops making them', async () => {
    vi.useFakeTimers()
    render(<App />)
    await act(async () => undefined)

    act(() => editor().apply((doc) => ({ ...doc, name: 'Riverside Hall' }), 'Rename project'))
    expect(editor().dirty).toBe(true)

    // Not on every keystroke: saving a venue with a traced floor plan in it is
    // not free, and the user is still typing.
    act(() => vi.advanceTimersByTime(1900))
    expect(vi.mocked(saveProject)).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(100))
    expect(vi.mocked(saveProject)).toHaveBeenCalledWith(editor().document)

    await act(async () => undefined)
    // Remembered as the project to reopen, and no longer unsaved.
    expect(vi.mocked(rememberLastProject)).toHaveBeenCalledWith(editor().document.id)
    expect(editor().dirty).toBe(false)
  })
})
