/**
 * The tool contract.
 *
 * A tool is a small state machine over pointer and keyboard events. It never
 * touches the store, the renderer or the DOM directly — everything it needs
 * arrives through the context, which keeps tools independently testable and
 * makes it obvious what a tool is allowed to do.
 */

import type { CrowdDocument, PlanObjectRef } from '../core/model/types'
import type { Vec2 } from '../core/math/vec2'
import type { DraftShape, PointerInfo } from '../render/Viewport'
import type { Label } from '../render/LabelLayer'
import type { SnapOptions, SnapResult } from './snapping'
import type { ToolId, ToolOptions, Toast } from '../state/editorStore'

export interface ToolContext {
  readonly document: CrowdDocument
  readonly options: ToolOptions
  readonly selection: readonly PlanObjectRef[]
  /** Metres per screen pixel at the ground plane. */
  readonly scale: number

  apply(mutate: (doc: CrowdDocument) => CrowdDocument, label: string, coalesceKey?: string): void
  seal(): void

  snap(point: Vec2, options?: Partial<SnapOptions>): SnapResult
  worldToScreen(point: Vec2, height?: number): { x: number; y: number }

  setDraft(shapes: DraftShape[]): void
  setLabels(labels: Label[]): void
  setSelection(refs: PlanObjectRef[]): void
  toggleSelection(ref: PlanObjectRef): void
  setHint(hint: string | null): void
  setTool(tool: ToolId): void
  toast(message: string, tone?: Toast['tone']): void
}

export interface Tool {
  readonly id: ToolId
  /** One-line instruction shown in the status bar while the tool is active. */
  readonly hint: string
  readonly cursor?: string
  /**
   * The left button drives the camera instead of editing. It is how a mouse or
   * trackpad with no spare button looks around without moving the plan.
   */
  readonly leftButtonNavigates?: boolean
  onActivate?(ctx: ToolContext): void
  onDeactivate?(ctx: ToolContext): void
  /**
   * The document changed underneath the tool and its draft needs redrawing.
   *
   * Distinct from `onActivate` because a tool that is mid-gesture is not being
   * started: a tool with no in-progress state can leave this out and let the
   * controller fall back to `onActivate`, but anything holding a chain, a drag
   * origin or a pending click has to redraw without throwing that away.
   */
  onRefresh?(ctx: ToolContext): void
  onPointerDown?(info: PointerInfo, ctx: ToolContext): void
  onPointerMove?(info: PointerInfo, ctx: ToolContext): void
  onPointerUp?(info: PointerInfo, ctx: ToolContext): void
  onDoubleClick?(info: PointerInfo, ctx: ToolContext): void
  onPointerLeave?(ctx: ToolContext): void
  /** Return true when the tool consumed the key. */
  onKeyDown?(event: KeyboardEvent, ctx: ToolContext): boolean
}

/** Screen-space handles a tool exposes for direct manipulation. */
export interface Handle {
  id: string
  position: Vec2
  kind: 'move' | 'rotate' | 'resize' | 'vertex' | 'endpoint'
  cursor?: string
}

export const HANDLE_HIT_PX = 11
