/**
 * The select tool, driven the way the viewport drives it.
 *
 * The tool reaches the world only through its `ToolContext`, so the fake one
 * here records every request and keeps a *real* undo history behind
 * `apply`/`seal`. Counting `history.past` is the only honest way to check that
 * a gesture costs one undo step — a mock that counts calls cannot see
 * coalescing at all.
 *
 * `worldToScreen` is a true plan projection (metres divided by metres-per-pixel)
 * rather than the identity, because every handle in this tool is hit-tested in
 * screen pixels. Under an identity projection `HANDLE_HIT_PX` would be eleven
 * *metres* and every handle test in here would pass for the wrong reason.
 */

import { describe, expect, it } from 'vitest'
import { SelectTool } from './selectTool'
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
import type { Vec2 } from '../../core/math/vec2'
import type {
  CrowdDocument,
  FurnitureItem,
  Plan,
  PlanObjectKind,
  PlanObjectRef,
  Wall,
} from '../../core/model/types'
import type { DraftShape, PickHit, PointerInfo } from '../../render/Viewport'
import type { Label } from '../../render/LabelLayer'
import type { SnapOptions } from '../snapping'
import type { ToolContext } from '../types'
import type { ToolOptions } from '../../state/editorStore'

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

/** Zoomed to a metre across 100 px, as the default camera roughly is. */
const METRES_PER_PIXEL = 0.01

/** Below this the tool calls the gesture a click, not a drag. */
const DRAG_THRESHOLD_M = METRES_PER_PIXEL * 4

/** ROTATE_HANDLE_OFFSET_PX (46) in metres at this zoom. */
const RING_OFFSET_M = 0.46

interface AppliedEdit {
  label: string
  coalesceKey: string | undefined
}

const harness = (plan: Partial<Plan> = {}) => {
  const base = createDocument('select fixture')
  let history = createHistory<CrowdDocument>({ ...base, plan: { ...base.plan, ...plan } })
  let selection: PlanObjectRef[] = []
  const edits: AppliedEdit[] = []
  const snapRequests: Array<Partial<SnapOptions>> = []
  let seals = 0
  let draft: DraftShape[] = []
  let labels: Label[] = []

  const ctx: ToolContext = {
    get document() {
      return history.present.value
    },
    options: TOOL_OPTIONS,
    get selection() {
      return selection
    },
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
    worldToScreen: (point) => ({ x: point.x / METRES_PER_PIXEL, y: point.y / METRES_PER_PIXEL }),
    setDraft(shapes) {
      draft = shapes
    },
    setLabels(next) {
      labels = next
    },
    setSelection(refs) {
      selection = refs
    },
    toggleSelection(ref) {
      const exists = selection.some((r) => r.id === ref.id && r.kind === ref.kind)
      selection = exists
        ? selection.filter((r) => !(r.id === ref.id && r.kind === ref.kind))
        : [...selection, ref]
    },
    setHint: () => {},
    setTool: () => {},
    toast: () => {},
  }

  return {
    ctx,
    edits,
    snapRequests,
    seals: () => seals,
    draft: () => draft,
    labels: () => labels,
    doc: () => history.present.value,
    selection: () => selection,
    undoSteps: () => history.past.length,
    undo: () => {
      history = undoHistory(history)
    },
  }
}

type Harness = ReturnType<typeof harness>

const pointer = (x: number, y: number, over: Partial<PointerInfo> = {}): PointerInfo => ({
  ground: { x, y },
  screenX: x / METRES_PER_PIXEL,
  screenY: y / METRES_PER_PIXEL,
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

const pick = (kind: PlanObjectKind, id: string, x: number, y: number): PickHit => ({
  ref: { kind, id },
  point: { x, y },
  height: 0,
})

/** The tool reads `key` and `shiftKey`; `node` has no KeyboardEvent. */
const press = (key: string, shiftKey = false): KeyboardEvent =>
  ({ key, shiftKey }) as unknown as KeyboardEvent

/**
 * Press on `hit`, drag to `to`, release.
 *
 * Two moves, not one: the move that crosses the drag threshold only arms the
 * drag, and the tool commits on the one after it. Both land on the same point,
 * which also pins that a repeated move is idempotent — the delta is measured
 * from the gesture's start, not from the last frame.
 *
 * Press and move modifiers are separate because they mean different things:
 * Alt is read when the button goes down, Shift only while the pointer moves.
 */
const drag = (
  tool: SelectTool,
  h: Harness,
  hit: PickHit,
  to: Vec2,
  over: { press?: Partial<PointerInfo>; move?: Partial<PointerInfo> } = {},
): void => {
  tool.onPointerDown(pointer(hit.point.x, hit.point.y, { hit, ...over.press }), h.ctx)
  tool.onPointerMove(pointer(to.x, to.y, over.move), h.ctx)
  tool.onPointerMove(pointer(to.x, to.y, over.move), h.ctx)
  tool.onPointerUp(pointer(to.x, to.y, over.move), h.ctx)
}

/** A 1 m square item, so its footprint corners sit ±0.5 m from its position. */
const item = (id: string, x: number, y: number, over: Partial<FurnitureItem> = {}): FurnitureItem =>
  ({
    id,
    catalogId: 'table-round-6',
    position: { x, y },
    rotation: 0,
    size: { width: 1, depth: 1, height: 0.75 },
    ...over,
  }) satisfies FurnitureItem

const wall = (id: string, a: Vec2, b: Vec2, over: Partial<Wall> = {}): Wall => ({
  id,
  a,
  b,
  thickness: DEFAULT_WALL_THICKNESS,
  height: DEFAULT_WALL_HEIGHT,
  kind: 'wall',
  ...over,
})

const furnitureById = (h: Harness, id: string): FurnitureItem => {
  const found = h.doc().plan.furniture.find((f) => f.id === id)
  if (!found) throw new Error(`no furniture ${id}`)
  return found
}

const wallById = (h: Harness, id: string): Wall => {
  const found = h.doc().plan.walls.find((w) => w.id === id)
  if (!found) throw new Error(`no wall ${id}`)
  return found
}

const ref = (kind: PlanObjectKind, id: string): PlanObjectRef => ({ kind, id })

describe('picking objects', () => {
  it('selects what is under the pointer without touching the document', () => {
    const h = harness({ furniture: [item('a', 2, 2)] })
    const tool = new SelectTool()
    const before = h.doc()

    tool.onPointerDown(pointer(2, 2, { hit: pick('furniture', 'a', 2, 2) }), h.ctx)
    tool.onPointerUp(pointer(2, 2), h.ctx)

    expect(h.selection()).toEqual([ref('furniture', 'a')])
    expect(h.doc()).toBe(before)
    expect(h.edits).toEqual([])
  })

  it('adds with Shift and removes the second time', () => {
    const h = harness({ furniture: [item('a', 2, 2), item('b', 6, 6)] })
    const tool = new SelectTool()

    tool.onPointerDown(pointer(2, 2, { hit: pick('furniture', 'a', 2, 2) }), h.ctx)
    tool.onPointerUp(pointer(2, 2), h.ctx)
    tool.onPointerDown(pointer(6, 6, { hit: pick('furniture', 'b', 6, 6), shiftKey: true }), h.ctx)

    expect(h.selection()).toEqual([ref('furniture', 'a'), ref('furniture', 'b')])

    tool.onPointerDown(pointer(6, 6, { hit: pick('furniture', 'b', 6, 6), shiftKey: true }), h.ctx)
    expect(h.selection()).toEqual([ref('furniture', 'a')])
  })

  it('clears the selection on empty space, but not while Shift is held', () => {
    const h = harness({ furniture: [item('a', 2, 2)] })
    const tool = new SelectTool()

    tool.onPointerDown(pointer(2, 2, { hit: pick('furniture', 'a', 2, 2) }), h.ctx)
    tool.onPointerUp(pointer(2, 2), h.ctx)
    // Far from the rotate ring, which would otherwise swallow the press.
    tool.onPointerDown(pointer(20, 20, { shiftKey: true }), h.ctx)
    expect(h.selection()).toEqual([ref('furniture', 'a')])

    tool.onPointerDown(pointer(20, 20), h.ctx)
    expect(h.selection()).toEqual([])
  })

  it('keeps the whole group when a member of it is pressed', () => {
    const h = harness({ furniture: [item('a', 2, 2), item('b', 6, 2)] })
    const tool = new SelectTool()

    tool.onPointerDown(pointer(2, 2, { hit: pick('furniture', 'a', 2, 2) }), h.ctx)
    tool.onPointerUp(pointer(2, 2), h.ctx)
    tool.onPointerDown(pointer(6, 2, { hit: pick('furniture', 'b', 6, 2), shiftKey: true }), h.ctx)
    tool.onPointerUp(pointer(6, 2), h.ctx)

    // Pressing one of several without a modifier must not collapse the group:
    // that press is how a multi-selection gets dragged.
    tool.onPointerDown(pointer(2, 2, { hit: pick('furniture', 'a', 2, 2) }), h.ctx)
    expect(h.selection()).toEqual([ref('furniture', 'a'), ref('furniture', 'b')])
  })
})

describe('marquee selection', () => {
  it('picks up what the band encloses and leaves the rest alone', () => {
    const h = harness({ furniture: [item('in', 2, 2), item('out', 10, 10)] })
    const tool = new SelectTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerMove(pointer(5, 5), h.ctx)
    expect(h.draft()).toEqual([
      {
        kind: 'rect',
        filled: true,
        color: '#2f7df6',
        points: [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
          { x: 5, y: 5 },
          { x: 0, y: 5 },
        ],
      },
    ])

    tool.onPointerUp(pointer(5, 5), h.ctx)
    expect(h.selection()).toEqual([ref('furniture', 'in')])
    expect(h.edits).toEqual([])
  })

  it('needs a band wider than the click threshold before it selects anything', () => {
    const h = harness({ furniture: [item('a', 2, 2)] })
    const tool = new SelectTool()
    // The item's near corner is at (1.5, 1.5); both bands below straddle it, so
    // only the threshold can tell them apart. Without it the jitter of an
    // ordinary click would rubber-band whatever corner happened to be nearby.
    const tiny = 0.03
    expect(tiny).toBeLessThan(DRAG_THRESHOLD_M)

    tool.onPointerDown(pointer(1.48, 1.48), h.ctx)
    tool.onPointerMove(pointer(1.48 + tiny, 1.48 + tiny), h.ctx)
    tool.onPointerUp(pointer(1.48 + tiny, 1.48 + tiny), h.ctx)
    expect(h.selection()).toEqual([])

    tool.onPointerDown(pointer(1.48, 1.48), h.ctx)
    tool.onPointerMove(pointer(1.6, 1.6), h.ctx)
    tool.onPointerUp(pointer(1.6, 1.6), h.ctx)
    expect(h.selection()).toEqual([ref('furniture', 'a')])
  })

  it('SUSPECTED BUG: a Shift marquee over an already-selected object duplicates it', () => {
    const h = harness({ furniture: [item('a', 2, 2)] })
    const tool = new SelectTool()

    tool.onPointerDown(pointer(2, 2, { hit: pick('furniture', 'a', 2, 2) }), h.ctx)
    tool.onPointerUp(pointer(2, 2), h.ctx)

    tool.onPointerDown(pointer(-5, -5, { shiftKey: true }), h.ctx)
    tool.onPointerMove(pointer(5, 5, { shiftKey: true }), h.ctx)
    tool.onPointerUp(pointer(5, 5, { shiftKey: true }), h.ctx)

    // Additive marquee concatenates without deduplicating, so the item is in
    // the selection twice. Moves stay correct because they are absolute, but
    // the inspector and any per-selection count now see two objects.
    expect(h.selection()).toEqual([ref('furniture', 'a'), ref('furniture', 'a')])
  })

  it('SUSPECTED BUG: misses a wall that crosses the band with both ends outside it', () => {
    const h = harness({ walls: [wall('w', { x: -5, y: 3 }, { x: 5, y: 3 })] })
    const tool = new SelectTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerMove(pointer(1, 6), h.ctx)
    tool.onPointerUp(pointer(1, 6), h.ctx)

    // The band is tested against footprint *corners* only, so a long wall drawn
    // straight through it is never picked up: the user has to enclose an end.
    expect(h.selection()).toEqual([])
  })
})

describe('dragging a selection', () => {
  it('moves every member by the same delta and leaves the rest shared', () => {
    const h = harness({ furniture: [item('a', 2, 2), item('b', 5, 2), item('c', 9, 9)] })
    const tool = new SelectTool()
    const untouched = furnitureById(h, 'c')

    tool.onPointerDown(pointer(2, 2, { hit: pick('furniture', 'a', 2, 2) }), h.ctx)
    tool.onPointerUp(pointer(2, 2), h.ctx)
    tool.onPointerDown(pointer(5, 2, { hit: pick('furniture', 'b', 5, 2), shiftKey: true }), h.ctx)
    tool.onPointerUp(pointer(5, 2), h.ctx)

    drag(tool, h, pick('furniture', 'a', 2, 2), { x: 3.2, y: 2.7 })

    expect(furnitureById(h, 'a').position).toEqual({ x: 3.2, y: 2.7 })
    expect(furnitureById(h, 'b').position).toEqual({ x: 6.2, y: 2.7 })
    // Structural sharing is what makes undo cheap: an object nobody dragged
    // must come out of the mutation by identity, not as a fresh copy.
    expect(furnitureById(h, 'c')).toBe(untouched)
  })

  it('writes nothing until the pointer has really left the press point', () => {
    const h = harness({ furniture: [item('a', 2, 2)] })
    const tool = new SelectTool()
    const before = h.doc()

    tool.onPointerDown(pointer(2, 2, { hit: pick('furniture', 'a', 2, 2) }), h.ctx)
    tool.onPointerMove(pointer(2.03, 2), h.ctx)
    expect(h.doc()).toBe(before)

    // The move that crosses the threshold only arms the drag. Recorded rather
    // than endorsed: a single large pointer jump followed by release moves
    // nothing at all, though a real pointer stream never does that.
    tool.onPointerMove(pointer(2.1, 2), h.ctx)
    expect(h.doc()).toBe(before)
    expect(h.edits).toEqual([])

    tool.onPointerMove(pointer(2.2, 2), h.ctx)
    expect(furnitureById(h, 'a').position).toEqual({ x: 2.2, y: 2 })
  })

  it('is one undo step per drag, sealed so the next drag starts its own', () => {
    const h = harness({ furniture: [item('a', 2, 2)] })
    const tool = new SelectTool()
    const original = h.doc()

    drag(tool, h, pick('furniture', 'a', 2, 2), { x: 4, y: 2 })
    expect(h.undoSteps()).toBe(1)
    expect(h.seals()).toBe(1)
    expect(h.edits.length).toBeGreaterThan(0)
    for (const edit of h.edits)
      expect(edit).toEqual({ label: 'Move', coalesceKey: 'move-selection' })

    drag(tool, h, pick('furniture', 'a', 4, 2), { x: 7, y: 2 })
    // Without the seal the second drag would coalesce into the first and the
    // user would lose both moves in one undo.
    expect(h.undoSteps()).toBe(2)

    h.undo()
    expect(furnitureById(h, 'a').position).toEqual({ x: 4, y: 2 })
    h.undo()
    expect(h.doc()).toBe(original)
  })

  it('excludes the dragged objects from snapping', () => {
    const h = harness({ furniture: [item('a', 2, 2), item('b', 5, 2)] })
    const tool = new SelectTool()

    tool.onPointerDown(pointer(2, 2, { hit: pick('furniture', 'a', 2, 2) }), h.ctx)
    tool.onPointerUp(pointer(2, 2), h.ctx)
    tool.onPointerDown(pointer(5, 2, { hit: pick('furniture', 'b', 5, 2), shiftKey: true }), h.ctx)
    tool.onPointerUp(pointer(5, 2), h.ctx)
    h.snapRequests.length = 0

    drag(tool, h, pick('furniture', 'a', 2, 2), { x: 3, y: 2 })

    expect(h.snapRequests.length).toBeGreaterThan(0)
    for (const request of h.snapRequests) {
      // A dragged object that can snap to itself sticks to where it started.
      expect([...(request.exclude ?? [])].sort()).toEqual(['a', 'b'])
    }
  })

  it('constrains to the dominant axis while Shift is held', () => {
    const h = harness({ furniture: [item('a', 2, 2)] })
    const tool = new SelectTool()

    // Shift on the *press* is the additive-selection modifier and never starts
    // a drag; the axis lock is read from each move, so it can be taken up and
    // dropped halfway through one.
    drag(tool, h, pick('furniture', 'a', 2, 2), { x: 3.2, y: 2.7 }, { move: { shiftKey: true } })
    expect(furnitureById(h, 'a').position).toEqual({ x: 3.2, y: 2 })

    tool.onPointerDown(pointer(3.2, 2, { hit: pick('furniture', 'a', 3.2, 2) }), h.ctx)
    tool.onPointerMove(pointer(4, 2.7, { shiftKey: true }), h.ctx)
    tool.onPointerMove(pointer(4, 2.7), h.ctx)
    expect(furnitureById(h, 'a').position).toEqual({ x: 4, y: 2.7 })
  })

  it('reports the distance travelled in the document units', () => {
    const h = harness({ furniture: [item('a', 2, 2)] })
    const tool = new SelectTool()

    drag(tool, h, pick('furniture', 'a', 2, 2), { x: 5, y: 6 })

    // Released, so the readout is cleared; capture it mid-drag instead.
    tool.onPointerDown(pointer(5, 6, { hit: pick('furniture', 'a', 5, 6) }), h.ctx)
    tool.onPointerMove(pointer(8, 10), h.ctx)
    tool.onPointerMove(pointer(8, 10), h.ctx)
    expect(h.labels()).toHaveLength(1)
    expect(h.labels()[0].text).toBe('5.00 m')

    tool.onPointerUp(pointer(8, 10), h.ctx)
    expect(h.labels()).toEqual([])
  })

  it('SUSPECTED BUG: Escape does not cancel a drag', () => {
    const h = harness({ furniture: [item('a', 2, 2)] })
    const tool = new SelectTool()
    const original = h.doc()

    tool.onPointerDown(pointer(2, 2, { hit: pick('furniture', 'a', 2, 2) }), h.ctx)
    tool.onPointerMove(pointer(4, 2), h.ctx)
    tool.onPointerMove(pointer(4, 2), h.ctx)

    // The tool never claims Escape, so the global handler runs instead: the
    // selection is dropped while the tool stays in its move state, the moved
    // position is left in the document, and the only way back is undo.
    expect(tool.onKeyDown(press('Escape'), h.ctx)).toBe(false)
    expect(h.doc()).not.toBe(original)
    expect(furnitureById(h, 'a').position).toEqual({ x: 4, y: 2 })

    tool.onPointerMove(pointer(6, 2), h.ctx)
    expect(furnitureById(h, 'a').position).toEqual({ x: 6, y: 2 })
  })
})

describe('alt-drag duplicates', () => {
  it('leaves the original where it was and drags the copy', () => {
    const h = harness({ furniture: [item('a', 2, 2)] })
    const tool = new SelectTool()

    drag(tool, h, pick('furniture', 'a', 2, 2), { x: 6, y: 2 }, { press: { altKey: true } })

    const furniture = h.doc().plan.furniture
    expect(furniture).toHaveLength(2)
    expect(furnitureById(h, 'a').position).toEqual({ x: 2, y: 2 })
    const copy = furniture.find((f) => f.id !== 'a')
    expect(copy?.position).toEqual({ x: 6, y: 2 })
    expect(h.selection()).toEqual([ref('furniture', copy?.id ?? '')])
  })

  it('SUSPECTED BUG: one alt-drag costs two undo steps', () => {
    const h = harness({ furniture: [item('a', 2, 2)] })
    const tool = new SelectTool()

    drag(tool, h, pick('furniture', 'a', 2, 2), { x: 6, y: 2 }, { press: { altKey: true } })

    // 'Duplicate' and 'move-selection' are different coalesce keys, so the
    // gesture splits in two. Undoing once leaves a copy sitting exactly on top
    // of the original, which looks like nothing happened.
    expect(h.undoSteps()).toBe(2)
    h.undo()
    expect(h.doc().plan.furniture).toHaveLength(2)
    expect(h.doc().plan.furniture.map((f) => f.position)).toEqual([
      { x: 2, y: 2 },
      { x: 2, y: 2 },
    ])
  })
})

describe('the rotate ring', () => {
  /** Where the ring sits for a single 1 m item: centred, a fixed gap above it. */
  const ringFor = (x: number, y: number): Vec2 => ({ x, y: y - 0.5 - RING_OFFSET_M })

  it('spins the selection about its centre and reads out the angle', () => {
    const h = harness({ furniture: [item('a', 2, 2)] })
    const tool = new SelectTool()
    tool.onPointerDown(pointer(2, 2, { hit: pick('furniture', 'a', 2, 2) }), h.ctx)
    tool.onPointerUp(pointer(2, 2), h.ctx)

    const ring = ringFor(2, 2)
    tool.onPointerDown(pointer(ring.x, ring.y), h.ctx)
    // Ring at -90° from the centre, pointer now due +X: a quarter turn.
    tool.onPointerMove(pointer(3, 2), h.ctx)

    expect(furnitureById(h, 'a').rotation).toBeCloseTo(Math.PI / 2, 9)
    // A single object turns on the spot, so its position must not drift.
    expect(furnitureById(h, 'a').position).toEqual({ x: 2, y: 2 })
    expect(h.labels()[0].text).toBe('90°')

    tool.onPointerUp(pointer(3, 2), h.ctx)
    expect(h.undoSteps()).toBe(1)
    expect(h.edits.every((e) => e.coalesceKey === 'rotate-selection')).toBe(true)
  })

  it('is hit in screen pixels, not in metres', () => {
    const near = harness({ furniture: [item('a', 2, 2)] })
    const nearTool = new SelectTool()
    nearTool.onPointerDown(pointer(2, 2, { hit: pick('furniture', 'a', 2, 2) }), near.ctx)
    nearTool.onPointerUp(pointer(2, 2), near.ctx)

    const ring = ringFor(2, 2)
    // 10 px short of the ring centre: inside HANDLE_HIT_PX (11), so it grabs.
    nearTool.onPointerDown(
      pointer(ring.x, ring.y, { screenY: ring.y / METRES_PER_PIXEL + 10 }),
      near.ctx,
    )
    nearTool.onPointerMove(pointer(3, 2), near.ctx)
    expect(furnitureById(near, 'a').rotation).toBeCloseTo(Math.PI / 2, 9)

    const far = harness({ furniture: [item('a', 2, 2)] })
    const farTool = new SelectTool()
    farTool.onPointerDown(pointer(2, 2, { hit: pick('furniture', 'a', 2, 2) }), far.ctx)
    farTool.onPointerUp(pointer(2, 2), far.ctx)
    // 20 px away is a miss even though it is only 0.2 m: the press falls
    // through to empty space and starts a marquee, dropping the selection.
    farTool.onPointerDown(
      pointer(ring.x, ring.y, { screenY: ring.y / METRES_PER_PIXEL + 20 }),
      far.ctx,
    )
    farTool.onPointerMove(pointer(3, 2), far.ctx)
    expect(far.selection()).toEqual([])
    expect(furnitureById(far, 'a').rotation).toBe(0)
  })

  it('snaps to 15°, 5° with Shift, and runs free with Alt', () => {
    const raw = 0.1 + Math.PI / 2
    const cases: Array<[Partial<PointerInfo>, number]> = [
      [{}, Math.round(raw / (Math.PI / 12)) * (Math.PI / 12)],
      [{ shiftKey: true }, Math.round(raw / (Math.PI / 36)) * (Math.PI / 36)],
      [{ altKey: true }, raw],
    ]

    for (const [modifiers, expected] of cases) {
      const h = harness({ furniture: [item('a', 2, 2)] })
      const tool = new SelectTool()
      tool.onPointerDown(pointer(2, 2, { hit: pick('furniture', 'a', 2, 2) }), h.ctx)
      tool.onPointerUp(pointer(2, 2), h.ctx)

      const ring = ringFor(2, 2)
      tool.onPointerDown(pointer(ring.x, ring.y), h.ctx)
      tool.onPointerMove(pointer(2 + Math.cos(0.1), 2 + Math.sin(0.1), modifiers), h.ctx)

      expect(furnitureById(h, 'a').rotation).toBeCloseTo(expected, 9)
    }
  })

  it('SUSPECTED BUG: a group rotation spins the positions again on every move', () => {
    const h = harness({ furniture: [item('a', 2, 2), item('b', 4, 2)] })
    const tool = new SelectTool()
    tool.onPointerDown(pointer(2, 2, { hit: pick('furniture', 'a', 2, 2) }), h.ctx)
    tool.onPointerUp(pointer(2, 2), h.ctx)
    tool.onPointerDown(pointer(4, 2, { hit: pick('furniture', 'b', 4, 2), shiftKey: true }), h.ctx)
    tool.onPointerUp(pointer(4, 2), h.ctx)

    // Ring for the pair: centred on (3, 2), above the shared bounds.
    const ring = { x: 3, y: 1.5 - RING_OFFSET_M }
    tool.onPointerDown(pointer(ring.x, ring.y), h.ctx)
    tool.onPointerMove(pointer(4, 2), h.ctx)

    expect(furnitureById(h, 'a').position.x).toBeCloseTo(3, 9)
    expect(furnitureById(h, 'a').position.y).toBeCloseTo(1, 9)

    // The same pointer position again. The rotation field is rebuilt from the
    // angle captured at press, but the position is re-read from the document
    // and spun by the full delta once more, so the pair keeps walking round the
    // pivot while the ring says it has turned 90° once.
    tool.onPointerMove(pointer(4, 2), h.ctx)

    expect(furnitureById(h, 'a').rotation).toBeCloseTo(Math.PI / 2, 9)
    expect(furnitureById(h, 'a').position.x).toBeCloseTo(4, 9)
    expect(furnitureById(h, 'a').position.y).toBeCloseTo(2, 9)
    expect(furnitureById(h, 'b').position.x).toBeCloseTo(2, 9)
    expect(furnitureById(h, 'b').position.y).toBeCloseTo(2, 9)
  })
})

describe('locked objects', () => {
  it('can be selected, so that it can be unlocked, but not dragged', () => {
    const h = harness({
      walls: [wall('w', { x: 0, y: 0 }, { x: 4, y: 0 }, { locked: true })],
    })
    const tool = new SelectTool()

    drag(tool, h, pick('wall', 'w', 2, 0), { x: 2, y: 3 })

    // Selecting is how you reach the inspector to unlock it, so that stays.
    // Moving does not: the reason to lock a traced survey line or a finished
    // shell is to stop knocking it out of place while drawing over it, and a
    // lock that only refused deletion read as protection without being any.
    expect(h.selection()).toEqual([ref('wall', 'w')])
    expect(wallById(h, 'w').a).toEqual({ x: 0, y: 0 })
    expect(wallById(h, 'w').b).toEqual({ x: 4, y: 0 })
  })

  it('moves the rest of a mixed selection and leaves the locked one behind', () => {
    const h = harness({
      furniture: [item('free', 1, 1), item('pinned', 5, 5, { locked: true })],
    })
    const tool = new SelectTool()
    h.ctx.setSelection([ref('furniture', 'free'), ref('furniture', 'pinned')])

    drag(tool, h, pick('furniture', 'free', 1, 1), { x: 3, y: 1 })

    expect(furnitureById(h, 'free').position).toEqual({ x: 3, y: 1 })
    expect(furnitureById(h, 'pinned').position).toEqual({ x: 5, y: 5 })
  })

  it('withholds the endpoint handles of a locked wall but keeps its rotate ring', () => {
    const open = harness({ walls: [wall('w', { x: 0, y: 0 }, { x: 4, y: 0 })] })
    const openTool = new SelectTool()
    openTool.onPointerDown(pointer(2, 0, { hit: pick('wall', 'w', 2, 0) }), open.ctx)
    openTool.onPointerUp(pointer(2, 0), open.ctx)
    // Two endpoints and the ring.
    expect(open.draft()).toHaveLength(3)

    const shut = harness({
      walls: [wall('w', { x: 0, y: 0 }, { x: 4, y: 0 }, { locked: true })],
    })
    const shutTool = new SelectTool()
    shutTool.onPointerDown(pointer(2, 0, { hit: pick('wall', 'w', 2, 0) }), shut.ctx)
    shutTool.onPointerUp(pointer(2, 0), shut.ctx)
    // Only the ring survives — which is itself enough to rotate the wall.
    expect(shut.draft()).toHaveLength(1)
  })
})

describe('keyboard editing', () => {
  it('nudges by the grid size and collapses the burst into one undo step', () => {
    const h = harness({ furniture: [item('a', 2, 2)] })
    const tool = new SelectTool()
    const original = h.doc()
    tool.onPointerDown(pointer(2, 2, { hit: pick('furniture', 'a', 2, 2) }), h.ctx)
    tool.onPointerUp(pointer(2, 2), h.ctx)

    expect(tool.onKeyDown(press('ArrowRight'), h.ctx)).toBe(true)
    expect(tool.onKeyDown(press('ArrowRight'), h.ctx)).toBe(true)
    expect(tool.onKeyDown(press('ArrowUp'), h.ctx)).toBe(true)

    const grid = h.ctx.document.settings.gridSize
    expect(furnitureById(h, 'a').position).toEqual({ x: 2 + 2 * grid, y: 2 - grid })
    expect(h.undoSteps()).toBe(1)

    h.undo()
    expect(h.doc()).toBe(original)
  })

  it('SUSPECTED BUG: Shift makes the nudge coarser while it makes rotation finer', () => {
    const h = harness({ furniture: [item('a', 2, 2)] })
    const tool = new SelectTool()
    tool.onPointerDown(pointer(2, 2, { hit: pick('furniture', 'a', 2, 2) }), h.ctx)
    tool.onPointerUp(pointer(2, 2), h.ctx)

    tool.onKeyDown(press('ArrowRight', true), h.ctx)

    // A hard-coded 1 m, larger than the 0.5 m grid step it replaces, while
    // Shift-[ and Shift-] below give the *fine* 1° rotation. One modifier,
    // two opposite meanings — and a dimension literal outside standards.ts.
    expect(furnitureById(h, 'a').position.x).toBe(3)
    expect(h.ctx.document.settings.gridSize).toBe(0.5)
  })

  it('rotates in 15° steps with the bracket keys, 1° with Shift', () => {
    const h = harness({ furniture: [item('a', 2, 2)] })
    const tool = new SelectTool()
    tool.onPointerDown(pointer(2, 2, { hit: pick('furniture', 'a', 2, 2) }), h.ctx)
    tool.onPointerUp(pointer(2, 2), h.ctx)

    expect(tool.onKeyDown(press(']'), h.ctx)).toBe(true)
    expect(furnitureById(h, 'a').rotation).toBeCloseTo(Math.PI / 12, 9)

    expect(tool.onKeyDown(press('[', true), h.ctx)).toBe(true)
    expect(furnitureById(h, 'a').rotation).toBeCloseTo(Math.PI / 12 - Math.PI / 180, 9)
    // Turning on the spot: a lone object must not orbit its own centre.
    expect(furnitureById(h, 'a').position).toEqual({ x: 2, y: 2 })
  })

  it('leaves keys it cannot use to the application', () => {
    const h = harness({ furniture: [item('a', 2, 2)] })
    const tool = new SelectTool()

    expect(tool.onKeyDown(press('x'), h.ctx)).toBe(false)
    // Nothing selected: the bracket keys have no pivot, so they pass through.
    expect(tool.onKeyDown(press(']'), h.ctx)).toBe(false)
    expect(h.edits).toEqual([])
  })

  it('will not nudge a locked object either', () => {
    const h = harness({ furniture: [item('a', 2, 2, { locked: true })] })
    const tool = new SelectTool()
    tool.onPointerDown(pointer(2, 2, { hit: pick('furniture', 'a', 2, 2) }), h.ctx)
    tool.onPointerUp(pointer(2, 2), h.ctx)

    tool.onKeyDown(press('ArrowRight'), h.ctx)

    // An arrow key is the easiest way to move something by accident, so this is
    // the case the lock most needs to cover.
    expect(furnitureById(h, 'a').position.x).toBe(2)
    expect(h.edits).toEqual([])
  })
})

describe('leaving the tool', () => {
  it('drops any in-flight gesture and clears what it drew', () => {
    const h = harness({ furniture: [item('a', 2, 2)] })
    const tool = new SelectTool()

    tool.onPointerDown(pointer(2, 2, { hit: pick('furniture', 'a', 2, 2) }), h.ctx)
    tool.onPointerMove(pointer(4, 2), h.ctx)
    tool.onPointerMove(pointer(4, 2), h.ctx)
    const midDrag = furnitureById(h, 'a').position
    tool.onDeactivate(h.ctx)

    expect(h.draft()).toEqual([])
    expect(h.labels()).toEqual([])

    // The abandoned drag must not resume on the next pointer move the tool
    // sees, or switching tools mid-drag would keep editing behind the user.
    tool.onPointerMove(pointer(9, 9), h.ctx)
    expect(furnitureById(h, 'a').position).toEqual(midDrag)
  })
})
