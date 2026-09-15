import { describe, expect, it } from 'vitest'
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
} from './history'

/**
 * Documents stand in as strings here: history only ever compares values by
 * identity, exactly as it does with the real immutable documents.
 */
const opened = () => createHistory('open')

describe('undo history', () => {
  it('walks back and forward through the edits in order', () => {
    let history = opened()
    history = commit(history, 'a', 'Draw wall')
    history = commit(history, 'b', 'Move')
    history = commit(history, 'c', 'Delete')

    history = undo(history)
    expect(history.present.value).toBe('b')
    history = undo(history)
    expect(history.present.value).toBe('a')
    history = undo(history)
    expect(history.present.value).toBe('open')
    expect(canUndo(history)).toBe(false)

    history = redo(history)
    history = redo(history)
    expect(history.present.value).toBe('b')
    history = redo(history)
    expect(history.present.value).toBe('c')
    expect(canRedo(history)).toBe(false)
  })

  it('throws the redo stack away as soon as you edit again', () => {
    let history = opened()
    history = commit(history, 'a', 'Draw wall')
    history = commit(history, 'b', 'Move')
    history = undo(history)
    expect(canRedo(history)).toBe(true)

    history = commit(history, 'c', 'Place door')
    expect(canRedo(history)).toBe(false)
    expect(redo(history).present.value).toBe('c')
    // The abandoned branch must not be reachable by undoing either.
    expect(undo(history).present.value).toBe('a')
  })

  it('collapses one drag into a single undo step', () => {
    let history = opened()
    history = commit(history, 'anchor', 'Draw wall')
    const before = history.past.length

    for (const position of ['x1', 'x2', 'x3', 'x4']) {
      history = commit(history, position, 'Move', 'move-selection')
    }

    // A drag emits an edit per pointer move; each one must not cost a step.
    expect(history.past.length).toBe(before + 1)
    expect(undo(history).present.value).toBe('anchor')
  })

  it('starts a fresh step once the gesture is sealed', () => {
    let history = opened()
    history = commit(history, 'drag-1-start', 'Move', 'move-selection')
    history = commit(history, 'drag-1-end', 'Move', 'move-selection')
    history = seal(history)
    history = commit(history, 'drag-2-start', 'Move', 'move-selection')
    history = commit(history, 'drag-2-end', 'Move', 'move-selection')

    history = undo(history)
    expect(history.present.value).toBe('drag-1-end')
    history = undo(history)
    expect(history.present.value).toBe('open')
  })

  it('coalesces only consecutive edits that agree on the key', () => {
    let history = opened()
    history = commit(history, 'a', 'Move', 'move-selection')
    history = commit(history, 'b', 'Rotate', 'rotate-selection')
    history = commit(history, 'c', 'Move', 'move-selection')
    expect(history.past).toHaveLength(3)

    // No key at all means no coalescing, however fast the edits arrive.
    let keyless = opened()
    keyless = commit(keyless, 'a', 'Nudge')
    keyless = commit(keyless, 'b', 'Nudge')
    expect(keyless.past).toHaveLength(2)
  })

  it('does not merge a new gesture into the step an undo just restored', () => {
    // This was a real bug, and a quiet one. Coalesce keys are fixed strings in
    // the tools ('nudge', 'move-selection'), and undo used to restore an entry
    // with its key still on it — so the first nudge after an undo merged into
    // the step the user had just come back to, and that state became
    // unreachable. A step you have moved to is a finished step.
    let history = opened()
    history = commit(history, 'nudged', 'Nudge', 'nudge')
    history = commit(history, 'moved', 'Move', 'move-selection')
    history = undo(history)
    expect(history.present.value).toBe('nudged')

    history = commit(history, 'nudged-again', 'Nudge', 'nudge')
    expect(history.past).toHaveLength(2)
    expect(undo(history).present.value).toBe('nudged')
  })

  it('does not merge a new gesture into the step a redo just restored', () => {
    let history = opened()
    history = commit(history, 'nudged', 'Nudge', 'nudge')
    history = undo(history)
    history = redo(history)
    expect(history.present.value).toBe('nudged')

    history = commit(history, 'nudged-again', 'Nudge', 'nudge')
    expect(undo(history).present.value).toBe('nudged')
  })

  it('keeps only the last `limit` steps', () => {
    let history = createHistory('v0', 3)
    for (const value of ['v1', 'v2', 'v3', 'v4', 'v5']) {
      history = commit(history, value, 'Edit')
    }
    expect(history.past).toHaveLength(3)
    expect(history.present.value).toBe('v5')

    history = undo(history)
    history = undo(history)
    history = undo(history)
    expect(history.present.value).toBe('v2')
    expect(canUndo(history)).toBe(false)
  })

  it('is a no-op at either end, and says so by identity', () => {
    const history = commit(opened(), 'a', 'Draw wall')
    // The store feeds these straight into `set`; a fresh object every time
    // would re-render the editor on every dead keystroke.
    expect(redo(history)).toBe(history)
    const atStart = undo(history)
    expect(undo(atStart)).toBe(atStart)
    expect(seal(history)).toBe(history)
  })

  it('does not record an edit that changed nothing', () => {
    const history = commit(opened(), 'a', 'Draw wall')
    expect(commit(history, 'a', 'Draw wall')).toBe(history)
  })

  it('names the step each button would reverse', () => {
    let history = opened()
    expect(undoLabel(history)).toBeNull()
    expect(redoLabel(history)).toBeNull()

    history = commit(history, 'a', 'Draw wall')
    history = commit(history, 'b', 'Place door')
    expect(undoLabel(history)).toBe('Place door')
    expect(redoLabel(history)).toBeNull()

    history = undo(history)
    expect(undoLabel(history)).toBe('Draw wall')
    expect(redoLabel(history)).toBe('Place door')

    history = undo(history)
    expect(undoLabel(history)).toBeNull()
  })

  it('reset drops both stacks but keeps the depth limit', () => {
    let history = createHistory('v0', 5)
    history = commit(history, 'a', 'Draw wall')
    history = undo(history)

    const fresh = reset(history, 'loaded')
    expect(fresh.present.value).toBe('loaded')
    expect(fresh.present.label).toBe('Open')
    expect(canUndo(fresh)).toBe(false)
    expect(canRedo(fresh)).toBe(false)
    expect(fresh.limit).toBe(5)
    // Opening a file must not leave the previous document one undo away.
    expect(undo(fresh).present.value).toBe('loaded')
  })
})
