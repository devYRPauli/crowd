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
 *
 * Snapping has a suite of its own, so `ctx.snap` is the identity unless a test
 * calls `snapTo` to stand a known snap in its place.
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
  OPENING_JAMB,
} from '../../core/model/standards'
import { openingTransform, serviceQueue } from '../../core/model/planGeometry'
import type { Vec2 } from '../../core/math/vec2'
import type {
  CrowdDocument,
  FurnitureItem,
  Opening,
  Plan,
  PlanObjectKind,
  PlanObjectRef,
  ServicePoint,
  Wall,
  Zone,
} from '../../core/model/types'
import type { DraftShape, PickHit, PointerInfo } from '../../render/Viewport'
import type { Label } from '../../render/LabelLayer'
import type { SnapOptions, SnapResult } from '../snapping'
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
  let snapOverride: ((point: Vec2) => SnapResult) | null = null
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
    // The identity by default, so that the geometry a test asserts is the
    // geometry the tool computed rather than the grid's.
    snap(point, options) {
      snapRequests.push(options ?? {})
      return snapOverride ? snapOverride(point) : { point: { ...point }, kind: 'none', guides: [] }
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
    /** Stand a known snap in place of the identity for the rest of a test. */
    snapTo: (snapper: (point: Vec2) => SnapResult) => {
      snapOverride = snapper
    },
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

const pick = (kind: PlanObjectKind, id: string, x: number, y: number, height = 0): PickHit => ({
  ref: { kind, id },
  point: { x, y },
  height,
})

/** For points that come out of trig or a clamp rather than whole metres. */
const expectPoint = (actual: Vec2, expected: Vec2): void => {
  expect(actual.x).toBeCloseTo(expected.x, 9)
  expect(actual.y).toBeCloseTo(expected.y, 9)
}

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

/** Press and release without moving, which is how a plain click selects. */
const click = (tool: SelectTool, h: Harness, hit: PickHit): void => {
  tool.onPointerDown(pointer(hit.point.x, hit.point.y, { hit }), h.ctx)
  tool.onPointerUp(pointer(hit.point.x, hit.point.y), h.ctx)
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

const door = (
  id: string,
  wallId: string,
  offset: number,
  over: Partial<Opening> = {},
): Opening => ({
  id,
  wallId,
  offset,
  width: DEFAULT_DOOR_WIDTH,
  height: DEFAULT_DOOR_HEIGHT,
  sill: 0,
  kind: 'door',
  ...over,
})

const zone = (id: string, polygon: Vec2[], over: Partial<Zone> = {}): Zone => ({
  id,
  kind: 'waypoint',
  name: id,
  polygon,
  ...over,
})

/** A counter the size the place tool builds, 1.8 m along its face. */
const counter = (
  id: string,
  x: number,
  y: number,
  over: Partial<ServicePoint> = {},
): ServicePoint => ({
  id,
  name: id,
  position: { x, y },
  rotation: 0,
  width: 1.8,
  depth: 0.7,
  servers: 2,
  serviceTime: { kind: 'constant', mean: 20 },
  queueSpacing: 0.6,
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

const zoneById = (h: Harness, id: string): Zone => {
  const found = h.doc().plan.zones.find((z) => z.id === id)
  if (!found) throw new Error(`no zone ${id}`)
  return found
}

const serviceById = (h: Harness, id: string): ServicePoint => {
  const found = h.doc().plan.servicePoints.find((s) => s.id === id)
  if (!found) throw new Error(`no service point ${id}`)
  return found
}

const openingById = (h: Harness, id: string): Opening => {
  const found = h.doc().plan.openings.find((o) => o.id === id)
  if (!found) throw new Error(`no opening ${id}`)
  return found
}

/** Where a door stands on the floor, rather than how far along its wall it is. */
const doorPosition = (h: Harness, id: string): Vec2 => {
  const placed = openingTransform(h.doc().plan, openingById(h, id))
  if (!placed) throw new Error(`opening ${id} has lost its wall`)
  return placed.position
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

    // A press whose ray never reaches the floor — the camera tilted up to the
    // horizon — is not a press on empty space and must not clear anything.
    tool.onPointerDown(pointer(20, 20, { ground: null }), h.ctx)
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

  it('takes the object the viewport picked even when the floor under the cursor is elsewhere', () => {
    const h = harness({ furniture: [item('shelf', 5, 5), item('floor', 2, 2)] })
    const tool = new SelectTool()

    // A tilted camera catches the top of a tall shelf while the same ray meets
    // the ground metres short of its footprint. Which object that is belongs to
    // the renderer's raycast — it is what the hover highlight already shows —
    // so the tool takes the ref and never hit-tests the ground point itself.
    tool.onPointerDown(pointer(2, 2, { hit: pick('furniture', 'shelf', 2, 2, 1.8) }), h.ctx)
    expect(h.selection()).toEqual([ref('furniture', 'shelf')])

    tool.onPointerMove(pointer(3, 2), h.ctx)
    tool.onPointerMove(pointer(3, 2), h.ctx)

    // And it moves by how far the pointer travelled, so grabbing an object
    // anywhere on it never makes it jump under the cursor.
    expect(furnitureById(h, 'shelf').position).toEqual({ x: 6, y: 5 })
    expect(furnitureById(h, 'floor').position).toEqual({ x: 2, y: 2 })
  })

  it('gives a press on a handle to the handle, not to what the handle covers', () => {
    const h = harness({ furniture: [item('a', 2, 2), item('b', 2, 1.04)] })
    const tool = new SelectTool()
    click(tool, h, pick('furniture', 'a', 2, 2))

    // The ring is drawn over the plan and at this zoom it lands on top of 'b'.
    // Falling through would swap the selection out from under the gesture the
    // user has already started.
    const ring = { x: 2, y: 2 - 0.5 - RING_OFFSET_M }
    const covered = pick('furniture', 'b', ring.x, ring.y)
    tool.onPointerDown(pointer(ring.x, ring.y, { hit: covered }), h.ctx)
    tool.onPointerMove(pointer(3, 2), h.ctx)

    expect(h.selection()).toEqual([ref('furniture', 'a')])
    expect(furnitureById(h, 'a').rotation).toBeCloseTo(Math.PI / 2, 9)
    expect(furnitureById(h, 'b').rotation).toBe(0)
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

    // The same band drawn the other way round. A rubber band is a rectangle,
    // not a direction, and dragging up and left is how anything at the
    // bottom-right of the plan gets caught. The press clears the selection
    // first, so finding the item again is the band's doing.
    tool.onPointerDown(pointer(5, 5), h.ctx)
    tool.onPointerMove(pointer(0, 0), h.ctx)
    expect(h.draft()[0].points[0]).toEqual({ x: 0, y: 0 })
    tool.onPointerUp(pointer(0, 0), h.ctx)
    expect(h.selection()).toEqual([ref('furniture', 'in')])
  })

  it('needs a band wider than the click threshold before it selects anything', () => {
    const h = harness({ furniture: [item('a', 2, 2)] })
    const tool = new SelectTool()
    // The item's near corner is at (1.5, 1.5); both bands below straddle it, so
    // only the threshold can tell them apart. Without it the jitter of an
    // ordinary click would rubber-band whatever corner happened to be nearby.
    const tiny = DRAG_THRESHOLD_M * 0.75

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

    // SUSPECTED BUG: the additive marquee concatenates without deduplicating,
    // so the item is in the selection twice. Moves stay correct because they are absolute, but
    // the inspector and any per-selection count now see two objects.
    expect(h.selection()).toEqual([ref('furniture', 'a'), ref('furniture', 'a')])
  })

  it('SUSPECTED BUG: misses a wall that crosses the band with both ends outside it', () => {
    const h = harness({ walls: [wall('w', { x: -5, y: 3 }, { x: 5, y: 3 })] })
    const tool = new SelectTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerMove(pointer(1, 6), h.ctx)
    tool.onPointerUp(pointer(1, 6), h.ctx)

    // SUSPECTED BUG: the band is tested against footprint *corners* only, so a
    // long wall drawn straight through it is never picked up: the user has to enclose an end.
    expect(h.selection()).toEqual([])
  })

  it('takes every kind of object the band encloses', () => {
    const h = harness({
      walls: [wall('w', { x: 1, y: 1 }, { x: 3, y: 1 })],
      furniture: [item('f', 2, 3), item('far', 20, 20)],
      zones: [
        zone('z', [
          { x: 1, y: 4 },
          { x: 3, y: 4 },
          { x: 3, y: 6 },
          { x: 1, y: 6 },
        ]),
      ],
      servicePoints: [counter('s', 2, 7)],
    })
    const tool = new SelectTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerMove(pointer(9, 9), h.ctx)
    tool.onPointerUp(pointer(9, 9), h.ctx)

    // Plan order, and it matters: the first of them leads the next drag, and
    // the lead is the one the snapping follows.
    expect(h.selection()).toEqual([
      ref('wall', 'w'),
      ref('furniture', 'f'),
      ref('zone', 'z'),
      ref('service', 's'),
    ])
  })

  it('takes an object it clips a corner off and leaves the one it passes beside', () => {
    const h = harness({ furniture: [item('clipped', 5.2, 2), item('beside', 6.5, 2)] })
    const tool = new SelectTool()

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerMove(pointer(5, 4), h.ctx)
    tool.onPointerUp(pointer(5, 4), h.ctx)

    // Touching is enough, enclosing is not required: a band that had to
    // swallow an object whole could not lift a row of tables off a wall
    // without taking the wall with them.
    expect(h.selection()).toEqual([ref('furniture', 'clipped')])
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

  it('snaps the leading object and carries the rest of the selection by that same delta', () => {
    const h = harness({ furniture: [item('lead', 2, 2), item('follower', 5, 2)] })
    const tool = new SelectTool()
    h.ctx.setSelection([ref('furniture', 'lead'), ref('furniture', 'follower')])
    h.snapTo((point) => ({
      point: { x: Math.round(point.x), y: Math.round(point.y) },
      kind: 'grid',
      guides: [{ from: { x: 3, y: 0 }, to: { x: 3, y: 4 }, kind: 'grid' }],
    }))

    tool.onPointerDown(pointer(2, 2, { hit: pick('furniture', 'lead', 2, 2) }), h.ctx)
    tool.onPointerMove(pointer(3.4, 2.2), h.ctx)
    tool.onPointerMove(pointer(3.4, 2.2), h.ctx)

    // One object lands on the grid and the others keep their spacing with it:
    // a row of tables set out relative to each other must not be pulled apart
    // by dragging the row onto a gridline.
    expect(furnitureById(h, 'lead').position).toEqual({ x: 3, y: 2 })
    expect(furnitureById(h, 'follower').position).toEqual({ x: 6, y: 2 })
    // The guide explaining the snap has to reach the screen, or the object
    // lands somewhere the pointer is not for no visible reason.
    expect(h.draft().map((shape) => shape.points)).toEqual([
      [
        { x: 3, y: 0 },
        { x: 3, y: 4 },
      ],
    ])
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

    // The tool declines the key, so the application's handler runs instead and
    // clears the selection — which is what the rest of this test stands in for.
    expect(tool.onKeyDown(press('Escape'), h.ctx)).toBe(false)
    h.ctx.setSelection([])

    tool.onPointerMove(pointer(6, 2), h.ctx)
    tool.onPointerUp(pointer(6, 2), h.ctx)

    // SUSPECTED BUG: every other tool puts down what it was drawing on Escape.
    // This one strands the item two metres from where it was picked up and
    // commits the step, so the only way back to the plan the user was looking
    // at is undo.
    expect(furnitureById(h, 'a').position).toEqual({ x: 4, y: 2 })
    expect(h.undoSteps()).toBe(1)
    h.undo()
    expect(h.doc()).toBe(original)
  })

  it('lands back on the original position when a drag returns to where it began', () => {
    const h = harness({ furniture: [item('a', 2, 2)] })
    const tool = new SelectTool()
    const original = h.doc()

    tool.onPointerDown(pointer(2, 2, { hit: pick('furniture', 'a', 2, 2) }), h.ctx)
    tool.onPointerMove(pointer(4, 2), h.ctx)
    tool.onPointerMove(pointer(4, 2), h.ctx)
    tool.onPointerMove(pointer(2, 2), h.ctx)
    tool.onPointerUp(pointer(2, 2), h.ctx)

    // Each frame is measured from the press rather than from the frame before
    // it, so the round trip lands back on the original position exactly
    // instead of a few accumulated floating-point metres away from it.
    expect(h.doc().plan).toEqual(original.plan)

    // And the whole out-and-back is still the single step the gesture is
    // entitled to, whatever route the pointer took to get there.
    expect(h.undoSteps()).toBe(1)
    h.undo()
    expect(h.doc()).toBe(original)
  })

  it('moves a wall, a zone and a counter together, doors and all', () => {
    const h = harness({
      walls: [wall('w', { x: 0, y: 0 }, { x: 4, y: 0 })],
      openings: [door('d', 'w', 1)],
      zones: [
        zone('z', [
          { x: 0, y: 2 },
          { x: 2, y: 2 },
          { x: 2, y: 4 },
          { x: 0, y: 4 },
        ]),
      ],
      servicePoints: [counter('s', 6, 6)],
    })
    const tool = new SelectTool()
    h.ctx.setSelection([ref('wall', 'w'), ref('zone', 'z'), ref('service', 's')])

    drag(tool, h, pick('wall', 'w', 2, 0), { x: 3, y: -2 })

    // Each kind is anchored differently — a wall by its midpoint, a zone by
    // its centroid, a counter by its face — and all three have to come out
    // shifted by the same metre-for-metre delta or the layout distorts.
    expect(wallById(h, 'w').a).toEqual({ x: 1, y: -2 })
    expect(wallById(h, 'w').b).toEqual({ x: 5, y: -2 })
    expect(zoneById(h, 'z').polygon).toEqual([
      { x: 1, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 2 },
      { x: 1, y: 2 },
    ])
    expect(serviceById(h, 's').position).toEqual({ x: 7, y: 4 })
    // A door is held as a distance along its wall, so it travels with the
    // wall for free and is still cut to the width it was ordered at.
    expect(doorPosition(h, 'd')).toEqual({ x: 2, y: -2 })
    expect(openingById(h, 'd').width).toBe(DEFAULT_DOOR_WIDTH)
  })

  it('SUSPECTED BUG: a counter dragged across the room leaves its drawn queue behind', () => {
    const drawn = [
      { x: 2, y: 3 },
      { x: 2, y: 6 },
    ]
    const h = harness({
      servicePoints: [counter('till', 2, 2, { queue: drawn }), counter('auto', 2, 8)],
    })
    const tool = new SelectTool()
    h.ctx.setSelection([ref('service', 'till'), ref('service', 'auto')])
    const derived = serviceQueue(serviceById(h, 'auto'))

    drag(tool, h, pick('service', 'till', 2, 2), { x: 9, y: 2 })

    expect(serviceById(h, 'till').position).toEqual({ x: 9, y: 2 })
    // The counter nobody drew a queue for is fine: its centreline is derived
    // from its own position and facing every time it is asked for, so it
    // travels the same seven metres the counter did.
    expect(serviceQueue(serviceById(h, 'auto'))[0].x - derived[0].x).toBeCloseTo(7, 9)

    // SUSPECTED BUG: a queue drawn by hand is a world-space centreline that
    // the drag never touches, so it still runs up to where the counter used to
    // stand. People walk to the old spot, and the queue length the study
    // reports is measured along a line nobody is standing on. `paste` already
    // shifts a drawn queue by the paste offset, so the document model agrees
    // it should travel with its counter — only the drag disagrees.
    expect(serviceById(h, 'till').queue).toEqual(drawn)
  })

  it('SUSPECTED BUG: a door can be selected but no gesture in this tool will move it', () => {
    const h = harness({
      walls: [wall('w', { x: 0, y: 0 }, { x: 6, y: 0 })],
      openings: [door('d', 'w', 3)],
    })
    const tool = new SelectTool()

    tool.onPointerDown(pointer(3, 0, { hit: pick('opening', 'd', 3, 0) }), h.ctx)
    tool.onPointerMove(pointer(5, 0), h.ctx)
    tool.onPointerMove(pointer(5, 0), h.ctx)

    expect(h.selection()).toEqual([ref('opening', 'd')])
    // SUSPECTED BUG: the renderer hands out opening refs and the inspector
    // edits them, but `positionOf` and `moveObject` have no case for one, so a
    // door is selectable and immovable. Nothing says so: there is no handle,
    // no ring and no toast, and the readout counts out the two metres the
    // pointer travelled while the door has not moved at all. Sliding a doorway
    // along its wall is an everyday edit, and the offset field in the
    // inspector is the only way to do it.
    expect(h.labels()[0].text).toBe('2.00 m')
    expect(openingById(h, 'd').offset).toBe(3)

    tool.onPointerUp(pointer(5, 0), h.ctx)
    expect(h.draft()).toEqual([])
    expect(h.edits).toEqual([])

    expect(tool.onKeyDown(press('ArrowRight'), h.ctx)).toBe(true)
    expect(openingById(h, 'd').offset).toBe(3)
    expect(h.edits).toEqual([])
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

  it('hands back an unlocked copy of a locked original', () => {
    const h = harness({ walls: [wall('w', { x: 0, y: 0 }, { x: 4, y: 0 }, { locked: true })] })
    const tool = new SelectTool()

    drag(tool, h, pick('wall', 'w', 2, 0), { x: 2, y: 3 }, { press: { altKey: true } })

    // Tracing over a locked survey line is the reason to lock one, and copying
    // a piece of it off to work on is the reason to alt-drag: the original has
    // to stay put and locked, and the copy has to be movable or the gesture
    // ends with two objects the user cannot touch.
    expect(wallById(h, 'w').a).toEqual({ x: 0, y: 0 })
    expect(wallById(h, 'w').locked).toBe(true)
    const copy = h.doc().plan.walls.find((w) => w.id !== 'w')
    expect(copy?.locked).toBe(false)
    expect(copy?.a).toEqual({ x: 0, y: 3 })
    expect(copy?.b).toEqual({ x: 4, y: 3 })
  })

  it('SUSPECTED BUG: one alt-drag costs two undo steps', () => {
    const h = harness({ furniture: [item('a', 2, 2)] })
    const tool = new SelectTool()

    drag(tool, h, pick('furniture', 'a', 2, 2), { x: 6, y: 2 }, { press: { altKey: true } })

    // SUSPECTED BUG: 'Duplicate' and 'move-selection' are different coalesce
    // keys, so the gesture splits in two. Undoing once leaves a copy sitting exactly on top
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

  it('snaps to 15°, to 5° with Shift, and runs free with Alt', () => {
    // The ring starts due south of the centre and the pointer ends 0.1 rad
    // north of due east, so the turn asked for is 95.73°.
    const asked = 90 + (0.1 * 180) / Math.PI
    const cases: Array<[Partial<PointerInfo>, number, string]> = [
      [{}, 90, '90°'],
      [{ shiftKey: true }, 95, '95°'],
      [{ altKey: true }, asked, '96°'],
    ]

    for (const [modifiers, degrees, readout] of cases) {
      const h = harness({ furniture: [item('a', 2, 2)] })
      const tool = new SelectTool()
      click(tool, h, pick('furniture', 'a', 2, 2))

      const ring = ringFor(2, 2)
      tool.onPointerDown(pointer(ring.x, ring.y), h.ctx)
      tool.onPointerMove(pointer(2 + Math.cos(0.1), 2 + Math.sin(0.1), modifiers), h.ctx)

      expect((furnitureById(h, 'a').rotation * 180) / Math.PI).toBeCloseTo(degrees, 9)
      // The readout is rounded to the degree, so a free turn can only be
      // trusted to the degree it shows — the notches are what square things up.
      expect(h.labels()[0].text).toBe(readout)
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

    expectPoint(furnitureById(h, 'a').position, { x: 3, y: 1 })

    // SUSPECTED BUG: the same pointer position again. The rotation field is
    // rebuilt from the angle captured at the press, but the position is re-read
    // from the document and spun by the full delta once more, so the pair keeps
    // walking round the pivot while the ring says it has turned 90° once. A
    // pointer that hesitates on its way round is enough to fire it.
    tool.onPointerMove(pointer(4, 2), h.ctx)

    expect(furnitureById(h, 'a').rotation).toBeCloseTo(Math.PI / 2, 9)
    expect(h.labels()[0].text).toBe('90°')
    expectPoint(furnitureById(h, 'a').position, { x: 4, y: 2 })
    expectPoint(furnitureById(h, 'b').position, { x: 2, y: 2 })
  })

  it('SUSPECTED BUG: a wall keeps turning while the pointer stands still', () => {
    const h = harness({ walls: [wall('w', { x: 0, y: 0 }, { x: 4, y: 0 })] })
    const tool = new SelectTool()
    click(tool, h, pick('wall', 'w', 2, 0))

    const ring = { x: 2, y: -DEFAULT_WALL_THICKNESS / 2 - RING_OFFSET_M }
    tool.onPointerDown(pointer(ring.x, ring.y), h.ctx)
    // Ring at -90° from the centre, pointer now due +X: a quarter turn, so
    // the wall stands on end about its own midpoint.
    tool.onPointerMove(pointer(3, 0), h.ctx)
    expectPoint(wallById(h, 'w').a, { x: 2, y: -2 })

    // SUSPECTED BUG: the same pointer position again. Furniture is rebuilt
    // from the rotation captured at the press, but a wall has no rotation
    // field, so its ends are read back out of the document and spun by the
    // whole delta a second time. The readout still says 90° while the wall has
    // turned 180° — and unlike the group case above this is a single object,
    // where nothing warns the user that a traced wall has left its survey.
    tool.onPointerMove(pointer(3, 0), h.ctx)
    expect(h.labels()[0].text).toBe('90°')
    expectPoint(wallById(h, 'w').a, { x: 4, y: 0 })
    expectPoint(wallById(h, 'w').b, { x: 0, y: 0 })
  })
})

describe('wall endpoints', () => {
  /** Select the wall, then take hold of one of its end handles. */
  const grab = (tool: SelectTool, h: Harness, end: 'a' | 'b'): void => {
    click(tool, h, pick('wall', 'w', 3, 0))
    const point = wallById(h, 'w')[end]
    tool.onPointerDown(pointer(point.x, point.y), h.ctx)
  }

  it('stretches the wall from the end you took hold of', () => {
    const h = harness({ walls: [wall('w', { x: 0, y: 0 }, { x: 6, y: 0 })] })
    const tool = new SelectTool()

    grab(tool, h, 'b')
    tool.onPointerMove(pointer(9, 1), h.ctx)

    expect(wallById(h, 'w').b).toEqual({ x: 9, y: 1 })
    // The far end staying put is the whole point of an endpoint handle: that
    // is where the wall meets its neighbours.
    expect(wallById(h, 'w').a).toEqual({ x: 0, y: 0 })
    expect(h.labels()[0].text).toBe('9.06 m')

    tool.onPointerUp(pointer(9, 1), h.ctx)
    expect(h.undoSteps()).toBe(1)
    expect(h.edits.every((e) => e.coalesceKey === 'wall-endpoint-w')).toBe(true)
    expect(h.edits[0].label).toBe('Edit wall')
  })

  it('holds the end that is not moving as the anchor, and never snaps to itself', () => {
    const h = harness({ walls: [wall('w', { x: 0, y: 0 }, { x: 6, y: 0 })] })
    const tool = new SelectTool()

    grab(tool, h, 'b')
    h.snapRequests.length = 0
    tool.onPointerMove(pointer(9, 1), h.ctx)

    const request = h.snapRequests[0]
    // Squaring a wall up is most of the reason to drag an end at all, so the
    // angle is measured from the end staying put, at the document's own step.
    expect(request.anchor).toEqual({ x: 0, y: 0 })
    expect(request.angleSnapDeg).toBe(h.ctx.document.settings.angleSnapDeg)
    expect([...(request.exclude ?? [])]).toEqual(['w'])
  })

  it('leaves the doors cut into the wall standing where they were drawn', () => {
    const h = harness({
      walls: [wall('w', { x: 0, y: 0 }, { x: 6, y: 0 })],
      openings: [door('d', 'w', 3)],
    })
    const tool = new SelectTool()

    grab(tool, h, 'b')
    tool.onPointerMove(pointer(9, 0), h.ctx)
    tool.onPointerUp(pointer(9, 0), h.ctx)

    // Lengthening the far end of a wall is how a room gets extended, and the
    // doorway already in it has to survive that untouched — still in the same
    // wall, still on the same spot of floor, still a 3'0" leaf.
    expect(doorPosition(h, 'd')).toEqual({ x: 3, y: 0 })
    expect(openingById(h, 'd').wallId).toBe('w')
    expect(openingById(h, 'd').width).toBe(DEFAULT_DOOR_WIDTH)
  })

  it('narrows a door rather than letting it hang off a wall dragged shorter', () => {
    const h = harness({
      walls: [wall('w', { x: 0, y: 0 }, { x: 6, y: 0 })],
      openings: [door('d', 'w', 3)],
    })
    const tool = new SelectTool()

    grab(tool, h, 'b')
    tool.onPointerMove(pointer(0.8, 0), h.ctx)
    tool.onPointerUp(pointer(0.8, 0), h.ctx)

    // The door was at 3 m along a wall that is now 0.8 m long. What must not
    // happen is a hole left hanging past the end of the wall it belongs to:
    // it is pulled back inside and cut down to what the jambs leave.
    expect(openingById(h, 'd').width).toBeCloseTo(0.8 - 2 * OPENING_JAMB, 9)
    expectPoint(doorPosition(h, 'd'), { x: 0.4, y: 0 })
  })

  it('offers the ends of a wall only while the wall is the only thing selected', () => {
    const h = harness({
      walls: [wall('w', { x: 0, y: 0 }, { x: 4, y: 0 })],
      furniture: [item('a', 6, 0)],
    })
    const tool = new SelectTool()

    click(tool, h, pick('wall', 'w', 2, 0))
    // Both ends and the ring.
    expect(h.draft()).toHaveLength(3)

    tool.onPointerDown(pointer(6, 0, { hit: pick('furniture', 'a', 6, 0), shiftKey: true }), h.ctx)
    tool.onPointerUp(pointer(6, 0), h.ctx)
    // Only the ring. With two things in hand, a press by the wall's end is the
    // start of a drag of the pair — stretching one member of a group from a
    // handle nobody could see the other half of would be a silent reshape.
    expect(h.draft()).toHaveLength(1)

    tool.onPointerDown(pointer(0, 0), h.ctx)
    tool.onPointerMove(pointer(-1, -1), h.ctx)
    expect(wallById(h, 'w').a).toEqual({ x: 0, y: 0 })
  })

  it('SUSPECTED BUG: dragging the near end drags every door along with it', () => {
    const h = harness({
      walls: [wall('w', { x: 0, y: 0 }, { x: 6, y: 0 })],
      openings: [door('d', 'w', 3)],
    })
    const tool = new SelectTool()

    grab(tool, h, 'a')
    tool.onPointerMove(pointer(-2, 0), h.ctx)
    tool.onPointerUp(pointer(-2, 0), h.ctx)

    expect(wallById(h, 'w').a).toEqual({ x: -2, y: 0 })
    // SUSPECTED BUG: an offset is measured from `a`, and moving `a` does not
    // adjust it, so extending the wall 2 m backwards slides the door 2 m as
    // well — from x = 3 to x = 1. Dragging `b` leaves it alone, which makes
    // the two ends of one handle pair behave differently. The fix is to add
    // the distance `a` travelled along the wall to every opening in it. It
    // matters because a door is what an egress route goes through: the way
    // out of the room moves under a gesture aimed at a wall end.
    expect(doorPosition(h, 'd')).toEqual({ x: 1, y: 0 })
    expect(openingById(h, 'd').offset).toBe(3)
  })
})

describe('zone vertices', () => {
  const square = (): Vec2[] => [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
    { x: 0, y: 4 },
  ]

  it('drags one corner and leaves the rest of the outline where it was', () => {
    const h = harness({ zones: [zone('z', square())] })
    const tool = new SelectTool()
    click(tool, h, pick('zone', 'z', 2, 2))

    tool.onPointerDown(pointer(4, 4), h.ctx)
    tool.onPointerMove(pointer(6, 5), h.ctx)
    tool.onPointerMove(pointer(6, 5), h.ctx)
    tool.onPointerUp(pointer(6, 5), h.ctx)

    expect(zoneById(h, 'z').polygon).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 6, y: 5 },
      { x: 0, y: 4 },
    ])
    // The index is in the coalesce key, so pulling one corner about is a
    // single undo step and the next corner starts a step of its own.
    expect(h.undoSteps()).toBe(1)
    expect(h.edits.every((e) => e.coalesceKey === 'zone-vertex-z-2')).toBe(true)
    // A corner that could snap to its own zone would stick to the outline it
    // is being dragged off.
    expect(h.snapRequests.every((r) => [...(r.exclude ?? [])].includes('z'))).toBe(true)
  })

  it('adds a corner where a double-click lands on the outline', () => {
    const h = harness({ zones: [zone('z', square())] })
    const tool = new SelectTool()

    tool.onDoubleClick(pointer(4, 2, { hit: pick('zone', 'z', 4, 2) }), h.ctx)

    expect(zoneById(h, 'z').polygon).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 2 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ])
    // No coalesce key: adding a point is a finished edit, not a gesture, and
    // it must not merge into whatever the user does next.
    expect(h.edits).toEqual([{ label: 'Add zone point', coalesceKey: undefined }])
  })

  it('SUSPECTED BUG: a double-click inside a zone folds the outline in to the pointer', () => {
    const h = harness({
      zones: [
        zone('z', [
          { x: 0, y: 0 },
          { x: 8, y: 0 },
          { x: 8, y: 8 },
          { x: 0, y: 8 },
        ]),
      ],
    })
    const tool = new SelectTool()

    tool.onDoubleClick(pointer(4, 4, { hit: pick('zone', 'z', 4, 4) }), h.ctx)

    // SUSPECTED BUG: the new corner is placed at the pointer rather than on
    // the outline, and the edge it joins is chosen by the nearest edge
    // *midpoint*. A double-click in the middle of a zone — most of a zone's
    // area, and easy to do while trying to get at something standing on it —
    // therefore cuts a notch from an edge right into the centre. It should
    // add the point only near an edge, projected onto that edge. A zone is a
    // counted region, so a fold like this quietly changes who a measurement
    // zone says was inside it, and which floor a keep-clear rule covers.
    expect(zoneById(h, 'z').polygon).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 4 },
      { x: 8, y: 0 },
      { x: 8, y: 8 },
      { x: 0, y: 8 },
    ])
  })

  it('SUSPECTED BUG: a double-click reshapes a zone that is locked', () => {
    const h = harness({ zones: [zone('z', square(), { locked: true })] })
    const tool = new SelectTool()

    tool.onDoubleClick(pointer(4, 2, { hit: pick('zone', 'z', 4, 2) }), h.ctx)

    // SUSPECTED BUG: every pointer gesture in the tool filters the selection
    // through `movable`, but `onDoubleClick` asks the document for the zone and
    // edits it without ever asking whether it is locked — and a locked zone
    // shows no vertex handles, so there is nothing on screen to explain where
    // the new corner came from. A measurement zone is locked precisely so that
    // double-clicking about on top of it cannot change what it counts.
    expect(zoneById(h, 'z').polygon).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 2 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ])
  })

  it('ignores a double-click on anything that is not a zone', () => {
    const h = harness({ furniture: [item('a', 2, 2)], zones: [zone('z', square())] })
    const tool = new SelectTool()

    tool.onDoubleClick(pointer(2, 2, { hit: pick('furniture', 'a', 2, 2) }), h.ctx)

    expect(h.edits).toEqual([])
    expect(zoneById(h, 'z').polygon).toHaveLength(4)
  })
})

describe('the traced backdrop', () => {
  it('drags like anything else but carries no handles of its own', () => {
    const h = harness({
      backdrop: {
        src: 'data:image/png;base64,',
        position: { x: 0, y: 0 },
        rotation: 0,
        width: 10,
        depth: 8,
        opacity: 0.5,
        visible: true,
      },
    })
    const tool = new SelectTool()

    drag(tool, h, pick('backdrop', 'backdrop', 0, 0), { x: 2, y: 1 })

    expect(h.doc().plan.backdrop?.position).toEqual({ x: 2, y: 1 })
    // A backdrop has no footprint, so there is no selection centre, no ring
    // and no pivot for the bracket keys either: turning a photographed plan
    // square-on is the inspector's job, not the tool's.
    expect(h.draft()).toEqual([])
    expect(tool.onKeyDown(press(']'), h.ctx)).toBe(false)
    expect(h.doc().plan.backdrop?.rotation).toBe(0)
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

  it('SUSPECTED BUG: keeps a rotate ring that will not turn a locked wall', () => {
    const open = harness({ walls: [wall('w', { x: 0, y: 0 }, { x: 4, y: 0 })] })
    const openTool = new SelectTool()
    click(openTool, open, pick('wall', 'w', 2, 0))
    // Two endpoints and the ring.
    expect(open.draft()).toHaveLength(3)

    const h = harness({ walls: [wall('w', { x: 0, y: 0 }, { x: 4, y: 0 }, { locked: true })] })
    const tool = new SelectTool()
    click(tool, h, pick('wall', 'w', 2, 0))
    // The endpoints are gone, as they should be.
    expect(h.draft()).toHaveLength(1)

    const ring = { x: 2, y: -DEFAULT_WALL_THICKNESS / 2 - RING_OFFSET_M }
    tool.onPointerDown(pointer(ring.x, ring.y), h.ctx)
    tool.onPointerMove(pointer(3, 0), h.ctx)

    // SUSPECTED BUG: rotation runs over `movable`, so the ring the tool drew
    // for a locked wall is a control that cannot do anything — and it reads
    // out a quarter turn while the wall stands exactly where it was. Either
    // the ring goes with the endpoint handles, or the lock lets it through.
    expect(h.labels()[0].text).toBe('90°')
    expect(wallById(h, 'w').a).toEqual({ x: 0, y: 0 })
    expect(wallById(h, 'w').b).toEqual({ x: 4, y: 0 })
    expect(h.edits).toEqual([])
  })

  it('SUSPECTED BUG: turns a locked object under the bracket keys', () => {
    const h = harness({ furniture: [item('a', 2, 2, { locked: true })] })
    const tool = new SelectTool()
    click(tool, h, pick('furniture', 'a', 2, 2))

    // SUSPECTED BUG: the bracket keys rotate `ctx.selection` where every other
    // edit in the tool rotates `movable(ctx)`, so one keystroke goes straight
    // past the lock that the ring, the drag and the arrow keys all honour. The
    // lock exists to stop a finished shell being knocked out of true while
    // somebody draws over it, and 15° is a long way out of true.
    expect(tool.onKeyDown(press(']'), h.ctx)).toBe(true)
    expect(furnitureById(h, 'a').rotation).toBeCloseTo(Math.PI / 12, 9)
    expect(h.edits).toEqual([{ label: 'Rotate', coalesceKey: 'rotate-key' }])
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

    // SUSPECTED BUG: a hard-coded 1 m, larger than the 0.5 m grid step it
    // replaces, while Shift-[ and Shift-] below give the *fine* 1° rotation.
    // One modifier, two opposite meanings — and a dimension literal outside
    // standards.ts.
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
