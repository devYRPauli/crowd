/**
 * Global keyboard handling.
 *
 * Keys reach the active tool first — a tool mid-gesture owns Escape, Enter and
 * the number keys — and only fall through to the application when the tool has
 * not consumed them. Typing in an input is always left alone.
 */

import { useEffect } from 'react'
import { useEditor, type ToolId } from '../state/editorStore'
import { useSimulation } from '../state/simulationStore'
import { planBounds } from '../core/model/planGeometry'
import { documentFileName, serializeDocument } from '../core/document/serialize'
import { downloadText, saveProject } from '../core/document/storage'
import type { ViewportHandle } from './ViewportHost'
import type { PlanObjectRef } from '../core/model/types'
import {
  clipboardSize,
  copySelection,
  emptyClipboard,
  paste,
  type Clipboard,
} from '../core/document/clipboard'

/**
 * One clipboard for the session. It lives outside React because pasting must
 * work identically whatever is mounted, and because a copy should survive
 * switching projects.
 */
let clipboard: Clipboard = emptyClipboard()
/** Successive pastes step further out, so a stack of copies stays visible. */
let pasteCount = 0

const pasteClipboard = (editor: ReturnType<typeof useEditor.getState>): void => {
  pasteCount++
  const step = editor.document.settings.gridSize * pasteCount
  let created: PlanObjectRef[] = []
  editor.apply((doc) => {
    const result = paste(doc, clipboard, { x: step, y: step })
    created = result.refs
    return result.document
  }, 'Paste')
  editor.sealHistory()
  if (created.length > 0) editor.setSelection(created)
}

const TOOL_KEYS: Record<string, ToolId> = {
  v: 'select',
  w: 'wall',
  r: 'room',
  d: 'door',
  n: 'window',
  f: 'furniture',
  z: 'zone',
  s: 'service',
  q: 'queue',
  m: 'measure',
}

const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export const useKeyboard = ({
  viewportRef,
  onToggleHeatmap,
  onShowShortcuts,
  overlayOpen,
}: {
  viewportRef: React.MutableRefObject<ViewportHandle>
  onToggleHeatmap: () => void
  onShowShortcuts: () => void
  /** True while a dialog is open; it owns the keyboard until it closes. */
  overlayOpen: boolean
}) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return
      // A dialog handles its own keys — in particular Escape, which the editor
      // would otherwise consume before the dialog ever saw it.
      if (overlayOpen) return

      const editor = useEditor.getState()
      const simulation = useSimulation.getState()
      const mod = event.metaKey || event.ctrlKey

      // The active tool gets first refusal.
      if (viewportRef.current.controller?.handleKeyDown(event)) {
        event.preventDefault()
        return
      }

      if (mod) {
        switch (event.key.toLowerCase()) {
          case 'z':
            event.preventDefault()
            if (event.shiftKey) editor.redo()
            else editor.undo()
            return
          case 'y':
            event.preventDefault()
            editor.redo()
            return
          case 'a': {
            event.preventDefault()
            const plan = editor.document.plan
            const all: PlanObjectRef[] = [
              ...plan.walls.map((w) => ({ kind: 'wall' as const, id: w.id })),
              ...plan.furniture.map((f) => ({ kind: 'furniture' as const, id: f.id })),
              ...plan.zones.map((z) => ({ kind: 'zone' as const, id: z.id })),
              ...plan.servicePoints.map((s) => ({ kind: 'service' as const, id: s.id })),
            ]
            editor.setSelection(all)
            return
          }
          case 's':
            event.preventDefault()
            downloadText(documentFileName(editor.document), serializeDocument(editor.document))
            void saveProject(editor.document)
              .then(editor.markSaved)
              .catch(() => undefined)
            editor.toast('Project saved.', 'success')
            return
          case 'c': {
            if (editor.selection.length === 0) return
            event.preventDefault()
            clipboard = copySelection(editor.document, editor.selection)
            pasteCount = 0
            editor.toast(
              `Copied ${clipboardSize(clipboard)} ${clipboardSize(clipboard) === 1 ? 'object' : 'objects'}.`,
              'info',
            )
            return
          }
          case 'x': {
            if (editor.selection.length === 0) return
            event.preventDefault()
            clipboard = copySelection(editor.document, editor.selection)
            pasteCount = 0
            editor.deleteSelection()
            return
          }
          case 'v': {
            if (clipboardSize(clipboard) === 0) return
            event.preventDefault()
            pasteClipboard(editor)
            return
          }
          case 'd': {
            if (editor.selection.length === 0) return
            event.preventDefault()
            // Duplicate is copy and paste in one gesture, and leaves the
            // clipboard alone so a real copy is not clobbered by it.
            const snapshot = copySelection(editor.document, editor.selection)
            const step = editor.document.settings.gridSize
            let created: PlanObjectRef[] = []
            editor.apply((doc) => {
              const result = paste(doc, snapshot, { x: step, y: step })
              created = result.refs
              return result.document
            }, 'Duplicate')
            editor.sealHistory()
            if (created.length > 0) editor.setSelection(created)
            return
          }
          default:
            return
        }
      }

      switch (event.key) {
        case 'Delete':
        case 'Backspace':
          event.preventDefault()
          editor.deleteSelection()
          return
        case 'Escape':
          editor.clearSelection()
          editor.setTool('select')
          return
        case 'Tab':
          event.preventDefault()
          editor.setView({ preset: editor.view.preset === 'plan' ? 'iso' : 'plan' })
          return
        case '.':
          event.preventDefault()
          viewportRef.current.viewport?.frame(planBounds(editor.document.plan, 3))
          return
        case '?':
          event.preventDefault()
          onShowShortcuts()
          return
        case ' ':
          event.preventDefault()
          if (event.shiftKey) {
            simulation.stop()
          } else if (simulation.phase === 'running') {
            simulation.pause()
          } else if (simulation.phase === 'paused') {
            simulation.resume()
          } else {
            simulation.run(editor.document, editor.document.name)
          }
          return
        default:
          break
      }

      const tool = TOOL_KEYS[event.key.toLowerCase()]
      if (tool && !event.shiftKey && !event.altKey) {
        event.preventDefault()
        editor.setTool(tool)
        return
      }

      if (event.key.toLowerCase() === 'h') {
        event.preventDefault()
        onToggleHeatmap()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [viewportRef, onToggleHeatmap, onShowShortcuts, overlayOpen])
}
