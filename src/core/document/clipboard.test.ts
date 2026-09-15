import { describe, expect, it } from 'vitest'
import { clipboardSize, copySelection, paste } from './clipboard'
import { getTemplate } from '../../library/templates'
import type { PlanObjectRef } from '../model/types'

const doc = () => getTemplate('coffee-bar')!.build()

describe('clipboard', () => {
  it('copies the selected objects and nothing else', () => {
    const document = doc()
    const refs: PlanObjectRef[] = [{ kind: 'furniture', id: document.plan.furniture[0].id }]
    const clipboard = copySelection(document, refs)
    expect(clipboard.furniture).toHaveLength(1)
    expect(clipboard.walls).toHaveLength(0)
    expect(clipboardSize(clipboard)).toBe(1)
  })

  it('takes a wall’s doors and windows with it', () => {
    const document = doc()
    const wallWithOpening = document.plan.openings[0].wallId
    const clipboard = copySelection(document, [{ kind: 'wall', id: wallWithOpening }])
    expect(clipboard.walls).toHaveLength(1)
    expect(clipboard.openings.length).toBeGreaterThan(0)

    const { document: pasted } = paste(document, clipboard, { x: 5, y: 0 })
    const newWall = pasted.plan.walls[pasted.plan.walls.length - 1]
    const newOpenings = pasted.plan.openings.filter((o) => o.wallId === newWall.id)
    expect(newOpenings.length).toBe(clipboard.openings.length)
  })

  it('gives every pasted object a fresh identity', () => {
    const document = doc()
    const refs: PlanObjectRef[] = document.plan.furniture.slice(0, 3).map((item) => ({
      kind: 'furniture',
      id: item.id,
    }))
    const clipboard = copySelection(document, refs)
    const { document: pasted, refs: created } = paste(document, clipboard, { x: 1, y: 1 })

    expect(created).toHaveLength(3)
    const ids = pasted.plan.furniture.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const ref of created) expect(refs.some((r) => r.id === ref.id)).toBe(false)
  })

  it('offsets what it pastes, so the copy is visible', () => {
    const document = doc()
    const original = document.plan.furniture[0]
    const clipboard = copySelection(document, [{ kind: 'furniture', id: original.id }])
    const { document: pasted } = paste(document, clipboard, { x: 2, y: -1 })
    const copy = pasted.plan.furniture[pasted.plan.furniture.length - 1]
    expect(copy.position.x).toBeCloseTo(original.position.x + 2, 6)
    expect(copy.position.y).toBeCloseTo(original.position.y - 1, 6)
  })

  it('unlocks what it pastes', () => {
    const document = doc()
    const locked = {
      ...document.plan.furniture[0],
      locked: true,
    }
    const withLocked = {
      ...document,
      plan: { ...document.plan, furniture: [locked, ...document.plan.furniture.slice(1)] },
    }
    const clipboard = copySelection(withLocked, [{ kind: 'furniture', id: locked.id }])
    const { document: pasted } = paste(withLocked, clipboard, { x: 1, y: 0 })
    expect(pasted.plan.furniture[pasted.plan.furniture.length - 1].locked).toBe(false)
  })

  it('does nothing when the clipboard is empty', () => {
    const document = doc()
    const result = paste(document, copySelection(document, []), { x: 1, y: 1 })
    expect(result.document).toBe(document)
    expect(result.refs).toHaveLength(0)
  })

  it('is not affected by later edits to the original', () => {
    const document = doc()
    const original = document.plan.furniture[0]
    const clipboard = copySelection(document, [{ kind: 'furniture', id: original.id }])
    // Mutating the live document must not reach into the clipboard.
    original.position.x = 999
    expect(clipboard.furniture[0].position.x).not.toBe(999)
  })
})
