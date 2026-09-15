// Straight transliteration of RVO2 (Agent.cpp) — written independently of the port
// under review, to diff against it. Vectors are [x,y] arrays.
const EPS = 1e-5
const det = (a, b) => a[0] * b[1] - a[1] * b[0]
const absSq = (a) => a[0] * a[0] + a[1] * a[1]
const abs_ = (a) => Math.sqrt(absSq(a))
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]]
const addv = (a, b) => [a[0] + b[0], a[1] + b[1]]
const mul = (a, k) => [a[0] * k, a[1] * k]
const dotv = (a, b) => a[0] * b[0] + a[1] * b[1]
const norm = (a) => mul(a, 1 / abs_(a))

function linearProgram1(lines, lineNo, radius, optVelocity, directionOpt, result) {
  const dotProduct = dotv(lines[lineNo].point, lines[lineNo].direction)
  const discriminant = dotProduct * dotProduct + radius * radius - absSq(lines[lineNo].point)
  if (discriminant < 0) return false
  const sq = Math.sqrt(discriminant)
  let tLeft = -dotProduct - sq
  let tRight = -dotProduct + sq
  for (let i = 0; i < lineNo; ++i) {
    const denominator = det(lines[lineNo].direction, lines[i].direction)
    const numerator = det(lines[i].direction, sub(lines[lineNo].point, lines[i].point))
    if (Math.abs(denominator) <= EPS) {
      if (numerator < 0) return false
      continue
    }
    const t = numerator / denominator
    if (denominator >= 0) tRight = Math.min(tRight, t)
    else tLeft = Math.max(tLeft, t)
    if (tLeft > tRight) return false
  }
  if (directionOpt) {
    const t = dotv(optVelocity, lines[lineNo].direction) > 0 ? tRight : tLeft
    const r = addv(lines[lineNo].point, mul(lines[lineNo].direction, t))
    result[0] = r[0]; result[1] = r[1]
  } else {
    let t = dotv(lines[lineNo].direction, sub(optVelocity, lines[lineNo].point))
    if (t < tLeft) t = tLeft
    else if (t > tRight) t = tRight
    const r = addv(lines[lineNo].point, mul(lines[lineNo].direction, t))
    result[0] = r[0]; result[1] = r[1]
  }
  return true
}

function linearProgram2(lines, radius, optVelocity, directionOpt, result) {
  if (directionOpt) { const r = mul(optVelocity, radius); result[0] = r[0]; result[1] = r[1] }
  else if (absSq(optVelocity) > radius * radius) { const r = mul(norm(optVelocity), radius); result[0] = r[0]; result[1] = r[1] }
  else { result[0] = optVelocity[0]; result[1] = optVelocity[1] }
  for (let i = 0; i < lines.length; ++i) {
    if (det(lines[i].direction, sub(lines[i].point, result)) > 0) {
      const temp = [result[0], result[1]]
      if (!linearProgram1(lines, i, radius, optVelocity, directionOpt, result)) {
        result[0] = temp[0]; result[1] = temp[1]
        return i
      }
    }
  }
  return lines.length
}

function linearProgram3(lines, numObstLines, beginLine, radius, result) {
  let distance = 0
  for (let i = beginLine; i < lines.length; ++i) {
    if (det(lines[i].direction, sub(lines[i].point, result)) > distance) {
      const projLines = lines.slice(0, numObstLines).map((l) => ({ point: l.point, direction: l.direction }))
      for (let j = numObstLines; j < i; ++j) {
        const line = { point: null, direction: null }
        const determinant = det(lines[i].direction, lines[j].direction)
        if (Math.abs(determinant) <= EPS) {
          if (dotv(lines[i].direction, lines[j].direction) > 0) continue
          line.point = mul(addv(lines[i].point, lines[j].point), 0.5)
        } else {
          line.point = addv(lines[i].point, mul(lines[i].direction, det(lines[j].direction, sub(lines[i].point, lines[j].point)) / determinant))
        }
        line.direction = norm(sub(lines[j].direction, lines[i].direction))
        projLines.push(line)
      }
      const temp = [result[0], result[1]]
      if (linearProgram2(projLines, radius, [-lines[i].direction[1], lines[i].direction[0]], true, result) < projLines.length) {
        result[0] = temp[0]; result[1] = temp[1]
      }
      distance = det(lines[i].direction, sub(lines[i].point, result))
    }
  }
}

// agent: {position, velocity, radius, maxSpeed, prefVelocity, timeHorizon, timeHorizonObst}
// obstacleNeighbors: array of obstacle objects {point, unitDir, isConvex, next, prev}
export function computeNewVelocityRef(agent, agentNeighbors, obstacleNeighbors, timeStep) {
  const orcaLines = []
  const invTimeHorizonObst = 1 / agent.timeHorizonObst
  const position_ = agent.position
  const velocity_ = agent.velocity
  const radius_ = agent.radius

  for (let i = 0; i < obstacleNeighbors.length; ++i) {
    let obstacle1 = obstacleNeighbors[i]
    let obstacle2 = obstacle1.next
    const relativePosition1 = sub(obstacle1.point, position_)
    const relativePosition2 = sub(obstacle2.point, position_)

    let alreadyCovered = false
    for (let j = 0; j < orcaLines.length; ++j) {
      if (
        det(sub(mul(relativePosition1, invTimeHorizonObst), orcaLines[j].point), orcaLines[j].direction) - invTimeHorizonObst * radius_ >= -EPS &&
        det(sub(mul(relativePosition2, invTimeHorizonObst), orcaLines[j].point), orcaLines[j].direction) - invTimeHorizonObst * radius_ >= -EPS
      ) { alreadyCovered = true; break }
    }
    if (alreadyCovered) continue

    const distSq1 = absSq(relativePosition1)
    const distSq2 = absSq(relativePosition2)
    const radiusSq = radius_ * radius_
    const obstacleVector = sub(obstacle2.point, obstacle1.point)
    const s = dotv(mul(relativePosition1, -1), obstacleVector) / absSq(obstacleVector)
    const distSqLine = absSq(sub(mul(relativePosition1, -1), mul(obstacleVector, s)))

    const line = { point: null, direction: null }

    if (s < 0 && distSq1 <= radiusSq) {
      if (obstacle1.isConvex) {
        line.point = [0, 0]
        line.direction = norm([-relativePosition1[1], relativePosition1[0]])
        orcaLines.push(line)
      }
      continue
    } else if (s > 1 && distSq2 <= radiusSq) {
      if (obstacle2.isConvex && det(relativePosition2, obstacle2.unitDir) >= 0) {
        line.point = [0, 0]
        line.direction = norm([-relativePosition2[1], relativePosition2[0]])
        orcaLines.push(line)
      }
      continue
    } else if (s >= 0 && s < 1 && distSqLine <= radiusSq) {
      line.point = [0, 0]
      line.direction = mul(obstacle1.unitDir, -1)
      orcaLines.push(line)
      continue
    }

    let leftLegDirection, rightLegDirection

    if (s < 0 && distSqLine <= radiusSq) {
      if (!obstacle1.isConvex) continue
      obstacle2 = obstacle1
      const leg1 = Math.sqrt(distSq1 - radiusSq)
      leftLegDirection = mul([relativePosition1[0] * leg1 - relativePosition1[1] * radius_, relativePosition1[0] * radius_ + relativePosition1[1] * leg1], 1 / distSq1)
      rightLegDirection = mul([relativePosition1[0] * leg1 + relativePosition1[1] * radius_, -relativePosition1[0] * radius_ + relativePosition1[1] * leg1], 1 / distSq1)
    } else if (s > 1 && distSqLine <= radiusSq) {
      if (!obstacle2.isConvex) continue
      obstacle1 = obstacle2
      const leg2 = Math.sqrt(distSq2 - radiusSq)
      leftLegDirection = mul([relativePosition2[0] * leg2 - relativePosition2[1] * radius_, relativePosition2[0] * radius_ + relativePosition2[1] * leg2], 1 / distSq2)
      rightLegDirection = mul([relativePosition2[0] * leg2 + relativePosition2[1] * radius_, -relativePosition2[0] * radius_ + relativePosition2[1] * leg2], 1 / distSq2)
    } else {
      if (obstacle1.isConvex) {
        const leg1 = Math.sqrt(distSq1 - radiusSq)
        leftLegDirection = mul([relativePosition1[0] * leg1 - relativePosition1[1] * radius_, relativePosition1[0] * radius_ + relativePosition1[1] * leg1], 1 / distSq1)
      } else {
        leftLegDirection = mul(obstacle1.unitDir, -1)
      }
      if (obstacle2.isConvex) {
        const leg2 = Math.sqrt(distSq2 - radiusSq)
        rightLegDirection = mul([relativePosition2[0] * leg2 + relativePosition2[1] * radius_, -relativePosition2[0] * radius_ + relativePosition2[1] * leg2], 1 / distSq2)
      } else {
        rightLegDirection = obstacle1.unitDir
      }
    }

    const leftNeighbor = obstacle1.prev
    let isLeftLegForeign = false
    let isRightLegForeign = false

    if (obstacle1.isConvex && det(leftLegDirection, mul(leftNeighbor.unitDir, -1)) >= 0) {
      leftLegDirection = mul(leftNeighbor.unitDir, -1)
      isLeftLegForeign = true
    }
    if (obstacle2.isConvex && det(rightLegDirection, obstacle2.unitDir) <= 0) {
      rightLegDirection = obstacle2.unitDir
      isRightLegForeign = true
    }

    const leftCutoff = mul(sub(obstacle1.point, position_), invTimeHorizonObst)
    const rightCutoff = mul(sub(obstacle2.point, position_), invTimeHorizonObst)
    const cutoffVec = sub(rightCutoff, leftCutoff)

    const t = obstacle1 === obstacle2 ? 0.5 : dotv(sub(velocity_, leftCutoff), cutoffVec) / absSq(cutoffVec)
    const tLeft = dotv(sub(velocity_, leftCutoff), leftLegDirection)
    const tRight = dotv(sub(velocity_, rightCutoff), rightLegDirection)

    if ((t < 0 && tLeft < 0) || (obstacle1 === obstacle2 && tLeft < 0 && tRight < 0)) {
      const unitW = norm(sub(velocity_, leftCutoff))
      line.direction = [unitW[1], -unitW[0]]
      line.point = addv(leftCutoff, mul(unitW, radius_ * invTimeHorizonObst))
      orcaLines.push(line)
      continue
    } else if (t > 1 && tRight < 0) {
      const unitW = norm(sub(velocity_, rightCutoff))
      line.direction = [unitW[1], -unitW[0]]
      line.point = addv(rightCutoff, mul(unitW, radius_ * invTimeHorizonObst))
      orcaLines.push(line)
      continue
    }

    const distSqCutoff = t < 0 || t > 1 || obstacle1 === obstacle2 ? Infinity : absSq(sub(velocity_, addv(leftCutoff, mul(cutoffVec, t))))
    const distSqLeft = tLeft < 0 ? Infinity : absSq(sub(velocity_, addv(leftCutoff, mul(leftLegDirection, tLeft))))
    const distSqRight = tRight < 0 ? Infinity : absSq(sub(velocity_, addv(rightCutoff, mul(rightLegDirection, tRight))))

    if (distSqCutoff <= distSqLeft && distSqCutoff <= distSqRight) {
      line.direction = mul(obstacle1.unitDir, -1)
      line.point = addv(leftCutoff, mul([-line.direction[1], line.direction[0]], radius_ * invTimeHorizonObst))
      orcaLines.push(line)
      continue
    } else if (distSqLeft <= distSqRight) {
      if (isLeftLegForeign) continue
      line.direction = leftLegDirection
      line.point = addv(leftCutoff, mul([-line.direction[1], line.direction[0]], radius_ * invTimeHorizonObst))
      orcaLines.push(line)
      continue
    } else {
      if (isRightLegForeign) continue
      line.direction = mul(rightLegDirection, -1)
      line.point = addv(rightCutoff, mul([-line.direction[1], line.direction[0]], radius_ * invTimeHorizonObst))
      orcaLines.push(line)
      continue
    }
  }

  const numObstLines = orcaLines.length
  const invTimeHorizon = 1 / agent.timeHorizon

  for (let i = 0; i < agentNeighbors.length; ++i) {
    const other = agentNeighbors[i]
    const relativePosition = sub(other.position, position_)
    const relativeVelocity = sub(velocity_, other.velocity)
    const distSq = absSq(relativePosition)
    const combinedRadius = radius_ + other.radius
    const combinedRadiusSq = combinedRadius * combinedRadius
    const line = { point: null, direction: null }
    let u

    if (distSq > combinedRadiusSq) {
      const w = sub(relativeVelocity, mul(relativePosition, invTimeHorizon))
      const wLengthSq = absSq(w)
      const dotProduct1 = dotv(w, relativePosition)
      if (dotProduct1 < 0 && dotProduct1 * dotProduct1 > combinedRadiusSq * wLengthSq) {
        const wLength = Math.sqrt(wLengthSq)
        const unitW = mul(w, 1 / wLength)
        line.direction = [unitW[1], -unitW[0]]
        u = mul(unitW, combinedRadius * invTimeHorizon - wLength)
      } else {
        const leg = Math.sqrt(distSq - combinedRadiusSq)
        if (det(relativePosition, w) > 0) {
          line.direction = mul([relativePosition[0] * leg - relativePosition[1] * combinedRadius, relativePosition[0] * combinedRadius + relativePosition[1] * leg], 1 / distSq)
        } else {
          line.direction = mul(mul([relativePosition[0] * leg + relativePosition[1] * combinedRadius, -relativePosition[0] * combinedRadius + relativePosition[1] * leg], 1 / distSq), -1)
        }
        const dotProduct2 = dotv(relativeVelocity, line.direction)
        u = sub(mul(line.direction, dotProduct2), relativeVelocity)
      }
    } else {
      const invTimeStep = 1 / timeStep
      const w = sub(relativeVelocity, mul(relativePosition, invTimeStep))
      const wLength = abs_(w)
      const unitW = mul(w, 1 / wLength)
      line.direction = [unitW[1], -unitW[0]]
      u = mul(unitW, combinedRadius * invTimeStep - wLength)
    }

    line.point = addv(velocity_, mul(u, 0.5))
    orcaLines.push(line)
  }

  const newVelocity = [0, 0]
  const lineFail = linearProgram2(orcaLines, agent.maxSpeed, agent.prefVelocity, false, newVelocity)
  if (lineFail < orcaLines.length) {
    linearProgram3(orcaLines, numObstLines, lineFail, agent.maxSpeed, newVelocity)
  }
  return { velocity: newVelocity, lines: orcaLines, numObstLines }
}
