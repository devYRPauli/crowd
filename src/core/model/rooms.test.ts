import { describe, expect, it } from 'vitest'
import { detectRooms } from './rooms'
import type { Wall } from './types'

let counter = 0
const wall = (ax: number, ay: number, bx: number, by: number): Wall => ({
  id: `w${counter++}`,
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
  thickness: 0.15,
  height: 3,
  kind: 'wall',
})

const rect = (x0: number, y0: number, x1: number, y1: number): Wall[] => [
  wall(x0, y0, x1, y0),
  wall(x1, y0, x1, y1),
  wall(x1, y1, x0, y1),
  wall(x0, y1, x0, y0),
]

describe('detectRooms', () => {
  it('finds a single closed rectangle', () => {
    const rooms = detectRooms(rect(0, 0, 6, 4))
    expect(rooms).toHaveLength(1)
    expect(rooms[0].area).toBeCloseTo(24, 5)
    expect(rooms[0].center.x).toBeCloseTo(3, 5)
    expect(rooms[0].center.y).toBeCloseTo(2, 5)
  })

  it('splits a rectangle divided by an interior wall', () => {
    const rooms = detectRooms([...rect(0, 0, 8, 4), wall(4, 0, 4, 4)])
    expect(rooms).toHaveLength(2)
    expect(rooms.map((r) => Math.round(r.area)).sort()).toEqual([16, 16])
  })

  it('handles a T-junction where a wall stops on another wall', () => {
    const rooms = detectRooms([...rect(0, 0, 8, 4), wall(4, 0, 4, 2)])
    // The stub does not enclose anything, so the outer room stays whole.
    expect(rooms).toHaveLength(1)
    expect(rooms[0].area).toBeCloseTo(32, 4)
  })

  it('ignores open shapes', () => {
    const rooms = detectRooms([wall(0, 0, 5, 0), wall(5, 0, 5, 5)])
    expect(rooms).toHaveLength(0)
  })

  it('finds nested rooms drawn as a grid', () => {
    const walls = [...rect(0, 0, 10, 10), wall(5, 0, 5, 10), wall(0, 5, 10, 5)]
    const rooms = detectRooms(walls)
    expect(rooms).toHaveLength(4)
    for (const room of rooms) expect(room.area).toBeCloseTo(25, 4)
  })
})
