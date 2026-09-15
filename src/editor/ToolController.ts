/**
 * Binds tools to the viewport and the store.
 *
 * The controller is the only thing that knows about all three: it builds the
 * `ToolContext` a tool sees, routes pointer and keyboard events to the active
 * tool, and keeps the viewport's hover state in step. Tools stay ignorant of
 * React, and React stays ignorant of pointer plumbing.
 */

import type { Viewport, PointerInfo } from '../render/Viewport'
import type { Tool, ToolContext } from './types'
import type { ToolId } from '../state/editorStore'
import { useEditor } from '../state/editorStore'
import { snapPoint, type SnapOptions } from './snapping'
import { SelectTool } from './tools/selectTool'
import { MeasureTool, RoomTool, WallTool, ZoneTool } from './tools/drawTools'
import { DoorTool, FurnitureTool, QueueTool, ServiceTool, WindowTool } from './tools/placementTools'
import type { Vec2 } from '../core/math/vec2'

const createTools = (): Record<ToolId, Tool> => ({
  select: new SelectTool(),
  wall: new WallTool(),
  room: new RoomTool(),
  door: new DoorTool(),
  window: new WindowTool(),
  furniture: new FurnitureTool(),
  zone: new ZoneTool(),
  service: new ServiceTool(),
  queue: new QueueTool(),
  measure: new MeasureTool(),
})

export class ToolController {
  private tools = createTools()
  private active: Tool
  private viewport: Viewport

  constructor(viewport: Viewport) {
    this.viewport = viewport
    this.active = this.tools.select
    viewport.handlers = {
      onPointerDown: (info) => this.dispatch('onPointerDown', info),
      onPointerMove: (info) => {
        this.updateHover(info)
        this.dispatch('onPointerMove', info)
      },
      onPointerUp: (info) => this.dispatch('onPointerUp', info),
      onDoubleClick: (info) => this.dispatch('onDoubleClick', info),
      onPointerLeave: () => {
        useEditor.getState().setHover(null)
        this.viewport.setHover(null)
        this.active.onPointerLeave?.(this.context())
      },
    }
    this.active.onActivate?.(this.context())
    useEditor.getState().setHint(this.active.hint)
  }

  get activeTool(): Tool {
    return this.active
  }

  setTool(id: ToolId): void {
    if (this.tools[id] === this.active) return
    this.active.onDeactivate?.(this.context())
    this.active = this.tools[id] ?? this.tools.select
    this.active.onActivate?.(this.context())
    useEditor.getState().setHint(this.active.hint)
    this.viewport.canvas.style.cursor = this.active.cursor ?? 'default'
  }

  /**
   * Let tools redraw when the document or selection changed underneath them.
   *
   * This used to call `onActivate`, which for a drawing tool means "start
   * over". Committing a wall segment is itself a document change, so a wall
   * chain wiped its own points the instant it drew its first segment: the tool
   * offered to "click again to continue" and every other click silently began a
   * new wall instead. Tools that hold state across clicks say how to redraw
   * without being restarted; the rest still fall back to `onActivate`, which is
   * only a redraw for them.
   */
  refresh(): void {
    const ctx = this.context()
    if (this.active.onRefresh) this.active.onRefresh(ctx)
    else this.active.onActivate?.(ctx)
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    return this.active.onKeyDown?.(event, this.context()) ?? false
  }

  private dispatch(
    method: 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onDoubleClick',
    info: PointerInfo,
  ): void {
    const handler = this.active[method]
    if (handler) handler.call(this.active, info, this.context())
  }

  private updateHover(info: PointerInfo): void {
    const store = useEditor.getState()
    const next = info.hit?.ref ?? null
    const current = store.hover
    if (next?.id !== current?.id || next?.kind !== current?.kind) {
      store.setHover(next)
      this.viewport.setHover(next)
    }
  }

  private context(): ToolContext {
    const store = useEditor.getState()
    const viewport = this.viewport
    return {
      document: store.document,
      options: store.toolOptions,
      selection: store.selection,
      scale: viewport.worldPerPixel,
      apply: (mutate, label, coalesceKey) => store.apply(mutate, label, coalesceKey),
      seal: () => store.sealHistory(),
      snap: (point: Vec2, options?: Partial<SnapOptions>) =>
        snapPoint(store.document, point, {
          scale: viewport.worldPerPixel,
          ...options,
        }),
      worldToScreen: (point, height = 0) => viewport.worldToScreen(point.x, point.y, height),
      setDraft: (shapes) => viewport.setDraft(shapes),
      setLabels: (labels) => viewport.setLabels(labels),
      setSelection: (refs) => store.setSelection(refs),
      toggleSelection: (ref) => store.toggleSelection(ref),
      setHint: (hint) => store.setHint(hint),
      setTool: (tool) => store.setTool(tool),
      toast: (message, tone) => store.toast(message, tone),
    }
  }
}
