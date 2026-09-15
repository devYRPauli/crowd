/**
 * Placement tools, driven through a fake ToolContext.
 *
 * The fake records edits against the real undo history rather than a store, so
 * "one undo step" here means what it means to the user — a single Ctrl-Z takes
 * the placement back — and not merely "apply was called once".
 */

import { describe, expect, it } from 'vitest'
import { DoorTool, FurnitureTool, ServiceTool, WindowTool } from './placementTools'
import {
  commit,
  createHistory,
  seal as sealHistory,
  undo as undoHistory,
} from '../../core/document/history'
import { createDocument } from '../../core/model/defaults'
import { resolveCatalogItem } from '../../library/catalog'
import { serviceQueue, wallLength } from '../../core/model/planGeometry'
import { formatLength } from '../../core/model/units'
import {
  DEFAULT_DOOR_HEIGHT,
  DEFAULT_DOOR_WIDTH,
  DEFAULT_WALL_HEIGHT,
  DEFAULT_WALL_THICKNESS,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_SILL,
  DEFAULT_WINDOW_WIDTH,
  DOUBLE_DOOR_FROM,
  OPENING_JAMB,
} from '../../core/model/standards'
import { fromAngle } from '../../core/math/vec2'
import type { History } from '../../core/document/history'
import type { Vec2 } from '../../core/math/vec2'
import type { CrowdDocument, Plan, PlanObjectRef, Wall } from '../../core/model/types'
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

const harness = (plan: Partial<Plan> = {}, options: Partial<ToolOptions> = {}): Harness => {
  const base = createDocument()
  let history: History<CrowdDocument> = createHistory({
    ...base,
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
  })

  it('cuts into the nearest wall when two are in reach', () => {
    const near = wall(0, 0, 10, 0)
    const far = wall(0, 2, 10, 2)
    const h = harness({ walls: [near, far] })
    // 1.1 m from `near`, 0.9 m from `far` — both within reach.
    new DoorTool().onPointerDown(pointer({ x: 5, y: 1.1 }), h.ctx)

    expect(h.document.plan.openings[0].wallId).toBe(far.id)
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
    expect(h.labels[0].text).toBe(formatLength(1.2, 'metric'))

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

  it('rotates by 15°, by 90° with Shift and backwards with Alt', () => {
    const h = harness({ walls: [horizontal] })
    const tool = new FurnitureTool()

    expect(tool.onKeyDown(key('r'), h.ctx)).toBe(true)
    expect(tool.onKeyDown(key('R', { shiftKey: true }), h.ctx)).toBe(true)
    expect(tool.onKeyDown(key('r', { altKey: true }), h.ctx)).toBe(true)
    tool.onPointerDown(pointer({ x: 5, y: 0.4 }), h.ctx)

    // +15° +90° −15°, on top of a wall alignment that is itself zero here.
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
    expect(h.labels[0].text).toContain(CHAIR.name)
    expect(h.labels[0].text).toContain(formatLength(CHAIR.size.width, 'metric'))
    expect(h.labels[0].text).toContain(formatLength(CHAIR.size.depth, 'metric'))
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

  it('rotates with R on top of the wall alignment', () => {
    const h = harness({ walls: [horizontal] })
    const tool = new ServiceTool()

    expect(tool.onKeyDown(key('r'), h.ctx)).toBe(true)
    tool.onPointerDown(pointer({ x: 5, y: 0.8 }), h.ctx)

    expect(h.document.plan.servicePoints[0].rotation).toBeCloseTo(Math.PI / 12, 9)
  })

  it('leaves the preview stale until the pointer moves again', () => {
    // Current behaviour, unlike the furniture tool: R changes the rotation but
    // does not redraw, so the counter on screen is a frame behind the keypress.
    const h = harness({ walls: [horizontal] })
    const tool = new ServiceTool()
    tool.onPointerMove(pointer({ x: 5, y: 0.8 }), h.ctx)
    const before = h.draft[0].points.map((p) => ({ ...p }))

    tool.onKeyDown(key('r'), h.ctx)
    expect(h.draft[0].points).toEqual(before)
  })

  it('does nothing off the ground plane', () => {
    const h = harness({ walls: [horizontal] })
    new ServiceTool().onPointerDown(pointer(null), h.ctx)

    expect(h.document.plan.servicePoints).toEqual([])
    expect(h.edits).toEqual([])
  })
})
