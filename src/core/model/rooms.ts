/**
 * Room detection.
 *
 * Users draw walls, not rooms — but a floor plan only reads as a floor plan
 * once the enclosed spaces are filled and labelled with their area. We recover
 * those spaces by treating the wall centrelines as a planar graph and
 * extracting its bounded faces: split every wall at its crossings, sort the
 * half-edges around each node, and walk each face by always taking the next
 * edge clockwise from the one we came back along. Dangling walls are traversed
 * in both directions and collapse to zero area, so they fall out naturally.
 */

import type { Vec2 } from '../math/vec2'
import type { Polygon } from '../math/geometry'
import { polygonArea, polygonCentroid, signedArea } from '../math/geometry'
import type { Wall } from './types'

export interface Room {
  id: string
  polygon: Polygon
  area: number
  center: Vec2
  /** Ids of the walls that bound the room. */
  wallIds: string[]
}

const SNAP = 1e-3

const keyOf = (p: Vec2): string =>
  `${Math.round(p.x / SNAP) * SNAP},${Math.round(p.y / SNAP) * SNAP}`

interface Node {
  point: Vec2
  edges: number[]
}

interface HalfEdge {
  from: string
  to: string
  angle: number
  wallId: string
  twin: number
  visited: boolean
}

/** Split a set of segments wherever they cross or touch. */
const splitSegments = (
  segments: Array<{ a: Vec2; b: Vec2; wallId: string }>,
): Array<{ a: Vec2; b: Vec2; wallId: string }> => {
  const out: Array<{ a: Vec2; b: Vec2; wallId: string }> = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const dx = seg.b.x - seg.a.x
    const dy = seg.b.y - seg.a.y
    const lenSq = dx * dx + dy * dy
    if (lenSq < SNAP * SNAP) continue
    const cuts: number[] = [0, 1]
    for (let j = 0; j < segments.length; j++) {
      if (i === j) continue
      const other = segments[j]
      const ox = other.b.x - other.a.x
      const oy = other.b.y - other.a.y
      const denom = dx * oy - dy * ox
      if (Math.abs(denom) > 1e-9) {
        const t = ((other.a.x - seg.a.x) * oy - (other.a.y - seg.a.y) * ox) / denom
        const u = ((other.a.x - seg.a.x) * dy - (other.a.y - seg.a.y) * dx) / denom
        if (t > 1e-6 && t < 1 - 1e-6 && u > -1e-6 && u < 1 + 1e-6) cuts.push(t)
      }
      // A T-junction: the other segment's endpoint lands on this one.
      for (const p of [other.a, other.b]) {
        const t = ((p.x - seg.a.x) * dx + (p.y - seg.a.y) * dy) / lenSq
        if (t <= 1e-6 || t >= 1 - 1e-6) continue
        const px = seg.a.x + dx * t
        const py = seg.a.y + dy * t
        if (Math.hypot(px - p.x, py - p.y) < 0.02) cuts.push(t)
      }
    }
    cuts.sort((m, n) => m - n)
    for (let k = 1; k < cuts.length; k++) {
      const t0 = cuts[k - 1]
      const t1 = cuts[k]
      if (t1 - t0 < 1e-5) continue
      out.push({
        a: { x: seg.a.x + dx * t0, y: seg.a.y + dy * t0 },
        b: { x: seg.a.x + dx * t1, y: seg.a.y + dy * t1 },
        wallId: seg.wallId,
      })
    }
  }
  return out
}

/** Extract the enclosed rooms bounded by the given walls. */
export const detectRooms = (walls: readonly Wall[], minArea = 0.5): Room[] => {
  if (walls.length < 3) return []
  const pieces = splitSegments(walls.map((w) => ({ a: w.a, b: w.b, wallId: w.id })))
  if (pieces.length < 3) return []

  const nodes = new Map<string, Node>()
  const halfEdges: HalfEdge[] = []
  const nodeFor = (p: Vec2): string => {
    const key = keyOf(p)
    if (!nodes.has(key)) nodes.set(key, { point: { x: p.x, y: p.y }, edges: [] })
    return key
  }

  const seen = new Set<string>()
  for (const piece of pieces) {
    const from = nodeFor(piece.a)
    const to = nodeFor(piece.b)
    if (from === to) continue
    const dedupe = from < to ? `${from}|${to}` : `${to}|${from}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)

    const a = nodes.get(from)!
    const b = nodes.get(to)!
    const forward = halfEdges.length
    const backward = forward + 1
    halfEdges.push({
      from,
      to,
      angle: Math.atan2(b.point.y - a.point.y, b.point.x - a.point.x),
      wallId: piece.wallId,
      twin: backward,
      visited: false,
    })
    halfEdges.push({
      from: to,
      to: from,
      angle: Math.atan2(a.point.y - b.point.y, a.point.x - b.point.x),
      wallId: piece.wallId,
      twin: forward,
      visited: false,
    })
    a.edges.push(forward)
    b.edges.push(backward)
  }

  for (const node of nodes.values()) {
    node.edges.sort((m, n) => halfEdges[m].angle - halfEdges[n].angle)
  }

  const rooms: Room[] = []
  for (let start = 0; start < halfEdges.length; start++) {
    if (halfEdges[start].visited) continue
    const polygon: Vec2[] = []
    const wallIds = new Set<string>()
    let current = start
    let guard = 0
    while (!halfEdges[current].visited && guard++ < halfEdges.length * 2) {
      const edge = halfEdges[current]
      edge.visited = true
      wallIds.add(edge.wallId)
      polygon.push({ ...nodes.get(edge.from)!.point })
      // Arrive at `to`, then take the edge clockwise from the way we came.
      const arrival = halfEdges[edge.twin]
      const node = nodes.get(edge.to)!
      const index = node.edges.indexOf(edge.twin)
      if (index < 0) break
      current = node.edges[(index - 1 + node.edges.length) % node.edges.length]
      void arrival
      if (current === start) break
    }
    if (polygon.length < 3) continue
    // Interior faces come out counter-clockwise; the unbounded face does not.
    if (signedArea(polygon) <= 0) continue
    const area = polygonArea(polygon)
    if (area < minArea) continue
    rooms.push({
      id: `room_${rooms.length}`,
      polygon,
      area,
      center: polygonCentroid(polygon),
      wallIds: [...wallIds],
    })
  }
  return rooms
}
