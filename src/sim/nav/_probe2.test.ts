import { describe, it } from 'vitest'
import { cellCenter, createNavGrid, gridIndex, sampleGradient, solveEikonal, worldToCell } from './eikonal'

describe('probe2', () => {
  it('value and direction error', () => {
    const cell = 0.25
    const grid = createNavGrid({ minX: 0, minY: 0, maxX: 40, maxY: 40 }, cell)
    const n = grid.cols * grid.rows
    const t0 = performance.now()
    const t = solveEikonal(grid, new Uint8Array(n), new Float32Array(n).fill(1), [
      gridIndex(grid, ...(() => { const c = worldToCell(grid, 20, 20); return [c.col, c.row] as [number, number] })()),
    ])
    const ms = performance.now() - t0
    const gcell = worldToCell(grid, 20, 20)
    const center = cellCenter(grid, gcell.col, gcell.row)
    let worstVal = 0
    let worstAng = 0
    const rows: string[] = []
    for (let deg = 0; deg < 90; deg += 5) {
      const a = (deg * Math.PI) / 180
      for (const r of [2, 5, 10, 15]) {
        const c = worldToCell(grid, center.x + Math.cos(a) * r, center.y + Math.sin(a) * r)
        const cc = cellCenter(grid, c.col, c.row)
        const exact = Math.hypot(cc.x - center.x, cc.y - center.y)
        const rel = Math.abs(t[gridIndex(grid, c.col, c.row)] - exact) / exact
        if (rel > worstVal) worstVal = rel
        // direction: downhill should point straight back at the goal
        const g = sampleGradient(grid, t, cc.x, cc.y)!
        const want = Math.atan2(center.y - cc.y, center.x - cc.x)
        let d = Math.abs(((Math.atan2(g.dy, g.dx) - want + Math.PI * 3) % (Math.PI * 2)) - Math.PI)
        d = (d * 180) / Math.PI
        if (d > worstAng) worstAng = d
        if (deg % 15 === 0) rows.push(`deg=${deg} r=${r} relErr=${(rel * 100).toFixed(2)}% angErr=${d.toFixed(2)}deg`)
      }
    }
    console.error(rows.join('\n'))
    console.error(`WORST value err ${(worstVal * 100).toFixed(2)}%  WORST angle err ${worstAng.toFixed(2)} deg  solve ${ms.toFixed(1)}ms`)
  })
})
