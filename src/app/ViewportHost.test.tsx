/**
 * @vitest-environment jsdom
 */

/**
 * The bridge between the stores and the imperative viewport.
 *
 * The viewport needs WebGL, which jsdom does not have, so it is replaced by a
 * stand-in that keeps the one piece of derived state the bridge reads back out
 * of it: the rooms it found in the last plan it was handed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { ViewportHost, type ViewportHandle } from './ViewportHost'
import { ErrorBoundary } from './ErrorBoundary'
import { WebGLUnavailableError } from '../render/webgl'
import { useEditor } from '../state/editorStore'
import { createHistory } from '../core/document/history'
import { createDocument } from '../core/model/defaults'
import { detectRooms, type Room } from '../core/model/rooms'
import { PlanBuilder } from '../library/planBuilder'
import type { Label } from '../render/LabelLayer'
import type { CrowdDocument } from '../core/model/types'

const published = vi.hoisted(() => ({
  labels: [] as Label[][],
  refreshes: 0,
  noGpu: false,
  views: [] as string[],
  orbit: null as (() => void) | null,
}))

vi.mock('../render/Viewport', () => ({
  Viewport: class {
    constructor() {
      if (published.noGpu)
        throw new WebGLUnavailableError(new Error('Error creating WebGL context.'))
    }
    crowdLayer = { add: () => {} }
    overlayLayer = { add: () => {} }
    canvas = document.createElement('canvas')
    rooms: Room[] = []
    setDocument(doc: CrowdDocument) {
      this.rooms = detectRooms(doc.plan.walls)
    }
    setLabels(labels: Label[]) {
      published.labels.push(labels)
    }
    frame() {}
    restoreCamera() {}
    cameraSnapshot() {
      return ''
    }
    setSelection() {}
    setTheme() {}
    setGridVisible() {}
    setPlanOptions() {}
    setView(preset: string) {
      published.views.push(preset)
    }
    set onOrbit(handler: (() => void) | null) {
      published.orbit = handler
    }
    setContinuous() {}
    invalidate() {}
    dispose() {}
  },
}))

vi.mock('../editor/ToolController', () => ({
  ToolController: class {
    refresh() {
      published.refreshes++
    }
    setTool() {}
  },
}))

vi.mock('../render/crowd/CrowdRenderer', () => ({
  CrowdRenderer: class {
    group = {}
    clear() {}
    update() {}
    dispose() {}
  },
}))

vi.mock('../render/overlays/DensityOverlay', () => ({
  DensityOverlay: class {
    mesh = {}
    setGrid() {}
    setFacility() {}
    setSafetyOverlay() {}
    setVisible() {}
    update() {}
    dispose() {}
  },
}))

const hall = (): CrowdDocument => {
  const b = new PlanBuilder()
  b.room(0, 0, 10, 8)
  return { ...createDocument('Hall'), plan: b.build() }
}

const open = (doc: CrowdDocument) =>
  useEditor.setState({
    document: doc,
    history: createHistory(doc),
    tool: 'select',
    view: { ...useEditor.getState().view, showRoomLabels: true },
  })

const mount = (wrapper?: typeof ErrorBoundary) =>
  render(
    <ViewportHost
      handleRef={{ current: { viewport: null, controller: null } as ViewportHandle }}
      colorMode="state"
      showHeatmap={false}
      heatmapFacility="walkway"
      showSafety={false}
      onPickPerson={() => {}}
    />,
    { wrapper },
  )

afterEach(() => {
  published.labels = []
  published.refreshes = 0
  published.noGpu = false
  published.views = []
  published.orbit = null
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('room labels', () => {
  it('labels the rooms of the plan on screen, not the one before it', () => {
    const doc = hall()
    open(doc)
    mount()

    // They were read during render, before the viewport had been handed the
    // plan: a venue opened with no labels on it, and one emptied afterwards
    // kept the old room's floor area over bare ground.
    expect(published.labels.at(-1)?.map((label) => [label.variant, label.text])).toEqual([
      ['area', '80 m²'],
    ])

    act(() => useEditor.getState().replaceDocument(createDocument(), 'New project'))
    expect(published.labels.at(-1)).toEqual([])
  })
})

describe('the tool in hand', () => {
  it('redraws when the selection changes and the plan does not', () => {
    const doc = hall()
    open(doc)
    mount()
    const before = published.refreshes

    // Cmd-A changes only the selection, and the rotate ring it should have
    // drawn did not appear until the pointer moved.
    act(() => useEditor.getState().setSelection([{ kind: 'wall', id: doc.plan.walls[0].id }]))

    expect(published.refreshes).toBe(before + 1)
  })
})

describe('the named views', () => {
  it('takes the view off the lit button once the camera is turned by hand', () => {
    open(hall())
    act(() => useEditor.getState().setView({ preset: 'plan' }))
    mount()
    expect(published.views).toEqual(['plan'])

    // After an orbit the Plan button stayed lit, and clicking it again changed
    // nothing, so it did nothing until another view had been picked first.
    act(() => published.orbit?.())
    expect(useEditor.getState().view.preset).toBeNull()

    act(() => useEditor.getState().setView({ preset: 'plan' }))
    expect(published.views).toEqual(['plan', 'plan'])
  })

  it('leaves a camera restored from the last visit where it was', () => {
    localStorage.setItem('crowd:camera', '{}')
    open(hall())
    act(() => useEditor.getState().setView({ preset: 'iso' }))
    mount()

    // The 3D view was applied on top of the restored camera and swung it back.
    expect(published.views).toEqual([])
    expect(useEditor.getState().view.preset).toBeNull()
  })
})

describe('a browser with no WebGL 2', () => {
  it('reaches the crash screen that says so', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    published.noGpu = true
    open(hall())

    mount(ErrorBoundary)

    // The viewport is built in an effect, and an effect that throws still
    // reaches the boundary; the screen it reaches has to be the right one.
    expect(screen.getByText('CROWD needs WebGL 2')).toBeDefined()
  })
})

describe('a browser that blocks site data', () => {
  it('builds the viewport with the default view rather than falling over', () => {
    // Blocked storage throws on a read instead of returning nothing.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    })
    open(hall())

    const { unmount } = mount()
    expect(published.labels.at(-1)).toHaveLength(1)
    unmount()
  })
})
