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
import { RoomTool, WallTool } from './drawTools'
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
  over: { settings?: Partial<DocumentSettings>; options?: Partial<ToolOptions> } = {},
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

  const ctx: ToolContext = {
    get document() {
      return history.present.value
    },
    options: { ...TOOL_OPTIONS, ...over.options },
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
    // Snapping has its own suite; here it is the identity so that the geometry
    // a test asserts is the geometry the tool computed, not the grid's.
    snap(point, options) {
      snapRequests.push(options ?? {})
      return { point: { ...point }, kind: 'none', guides: [] }
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
