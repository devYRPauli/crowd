/**
 * Undo history.
 *
 * Documents are immutable and structurally shared, so the history is simply a
 * list of past versions. Entries carry a `coalesceKey` so that a continuous
 * gesture — dragging a table across the room, nudging a wall with the arrow
 * keys — collapses into a single undo step instead of hundreds.
 */

export interface HistoryEntry<T> {
  value: T
  label: string
  coalesceKey?: string
  at: number
}

export interface History<T> {
  past: HistoryEntry<T>[]
  present: HistoryEntry<T>
  future: HistoryEntry<T>[]
  limit: number
}

export const createHistory = <T>(value: T, limit = 200): History<T> => ({
  past: [],
  present: { value, label: 'Open', at: 0 },
  future: [],
  limit,
})

/**
 * Record a new version. When `coalesceKey` matches the current entry's key the
 * present is replaced rather than pushed, so the gesture stays one undo step.
 */
export const commit = <T>(
  history: History<T>,
  value: T,
  label: string,
  coalesceKey?: string,
): History<T> => {
  if (value === history.present.value) return history
  const at = history.present.at + 1
  if (coalesceKey && history.present.coalesceKey === coalesceKey) {
    return { ...history, present: { value, label, coalesceKey, at }, future: [] }
  }
  const past = [...history.past, history.present]
  if (past.length > history.limit) past.splice(0, past.length - history.limit)
  return { ...history, past, present: { value, label, coalesceKey, at }, future: [] }
}

/** End the current gesture so the next edit starts a fresh undo step. */
export const seal = <T>(history: History<T>): History<T> =>
  history.present.coalesceKey
    ? { ...history, present: { ...history.present, coalesceKey: undefined } }
    : history

export const canUndo = <T>(history: History<T>): boolean => history.past.length > 0

export const canRedo = <T>(history: History<T>): boolean => history.future.length > 0

export const undo = <T>(history: History<T>): History<T> => {
  if (history.past.length === 0) return history
  const previous = history.past[history.past.length - 1]
  return {
    ...history,
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  }
}

export const redo = <T>(history: History<T>): History<T> => {
  if (history.future.length === 0) return history
  const [next, ...rest] = history.future
  return {
    ...history,
    past: [...history.past, history.present],
    present: next,
    future: rest,
  }
}

/** Label of the step `undo` would reverse, for the menu and tooltips. */
export const undoLabel = <T>(history: History<T>): string | null =>
  history.past.length > 0 ? history.present.label : null

export const redoLabel = <T>(history: History<T>): string | null =>
  history.future.length > 0 ? history.future[0].label : null

export const reset = <T>(history: History<T>, value: T, label = 'Open'): History<T> => ({
  past: [],
  present: { value, label, at: history.present.at + 1 },
  future: [],
  limit: history.limit,
})
