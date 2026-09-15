import { describe, it } from 'vitest'
import { Simulation } from '../engine'
import type { Plan, Scenario, Wall, Zone } from '../../core/model/types'
import { createScenario } from '../../core/model/defaults'

let n = 0
const wall = (ax: number, ay: number, bx: number, by: number, thickness = 0.2): Wall => ({
  id: `w${n++}`,
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
  thickness,
  height: 3,
  kind: 'wall',
})
const zone = (kind: Zone['kind'], x0: number, y0: number, x1: number, y1: number): Zone => ({
  id: `${kind}_${n++}`,
  kind,
  name: kind,
  polygon: [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ],
})

describe('probe', () => {
  it('tc1', () => {
    const entry = zone('entry', 0.4, 0.5, 1.4, 1.5)
    const exit = zone('exit', 39.0, 0.4, 39.8, 1.6)
    const plan: Plan = {
      walls: [wall(0, 0, 40, 0), wall(0, 2, 40, 2), wall(0, 0, 0, 2), wall(40, 0, 40, 2)],
      openings: [],
      furniture: [],
      zones: [entry, exit],
      servicePoints: [],
    }
    const base = createScenario()
    const scenario: Scenario = {
      ...base,
      durationS: 200,
      profiles: [
        {
          id: 'fixed',
          name: 'Fixed',
          radius: 0.23,
          speed: { mean: 1, sd: 0, min: 1, max: 1 },
          caution: 1,
          assertiveness: 0.5,
          color: '#000',
          heightScale: 1,
          mobility: 'walking',
        },
      ],
      populations: [
        {
          id: 'pop-tc1',
          name: 'one',
          count: 1,
          color: '#000',
          entryIds: [entry.id],
          arrival: { kind: 'all-at-once', startS: 0, windowS: 0 },
          profileMix: [{ profileId: 'fixed', weight: 1 }],
          itinerary: [{ id: 'exit', kind: 'exit' }],
        },
      ],
    }
    const sim = new Simulation(plan, scenario)
    const dt = 0.1
    let prevX = -1
    let prevT = 0
    let t2 = -1
    let t38 = -1
    let maxSpeed = 0
    for (let i = 0; i < 2000 && !sim.isFinished; i++) {
      sim.step(dt)
      const s = sim.snapshot()
      if (s.count === 0) continue
      const x = s.agents[0]
      const sp = s.agents[3]
      maxSpeed = Math.max(maxSpeed, sp)
      const t = sim.currentTime
      if (prevX >= 0) {
        if (t2 < 0 && prevX < 2 && x >= 2) t2 = prevT + ((2 - prevX) / (x - prevX)) * (t - prevT)
        if (t38 < 0 && prevX < 38 && x >= 38)
          t38 = prevT + ((38 - prevX) / (x - prevX)) * (t - prevT)
      }
      prevX = x
      prevT = t
    }
    const span = t38 - t2
    console.warn(
      `TC1 t2=${t2.toFixed(3)} t38=${t38.toFixed(3)} span=${span.toFixed(3)} scaled40=${((span * 40) / 36).toFixed(3)} maxSpeed=${maxSpeed.toFixed(3)} completed=${sim.summary().completed}`,
    )
  })
})
