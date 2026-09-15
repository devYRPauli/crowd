/**
 * Optimal Reciprocal Collision Avoidance (van den Berg et al., 2011), ported
 * from the reference RVO2 implementation.
 *
 * Every neighbour and every nearby obstacle edge contributes one half-plane of
 * velocities that stay safe for the next `timeHorizon` seconds; the agent then
 * takes the velocity inside the intersection of those half-planes that is
 * closest to the one it wanted. In a dense crowd that intersection is regularly
 * empty, so a second, relaxed program (`linearProgram3`) reintroduces the
 * constraints in order of how badly they are violated and returns the "safest
 * possible" velocity instead. Without that fallback agents freeze the moment
 * they are boxed in, so it is not optional.
 *
 * The geometry is written out in scalars rather than through the Vec2 helpers:
 * this runs for every agent against every neighbour on every tick, and each
 * helper call would allocate a temporary.
 */

import type { Vec2 } from '../../core/math/vec2'
import { cross, dot, lengthSq, normalize, sub } from '../../core/math/vec2'

export interface OrcaAgentState {
  position: Vec2
  velocity: Vec2
  radius: number
  maxSpeed: number
  /** Desired velocity this tick. */
  prefVelocity: Vec2
  /** Time window over which collisions with other agents are avoided (s). */
  timeHorizon: number
  /** Time window for static obstacles (s). Usually shorter than timeHorizon. */
  timeHorizonObst: number
  /**
   * Share of the avoidance effort this agent takes: 0.5 is fully reciprocal,
   * 1.0 means this agent does all the work (use for agents avoiding non-reacting ones).
   */
  responsibility: number
}

/** A static obstacle edge. Obstacles form closed CCW loops around solid regions. */
export interface OrcaObstacle {
  point: Vec2
  /** Unit vector from this point to the next obstacle vertex. */
  direction: Vec2
  /** Index into the obstacle array of the next vertex, or -1 if this edge is isolated. */
  nextIndex: number
  /** Index of the previous vertex, or -1. */
  prevIndex: number
  /** True when the vertex is convex, i.e. a CCW-wound solid turns left at it. */
  convex: boolean
}

export interface OrcaLine {
  point: Vec2
  direction: Vec2
}

/** RVO2's RVO_EPSILON: the cutoff for "parallel" and other degenerate tests. */
const EPSILON = 1e-5

/** Guards `1 / timeHorizon` against a caller passing zero or a negative horizon. */
const MIN_TIME_HORIZON = 1e-3

/** An obstacle edge shorter than this has no usable direction and is skipped (m²). */
const MIN_EDGE_LENGTH_SQ = 1e-12

/** Separation below which two agents count as coincident and need a nudge (m). */
const COINCIDENT_DISTANCE = 1e-4

/**
 * RVO2 clears an existing overlap over one simulation step, and this API carries
 * no step length, so assume 60 Hz. Assuming a step shorter than the caller's only
 * makes the escape velocity larger, and that is clamped to maxSpeed anyway, so
 * the practical meaning is "separate as fast as you can".
 */
const COLLISION_TIME_STEP = 1 / 60

const FNV_PRIME = 16777619
const FNV_OFFSET = 2166136261

/** Quantised to millimetres so the hash does not hinge on the last float bit. */
const mix = (hash: number, value: number): number =>
  Math.imul((hash ^ Math.round(value * 1000)) >>> 0, FNV_PRIME) >>> 0

/**
 * Deterministic direction to nudge two coincident agents apart along. They have
 * no relative position to avoid along and RVO2 would divide by zero; hashing the
 * pair keeps the nudge reproducible, which `Math.random` would not. Velocities
 * join the hash only so the two agents of a pair pick opposing nudges whenever
 * anything about them differs.
 */
const perturbationAngle = (a: OrcaAgentState, b: OrcaAgentState): number => {
  let hash = FNV_OFFSET
  hash = mix(hash, a.position.x)
  hash = mix(hash, a.position.y)
  hash = mix(hash, a.velocity.x)
  hash = mix(hash, a.velocity.y)
  hash = mix(hash, b.position.x)
  hash = mix(hash, b.position.y)
  hash = mix(hash, b.velocity.x)
  hash = mix(hash, b.velocity.y)
  return (hash / 4294967296) * Math.PI * 2
}

/** Rounding can push a squared leg length just below zero; a NaN here poisons the tick. */
const safeSqrt = (value: number): number => (value > 0 ? Math.sqrt(value) : 0)

/** Write a line at `index`, reusing the object already there, and return the new count. */
const writeLine = (
  out: OrcaLine[],
  index: number,
  pointX: number,
  pointY: number,
  directionX: number,
  directionY: number,
): number => {
  if (index < out.length) {
    const line = out[index]
    line.point.x = pointX
    line.point.y = pointY
    line.direction.x = directionX
    line.direction.y = directionY
  } else {
    out.push({ point: { x: pointX, y: pointY }, direction: { x: directionX, y: directionY } })
  }
  return index + 1
}

/** `det(line.direction, line.point - v)`: positive when `v` violates the half-plane. */
const violation = (line: OrcaLine, vx: number, vy: number): number =>
  line.direction.x * (line.point.y - vy) - line.direction.y * (line.point.x - vx)

/**
 * Fill `out` with this agent's constraint lines and return how many of them came
 * from obstacles. Obstacle lines are written first because `solveOrca` may never
 * relax them: walls do not negotiate.
 *
 * `obstacleNeighbourIndices` indexes `obstacles`, nearest edge first; each entry
 * is the *start* vertex of an edge. Line objects already in `out` are reused.
 */
export function buildOrcaLinesInto(
  agent: OrcaAgentState,
  neighbours: readonly OrcaAgentState[],
  obstacles: readonly OrcaObstacle[],
  obstacleNeighbourIndices: readonly number[],
  out: OrcaLine[],
): number {
  const posX = agent.position.x
  const posY = agent.position.y
  const velX = agent.velocity.x
  const velY = agent.velocity.y
  const radius = agent.radius
  const radiusSq = radius * radius
  const invHorizonObst = 1 / Math.max(agent.timeHorizonObst, MIN_TIME_HORIZON)
  let count = 0

  for (let n = 0; n < obstacleNeighbourIndices.length; n++) {
    const index = obstacleNeighbourIndices[n]
    if (index < 0 || index >= obstacles.length) continue
    let obstacle1 = obstacles[index]
    if (obstacle1.nextIndex < 0 || obstacle1.nextIndex >= obstacles.length) continue
    let obstacle2 = obstacles[obstacle1.nextIndex]

    let rel1X = obstacle1.point.x - posX
    let rel1Y = obstacle1.point.y - posY
    let rel2X = obstacle2.point.x - posX
    let rel2Y = obstacle2.point.y - posY

    // Skip the edge when an earlier obstacle line already forbids its velocities.
    let alreadyCovered = false
    for (let j = 0; j < count; j++) {
      const line = out[j]
      const dx = line.direction.x
      const dy = line.direction.y
      const d1 = (rel1X * invHorizonObst - line.point.x) * dy - (rel1Y * invHorizonObst - line.point.y) * dx
      if (d1 - invHorizonObst * radius < -EPSILON) continue
      const d2 = (rel2X * invHorizonObst - line.point.x) * dy - (rel2Y * invHorizonObst - line.point.y) * dx
      if (d2 - invHorizonObst * radius >= -EPSILON) {
        alreadyCovered = true
        break
      }
    }
    if (alreadyCovered) continue

    let distSq1 = rel1X * rel1X + rel1Y * rel1Y
    let distSq2 = rel2X * rel2X + rel2Y * rel2Y

    const edgeX = obstacle2.point.x - obstacle1.point.x
    const edgeY = obstacle2.point.y - obstacle1.point.y
    const edgeLengthSq = edgeX * edgeX + edgeY * edgeY
    if (edgeLengthSq < MIN_EDGE_LENGTH_SQ) continue

    // Where the agent projects onto the edge, and how far it sits off that line.
    const s = (-rel1X * edgeX - rel1Y * edgeY) / edgeLengthSq
    const offX = -rel1X - s * edgeX
    const offY = -rel1Y - s * edgeY
    const distSqLine = offX * offX + offY * offY

    if (s < 0 && distSq1 <= radiusSq) {
      // Already touching the left vertex; a non-convex one is covered by its neighbours.
      if (obstacle1.convex && distSq1 > MIN_EDGE_LENGTH_SQ) {
        const inv = 1 / Math.sqrt(distSq1)
        count = writeLine(out, count, 0, 0, -rel1Y * inv, rel1X * inv)
      }
      continue
    }

    if (s > 1 && distSq2 <= radiusSq) {
      // Touching the right vertex; the next edge handles it when it faces away.
      const facing = rel2X * obstacle2.direction.y - rel2Y * obstacle2.direction.x
      if (obstacle2.convex && facing >= 0 && distSq2 > MIN_EDGE_LENGTH_SQ) {
        const inv = 1 / Math.sqrt(distSq2)
        count = writeLine(out, count, 0, 0, -rel2Y * inv, rel2X * inv)
      }
      continue
    }

    if (s >= 0 && s < 1 && distSqLine <= radiusSq) {
      // Touching the edge itself: only velocities heading away from the solid remain.
      count = writeLine(out, count, 0, 0, -obstacle1.direction.x, -obstacle1.direction.y)
      continue
    }

    // No contact. Build the legs of the velocity obstacle. Seen obliquely enough,
    // one vertex defines both legs; a non-convex vertex extends the cut-off line.
    let leftLegX: number
    let leftLegY: number
    let rightLegX: number
    let rightLegY: number
    let singleVertex = false

    if (s < 0 && distSqLine <= radiusSq) {
      if (!obstacle1.convex) continue
      obstacle2 = obstacle1
      rel2X = rel1X
      rel2Y = rel1Y
      distSq2 = distSq1
      singleVertex = true
      const leg = safeSqrt(distSq1 - radiusSq)
      leftLegX = (rel1X * leg - rel1Y * radius) / distSq1
      leftLegY = (rel1X * radius + rel1Y * leg) / distSq1
      rightLegX = (rel1X * leg + rel1Y * radius) / distSq1
      rightLegY = (-rel1X * radius + rel1Y * leg) / distSq1
    } else if (s > 1 && distSqLine <= radiusSq) {
      if (!obstacle2.convex) continue
      obstacle1 = obstacle2
      rel1X = rel2X
      rel1Y = rel2Y
      distSq1 = distSq2
      singleVertex = true
      const leg = safeSqrt(distSq2 - radiusSq)
      leftLegX = (rel2X * leg - rel2Y * radius) / distSq2
      leftLegY = (rel2X * radius + rel2Y * leg) / distSq2
      rightLegX = (rel2X * leg + rel2Y * radius) / distSq2
      rightLegY = (-rel2X * radius + rel2Y * leg) / distSq2
    } else {
      if (obstacle1.convex) {
        const leg = safeSqrt(distSq1 - radiusSq)
        leftLegX = (rel1X * leg - rel1Y * radius) / distSq1
        leftLegY = (rel1X * radius + rel1Y * leg) / distSq1
      } else {
        leftLegX = -obstacle1.direction.x
        leftLegY = -obstacle1.direction.y
      }
      if (obstacle2.convex) {
        const leg = safeSqrt(distSq2 - radiusSq)
        rightLegX = (rel2X * leg + rel2Y * radius) / distSq2
        rightLegY = (-rel2X * radius + rel2Y * leg) / distSq2
      } else {
        rightLegX = obstacle1.direction.x
        rightLegY = obstacle1.direction.y
      }
    }

    // A leg that points into the neighbouring edge belongs to that edge, not this
    // one: borrow its cut-off direction, and add no constraint if the velocity
    // ends up projected onto the borrowed leg.
    const prevIndex = obstacle1.prevIndex
    const leftNeighbour =
      prevIndex >= 0 && prevIndex < obstacles.length ? obstacles[prevIndex] : null
    let leftLegForeign = false
    let rightLegForeign = false

    if (obstacle1.convex && leftNeighbour !== null) {
      const nx = -leftNeighbour.direction.x
      const ny = -leftNeighbour.direction.y
      if (leftLegX * ny - leftLegY * nx >= 0) {
        leftLegX = nx
        leftLegY = ny
        leftLegForeign = true
      }
    }

    if (obstacle2.convex) {
      const nx = obstacle2.direction.x
      const ny = obstacle2.direction.y
      if (rightLegX * ny - rightLegY * nx <= 0) {
        rightLegX = nx
        rightLegY = ny
        rightLegForeign = true
      }
    }

    const leftCutX = rel1X * invHorizonObst
    const leftCutY = rel1Y * invHorizonObst
    const rightCutX = rel2X * invHorizonObst
    const rightCutY = rel2Y * invHorizonObst
    const cutX = rightCutX - leftCutX
    const cutY = rightCutY - leftCutY

    const fromLeftX = velX - leftCutX
    const fromLeftY = velY - leftCutY
    const fromRightX = velX - rightCutX
    const fromRightY = velY - rightCutY

    const cutLengthSq = cutX * cutX + cutY * cutY
    const t =
      singleVertex || cutLengthSq < MIN_EDGE_LENGTH_SQ
        ? 0.5
        : (fromLeftX * cutX + fromLeftY * cutY) / cutLengthSq
    const tLeft = fromLeftX * leftLegX + fromLeftY * leftLegY
    const tRight = fromRightX * rightLegX + fromRightY * rightLegY

    if ((t < 0 && tLeft < 0) || (singleVertex && tLeft < 0 && tRight < 0)) {
      const wLength = Math.hypot(fromLeftX, fromLeftY)
      if (wLength > EPSILON) {
        const unitWx = fromLeftX / wLength
        const unitWy = fromLeftY / wLength
        const offset = radius * invHorizonObst
        count = writeLine(
          out,
          count,
          leftCutX + offset * unitWx,
          leftCutY + offset * unitWy,
          unitWy,
          -unitWx,
        )
      }
      continue
    }

    if (t > 1 && tRight < 0) {
      const wLength = Math.hypot(fromRightX, fromRightY)
      if (wLength > EPSILON) {
        const unitWx = fromRightX / wLength
        const unitWy = fromRightY / wLength
        const offset = radius * invHorizonObst
        count = writeLine(
          out,
          count,
          rightCutX + offset * unitWx,
          rightCutY + offset * unitWy,
          unitWy,
          -unitWx,
        )
      }
      continue
    }

    // Take whichever of the cut-off line and the two legs the velocity is nearest.
    let distSqCutoff = Infinity
    if (t >= 0 && t <= 1 && !singleVertex) {
      const dx = fromLeftX - t * cutX
      const dy = fromLeftY - t * cutY
      distSqCutoff = dx * dx + dy * dy
    }
    let distSqLeft = Infinity
    if (tLeft >= 0) {
      const dx = fromLeftX - tLeft * leftLegX
      const dy = fromLeftY - tLeft * leftLegY
      distSqLeft = dx * dx + dy * dy
    }
    let distSqRight = Infinity
    if (tRight >= 0) {
      const dx = fromRightX - tRight * rightLegX
      const dy = fromRightY - tRight * rightLegY
      distSqRight = dx * dx + dy * dy
    }

    const offset = radius * invHorizonObst
    if (distSqCutoff <= distSqLeft && distSqCutoff <= distSqRight) {
      const dx = -obstacle1.direction.x
      const dy = -obstacle1.direction.y
      count = writeLine(out, count, leftCutX - offset * dy, leftCutY + offset * dx, dx, dy)
    } else if (distSqLeft <= distSqRight) {
      if (leftLegForeign) continue
      count = writeLine(
        out,
        count,
        leftCutX - offset * leftLegY,
        leftCutY + offset * leftLegX,
        leftLegX,
        leftLegY,
      )
    } else {
      if (rightLegForeign) continue
      const dx = -rightLegX
      const dy = -rightLegY
      count = writeLine(out, count, rightCutX - offset * dy, rightCutY + offset * dx, dx, dy)
    }
  }

  const obstacleLineCount = count
  const invHorizon = 1 / Math.max(agent.timeHorizon, MIN_TIME_HORIZON)
  const invCollisionStep = 1 / COLLISION_TIME_STEP
  const responsibility = agent.responsibility

  for (let i = 0; i < neighbours.length; i++) {
    const other = neighbours[i]
    if (other === agent) continue

    let relX = other.position.x - posX
    let relY = other.position.y - posY
    let distSq = relX * relX + relY * relY
    const relVelX = velX - other.velocity.x
    const relVelY = velY - other.velocity.y
    const combined = radius + other.radius
    const combinedSq = combined * combined

    if (distSq < COINCIDENT_DISTANCE * COINCIDENT_DISTANCE) {
      const angle = perturbationAngle(agent, other)
      relX = Math.cos(angle) * COINCIDENT_DISTANCE
      relY = Math.sin(angle) * COINCIDENT_DISTANCE
      distSq = COINCIDENT_DISTANCE * COINCIDENT_DISTANCE
    }

    // `u` is the shortest change to the relative velocity that clears the
    // velocity obstacle; the pair splits it according to `responsibility`.
    let directionX: number
    let directionY: number
    let uX: number
    let uY: number

    if (distSq > combinedSq) {
      // Vector from the cut-off circle's centre to the relative velocity.
      const wX = relVelX - invHorizon * relX
      const wY = relVelY - invHorizon * relY
      const wLengthSq = wX * wX + wY * wY
      const wDotRel = wX * relX + wY * relY

      if (wDotRel < 0 && wDotRel * wDotRel > combinedSq * wLengthSq) {
        // In front of the cut-off circle: project onto it.
        const wLength = Math.sqrt(wLengthSq)
        const unitWx = wX / wLength
        const unitWy = wY / wLength
        directionX = unitWy
        directionY = -unitWx
        const scale = combined * invHorizon - wLength
        uX = scale * unitWx
        uY = scale * unitWy
      } else {
        // Beside the circle: project onto the nearer leg of the cone.
        const leg = safeSqrt(distSq - combinedSq)
        if (relX * wY - relY * wX > 0) {
          directionX = (relX * leg - relY * combined) / distSq
          directionY = (relX * combined + relY * leg) / distSq
        } else {
          directionX = -(relX * leg + relY * combined) / distSq
          directionY = -(-relX * combined + relY * leg) / distSq
        }
        const along = relVelX * directionX + relVelY * directionY
        uX = along * directionX - relVelX
        uY = along * directionY - relVelY
      }
    } else {
      // Already overlapping: clear the overlap inside one step instead of one horizon.
      const wX = relVelX - invCollisionStep * relX
      const wY = relVelY - invCollisionStep * relY
      let wLength = Math.hypot(wX, wY)
      let unitWx: number
      let unitWy: number
      if (wLength > EPSILON) {
        unitWx = wX / wLength
        unitWy = wY / wLength
      } else {
        // Relative velocity sits exactly on the centre: push straight apart.
        const inv = 1 / Math.sqrt(distSq)
        unitWx = -relX * inv
        unitWy = -relY * inv
        wLength = 0
      }
      directionX = unitWy
      directionY = -unitWx
      const scale = combined * invCollisionStep - wLength
      uX = scale * unitWx
      uY = scale * unitWy
    }

    count = writeLine(
      out,
      count,
      velX + responsibility * uX,
      velY + responsibility * uY,
      directionX,
      directionY,
    )
  }

  out.length = count
  return obstacleLineCount
}

/** Build the ORCA half-plane constraints for one agent. */
export function buildOrcaLines(
  agent: OrcaAgentState,
  neighbours: readonly OrcaAgentState[],
  obstacles: readonly OrcaObstacle[],
  obstacleNeighbourIndices: readonly number[],
  out?: OrcaLine[],
): OrcaLine[] {
  const lines = out ?? []
  buildOrcaLinesInto(agent, neighbours, obstacles, obstacleNeighbourIndices, lines)
  return lines
}
