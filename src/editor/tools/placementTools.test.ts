/**
 * Placement tools, driven through a fake ToolContext.
 *
 * The fake records edits against the real undo history rather than a store, so
 * "one undo step" here means what it means to the user — a single Ctrl-Z takes
 * the placement back — and not merely "apply was called once".
 */

import { describe, expect, it, vi } from 'vitest'
import { DoorTool, FurnitureTool, QueueTool, ServiceTool, WindowTool } from './placementTools'
import {
  commit,
  createHistory,
  seal as sealHistory,
  undo as undoHistory,
  undoLabel as undoMenuLabel,
} from '../../core/document/history'
import { createDocument } from '../../core/model/defaults'
import { resolveCatalogItem } from '../../library/catalog'
import {
  furnitureSize,
  furnitureVisualPolygon,
  openingTransform,
  serviceQueue,
  wallLength,
} from '../../core/model/planGeometry'
import {
  DEFAULT_DOOR_HEIGHT,
  DEFAULT_DOOR_WIDTH,
  DEFAULT_WALL_HEIGHT,
  DEFAULT_WALL_THICKNESS,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_SILL,
  DEFAULT_WINDOW_WIDTH,
  DOOR_WIDTHS,
  DOUBLE_DOOR_FROM,
  isStandard,
  OPENING_JAMB,
  WINDOW_SILLS,
  WINDOW_WIDTHS,
} from '../../core/model/standards'
import { fromAngle } from '../../core/math/vec2'
import type { History } from '../../core/document/history'
import type { Vec2 } from '../../core/math/vec2'
import type {
  CrowdDocument,
  DocumentSettings,
  Plan,
  PlanObjectRef,
  ServicePoint,
  Wall,
} from '../../core/model/types'
import type { Label } from '../../render/LabelLayer'
import type { DraftShape, PointerInfo } from '../../render/Viewport'
import type { Toast, ToolId, ToolOptions } from '../../state/editorStore'
import type { SnapOptions, SnapResult } from '../snapping'
import type { ToolContext } from '../types'

const WALL_THICKNESS = 0.2
const WALL_HEIGHT = 3
/** Metres per screen pixel; only the queue tool cares, but the context needs one. */
const SCALE = 0.01
/** The fake snapper rounds to this, so a test can tell a snapped point from a raw one. */
const GRID = 0.5

const CHAIR = resolveCatalogItem('chair-stacking')
const ROUND_TABLE = resolveCatalogItem('table-round-6')

let ids = 0

const wall = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  thickness = WALL_THICKNESS,
): Wall => ({
  id: `w${ids++}`,
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
  thickness,
  height: WALL_HEIGHT,
  kind: 'wall',
})

const counter = (patch: Partial<ServicePoint> = {}): ServicePoint => ({
  id: `svc${ids++}`,
  name: 'Bar',
  position: { x: 0, y: 0 },
  rotation: 0,
  width: 1.8,
  depth: 0.7,
  servers: 2,
  serviceTime: { kind: 'lognormal', mean: 20, sd: 7, min: 2 },
  queueSpacing: 0.6,
  ...patch,
})

const BASE_OPTIONS: ToolOptions = {
  catalogId: CHAIR.id,
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

const pointer = (
  ground: Vec2 | null,
  mods: { shiftKey?: boolean; altKey?: boolean } = {},
): PointerInfo => ({
  ground,
  screenX: 0,
  screenY: 0,
  button: 0,
  buttons: 1,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  hit: null,
  scale: SCALE,
  ...mods,
})

// Node has no KeyboardEvent, and the tools read four fields off it.
const key = (name: string, mods: { shiftKey?: boolean; altKey?: boolean } = {}): KeyboardEvent =>
  ({
    key: name,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...mods,
  }) as KeyboardEvent

interface Harness {
  readonly ctx: ToolContext
  readonly document: CrowdDocument
  /** Steps a user would have to undo to get back to the empty plan. */
  readonly undoSteps: number
  /** True when no gesture is left open, so the next edit starts a fresh step. */
  readonly sealed: boolean
  /** What the undo menu offers to take back next. */
  readonly undoMenuLabel: string | null
  readonly draft: DraftShape[]
  readonly labels: Label[]
  readonly selection: PlanObjectRef[]
  readonly toasts: Array<{ message: string; tone?: Toast['tone'] }>
  readonly edits: Array<{ label: string; coalesceKey?: string }>
  readonly snaps: Array<{ point: Vec2; options?: Partial<SnapOptions> }>
  readonly toolsRequested: ToolId[]
  undo(): void
}

const toGrid = (p: Vec2): Vec2 => ({
  x: Math.round(p.x / GRID) * GRID,
  y: Math.round(p.y / GRID) * GRID,
})

const harness = (
  plan: Partial<Plan> = {},
  options: Partial<ToolOptions> = {},
  settings: Partial<DocumentSettings> = {},
): Harness => {
  const base = createDocument()
  let history: History<CrowdDocument> = createHistory({
    ...base,
    settings: { ...base.settings, ...settings },
    plan: { ...base.plan, ...plan },
  })
  let draft: DraftShape[] = []
  let labels: Label[] = []
  let selection: PlanObjectRef[] = []
  const toasts: Harness['toasts'] = []
  const edits: Harness['edits'] = []
  const snaps: Harness['snaps'] = []
  const toolsRequested: ToolId[] = []

  const ctx: ToolContext = {
    get document() {
      return history.present.value
    },
    options: { ...BASE_OPTIONS, ...options },
    get selection() {
      return selection
    },
    scale: SCALE,
    apply(mutate, label, coalesceKey) {
      edits.push({ label, coalesceKey })
      // Same route as the store: history is the only place an edit is recorded.
      history = commit(history, mutate(history.present.value), label, coalesceKey)
    },
    seal() {
      history = sealHistory(history)
    },
    snap(point, snapOptions): SnapResult {
      snaps.push({ point, options: snapOptions })
      return { point: snapOptions?.disabled ? point : toGrid(point), kind: 'none', guides: [] }
    },
    worldToScreen: (point) => ({ x: point.x / SCALE, y: point.y / SCALE }),
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
      selection = [...selection, ref]
    },
    setHint() {},
    setTool(tool) {
      toolsRequested.push(tool)
    },
    toast(message, tone) {
      toasts.push({ message, tone })
    },
  }

  return {
    ctx,
    get document() {
      return history.present.value
    },
    get undoSteps() {
      return history.past.length
    },
    get sealed() {
      return history.present.coalesceKey === undefined
    },
    get undoMenuLabel() {
      return undoMenuLabel(history)
    },
    get draft() {
      return draft
    },
    get labels() {
      return labels
    },
    get selection() {
      return selection
    },
    toasts,
    edits,
    snaps,
    toolsRequested,
    undo() {
      history = undoHistory(history)
    },
  }
}

const centreOf = (points: Vec2[]): Vec2 => ({
  x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
  y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
})

const spanX = (points: Vec2[]): number =>
  Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x))

const spanY = (points: Vec2[]): number =>
  Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y))

/** Where the object's front points, in plan coordinates. See `wallAlignedPlacement`. */
const frontOf = (rotation: number): Vec2 => fromAngle(rotation + Math.PI / 2)

describe('DoorTool placement', () => {
  it('refuses to cut a doorway away from a wall, and says why', () => {
    const h = harness({ walls: [wall(0, 0, 10, 0)] })
    // 1.3 m from the centreline is past the 1.2 m the tool reaches.
    new DoorTool().onPointerDown(pointer({ x: 5, y: 1.3 }), h.ctx)

    expect(h.document.plan.openings).toHaveLength(0)
    expect(h.undoSteps).toBe(0)
    expect(h.selection).toEqual([])
    expect(h.toasts).toHaveLength(1)
    expect(h.toasts[0].tone).toBe('warn')
    expect(h.toasts[0].message).toMatch(/wall/i)
  })

  it('refuses when the pointer is not on the ground plane at all', () => {
    // Pointing at the sky: no ground hit, so there is nothing to place against.
    const h = harness({ walls: [wall(0, 0, 10, 0)] })
    new DoorTool().onPointerDown(pointer(null), h.ctx)

    expect(h.document.plan.openings).toHaveLength(0)
    expect(h.edits).toEqual([])
    expect(h.toasts).toHaveLength(1)
  })

  it('places once the pointer is within reach of the wall', () => {
    const w = wall(0, 0, 10, 0)
    const h = harness({ walls: [w] })
    new DoorTool().onPointerDown(pointer({ x: 5, y: 1.2 }), h.ctx)

    const [opening] = h.document.plan.openings
    expect(opening.wallId).toBe(w.id)
    expect(opening.offset).toBeCloseTo(5, 9)
    expect(opening.kind).toBe('door')
    // An opening is placed by projection on to the wall and nothing else. Ask
    // the snapper and the doorway slides to the nearest half metre along the
    // wall, away from the spot the user aimed at.
    expect(h.snaps).toEqual([])
  })

  it('cuts into the nearest wall when two are in reach', () => {
    const near = wall(0, 0, 10, 0)
    const far = wall(0, 2, 10, 2)
    const h = harness({ walls: [near, far] })
    // 1.1 m from `near`, 0.9 m from `far` — both within reach.
    new DoorTool().onPointerDown(pointer({ x: 5, y: 1.1 }), h.ctx)

    expect(h.document.plan.openings[0].wallId).toBe(far.id)
  })

  it('measures the offset along a slanted wall, not across the plan', () => {
    // A 3-4-5 wall. The click sits 5 m along it but only 3 m across the plan, so
    // an offset taken from x would hang the doorway two metres from where the
    // user pointed — and every axis-aligned test in this file would still pass.
    const w = wall(0, 0, 6, 8)
    const h = harness({ walls: [w] })
    new DoorTool().onPointerDown(pointer({ x: 2.76, y: 4.18 }), h.ctx)

    const [opening] = h.document.plan.openings
    expect(opening.wallId).toBe(w.id)
    expect(opening.offset).toBeCloseTo(5, 9)
    const placed = openingTransform(h.document.plan, opening)
    expect(placed?.position.x).toBeCloseTo(3, 9)
    expect(placed?.position.y).toBeCloseTo(4, 9)
    // Both jambs survive: an opening measured in the wrong frame runs off an end.
    expect(opening.offset - opening.width / 2).toBeGreaterThan(0)
    expect(opening.offset + opening.width / 2).toBeLessThan(wallLength(w))
  })

  it('clamps the opening so it cannot hang off either end of the wall', () => {
    const w = wall(0, 0, 10, 0)
    const tool = new DoorTool()

    const atStart = harness({ walls: [w] })
    tool.onPointerDown(pointer({ x: 0.05, y: 0.2 }), atStart.ctx)
    const first = atStart.document.plan.openings[0]
    expect(first.offset - first.width / 2).toBeGreaterThanOrEqual(0)
    // The tool clamps to half a leaf; `addOpening` then insists on a jamb too.
    expect(first.offset).toBeCloseTo(DEFAULT_DOOR_WIDTH / 2 + OPENING_JAMB, 9)

    const atEnd = harness({ walls: [w] })
    tool.onPointerDown(pointer({ x: 9.98, y: 0.2 }), atEnd.ctx)
    const second = atEnd.document.plan.openings[0]
    expect(second.offset + second.width / 2).toBeLessThanOrEqual(wallLength(w))
    expect(second.offset).toBeCloseTo(wallLength(w) - DEFAULT_DOOR_WIDTH / 2 - OPENING_JAMB, 9)
  })

  it('shrinks the doorway to a 50 mm slot on a wall too short to take one', () => {
    // SUSPECTED BUG, asserted as it behaves today: the tool checks that the
    // pointer is near a wall, never that the wall can carry an opening. The
    // preview draws a full leaf that is not even over the wall, and what lands
    // is `fitToWall`'s 50 mm floor: a doorway nobody fits through, which the
    // engine then reads as the narrowest way through the venue and sizes the
    // whole navigation grid for — 0.05 m where a 3'0" leaf asks for 0.11 m,
    // four to five times the cells, for a door that is a mistake. A wall
    // shorter than a leaf and its two jambs wants the toast an off-wall click
    // already gets.
    const h = harness({ walls: [wall(0, 0, 0.1, 0)] })
    const tool = new DoorTool()
    const at = pointer({ x: 0.05, y: 0.05 })

    tool.onPointerMove(at, h.ctx)
    expect(spanX(h.draft[0].points)).toBeCloseTo(DEFAULT_DOOR_WIDTH, 9)
    // Clamped to half a leaf from the start of a wall 0.1 m long: the green
    // rectangle is drawn 0.36 m past the far end of it.
    expect(centreOf(h.draft[0].points).x).toBeCloseTo(DEFAULT_DOOR_WIDTH / 2, 9)

    tool.onPointerDown(at, h.ctx)
    const [opening] = h.document.plan.openings
    expect(opening.width).toBeCloseTo(0.05, 9)
    expect(opening.offset).toBeCloseTo(0.05, 9)
    expect(h.toasts).toEqual([])
  })

  it('previews the door 5 cm from where it lands at the end of a wall', () => {
    // SUSPECTED BUG, asserted as it behaves today: the tool clamps the preview
    // to width/2 from the wall end, but `addOpening` refits every opening with
    // a jamb either side, so the committed door sits OPENING_JAMB further in
    // than the green rectangle the user clicked on.
    const h = harness({ walls: [wall(0, 0, 10, 0)] })
    const tool = new DoorTool()
    const at = pointer({ x: 0.05, y: 0.2 })

    tool.onPointerMove(at, h.ctx)
    const previewed = centreOf(h.draft[0].points)
    tool.onPointerDown(at, h.ctx)

    expect(previewed.x).toBeCloseTo(DEFAULT_DOOR_WIDTH / 2, 9)
    expect(h.document.plan.openings[0].offset - previewed.x).toBeCloseTo(OPENING_JAMB, 9)
  })

  it('takes width, height and sill from the tool options, not from literals', () => {
    // These three used to be hardcoded in three separate places, which is how a
    // door came out 1.0 m wide however the panel was set.
    const h = harness({ walls: [wall(0, 0, 10, 0)] }, { doorWidth: 1.2, doorHeight: 2.4 })
    new DoorTool().onPointerDown(pointer({ x: 5, y: 0.3 }), h.ctx)

    const [opening] = h.document.plan.openings
    expect(opening.width).toBe(1.2)
    expect(opening.height).toBe(2.4)
    expect(opening.width).not.toBe(DEFAULT_DOOR_WIDTH)
    expect(opening.height).not.toBe(DEFAULT_DOOR_HEIGHT)
    // Only a sill of zero is walkable, so a door has to have one.
    expect(opening.sill).toBe(0)
    expect(opening.swing).toBe('left')
  })

  it('draws the preview, the label and the clamp at the option width', () => {
    const h = harness({ walls: [wall(0, 0, 10, 0)] }, { doorWidth: 1.2 })
    const tool = new DoorTool()

    tool.onPointerMove(pointer({ x: 5, y: 0.3 }), h.ctx)
    expect(spanX(h.draft[0].points)).toBeCloseTo(1.2, 9)
    // The preview is as deep as the wall it is cut into, plus a visible lip.
    expect(spanY(h.draft[0].points)).toBeCloseTo(WALL_THICKNESS + 0.14, 9)
    expect(h.labels[0].text).toBe('1.20 m')

    tool.onPointerMove(pointer({ x: 0.05, y: 0.3 }), h.ctx)
    expect(centreOf(h.draft[0].points).x).toBeCloseTo(0.6, 9)
  })

  it('becomes a pair at and above the double-door width', () => {
    const w = wall(0, 0, 10, 0)
    const place = (doorWidth: number) => {
      const h = harness({ walls: [w] }, { doorWidth })
      new DoorTool().onPointerDown(pointer({ x: 5, y: 0.3 }), h.ctx)
      return h.document.plan.openings[0].kind
    }

    expect(place(DOUBLE_DOOR_FROM)).toBe('double-door')
    expect(place(DOUBLE_DOOR_FROM + 0.5)).toBe('double-door')
    expect(place(DOUBLE_DOOR_FROM - 0.001)).toBe('door')
    expect(place(DEFAULT_DOOR_WIDTH)).toBe('door')
  })

  it('keeps the pair kind when the wall trims the leaves below the threshold', () => {
    // Current behaviour, worth knowing: the kind is decided from the option
    // before `addOpening` trims the width to fit a 1.6 m wall, so the plan ends
    // up with a 'double-door' narrower than DOUBLE_DOOR_FROM.
    const h = harness({ walls: [wall(0, 0, 1.6, 0)] }, { doorWidth: DOUBLE_DOOR_FROM })
    new DoorTool().onPointerDown(pointer({ x: 0.8, y: 0.2 }), h.ctx)

    const [opening] = h.document.plan.openings
    expect(opening.kind).toBe('double-door')
    expect(opening.width).toBeLessThan(DOUBLE_DOOR_FROM)
    expect(opening.width).toBeCloseTo(1.6 - 2 * OPENING_JAMB, 9)
  })

  it('is one sealed undo step per door', () => {
    const h = harness({ walls: [wall(0, 0, 10, 0)] })
    const tool = new DoorTool()
    tool.onPointerDown(pointer({ x: 3, y: 0.3 }), h.ctx)
    tool.onPointerDown(pointer({ x: 7, y: 0.3 }), h.ctx)

    expect(h.document.plan.openings).toHaveLength(2)
    expect(h.undoSteps).toBe(2)
    expect(h.sealed).toBe(true)
    // A coalesce key here would merge the second door into the first step.
    expect(h.edits).toEqual([
      { label: 'Add door', coalesceKey: undefined },
      { label: 'Add door', coalesceKey: undefined },
    ])

    h.undo()
    expect(h.document.plan.openings).toHaveLength(1)
  })

  it('selects the door it just placed', () => {
    const h = harness({ walls: [wall(0, 0, 10, 0)] })
    new DoorTool().onPointerDown(pointer({ x: 5, y: 0.3 }), h.ctx)

    expect(h.selection).toEqual([{ kind: 'opening', id: h.document.plan.openings[0].id }])
  })

  it('clears a stale preview and warns in place once the pointer leaves the wall', () => {
    const h = harness({ walls: [wall(0, 0, 10, 0)] })
    const tool = new DoorTool()

    tool.onPointerMove(pointer({ x: 5, y: 0.3 }), h.ctx)
    expect(h.draft).toHaveLength(1)

    tool.onPointerMove(pointer({ x: 5, y: 4 }), h.ctx)
    expect(h.draft).toEqual([])
    expect(h.labels).toHaveLength(1)
    expect(h.labels[0].variant).toBe('warning')
    expect(h.labels[0].x).toBe(5)
    expect(h.labels[0].z).toBe(4)

    tool.onPointerMove(pointer(null), h.ctx)
    expect(h.labels).toEqual([])
  })

  it('hands the left button back to select on Escape', () => {
    const h = harness({ walls: [wall(0, 0, 10, 0)] })
    const tool = new DoorTool()

    expect(tool.onKeyDown(key('Escape'), h.ctx)).toBe(true)
    expect(h.toolsRequested).toEqual(['select'])
    expect(tool.onKeyDown(key('q'), h.ctx)).toBe(false)
  })

  it('drops its preview when it is put away', () => {
    const h = harness({ walls: [wall(0, 0, 10, 0)] })
    const tool = new DoorTool()
    tool.onPointerMove(pointer({ x: 5, y: 0.3 }), h.ctx)
    tool.onDeactivate(h.ctx)

    expect(h.draft).toEqual([])
    expect(h.labels).toEqual([])
  })
})

describe('WindowTool placement', () => {
  it('takes its width, height and sill from the tool options', () => {
    const h = harness(
      { walls: [wall(0, 0, 10, 0)] },
      { windowWidth: 1.5, windowHeight: 1.2, windowSill: 0.9 },
    )
    new WindowTool().onPointerDown(pointer({ x: 5, y: 0.3 }), h.ctx)

    const [opening] = h.document.plan.openings
    expect(opening.kind).toBe('window')
    expect(opening.width).toBe(1.5)
    expect(opening.height).toBe(1.2)
    // A sill above zero is what keeps people from walking through a window.
    expect(opening.sill).toBe(0.9)
    expect(opening.sill).not.toBe(DEFAULT_WINDOW_SILL)
    expect(opening.swing).toBeUndefined()
  })

  it('stays a window however wide it is', () => {
    const h = harness({ walls: [wall(0, 0, 10, 0)] }, { windowWidth: DOUBLE_DOOR_FROM + 1 })
    new WindowTool().onPointerDown(pointer({ x: 5, y: 0.3 }), h.ctx)

    expect(h.document.plan.openings[0].kind).toBe('window')
  })

  it('refuses off a wall and is one sealed undo step on it', () => {
    const h = harness({ walls: [wall(0, 0, 10, 0)] })
    const tool = new WindowTool()

    tool.onPointerDown(pointer({ x: 5, y: 3 }), h.ctx)
    expect(h.toasts).toHaveLength(1)
    expect(h.undoSteps).toBe(0)

    tool.onPointerDown(pointer({ x: 5, y: 0.3 }), h.ctx)
    expect(h.undoSteps).toBe(1)
    expect(h.sealed).toBe(true)
    expect(h.edits).toEqual([{ label: 'Add window', coalesceKey: undefined }])
  })
})

describe('FurnitureTool placement', () => {
  const horizontal = wall(0, 0, 10, 0)
  const backOff = WALL_THICKNESS / 2 + CHAIR.size.depth / 2

  it('backs the item onto the wall face and turns its front to the room', () => {
    const h = harness({ walls: [horizontal] })
    new FurnitureTool().onPointerDown(pointer({ x: 5, y: 0.4 }), h.ctx)

    const [item] = h.document.plan.furniture
    expect(item.catalogId).toBe(CHAIR.id)
    expect(item.position.x).toBeCloseTo(5, 9)
    expect(item.position.y).toBeCloseTo(backOff, 9)
    // Its back edge lands exactly on the wall face, not on the centreline.
    expect(item.position.y - CHAIR.size.depth / 2).toBeCloseTo(WALL_THICKNESS / 2, 9)
    expect(frontOf(item.rotation).y).toBeCloseTo(1, 9)
  })

  it('flips when the wall is approached from the other side', () => {
    const h = harness({ walls: [horizontal] })
    new FurnitureTool().onPointerDown(pointer({ x: 5, y: -0.4 }), h.ctx)

    const [item] = h.document.plan.furniture
    expect(item.position.y).toBeCloseTo(-backOff, 9)
    expect(frontOf(item.rotation).y).toBeCloseTo(-1, 9)
  })

  it('orients against a vertical wall too', () => {
    // A sign error in the rotation is invisible on a horizontal wall.
    const h = harness({ walls: [wall(0, 0, 0, 10)] })
    new FurnitureTool().onPointerDown(pointer({ x: 0.4, y: 5 }), h.ctx)

    const [item] = h.document.plan.furniture
    expect(item.position.x).toBeCloseTo(backOff, 9)
    expect(item.position.y).toBeCloseTo(5, 9)
    expect(frontOf(item.rotation).x).toBeCloseTo(1, 9)
    expect(frontOf(item.rotation).y).toBeCloseTo(0, 9)
  })

  it('orients against the nearest wall when two are in reach', () => {
    const h = harness({ walls: [horizontal, wall(0, 1.2, 10, 1.2)] })
    // 0.75 m below the far wall, 0.45 m above the near one.
    new FurnitureTool().onPointerDown(pointer({ x: 5, y: 0.75 }), h.ctx)

    const [item] = h.document.plan.furniture
    expect(item.position.y).toBeCloseTo(1.2 - backOff, 9)
    expect(frontOf(item.rotation).y).toBeCloseTo(-1, 9)
  })

  it('falls back to the snapped point beyond a metre of wall', () => {
    // The tool asks for a 1 m reach; the helper's own default is 1.2 m, so a
    // dropped argument would silently keep aligning out here.
    const h = harness({ walls: [horizontal] })
    new FurnitureTool().onPointerDown(pointer({ x: 5.1, y: 1.05 }), h.ctx)

    const [item] = h.document.plan.furniture
    expect(item.position).toEqual({ x: 5, y: 1 })
    expect(item.rotation).toBe(0)
    expect(h.snaps).toHaveLength(1)
    expect(h.snaps[0].options).toEqual({ disabled: false })
  })

  it('drops the item on the cursor when Alt is held, ignoring wall and grid', () => {
    const h = harness({ walls: [horizontal] })
    new FurnitureTool().onPointerDown(pointer({ x: 5.3, y: 0.3 }, { altKey: true }), h.ctx)

    const [item] = h.document.plan.furniture
    expect(item.position).toEqual({ x: 5.3, y: 0.3 })
    expect(item.rotation).toBe(0)
    expect(h.snaps[0].options).toEqual({ disabled: true })
  })

  it('takes its size from the catalog and its rotation from the tool', () => {
    // Bare floor, so there is nothing to align against: the item's shape can
    // only have come from the catalog entry and its angle only from the R key.
    const h = harness()
    const tool = new FurnitureTool()
    tool.onKeyDown(key('r'), h.ctx)
    tool.onKeyDown(key('r'), h.ctx)
    tool.onPointerDown(pointer({ x: 2, y: 3 }), h.ctx)

    const [chair] = h.document.plan.furniture
    expect(chair.position).toEqual({ x: 2, y: 3 })
    expect(chair.rotation).toBeCloseTo(Math.PI / 6, 9)
    // No size is copied on to the item, so a corrected catalog entry reaches
    // every chair already drawn instead of only the next one placed.
    expect(chair.size).toBeUndefined()
    expect(furnitureSize(chair)).toBe(CHAIR.size)
    // The stored angle has to reach the footprint too, or the plan and the shape
    // people walk around disagree about which way the chair is turned.
    expect(spanX(furnitureVisualPolygon(chair))).toBeGreaterThan(CHAIR.size.width)

    const tables = harness({}, { catalogId: ROUND_TABLE.id })
    new FurnitureTool().onPointerDown(pointer({ x: 2, y: 3 }), tables.ctx)
    expect(furnitureSize(tables.document.plan.furniture[0])).toBe(ROUND_TABLE.size)
  })

  it('rotates by 15°, by 90° with Shift and backwards with Alt', () => {
    const h = harness({ walls: [horizontal] })
    const tool = new FurnitureTool()

    expect(tool.onKeyDown(key('r'), h.ctx)).toBe(true)
    expect(tool.onKeyDown(key('R', { shiftKey: true }), h.ctx)).toBe(true)
    expect(tool.onKeyDown(key('r', { altKey: true }), h.ctx)).toBe(true)
    // Every other key belongs to the app: a tool that swallowed them would take
    // Ctrl-Z and the delete key with it for as long as a chair is on the cursor.
    expect(tool.onKeyDown(key('z'), h.ctx)).toBe(false)
    expect(tool.onKeyDown(key('Delete'), h.ctx)).toBe(false)
    tool.onPointerDown(pointer({ x: 5, y: 0.4 }), h.ctx)

    // +15° +90° −15°, on top of a wall alignment that is itself zero here.
    expect(h.document.plan.furniture[0].rotation).toBeCloseTo(Math.PI / 2, 9)

    expect(tool.onKeyDown(key('Escape'), h.ctx)).toBe(true)
    expect(h.toolsRequested).toEqual(['select'])
  })

  it('turns the item under the cursor but not the preview of it', () => {
    // SUSPECTED BUG, asserted as it behaves today: R rotates and does ask for a
    // redraw, but `refresh` draws `this.preview.rotation` — the angle resolved at
    // the last pointer move — so the preview comes back identical. The hint
    // offers R as the way to turn an object; nothing on screen turns until the
    // mouse moves, and the item that lands is at the angle the user gave up on.
    const h = harness()
    const tool = new FurnitureTool()
    const at = pointer({ x: 2, y: 3 })

    tool.onPointerMove(at, h.ctx)
    expect(tool.hint).toContain('R rotates')
    expect(spanX(h.draft[0].points)).toBeCloseTo(CHAIR.size.width, 9)

    tool.onKeyDown(key('R', { shiftKey: true }), h.ctx)
    // A quarter turn would put the chair's 48 cm depth across x, not its 45 cm
    // width, and swing the whisker from one side of it to the other.
    expect(spanX(h.draft[0].points)).toBeCloseTo(CHAIR.size.width, 9)
    expect(h.draft[1].points[1].x).toBeCloseTo(2, 9)

    tool.onPointerDown(at, h.ctx)
    expect(h.document.plan.furniture[0].rotation).toBeCloseTo(Math.PI / 2, 9)
  })

  it('forgets the rotation when the tool is picked up again', () => {
    const h = harness({ walls: [horizontal] })
    const tool = new FurnitureTool()

    tool.onKeyDown(key('r'), h.ctx)
    tool.onActivate()
    tool.onPointerDown(pointer({ x: 5, y: 0.4 }), h.ctx)

    expect(h.document.plan.furniture[0].rotation).toBe(0)
  })

  it('places the item exactly where the preview showed it', () => {
    const h = harness({ walls: [horizontal] })
    const tool = new FurnitureTool()
    const at = pointer({ x: 5, y: 0.4 })

    tool.onPointerMove(at, h.ctx)
    const previewed = centreOf(h.draft[0].points)
    expect(spanX(h.draft[0].points)).toBeCloseTo(CHAIR.size.width, 9)
    expect(spanY(h.draft[0].points)).toBeCloseTo(CHAIR.size.depth, 9)
    expect(h.labels[0].text).toBe('Stacking chair\n45 cm × 48 cm')
    // The label floats a hand's width above the chair rather than through it.
    expect(h.labels[0].y).toBeCloseTo(CHAIR.size.height + 0.3, 9)

    tool.onPointerDown(at, h.ctx)
    const [item] = h.document.plan.furniture
    expect(item.position.x).toBeCloseTo(previewed.x, 9)
    expect(item.position.y).toBeCloseTo(previewed.y, 9)
  })

  it('draws the facing whisker towards the wall, not into the room', () => {
    // SUSPECTED BUG, asserted as it behaves today: the item is oriented with its
    // front (rotation + π/2) to the room, but the preview's whisker is drawn at
    // rotation − π/2, so it sticks out of the back of the chair and through the
    // wall it was just snapped to.
    const h = harness({ walls: [horizontal] })
    const tool = new FurnitureTool()
    tool.onPointerMove(pointer({ x: 5, y: 0.4 }), h.ctx)

    const [from, to] = h.draft[1].points
    expect(to.y - from.y).toBeLessThan(0)
    expect(to.y).toBeLessThan(WALL_THICKNESS / 2)
  })

  it('is one sealed undo step per item and stays armed for the next one', () => {
    const h = harness({ walls: [horizontal] })
    const tool = new FurnitureTool()
    tool.onPointerDown(pointer({ x: 3, y: 0.4 }), h.ctx)
    tool.onPointerDown(pointer({ x: 6, y: 0.4 }), h.ctx)

    expect(h.document.plan.furniture).toHaveLength(2)
    expect(h.undoSteps).toBe(2)
    expect(h.sealed).toBe(true)
    expect(h.edits).toEqual([
      { label: `Place ${CHAIR.name}`, coalesceKey: undefined },
      { label: `Place ${CHAIR.name}`, coalesceKey: undefined },
    ])
    // A row of chairs is one gesture per chair; the tool must not drop out.
    expect(h.toolsRequested).toEqual([])

    h.undo()
    expect(h.document.plan.furniture).toHaveLength(1)
  })

  it('leaves the selection alone on a Shift-click so a row can be laid down', () => {
    const h = harness({ walls: [horizontal] })
    const tool = new FurnitureTool()

    tool.onPointerDown(pointer({ x: 3, y: 0.4 }), h.ctx)
    const first = h.document.plan.furniture[0].id
    expect(h.selection).toEqual([{ kind: 'furniture', id: first }])

    tool.onPointerDown(pointer({ x: 4, y: 0.4 }, { shiftKey: true }), h.ctx)
    expect(h.document.plan.furniture).toHaveLength(2)
    expect(h.selection).toEqual([{ kind: 'furniture', id: first }])
  })

  it('does nothing at all off the ground plane', () => {
    const h = harness({ walls: [horizontal] })
    new FurnitureTool().onPointerDown(pointer(null), h.ctx)

    expect(h.document.plan.furniture).toEqual([])
    expect(h.edits).toEqual([])
    // Unlike an opening, a missed drop is not worth a toast.
    expect(h.toasts).toEqual([])
  })
})

describe('ServiceTool placement', () => {
  const horizontal = wall(0, 0, 10, 0)

  it('backs the counter onto the wall using the depth it then stores', () => {
    const h = harness({ walls: [horizontal] })
    new ServiceTool().onPointerDown(pointer({ x: 5, y: 0.8 }), h.ctx)

    const [point] = h.document.plan.servicePoints
    expect(point.width).toBe(1.8)
    expect(point.depth).toBe(0.7)
    expect(point.servers).toBe(2)
    expect(point.queueSpacing).toBe(0.6)
    expect(point.serviceTime).toEqual({ kind: 'lognormal', mean: 20, sd: 7, min: 2 })
    // The depth used to align it and the depth stored on it have to agree, or
    // the counter floats off the wall or sinks into it.
    expect(point.position.y - point.depth / 2).toBeCloseTo(WALL_THICKNESS / 2, 9)
    expect(point.position.x).toBeCloseTo(5, 9)
  })

  it('sends the queue through the wall it snapped to', () => {
    // SUSPECTED BUG, asserted as it behaves today: `wallAlignedPlacement` turns
    // the object's front (rotation + π/2) into the room, but a service point is
    // served from rotation − π/2 (`serviceFacing`). A counter placed against a
    // wall therefore queues people on the far side of that wall and stands its
    // staff in the room.
    const h = harness({ walls: [horizontal] })
    new ServiceTool().onPointerDown(pointer({ x: 5, y: 0.8 }), h.ctx)

    const [point] = h.document.plan.servicePoints
    const [head, tail] = serviceQueue(point)
    expect(head.y).toBeLessThan(0)
    expect(tail.y).toBeLessThan(head.y)
  })

  it('numbers counters in the order they are placed', () => {
    const h = harness({ walls: [horizontal] })
    const tool = new ServiceTool()
    tool.onPointerDown(pointer({ x: 3, y: 0.8 }), h.ctx)
    tool.onPointerDown(pointer({ x: 7, y: 0.8 }), h.ctx)

    expect(h.document.plan.servicePoints.map((s) => s.name)).toEqual([
      'Service point 1',
      'Service point 2',
    ])
  })

  it('is one sealed undo step and hands back to select', () => {
    const h = harness({ walls: [horizontal] })
    new ServiceTool().onPointerDown(pointer({ x: 5, y: 0.8 }), h.ctx)

    expect(h.undoSteps).toBe(1)
    expect(h.sealed).toBe(true)
    expect(h.edits).toEqual([{ label: 'Add service point', coalesceKey: undefined }])
    expect(h.selection).toEqual([{ kind: 'service', id: h.document.plan.servicePoints[0].id }])
    // One counter is a deliberate act; the tool does not stay armed.
    expect(h.toolsRequested).toEqual(['select'])

    h.undo()
    expect(h.document.plan.servicePoints).toEqual([])
  })

  it('falls back to the snapped point beyond its 1.4 m reach', () => {
    const h = harness({ walls: [horizontal] })
    new ServiceTool().onPointerDown(pointer({ x: 5.1, y: 1.45 }), h.ctx)

    const [point] = h.document.plan.servicePoints
    expect(point.position).toEqual({ x: 5, y: 1.5 })
    expect(point.rotation).toBe(0)
  })

  it('rotates with R and leaves the keys it does not use to the app', () => {
    const h = harness({ walls: [horizontal] })
    const tool = new ServiceTool()

    expect(tool.onKeyDown(key('r'), h.ctx)).toBe(true)
    expect(tool.onKeyDown(key('z'), h.ctx)).toBe(false)
    expect(tool.onKeyDown(key('Escape'), h.ctx)).toBe(true)
    expect(h.toolsRequested).toEqual(['select'])

    tool.onPointerDown(pointer({ x: 5, y: 0.8 }), h.ctx)
    expect(h.document.plan.servicePoints[0].rotation).toBeCloseTo(Math.PI / 12, 9)
  })

  it('leaves the preview stale until the pointer moves again', () => {
    // SUSPECTED BUG, asserted as it behaves today: R turns the counter and the
    // preview keeps the angle it was drawn at, counter and queue whisker alike.
    // The furniture tool has the same fault by a different route — see 'turns
    // the item under the cursor but not the preview of it'; this one does not
    // even ask for the redraw. Both leave the user turning something they
    // cannot see turn.
    const h = harness({ walls: [horizontal] })
    const tool = new ServiceTool()
    tool.onPointerMove(pointer({ x: 5, y: 0.8 }), h.ctx)
    const counterBefore = h.draft[0].points.map((p) => ({ ...p }))
    const whiskerBefore = h.draft[1].points.map((p) => ({ ...p }))

    tool.onKeyDown(key('r'), h.ctx)
    expect(h.draft[0].points).toEqual(counterBefore)
    expect(h.draft[1].points).toEqual(whiskerBefore)
  })

  it('draws the queue whisker where the counter will really put the line', () => {
    // The whisker is the whole promise of the preview: it is the only thing
    // that says which side of the counter people will stand on before there is
    // a counter to look at. The furniture tool draws its equivalent backwards.
    const h = harness({ walls: [horizontal] })
    const tool = new ServiceTool()
    const at = pointer({ x: 5, y: 0.8 })

    tool.onPointerMove(at, h.ctx)
    const previewedCounter = h.draft[0].points
    const [previewHead, previewTail] = h.draft[1].points
    expect(h.labels[0].text).toBe('Service point\nqueue forms this way')
    expect(h.labels[0].x).toBeCloseTo(previewTail.x, 9)
    expect(h.labels[0].z).toBeCloseTo(previewTail.y, 9)

    tool.onPointerDown(at, h.ctx)
    const [point] = h.document.plan.servicePoints
    // The counter is drawn from one pair of numbers and stored from another;
    // they are only the same 1.8 m by 0.7 m for as long as somebody keeps them
    // in step, and the preview is where a user would notice they had drifted.
    expect(spanX(previewedCounter)).toBeCloseTo(point.width, 9)
    expect(spanY(previewedCounter)).toBeCloseTo(point.depth, 9)

    const [head, tail] = serviceQueue(point)
    expect(head.x).toBeCloseTo(previewHead.x, 9)
    expect(head.y).toBeCloseTo(previewHead.y, 9)
    expect(tail.x).toBeCloseTo(previewTail.x, 9)
    expect(tail.y).toBeCloseTo(previewTail.y, 9)
  })

  it('does nothing off the ground plane', () => {
    const h = harness({ walls: [horizontal] })
    new ServiceTool().onPointerDown(pointer(null), h.ctx)

    expect(h.document.plan.servicePoints).toEqual([])
    expect(h.edits).toEqual([])
  })
})

describe('placement against the document it lands in', () => {
  it('places a door and a window at the sizes the document calls its defaults', () => {
    // The editor's options and the document's settings are seeded in two
    // different files; a fresh plan is the one moment they are guaranteed to
    // agree, and what a user gets before touching a single field.
    const h = harness({ walls: [wall(0, 0, 10, 0)] })
    new DoorTool().onPointerDown(pointer({ x: 3, y: 0.3 }), h.ctx)
    new WindowTool().onPointerDown(pointer({ x: 7, y: 0.3 }), h.ctx)

    const { settings } = h.document
    const [door, window] = h.document.plan.openings
    expect(door.width).toBe(settings.defaultDoorWidth)
    expect(door.height).toBe(settings.defaultDoorHeight)
    expect(window.width).toBe(settings.defaultWindowWidth)
    expect(window.height).toBe(settings.defaultWindowHeight)
    expect(window.sill).toBe(settings.defaultWindowSill)
    // And every one of those defaults is a size somebody could order. A round
    // 1.0 m door is three and a half inches off a 3'0", which at a doorway is
    // one person abreast or two, and every egress figure computed from the plan
    // inherits the error.
    expect(isStandard(DOOR_WIDTHS, door.width)).toBe(true)
    expect(isStandard(WINDOW_WIDTHS, window.width)).toBe(true)
    expect(isStandard(WINDOW_SILLS, window.sill)).toBe(true)
  })

  it('keeps placing the app default after the document has asked for another', () => {
    // SUSPECTED BUG, asserted as it behaves today: the default sizes belong to
    // the document — the loader falls back to them for any opening that arrives
    // without a width of its own — but the tools read the editor's toolOptions,
    // and nothing re-seeds those from the document (editorStore.replaceDocument
    // resets the history and leaves toolOptions alone). A venue drawn to 2'8"
    // interior leaves gets 3'0" doors from the second session onwards, and the
    // drawing ends up disagreeing with the default it carries.
    const interior = DOOR_WIDTHS.find((size) => size.imperial === `2'8"`)!
    const storefront = WINDOW_SILLS.find((size) => size.note === 'Storefront')!
    const h = harness(
      { walls: [wall(0, 0, 10, 0)] },
      {},
      { defaultDoorWidth: interior.metres, defaultWindowSill: storefront.metres },
    )

    new DoorTool().onPointerDown(pointer({ x: 3, y: 0.3 }), h.ctx)
    new WindowTool().onPointerDown(pointer({ x: 7, y: 0.3 }), h.ctx)

    const [door, window] = h.document.plan.openings
    expect(door.width).not.toBe(interior.metres)
    expect(door.width).toBe(DEFAULT_DOOR_WIDTH)
    expect(window.sill).not.toBe(storefront.metres)
    expect(window.sill).toBe(DEFAULT_WINDOW_SILL)
  })

  it('measures its preview in the units the document is set to', () => {
    const h = harness({ walls: [wall(0, 0, 10, 0)] }, {}, { units: 'imperial' })
    new DoorTool().onPointerMove(pointer({ x: 5, y: 0.3 }), h.ctx)

    // SUSPECTED BUG, asserted as it behaves today: this should read 3'0", the
    // leaf the whole app defaults to. `formatLength` takes the feet first and
    // rounds the inches only afterwards, so 0.914 m — that leaf, carried to
    // the millimetre and so a hair under 36 inches — prints as twelve inches
    // on top of two feet: the one dimension a user placing a door actually
    // reads, given as a size that does not exist.
    expect(h.labels[0].text).toBe(`2' 12.0"`)

    new FurnitureTool().onPointerMove(pointer({ x: 5, y: 4 }), h.ctx)
    expect(h.labels[0].text).toBe(`Stacking chair\n1' 5.7" × 1' 6.9"`)
  })

  it('names each placement in the undo menu the way the user would describe it', () => {
    const h = harness({ walls: [wall(0, 0, 10, 0)] })

    new FurnitureTool().onPointerDown(pointer({ x: 5, y: 3 }), h.ctx)
    expect(h.undoMenuLabel).toBe(`Place ${CHAIR.name}`)

    new DoorTool().onPointerDown(pointer({ x: 3, y: 0.3 }), h.ctx)
    expect(h.undoMenuLabel).toBe('Add door')

    new WindowTool().onPointerDown(pointer({ x: 7, y: 0.3 }), h.ctx)
    expect(h.undoMenuLabel).toBe('Add window')

    new ServiceTool().onPointerDown(pointer({ x: 5, y: 4 }), h.ctx)
    expect(h.undoMenuLabel).toBe('Add service point')

    // Four placements, four steps: nothing merged two of them into one.
    expect(h.undoSteps).toBe(4)
    h.undo()
    expect(h.document.plan.servicePoints).toEqual([])
    expect(h.undoMenuLabel).toBe('Add window')
  })
})

describe('QueueTool', () => {
  it('shows the queue of the selected counter, and of the first when none is', () => {
    const bar = counter()
    const boxOffice = counter({ name: 'Box office', position: { x: 20, y: 0 } })
    const h = harness({ servicePoints: [bar, boxOffice] })
    const tool = new QueueTool()

    tool.onActivate(h.ctx)
    expect(h.draft[0].points).toEqual(serviceQueue(bar))

    h.ctx.setSelection([{ kind: 'service', id: boxOffice.id }])
    tool.onActivate(h.ctx)
    expect(h.draft[0].points).toEqual(serviceQueue(boxOffice))

    // A chair is not a counter. The tool looks past anything that is not a
    // service point instead of going blank on the user mid-edit.
    h.ctx.setSelection([{ kind: 'furniture', id: 'item_1' }])
    tool.onActivate(h.ctx)
    expect(h.draft[0].points).toEqual(serviceQueue(bar))
  })

  it('draws nothing and edits nothing until there is a counter to queue at', () => {
    const h = harness()
    const tool = new QueueTool()

    tool.onActivate(h.ctx)
    expect(h.draft).toEqual([])
    expect(h.labels).toEqual([])

    tool.onPointerDown(pointer({ x: 0, y: -1.35 }), h.ctx)
    tool.onPointerUp(pointer({ x: 0, y: -1.35 }), h.ctx)
    expect(h.edits).toEqual([])

    expect(tool.onKeyDown(key('Escape'), h.ctx)).toBe(true)
    expect(h.toolsRequested).toEqual(['select'])
  })

  it('collapses a whole drag of one queue point into a single undo step', () => {
    const bar = counter()
    const [, tail] = serviceQueue(bar)
    const h = harness({ servicePoints: [bar] })
    const tool = new QueueTool()

    tool.onPointerDown(pointer({ x: 0, y: -1.35 }), h.ctx)
    tool.onPointerMove(pointer({ x: 1.1, y: -1.4 }), h.ctx)
    tool.onPointerMove(pointer({ x: 1.4, y: -1.6 }), h.ctx)
    tool.onPointerUp(pointer({ x: 1.4, y: -1.6 }), h.ctx)

    // Dragging the head writes the generated line on to the counter for the
    // first time; the untouched end stays exactly where it was generated.
    expect(h.document.plan.servicePoints[0].queue).toEqual([{ x: 1.5, y: -1.5 }, tail])
    // Two applies, one step: they coalesced while the button was down, and the
    // seal on release means the next drag cannot merge into this one.
    expect(h.edits.map((edit) => edit.label)).toEqual(['Reshape queue', 'Reshape queue'])
    expect(h.undoSteps).toBe(1)
    expect(h.sealed).toBe(true)
    // The counter is kept out of its own snap candidates, or the line a user is
    // pulling away from the till jumps back on to it.
    expect(h.snaps[h.snaps.length - 1].options?.exclude?.has(bar.id)).toBe(true)

    h.undo()
    expect(h.document.plan.servicePoints[0].queue).toBeUndefined()
  })

  it('adds a point where the user clicks the middle of the line', () => {
    const bar = counter()
    const [head, tail] = serviceQueue(bar)
    const h = harness({ servicePoints: [bar] })
    new QueueTool().onPointerDown(pointer({ x: 0, y: -4.35 }), h.ctx)

    expect(h.document.plan.servicePoints[0].queue).toEqual([head, { x: 0, y: -4.5 }, tail])
    expect(h.edits).toEqual([{ label: 'Add queue point', coalesceKey: undefined }])
    expect(h.undoSteps).toBe(1)
    expect(h.sealed).toBe(true)
  })

  it('ignores a click on the line that is not near a segment’s middle', () => {
    // SUSPECTED BUG, asserted as it behaves today: the hint promises "Click the
    // line to add a point", but the tool measures the click against each
    // segment's midpoint rather than against the segment. At this zoom that is a
    // 0.18 m disc on a 6 m line, so the click lands on the line the user is
    // aiming at and nothing whatever happens.
    const h = harness({ servicePoints: [counter()] })
    const tool = new QueueTool()
    expect(tool.hint).toContain('Click the line to add a point')

    tool.onPointerDown(pointer({ x: 0, y: -2.5 }), h.ctx)
    expect(h.edits).toEqual([])
    expect(h.document.plan.servicePoints[0].queue).toBeUndefined()

    // Nothing was picked up either, so the drag the user goes on to make is
    // swallowed with the click: the whole gesture leaves the plan untouched.
    tool.onPointerMove(pointer({ x: 1.5, y: -2.5 }), h.ctx)
    tool.onPointerUp(pointer({ x: 1.5, y: -2.5 }), h.ctx)
    expect(h.edits).toEqual([])
    expect(h.document.plan.servicePoints[0].queue).toBeUndefined()
  })

  it('takes two presses of undo to undo one click-and-drag on the line', () => {
    // SUSPECTED BUG, asserted as it behaves today: inserting a point seals
    // immediately, so the drag the same pointer-down goes on to start becomes a
    // second step. A gesture is meant to be one undo step; here one press, move
    // and release costs two, and the state in between is a point sitting where
    // the user happened to click rather than where they dragged it to.
    const h = harness({ servicePoints: [counter()] })
    const tool = new QueueTool()

    tool.onPointerDown(pointer({ x: 0, y: -4.35 }), h.ctx)
    tool.onPointerMove(pointer({ x: 2.1, y: -4.4 }), h.ctx)
    tool.onPointerUp(pointer({ x: 2.1, y: -4.4 }), h.ctx)

    expect(h.undoSteps).toBe(2)
    expect(h.document.plan.servicePoints[0].queue?.[1]).toEqual({ x: 2, y: -4.5 })

    h.undo()
    expect(h.document.plan.servicePoints[0].queue?.[1]).toEqual({ x: 0, y: -4.5 })
    h.undo()
    expect(h.document.plan.servicePoints[0].queue).toBeUndefined()
  })

  it('removes a queue point on Alt-click but never leaves fewer than two', () => {
    const bar = counter({
      queue: [
        { x: 0, y: -1 },
        { x: 0, y: -4 },
        { x: 0, y: -7 },
      ],
    })
    const h = harness({ servicePoints: [bar] })
    const tool = new QueueTool()

    tool.onPointerDown(pointer({ x: 0, y: -4 }, { altKey: true }), h.ctx)
    expect(h.document.plan.servicePoints[0].queue).toEqual([
      { x: 0, y: -1 },
      { x: 0, y: -7 },
    ])
    expect(h.edits).toEqual([{ label: 'Remove queue point', coalesceKey: undefined }])

    // A line needs two ends. Taking one more would leave a queue that cannot be
    // drawn, walked or picked back up.
    tool.onPointerDown(pointer({ x: 0, y: -7 }, { altKey: true }), h.ctx)
    expect(h.document.plan.servicePoints[0].queue).toHaveLength(2)
    expect(h.edits).toHaveLength(1)
  })

  it('says how many people the line holds at that counter’s own spacing', () => {
    const close = harness({ servicePoints: [counter()] })
    new QueueTool().onActivate(close.ctx)
    // Six metres of line at 0.6 m apart: ten gaps, plus the person at the head.
    expect(close.labels[0].text).toBe('Bar\nholds about 11 people')
    expect(close.labels[0].z).toBeCloseTo(-7.35, 9)

    const spaced = harness({ servicePoints: [counter({ queueSpacing: 1.2 })] })
    new QueueTool().onActivate(spaced.ctx)
    expect(spaced.labels[0].text).toBe('Bar\nholds about 6 people')
  })

  it('reshapes the queue without marking the venue as edited', () => {
    // SUSPECTED BUG, asserted as it behaves today: every one of the queue edits
    // builds the new document inline rather than through a function in
    // core/document/mutations, and a plan edit is stamped with the time nowhere
    // else. The projects list sorts on that stamp, so an afternoon spent laying
    // out queues leaves the venue looking untouched at the bottom of the list.
    const h = harness({ servicePoints: [counter()] })
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
      new FurnitureTool().onPointerDown(pointer({ x: 6, y: 6 }), h.ctx)
      expect(h.document.updatedAt).toBe('2030-01-01T00:00:00.000Z')

      vi.setSystemTime(new Date('2030-01-01T00:30:00.000Z'))
      const tool = new QueueTool()
      tool.onPointerDown(pointer({ x: 0, y: -1.35 }), h.ctx)
      tool.onPointerMove(pointer({ x: 1.1, y: -1.4 }), h.ctx)
      tool.onPointerUp(pointer({ x: 1.1, y: -1.4 }), h.ctx)

      expect(h.document.plan.servicePoints[0].queue).toHaveLength(2)
      expect(h.document.updatedAt).toBe('2030-01-01T00:00:00.000Z')
    } finally {
      vi.useRealTimers()
    }
  })
})
