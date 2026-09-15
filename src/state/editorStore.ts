/**
 * Editor state.
 *
 * One store holds the document, its undo history, the selection and everything
 * about how the plan is being viewed. Document edits all funnel through
 * `apply`, which is the only place history is written — so an edit can never
 * silently escape undo, and a gesture can coalesce into one step by passing the
 * same `coalesceKey`.
 */

import { create } from 'zustand'
import type { CrowdDocument, PlanObjectRef } from '../core/model/types'
import type { History } from '../core/document/history'
import {
  canRedo,
  canUndo,
  commit,
  createHistory,
  redo,
  redoLabel,
  reset,
  seal,
  undo,
  undoLabel,
} from '../core/document/history'
import { createDocument } from '../core/model/defaults'
import {
  DEFAULT_DOOR_HEIGHT,
  DEFAULT_DOOR_WIDTH,
  DEFAULT_WALL_HEIGHT,
  DEFAULT_WALL_THICKNESS,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_SILL,
  DEFAULT_WINDOW_WIDTH,
} from '../core/model/standards'
import { removeObjects } from '../core/document/mutations'
import type { ThemeName } from '../render/theme'
import type { ViewPreset } from '../render/CameraRig'

export type ToolId =
  | 'select'
  | 'wall'
  | 'room'
  | 'door'
  | 'window'
  | 'furniture'
  | 'zone'
  | 'service'
  | 'queue'
  | 'measure'

export type ZoneToolKind =
  'entry' | 'exit' | 'waypoint' | 'obstacle' | 'keep-clear' | 'seating' | 'measure'

export interface ToolOptions {
  /** Catalog id the furniture tool places. */
  catalogId: string
  zoneKind: ZoneToolKind
  wallKind: 'wall' | 'partition' | 'glass' | 'barrier' | 'rail'
  wallThickness: number
  wallHeight: number
  doorWidth: number
  doorHeight: number
  windowWidth: number
  windowHeight: number
  windowSill: number
}

export interface ViewOptions {
  theme: ThemeName
  preset: ViewPreset
  showGrid: boolean
  showZones: boolean
  showSeats: boolean
  showQueues: boolean
  showFurniture: boolean
  showRoomLabels: boolean
  showDimensions: boolean
  /** Cut walls down to this height so a plan view stays readable; null keeps full height. */
  wallCutHeight: number | null
}

export type PanelId = 'library' | 'scenario' | 'results' | 'layers' | 'settings'

export interface Toast {
  id: number
  message: string
  tone: 'info' | 'warn' | 'error' | 'success'
}

interface EditorState {
  history: History<CrowdDocument>
  document: CrowdDocument
  selection: PlanObjectRef[]
  hover: PlanObjectRef | null
  tool: ToolId
  toolOptions: ToolOptions
  view: ViewOptions
  panel: PanelId
  toasts: Toast[]
  /** Transient hint shown in the status bar by the active tool. */
  hint: string | null
  dirty: boolean

  apply: (
    mutate: (doc: CrowdDocument) => CrowdDocument,
    label: string,
    coalesceKey?: string,
  ) => void
  sealHistory: () => void
  replaceDocument: (doc: CrowdDocument, label?: string) => void
  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean
  undoLabel: () => string | null
  redoLabel: () => string | null

  setSelection: (refs: PlanObjectRef[]) => void
  toggleSelection: (ref: PlanObjectRef) => void
  clearSelection: () => void
  deleteSelection: () => void
  setHover: (ref: PlanObjectRef | null) => void

  setTool: (tool: ToolId) => void
  setToolOptions: (patch: Partial<ToolOptions>) => void
  setView: (patch: Partial<ViewOptions>) => void
  setPanel: (panel: PanelId) => void
  setHint: (hint: string | null) => void
  markSaved: () => void

  toast: (message: string, tone?: Toast['tone']) => void
  dismissToast: (id: number) => void
}

const initialDocument = createDocument()

let toastId = 0

export const useEditor = create<EditorState>()((set, get) => ({
  history: createHistory(initialDocument),
  document: initialDocument,
  selection: [],
  hover: null,
  tool: 'select',
  toolOptions: {
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
  },
  view: {
    theme: 'light',
    preset: 'iso',
    showGrid: true,
    showZones: true,
    showSeats: false,
    showQueues: true,
    showFurniture: true,
    showRoomLabels: true,
    showDimensions: true,
    wallCutHeight: null,
  },
  panel: 'library',
  toasts: [],
  hint: null,
  dirty: false,

  apply: (mutate, label, coalesceKey) => {
    const state = get()
    const next = mutate(state.document)
    if (next === state.document) return
    const history = commit(state.history, next, label, coalesceKey)
    set({ history, document: history.present.value, dirty: true })
  },

  sealHistory: () => set((state) => ({ history: seal(state.history) })),

  replaceDocument: (doc, label = 'Open') =>
    set((state) => {
      const history = reset(state.history, doc, label)
      return { history, document: doc, selection: [], hover: null, dirty: false }
    }),

  undo: () =>
    set((state) => {
      if (!canUndo(state.history)) return state
      const history = undo(state.history)
      const doc = history.present.value
      return {
        history,
        document: doc,
        dirty: true,
        selection: state.selection.filter((ref) => referenceExists(doc, ref)),
      }
    }),

  redo: () =>
    set((state) => {
      if (!canRedo(state.history)) return state
      const history = redo(state.history)
      const doc = history.present.value
      return {
        history,
        document: doc,
        dirty: true,
        selection: state.selection.filter((ref) => referenceExists(doc, ref)),
      }
    }),

  canUndo: () => canUndo(get().history),
  canRedo: () => canRedo(get().history),
  undoLabel: () => undoLabel(get().history),
  redoLabel: () => redoLabel(get().history),

  setSelection: (refs) => set({ selection: refs }),

  toggleSelection: (ref) =>
    set((state) => {
      const exists = state.selection.some((r) => r.id === ref.id && r.kind === ref.kind)
      return {
        selection: exists
          ? state.selection.filter((r) => !(r.id === ref.id && r.kind === ref.kind))
          : [...state.selection, ref],
      }
    }),

  clearSelection: () => set({ selection: [] }),

  deleteSelection: () => {
    const { selection, document, apply } = get()
    const removable = selection.filter((ref) => {
      const object = findRef(document, ref)
      return object && !(object as { locked?: boolean }).locked
    })
    if (removable.length === 0) return
    apply(
      (doc) => removeObjects(doc, removable),
      removable.length === 1 ? 'Delete' : `Delete ${removable.length} objects`,
    )
    set({ selection: [] })
  },

  setHover: (ref) => set({ hover: ref }),

  setTool: (tool) => set({ tool, hint: null }),
  setToolOptions: (patch) => set((state) => ({ toolOptions: { ...state.toolOptions, ...patch } })),
  setView: (patch) => set((state) => ({ view: { ...state.view, ...patch } })),
  setPanel: (panel) => set({ panel }),
  setHint: (hint) => set({ hint }),
  markSaved: () => set({ dirty: false }),

  toast: (message, tone = 'info') =>
    set((state) => ({ toasts: [...state.toasts, { id: ++toastId, message, tone }] })),

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}))

const findRef = (doc: CrowdDocument, ref: PlanObjectRef): unknown => {
  switch (ref.kind) {
    case 'wall':
      return doc.plan.walls.find((w) => w.id === ref.id)
    case 'opening':
      return doc.plan.openings.find((o) => o.id === ref.id)
    case 'furniture':
      return doc.plan.furniture.find((f) => f.id === ref.id)
    case 'zone':
      return doc.plan.zones.find((z) => z.id === ref.id)
    case 'service':
      return doc.plan.servicePoints.find((s) => s.id === ref.id)
    case 'backdrop':
      return doc.plan.backdrop
  }
}

const referenceExists = (doc: CrowdDocument, ref: PlanObjectRef): boolean =>
  findRef(doc, ref) !== undefined

export const selectDocument = (state: EditorState) => state.document
export const selectSelection = (state: EditorState) => state.selection
