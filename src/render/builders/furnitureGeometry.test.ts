import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Box3, BufferGeometry, Color, Vector3 } from 'three'
import {
  buildPrimGeometry,
  clearFurnitureGeometryCache,
  furnitureGeometryKey,
  getFurnitureGeometry,
  pruneFurnitureGeometry,
} from './furnitureGeometry'
import { roleColor } from '../theme'
import type { Prim } from '../../library/primitives'
import { resolveCatalogItem, type Size } from '../../library/catalog'

const box = (extra: Partial<Prim> = {}): Prim => ({
  type: 'box',
  x: 0,
  y: 0,
  z: 0,
  w: 1,
  h: 1,
  d: 1,
  color: 'wood',
  ...(extra as object),
})

const bounds = (geometry: BufferGeometry): Box3 => {
  const position = geometry.getAttribute('position')
  const out = new Box3()
  for (let i = 0; i < position.count; i++) {
    out.expandByPoint(new Vector3().fromBufferAttribute(position, i))
  }
  return out
}

/** The vertex colour at `index`, written back out as the hex it will display as. */
const vertexHex = (geometry: BufferGeometry, index: number): string => {
  const color = geometry.getAttribute('color')
  return new Color(color.getX(index), color.getY(index), color.getZ(index)).getHexString()
}

beforeEach(() => {
  // The cache is module-level and outlives a test; a stale entry would make the
  // identity assertions below pass for the wrong reason.
  clearFurnitureGeometryCache()
})

describe('building a primitive list', () => {
  it('paints every vertex of a primitive with its role colour', () => {
    const geometry = buildPrimGeometry([box({ color: 'wood' })])
    const color = geometry.getAttribute('color')
    expect(color.count).toBe(geometry.getAttribute('position').count)
    expect(color.itemSize).toBe(3)
    for (let i = 0; i < color.count; i++)
      expect(vertexHex(geometry, i)).toBe(vertexHex(geometry, 0))

    // SUSPECTED BUG: three's colour management is on by default in r180, so
    // `Color.set('#b08356')` already decodes to the linear working space. The
    // extra `convertSRGBToLinear()` (furnitureGeometry.ts:77) decodes a second
    // time, and the vertex colour reaches the shader as #6f3a18 — a dark brown
    // where the catalog asked for tan. Everything drawn from the role table is
    // affected, and the same double decode is in CrowdRenderer.ts:130,293,
    // DensityOverlay.ts:116,124-125 and GroundGrid.ts:71-73,93-95, while
    // `MaterialLibrary` (theme.ts) decodes once and is right. The fix is to drop
    // the `convertSRGBToLinear()` calls, not to add one in the theme.
    expect(roleColor('wood')).toBe('#b08356')
    expect(vertexHex(geometry, 0)).toBe('6f3a18')
    expect(new Color(roleColor('wood')).convertSRGBToLinear().getHexString()).toBe('6f3a18')
  })

  it('replaces only the role the catalog marks as tintable', () => {
    // Pure red survives both decodes unchanged, so this measures the tint alone.
    const geometry = buildPrimGeometry(
      [box({ color: 'fabric', y: 1 }), box({ color: 'wood', y: -1 })],
      '#ff0000',
      'fabric',
    )
    expect(vertexHex(geometry, 0)).toBe('ff0000')
    // The second primitive keeps the role colour it was authored with.
    expect(vertexHex(geometry, 24)).toBe(vertexHex(buildPrimGeometry([box()]), 0))
  })

  it('leaves everything alone when a tint names a role the item does not use', () => {
    const plain = buildPrimGeometry([box({ color: 'wood' })])
    const tinted = buildPrimGeometry([box({ color: 'wood' })], '#ff0000', 'fabric')
    expect(vertexHex(tinted, 0)).toBe(vertexHex(plain, 0))
  })

  it('places and turns each primitive by its own transform', () => {
    // A 2 m rail turned a quarter turn has to end up 2 m deep and 0.4 m wide.
    const geometry = buildPrimGeometry([
      box({ x: 1, y: 0.5, z: 0, w: 2, h: 0.1, d: 0.4, rot: Math.PI / 2 }),
    ])
    const size = bounds(geometry).getSize(new Vector3())
    expect(size.x).toBeCloseTo(0.4, 6)
    expect(size.z).toBeCloseTo(2, 6)
    expect(bounds(geometry).getCenter(new Vector3()).x).toBeCloseTo(1, 6)
    expect(bounds(geometry).getCenter(new Vector3()).y).toBeCloseTo(0.5, 6)
  })

  it('tilts a primitive before it turns it', () => {
    // YXZ order: the tilt is about the primitive's own x axis, so a tilted rail
    // then turned lies along z. Applying the turn first would stand it on end.
    const geometry = buildPrimGeometry([
      box({ w: 2, h: 0.2, d: 0.2, tilt: Math.PI / 2, rot: Math.PI / 2 }),
    ])
    const size = bounds(geometry).getSize(new Vector3())
    expect(size.z).toBeCloseTo(2, 6)
    expect(size.y).toBeCloseTo(0.2, 6)
  })

  it('stands a torus up so it reads as a ring on the floor', () => {
    const geometry = buildPrimGeometry([
      { type: 'torus', x: 0, y: 0, z: 0, r: 0.5, tube: 0.05, color: 'chrome' },
    ])
    const size = bounds(geometry).getSize(new Vector3())
    // Authored in the xy plane; on the floor it is wide and flat, not upright.
    // The ring is 2 * (r + tube) across and only the tube thick.
    expect(size.x).toBeCloseTo(1.1, 6)
    expect(size.z).toBeCloseTo(1.1, 6)
    expect(size.y).toBeCloseTo(0.1, 6)
  })

  it('squashes a sphere and tapers a cylinder the way the shape language says', () => {
    // Cushions are a squashed sphere and shades a tapered cylinder; a builder
    // that dropped either would turn a sofa into a heap of beach balls.
    const cushion = buildPrimGeometry([
      { type: 'sphere', x: 0, y: 0, z: 0, r: 0.3, squash: 0.4, color: 'fabric' },
    ])
    const squashed = bounds(cushion).getSize(new Vector3())
    expect(squashed.x).toBeCloseTo(0.6, 6)
    expect(squashed.z).toBeCloseTo(0.6, 6)
    expect(squashed.y).toBeCloseTo(0.24, 6)

    const shade = buildPrimGeometry([
      { type: 'cyl', x: 0, y: 0, z: 0, r: 0.1, r2: 0.25, h: 0.3, seg: 16, color: 'paper' },
    ])
    const widthAt = (y: number): number => {
      const position = shade.getAttribute('position')
      let widest = 0
      for (let i = 0; i < position.count; i++) {
        const point = new Vector3().fromBufferAttribute(position, i)
        if (Math.abs(point.y - y) > 1e-6) continue
        widest = Math.max(widest, Math.hypot(point.x, point.z))
      }
      return widest
    }
    // `r` is the radius at the top and `r2` at the bottom, so a shade widens
    // downwards. Swapping them stands every lamp and bin on its head.
    expect(widthAt(0.15)).toBeCloseTo(0.1, 6)
    expect(widthAt(-0.15)).toBeCloseTo(0.25, 6)
  })

  it('gives an empty build an empty geometry rather than nothing', () => {
    // A catalog entry that builds no primitives must not take the renderer
    // down, and what comes back has to be something the scene can hold and
    // dispose of like any other mesh.
    const geometry = buildPrimGeometry([])
    expect(geometry).toBeInstanceOf(BufferGeometry)
    expect(geometry.getAttribute('position')).toBeUndefined()
    expect(geometry.getAttribute('color')).toBeUndefined()
    expect(() => geometry.dispose()).not.toThrow()
  })

  it('frees the primitives once they are merged into the item', () => {
    const dispose = vi.spyOn(BufferGeometry.prototype, 'dispose')
    const geometry = buildPrimGeometry([box(), box({ x: 1 }), box({ x: 2 })])
    // An item is rebuilt on every resize handle drag. Holding the primitives
    // would leak one buffer per primitive per frame of the drag.
    expect(dispose).toHaveBeenCalledTimes(3)
    dispose.mockRestore()

    // The merge kept everything it was given: three boxes, 24 vertices each.
    expect(geometry.getAttribute('position').count).toBe(72)
    expect(bounds(geometry).max.x).toBeCloseTo(2.5, 6)
  })

  it('drops the uvs it will never sample and computes bounds it will', () => {
    const geometry = buildPrimGeometry([box()])
    // Vertex-coloured furniture never samples a texture; uvs are dead memory
    // in every instance buffer.
    expect(geometry.getAttribute('uv')).toBeUndefined()
    expect(geometry.boundingSphere!.radius).toBeCloseTo(Math.sqrt(3) / 2, 6)
    expect(geometry.boundingBox!.max.y).toBeCloseTo(0.5, 6)
  })
})

describe('the geometry cache', () => {
  const size: Size = { width: 1, depth: 1, height: 0.75 }
  const table = resolveCatalogItem('table-round-4')

  it('shares one geometry between instances that agree on item, size and colour', () => {
    // Sharing is what puts a room full of identical tables in one draw call.
    const first = getFurnitureGeometry(table, size)
    expect(getFurnitureGeometry(table, { ...size })).toBe(first)
    expect(getFurnitureGeometry(table, size, '#8a5cf6')).not.toBe(first)
    expect(getFurnitureGeometry(resolveCatalogItem('table-round-6'), size)).not.toBe(first)
  })

  it('keys on the millimetre, so a dragged resize does not mint a mesh per pixel', () => {
    expect(furnitureGeometryKey(table, { ...size, width: 1.00004 })).toBe(
      furnitureGeometryKey(table, size),
    )
    expect(furnitureGeometryKey(table, { ...size, width: 1.001 })).not.toBe(
      furnitureGeometryKey(table, size),
    )
  })

  it('builds the mesh at the size it was asked for', () => {
    const wide = getFurnitureGeometry(table, { width: 1.6, depth: 1.6, height: 0.75 })
    const box = bounds(wide)
    expect(box.max.x).toBeCloseTo(0.8, 2)
    // A table top is the height it is ordered at; people sit at it.
    expect(box.max.y).toBeCloseTo(0.75, 6)
  })

  it('frees the geometry nobody is drawing any more and keeps the rest', () => {
    const kept = getFurnitureGeometry(table, size)
    const dropped = getFurnitureGeometry(table, size, '#8a5cf6')
    let freedKept = 0
    let freedDropped = 0
    kept.addEventListener('dispose', () => {
      freedKept++
    })
    dropped.addEventListener('dispose', () => {
      freedDropped++
    })

    pruneFurnitureGeometry(new Set([furnitureGeometryKey(table, size)]))

    // Deleting the last purple table has to give its buffers back; otherwise a
    // long editing session accumulates one per colour ever tried.
    expect(freedDropped).toBe(1)
    expect(freedKept).toBe(0)
    expect(getFurnitureGeometry(table, size)).toBe(kept)
    expect(getFurnitureGeometry(table, size, '#8a5cf6')).not.toBe(dropped)
  })

  it('frees everything when the cache is cleared', () => {
    const geometry = getFurnitureGeometry(table, size)
    let freed = 0
    geometry.addEventListener('dispose', () => {
      freed++
    })
    clearFurnitureGeometryCache()
    expect(freed).toBe(1)
    expect(getFurnitureGeometry(table, size)).not.toBe(geometry)
  })
})
