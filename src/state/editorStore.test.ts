/**
 * The editor store is where a venue, the history of how it got that way and
 * what the user has selected have to agree with each other. These tests are
 * mostly about that agreement: an undo hands back the previous document itself
 * rather than a copy of it, a selection never outlives the object it names, and
 * opening a project starts a history rather than extending one.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { useEditor } from './editorStore'
import { createHistory } from '../core/document/history'
import { addWall, renameDocument, updateFurniture } from '../core/document/mutations'
import { createDocument, createPopulation } from '../core/model/defaults'
import { PlanBuilder, step } from '../library/planBuilder'
import {
  DEFAULT_DOOR_WIDTH,
  DEFAULT_DOUBLE_DOOR_WIDTH,
  DEFAULT_WALL_HEIGHT,
  DEFAULT_WALL_THICKNESS,
} from '../core/model/standards'
import type { Backdrop, CrowdDocument, PlanObjectRef, Wall } from '../core/model/types'

/**
 * A 12 x 8 hall with a front door, a table, a locked stage, a fire exit, a bar
 * everyone is routed to, and the surveyor's drawing it was traced over.
 */
const venue = () => {
  const b = new PlanBuilder()
  const room = b.room(0, 0, 12, 8)
  const door = b.door(room.south, 6, DEFAULT_DOOR_WIDTH, 'door', 'entry')
  const table = b.place('table-round-6', 4, 4)
  const stage = b.place('stage', 6, 7, 0, { locked: true })
  const exit = b.zone('exit', 10, 0.2, 11.8, 1.4, 'Fire exit')
  const bar = b.service('Bar', 2, 7, -Math.PI / 2, 2, { kind: 'normal' as const, mean: 40, sd: 8 })
  const tracing: Backdrop = {
    src: 'data:image/png;base64,survey',
    position: { x: 6, y: 4 },
    rotation: 0,
    width: 12,
    depth: 8,
    opacity: 0.4,
    visible: true,
  }

  const base = createDocument('Riverside Hall')
  const document: CrowdDocument = {
    ...base,
    plan: { ...b.build(), backdrop: tracing },
    scenario: {
      ...base.scenario,
      populations: [
        {
          ...createPopulation(0),
          entryIds: [door.id],
          itinerary: [step('service', bar.id), step('exit')],
        },
      ],
    },
  }
  return { document, room, door, table, stage, exit, bar, tracing }
}

const editor = () => useEditor.getState()

const ref = (kind: PlanObjectRef['kind'], id: string): PlanObjectRef => ({ kind, id })

/** A wall a test can draw and then name in an assertion. */
const partition = (): Wall => ({
  id: 'wall_partition',
  a: { x: 3, y: 0 },
  b: { x: 3, y: 5 },
  thickness: DEFAULT_WALL_THICKNESS,
  height: DEFAULT_WALL_HEIGHT,
  kind: 'partition',
})

let hall = venue()

const move = (x: number) => (doc: CrowdDocument) =>
  updateFurniture(doc, hall.table.id, { position: { x, y: 4 } })

const tableIn = (doc: CrowdDocument) => {
  const item = doc.plan.furniture.find((f) => f.id === hall.table.id)
  if (!item) throw new Error('the table is no longer in the plan')
  return item
}

/**
 * The store is a module singleton, so each test is handed one that has just
 * opened this venue and done nothing else to it. The tool, view and panel
 * settings come from the store's own defaults rather than being restated here,
 * so changing a default does not mean changing it in two places.
 */
const defaults = useEditor.getInitialState()

beforeEach(() => {
  hall = venue()
  useEditor.setState({
    history: createHistory(hall.document),
    document: hall.document,
    selection: [],
    hover: null,
    tool: defaults.tool,
    toolOptions: { ...defaults.toolOptions },
    view: { ...defaults.view },
    panel: defaults.panel,
    toasts: [],
    hint: null,
    dirty: false,
  })
})

describe('editing the venue', () => {
  it('hands back the very document an edit replaced, not a copy of it', () => {
    const before = editor().document
    editor().apply((doc) => addWall(doc, partition()), 'Draw wall')
    const after = editor().document

    expect(after.plan.walls.map((w) => w.id)).toContain('wall_partition')
    // What the edit did not touch is still the same object, and undo hands the
    // whole document back by identity. The renderer decides what to rebuild by
    // comparing these arrays, so a structurally equal copy would rebuild every
    // mesh in the venue on every Ctrl+Z.
    expect(after.plan.furniture).toBe(before.plan.furniture)
    expect(editor().undoLabel()).toBe('Draw wall')

    editor().undo()
    expect(editor().document).toBe(before)
    expect(editor().undoLabel()).toBeNull()
    expect(editor().redoLabel()).toBe('Draw wall')

    editor().redo()
    expect(editor().document).toBe(after)
  })

  it('does not spend an undo step on an edit that changed nothing', () => {
    const opened = { document: editor().document, history: editor().history }
    editor().apply((doc) => doc, 'Move')

    // A drag that never left the pixel it started on still runs its mutation.
    // It must not leave a dead step in the history for the user to undo, and
    // must not claim there is unsaved work.
    expect(editor().document).toBe(opened.document)
    expect(editor().history).toBe(opened.history)
    expect(editor().canUndo()).toBe(false)
    expect(editor().dirty).toBe(false)
  })

  it('reports unsaved work from the first edit until the project is saved', () => {
    expect(editor().dirty).toBe(false)

    editor().apply((doc) => renameDocument(doc, 'Riverside Hall — evening'), 'Rename')
    expect(editor().dirty).toBe(true)

    editor().markSaved()
    expect(editor().dirty).toBe(false)

    // Undoing past the saved state is itself an unsaved change.
    editor().undo()
    expect(editor().dirty).toBe(true)

    // Redoing back to the document that was written to disk still reports work
    // to save: the store remembers that the history moved, not which step the
    // file holds. Claiming an unsaved change that is not there costs a
    // redundant save; missing one loses the venue.
    editor().redo()
    expect(editor().document.name).toBe('Riverside Hall — evening')
    expect(editor().dirty).toBe(true)
  })
})

describe('a gesture', () => {
  it('collapses a whole drag into one undo step', () => {
    const before = editor().document
    for (const x of [4.2, 4.6, 5.1, 5.8]) editor().apply(move(x), 'Move', 'move-selection')

    expect(editor().history.past).toHaveLength(1)
    expect(tableIn(editor().document).position.x).toBeCloseTo(5.8, 6)

    // One drag, one Ctrl+Z — and it lands where the table started, not on the
    // last pointer sample before it.
    editor().undo()
    expect(editor().document).toBe(before)
  })

  it('starts a fresh undo step once the gesture is sealed', () => {
    // Tools seal on every pointer-up, including the ones that dragged nothing,
    // so sealing when no gesture is running must cost nothing.
    const opened = editor().history
    editor().sealHistory()
    expect(editor().history).toBe(opened)

    editor().apply(move(4.6), 'Move', 'move-selection')
    editor().apply(move(5.8), 'Move', 'move-selection')
    editor().sealHistory()
    editor().apply(move(7), 'Move', 'move-selection')
    editor().apply(move(8.2), 'Move', 'move-selection')

    expect(editor().history.past).toHaveLength(2)
    editor().undo()
    expect(tableIn(editor().document).position.x).toBeCloseTo(5.8, 6)
  })
})

describe('undo, redo and the selection', () => {
  it('drops an object the undo removed and keeps the rest of the selection', () => {
    editor().apply((doc) => addWall(doc, partition()), 'Draw wall')
    editor().setSelection([ref('wall', 'wall_partition'), ref('furniture', hall.table.id)])

    editor().undo()

    // Placing a door or a counter leaves it selected, and so does pasting
    // (placementTools.ts:272, useKeyboard.ts:44) — so the very next Ctrl+Z is
    // routinely an undo of the thing that is selected. Without this filter it
    // leaves a ref to an object that is no longer there: handles in empty
    // space, and an inspector editing something the document does not have.
    expect(editor().selection).toEqual([ref('furniture', hall.table.id)])
  })

  it('drops a door from the selection when a redo takes its wall away again', () => {
    editor().setSelection([ref('wall', hall.room.south.id)])
    editor().deleteSelection()
    // The crowd came in through that door, so deleting its wall empties the
    // population's list of ways in as well.
    expect(editor().document.scenario.populations[0].entryIds).toEqual([])

    editor().undo()
    expect(editor().document.plan.openings.map((o) => o.id)).toContain(hall.door.id)
    expect(editor().document.scenario.populations[0].entryIds).toEqual([hall.door.id])

    editor().setSelection([ref('opening', hall.door.id), ref('zone', hall.exit.id)])
    editor().redo()

    // The door was never named in the delete — it goes because its wall does.
    // The selection has to follow what is left in the document, not the list of
    // refs the delete was given.
    expect(editor().document.plan.openings).toHaveLength(0)
    expect(editor().selection).toEqual([ref('zone', hall.exit.id)])
  })

  it('does nothing at all at either end of the history', () => {
    const opened = { document: editor().document, history: editor().history }
    editor().setSelection([ref('furniture', hall.table.id)])
    const selection = editor().selection

    editor().undo()

    // A dead Ctrl+Z must not mark the venue as having unsaved changes, and
    // handing `set` fresh objects would re-render the viewport and the
    // inspector for nothing on every keystroke held down at the end of a stack.
    expect(editor().document).toBe(opened.document)
    expect(editor().history).toBe(opened.history)
    expect(editor().selection).toBe(selection)
    expect(editor().dirty).toBe(false)

    editor().apply((doc) => addWall(doc, partition()), 'Draw wall')
    const drawn = { document: editor().document, history: editor().history }
    editor().redo()
    expect(editor().document).toBe(drawn.document)
    expect(editor().history).toBe(drawn.history)
  })
})

describe('deleting the selection', () => {
  it('takes the objects out of the venue, out of the scenario and out of the selection', () => {
    const before = editor().document
    editor().setSelection([ref('furniture', hall.table.id), ref('service', hall.bar.id)])
    editor().deleteSelection()

    const after = editor().document
    expect(after.plan.furniture.map((f) => f.id)).not.toContain(hall.table.id)
    expect(after.plan.servicePoints).toHaveLength(0)
    // Everyone was routed to the bar. With the bar gone that step names nothing,
    // and a scenario pointing at a counter that is not in the plan cannot run.
    expect(after.scenario.populations[0].itinerary.map((s) => s.kind)).toEqual(['exit'])
    expect(editor().selection).toEqual([])
    expect(editor().undoLabel()).toBe('Delete 2 objects')

    editor().undo()
    expect(editor().document).toBe(before)
    // What came back is not re-selected; the next click picks it up again.
    expect(editor().selection).toEqual([])
  })

  it('deletes the traced survey drawing, which has no id of its own', () => {
    editor().setSelection([ref('backdrop', 'backdrop'), ref('wall', hall.room.west.id)])
    editor().deleteSelection()

    // A backdrop is the one object the document holds singly, so the renderer
    // hands out a placeholder id for it. A lookup that insisted the id match
    // would leave the tracing image impossible to select away or delete.
    expect(editor().document.plan.backdrop).toBeUndefined()
    expect(editor().document.plan.walls).toHaveLength(3)
    expect(editor().undoLabel()).toBe('Delete 2 objects')
    // The survivor check runs through that same placeholder-id lookup. It is
    // the half that can fail silently: a lookup that matched on id would report
    // the tracing as still in the plan and leave it selected, with the
    // inspector offering an opacity slider for an image that has gone.
    expect(editor().selection).toEqual([])

    editor().undo()
    expect(editor().document.plan.backdrop).toBe(hall.tracing)
  })

  it('shrugs at a selection with nothing in it left to delete', () => {
    const opened = { document: editor().document, history: editor().history }

    // Delete pressed with nothing selected, and with a selection left over from
    // a plan that has moved on. Neither is an edit, so neither may leave a step
    // in the menu for the user to undo.
    editor().deleteSelection()
    editor().setSelection([ref('wall', 'wall_no_longer_here')])
    editor().deleteSelection()

    expect(editor().document).toBe(opened.document)
    expect(editor().history).toBe(opened.history)
    expect(editor().dirty).toBe(false)
    expect(editor().selection).toEqual([ref('wall', 'wall_no_longer_here')])
  })

  it('refuses a locked object and deletes the rest of the selection around it', () => {
    const opened = { document: editor().document, history: editor().history }
    editor().setSelection([ref('furniture', hall.stage.id)])
    editor().deleteSelection()

    // A lock is protection or it is nothing, and refusing has to cost nothing:
    // no step to undo, and the stage stays selected because the inspector is
    // the only place to unlock it.
    expect(editor().document).toBe(opened.document)
    expect(editor().history).toBe(opened.history)
    expect(editor().selection).toEqual([ref('furniture', hall.stage.id)])

    editor().setSelection([ref('furniture', hall.stage.id), ref('furniture', hall.table.id)])
    editor().deleteSelection()

    // The lock is on the stage alone, so the rest of the selection goes — the
    // same rule the select tool drags a mixed selection by — and the step names
    // the one object that actually went.
    expect(editor().document.plan.furniture.map((f) => f.id)).toEqual([hall.stage.id])
    expect(editor().undoLabel()).toBe('Delete')
  })

  it('leaves the locked object it refused selected, and drops what it took', () => {
    editor().setSelection([ref('furniture', hall.stage.id), ref('furniture', hall.table.id)])
    editor().deleteSelection()

    // The stage is still in the plan, so it is still selected — the same rule
    // as when it was the whole selection. The inspector is the only place to
    // unlock it, and clearing the selection outright left the user hunting for
    // the object the editor had just declined to delete, with nothing on screen
    // saying why it survived.
    expect(editor().document.plan.furniture.map((f) => f.id)).toEqual([hall.stage.id])
    expect(editor().selection).toEqual([ref('furniture', hall.stage.id)])

    editor().setSelection([ref('wall', hall.room.south.id), ref('opening', hall.door.id)])
    editor().deleteSelection()

    // The door was never named in the delete; it went because its wall did. The
    // selection follows the document, so nothing is left pointing at it.
    expect(editor().document.plan.openings).toEqual([])
    expect(editor().selection).toEqual([])
  })
})

describe('opening another venue', () => {
  it('puts the venue that was open further away than one undo', () => {
    editor().apply((doc) => addWall(doc, partition()), 'Draw wall')
    editor().setSelection([ref('furniture', hall.table.id)])
    editor().setHover(ref('wall', hall.room.north.id))
    expect(editor().dirty).toBe(true)

    const convention = createDocument('Convention centre')
    editor().replaceDocument(convention)

    expect(editor().document).toBe(convention)
    expect(editor().canUndo()).toBe(false)
    expect(editor().canRedo()).toBe(false)
    expect(editor().history.present.label).toBe('Open')
    // Both of these named objects in a venue that is no longer loaded.
    expect(editor().selection).toEqual([])
    expect(editor().hover).toBeNull()
    // Nothing has been done to this project yet, so the unsaved work that
    // belonged to the last one does not follow it here.
    expect(editor().dirty).toBe(false)

    editor().undo()
    expect(editor().document).toBe(convention)

    // History still works — it just starts here.
    editor().apply((doc) => renameDocument(doc, 'Convention centre — hall 2'), 'Rename')
    editor().undo()
    expect(editor().document).toBe(convention)
  })
})

describe('the editor around the document', () => {
  it('adds and removes one object from the selection without disturbing the rest', () => {
    const table = ref('furniture', hall.table.id)
    const exit = ref('zone', hall.exit.id)
    editor().setSelection([table])

    editor().toggleSelection(exit)
    expect(editor().selection).toEqual([table, exit])
    editor().toggleSelection(table)
    expect(editor().selection).toEqual([exit])

    // Ids are minted per kind, so a ref is the pair: the same id under another
    // kind is a different object and must not knock the first one out.
    editor().toggleSelection(ref('wall', hall.exit.id))
    expect(editor().selection).toEqual([exit, ref('wall', hall.exit.id)])

    editor().clearSelection()
    expect(editor().selection).toEqual([])
  })

  it('keeps the editor’s own settings out of the document and out of the history', () => {
    editor().setToolOptions({ doorWidth: DEFAULT_DOUBLE_DOOR_WIDTH })
    editor().setView({ showGrid: false })
    editor().setPanel('scenario')

    expect(editor().toolOptions.doorWidth).toBeCloseTo(DEFAULT_DOUBLE_DOOR_WIDTH, 6)
    // A patch changes the keys it names and leaves the others where they were —
    // including when the new value is `false`, which a merge written with `??`
    // would quietly discard.
    expect(editor().toolOptions.wallThickness).toBeCloseTo(DEFAULT_WALL_THICKNESS, 6)
    expect(editor().view.showGrid).toBe(false)
    expect(editor().view.theme).toBe(defaults.view.theme)
    expect(editor().panel).toBe('scenario')

    // None of it is a change to the venue: nothing to undo, and a saved project
    // must not start claiming it has unsaved work because a checkbox moved.
    expect(editor().canUndo()).toBe(false)
    expect(editor().dirty).toBe(false)
    expect(editor().document).toBe(hall.document)
  })

  it('drops the previous tool’s instruction when the tool changes', () => {
    editor().setHint('Click a wall to place the door')
    editor().setTool('door')

    expect(editor().tool).toBe('door')
    // Half-finished instructions from the tool that just went away are worse
    // than no instruction at all.
    expect(editor().hint).toBeNull()
  })

  it('queues toasts in the order they happened and forgets the one dismissed', () => {
    editor().toast('Project saved.', 'success')
    editor().toast('No room for a queue here', 'warn')
    editor().toast('Copied 3 objects.')

    const toasts = editor().toasts
    // The toaster shows the tail of this list, so the order is the order they
    // stack on screen and the newest is the one that cannot be pushed off.
    expect(toasts.map((t) => [t.message, t.tone])).toEqual([
      ['Project saved.', 'success'],
      ['No room for a queue here', 'warn'],
      ['Copied 3 objects.', 'info'],
    ])
    // Ids have to be unique or dismissing one takes another with it.
    expect(new Set(toasts.map((t) => t.id)).size).toBe(3)

    editor().dismissToast(toasts[1].id)
    expect(editor().toasts.map((t) => t.message)).toEqual(['Project saved.', 'Copied 3 objects.'])
  })
})
