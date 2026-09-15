/**
 * The wall and room tools, driven the way the viewport drives them.
 *
 * A tool reaches the world only through its `ToolContext`, so the fake one here
 * records every request and keeps a *real* undo history behind `apply`/`seal`.
 * Counting `history.past` is the only honest way to check the invariant that a
 * gesture costs one undo step — a mock that just counts calls cannot see
 * coalescing at all.
 */

import { describe, expect, it } from 'vitest'
import { MeasureTool, RoomTool, WallTool, ZoneTool } from './drawTools'
import { createDocument } from '../../core/model/defaults'
import {
  createHistory,
  commit as commitHistory,
  seal as sealHistory,
  undo as undoHistory,
} from '../../core/document/history'
import {
  DEFAULT_DOOR_HEIGHT,
  DEFAULT_DOOR_WIDTH,
  DEFAULT_WALL_HEIGHT,
  DEFAULT_WALL_THICKNESS,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_SILL,
  DEFAULT_WINDOW_WIDTH,
} from '../../core/model/standards'
import { distance } from '../../core/math/vec2'
import { polygonArea } from '../../core/math/geometry'
import type { Vec2 } from '../../core/math/vec2'
import type { CrowdDocument, DocumentSettings, Wall } from '../../core/model/types'
import type { DraftShape, PointerInfo } from '../../render/Viewport'
import type { Label } from '../../render/LabelLayer'
import type { SnapOptions } from '../snapping'
import type { ToolContext } from '../types'
import type { ToolId, ToolOptions } from '../../state/editorStore'

const TOOL_OPTIONS: ToolOptions = {
  catalogId: 'table-round-6',
  zoneKind: 'entry',
  wallKind: 'wall',
  wallThickness: DEFAULT_WALL_THICKNESS,
  wallHeight: DEFAULT_WALL_HEIGHT,
  doorWidth: DEFAULT_DOOR_WIDTH,
  doorHeight: DEFAULT_DOOR_HEIGHT,
  windowWidth: DEFAULT_WINDOW_WIDTH,
  windowHeight: DEFAULT_WINDOW_HEIGHT,
  windowSill: DEFAULT_WINDOW_SILL,
}

/** Zoomed to about a metre across 100 px, as the default camera roughly is. */
const METRES_PER_PIXEL = 0.01

interface AppliedEdit {
  label: string
  coalesceKey: string | undefined
}

const harness = (
  over: {
    settings?: Partial<DocumentSettings>
    options?: Partial<ToolOptions>
    /** Stand-in for `snapping.ts`, so a test can see where a point was moved to. */
    snap?: (point: Vec2, request: Partial<SnapOptions>) => Vec2
  } = {},
) => {
  const base = createDocument('draw fixture')
  let history = createHistory<CrowdDocument>({
    ...base,
    settings: { ...base.settings, ...over.settings },
  })
  const edits: AppliedEdit[] = []
  const snapRequests: Array<Partial<SnapOptions>> = []
  const toolSwitches: ToolId[] = []
  const toasts: string[] = []
  let seals = 0
  let draft: DraftShape[] = []
  let labels: Label[] = []

  let toolOptions: ToolOptions = { ...TOOL_OPTIONS, ...over.options }

  const ctx: ToolContext = {
    get document() {
      return history.present.value
    },
    get options() {
      return toolOptions
    },
    selection: [],
    scale: METRES_PER_PIXEL,
    apply(mutate, label, coalesceKey) {
      // Mirrors the store: a mutation that changes nothing writes no history.
      const next = mutate(history.present.value)
      if (next === history.present.value) return
      history = commitHistory(history, next, label, coalesceKey)
      edits.push({ label, coalesceKey })
    },
    seal() {
      history = sealHistory(history)
      seals += 1
    },
    // Snapping has its own suite; here it is the identity unless a test asks for
    // something else, so the geometry a test asserts is the geometry the tool
    // computed rather than whatever the real grid does this week.
    snap(point, request) {
      snapRequests.push(request ?? {})
      const moved = over.snap ? over.snap(point, request ?? {}) : { ...point }
      return { point: moved, kind: 'none', guides: [] }
    },
    worldToScreen: (point) => ({ x: point.x, y: point.y }),
    setDraft(shapes) {
      draft = shapes
    },
    setLabels(next) {
      labels = next
    },
    setSelection: () => {},
    toggleSelection: () => {},
    setHint: () => {},
    setTool(tool) {
      toolSwitches.push(tool)
    },
    toast(message) {
      toasts.push(message)
    },
  }

  return {
    ctx,
    edits,
    snapRequests,
    toolSwitches,
    toasts,
    seals: () => seals,
    draft: () => draft,
    labels: () => labels,
    doc: () => history.present.value,
    walls: () => history.present.value.plan.walls,
    zones: () => history.present.value.plan.zones,
    setOptions: (patch: Partial<ToolOptions>) => {
      toolOptions = { ...toolOptions, ...patch }
    },
    undoSteps: () => history.past.length,
    undo: () => {
      history = undoHistory(history)
    },
  }
}

const pointer = (x: number, y: number, over: Partial<PointerInfo> = {}): PointerInfo => ({
  ground: { x, y },
  screenX: 0,
  screenY: 0,
  button: 0,
  buttons: 1,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  hit: null,
  scale: METRES_PER_PIXEL,
  ...over,
})

/** The tools read `event.key` and nothing else; `node` has no KeyboardEvent. */
const press = (key: string): KeyboardEvent => ({ key }) as unknown as KeyboardEvent

const type = (tool: WallTool, ctx: ToolContext, text: string): boolean[] =>
  [...text].map((character) => tool.onKeyDown(press(character), ctx))

const ends = (wall: Wall): [Vec2, Vec2] => [wall.a, wall.b]

describe('WallTool chains click by click', () => {
  it('shows a draft but writes nothing until a second point exists', () => {
    const h = harness()
    const tool = new WallTool()
    const before = h.doc()

    tool.onActivate(h.ctx)
    tool.onPointerMove(pointer(1, 1), h.ctx)
    tool.onPointerDown(pointer(2, 1), h.ctx)
    tool.onPointerMove(pointer(5, 1), h.ctx)

    expect(h.doc()).toBe(before)
    expect(h.edits).toEqual([])
    expect(h.draft().length).toBeGreaterThan(0)
  })

  it('closes each segment behind the pointer, sharing the endpoints', () => {
    const h = harness()
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerDown(pointer(4, 0), h.ctx)
    tool.onPointerDown(pointer(4, 3), h.ctx)

    const walls = h.walls()
    expect(walls).toHaveLength(2)
    expect(ends(walls[0])).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
    ])
    // A chain is only a chain if the corner is one point, not two 3 mm apart.
    expect(walls[1].a).toEqual(walls[0].b)
    expect(walls[1].b).toEqual({ x: 4, y: 3 })
  })

  it('discards a second click that lands on the anchor', () => {
    const h = harness()
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerDown(pointer(0.02, 0.02), h.ctx)
    tool.onPointerDown(pointer(3, 0), h.ctx)

    // The stray click is dropped whole: the anchor stays where it was, so the
    // wall runs from the original point rather than from the jitter.
    expect(h.walls()).toHaveLength(1)
    expect(ends(h.walls()[0])).toEqual([
      { x: 0, y: 0 },
      { x: 3, y: 0 },
    ])
  })

  it('asks for the document angle snap and honours Alt', () => {
    const h = harness()
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    h.snapRequests.length = 0
    tool.onPointerMove(pointer(3, 1, { altKey: true }), h.ctx)

    expect(h.snapRequests.length).toBeGreaterThan(0)
    for (const request of h.snapRequests) {
      expect(request.angleSnapDeg).toBe(h.ctx.document.settings.angleSnapDeg)
      expect(request.disabled).toBe(true)
      expect(request.anchor).toEqual({ x: 0, y: 0 })
    }
  })
})

describe('ending a wall chain', () => {
  it('clears the chain on Escape so the next click starts a fresh one', () => {
    const h = harness()
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerDown(pointer(4, 0), h.ctx)
    expect(tool.onKeyDown(press('Escape'), h.ctx)).toBe(true)

    expect(h.draft()).toEqual([])
    expect(h.labels()).toEqual([])

    tool.onPointerDown(pointer(9, 9), h.ctx)
    // Nothing joins the abandoned chain to the new one.
    expect(h.walls()).toHaveLength(1)

    tool.onPointerDown(pointer(9, 12), h.ctx)
    expect(ends(h.walls()[1])).toEqual([
      { x: 9, y: 9 },
      { x: 9, y: 12 },
    ])
  })

  it('lets Escape through when there is no chain to cancel', () => {
    const h = harness()
    const tool = new WallTool()

    // Unconsumed, so the editor's own Escape (drop the selection) still fires.
    expect(tool.onKeyDown(press('Escape'), h.ctx)).toBe(false)
  })

  it('ends the chain on Enter when nothing has been typed', () => {
    const h = harness()
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerDown(pointer(4, 0), h.ctx)
    expect(tool.onKeyDown(press('Enter'), h.ctx)).toBe(true)

    tool.onPointerDown(pointer(8, 0), h.ctx)
    expect(h.walls()).toHaveLength(1)
  })

  it('ends the chain on a double-click', () => {
    const h = harness()
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerDown(pointer(4, 0), h.ctx)
    tool.onDoubleClick(pointer(4, 0), h.ctx)

    expect(h.draft()).toEqual([])
    tool.onPointerDown(pointer(8, 0), h.ctx)
    expect(h.walls()).toHaveLength(1)
  })

  it('swallows Enter even with no chain in progress', () => {
    const h = harness()
    const tool = new WallTool()

    // Asymmetric with Escape above, which passes through when idle. Recorded
    // rather than endorsed: an idle wall tool eats a global Enter shortcut.
    expect(tool.onKeyDown(press('Enter'), h.ctx)).toBe(true)
  })
})

describe('WallTool typed length', () => {
  it('places a wall of exactly the typed length once the pointer names a direction', () => {
    const h = harness()
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    expect(type(tool, h.ctx, '4.5')).toEqual([true, true, true])
    // Slightly off axis: the direction comes from the pointer, the length does not.
    tool.onPointerMove(pointer(10, 0.3), h.ctx)
    expect(tool.onKeyDown(press('Enter'), h.ctx)).toBe(true)

    expect(h.walls()).toHaveLength(1)
    const wall = h.walls()[0]
    expect(wall.a).toEqual({ x: 0, y: 0 })
    expect(wall.b.x).toBeCloseTo(4.5, 9)
    expect(wall.b.y).toBeCloseTo(0, 9)

    // Enter keeps the chain alive from the point it just placed.
    tool.onPointerMove(pointer(4.5, 6), h.ctx)
    tool.onPointerDown(pointer(4.5, 6), h.ctx)
    expect(h.walls()[1].a.x).toBeCloseTo(4.5, 9)
  })

  it('reads a bare number in the document units', () => {
    const h = harness({ settings: { units: 'imperial' } })
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    type(tool, h.ctx, '10')
    tool.onPointerMove(pointer(10, 0), h.ctx)
    tool.onKeyDown(press('Enter'), h.ctx)

    // 10 typed in an imperial document is ten feet; the document stays metric.
    expect(h.walls()[0].b.x).toBeCloseTo(3.048, 9)
  })

  it('accepts a unit suffix typed after the number', () => {
    const h = harness()
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    expect(type(tool, h.ctx, '250cm')).toEqual([true, true, true, true, true])
    tool.onPointerMove(pointer(10, 0), h.ctx)
    tool.onKeyDown(press('Enter'), h.ctx)

    expect(h.walls()[0].b.x).toBeCloseTo(2.5, 9)
  })

  it('rounds the direction to the angle snap, and leaves it raw when the snap is off', () => {
    const snapped = harness()
    const snappedTool = new WallTool()
    snappedTool.onPointerDown(pointer(0, 0), snapped.ctx)
    type(snappedTool, snapped.ctx, '4.5')
    // atan2(3.64, 10) is 20.03°, which rounds to the 15° step.
    snappedTool.onPointerMove(pointer(10, 3.64), snapped.ctx)
    snappedTool.onKeyDown(press('Enter'), snapped.ctx)

    const wall = snapped.walls()[0]
    expect(wall.b.x).toBeCloseTo(4.5 * Math.cos(Math.PI / 12), 9)
    expect(wall.b.y).toBeCloseTo(4.5 * Math.sin(Math.PI / 12), 9)

    const free = harness({ settings: { angleSnapDeg: 0 } })
    const freeTool = new WallTool()
    freeTool.onPointerDown(pointer(0, 0), free.ctx)
    type(freeTool, free.ctx, '4.5')
    freeTool.onPointerMove(pointer(10, 3.64), free.ctx)
    freeTool.onKeyDown(press('Enter'), free.ctx)

    const raw = free.walls()[0]
    expect(Math.atan2(raw.b.y, raw.b.x)).toBeCloseTo(Math.atan2(3.64, 10), 9)
    expect(distance(raw.a, raw.b)).toBeCloseTo(4.5, 9)
  })

  it('SUSPECTED BUG: keeps snapping the typed direction while Alt is held', () => {
    const h = harness()
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    type(tool, h.ctx, '4.5')
    tool.onPointerMove(pointer(10, 3.64, { altKey: true }), h.ctx)
    tool.onKeyDown(press('Enter'), h.ctx)

    // Alt suspends snapping everywhere else (SnapOptions.disabled), but the
    // typed-length branch of resolvePoint never looks at info.altKey, so an
    // exact 20.03° wall cannot be drawn by length at all.
    expect(h.walls()[0].b.y).toBeCloseTo(4.5 * Math.sin(Math.PI / 12), 9)
  })

  it('leaves digits alone until a wall has been started', () => {
    const h = harness()
    const tool = new WallTool()

    // Otherwise the tool would eat the number-row tool shortcuts when idle.
    expect(tool.onKeyDown(press('4'), h.ctx)).toBe(false)
  })

  it('leaves letters alone when no number has been typed', () => {
    const h = harness()
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    // `w`, `r`, `m` are tool shortcuts; only a unit suffix after digits is ours.
    expect(tool.onKeyDown(press('w'), h.ctx)).toBe(false)
    expect(type(tool, h.ctx, '2')).toEqual([true])
    expect(tool.onKeyDown(press('m'), h.ctx)).toBe(true)
  })

  it('edits the typed number with Backspace before touching the chain', () => {
    const h = harness()
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    type(tool, h.ctx, '49')
    expect(tool.onKeyDown(press('Backspace'), h.ctx)).toBe(true)
    tool.onPointerMove(pointer(10, 0), h.ctx)
    tool.onKeyDown(press('Enter'), h.ctx)

    expect(h.walls()[0].b.x).toBeCloseTo(4, 9)
  })

  it('SUSPECTED BUG: Backspace drops a chain point but keeps its committed wall', () => {
    const h = harness()
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerDown(pointer(4, 0), h.ctx)
    tool.onPointerDown(pointer(4, 3), h.ctx)
    expect(h.walls()).toHaveLength(2)

    expect(tool.onKeyDown(press('Backspace'), h.ctx)).toBe(true)
    // The point leaves the preview but the wall stays in the document, so the
    // segment the user just "took back" is still there — and the next click
    // draws a second wall out of the same corner.
    expect(h.walls()).toHaveLength(2)

    tool.onPointerDown(pointer(8, 0), h.ctx)
    expect(h.walls()).toHaveLength(3)
    expect(ends(h.walls()[1])).toEqual([
      { x: 4, y: 0 },
      { x: 4, y: 3 },
    ])
    expect(h.walls()[2].a).toEqual({ x: 4, y: 0 })
  })

  it('SUSPECTED BUG: Enter straight after typing commits a zero-length wall', () => {
    const h = harness()
    const tool = new WallTool()

    // Exactly what the README advertises: click, type a length, press Enter.
    tool.onPointerDown(pointer(0, 0), h.ctx)
    type(tool, h.ctx, '4.5')
    expect(tool.onKeyDown(press('Enter'), h.ctx)).toBe(true)

    // The Enter branch commits `this.preview`, which typing never recomputes;
    // with no pointer move since the click it is still the anchor. A degenerate
    // wall reaches the document, and the 5 cm guard on onPointerDown does not
    // cover this path.
    expect(h.walls()).toHaveLength(1)
    expect(h.walls()[0].a).toEqual(h.walls()[0].b)
    expect(distance(h.walls()[0].a, h.walls()[0].b)).toBe(0)
  })

  it('SUSPECTED BUG: Enter uses the pointer distance, not the number just typed', () => {
    const h = harness()
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerMove(pointer(2, 0), h.ctx)
    type(tool, h.ctx, '4.5')
    tool.onKeyDown(press('Enter'), h.ctx)

    // Typing does not re-resolve the preview, so the wall is as long as the
    // cursor happened to be. The tool even says so on screen first.
    expect(distance(h.walls()[0].a, h.walls()[0].b)).toBeCloseTo(2, 9)
  })

  it('SUSPECTED BUG: the preview label shows the typed value beside a different length', () => {
    const h = harness()
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerMove(pointer(2, 0), h.ctx)
    type(tool, h.ctx, '4.5')

    expect(h.labels()).toHaveLength(1)
    expect(h.labels()[0].text).toBe('4.5 → 2.00 m  ·  0°')
  })
})

describe('RoomTool turns one drag into a room', () => {
  it('builds four closed walls from a single drag', () => {
    const h = harness()
    const tool = new RoomTool()

    tool.onPointerDown(pointer(1, 2), h.ctx)
    tool.onPointerMove(pointer(7, 6), h.ctx)
    tool.onPointerUp(pointer(7, 6), h.ctx)

    const walls = h.walls()
    expect(walls).toHaveLength(4)
    expect(walls.map((wall) => wall.a)).toEqual([
      { x: 1, y: 2 },
      { x: 7, y: 2 },
      { x: 7, y: 6 },
      { x: 1, y: 6 },
    ])
    // Closed: every wall starts where the previous one ended.
    for (let i = 0; i < 4; i++) expect(walls[i].b).toEqual(walls[(i + 1) % 4].a)
    expect(walls.reduce((sum, wall) => sum + distance(wall.a, wall.b), 0)).toBeCloseTo(20, 9)
  })

  it('keeps the document untouched until the pointer comes up', () => {
    const h = harness()
    const tool = new RoomTool()
    const before = h.doc()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerMove(pointer(2, 2), h.ctx)
    tool.onPointerMove(pointer(5, 4), h.ctx)
    tool.onPointerMove(pointer(6, 5), h.ctx)

    expect(h.doc()).toBe(before)
    expect(h.edits).toEqual([])
    expect(h.draft()).toHaveLength(1)
    expect(h.labels()[0].text).toBe('6.00 m × 5.00 m\n30 m²')

    tool.onPointerUp(pointer(6, 5), h.ctx)
    expect(h.walls()).toHaveLength(4)
    expect(h.draft()).toEqual([])
    expect(h.labels()).toEqual([])
  })

  it('takes the wall spec from the tool options', () => {
    const h = harness({ options: { wallKind: 'partition' } })
    const tool = new RoomTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerMove(pointer(4, 4), h.ctx)
    tool.onPointerUp(pointer(4, 4), h.ctx)

    for (const wall of h.walls()) {
      expect(wall.kind).toBe('partition')
      expect(wall.thickness).toBe(DEFAULT_WALL_THICKNESS)
      expect(wall.height).toBe(DEFAULT_WALL_HEIGHT)
    }
  })

  it('hands back to the select tool once the room exists', () => {
    const h = harness()
    const tool = new RoomTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerMove(pointer(4, 4), h.ctx)
    tool.onPointerUp(pointer(4, 4), h.ctx)

    expect(h.toolSwitches).toEqual(['select'])
  })

  it('squares the rectangle while Shift is held', () => {
    const h = harness()
    const tool = new RoomTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerMove(pointer(6, 2, { shiftKey: true }), h.ctx)
    tool.onPointerUp(pointer(6, 2, { shiftKey: true }), h.ctx)

    const walls = h.walls()
    expect(walls).toHaveLength(4)
    const lengths = walls.map((wall) => distance(wall.a, wall.b))
    for (const length of lengths) expect(length).toBeCloseTo(6, 9)
  })

  it('forwards Alt to the snap so the room can ignore the grid', () => {
    const h = harness()
    const tool = new RoomTool()

    tool.onPointerDown(pointer(0, 0, { altKey: true }), h.ctx)
    tool.onPointerMove(pointer(3.17, 4.42, { altKey: true }), h.ctx)

    expect(h.snapRequests).toHaveLength(2)
    for (const request of h.snapRequests) expect(request.disabled).toBe(true)
  })

  it('abandons a drag in progress on Escape', () => {
    const h = harness()
    const tool = new RoomTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerMove(pointer(6, 5), h.ctx)
    expect(tool.onKeyDown(press('Escape'), h.ctx)).toBe(true)
    tool.onPointerUp(pointer(6, 5), h.ctx)

    expect(h.walls()).toEqual([])
    expect(h.draft()).toEqual([])
  })
})

describe('a degenerate drag produces nothing rather than a broken room', () => {
  it('ignores a click with no drag behind it', () => {
    const h = harness()
    const tool = new RoomTool()
    const before = h.doc()

    tool.onPointerDown(pointer(3, 3), h.ctx)
    tool.onPointerUp(pointer(3, 3), h.ctx)

    expect(h.doc()).toBe(before)
    expect(h.edits).toEqual([])
    // Still the room tool: the user gets to try again without re-picking it.
    expect(h.toolSwitches).toEqual([])
  })

  it('ignores a drag thinner than the degenerate threshold', () => {
    const h = harness()
    const tool = new RoomTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerMove(pointer(0.25, 5), h.ctx)
    tool.onPointerUp(pointer(0.25, 5), h.ctx)

    // 0.25 m of width loses the whole 5 m room, and silently — worth knowing
    // if a user ever reports a room that did not appear.
    expect(h.walls()).toEqual([])
    expect(h.toasts).toEqual([])
  })

  it('SUSPECTED BUG: Shift plus a straight-up drag collapses the room to nothing', () => {
    const h = harness()
    const tool = new RoomTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerMove(pointer(0, 5, { shiftKey: true }), h.ctx)
    tool.onPointerUp(pointer(0, 5, { shiftKey: true }), h.ctx)

    // The square constraint multiplies the side by Math.sign(dx), which is 0
    // when the pointer has not moved horizontally — and grid snapping makes an
    // exactly vertical drag common. A 5 m square is dropped instead of drawn.
    expect(h.walls()).toEqual([])
  })

  it('does not release a zero-area room through the draft either', () => {
    const h = harness()
    const tool = new RoomTool()

    tool.onPointerDown(pointer(2, 2), h.ctx)
    tool.onPointerMove(pointer(2, 2), h.ctx)
    tool.onPointerUp(pointer(2, 2), h.ctx)

    expect(h.walls()).toEqual([])
    expect(h.undoSteps()).toBe(0)
  })
})

describe('a gesture is one undo step', () => {
  it('collapses a whole room into a single step', () => {
    const h = harness()
    const tool = new RoomTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerMove(pointer(3, 3), h.ctx)
    tool.onPointerMove(pointer(6, 4), h.ctx)
    tool.onPointerUp(pointer(6, 4), h.ctx)

    expect(h.edits.map((edit) => edit.label)).toEqual(['Draw room'])
    expect(h.undoSteps()).toBe(1)
    expect(h.seals()).toBe(1)

    h.undo()
    // One undo, and all four walls go — not three of them.
    expect(h.walls()).toEqual([])
  })

  it('SUSPECTED BUG: a wall chain costs one undo step per segment', () => {
    const h = harness()
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerDown(pointer(4, 0), h.ctx)
    tool.onPointerDown(pointer(4, 3), h.ctx)
    tool.onPointerDown(pointer(0, 3), h.ctx)
    tool.onKeyDown(press('Escape'), h.ctx)

    // AGENTS.md: "A gesture is one undo step: pass a coalesceKey while it runs
    // and seal it when it ends." commitSegment passes no key and seals after
    // every segment, so the chain is three steps and three undos.
    expect(h.edits.map((edit) => edit.coalesceKey)).toEqual([undefined, undefined, undefined])
    expect(h.seals()).toBe(3)
    expect(h.undoSteps()).toBe(3)

    h.undo()
    expect(h.walls()).toHaveLength(2)
  })
})

/**
 * A snap the tests can watch: every point lands on a quarter-metre lattice.
 *
 * Deliberately not the document's own 0.5 m grid, so the only way an assertion
 * below can pass is if the tool really routed the point through `ctx.snap` —
 * and it stays true whatever `snapping.ts` decides a snap is.
 */
const LATTICE = 0.25
const latticeSnap = (point: Vec2, request: Partial<SnapOptions>): Vec2 =>
  request.disabled
    ? { ...point }
    : {
        x: Math.round(point.x / LATTICE) * LATTICE,
        y: Math.round(point.y / LATTICE) * LATTICE,
      }

describe('snapping reaches the document, not just the preview', () => {
  it('writes the wall to the corners the preview drew, not to the pixels clicked', () => {
    const h = harness({ snap: latticeSnap })
    const tool = new WallTool()

    tool.onPointerDown(pointer(1.06, 0.94), h.ctx)
    tool.onPointerMove(pointer(4.94, 1.06), h.ctx)
    tool.onPointerDown(pointer(4.94, 1.06), h.ctx)

    expect(ends(h.walls()[0])).toEqual([
      { x: 1, y: 1 },
      { x: 5, y: 1 },
    ])
    // The point of snapping: the wall is a round 4 m, not 3.88 m of hand jitter.
    expect(distance(h.walls()[0].a, h.walls()[0].b)).toBe(4)

    tool.onPointerDown(pointer(7.94, 1.02), h.ctx)
    // The chain continues from the snapped corner, so the two walls still meet.
    expect(h.walls()[1].a).toEqual(h.walls()[0].b)
  })

  it('builds the room out of snapped corners', () => {
    const h = harness({ snap: latticeSnap })
    const tool = new RoomTool()

    tool.onPointerDown(pointer(1.06, 1.94), h.ctx)
    tool.onPointerMove(pointer(6.91, 5.06), h.ctx)
    tool.onPointerUp(pointer(6.91, 5.06), h.ctx)

    expect(h.walls().map((wall) => wall.a)).toEqual([
      { x: 1, y: 2 },
      { x: 7, y: 2 },
      { x: 7, y: 5 },
      { x: 1, y: 5 },
    ])
    expect(h.walls().reduce((sum, wall) => sum + distance(wall.a, wall.b), 0)).toBe(18)
  })

  it('writes the zone on the same corners it outlined', () => {
    const h = harness({ snap: latticeSnap })
    const tool = new ZoneTool()

    tool.onPointerDown(pointer(2.06, 0.94), h.ctx)
    tool.onPointerMove(pointer(7.94, 5.06), h.ctx)
    tool.onPointerUp(pointer(7.94, 5.06), h.ctx)

    expect(h.zones()[0].polygon).toEqual([
      { x: 2, y: 1 },
      { x: 8, y: 1 },
      { x: 8, y: 5 },
      { x: 2, y: 5 },
    ])
  })

  it('puts the room exactly under the pointer while Alt is held', () => {
    const h = harness({ snap: latticeSnap })
    const tool = new RoomTool()

    tool.onPointerDown(pointer(1.06, 1.94, { altKey: true }), h.ctx)
    tool.onPointerMove(pointer(6.91, 5.06, { altKey: true }), h.ctx)
    tool.onPointerUp(pointer(6.91, 5.06, { altKey: true }), h.ctx)

    // Alt is how you draw the one thing that is not on the grid; a room that
    // snapped anyway on release would make it useless.
    expect(h.walls()[0].a.x).toBeCloseTo(1.06, 9)
    expect(h.walls()[0].a.y).toBeCloseTo(1.94, 9)
    expect(h.walls()[2].a.x).toBeCloseTo(6.91, 9)
    expect(h.walls()[2].a.y).toBeCloseTo(5.06, 9)
  })
})

describe('ZoneTool drags out an area', () => {
  it('writes one closed, named area of the chosen kind', () => {
    const h = harness()
    const tool = new ZoneTool()

    tool.onPointerDown(pointer(2, 1), h.ctx)
    tool.onPointerMove(pointer(5, 3), h.ctx)
    tool.onPointerMove(pointer(8, 5), h.ctx)
    tool.onPointerUp(pointer(8, 5), h.ctx)

    expect(h.zones()).toHaveLength(1)
    const zone = h.zones()[0]
    expect(zone.kind).toBe('entry')
    expect(zone.name).toBe('Entry 1')
    expect(zone.polygon).toEqual([
      { x: 2, y: 1 },
      { x: 8, y: 1 },
      { x: 8, y: 5 },
      { x: 2, y: 5 },
    ])
    expect(polygonArea(zone.polygon)).toBeCloseTo(24, 9)
    // Three pointer moves, one thing to undo.
    expect(h.edits.map((edit) => edit.label)).toEqual(['Add entry'])
    expect(h.undoSteps()).toBe(1)
    expect(h.seals()).toBe(1)
  })

  it('shows the area growing but writes nothing until the pointer lifts', () => {
    const h = harness()
    const tool = new ZoneTool()
    const before = h.doc()

    tool.onPointerDown(pointer(2, 1), h.ctx)
    tool.onPointerMove(pointer(8, 5), h.ctx)

    expect(h.doc()).toBe(before)
    expect(h.edits).toEqual([])
    expect(h.draft()).toHaveLength(1)
    expect(h.draft()[0].kind).toBe('rect')
    expect(h.labels()[0].text).toBe('Entry\n24 m²')

    tool.onPointerUp(pointer(8, 5), h.ctx)
    expect(h.draft()).toEqual([])
    expect(h.labels()).toEqual([])
  })

  it('stays on the tool and numbers each kind on its own', () => {
    const h = harness()
    const tool = new ZoneTool()
    const drag = (x: number, y: number) => {
      tool.onPointerDown(pointer(0, 0), h.ctx)
      tool.onPointerMove(pointer(x, y), h.ctx)
      tool.onPointerUp(pointer(x, y), h.ctx)
    }

    drag(4, 4)
    drag(6, 6)
    h.setOptions({ zoneKind: 'exit' })
    drag(8, 8)

    // Areas come in sets, so unlike the room tool this one does not hand back
    // to select; and an exit is the first exit even though it is the third zone.
    expect(h.toolSwitches).toEqual([])
    expect(h.zones().map((zone) => zone.name)).toEqual(['Entry 1', 'Entry 2', 'Exit 1'])
  })

  it('gives a keep-clear area the routing cost that makes it one', () => {
    const h = harness({ options: { zoneKind: 'keep-clear' } })
    const tool = new ZoneTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerMove(pointer(4, 3), h.ctx)
    tool.onPointerUp(pointer(4, 3), h.ctx)

    // Without the cost the region is drawn but routing walks straight through it.
    expect(h.zones()[0].cost).toBe(4)
    expect(h.zones()[0].name).toBe('Keep clear 1')
    expect(h.edits.map((edit) => edit.label)).toEqual(['Add keep clear'])

    const entry = harness()
    const entryTool = new ZoneTool()
    entryTool.onPointerDown(pointer(0, 0), entry.ctx)
    entryTool.onPointerMove(pointer(4, 3), entry.ctx)
    entryTool.onPointerUp(pointer(4, 3), entry.ctx)
    expect(entry.zones()[0].cost).toBeUndefined()
  })

  it('comes out the same whichever corner the drag started from', () => {
    const forward = harness()
    const forwardTool = new ZoneTool()
    forwardTool.onPointerDown(pointer(2, 1), forward.ctx)
    forwardTool.onPointerMove(pointer(8, 5), forward.ctx)
    forwardTool.onPointerUp(pointer(8, 5), forward.ctx)

    const backward = harness()
    const backwardTool = new ZoneTool()
    backwardTool.onPointerDown(pointer(8, 5), backward.ctx)
    backwardTool.onPointerMove(pointer(2, 1), backward.ctx)
    backwardTool.onPointerUp(pointer(2, 1), backward.ctx)

    // Winding decides which side of the polygon the simulation calls inside.
    expect(backward.zones()[0].polygon).toEqual(forward.zones()[0].polygon)

    const room = harness()
    const roomTool = new RoomTool()
    roomTool.onPointerDown(pointer(8, 5), room.ctx)
    roomTool.onPointerMove(pointer(2, 1), room.ctx)
    roomTool.onPointerUp(pointer(2, 1), room.ctx)
    expect(room.walls().map((wall) => wall.a)).toEqual([
      { x: 2, y: 1 },
      { x: 8, y: 1 },
      { x: 8, y: 5 },
      { x: 2, y: 5 },
    ])
  })

  it('abandons a drag in progress on Escape', () => {
    const h = harness()
    const tool = new ZoneTool()
    const before = h.doc()

    tool.onPointerDown(pointer(1, 1), h.ctx)
    tool.onPointerMove(pointer(7, 6), h.ctx)
    expect(tool.onKeyDown(press('Escape'), h.ctx)).toBe(true)
    tool.onPointerUp(pointer(7, 6), h.ctx)

    expect(h.doc()).toBe(before)
    expect(h.zones()).toEqual([])
    expect(h.draft()).toEqual([])
    expect(h.labels()).toEqual([])
  })
})

describe('a click rather than a drag starts a free-form outline', () => {
  /** One click: press and release without moving. */
  const click = (tool: ZoneTool, ctx: ToolContext, x: number, y: number): void => {
    tool.onPointerMove(pointer(x, y), ctx)
    tool.onPointerDown(pointer(x, y), ctx)
    tool.onPointerUp(pointer(x, y), ctx)
  }

  it('writes nothing on the click that opens it', () => {
    const h = harness()
    const tool = new ZoneTool()
    const before = h.doc()

    click(tool, h.ctx, 3, 3)

    expect(h.doc()).toBe(before)
    expect(h.zones()).toEqual([])
    expect(h.draft()[0].kind).toBe('polygon')
  })

  it('ignores Enter until three corners exist, then closes the outline in one step', () => {
    const h = harness()
    const tool = new ZoneTool()

    click(tool, h.ctx, 3, 3)
    click(tool, h.ctx, 9, 3)
    // Two corners are a line, not an area — and the editor's own Enter still works.
    expect(tool.onKeyDown(press('Enter'), h.ctx)).toBe(false)
    expect(h.zones()).toEqual([])

    click(tool, h.ctx, 9, 7)
    expect(tool.onKeyDown(press('Enter'), h.ctx)).toBe(true)

    expect(h.zones()[0].polygon).toEqual([
      { x: 3, y: 3 },
      { x: 9, y: 3 },
      { x: 9, y: 7 },
    ])
    expect(polygonArea(h.zones()[0].polygon)).toBeCloseTo(12, 9)
    expect(h.undoSteps()).toBe(1)
    expect(h.seals()).toBe(1)
    h.undo()
    expect(h.zones()).toEqual([])
  })

  it('takes back a corner with Backspace', () => {
    const h = harness()
    const tool = new ZoneTool()

    click(tool, h.ctx, 3, 3)
    click(tool, h.ctx, 9, 3)
    click(tool, h.ctx, 9, 7)
    expect(tool.onKeyDown(press('Backspace'), h.ctx)).toBe(true)

    // A corner taken back is a corner not drawn: two are left, so there is
    // nothing to close and Enter goes back to the editor.
    expect(tool.onKeyDown(press('Enter'), h.ctx)).toBe(false)
    expect(h.zones()).toEqual([])

    click(tool, h.ctx, 3, 7)
    tool.onKeyDown(press('Enter'), h.ctx)
    expect(h.zones()[0].polygon).toEqual([
      { x: 3, y: 3 },
      { x: 9, y: 3 },
      { x: 3, y: 7 },
    ])
  })

  it('SUSPECTED BUG: finishing with a double-click duplicates the corner it lands on', () => {
    const h = harness()
    const tool = new ZoneTool()

    click(tool, h.ctx, 3, 3)
    click(tool, h.ctx, 9, 3)
    // A real double-click is two pointer down/up pairs and then `dblclick`, and
    // the hint tells the user to end an outline this way.
    click(tool, h.ctx, 9, 7)
    click(tool, h.ctx, 9, 7)
    tool.onDoubleClick(pointer(9, 7), h.ctx)

    // Nothing rejects a click on the corner just placed — the wall tool drops
    // one within 5 cm — so the saved zone carries a corner twice. The select
    // tool then stacks two vertex handles on the same spot, which the user
    // cannot pull apart, and the duplicate rides into every copy and save.
    const polygon = h.zones()[0].polygon
    expect(polygon).toHaveLength(4)
    expect(polygon[3]).toEqual(polygon[2])
  })

  it('SUSPECTED BUG: two corners and a double-click commit an area with no area', () => {
    const h = harness()
    const tool = new ZoneTool()

    click(tool, h.ctx, 3, 3)
    click(tool, h.ctx, 9, 3)
    click(tool, h.ctx, 9, 3)
    tool.onDoubleClick(pointer(9, 3), h.ctx)

    // The duplicate corner counts towards the three the commit asks for, so a
    // user who double-clicks one corner too early gets a degenerate zone
    // instead of nothing. The drag path guards exactly this with its 0.2 m
    // check. In the engine a zero-area entry falls back to a single nav cell,
    // so a whole population spawns on one spot, and a zero-area measurement
    // area reports a density over no floor at all.
    expect(h.zones()).toHaveLength(1)
    expect(polygonArea(h.zones()[0].polygon)).toBe(0)
  })

  it('SUSPECTED BUG: a thin drag falls into outline mode and traps the tool there', () => {
    const h = harness()
    const tool = new ZoneTool()

    tool.onPointerDown(pointer(1, 1), h.ctx)
    tool.onPointerMove(pointer(1.1, 7), h.ctx)
    tool.onPointerUp(pointer(1.1, 7), h.ctx)

    // A 6 m drag is not a click, but anything under 20 cm on either side is
    // treated as one — so a narrow gate line cannot be drawn at all.
    expect(h.zones()).toEqual([])
    expect(h.draft()[0].kind).toBe('polygon')

    // And the tool is now holding an outline the user never asked for: pointer
    // up is dead in that mode, so no further drag can produce an area until
    // they find Escape.
    tool.onPointerDown(pointer(5, 5), h.ctx)
    tool.onPointerMove(pointer(9, 9), h.ctx)
    tool.onPointerUp(pointer(9, 9), h.ctx)
    expect(h.zones()).toEqual([])

    expect(tool.onKeyDown(press('Escape'), h.ctx)).toBe(true)
    tool.onPointerDown(pointer(5, 5), h.ctx)
    tool.onPointerMove(pointer(9, 9), h.ctx)
    tool.onPointerUp(pointer(9, 9), h.ctx)
    expect(h.zones()).toHaveLength(1)
  })
})

describe('a wall takes two clicks', () => {
  it('draws nothing from a press and drag, and finishes on the click after it', () => {
    const h = harness()
    const tool = new WallTool()
    const before = h.doc()

    tool.onPointerDown(pointer(2, 2), h.ctx)
    tool.onPointerMove(pointer(4, 2), h.ctx)
    tool.onPointerMove(pointer(5, 2), h.ctx)
    tool.onPointerUp(pointer(5, 2), h.ctx)

    // Releasing where you started would otherwise leave a wall of no length in
    // the plan; the tool commits on clicks, so a drag of any length writes
    // nothing on its own.
    expect(h.doc()).toBe(before)
    expect(h.walls()).toEqual([])
    expect(h.draft().length).toBeGreaterThan(0)

    tool.onPointerDown(pointer(5, 2), h.ctx)
    expect(h.walls()).toHaveLength(1)
    expect(ends(h.walls()[0])).toEqual([
      { x: 2, y: 2 },
      { x: 5, y: 2 },
    ])
  })
})

describe('measuring never touches the plan', () => {
  it('reports each leg and the total without writing anything to undo', () => {
    const h = harness()
    const tool = new MeasureTool()
    const before = h.doc()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerMove(pointer(3, 0), h.ctx)
    tool.onPointerDown(pointer(3, 0), h.ctx)
    tool.onPointerMove(pointer(3, 4), h.ctx)
    tool.onPointerDown(pointer(3, 4), h.ctx)
    tool.onDoubleClick(pointer(3, 4), h.ctx)

    expect(h.labels().map((label) => label.text)).toEqual(['3.00 m', '4.00 m', 'Total 7.00 m'])
    expect(h.doc()).toBe(before)
    expect(h.edits).toEqual([])
    expect(h.undoSteps()).toBe(0)

    expect(tool.onKeyDown(press('Escape'), h.ctx)).toBe(true)
    expect(h.draft()).toEqual([])
    expect(h.labels()).toEqual([])
  })

  it('SUSPECTED BUG: Alt frees the preview but the clicks still snap', () => {
    const h = harness({ snap: latticeSnap })
    const tool = new MeasureTool()

    tool.onPointerDown(pointer(1.06, 2, { altKey: true }), h.ctx)
    tool.onPointerMove(pointer(4.06, 2, { altKey: true }), h.ctx)
    tool.onPointerDown(pointer(4.06, 2, { altKey: true }), h.ctx)
    tool.onDoubleClick(pointer(4.06, 2, { altKey: true }), h.ctx)

    // `onPointerMove` passes `disabled: info.altKey` and `onPointerDown` does
    // not, so Alt-measuring an exact 3.00 m between two off-grid features
    // reports the distance between the grid points beside them instead. The
    // measure tool exists to answer "how far is that really".
    expect(h.labels()[0].text).toBe('3.00 m')
  })
})
