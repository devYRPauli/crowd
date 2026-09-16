/**
 * The wall, room, zone and measure tools, driven the way the viewport drives them.
 *
 * A tool reaches the world only through its `ToolContext`, so the fake one here
 * records every request and keeps a *real* undo history behind `apply`/`seal`.
 * Counting `history.past` is the only honest way to check the invariant that a
 * gesture costs one undo step — a mock that just counts calls cannot see
 * coalescing at all.
 *
 * `Viewport` sends `pointerdown`, `pointerup` and `dblclick` straight through
 * to the active tool with nothing filtered, so a double-click is modelled here
 * as two down/up pairs followed by `onDoubleClick`. That is the sequence a user
 * produces, and two of the cases below — an outline corner placed twice and a
 * tape that ends on a leg of nothing — exist only in it.
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
import { removeObjects } from '../../core/document/mutations'
import type { Vec2 } from '../../core/math/vec2'
import type { CrowdDocument, DocumentSettings, Wall } from '../../core/model/types'
import type { DraftShape, PointerInfo } from '../../render/Viewport'
import type { Label } from '../../render/LabelLayer'
import type { SnapOptions } from '../snapping'
import type { Tool, ToolContext } from '../types'
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
    // The rubber band runs from the anchor to the pointer, and it is the only
    // record of the wall so far: nothing about it has reached the plan.
    expect(h.draft()).toHaveLength(1)
    expect(h.draft()[0].points).toEqual([
      { x: 2, y: 1 },
      { x: 5, y: 1 },
    ])
    expect(h.labels()[0].text).toBe('3.00 m  ·  0°')
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

  it('keeps the chain when a click misses the floor', () => {
    const h = harness()
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    // Above the horizon the ray never meets the ground plane. Losing the anchor
    // there would make a wall drawn across a wide view unfinishable.
    tool.onPointerMove(pointer(0, 0, { ground: null }), h.ctx)
    tool.onPointerDown(pointer(0, 0, { ground: null }), h.ctx)
    tool.onPointerDown(pointer(4, 0), h.ctx)

    expect(h.walls()).toHaveLength(1)
    expect(ends(h.walls()[0])).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
    ])
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

    // Just outside the same guard, and a deliberate short return still draws:
    // the rule is "the click did not move", not "short walls are not allowed".
    const short = harness()
    const shortTool = new WallTool()
    shortTool.onPointerDown(pointer(0, 0), short.ctx)
    shortTool.onPointerDown(pointer(0.06, 0), short.ctx)
    expect(short.walls()).toHaveLength(1)
    expect(distance(short.walls()[0].a, short.walls()[0].b)).toBeCloseTo(0.06, 9)
  })

  it('takes the angle step from the document, and draws where the pointer is under Alt', () => {
    // 30°, not the default 15°, so the step can only have come from the document.
    const h = harness({ settings: { angleSnapDeg: 30 }, snap: latticeSnap })
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    h.snapRequests.length = 0
    tool.onPointerMove(pointer(3.06, 1.19, { altKey: true }), h.ctx)

    expect(h.snapRequests).not.toEqual([])
    for (const request of h.snapRequests) {
      expect(request.angleSnapDeg).toBe(30)
      expect(request.anchor).toEqual({ x: 0, y: 0 })
      expect(request.disabled).toBe(true)
    }

    tool.onPointerDown(pointer(3.06, 1.19, { altKey: true }), h.ctx)
    // Alt is how the one thing that is not on the grid gets drawn, so the wall
    // that is kept has to be the one that was under the pointer.
    expect(h.walls()[0].b).toEqual({ x: 3.06, y: 1.19 })
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

    // Unconsumed, so the editor's own Escape still fires: clear the selection
    // and hand the user back to the select tool.
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

    // Asymmetric with Escape above, which passes through when idle. It costs
    // nothing today — `useKeyboard` binds no global Enter — so this is here to
    // catch the day one is added and silently stops working on this tool.
    expect(tool.onKeyDown(press('Enter'), h.ctx)).toBe(true)
  })
})

describe('Escape is how a drawing tool is left', () => {
  it('passes it on when the tool has nothing part-drawn', () => {
    const h = harness()

    // An Escape no tool claims is what clears the selection and returns the
    // user to the select tool (`useKeyboard`), and it is the only keyboard way
    // out of a drawing tool. Swallowed when there was nothing to cancel, it
    // did nothing at all however many times it was pressed.
    for (const tool of [new RoomTool(), new ZoneTool(), new MeasureTool()]) {
      expect(tool.onKeyDown(press('Escape'), h.ctx)).toBe(false)
    }
  })

  it('claims it again the moment there is something to cancel', () => {
    const h = harness()

    const room = new RoomTool()
    room.onPointerDown(pointer(1, 1), h.ctx)
    expect(room.onKeyDown(press('Escape'), h.ctx)).toBe(true)

    const zone = new ZoneTool()
    zone.onPointerDown(pointer(1, 1), h.ctx)
    expect(zone.onKeyDown(press('Escape'), h.ctx)).toBe(true)

    const measure = new MeasureTool()
    measure.onPointerDown(pointer(1, 1), h.ctx)
    expect(measure.onKeyDown(press('Escape'), h.ctx)).toBe(true)
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

  it('leaves the typed direction where the pointer put it while Alt is held', () => {
    const h = harness()
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    type(tool, h.ctx, '4.5')
    tool.onPointerMove(pointer(10, 3.64, { altKey: true }), h.ctx)
    tool.onKeyDown(press('Enter'), h.ctx)

    // The typed branch never reaches `ctx.snap`, so it has to honour Alt
    // itself. A splayed entrance wall off a measured survey is an exact length
    // at 20.03°, and with the angle step still on there was no way to draw one.
    const angle = Math.atan2(3.64, 10)
    expect(h.walls()[0].b.x).toBeCloseTo(4.5 * Math.cos(angle), 9)
    expect(h.walls()[0].b.y).toBeCloseTo(4.5 * Math.sin(angle), 9)
    expect(distance(h.walls()[0].a, h.walls()[0].b)).toBeCloseTo(4.5, 9)
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

  it('steps the chain back a corner on Backspace and leaves the wall to undo', () => {
    const h = harness()
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerDown(pointer(4, 0), h.ctx)
    tool.onPointerDown(pointer(4, 3), h.ctx)
    expect(h.walls()).toHaveLength(2)

    expect(tool.onKeyDown(press('Backspace'), h.ctx)).toBe(true)
    // Recorded decision: Backspace re-aims the chain — the anchor goes back a
    // corner so the next click starts from there — and leaves the wall already
    // drawn alone. Each segment is its own sealed undo step, so Ctrl+Z is what
    // takes one back; for Backspace to do it too the tool would have to apply a
    // compensating delete, which costs two undos to get back to where you were,
    // or reach into history, which `ToolContext` deliberately does not offer.
    // The cost is what the rest of this test pins: the segment stays in the
    // plan while the chain carries on from the corner before it.
    expect(h.walls()).toHaveLength(2)

    tool.onPointerDown(pointer(8, 0), h.ctx)
    expect(h.walls()).toHaveLength(3)
    expect(ends(h.walls()[1])).toEqual([
      { x: 4, y: 0 },
      { x: 4, y: 3 },
    ])
    expect(h.walls()[2].a).toEqual({ x: 4, y: 0 })
  })

  it('waits for a direction when Enter comes before the pointer has moved', () => {
    const h = harness()
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    type(tool, h.ctx, '4.5')
    expect(tool.onKeyDown(press('Enter'), h.ctx)).toBe(true)

    // The click is the only pointer position there has been, so there is no
    // direction to spend the number along yet. Committing the preview here put
    // a wall of no length in the plan — a hazard `objectFootprint` already
    // carries a special case for, so that one can at least be rubber-banded
    // away again.
    expect(h.walls()).toEqual([])
    expect(h.undoSteps()).toBe(0)

    // The number survives the keypress: the first move names the direction it
    // was waiting for, and the same Enter then draws it.
    tool.onPointerMove(pointer(0, 10), h.ctx)
    expect(tool.onKeyDown(press('Enter'), h.ctx)).toBe(true)
    expect(h.walls()).toHaveLength(1)
    expect(h.walls()[0].b.x).toBeCloseTo(0, 9)
    expect(h.walls()[0].b.y).toBeCloseTo(4.5, 9)
  })

  it('draws the number that was typed, not the distance the pointer stopped at', () => {
    const h = harness()
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerMove(pointer(2, 0), h.ctx)
    type(tool, h.ctx, '4.5')

    // Typing re-aims the preview where a move would. It used to offer the
    // typed length beside the 2 m that would actually be drawn, and Enter drew
    // the 2 m — so the one feature the tool exists for only took effect if the
    // user happened to waggle the mouse afterwards.
    expect(h.labels()).toHaveLength(1)
    expect(h.labels()[0].text).toBe('4.5 → 4.50 m  ·  0°')
    expect(h.draft()[0].points).toEqual([
      { x: 0, y: 0 },
      { x: 4.5, y: 0 },
    ])

    tool.onKeyDown(press('Enter'), h.ctx)
    expect(distance(h.walls()[0].a, h.walls()[0].b)).toBeCloseTo(4.5, 9)
  })

  it('spends the typed length on the click that names the direction, and only that one', () => {
    const h = harness()
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    type(tool, h.ctx, '4.5')
    // The click says which way, not how far — so a 2 m gap on screen still
    // draws the 4.5 m that was typed.
    tool.onPointerDown(pointer(2, 0), h.ctx)
    expect(h.walls()[0].b).toEqual({ x: 4.5, y: 0 })

    tool.onPointerMove(pointer(4.5, 9), h.ctx)
    tool.onPointerDown(pointer(4.5, 9), h.ctx)
    // The number is spent, not sticky: the next segment is as long as it looks.
    expect(distance(h.walls()[1].a, h.walls()[1].b)).toBeCloseTo(9, 9)
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

  it('squares the rectangle while Shift is held, into the quadrant the drag went', () => {
    const h = harness()
    const tool = new RoomTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerMove(pointer(6, 2, { shiftKey: true }), h.ctx)
    tool.onPointerUp(pointer(6, 2, { shiftKey: true }), h.ctx)

    const walls = h.walls()
    expect(walls).toHaveLength(4)
    for (const wall of walls) expect(distance(wall.a, wall.b)).toBeCloseTo(6, 9)

    // Up and to the left: the square has to grow away from the anchor, not
    // mirror back across it.
    const back = harness()
    const backTool = new RoomTool()
    backTool.onPointerDown(pointer(6, 6), back.ctx)
    backTool.onPointerMove(pointer(1, 4, { shiftKey: true }), back.ctx)
    backTool.onPointerUp(pointer(1, 4, { shiftKey: true }), back.ctx)

    expect(back.walls().map((wall) => wall.a)).toEqual([
      { x: 1, y: 1 },
      { x: 6, y: 1 },
      { x: 6, y: 6 },
      { x: 1, y: 6 },
    ])
  })

  it('squares a drag that went straight up instead of dropping it', () => {
    const h = harness()
    const tool = new RoomTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerMove(pointer(0, 5, { shiftKey: true }), h.ctx)
    tool.onPointerUp(pointer(0, 5, { shiftKey: true }), h.ctx)

    // Angle snapping pulls a drag onto the axis, so an exactly vertical one is
    // the ordinary case and not a freak. There is no sign to take on the axis
    // the pointer never left, and `Math.sign(0)` collapsed the square to a line
    // that the release then threw away without a word — on the gesture the
    // tool's own hint recommends.
    const walls = h.walls()
    expect(walls).toHaveLength(4)
    for (const wall of walls) expect(distance(wall.a, wall.b)).toBeCloseTo(5, 9)
    expect(walls.map((wall) => wall.a)).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 5 },
      { x: 0, y: 5 },
    ])
  })

  it('finishes the room on a release that misses the floor', () => {
    const h = harness()
    const tool = new RoomTool()

    tool.onPointerDown(pointer(1, 1), h.ctx)
    tool.onPointerMove(pointer(5, 4), h.ctx)
    // Drag past the horizon and let go: the ground plane is behind the camera
    // there, so `ground` is null and the last corner on the floor has to stand.
    tool.onPointerMove(pointer(0, 0, { ground: null }), h.ctx)
    tool.onPointerUp(pointer(0, 0, { ground: null }), h.ctx)

    expect(h.walls()).toHaveLength(4)
    expect(h.walls()[2].a).toEqual({ x: 5, y: 4 })
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

  it('gives each segment of a chain its own step, so undo takes back one wall', () => {
    const h = harness()
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerDown(pointer(4, 0), h.ctx)
    tool.onPointerDown(pointer(4, 3), h.ctx)
    tool.onPointerDown(pointer(0, 3), h.ctx)
    tool.onKeyDown(press('Escape'), h.ctx)

    // Unlike the room tool's one drag, a chain is a sequence of separate
    // clicks, and each is committed and sealed on its own: undo after a
    // mis-clicked corner costs the corner, not the whole traced floor.
    expect(h.edits.map((edit) => edit.coalesceKey)).toEqual([undefined, undefined, undefined])
    expect(h.seals()).toBe(3)
    expect(h.undoSteps()).toBe(3)

    h.undo()
    expect(h.walls()).toHaveLength(2)
  })

  it('goes on drawing from the corner it was at when a segment is undone', () => {
    const h = harness()
    const tool = new WallTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerDown(pointer(4, 0), h.ctx)
    tool.onPointerDown(pointer(4, 3), h.ctx)

    h.undo()
    // Every document change reaches the active tool as `onRefresh`, which is
    // what `ViewportHost` calls when the store's document changes.
    tool.onRefresh(h.ctx)

    // Recorded decision: the chain is the gesture in progress and it does not
    // follow the document back. `onRefresh` exists precisely so that a document
    // change redraws the chain rather than restarting it — committing a segment
    // is itself a document change — and it reads none of the plan to decide
    // what the chain should be. For undo to move the chain the tool would have
    // to keep the id of every wall it committed and pop a point whenever one
    // went missing, which puts tool state in the business of tracking history
    // and still leaves redo out of step the other way round. The cost is what
    // this test pins: after an undo mid-chain the draft runs through a corner
    // whose wall has gone, until Escape or a double-click starts a fresh
    // chain.
    expect(h.walls()).toHaveLength(1)
    expect(h.draft()[0].points).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 3 },
    ])

    tool.onPointerDown(pointer(8, 3), h.ctx)
    expect(h.walls().map(ends)).toEqual([
      [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
      ],
      [
        { x: 4, y: 3 },
        { x: 8, y: 3 },
      ],
    ])
  })
})

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
    expect(distance(h.walls()[0].a, h.walls()[0].b)).toBeCloseTo(4, 9)

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
    expect(h.walls().reduce((sum, wall) => sum + distance(wall.a, wall.b), 0)).toBeCloseTo(18, 9)
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

  it('numbers past the highest name in use, so a deleted area leaves no twin', () => {
    const h = harness()
    const tool = new ZoneTool()
    const drag = (x: number, y: number) => {
      tool.onPointerDown(pointer(x, y), h.ctx)
      tool.onPointerMove(pointer(x + 4, y + 3), h.ctx)
      tool.onPointerUp(pointer(x + 4, y + 3), h.ctx)
    }

    drag(0, 0)
    drag(6, 0)
    // What Delete does to a selected area, through the same `apply` the store
    // uses for it.
    h.ctx.apply((doc) => removeObjects(doc, [{ kind: 'zone', id: h.zones()[0].id }]), 'Delete')
    drag(12, 0)

    // Counting instead handed the successor's name out twice. The itinerary
    // editor lists destinations by name and the results report them by name, so
    // a planner was left picking between two identical "Entry 2" rows with no
    // way to tell which door they meant.
    expect(h.zones().map((zone) => zone.name)).toEqual(['Entry 2', 'Entry 3'])
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

  it('draws and measures the outline while nothing is written', () => {
    const h = harness()
    const tool = new ZoneTool()
    const before = h.doc()

    click(tool, h.ctx, 3, 3)
    expect(h.draft()[0].kind).toBe('polygon')

    click(tool, h.ctx, 9, 3)
    tool.onPointerMove(pointer(9, 7), h.ctx)

    // The pointer counts as a corner in the preview, so the readout is the area
    // the next click locks in rather than the one already placed.
    expect(h.draft()[0].points).toEqual([
      { x: 3, y: 3 },
      { x: 9, y: 3 },
      { x: 9, y: 7 },
    ])
    expect(h.labels()[0].text).toBe('12 m²')
    expect(h.doc()).toBe(before)
    expect(h.zones()).toEqual([])
  })

  it('ignores Enter until three corners exist, then closes the outline in one step', () => {
    const h = harness()
    const tool = new ZoneTool()

    click(tool, h.ctx, 3, 3)
    click(tool, h.ctx, 9, 3)
    // Two corners are a line, not an area, so the key is not the tool's to take.
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

  it('finishes on a double-click with the corners the user placed', () => {
    const h = harness()
    const tool = new ZoneTool()

    click(tool, h.ctx, 3, 3)
    click(tool, h.ctx, 9, 3)
    // The hint tells the user to end an outline this way, and a double-click is
    // two down/up pairs before `dblclick` — the tool sees both downs. Kept, the
    // repeat put two vertex handles on one spot for the select tool: dragging
    // moved only the one that won the hit test, tearing a spike out of the
    // edge, and the duplicate rode into every copy and file the plan was sent
    // as.
    click(tool, h.ctx, 9, 7)
    click(tool, h.ctx, 9, 7)
    tool.onDoubleClick(pointer(9, 7), h.ctx)

    expect(h.zones()[0].polygon).toEqual([
      { x: 3, y: 3 },
      { x: 9, y: 3 },
      { x: 9, y: 7 },
    ])
    expect(polygonArea(h.zones()[0].polygon)).toBeCloseTo(12, 9)
  })

  it('throws an outline away when the double-click comes before there is an area', () => {
    const h = harness()
    const tool = new ZoneTool()
    const before = h.doc()

    click(tool, h.ctx, 3, 3)
    tool.onDoubleClick(pointer(3, 3), h.ctx)

    expect(h.doc()).toBe(before)
    expect(h.draft()).toEqual([])
    expect(h.labels()).toEqual([])

    // Thrown away and not half-held: the next drag is an area again, not a
    // third corner of the outline that was abandoned.
    tool.onPointerDown(pointer(1, 1), h.ctx)
    tool.onPointerMove(pointer(5, 4), h.ctx)
    tool.onPointerUp(pointer(5, 4), h.ctx)
    expect(h.zones()).toHaveLength(1)
    expect(polygonArea(h.zones()[0].polygon)).toBeCloseTo(12, 9)
  })

  it('writes nothing when the double-click comes a corner too early', () => {
    const h = harness()
    const tool = new ZoneTool()
    const before = h.doc()

    click(tool, h.ctx, 3, 3)
    click(tool, h.ctx, 9, 3)
    click(tool, h.ctx, 9, 3)
    tool.onDoubleClick(pointer(9, 3), h.ctx)

    // Two corners are a line. The repeat press used to count towards the three
    // a commit asks for, and `destinationFrom` finds no cells inside a zone
    // with no area: a whole population then arrives at the single
    // `nearestFreeCell` it falls back to, and a measurement area reports
    // density over zero floor.
    expect(h.zones()).toEqual([])
    expect(h.doc()).toBe(before)
  })

  it('takes a long thin drag as the area it swept, not as a click', () => {
    const h = harness()
    const tool = new ZoneTool()

    tool.onPointerDown(pointer(1, 1), h.ctx)
    tool.onPointerMove(pointer(1.1, 7), h.ctx)
    tool.onPointerUp(pointer(1.1, 7), h.ctx)

    // A gate line across a doorway is exactly this shape. Judged on the
    // thinner side alone a 6 m drag counted as a click, which dropped the user
    // into a free-form outline they never asked for — and pointer-up does
    // nothing in that mode, so every further drag added another corner and drew
    // no area at all until they found Escape.
    expect(h.zones()).toHaveLength(1)
    expect(h.zones()[0].polygon).toEqual([
      { x: 1, y: 1 },
      { x: 1.1, y: 1 },
      { x: 1.1, y: 7 },
      { x: 1, y: 7 },
    ])

    // Still drawing areas: the next drag is one too, not a corner of an outline.
    tool.onPointerDown(pointer(5, 5), h.ctx)
    tool.onPointerMove(pointer(9, 9), h.ctx)
    tool.onPointerUp(pointer(9, 9), h.ctx)
    expect(h.zones()).toHaveLength(2)
  })

  it('drops a drag that swept no width at all', () => {
    const h = harness()
    const tool = new ZoneTool()

    tool.onPointerDown(pointer(1, 1), h.ctx)
    tool.onPointerMove(pointer(7, 1), h.ctx)
    tool.onPointerUp(pointer(7, 1), h.ctx)

    // Snapping pulls a drag onto a grid line, so this is a gesture a user
    // makes. A zone with no thickness has no floor inside it for the
    // simulation to find a cell in, and nothing to click on afterwards.
    expect(h.zones()).toEqual([])
    expect(h.draft()).toEqual([])
  })
})

describe('a wall takes two clicks', () => {
  it('draws nothing from a press and drag, and finishes on the click after it', () => {
    const h = harness()
    // Through the interface the viewport dispatches on, which calls only the
    // handlers a tool defines: the wall tool has no pointer-up at all, so a
    // press and drag ends with the chain still open rather than with a wall
    // nobody meant to draw — of whatever length the release happened to be.
    const tool: Tool = new WallTool()
    const before = h.doc()

    tool.onPointerDown?.(pointer(2, 2), h.ctx)
    tool.onPointerMove?.(pointer(4, 2), h.ctx)
    tool.onPointerMove?.(pointer(5, 2), h.ctx)
    tool.onPointerUp?.(pointer(5, 2), h.ctx)

    expect(h.doc()).toBe(before)
    expect(h.walls()).toEqual([])
    // The drag is still only a preview, waiting for the click that ends it.
    expect(h.draft()[0].points).toEqual([
      { x: 2, y: 2 },
      { x: 5, y: 2 },
    ])

    tool.onPointerDown?.(pointer(5, 2), h.ctx)
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

  it('measures between the points the pointer named while Alt is held', () => {
    const h = harness({ snap: latticeSnap })
    const tool = new MeasureTool()

    tool.onPointerDown(pointer(1.06, 2, { altKey: true }), h.ctx)
    tool.onPointerMove(pointer(4.19, 2, { altKey: true }), h.ctx)
    // What the user reads while deciding where to click.
    expect(h.labels()[0].text).toBe('3.13 m')

    tool.onPointerDown(pointer(4.19, 2, { altKey: true }), h.ctx)
    tool.onDoubleClick(pointer(4.19, 2, { altKey: true }), h.ctx)

    // And what they are left with: the click used to snap where the preview did
    // not, so the number moved 6 cm at the instant it was committed and the one
    // tool whose whole job is "how far is that really" answered about the grid
    // points beside the thing being measured.
    expect(h.labels()[0].text).toBe('3.13 m')
  })

  it('ends the tape on a double-click without a leg of nothing', () => {
    const h = harness()
    const tool = new MeasureTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerMove(pointer(3, 0), h.ctx)
    tool.onPointerDown(pointer(3, 0), h.ctx)
    // The second press of the double-click that ends the tape.
    tool.onPointerDown(pointer(3, 0), h.ctx)
    tool.onDoubleClick(pointer(3, 0), h.ctx)

    // One span, one number: the repeat press used to add a 0 cm leg, which put
    // a "Total" line over what the user drew as a single measurement.
    expect(h.labels().map((label) => label.text)).toEqual(['3.00 m'])
  })
})
