import { describe, it } from 'vitest'
import {
  cellCenter,
  clearanceField,
  createNavGrid,
  createNavGrid as _c,
  gridIndex,
  rasterizePolygon,
  sampleGradient,
  solveEikonal,
  worldToCell,
} from './eikonal'

void _c

describe('probe', () => {
  it('radial accuracy', () => {
    const cell = 0.25
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 40, maxY: 40 }, cell)
    const blocked = new Uint8Array(grid.cols * grid.rows)
    const speed = new Float32Array(grid.cols * grid.rows).fill(1)
    const gc = worldToCell(grid, 20, 20)
    const t = solveEikonal(grid, blocked, speed, [gridIndex(grid, gc.col, gc.row)])
    const center = cellCenter(grid, gc.col, gc.row)
    const lines: string[] = []
    for (const deg of [0, 15, 30, 45, 60, 75, 90, 135, 180, 225, 26.565]) {
      const a = (deg * Math.PI) / 180
      for (const r of [1, 2, 5, 10, 15]) {
        const x = center.x + Math.cos(a) * r
        const y = center.y + Math.sin(a) * r
        const c = worldToCell(grid, x, y)
        const cc = cellCenter(grid, c.col, c.row)
        const exact = Math.hypot(cc.x - center.x, cc.y - center.y)
        const got = t[gridIndex(grid, c.col, c.row)]
        lines.push(`deg=${deg} r=${r} exact=${exact.toFixed(4)} got=${got.toFixed(4)} rel=${(((got - exact) / exact) * 100).toFixed(3)}%`)
      }
    }
    console.error(lines.join('\n'))
  })

  it('timing 300x200', () => {
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 75, maxY: 50 }, 0.25)
    console.error('grid', grid.cols, grid.rows)
    const n = grid.cols * grid.rows
    const blocked = new Uint8Array(n)
    const speed = new Float32Array(n).fill(1)
    // warm
    solveEikonal(grid, blocked, speed, [gridIndex(grid, 5, 5)])
    let t = speed as unknown as Float32Array
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now()
      t = solveEikonal(grid, blocked, speed, [gridIndex(grid, 5, 5)])
      console.error('solve ms', (performance.now() - t0).toFixed(2))
    }
    console.error('corner T', t[gridIndex(grid, grid.cols - 1, grid.rows - 1)].toFixed(3), 'exact', Math.hypot(grid.cols - 6, grid.rows - 6) * 0.25)
    for (let k = 0; k < 3; k++) {
      const t1 = performance.now()
      clearanceField(grid, blocked)
      console.error('clearance ms', (performance.now() - t1).toFixed(2))
    }
  })

  it('wall with gap + descent', () => {
    const cell = 0.25
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 20, maxY: 20 }, cell)
    const n = grid.cols * grid.rows
    const blocked = new Uint8Array(n)
    // wall along y=10, thickness 0.5, gap from x=14..15.5
    rasterizePolygon(grid, [
      { x: 0, y: 9.75 }, { x: 14, y: 9.75 }, { x: 14, y: 10.25 }, { x: 0, y: 10.25 },
    ], blocked)
    rasterizePolygon(grid, [
      { x: 15.5, y: 9.75 }, { x: 20, y: 9.75 }, { x: 20, y: 10.25 }, { x: 15.5, y: 10.25 },
    ], blocked)
    const speed = new Float32Array(n).fill(1)
    const g = worldToCell(grid, 2, 18)
    const goal = gridIndex(grid, g.col, g.row)
    const t = solveEikonal(grid, blocked, speed, [goal])
    const gc = cellCenter(grid, g.col, g.row)
    let x = 3
    let y = 2
    let steps = 0
    const step = cell * 0.5
    while (steps < 4000 && Math.hypot(x - gc.x, y - gc.y) > 0.4) {
      const s = sampleGradient(grid, t, x, y)
      if (!s) { console.error('LOST at', x.toFixed(2), y.toFixed(2), 'step', steps); break }
      if (s.dx === 0 && s.dy === 0) { console.error('FLAT at', x.toFixed(2), y.toFixed(2)); break }
      x += s.dx * step
      y += s.dy * step
      steps++
    }
    console.error('descent steps', steps, 'end', x.toFixed(2), y.toFixed(2), 'dist', Math.hypot(x - gc.x, y - gc.y).toFixed(3))
  })

  it('clearance 1m', () => {
    const cell = 0.25
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 20, maxY: 20 }, cell)
    const blocked = new Uint8Array(grid.cols * grid.rows)
    rasterizePolygon(grid, [
      { x: 4.9, y: 0 }, { x: 5.1, y: 0 }, { x: 5.1, y: 20 }, { x: 4.9, y: 20 },
    ], blocked)
    const cl = clearanceField(grid, blocked)
    for (const px of [6.0, 6.1, 7, 4.1]) {
      const c = worldToCell(grid, px, 10)
      console.error('x=', px, 'clearance', cl[gridIndex(grid, c.col, c.row)].toFixed(4), 'centre', cellCenter(grid, c.col, c.row).x)
    }
    const cW = worldToCell(grid, 5.0, 10)
    console.error('inside wall clearance', cl[gridIndex(grid, cW.col, cW.row)].toFixed(4))
  })
})
