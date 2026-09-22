/**
 * The switchboard, driven the way the viewport drives it.
 *
 * Everything here goes through the controller's own seams: events arrive on the
 * `ViewportHandlers` it installed, and the assertions read the store and the
 * viewport it wrote to. The ten real tools are swapped out for recorders after
 * construction — this suite is about routing, and a real tool failing would
 * otherwise look like a routing bug. `active` is set by hand during setup so
 * that `setTool`, which is under test, is not also the thing that arranges the
 * test.
 *
 * The store is a module singleton, so each test starts from a fresh document.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { ToolController } from './ToolController'
import { useEditor } from '../state/editorStore'
import { createDocument } from '../core/model/defaults'
import { renameDocument } from '../core/document/mutations'
import type { ToolId } from '../state/editorStore'
import { ViewTool } from './tools/viewTool'
import type { Tool, ToolContext } from './types'
import type { SnapResult } from './snapping'
import type {
  DraftShape,
  PickHit,
  PointerInfo,
  Viewport,
  ViewportHandlers,
} from '../render/Viewport'
import type { Label } from '../render/LabelLayer'
import type { CrowdDocument, PlanObjectRef } from '../core/model/types'
import type { Vec2 } from '../core/math/vec2'

/** Zoomed to a metre across a hundred pixels, as the default camera roughly is. */
const METRES_PER_PIXEL = 0.01

interface FakeViewport {
  handlers: ViewportHandlers
  canvas: { style: { cursor: string } }
  leftButtonNavigates: boolean
  worldPerPixel: number
  hover: PlanObjectRef | null
  hoverUpdates: number
  draft: DraftShape[]
  labels: Label[]
  projections: Array<{ x: number; z: number; height: number }>
  setHover(ref: PlanObjectRef | null): void
  setDraft(shapes: DraftShape[]): void
  setLabels(labels: Label[]): void
  worldToScreen(x: number, z: number, height?: number): { x: number; y: number }
}

const createViewport = (log: string[]): FakeViewport => {
  const viewport: FakeViewport = {
    handlers: {},
    canvas: { style: { cursor: 'auto' } },
    leftButtonNavigates: false,
    worldPerPixel: METRES_PER_PIXEL,
    hover: null,
    hoverUpdates: 0,
    draft: [],
    labels: [],
    projections: [],
    setHover(ref) {
      viewport.hover = ref
      viewport.hoverUpdates += 1
      log.push(`viewport:hover=${ref ? `${ref.kind}/${ref.id}` : 'none'}`)
    },
    setDraft(shapes) {
      viewport.draft = shapes
      log.push(`viewport:draft=${shapes.length}`)
    },
    setLabels(labels) {
      viewport.labels = labels
    },
    worldToScreen(x, z, height = 0) {
      viewport.projections.push({ x, z, height })
      return { x: x / viewport.worldPerPixel, y: -z / viewport.worldPerPixel }
    },
  }
  return viewport
}

type ToolEvent =
  'activate' | 'deactivate' | 'refresh' | 'down' | 'move' | 'up' | 'doubleClick' | 'leave'

interface FakeCall {
  event: ToolEvent
  ctx: ToolContext
  info?: PointerInfo
}

interface FakeToolOptions {
  cursor?: string
  /** Keys this tool takes for itself; everything else it refuses. */
  claims?: readonly string[]
  /** Give it an `onRefresh`, as tools holding a chain across clicks have. */
  holdsState?: boolean
}

/**
 * A tool that only remembers what it was asked to do.
 *
 * The handlers are prototype methods rather than bound arrows on purpose: they
 * reach their own state through `this`, so a controller that detached one would
 * fail here the way it would fail a real tool.
 */
class FakeTool implements Tool {
  readonly hint: string
  readonly cursor: string | undefined
  readonly calls: FakeCall[] = []
  readonly keys: string[] = []
  /** Stands in for a wall chain: state a gesture builds up and a switch drops. */
  readonly points: Vec2[] = []
  /** Work to run inside the next pointer-down, with the context it was handed. */
  act: ((ctx: ToolContext, info: PointerInfo) => void) | null = null
  /** Work to run as the tool comes up, so a tool can draw from `onActivate`. */
  enter: ((ctx: ToolContext) => void) | null = null
  onRefresh?: (ctx: ToolContext) => void

  constructor(
    readonly id: ToolId,
    private readonly log: string[],
    private readonly options: FakeToolOptions = {},
  ) {
    this.hint = `Draw something with the ${id} tool`
    this.cursor = options.cursor
    if (options.holdsState) {
      this.onRefresh = (ctx: ToolContext): void => this.record('refresh', ctx)
    }
  }

  events(): ToolEvent[] {
    return this.calls.map((call) => call.event)
  }

  onActivate(ctx: ToolContext): void {
    this.record('activate', ctx)
    this.points.length = 0
    this.enter?.(ctx)
  }

  onDeactivate(ctx: ToolContext): void {
    this.record('deactivate', ctx)
    this.points.length = 0
    ctx.setDraft([])
    ctx.setLabels([])
  }

  onPointerDown(info: PointerInfo, ctx: ToolContext): void {
    this.record('down', ctx, info)
    if (info.ground) this.points.push(info.ground)
    ctx.setDraft(this.points.map((point) => ({ kind: 'marker' as const, points: [point] })))
    this.act?.(ctx, info)
  }

  onPointerMove(info: PointerInfo, ctx: ToolContext): void {
    this.record('move', ctx, info)
  }

  onPointerUp(info: PointerInfo, ctx: ToolContext): void {
    this.record('up', ctx, info)
  }

  onDoubleClick(info: PointerInfo, ctx: ToolContext): void {
    this.record('doubleClick', ctx, info)
  }

  onPointerLeave(ctx: ToolContext): void {
    this.record('leave', ctx)
  }

  onKeyDown(event: KeyboardEvent): boolean {
    this.keys.push(event.key)
    return (this.options.claims ?? []).includes(event.key)
  }

  private record(event: ToolEvent, ctx: ToolContext, info?: PointerInfo): void {
    this.calls.push(info ? { event, ctx, info } : { event, ctx })
    this.log.push(`${this.id}:${event}`)
  }
}

const TOOL_IDS: readonly ToolId[] = [
  'select',
  'wall',
  'room',
  'door',
  'window',
  'furniture',
  'zone',
  'service',
  'queue',
  'measure',
  'view',
]

const TOOL_SETUP: Partial<Record<ToolId, FakeToolOptions>> = {
  select: { cursor: 'default' },
  wall: { cursor: 'crosshair', claims: ['Escape', 'Enter'], holdsState: true },
  room: { cursor: 'crosshair' },
  door: { cursor: 'copy' },
  // `measure` is left without a cursor so the fallback has something to catch.
}

const pointer = (over: Partial<PointerInfo> = {}): PointerInfo => ({
  ground: { x: 0, y: 0 },
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

const hitOn = (ref: PlanObjectRef): PickHit => ({ ref, point: { x: 0, y: 0 }, height: 0 })

/** The test environment has no DOM, so a key event is only what the tools read. */
const keyOf = (key: string): KeyboardEvent => ({ key }) as KeyboardEvent

const harness = () => {
  const log: string[] = []
  const viewport = createViewport(log)
  const controller = new ToolController(viewport as unknown as Viewport)
  const tools = Object.fromEntries(
    TOOL_IDS.map((id) => [id, new FakeTool(id, log, TOOL_SETUP[id])]),
  ) as Record<ToolId, FakeTool>

  const internals = controller as unknown as { tools: Record<ToolId, Tool>; active: Tool }
  internals.tools = tools
  internals.active = tools.select

  // Forget whatever the real select tool drew on its way out.
  viewport.draft = []
  viewport.labels = []
  viewport.hover = null
  viewport.hoverUpdates = 0
  viewport.projections.length = 0
  log.length = 0
  useEditor.getState().setHint(null)

  const handlers = viewport.handlers
  return {
    controller,
    tools,
    viewport,
    log,
    /** The log with the viewport's own bookkeeping filtered out. */
    toolLog: () => log.filter((entry) => !entry.startsWith('viewport:')),
    pointerDown: (info: PointerInfo) => handlers.onPointerDown?.(info),
    pointerMove: (info: PointerInfo) => handlers.onPointerMove?.(info),
    pointerUp: (info: PointerInfo) => handlers.onPointerUp?.(info),
    doubleClick: (info: PointerInfo) => handlers.onDoubleClick?.(info),
    pointerLeave: () => handlers.onPointerLeave?.(),
    replaceTool: (id: ToolId, tool: Tool) => {
      internals.tools[id] = tool
    },
  }
}

/** Panel settings outlive a document swap, so they are put back by hand. */
const DEFAULT_TOOL_OPTIONS = { ...useEditor.getState().toolOptions }

beforeEach(() => {
  // `replaceDocument` clears the selection, the hover and the history with it.
  useEditor.getState().replaceDocument(createDocument('controller fixture'))
  useEditor.setState({
    tool: 'select',
    hint: null,
    toasts: [],
    toolOptions: { ...DEFAULT_TOOL_OPTIONS },
  })
})

describe('taking over the viewport', () => {
  it('comes up on the select tool with its instruction in the status bar', () => {
    const log: string[] = []
    const viewport = createViewport(log)
    const controller = new ToolController(viewport as unknown as Viewport)

    expect(controller.activeTool.id).toBe('select')
    expect(useEditor.getState().hint).toBe(controller.activeTool.hint)
    expect(controller.activeTool.hint).toMatch(/\S/)

    // Driven through the real select tool, because five assigned functions
    // prove nothing: the event has to reach a tool and come back out as a
    // redraw. Nothing is selected, so the decoration pass draws no handles.
    const ref: PlanObjectRef = { kind: 'wall', id: 'w-1' }
    log.length = 0
    viewport.handlers.onPointerMove?.(pointer({ hit: hitOn(ref) }))
    expect(useEditor.getState().hover).toBe(ref)
    expect(log).toEqual(['viewport:hover=wall/w-1', 'viewport:draft=0'])

    viewport.handlers.onPointerLeave?.()
    expect(useEditor.getState().hover).toBeNull()
    expect(log.slice(2)).toEqual(['viewport:hover=none', 'viewport:draft=0'])
  })
})

describe('routing a gesture', () => {
  it('walks a gesture through the active tool in the order the pointer made it', () => {
    const h = harness()
    h.controller.setTool('wall')
    const down = pointer({ ground: { x: 1, y: 2 } })
    const drag = pointer({ ground: { x: 1.5, y: 2 } })
    const up = pointer({ ground: { x: 2, y: 2 }, buttons: 0 })

    h.pointerDown(down)
    h.pointerMove(drag)
    h.pointerUp(up)
    h.doubleClick(up)

    const wall = h.tools.wall
    expect(wall.events()).toEqual(['activate', 'down', 'move', 'up', 'doubleClick'])
    expect(wall.calls[1].info).toBe(down)
    expect(wall.calls[2].info).toBe(drag)
    expect(wall.calls[3].info).toBe(up)
    expect(wall.points).toEqual([{ x: 1, y: 2 }])
  })

  it('keeps the highlight following the pointer under a tool that handles nothing', () => {
    const h = harness()
    // Every member of the tool contract bar `id` and `hint` is optional, and a
    // tool that takes none of them must not be able to take the editor down.
    h.replaceTool('measure', { id: 'measure', hint: 'Listens to nothing' })
    h.controller.setTool('measure')
    const ref: PlanObjectRef = { kind: 'zone', id: 'z-1' }

    h.pointerDown(pointer())
    h.pointerMove(pointer({ hit: hitOn(ref) }))
    expect(h.viewport.hover).toBe(ref)
    expect(useEditor.getState().hover).toBe(ref)

    h.pointerUp(pointer())
    h.doubleClick(pointer())
    h.controller.refresh()
    h.pointerLeave()

    expect(h.viewport.hover).toBeNull()
    expect(useEditor.getState().hover).toBeNull()
    expect(h.controller.handleKeyDown(keyOf('Delete'))).toBe(false)

    h.controller.setTool('select')
    expect(h.controller.activeTool).toBe(h.tools.select)
  })

  it('publishes what the pointer is over before the tool sees the move', () => {
    const h = harness()
    const ref: PlanObjectRef = { kind: 'wall', id: 'w-7' }

    h.pointerMove(pointer({ hit: hitOn(ref) }))

    expect(h.log).toEqual(['viewport:hover=wall/w-7', 'select:move'])
    expect(useEditor.getState().hover).toBe(ref)
    expect(h.viewport.hover).toBe(ref)
  })

  it('repaints the highlight only when the thing under the pointer changes', () => {
    const h = harness()
    const wall: PlanObjectRef = { kind: 'wall', id: 'shared' }
    const zone: PlanObjectRef = { kind: 'zone', id: 'shared' }

    h.pointerMove(pointer({ hit: hitOn(wall) }))
    h.pointerMove(pointer({ hit: hitOn(wall) }))
    expect(h.viewport.hoverUpdates).toBe(1)

    // A reference is a kind and an id together: comparing ids alone would leave
    // the outline sitting on the wrong object.
    h.pointerMove(pointer({ hit: hitOn(zone) }))
    expect(h.viewport.hoverUpdates).toBe(2)
    expect(h.viewport.hover).toBe(zone)

    h.pointerMove(pointer())
    h.pointerMove(pointer())
    expect(h.viewport.hoverUpdates).toBe(3)
    expect(h.viewport.hover).toBeNull()

    // Pressing belongs to the tool. A controller that also republished hover
    // from a click would fight a tool that dims or hides what it is editing.
    h.pointerDown(pointer({ hit: hitOn(wall) }))
    h.pointerUp(pointer({ hit: hitOn(wall) }))
    h.doubleClick(pointer({ hit: hitOn(wall) }))
    expect(h.viewport.hoverUpdates).toBe(3)
    expect(h.viewport.hover).toBeNull()
  })

  it('drops the highlight and tells the tool when the pointer leaves the canvas', () => {
    const h = harness()
    h.pointerMove(pointer({ hit: hitOn({ kind: 'furniture', id: 'f-2' }) }))
    h.log.length = 0

    h.pointerLeave()

    expect(useEditor.getState().hover).toBeNull()
    expect(h.viewport.hover).toBeNull()
    expect(h.log).toEqual(['viewport:hover=none', 'select:leave'])
  })
})

describe('switching tools', () => {
  it('drops a half-drawn object when the user reaches for another tool', () => {
    const h = harness()
    h.controller.setTool('wall')
    h.pointerDown(pointer({ ground: { x: 0, y: 0 } }))
    h.pointerDown(pointer({ ground: { x: 4, y: 0 } }))
    expect(h.tools.wall.points).toHaveLength(2)
    expect(h.viewport.draft).toHaveLength(2)

    // A placement tool paints its cursor preview the moment it comes up, and
    // the outgoing tool clears the draft through the very same context — so
    // activating first would wipe the incoming preview instead of the old one.
    const preview: DraftShape = { kind: 'marker', points: [{ x: 4, y: 0 }] }
    h.tools.door.enter = (ctx) => ctx.setDraft([preview])

    h.controller.setTool('door')

    expect(h.tools.wall.points).toEqual([])
    expect(h.viewport.draft).toEqual([preview])
    expect(h.log.slice(-4)).toEqual([
      'wall:deactivate',
      'viewport:draft=0',
      'door:activate',
      'viewport:draft=1',
    ])
    expect(h.controller.activeTool).toBe(h.tools.door)

    h.pointerDown(pointer({ ground: { x: 8, y: 0 } }))
    expect(h.tools.door.points).toEqual([{ x: 8, y: 0 }])
    expect(h.tools.wall.points).toEqual([])
  })

  it('leaves a tool mid-gesture alone when handed the tool already in use', () => {
    const h = harness()
    h.controller.setTool('wall')
    h.pointerDown(pointer({ ground: { x: 3, y: 1 } }))
    const seen = h.tools.wall.calls.length
    expect(useEditor.getState().hint).toBe(h.tools.wall.hint)

    // Clicking the rail button that is already lit, pressing the tool's own
    // shortcut twice and pressing Escape in select mode all send the active
    // tool's id straight back through the store.
    useEditor.getState().setTool('wall')
    h.controller.setTool('wall')

    expect(h.tools.wall.calls).toHaveLength(seen)
    expect(h.tools.wall.points).toEqual([{ x: 3, y: 1 }])
    expect(h.viewport.draft).toHaveLength(1)
    // The instruction in the status bar goes blank and stays blank, and that is
    // recorded rather than repaired here: the store's setTool clears the hint on
    // every call, redundant or not, and nothing puts it back — no tool calls
    // ctx.setHint and the controller is the only other source. The fix is in
    // src/state/editorStore.ts, leaving the hint alone when the id has not
    // changed. Doing it in this file instead would not reach the app at all,
    // because ViewportHost's effect is keyed on a *changed* tool id and this
    // method is never re-entered; the early return below is only why nothing
    // heals it afterwards.
    expect(useEditor.getState().hint).toBeNull()
  })

  it('publishes the incoming tool’s instruction and cursor', () => {
    const h = harness()

    h.controller.setTool('door')
    expect(useEditor.getState().hint).toBe(h.tools.door.hint)
    expect(h.viewport.canvas.style.cursor).toBe('copy')

    // A tool with nothing to say about the cursor gets the plain arrow back
    // rather than inheriting the last tool's crosshair.
    h.controller.setTool('measure')
    expect(h.viewport.canvas.style.cursor).toBe('default')
  })

  it('hands the left button to the camera only while the view tool is active', () => {
    const h = harness()
    h.replaceTool('view', new ViewTool())

    h.controller.setTool('view')
    expect(h.viewport.leftButtonNavigates).toBe(true)
    expect(h.viewport.canvas.style.cursor).toBe('grab')

    // Leaving it must give the button back, or the next tool could never edit.
    h.controller.setTool('select')
    expect(h.viewport.leftButtonNavigates).toBe(false)
  })

  it('falls back to select when handed a tool id it does not have', () => {
    const h = harness()
    h.controller.setTool('wall')

    h.controller.setTool('polygon' as ToolId)

    expect(h.controller.activeTool).toBe(h.tools.select)
    expect(useEditor.getState().hint).toBe(h.tools.select.hint)
    expect(h.viewport.canvas.style.cursor).toBe('default')
    expect(h.toolLog().slice(-2)).toEqual(['wall:deactivate', 'select:activate'])

    // The lookup misses before the already-active check can fire, so a second
    // bad id restarts select rather than being ignored.
    h.controller.setTool('polygon' as ToolId)
    expect(h.toolLog().slice(-2)).toEqual(['select:deactivate', 'select:activate'])
  })
})

describe('redrawing after the document changed', () => {
  it('redraws a tool that is holding a chain instead of starting it over', () => {
    const h = harness()
    h.controller.setTool('wall')
    h.pointerDown(pointer({ ground: { x: 0, y: 0 } }))

    h.controller.refresh()

    // Committing a segment is itself a document change: a refresh that
    // restarted the tool would wipe the chain, and every other click would
    // quietly begin a new wall.
    expect(h.tools.wall.events()).toEqual(['activate', 'down', 'refresh'])
    expect(h.tools.wall.points).toEqual([{ x: 0, y: 0 }])
  })

  it('restarts a tool that has no way to redraw itself', () => {
    const h = harness()
    h.controller.setTool('room')
    h.pointerDown(pointer({ ground: { x: 2, y: 2 } }))

    h.controller.refresh()

    expect(h.tools.room.events()).toEqual(['activate', 'down', 'activate'])
    expect(h.tools.room.points).toEqual([])
  })
})

describe('keys', () => {
  it('gives the app back a key the tool would not take', () => {
    const h = harness()
    h.controller.setTool('wall')

    expect(h.controller.handleKeyDown(keyOf('Escape'))).toBe(true)
    // Undo, delete and the tool shortcuts all live behind this false; a
    // controller that claimed keys on a tool's behalf would swallow Ctrl+Z.
    expect(h.controller.handleKeyDown(keyOf('z'))).toBe(false)

    expect(h.tools.wall.keys).toEqual(['Escape', 'z'])
    expect(h.tools.select.keys).toEqual([])
  })
})

describe('the context a tool is handed', () => {
  it('costs one undo step for a gesture and a fresh one once it is sealed', () => {
    const h = harness()
    h.controller.setTool('furniture')
    h.tools.furniture.act = (ctx, info) =>
      ctx.apply((doc) => renameDocument(doc, `at ${info.ground?.x}`), 'Move table', 'drag-table')
    const start = useEditor.getState().history.past.length

    h.pointerDown(pointer({ ground: { x: 1, y: 0 } }))
    h.pointerDown(pointer({ ground: { x: 2, y: 0 } }))
    h.pointerDown(pointer({ ground: { x: 3, y: 0 } }))

    // The coalesce key has to survive the trip through the context, or a drag
    // across the room becomes a hundred undo steps.
    expect(useEditor.getState().history.past.length - start).toBe(1)
    expect(useEditor.getState().document.name).toBe('at 3')

    h.tools.furniture.act = (ctx) => {
      ctx.seal()
      ctx.apply((doc) => renameDocument(doc, 'after'), 'Rename')
    }
    h.pointerDown(pointer({ ground: { x: 4, y: 0 } }))
    expect(useEditor.getState().history.past.length - start).toBe(2)
  })

  it('hands the tool the document as it stood when the event arrived', () => {
    const h = harness()
    h.controller.setTool('zone')
    const seen: CrowdDocument[] = []
    h.tools.zone.act = (ctx) => {
      seen.push(ctx.document)
      ctx.apply((doc) => renameDocument(doc, `${doc.name}!`), 'Rename')
      seen.push(ctx.document)
    }

    const before = useEditor.getState().document
    h.pointerDown(pointer())
    const after = useEditor.getState().document
    h.pointerDown(pointer())

    expect(after).not.toBe(before)
    expect(seen[0]).toBe(before)
    // The snapshot does not move under the tool mid-event: a tool that needs
    // the result of its own edit must read it inside the next mutate.
    expect(seen[1]).toBe(before)
    // But the context is built fresh per event, so the next one sees the edit.
    expect(seen[2]).toBe(after)
  })

  it('snaps by screen distance at whatever zoom the camera is at now', () => {
    const h = harness()
    h.controller.setTool('wall')
    const results: SnapResult[] = []
    h.tools.wall.act = (ctx, info) => {
      if (info.ground) results.push(ctx.snap(info.ground))
    }
    const loose = pointer({ ground: { x: 1.04, y: 2.02 } })

    h.pointerDown(loose)
    expect(results[0].kind).toBe('grid')
    expect(results[0].point.x).toBeCloseTo(1, 9)
    expect(results[0].point.y).toBeCloseTo(2, 9)

    // Zoomed into a doorway the same 45 mm is ninety pixels away, so the point
    // is left exactly where the user put it — and handed back by identity,
    // which is how a tool tells "not snapped" from "snapped onto itself".
    h.viewport.worldPerPixel = 0.0005
    h.pointerDown(loose)
    expect(results[1].kind).toBe('none')
    expect(results[1].point).toBe(loose.ground)

    // The tool's own options win over the ones the controller fills in, or
    // Alt-to-suspend and the door tool's walls-only search would be ignored.
    h.viewport.worldPerPixel = METRES_PER_PIXEL
    h.tools.wall.act = (ctx, info) => {
      if (!info.ground) return
      results.push(ctx.snap(info.ground, { disabled: true }))
      results.push(ctx.snap(info.ground, { tolerancePx: 1 }))
    }
    h.pointerDown(loose)
    expect(results[2].kind).toBe('none')
    // Same zoom as the grid snap above; only the tolerance the tool asked for
    // is different, which is the proof it reached `snapPoint` at all.
    expect(results[3].kind).toBe('none')
  })

  it('projects a point with the plan position flat and the height above it', () => {
    const h = harness()
    h.controller.setTool('service')
    const screens: Array<{ x: number; y: number }> = []
    let scale = 0
    h.tools.service.act = (ctx) => {
      scale = ctx.scale
      screens.push(ctx.worldToScreen({ x: 3, y: 4 }, 2))
      screens.push(ctx.worldToScreen({ x: 3, y: 4 }))
    }

    h.pointerDown(pointer())

    // The plan's y is depth and the height is elevation; swapping the two puts
    // every handle and dimension label somewhere the object is not.
    expect(h.viewport.projections).toEqual([
      { x: 3, z: 4, height: 2 },
      { x: 3, z: 4, height: 0 },
    ])
    expect(screens[0].x).toBeCloseTo(300, 6)
    expect(screens[0].y).toBeCloseTo(-400, 6)
    expect(scale).toBe(METRES_PER_PIXEL)
  })

  it('sends a tool that wants to hand over through the store rather than itself', () => {
    const h = harness()
    h.controller.setTool('door')
    h.tools.door.act = (ctx) => ctx.setTool('select')

    h.pointerDown(pointer())

    // Placement tools drop back to select once they have placed something.
    // Going through the store is what moves the highlight in the tool rail;
    // React then drives the controller, which is why it has not moved yet.
    expect(useEditor.getState().tool).toBe('select')
    expect(h.controller.activeTool).toBe(h.tools.door)
  })

  it('puts a tool’s selection, hint and warning through the store it was handed', () => {
    const h = harness()
    useEditor.getState().setToolOptions({ doorWidth: 0.9 })
    h.controller.setTool('service')
    const ref: PlanObjectRef = { kind: 'service', id: 'till-1' }
    const widths: number[] = []
    const dimension: Label = { id: 'dim-1', text: '2.40 m', x: 1, y: 0, z: 2 }
    h.tools.service.act = (ctx) => {
      widths.push(ctx.options.doorWidth)
      ctx.setSelection([ref])
      ctx.setHint('Click to place the till')
      ctx.setLabels([dimension])
      ctx.toast('No room for a queue here', 'warn')
      ctx.toast('Counter placed')
    }

    h.pointerDown(pointer())

    const state = useEditor.getState()
    expect(state.selection).toEqual([ref])
    expect(state.hint).toBe('Click to place the till')
    expect(h.viewport.labels).toEqual([dimension])
    // The tone is forwarded as `undefined` rather than filled in here, which is
    // what lets the store's own default stand.
    expect(state.toasts.map((toast) => [toast.message, toast.tone])).toEqual([
      ['No room for a queue here', 'warn'],
      ['Counter placed', 'info'],
    ])
    // Options set in a panel have to reach the tool on the very next event.
    expect(widths).toEqual([0.9])

    h.tools.service.act = (ctx) => ctx.toggleSelection(ref)
    h.pointerDown(pointer())
    expect(useEditor.getState().selection).toEqual([])
  })
})
