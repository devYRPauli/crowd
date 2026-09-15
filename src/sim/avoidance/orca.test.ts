import { describe, expect, it } from 'vitest'
import type { Vec2 } from '../../core/math/vec2'
import { distance, fromAngle, length, scale, sub } from '../../core/math/vec2'
import { Rng } from '../../core/math/random'
import type { OrcaAgentState, OrcaLine } from './orca'
import { buildObstacles, buildOrcaLines, computeNewVelocity, solveOrca } from './orca'

const agent = (overrides: Partial<OrcaAgentState> = {}): OrcaAgentState => ({
  position: { x: 0, y: 0 },
  velocity: { x: 0, y: 0 },
  radius: 0.5,
  maxSpeed: 1.5,
  prefVelocity: { x: 0, y: 0 },
  timeHorizon: 5,
  timeHorizonObst: 2,
  responsibility: 0.5,
  ...overrides,
})

const NO_OBSTACLES: number[] = []

describe('solveOrca', () => {
  it('returns the preferred velocity when nothing constrains the agent', () => {
    const a = agent({ prefVelocity: { x: 0.8, y: -0.6 } })
    const velocity = computeNewVelocity(a, [], [], NO_OBSTACLES)
    expect(velocity.x).toBe(0.8)
    expect(velocity.y).toBe(-0.6)
  })

  it('clamps a preferred velocity above maxSpeed', () => {
    const a = agent({ prefVelocity: { x: 3, y: 4 }, maxSpeed: 1.5 })
    const velocity = computeNewVelocity(a, [], [], NO_OBSTACLES)
    expect(length(velocity)).toBeCloseTo(1.5, 12)
    expect(velocity.x).toBeCloseTo(0.9, 12)
    expect(velocity.y).toBeCloseTo(1.2, 12)
  })

  it('leaves the velocity at zero when maxSpeed is zero', () => {
    const a = agent({ prefVelocity: { x: 1, y: 1 }, maxSpeed: 0 })
    const velocity = computeNewVelocity(a, [], [], NO_OBSTACLES)
    expect(velocity.x).toBe(0)
    expect(velocity.y).toBe(0)
  })
})

describe('agent ORCA lines', () => {
  it('steers a head-on pair sideways, symmetrically', () => {
    const left = agent({
      position: { x: -2, y: 0 },
      velocity: { x: 1.5, y: 0 },
      prefVelocity: { x: 1.5, y: 0 },
    })
    const right = agent({
      position: { x: 2, y: 0 },
      velocity: { x: -1.5, y: 0 },
      prefVelocity: { x: -1.5, y: 0 },
    })

    const leftVelocity = computeNewVelocity(left, [right], [], NO_OBSTACLES)
    const rightVelocity = computeNewVelocity(right, [left], [], NO_OBSTACLES)

    expect(Math.abs(leftVelocity.y)).toBeGreaterThan(0.05)
    expect(Math.abs(rightVelocity.y)).toBeGreaterThan(0.05)
    // Mirror images: same lateral magnitude, opposite signs, and still closing.
    expect(leftVelocity.y).toBeCloseTo(-rightVelocity.y, 12)
    expect(leftVelocity.x).toBeCloseTo(-rightVelocity.x, 12)
    expect(leftVelocity.x).toBeGreaterThan(0)
    expect(rightVelocity.x).toBeLessThan(0)
  })

  it('gives every neighbour one constraint line', () => {
    const a = agent({ prefVelocity: { x: 1, y: 0 } })
    const neighbours = [
      agent({ position: { x: 2, y: 0 } }),
      agent({ position: { x: 0, y: 2 } }),
      agent({ position: { x: -2, y: 0 } }),
    ]
    expect(buildOrcaLines(a, neighbours, [], NO_OBSTACLES)).toHaveLength(3)
  })

  it('reuses a caller-supplied output array', () => {
    const a = agent({ prefVelocity: { x: 1, y: 0 } })
    const out = buildOrcaLines(a, [agent({ position: { x: 2, y: 0 } })], [], NO_OBSTACLES)
    const first = out[0]
    const again = buildOrcaLines(a, [agent({ position: { x: 2, y: 0.5 } })], [], NO_OBSTACLES, out)
    expect(again).toBe(out)
    expect(again[0]).toBe(first)
    expect(again).toHaveLength(1)
  })

  it('separates coincident agents deterministically instead of producing NaN', () => {
    const a = agent({ position: { x: 3, y: 1 }, prefVelocity: { x: 1, y: 0 } })
    const b = agent({ position: { x: 3, y: 1 }, velocity: { x: 0.2, y: 0 } })
    const first = computeNewVelocity(a, [b], [], NO_OBSTACLES)
    const second = computeNewVelocity(a, [b], [], NO_OBSTACLES)
    expect(Number.isFinite(first.x)).toBe(true)
    expect(Number.isFinite(first.y)).toBe(true)
    expect(first).toEqual(second)
  })

  it('makes the responsible agent absorb the whole correction', () => {
    const shared = agent({
      position: { x: 0, y: 0 },
      velocity: { x: 1.5, y: 0 },
      prefVelocity: { x: 1.5, y: 0 },
      responsibility: 0.5,
    })
    const solo = agent({ ...shared, responsibility: 1 })
    const blocker = agent({ position: { x: 4, y: 0 }, velocity: { x: -1.5, y: 0 } })

    const sharedLine = buildOrcaLines(shared, [blocker], [], NO_OBSTACLES)[0]
    const soloLine = buildOrcaLines(solo, [blocker], [], NO_OBSTACLES)[0]
    const sharedOffset = sub(sharedLine.point, shared.velocity)
    const soloOffset = sub(soloLine.point, solo.velocity)
    expect(length(soloOffset)).toBeCloseTo(2 * length(sharedOffset), 12)
  })
})

describe('buildObstacles', () => {
  it('links a CCW square into a loop of convex vertices', () => {
    const square: Vec2[] = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ]
    const obstacles = buildObstacles([square])
    expect(obstacles).toHaveLength(4)
    expect(obstacles.every((o) => o.convex)).toBe(true)
    expect(obstacles[0].nextIndex).toBe(1)
    expect(obstacles[0].prevIndex).toBe(3)
    expect(obstacles[3].nextIndex).toBe(0)
    expect(obstacles[0].direction).toEqual({ x: 1, y: 0 })
    expect(obstacles[1].direction).toEqual({ x: 0, y: 1 })
  })

  it('marks the reflex corner of an L-shaped solid as non-convex', () => {
    const shape: Vec2[] = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 2 },
      { x: 2, y: 2 },
      { x: 2, y: 4 },
      { x: 0, y: 4 },
    ]
    const obstacles = buildObstacles([shape])
    expect(obstacles.map((o) => o.convex)).toEqual([true, true, true, false, true, true])
  })

  it('treats a two-point wall as a closed pair of convex ends', () => {
    const obstacles = buildObstacles([
      [
        { x: -1, y: 0 },
        { x: 1, y: 0 },
      ],
    ])
    expect(obstacles).toHaveLength(2)
    expect(obstacles.map((o) => o.convex)).toEqual([true, true])
    expect(obstacles[0].nextIndex).toBe(1)
    expect(obstacles[1].nextIndex).toBe(0)
    expect(obstacles[1].direction).toEqual({ x: -1, y: 0 })
  })

  it('offsets indices per loop and skips degenerate ones', () => {
    const obstacles = buildObstacles([
      [{ x: 0, y: 0 }],
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ],
    ])
    expect(obstacles).toHaveLength(3)
    expect(obstacles.map((o) => o.nextIndex)).toEqual([1, 2, 0])
  })

  it('leaves a zero-length edge with a zero direction rather than NaN', () => {
    const obstacles = buildObstacles([
      [
        { x: 2, y: 2 },
        { x: 2, y: 2 },
        { x: 5, y: 2 },
      ],
    ])
    expect(obstacles[0].direction).toEqual({ x: 0, y: 0 })
    expect(obstacles.every((o) => Number.isFinite(o.direction.x))).toBe(true)
  })
})

describe('obstacle ORCA lines', () => {
  // A wall along y = WALL_Y whose solid side is above it: CCW winding puts the
  // interior to the left of the edge direction, so the edge runs +x.
  const WALL_Y = 0.5
  const wall = buildObstacles([
    [
      { x: -5, y: WALL_Y },
      { x: 5, y: WALL_Y },
    ],
  ])
  const wallIndices = [0, 1]
  /** Points away from the wall, into the agent's free space. */
  const wallNormal: Vec2 = { x: 0, y: -1 }

  it('slides an agent along a wall it is pressed against', () => {
    const a = agent({
      position: { x: 0, y: 0 },
      radius: 0.5,
      prefVelocity: { x: 1.2, y: 1.2 },
      maxSpeed: 1.5,
    })
    const velocity = computeNewVelocity(a, [], wall, wallIndices)
    expect(velocity.x * wallNormal.x + velocity.y * wallNormal.y).toBeGreaterThan(-1e-9)
    expect(velocity.x).toBeGreaterThan(0.5)
  })

  it('does not let the agent cross a wall from either side', () => {
    const below = agent({ position: { x: 0, y: 0 }, prefVelocity: { x: 0, y: 1.5 } })
    const above = agent({ position: { x: 0, y: 1 }, prefVelocity: { x: 0, y: -1.5 } })
    expect(computeNewVelocity(below, [], wall, wallIndices).y).toBeLessThan(1e-9)
    expect(computeNewVelocity(above, [], wall, wallIndices).y).toBeGreaterThan(-1e-9)
  })

  it('limits approach speed to the cut-off line of a wall further away', () => {
    // Wall 3 m ahead, radius 0.5, horizon 2 s: the agent may still close the gap
    // at (3 - 0.5) / 2 = 1.25 m/s, which is exactly the cut-off line.
    const farWall = buildObstacles([
      [
        { x: -5, y: 3 },
        { x: 5, y: 3 },
      ],
    ])
    const a = agent({ position: { x: 0, y: 0 }, prefVelocity: { x: 0, y: 1.5 } })
    const velocity = computeNewVelocity(a, [], farWall, [0, 1])
    expect(velocity.x).toBeCloseTo(0, 12)
    expect(velocity.y).toBeCloseTo(1.25, 12)
  })

  it('never relaxes an obstacle line, even when agents make the program infeasible', () => {
    const a = agent({ position: { x: 0, y: 0 }, prefVelocity: { x: 0, y: 1.5 } })
    // Two neighbours squeezing from both sides leave no feasible velocity.
    const neighbours = [
      agent({ position: { x: -0.6, y: 0.1 }, velocity: { x: 1.4, y: 0 } }),
      agent({ position: { x: 0.6, y: 0.1 }, velocity: { x: -1.4, y: 0 } }),
    ]
    const lines = buildOrcaLines(a, neighbours, wall, wallIndices)
    expect(lines.length).toBeGreaterThan(2)
    const velocity = computeNewVelocity(a, neighbours, wall, wallIndices)
    expect(Number.isFinite(velocity.x)).toBe(true)
    expect(velocity.x * wallNormal.x + velocity.y * wallNormal.y).toBeGreaterThan(-1e-9)
  })

  it('ignores obstacle indices that point nowhere', () => {
    const a = agent({ prefVelocity: { x: 1, y: 0 } })
    const velocity = computeNewVelocity(a, [], wall, [-1, 7])
    expect(velocity.x).toBe(1)
    expect(velocity.y).toBe(0)
  })
})

describe('infeasible constraints', () => {
  /** Worst half-plane violation of `v`; negative means every constraint is met. */
  const worstViolation = (lines: readonly OrcaLine[], v: Vec2): number => {
    let worst = -Infinity
    for (const line of lines) {
      const d = line.direction.x * (line.point.y - v.y) - line.direction.y * (line.point.x - v.x)
      if (d > worst) worst = d
    }
    return worst
  }

  /** Best achievable worst-violation over a fine sample of the speed disc. */
  const bestOverDisc = (lines: readonly OrcaLine[], maxSpeed: number): number => {
    let best = Infinity
    for (let gx = -60; gx <= 60; gx++) {
      for (let gy = -60; gy <= 60; gy++) {
        const v = { x: (gx / 60) * maxSpeed, y: (gy / 60) * maxSpeed }
        if (v.x * v.x + v.y * v.y > maxSpeed * maxSpeed) continue
        const worst = worstViolation(lines, v)
        if (worst < best) best = worst
      }
    }
    return best
  }

  // Four fast agents converging on one from every side: no velocity satisfies all
  // four half-planes, which is the case linearProgram3 exists for.
  const boxedIn = agent({ prefVelocity: { x: 1.5, y: 0 }, velocity: { x: 1.5, y: 0 } })
  const crowd = [0, 1, 2, 3].map((i) => {
    const offset = fromAngle((i / 4) * Math.PI * 2, 1.05)
    return agent({ position: offset, velocity: scale(offset, -1.4) })
  })
  const lines = buildOrcaLines(boxedIn, crowd, [], NO_OBSTACLES)

  it('has no feasible velocity in this scenario', () => {
    expect(bestOverDisc(lines, boxedIn.maxSpeed)).toBeGreaterThan(1e-6)
  })

  it('returns the safest velocity instead of giving up', () => {
    const velocity = solveOrca(lines, boxedIn.maxSpeed, boxedIn.prefVelocity, 0)
    expect(length(velocity)).toBeLessThanOrEqual(boxedIn.maxSpeed + 1e-9)
    // No sampled velocity violates the constraints less than the one we picked.
    expect(worstViolation(lines, velocity)).toBeLessThanOrEqual(
      bestOverDisc(lines, boxedIn.maxSpeed) + 1e-6,
    )
  })
})

/**
 * The RVO2 circle benchmark: every agent walks to the far side of a circle, so
 * the whole crowd meets in the middle. ORCA deadlocks under exact symmetry — as
 * RVO2's own demo notes — so the crowd is seeded with the small differences in
 * size, speed and start position that a real one would have.
 */
const CIRCLE_RADIUS = 5
const AGENT_COUNT = 8
const MAX_SPEED = 1.4
const DT = 0.05
const STEPS = 600

interface CircleRun {
  /** Every agent position at every step, for a bit-exact replay comparison. */
  trajectory: number[]
  /** Deepest overlap seen, as a fraction of the pair's summed radii. */
  worstOverlapRatio: number
  goalDistances: number[]
}

const simulateCircle = (seed: number): CircleRun => {
  const rng = new Rng(seed)
  const agents: OrcaAgentState[] = []
  const goals: Vec2[] = []

  for (let i = 0; i < AGENT_COUNT; i++) {
    const angle = (i / AGENT_COUNT) * Math.PI * 2
    const start = fromAngle(angle, CIRCLE_RADIUS)
    const spread = fromAngle(rng.next() * Math.PI * 2, rng.next() * 0.05)
    agents.push(
      agent({
        position: { x: start.x + spread.x, y: start.y + spread.y },
        radius: 0.26 + rng.next() * 0.08,
        maxSpeed: MAX_SPEED + (rng.next() - 0.5) * 0.4,
        timeHorizon: 2,
        timeHorizonObst: 1,
      }),
    )
    goals.push(fromAngle(angle + Math.PI, CIRCLE_RADIUS))
  }

  const trajectory: number[] = []
  const velocities: Vec2[] = agents.map(() => ({ x: 0, y: 0 }))
  const neighbours: OrcaAgentState[] = []
  let worstOverlapRatio = 0

  for (let step = 0; step < STEPS; step++) {
    for (let i = 0; i < AGENT_COUNT; i++) {
      const a = agents[i]
      const toGoal = sub(goals[i], a.position)
      const remaining = length(toGoal)
      // Ease off over the last stride so agents settle instead of orbiting the goal.
      const speed = Math.min(a.maxSpeed, remaining * 2)
      a.prefVelocity = remaining > 1e-9 ? scale(toGoal, speed / remaining) : { x: 0, y: 0 }
    }

    // Two phases: every new velocity is computed from the same old state.
    for (let i = 0; i < AGENT_COUNT; i++) {
      neighbours.length = 0
      for (let j = 0; j < AGENT_COUNT; j++) if (j !== i) neighbours.push(agents[j])
      velocities[i] = computeNewVelocity(agents[i], neighbours, [], NO_OBSTACLES)
    }

    for (let i = 0; i < AGENT_COUNT; i++) {
      const a = agents[i]
      a.velocity = velocities[i]
      a.position = { x: a.position.x + a.velocity.x * DT, y: a.position.y + a.velocity.y * DT }
      trajectory.push(a.position.x, a.position.y)
    }

    for (let i = 0; i < AGENT_COUNT; i++) {
      for (let j = i + 1; j < AGENT_COUNT; j++) {
        const combined = agents[i].radius + agents[j].radius
        const ratio = (combined - distance(agents[i].position, agents[j].position)) / combined
        if (ratio > worstOverlapRatio) worstOverlapRatio = ratio
      }
    }
  }

  return {
    trajectory,
    worstOverlapRatio,
    goalDistances: agents.map((a, i) => distance(a.position, goals[i])),
  }
}

describe('circle benchmark', () => {
  const run = simulateCircle(1337)

  it('never lets a pair overlap by more than 12% of their summed radii', () => {
    expect(run.worstOverlapRatio).toBeLessThanOrEqual(0.12)
  })

  it('gets every agent to the far side of the circle within 30 s', () => {
    for (const d of run.goalDistances) expect(d).toBeLessThan(0.8)
  })

  it('replays bit-identically from the same seed', () => {
    const replay = simulateCircle(1337)
    expect(replay.trajectory).toEqual(run.trajectory)
    expect(replay.worstOverlapRatio).toBe(run.worstOverlapRatio)
    expect(replay.goalDistances).toEqual(run.goalDistances)
  })
})
