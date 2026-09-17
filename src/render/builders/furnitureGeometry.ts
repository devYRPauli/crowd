/**
 * Turning catalog primitives into drawable geometry.
 *
 * Every catalog entry compiles to one merged, vertex-coloured
 * `BufferGeometry`. Instances that share a catalog id, size and colour share
 * that geometry and draw in a single instanced call, which is what lets a plan
 * hold several hundred pieces of furniture without the frame rate noticing.
 * Results are cached; the cache is keyed on exactly the inputs that change the
 * mesh.
 */

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Matrix4,
  SphereGeometry,
  TorusGeometry,
  Euler,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Prim } from '../../library/primitives'
import type { CatalogItem, Size } from '../../library/catalog'
import { roleColor } from '../theme'

const geometryCache = new Map<string, BufferGeometry>()
const scratchMatrix = new Matrix4()
const scratchEuler = new Euler()
const scratchColor = new Color()

const primGeometry = (prim: Prim): BufferGeometry => {
  switch (prim.type) {
    case 'box':
      return new BoxGeometry(prim.w, prim.h, prim.d)
    case 'cyl':
      return new CylinderGeometry(
        prim.r,
        prim.r2 ?? prim.r,
        prim.h,
        prim.seg ?? 16,
        1,
        prim.open ?? false,
      )
    case 'sphere': {
      const geometry = new SphereGeometry(prim.r, prim.seg ?? 12, Math.max(6, (prim.seg ?? 12) / 2))
      if (prim.squash && prim.squash !== 1) geometry.scale(1, prim.squash, 1)
      return geometry
    }
    case 'torus':
      return new TorusGeometry(prim.r, prim.tube, 8, prim.seg ?? 16, prim.arc ?? Math.PI * 2)
  }
}

/**
 * Merge a primitive list into one geometry, baking each primitive's role colour
 * into vertex colours. `tint` replaces the colour of the entry's tintable role.
 */
export const buildPrimGeometry = (
  prims: Prim[],
  tint?: string,
  tintRole?: string,
): BufferGeometry => {
  const parts: BufferGeometry[] = []
  for (const prim of prims) {
    const geometry = primGeometry(prim)
    scratchEuler.set(prim.tilt ?? 0, prim.rot ?? 0, 0, 'YXZ')
    // Torus is authored in the XY plane; stand it up so it reads as a ring on the floor.
    if (prim.type === 'torus') scratchEuler.x += Math.PI / 2
    scratchMatrix.makeRotationFromEuler(scratchEuler)
    scratchMatrix.setPosition(prim.x ?? 0, prim.y ?? 0, prim.z ?? 0)
    geometry.applyMatrix4(scratchMatrix)

    const source = tint && tintRole && prim.color === tintRole ? tint : roleColor(prim.color)
    // Vertex colours are handed to the shader in the working space, and `set`
    // has already brought the hex there — colour management is on. Decoding a
    // second time here drew the whole catalog several stops dark.
    scratchColor.set(source)
    const count = geometry.getAttribute('position').count
    const colors = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      colors[i * 3] = scratchColor.r
      colors[i * 3 + 1] = scratchColor.g
      colors[i * 3 + 2] = scratchColor.b
    }
    geometry.setAttribute('color', new BufferAttribute(colors, 3))
    geometry.deleteAttribute('uv')
    parts.push(geometry)
  }
  if (parts.length === 0) return new BufferGeometry()
  const merged = mergeGeometries(parts, false)
  for (const part of parts) part.dispose()
  if (!merged) return new BufferGeometry()
  merged.computeBoundingSphere()
  merged.computeBoundingBox()
  return merged
}

const sizeKey = (size: Size): string =>
  `${size.width.toFixed(3)}x${size.depth.toFixed(3)}x${size.height.toFixed(3)}`

/** Cache key covering everything that changes the mesh. */
export const furnitureGeometryKey = (item: CatalogItem, size: Size, color?: string): string =>
  `${item.id}|${sizeKey(size)}|${color ?? ''}`

export const getFurnitureGeometry = (
  item: CatalogItem,
  size: Size,
  color?: string,
): BufferGeometry => {
  const key = furnitureGeometryKey(item, size, color)
  const cached = geometryCache.get(key)
  if (cached) return cached
  const geometry = buildPrimGeometry(item.build(size), color, item.tintRole)
  geometryCache.set(key, geometry)
  return geometry
}

/** Free cached geometry that is no longer referenced by the scene. */
export const pruneFurnitureGeometry = (liveKeys: ReadonlySet<string>): void => {
  for (const [key, geometry] of geometryCache) {
    if (liveKeys.has(key)) continue
    geometry.dispose()
    geometryCache.delete(key)
  }
}

export const clearFurnitureGeometryCache = (): void => {
  for (const geometry of geometryCache.values()) geometry.dispose()
  geometryCache.clear()
}
