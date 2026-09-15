import { describe, expect, it } from 'vitest'
import type { Vec2 } from '../../core/math/vec2'
import {
  cross,
  distance,
  distanceSq,
  dot,
  fromAngle,
  length,
  scale,
  sub,
} from '../../core/math/vec2'
import { Rng } from '../../core/math/random'
import type { OrcaAgentState, OrcaLine } from './orca'
import {
  buildObstacles,
  buildOrcaLines,
  buildOrcaLinesInto,
  computeNewVelocity,
  solveOrca,
} from './orca'

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
const bestOverDisc = (lines: readonly OrcaLine[], maxSpeed: number, steps = 60): number => {
  let best = Infinity
  for (let gx = -steps; gx <= steps; gx++) {
    for (let gy = -steps; gy <= steps; gy++) {
      const v = { x: (gx / steps) * maxSpeed, y: (gy / steps) * maxSpeed }
      if (v.x * v.x + v.y * v.y > maxSpeed * maxSpeed) continue
      const worst = worstViolation(lines, v)
      if (worst < best) best = worst
    }
  }
  return best
}

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

  it('projects onto the leg it is passing, not the mirror one', () => {
    // Closing on a neighbour 4 m ahead while drifting left, so the nearest point
    // on the velocity obstacle is its left leg. That leg is the tangent from the
    // agent to the combined-radius disc: the bearing to the neighbour turned by
    // asin(combinedRadius / distance). Choosing the other leg mirrors the line
    // about that bearing and sends the agent round the wrong side.
    const a = agent({ velocity: { x: 1.2, y: 0.6 } })
    const other = agent({ position: { x: 4, y: 0 } })
    const line = buildOrcaLines(a, [other], [], NO_OBSTACLES)[0]
    const tangent = Math.asin((a.radius + other.radius) / 4)
    expect(line.direction.x).toBeCloseTo(Math.cos(tangent), 12)
    expect(line.direction.y).toBeCloseTo(Math.sin(tangent), 12)
  })

  it('projects onto the cut-off circle when neither leg is nearer', () => {
    // Two agents standing 4 m apart. The relative velocity of zero sits inside
    // the cone, so the nearest escape is straight out of the cut-off circle:
    // centred at relativePosition / timeHorizon with radius combinedRadius /
    // timeHorizon, pushing u back along the line of centres.
    const a = agent()
    const other = agent({ position: { x: 4, y: 0 } })
    const line = buildOrcaLines(a, [other], [], NO_OBSTACLES)[0]
    const inv = 1 / a.timeHorizon
    expect(line.direction.x).toBeCloseTo(0, 12)
    expect(line.direction.y).toBeCloseTo(1, 12)
    // u spans from the relative velocity out to the circle's rim, and the pair
    // splits it, so the line sits that far along +x from the agent's velocity.
    const toRim = (4 - (a.radius + other.radius)) * inv
    expect(line.point.x).toBeCloseTo(a.velocity.x + a.responsibility * toRim, 12)
    expect(line.point.y).toBeCloseTo(a.velocity.y, 12)
  })

  it('clears an existing overlap over one step, not one horizon', () => {
    // Overlapping agents escape on the simulation step, not timeHorizon: u runs
    // along the line of centres at combinedRadius / step - |w|. Centres 0.4 m
    // apart, combined radius 1 m and the module's 1/60 s step give |u| = 36 m/s,
    // halved by the reciprocal split. Falling back to timeHorizon here would
    // leave interpenetrating agents nudging each other at centimetres a second.
    const a = agent()
    const other = agent({ position: { x: 0.4, y: 0 } })
    const line = buildOrcaLines(a, [other], [], NO_OBSTACLES)[0]
    expect(line.direction.x).toBeCloseTo(0, 12)
    expect(line.direction.y).toBeCloseTo(1, 12)
    expect(line.point.x).toBeCloseTo(-18, 9)
    expect(line.point.y).toBeCloseTo(0, 12)
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

  it('never relaxes an obstacle line, even when the only escape is through it', () => {
    // Pressed against the wall with three neighbours converging from the open
    // side: no velocity satisfies every constraint, so linearProgram3 takes over.
    // Its least-violating answer, if the wall were relaxed with everything else,
    // is straight up through it -- so this pins the numObstacleLines handoff.
    const a = agent({ position: { x: 0, y: 0 }, prefVelocity: { x: 0, y: -1.5 } })
    const crowd = [
      agent({ position: { x: 0, y: -1.05 }, velocity: { x: 0, y: 1.5 } }),
      agent({ position: { x: -1.05, y: -0.2 }, velocity: { x: 1.5, y: 0 } }),
      agent({ position: { x: 1.05, y: -0.2 }, velocity: { x: -1.5, y: 0 } }),
    ]
    const lines: OrcaLine[] = []
    const obstacleCount = buildOrcaLinesInto(a, crowd, wall, wallIndices, lines)
    expect(obstacleCount).toBeGreaterThan(0)
    expect(lines).toHaveLength(obstacleCount + crowd.length)
    // The fallback only runs if the 2-D program really is infeasible.
    expect(bestOverDisc(lines, a.maxSpeed)).toBeGreaterThan(1e-6)

    const obstacleLines = lines.slice(0, obstacleCount)
    const velocity = solveOrca(lines, a.maxSpeed, a.prefVelocity, obstacleCount)
    expect(worstViolation(obstacleLines, velocity)).toBeLessThanOrEqual(1e-9)
    expect(velocity.x * wallNormal.x + velocity.y * wallNormal.y).toBeGreaterThan(-1e-9)
    // Without the handoff the same fallback walks the agent into the wall.
    const relaxed = solveOrca(lines, a.maxSpeed, a.prefVelocity, 0)
    expect(worstViolation(obstacleLines, relaxed)).toBeGreaterThan(0.1)
    // And the one-call path has to pass the same count through.
    const direct = computeNewVelocity(a, crowd, wall, wallIndices)
    expect(worstViolation(obstacleLines, direct)).toBeLessThanOrEqual(1e-9)
  })

  it('ignores obstacle indices that point nowhere', () => {
    const a = agent({ prefVelocity: { x: 1, y: 0 } })
    const velocity = computeNewVelocity(a, [], wall, [-1, 7])
    expect(velocity.x).toBe(1)
    expect(velocity.y).toBe(0)
  })
})

describe('obstacle ORCA lines: closed polygon', () => {
  // A 2 x 2 solid block. CCW winding puts the interior on the left of every edge,
  // so all four vertices are convex and each edge owns exactly one face. Unlike a
  // two-point wall, only the face an agent can see should constrain it, which is
  // what makes this the shape that catches sign errors in the case analysis.
  const block = buildObstacles([
    [
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 },
    ],
  ])
  const ALL_EDGES = [0, 1, 2, 3]

  /** Edge start vertices nearest first, the order `buildOrcaLinesInto` documents. */
  const nearestFirst = (x: number, y: number): number[] =>
    block
      .map((o, i) => ({ i, d: distanceSq(o.point, { x, y }) }))
      .sort((a, b) => a.d - b.d || a.i - b.i)
      .map((e) => e.i)

  it('pins an agent pressed against a face to that face', () => {
    // Touching the bottom face: the one half-plane left is "do not move up".
    const a = agent({ position: { x: 0, y: -1.4 } })
    const lines = buildOrcaLines(a, [], block, nearestFirst(0, -1.4))
    expect(lines).toHaveLength(1)
    expect(lines[0].point).toEqual({ x: 0, y: 0 })
    expect(lines[0].direction.x).toBeCloseTo(-1, 12)
    expect(lines[0].direction.y).toBeCloseTo(0, 12)
    // The forbidden side has to be the solid one.
    expect(worstViolation(lines, { x: 0, y: 0.5 })).toBeGreaterThan(0)
    expect(worstViolation(lines, { x: 0, y: -0.5 })).toBeLessThan(0)
  })

  it('turns a touched corner into a tangent through that corner', () => {
    // Off the bottom-left vertex: the constraint is perpendicular to the line of
    // centres, so the agent may circle the corner but not close on it.
    const a = agent({ position: { x: -1.3, y: -1.3 } })
    const lines = buildOrcaLines(a, [], block, nearestFirst(-1.3, -1.3))
    expect(lines).toHaveLength(1)
    expect(lines[0].direction.x).toBeCloseTo(-Math.SQRT1_2, 12)
    expect(lines[0].direction.y).toBeCloseTo(Math.SQRT1_2, 12)
    expect(worstViolation(lines, { x: 0.5, y: 0.5 })).toBeGreaterThan(0)
  })

  it('leaves a shared corner to the single edge that owns it', () => {
    // At the bottom-right vertex both the bottom and the right edge see a vertex
    // collision. The bottom edge has to defer or the corner is counted twice.
    const a = agent({ position: { x: 1.3, y: -1.3 } })
    const lines = buildOrcaLines(a, [], block, nearestFirst(1.3, -1.3))
    expect(lines).toHaveLength(1)
    expect(lines[0].direction.x).toBeCloseTo(-Math.SQRT1_2, 12)
    expect(lines[0].direction.y).toBeCloseTo(-Math.SQRT1_2, 12)
  })

  it('builds both legs from one vertex when a face is seen end-on', () => {
    // Past the left end of the bottom face but still within a radius of its line,
    // so the left vertex alone defines the velocity obstacle. A standing agent
    // then projects onto that vertex's cut-off circle: the line is tangent to a
    // circle of radius / timeHorizonObst around relativePosition / timeHorizonObst.
    const a = agent({ position: { x: -2, y: -1.3 } })
    const lines = buildOrcaLines(a, [], block, nearestFirst(-2, -1.3))
    expect(lines).toHaveLength(1)
    const inv = 1 / a.timeHorizonObst
    const centre = { x: (-1 - a.position.x) * inv, y: (-1 - a.position.y) * inv }
    const offset = sub(lines[0].point, centre)
    const toVelocity = sub(a.velocity, centre)
    expect(length(offset)).toBeCloseTo(a.radius * inv, 12)
    expect(dot(offset, lines[0].direction)).toBeCloseTo(0, 12)
    // Touching the circle is not enough -- the face's own cut-off line does that
    // too. It has to touch at the point nearest the velocity being pushed out.
    expect(cross(offset, toVelocity)).toBeCloseTo(0, 12)
    expect(dot(offset, toVelocity)).toBeGreaterThan(0)
  })

  it('projects onto the leg past the vertex it is heading round', () => {
    // Directly below the block, so the left face is seen end-on from beyond its
    // far end and its bottom vertex alone defines the obstacle. Aiming up and
    // left puts the nearest point of that obstacle on its left leg: the tangent
    // from the agent past the vertex, i.e. the bearing to the vertex turned
    // anticlockwise by asin(radius / distance), the same construction as an agent
    // leg. Mirroring the formula reflects the constraint about that bearing.
    const a = agent({ position: { x: -1, y: -4 }, velocity: { x: -1, y: 1.5 } })
    const lines = buildOrcaLines(a, [], block, nearestFirst(-1, -4))
    expect(lines).toHaveLength(1)
    const toVertex = { x: -1 - a.position.x, y: -1 - a.position.y }
    const span = length(toVertex)
    const turn = Math.asin(a.radius / span)
    const tangent = {
      x: (toVertex.x * Math.cos(turn) - toVertex.y * Math.sin(turn)) / span,
      y: (toVertex.x * Math.sin(turn) + toVertex.y * Math.cos(turn)) / span,
    }
    expect(lines[0].direction.x).toBeCloseTo(tangent.x, 12)
    expect(lines[0].direction.y).toBeCloseTo(tangent.y, 12)
    // And the leg sits a radius / timeHorizonObst off the vertex's cut-off centre.
    const centre = scale(toVertex, 1 / a.timeHorizonObst)
    const offset = sub(lines[0].point, centre)
    expect(length(offset)).toBeCloseTo(a.radius / a.timeHorizonObst, 12)
    expect(dot(offset, lines[0].direction)).toBeCloseTo(0, 12)
  })

  it('sets the cut-off line one radius in front of the face it faces', () => {
    // 3 m below the block, walking up. The binding constraint is the bottom
    // face's cut-off line: reachable in timeHorizonObst, pulled a radius nearer.
    const a = agent({
      position: { x: 0, y: -4 },
      velocity: { x: 0, y: 1.2 },
      prefVelocity: { x: 0, y: 1.5 },
    })
    const lines = buildOrcaLines(a, [], block, nearestFirst(0, -4))
    expect(lines).toHaveLength(1)
    expect(lines[0].direction.x).toBeCloseTo(-1, 12)
    expect(lines[0].direction.y).toBeCloseTo(0, 12)
    expect(lines[0].point.y).toBeCloseTo((3 - a.radius) / a.timeHorizonObst, 12)
    expect(computeNewVelocity(a, [], block, nearestFirst(0, -4)).y).toBeCloseTo(1.25, 12)
  })

  it('skips edges an earlier obstacle line already covers', () => {
    // Handed every edge, including the three faces it cannot see, the agent still
    // ends up with one constraint.
    const a = agent({ position: { x: 0, y: -4 }, velocity: { x: 0, y: 1.2 } })
    expect(buildOrcaLines(a, [], block, ALL_EDGES)).toHaveLength(1)
  })

  it('does not scale obstacle lines by responsibility', () => {
    // Walls take no share of the avoidance, so the half-plane is the same whether
    // the agent is fully reciprocal or doing all the work itself.
    const base = { position: { x: 0, y: -4 }, velocity: { x: 0.3, y: 1.2 } }
    const indices = nearestFirst(0, -4)
    const shared = buildOrcaLines(agent({ ...base, responsibility: 0.5 }), [], block, indices)
    const solo = buildOrcaLines(agent({ ...base, responsibility: 1 }), [], block, indices)
    expect(solo).toEqual(shared)
  })

  it('takes the left leg of the corner it is rounding', () => {
    // Below and well to the left of the block, heading up and right: the nearest
    // point of the velocity obstacle is the left leg past the top-left vertex,
    // reached through the ordinary two-vertex case rather than an end-on view.
    const a = agent({ position: { x: -4.5, y: -1 }, velocity: { x: 1.5, y: 1.5 } })
    const lines = buildOrcaLines(a, [], block, nearestFirst(-4.5, -1))
    expect(lines).toHaveLength(1)
    const toVertex = sub({ x: -1, y: 1 }, a.position)
    const span = length(toVertex)
    const turn = Math.asin(a.radius / span)
    expect(lines[0].direction.x).toBeCloseTo(
      (toVertex.x * Math.cos(turn) - toVertex.y * Math.sin(turn)) / span,
      12,
    )
    expect(lines[0].direction.y).toBeCloseTo(
      (toVertex.x * Math.sin(turn) + toVertex.y * Math.cos(turn)) / span,
      12,
    )
  })

  it('takes the right leg the other way round the same block', () => {
    // Mirror of the case above: the right leg is the bearing to the vertex turned
    // clockwise instead, and the line runs back along it so the forbidden side
    // stays the one containing the block.
    const a = agent({ position: { x: -4.5, y: -0.5 }, velocity: { x: 1.5, y: -1.5 } })
    const lines = buildOrcaLines(a, [], block, nearestFirst(-4.5, -0.5))
    expect(lines).toHaveLength(1)
    const toVertex = sub({ x: -1, y: -1 }, a.position)
    const span = length(toVertex)
    const turn = -Math.asin(a.radius / span)
    expect(lines[0].direction.x).toBeCloseTo(
      -(toVertex.x * Math.cos(turn) - toVertex.y * Math.sin(turn)) / span,
      12,
    )
    expect(lines[0].direction.y).toBeCloseTo(
      -(toVertex.x * Math.sin(turn) + toVertex.y * Math.cos(turn)) / span,
      12,
    )
  })

  it('projects onto the far vertex cut-off circle when it is behind the legs', () => {
    // Level with the left face and reversing away from it: the closest part of
    // the obstacle is the cut-off circle around the face's *far* vertex, and the
    // line is tangent there at the point nearest the velocity.
    const a = agent({ position: { x: -5, y: 0.5 }, velocity: { x: -1.5, y: -1.5 } })
    const lines = buildOrcaLines(a, [], block, nearestFirst(-5, 0.5))
    expect(lines).toHaveLength(1)
    const inv = 1 / a.timeHorizonObst
    const centre = scale(sub({ x: -1, y: -1 }, a.position), inv)
    const offset = sub(lines[0].point, centre)
    const toVelocity = sub(a.velocity, centre)
    expect(length(offset)).toBeCloseTo(a.radius * inv, 12)
    expect(dot(offset, lines[0].direction)).toBeCloseTo(0, 12)
    expect(cross(offset, toVelocity)).toBeCloseTo(0, 12)
    expect(dot(offset, toVelocity)).toBeGreaterThan(0)
  })

  it('runs a reflex corner straight on instead of wrapping round it', () => {
    // At a convex vertex the leg swings round the corner; at a reflex one there
    // is no room to swing into, so it continues the edge that arrives there. The
    // L's inner corner at (2, 2) is that vertex, and the line is the edge's own
    // direction held a radius / timeHorizonObst off the corner.
    const ell = buildObstacles([
      [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 2 },
        { x: 2, y: 2 },
        { x: 2, y: 4 },
        { x: 0, y: 4 },
      ],
    ])
    expect(ell[3].convex).toBe(false)
    const a = agent({ position: { x: -3, y: 4.5 }, velocity: { x: 1.5, y: 1 } })
    const order = ell
      .map((o, i) => ({ i, d: distanceSq(o.point, a.position) }))
      .sort((p, q) => p.d - q.d || p.i - q.i)
      .map((e) => e.i)
    const lines = buildOrcaLines(a, [], ell, order)
    expect(lines).toHaveLength(1)
    // The edge arriving at the reflex corner runs -x, and the line runs back
    // along it, so the solid stays on the forbidden side.
    expect(lines[0].direction.x).toBeCloseTo(1, 12)
    expect(lines[0].direction.y).toBeCloseTo(0, 12)
    const inv = 1 / a.timeHorizonObst
    const offset = sub(lines[0].point, scale(sub(ell[3].point, a.position), inv))
    expect(length(offset)).toBeCloseTo(a.radius * inv, 12)
    expect(dot(offset, lines[0].direction)).toBeCloseTo(0, 12)
  })

  it('takes the near vertex leg when a face is seen end-on', () => {
    // Beyond the top end of the left face and within a radius of its line, so the
    // top-left vertex alone defines the obstacle -- and unlike the standing case
    // above, this velocity lands on that vertex's left leg rather than its
    // cut-off circle. One vertex, one constraint.
    const a = agent({ position: { x: -1.5, y: 1.25 }, velocity: { x: -0.5, y: 1 } })
    const lines = buildOrcaLines(a, [], block, nearestFirst(-1.5, 1.25))
    expect(lines).toHaveLength(1)
    const toVertex = sub({ x: -1, y: 1 }, a.position)
    const span = length(toVertex)
    const turn = Math.asin(a.radius / span)
    expect(lines[0].direction.x).toBeCloseTo(
      (toVertex.x * Math.cos(turn) - toVertex.y * Math.sin(turn)) / span,
      12,
    )
    expect(lines[0].direction.y).toBeCloseTo(
      (toVertex.x * Math.sin(turn) + toVertex.y * Math.cos(turn)) / span,
      12,
    )
  })

  it('adds nothing beyond the face an agent in a notch is touching', () => {
    // Standing in the L's notch against its tall face. That contact constrains
    // the agent completely, and the edges folding away behind the reflex corner
    // must not smuggle in a second half-plane.
    const ell = buildObstacles([
      [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 2 },
        { x: 2, y: 2 },
        { x: 2, y: 4 },
        { x: 0, y: 4 },
      ],
    ])
    const a = agent({ position: { x: -0.25, y: 3.5 }, velocity: { x: 1, y: 0 } })
    const order = ell
      .map((o, i) => ({ i, d: distanceSq(o.point, a.position) }))
      .sort((p, q) => p.d - q.d || p.i - q.i)
      .map((e) => e.i)
    const lines = buildOrcaLines(a, [], ell, order)
    expect(lines).toHaveLength(1)
    expect(lines[0].point).toEqual({ x: 0, y: 0 })
    expect(lines[0].direction.x).toBeCloseTo(0, 12)
    expect(lines[0].direction.y).toBeCloseTo(1, 12)
  })

  it('keeps an approaching agent outside the block', () => {
    // Walking at the block from 64 bearings: ORCA linearises, so the agent's disc
    // may graze a face, but its centre must never end up inside the solid.
    let deepest = -Infinity
    for (let k = 0; k < 64; k++) {
      const bearing = (k / 64) * Math.PI * 2
      const a = agent({ position: fromAngle(bearing, 4), radius: 0.35 })
      const goal = fromAngle(bearing + Math.PI, 4)
      for (let step = 0; step < 240; step++) {
        const toGoal = sub(goal, a.position)
        const remaining = length(toGoal)
        a.prefVelocity = scale(toGoal, a.maxSpeed / remaining)
        a.velocity = computeNewVelocity(a, [], block, nearestFirst(a.position.x, a.position.y))
        a.position = {
          x: a.position.x + a.velocity.x * 0.05,
          y: a.position.y + a.velocity.y * 0.05,
        }
        const outside = Math.hypot(
          Math.max(Math.abs(a.position.x) - 1, 0),
          Math.max(Math.abs(a.position.y) - 1, 0),
        )
        const depth = outside > 0 ? -outside : Math.min(1 - Math.abs(a.position.x), 1)
        if (depth > deepest) deepest = depth
      }
    }
    expect(deepest).toBeLessThan(0)
  })
})

describe('infeasible constraints', () => {
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

  it('stays optimal across crowds that reintroduce constraints in other orders', () => {
    // One scenario only exercises one relaxation order. These rings are rotated
    // so the fallback meets its constraints in different sequences, which is what
    // pins its running "how far have I already had to give" bookkeeping: drop
    // that and it settles for a measurably worse velocity on some of them.
    for (const [count, ring, spin] of [
      [5, 1.05, 0],
      [6, 1.0, 0.45],
      [8, 1.0, 0.7],
      [8, 0.9, 0.7],
    ] as const) {
      const crowd = Array.from({ length: count }, (_, i) => {
        const offset = fromAngle((i / count) * Math.PI * 2 + spin, ring)
        return agent({ position: offset, velocity: scale(offset, -1.4 / ring) })
      })
      const ringLines = buildOrcaLines(boxedIn, crowd, [], NO_OBSTACLES)
      const best = bestOverDisc(ringLines, boxedIn.maxSpeed)
      // Each case has to be infeasible, or it never reaches the fallback.
      expect(best).toBeGreaterThan(1e-6)
      const velocity = solveOrca(ringLines, boxedIn.maxSpeed, boxedIn.prefVelocity, 0)
      expect(length(velocity)).toBeLessThanOrEqual(boxedIn.maxSpeed + 1e-9)
      expect(worstViolation(ringLines, velocity)).toBeLessThanOrEqual(best + 1e-6)
    }
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
