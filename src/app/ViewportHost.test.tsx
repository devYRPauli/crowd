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
import { act, render } from '@testing-library/react'
import { ViewportHost, type ViewportHandle } from './ViewportHost'
import { useEditor } from '../state/editorStore'
import { createHistory } from '../core/document/history'
import { createDocument } from '../core/model/defaults'
import { detectRooms, type Room } from '../core/model/rooms'
import { PlanBuilder } from '../library/planBuilder'
import type { Label } from '../render/LabelLayer'
import type { CrowdDocument } from '../core/model/types'

const published = vi.hoisted(() => ({ labels: [] as Label[][] }))

vi.mock('../render/Viewport', () => ({
  Viewport: class {
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
    setView() {}
    setContinuous() {}
    invalidate() {}
    dispose() {}
  },
}))

vi.mock('../editor/ToolController', () => ({
  ToolController: class {
    refresh() {}
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

const mount = () =>
  render(
    <ViewportHost
      handleRef={{ current: { viewport: null, controller: null } as ViewportHandle }}
      colorMode="state"
      showHeatmap={false}
      heatmapFacility="walkway"
      showSafety={false}
      onPickPerson={() => {}}
    />,
  )

afterEach(() => {
  published.labels = []
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
