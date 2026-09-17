/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { InspectorPanel } from './InspectorPanel'
import { useEditor } from '../../state/editorStore'
import { createDocument } from '../../core/model/defaults'
import { wallLength } from '../../core/model/planGeometry'
import {
  DEFAULT_DOOR_HEIGHT,
  DEFAULT_DOOR_WIDTH,
  DEFAULT_WALL_HEIGHT,
  DEFAULT_WALL_THICKNESS,
  OPENING_JAMB,
} from '../../core/model/standards'
import type {
  CrowdDocument,
  DocumentSettings,
  Opening,
  Plan,
  PlanObjectRef,
  ServicePoint,
  Wall,
  Zone,
} from '../../core/model/types'

const makeWall = (patch: Partial<Wall> = {}): Wall => ({
  id: 'wall-1',
  a: { x: 0, y: 0 },
  b: { x: 3, y: 0 },
  thickness: DEFAULT_WALL_THICKNESS,
  height: DEFAULT_WALL_HEIGHT,
  kind: 'wall',
  ...patch,
})

/** A 3'0" leaf hung in the middle of a 3 m wall — the editor's own default. */
const makeDoor = (patch: Partial<Opening> = {}): Opening => ({
  id: 'door-1',
  wallId: 'wall-1',
  offset: 1.5,
  width: DEFAULT_DOOR_WIDTH,
  height: DEFAULT_DOOR_HEIGHT,
  sill: 0,
  kind: 'door',
  ...patch,
})

const openWith = (plan: Partial<Plan>, settings: Partial<DocumentSettings> = {}): CrowdDocument => {
  const base = createDocument('Test venue')
  const doc: CrowdDocument = {
    ...base,
    settings: { ...base.settings, ...settings },
    plan: { ...base.plan, ...plan },
  }
  useEditor.getState().replaceDocument(doc)
  return doc
}

const select = (...refs: PlanObjectRef[]) => useEditor.setState({ selection: refs })

const doc = () => useEditor.getState().document
const firstOpening = () => doc().plan.openings[0]
const firstWall = () => doc().plan.walls[0]

/** The control inside the field carrying this label. Labels are wired by layout, not `for`. */
const control = (label: RegExp): HTMLInputElement | HTMLSelectElement => {
  const field = screen.getByText(label).closest('.field')
  if (!field) throw new Error(`No field is labelled ${label}`)
  const element = field.querySelector('input, select')
  if (!element) throw new Error(`The field labelled ${label} has no control`)
  return element as HTMLInputElement | HTMLSelectElement
}

/** Type into a numeric field and leave it, which is the only thing that commits. */
const typeAndLeave = (label: RegExp, text: string) => {
  const input = control(label)
  fireEvent.change(input, { target: { value: text } })
  fireEvent.blur(input)
}

const show = () => render(<InspectorPanel inspectedPerson={null} />)

beforeEach(() => {
  useEditor.setState({ selection: [], hover: null, toasts: [] })
})

describe('the inspector with a doorway selected', () => {
  it('reports the leaf width the plan actually holds', () => {
    openWith({ walls: [makeWall()], openings: [makeDoor()] })
    select({ kind: 'opening', id: 'door-1' })
    show()

    // The header badge and the width box are two readings of the same number,
    // and a leaf catalogued at 914 mm has to survive both: 3'0" shows as 91 cm,
    // not as a tidy 90.
    expect(screen.getByText(/^doorway$/i).nextElementSibling?.textContent).toBe('91 cm')
    expect(control(/^width$/i).value).toBe('91 cm')
    expect(firstOpening().width).toBeCloseTo(0.914, 6)
  })

  it('names a door by the size it would be ordered as', () => {
    openWith({ walls: [makeWall()], openings: [makeDoor()] }, { units: 'imperial' })
    select({ kind: 'opening', id: 'door-1' })
    show()

    // A 3'0" leaf is the default and the commonest door in the catalogue, and
    // it used to read 2' 12.0". `formatLength` took the feet with a floor and
    // rounded the remainder to a tenth independently, so any total landing a
    // hair under a whole foot — which every catalogued size does, because the
    // metric value is rounded to the millimetre — printed as the foot below
    // plus twelve inches. An imperial user could not match anything on screen
    // against a door schedule, which is the entire point of the setting, and a
    // width read back as 2' 12" invites somebody to "correct" it to a size
    // nobody makes.
    expect(control(/^width$/i).value).toBe(`3' 0"`)
    expect(screen.getByText(`3' 0"`)).toBeDefined()

    // And the box echoes the figure the user typed.
    typeAndLeave(/^width$/i, '3')
    expect(firstOpening().width).toBeCloseTo(0.9144, 6)
    expect(control(/^width$/i).value).toBe(`3' 0"`)

    // A catalogued pair goes the same way.
    fireEvent.change(control(/^stock size$/i), { target: { value: `5'0" pair` } })
    expect(firstOpening().width).toBeCloseTo(1.524, 6)
    expect(control(/^width$/i).value).toBe(`5' 0"`)
  })

  it('cuts a width that would swallow the wall down to one the wall can carry', () => {
    openWith({ walls: [makeWall()], openings: [makeDoor()] })
    select({ kind: 'opening', id: 'door-1' })
    show()

    typeAndLeave(/^width$/i, '5 m')

    // A door is cut into a wall, not instead of one: 2" of jamb has to survive
    // at each end or the wall vanishes from the plan while staying in the
    // document.
    const door = firstOpening()
    expect(door.width).toBeCloseTo(3 - 2 * OPENING_JAMB, 6)
    expect(door.offset - door.width / 2).toBeCloseTo(OPENING_JAMB, 6)
    expect(wallLength(firstWall()) - (door.offset + door.width / 2)).toBeCloseTo(OPENING_JAMB, 6)
  })

  it('warns about a width nobody makes and writes an exact leaf when one is chosen', () => {
    openWith({ walls: [makeWall()], openings: [makeDoor({ width: 0.92 })] })
    select({ kind: 'opening', id: 'door-1' })
    show()

    expect(screen.getByText('Not a stock size')).toBeDefined()
    // The dropdown snaps to the nearest orderable leaf rather than blanking, so
    // correcting the width is one click — but it therefore *names* a size this
    // door is not, and the hint beside the width box is the only thing saying
    // the two disagree.
    expect(control(/^stock size$/i).value).toBe(`3'0"`)

    fireEvent.change(control(/^stock size$/i), { target: { value: `2'8"` } })

    // 2'8" is 32 inches, carried to the millimetre — 0.813 m, not "about 0.81".
    expect(firstOpening().width).toBeCloseTo(0.813, 6)
    expect(screen.queryByText('Not a stock size')).toBeNull()
  })

  it('will not let the position slider push a door off the end of its wall', () => {
    openWith({ walls: [makeWall()], openings: [makeDoor()] })
    select({ kind: 'opening', id: 'door-1' })
    show()

    const slider = control(/^position along the wall$/i)
    fireEvent.change(slider, { target: { value: '99' } })

    const door = firstOpening()
    expect(door.offset).toBeCloseTo(3 - DEFAULT_DOOR_WIDTH / 2 - OPENING_JAMB, 6)
    expect(door.offset + door.width / 2).toBeLessThanOrEqual(wallLength(firstWall()))
  })

  it('will not let a doorway grow taller than the wall it is cut into', () => {
    openWith({ walls: [makeWall({ height: 2.438 })], openings: [makeDoor()] })
    select({ kind: 'opening', id: 'door-1' })
    show()

    typeAndLeave(/^height$/i, '5 m')

    // 8'0" of wall cannot carry a 5 m head; something has to hold the lintel up.
    expect(firstOpening().height).toBeCloseTo(2.438, 6)
  })

  it('says whether people can walk through an opening once it has a sill', () => {
    openWith({ walls: [makeWall()], openings: [makeDoor()] })
    select({ kind: 'opening', id: 'door-1' })
    show()

    expect(screen.getByText('Walkable')).toBeDefined()

    typeAndLeave(/^sill$/i, '0.4')

    expect(firstOpening().sill).toBeCloseTo(0.4, 6)
    expect(screen.getByText('Not walkable')).toBeDefined()

    // The sill cannot be raised past what is left of the wall above the head.
    typeAndLeave(/^sill$/i, '5 m')
    expect(firstOpening().sill).toBeCloseTo(DEFAULT_WALL_HEIGHT - DEFAULT_DOOR_HEIGHT, 6)
  })

  it('records that a door is a way out, and takes the mark off again', () => {
    openWith({ walls: [makeWall()], openings: [makeDoor()] })
    select({ kind: 'opening', id: 'door-1' })
    show()

    const use = control(/^people use it as$/i)
    fireEvent.change(use, { target: { value: 'exit' } })
    // Every egress figure is metered by the clear width of the doors marked
    // here, so the mark has to survive the round trip through the document.
    expect(firstOpening().use).toBe('exit')

    fireEvent.change(control(/^people use it as$/i), { target: { value: 'none' } })
    expect(firstOpening().use).toBeUndefined()
  })
})

describe('the inspector with a wall selected', () => {
  it('moves the far end when a length is typed, keeping the direction it was drawn in', () => {
    openWith({ walls: [makeWall({ b: { x: 3, y: 4 } })] })
    select({ kind: 'wall', id: 'wall-1' })
    show()

    // A 3-4-5 wall doubled: the far end lands at (6, 8), not at (10, 0).
    typeAndLeave(/^length$/i, '10')

    const wall = firstWall()
    expect(wall.a).toEqual({ x: 0, y: 0 })
    expect(wall.b.x).toBeCloseTo(6, 6)
    expect(wall.b.y).toBeCloseTo(8, 6)
  })

  it('swings a wall about its start when an angle is typed, keeping its length', () => {
    openWith({ walls: [makeWall({ b: { x: 4, y: 0 } })] })
    select({ kind: 'wall', id: 'wall-1' })
    show()

    typeAndLeave(/^angle$/i, '90')

    const wall = firstWall()
    expect(wallLength(wall)).toBeCloseTo(4, 6)
    expect(wall.b.x).toBeCloseTo(0, 6)
    expect(wall.b.y).toBeCloseTo(4, 6)
  })

  it('is where a locked wall gets unlocked, and refuses to delete it until it is', () => {
    openWith({ walls: [makeWall({ locked: true })] })
    select({ kind: 'wall', id: 'wall-1' })
    show()

    fireEvent.click(screen.getByText('Delete wall'))
    // A lock that only refuses deletion from the plan and not from the panel
    // that owns the object reads as protection without being any.
    expect(doc().plan.walls).toHaveLength(1)

    fireEvent.click(screen.getByLabelText(/^locked$/i))
    expect(firstWall().locked).toBe(false)

    fireEvent.click(screen.getByText('Delete wall'))
    expect(doc().plan.walls).toHaveLength(0)
  })
})

describe('the inspector with nothing, or several things, selected', () => {
  it('says what to do rather than showing an empty form', () => {
    openWith({ walls: [makeWall()] })
    show()
    expect(screen.getByText(/nothing selected/i)).toBeDefined()
    expect(screen.queryByText(/^length$/i)).toBeNull()
  })

  it('deletes a whole multiple selection as one undo step', () => {
    openWith({
      walls: [makeWall(), makeWall({ id: 'wall-2', a: { x: 0, y: 2 }, b: { x: 3, y: 2 } })],
    })
    select({ kind: 'wall', id: 'wall-1' }, { kind: 'wall', id: 'wall-2' })
    show()

    expect(screen.getByText('2 selected')).toBeDefined()
    fireEvent.click(screen.getByText('Delete 2 objects'))

    expect(doc().plan.walls).toHaveLength(0)
    // One gesture, one step back: undoing a box-select delete twice would be a
    // surprise.
    expect(useEditor.getState().undoLabel()).toBe('Delete 2 objects')
    useEditor.getState().undo()
    expect(doc().plan.walls).toHaveLength(2)
  })
})

describe('the inspector with an area or a counter selected', () => {
  const zone: Zone = {
    id: 'zone-1',
    kind: 'measure',
    name: 'Dance floor',
    polygon: [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 4 },
      { x: 0, y: 4 },
    ],
  }

  it('measures the area it is showing rather than quoting what was drawn', () => {
    openWith({ zones: [zone] })
    select({ kind: 'zone', id: 'zone-1' })
    show()

    // 6 × 4, measured from the polygon rather than read off whatever the drag
    // that made it thought it was drawing.
    expect(screen.getByText('24 m²')).toBeDefined()
    expect(screen.getByText(/4 corners/)).toBeDefined()
  })

  it('makes a typed name one undo step, not one per letter', () => {
    openWith({ zones: [zone] })
    select({ kind: 'zone', id: 'zone-1' })
    show()

    const name = control(/^name$/i)
    for (const draft of ['S', 'St', 'Sta', 'Stag', 'Stage']) {
      fireEvent.change(name, { target: { value: draft } })
    }
    expect(doc().plan.zones[0].name).toBe('Stage')

    // Typing a name is one gesture, so it is one undo step. Every character
    // used to be its own history entry, which meant undoing "Stage" handed the
    // user "Stag" — indistinguishable from the editor eating a letter. The
    // numeric fields beside it already held a draft and committed on blur, and
    // the project's own rule is that a gesture is one undo step.
    expect(useEditor.getState().undoLabel()).toBe('Rename area')
    useEditor.getState().undo()
    expect(doc().plan.zones[0].name).toBe('Dance floor')

    // And the next rename is a separate step rather than merging into it.
    useEditor.getState().redo()
    fireEvent.blur(name)
    fireEvent.change(name, { target: { value: 'Pit' } })
    useEditor.getState().undo()
    expect(doc().plan.zones[0].name).toBe('Stage')
  })

  const counter: ServicePoint = {
    id: 'svc-1',
    name: 'Bar',
    position: { x: 0, y: 0 },
    rotation: 0,
    width: 2,
    depth: 0.7,
    servers: 3,
    serviceTime: { kind: 'lognormal', mean: 45, sd: 15 },
    queueSpacing: 0.6,
  }

  it('turns staffing and service time into the hourly throughput a planner asks for', () => {
    openWith({ servicePoints: [counter] })
    select({ kind: 'service', id: 'svc-1' })
    show()

    // Little's law: three positions at 45 s each clears 3600 * 3 / 45 = 240/h.
    // The sentence has to carry the figures it was computed from, or a planner
    // reading 240 cannot tell which of the two inputs to change.
    const throughput = () => screen.getByText('Switch to the queue tool', { exact: false })
    expect(throughput().textContent).toContain('3 positions and 45 s each')
    expect(screen.getByText('240').tagName).toBe('B')

    // Doubling the time each person takes halves what the counter clears, and
    // the widened spread goes with it — a mean without an sd is a constant.
    typeAndLeave(/^service time$/i, '90')
    expect(doc().plan.servicePoints[0].serviceTime.mean).toBe(90)
    expect(doc().plan.servicePoints[0].serviceTime.sd).toBeCloseTo(31.5, 6)
    expect(throughput().textContent).toContain('90 s each')
    expect(screen.getByText('120').tagName).toBe('B')
  })
})
