/**
 * Transient messages.
 *
 * Warnings and errors stay until dismissed; anything else clears itself, on the
 * principle that a message you have to close is a message that had better be
 * worth closing.
 */

import { useEffect } from 'react'
import { useEditor } from '../state/editorStore'
import { CloseIcon } from './components/icons'

export const Toasts = () => {
  const toasts = useEditor((state) => state.toasts)
  const dismiss = useEditor((state) => state.dismissToast)

  useEffect(() => {
    const timers = toasts
      .filter((toast) => toast.tone === 'info' || toast.tone === 'success')
      .map((toast) => setTimeout(() => dismiss(toast.id), 4200))
    return () => timers.forEach(clearTimeout)
  }, [toasts, dismiss])

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
