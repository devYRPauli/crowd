import { describe, expect, it } from 'vitest'
import { Box3, Color, Vector3, type BufferGeometry } from 'three'
import {
  HAIR_COLORS,
  LEG_COLORS,
  LIMB,
  PIVOTS,
  SKIN_TONES,
  ZONE,
  buildCharacterGeometry,
} from './character'

const full = buildCharacterGeometry('full')
const simple = buildCharacterGeometry('simple')

const vertices = (geometry: BufferGeometry): Vector3[] => {
  const position = geometry.getAttribute('position')
  return Array.from({ length: position.count }, (_, i) =>
    new Vector3().fromBufferAttribute(position, i),
  )
}

const valuesOf = (geometry: BufferGeometry, name: 'aLimb' | 'aZone'): number[] => {
  const attribute = geometry.getAttribute(name)
  return Array.from({ length: attribute.count }, (_, i) => attribute.getX(i))
}

/** The vertices belonging to one limb, or one material zone. */
const partOf = (geometry: BufferGeometry, name: 'aLimb' | 'aZone', value: number): Vector3[] => {
  const tags = valuesOf(geometry, name)
  return vertices(geometry).filter((_, i) => tags[i] === value)
}

/** Every vertex with the two tags the shader will read off it. */
const tagged = (
  geometry: BufferGeometry,
): Array<{ point: Vector3; limb: number; zone: number }> => {
  const limbs = valuesOf(geometry, 'aLimb')
  const zones = valuesOf(geometry, 'aZone')
  return vertices(geometry).map((point, i) => ({ point, limb: limbs[i], zone: zones[i] }))
}

const boxOf = (points: Vector3[]): Box3 => new Box3().setFromPoints(points)

describe('the character mesh', () => {
  it('is a 1.75 m person standing on the floor', () => {
    const box = boxOf(vertices(full))
    expect(box.min.y).toBeCloseTo(0, 6)
    expect(box.max.y).toBeCloseTo(1.75, 6)
    // Shoulder to shoulder, which is what has to fit through a 0.8 m door.
    expect(box.max.x - box.min.x).toBeCloseTo(0.5, 6)
    expect(box.max.z - box.min.z).toBeCloseTo(0.23, 6)
  })

  it('tags every vertex with the limb and the zone the shader reads', () => {
    const count = full.getAttribute('position').count
    expect(full.getAttribute('aLimb').count).toBe(count)
    expect(full.getAttribute('aZone').count).toBe(count)
    // A vertex with no limb would pose as the body and tear away from its arm.
    expect(new Set(valuesOf(full, 'aLimb'))).toEqual(new Set(Object.values(LIMB)))
    expect(new Set(valuesOf(full, 'aZone'))).toEqual(new Set(Object.values(ZONE)))
  })

  it('hangs every limb below the joint it turns about', () => {
    // The shader rotates a limb about its pivot. A vertex above the joint
    // swings the wrong way and pulls the body apart at speed.
    for (const limb of [LIMB.armLeft, LIMB.armRight, LIMB.thighLeft, LIMB.thighRight]) {
      const box = boxOf(partOf(full, 'aLimb', limb))
      expect(box.max.y).toBeLessThanOrEqual(PIVOTS[limb][1] + 1e-6)
    }
    // Knees are the tight case: the thigh ends exactly where the shin begins.
    expect(boxOf(partOf(full, 'aLimb', LIMB.thighLeft)).max.y).toBeCloseTo(
      PIVOTS[LIMB.thighLeft][1],
      6,
    )
    expect(boxOf(partOf(full, 'aLimb', LIMB.shinLeft)).max.y).toBeCloseTo(
      PIVOTS[LIMB.shinLeft][1],
      6,
    )
  })

  it('puts each limb on the side its joint is on', () => {
    // Swapping a pair leaves the knee bending backwards on one leg only, which
    // is the kind of thing that is invisible in a still and awful in motion.
    for (const limb of [LIMB.armLeft, LIMB.thighLeft, LIMB.shinLeft]) {
      expect(boxOf(partOf(full, 'aLimb', limb)).getCenter(new Vector3()).x).toBeCloseTo(
        PIVOTS[limb][0],
        6,
      )
    }
    for (const limb of [LIMB.armRight, LIMB.thighRight, LIMB.shinRight]) {
      expect(boxOf(partOf(full, 'aLimb', limb)).getCenter(new Vector3()).x).toBeCloseTo(
        PIVOTS[limb][0],
        6,
      )
    }
    expect(PIVOTS[LIMB.armLeft][0]).toBeGreaterThan(0)
    expect(PIVOTS[LIMB.armRight][0]).toBeLessThan(0)
  })

  it('cuts the shoes with the hair, but swings them with the shin', () => {
    // There is no zone of their own left for shoes, and a person in hair-black
    // shoes reads better than one in trouser-coloured feet — so the dark zone
    // has to reach both the crown and the floor.
    const hair = boxOf(partOf(full, 'aZone', ZONE.hair))
    expect(hair.min.y).toBeCloseTo(0, 6)
    expect(hair.max.y).toBeCloseTo(1.75, 6)

    // Colour and pose are independent tags. A shoe tagged to the body for
    // posing would stay flat on the floor while the leg walked away from it.
    const soles = tagged(full).filter((vertex) => vertex.point.y < 0.05)
    // Two shoe boxes, twelve vertices apiece sitting on the floor plane.
    expect(soles).toHaveLength(24)
    expect(new Set(soles.map((vertex) => vertex.limb))).toEqual(
      new Set([LIMB.shinLeft, LIMB.shinRight]),
    )
    expect(new Set(soles.map((vertex) => vertex.zone))).toEqual(new Set([ZONE.hair]))
  })

  it('gives the cheap model the same attributes and fewer boxes', () => {
    const before = full.getAttribute('position').count
    const after = simple.getAttribute('position').count
    expect(after).toBeLessThan(before)
    // The shader is shared, so the cheap model must still answer for every
    // attribute the injected code reads.
    expect(simple.getAttribute('aLimb').count).toBe(after)
    expect(simple.getAttribute('aZone').count).toBe(after)
    expect(new Set(valuesOf(simple, 'aLimb'))).toEqual(new Set(Object.values(LIMB)))

    // SUSPECTED BUG: `simplify` (character.ts:114-115) drops every part in the
    // hair zone, and the shoes are tagged with it (81-91), so it loses its feet
    // and starts 60 mm above the floor. Nothing asks for 'simple' today, so it
    // costs nothing yet; the moment a distance test switches models, people
    // would hover as they recede. Dropping by limb, or giving shoes their own
    // zone, would fix it.
    expect(boxOf(vertices(simple)).min.y).toBeCloseTo(0.06, 6)
  })

  it('leaves no uvs behind and bounds itself no larger than it is', () => {
    // Vertex-coloured people never sample a texture, and uvs on the character
    // are paid for once per instance in the shared buffer.
    expect(full.getAttribute('uv')).toBeUndefined()

    // A crowd is drawn with frustum culling off, but the bounding sphere is
    // still what shadow and raycast code measures against: short and people
    // drop out of shadows, long and every query touches every person.
    const sphere = full.boundingSphere!
    const furthest = Math.max(...vertices(full).map((point) => point.distanceTo(sphere.center)))
    expect(sphere.radius).toBeGreaterThanOrEqual(furthest)
    expect(sphere.radius).toBeCloseTo(furthest, 9)
    expect(sphere.center.y).toBeCloseTo(1.75 / 2, 6)
  })
})

describe('the colour tables', () => {
  it('are the size the shader indexes them at', () => {
    // The uniform arrays are declared with these lengths in the crowd shader
    // and sampled with `floor(t * n)`. A seventh skin tone would simply never
    // appear, and a shorter table would read off the end of the uniform.
    expect(SKIN_TONES).toHaveLength(6)
    expect(LEG_COLORS).toHaveLength(5)
    expect(HAIR_COLORS).toHaveLength(5)
    expect(PIVOTS).toHaveLength(Object.keys(LIMB).length)
  })

  it('are colours three can parse, and the limbs are numbered from zero', () => {
    for (const hex of [...SKIN_TONES, ...LEG_COLORS, ...HAIR_COLORS]) {
      expect(new Color(hex).getHexString()).toBe(hex.slice(1))
    }
    // The limb index is an integer compared against in GLSL, so the table has
    // to stay dense and start at zero.
    expect(Object.values(LIMB).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(Object.values(ZONE).sort((a, b) => a - b)).toEqual([0, 1, 2, 3])
  })
})
