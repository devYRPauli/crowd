/**
 * Transient messages.
 *
 * Warnings and errors stay until dismissed; anything else clears itself, on the
 * principle that a message you have to close is a message that had better be
 * worth closing.
 */

import { useEffect, useRef } from 'react'
import { useEditor } from '../state/editorStore'
import { CloseIcon } from './components/icons'

const CLEARS_AFTER_MS = 4200

export const Toasts = () => {
  const toasts = useEditor((state) => state.toasts)
  const dismiss = useEditor((state) => state.dismissToast)

  /**
   * The countdown belongs to the message, not to the list.
   *
   * Timing the whole array meant every arrival tore down and re-created the
   * timers of the messages already showing, so a run reporting its findings one
   * after another handed an unrelated "Project saved." another 4.2 seconds each
   * time — and it sat under them for as long as they kept coming.
   */
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const running = timers.current
    for (const toast of toasts) {
      if (toast.tone !== 'info' && toast.tone !== 'success') continue
      if (running.has(toast.id)) continue
      running.set(
        toast.id,
        setTimeout(() => {
          running.delete(toast.id)
          dismiss(toast.id)
        }, CLEARS_AFTER_MS),
      )
    }
    // A message the user closed first takes its timer with it.
    for (const [id, timer] of running) {
      if (!toasts.some((toast) => toast.id === id)) {
        clearTimeout(timer)
        running.delete(id)
      }
    }
  }, [toasts, dismiss])

  useEffect(() => {
    const running = timers.current
    return () => {
      for (const timer of running.values()) clearTimeout(timer)
      running.clear()
    }
  }, [])

  if (toasts.length === 0) return null

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.slice(-4).map((toast) => (
        <div key={toast.id} className={`toast is-${toast.tone}`}>
          <span>{toast.message}</span>
          <button
            className="btn is-ghost is-icon"
            onClick={() => dismiss(toast.id)}
            aria-label="Dismiss"
            style={{ height: 20, width: 20 }}
          >
            <CloseIcon width={12} height={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
