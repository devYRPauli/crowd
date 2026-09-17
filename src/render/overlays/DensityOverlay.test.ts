import { describe, expect, it } from 'vitest'
import {
  Color,
  LinearFilter,
  RedFormat,
  UnsignedByteType,
  type DataTexture,
  type ShaderMaterial,
  type Vector3,
} from 'three'
import { DensityOverlay } from './DensityOverlay'
import { CROWD_SAFETY, LOS_TABLES } from '../../sim/metrics/los'
import type { GridInfo } from '../../state/simulationStore'

const grid = (extra: Partial<GridInfo> = {}): GridInfo => ({
  originX: -4,
  originY: 2,
  cellSize: 0.25,
  cols: 40,
  rows: 20,
  ...extra,
})

const materialOf = (overlay: DensityOverlay): ShaderMaterial =>
  overlay.mesh.material as ShaderMaterial
const textureOf = (overlay: DensityOverlay): DataTexture =>
  materialOf(overlay).uniforms.uDensity.value as DataTexture
const bandHex = (overlay: DensityOverlay, index: number): string => {
  const band = (materialOf(overlay).uniforms.uBands.value as Vector3[])[index]
  return new Color(band.x, band.y, band.z).getHexString()
}

describe('the density overlay', () => {
  it('lays the map exactly over the navigation grid', () => {
    const overlay = new DensityOverlay()
    overlay.setGrid(grid())

    // 40 x 20 cells of 0.25 m is 10 m by 5 m, starting at (-4, 2) in plan.
    // A map that does not line up puts the crowd beside its own density.
    expect(overlay.mesh.scale.toArray()).toEqual([10, 1, 5])
    expect(overlay.mesh.position.x).toBeCloseTo(1, 6)
    expect(overlay.mesh.position.z).toBeCloseTo(4.5, 6)
  })

  it('reads as paint on the floor rather than a slab over it', () => {
    const overlay = new DensityOverlay()
    expect(overlay.mesh.position.y).toBeCloseTo(0.02, 6)
    expect(materialOf(overlay).depthWrite).toBe(false)
    expect(materialOf(overlay).transparent).toBe(true)
    // Drawn after the floor and the furniture, so it covers them.
    expect(overlay.mesh.renderOrder).toBe(6)
  })

  it('sizes the texture to the grid and frees the one it replaces', () => {
    const overlay = new DensityOverlay()
    overlay.setGrid(grid({ cols: 4, rows: 3 }))
    const first = textureOf(overlay)
    let freed = 0
    first.addEventListener('dispose', () => {
      freed++
    })
    expect((first.image.data as Uint8Array).length).toBe(12)
    // One byte per navigation cell, uploaded every frame of a run: anything
    // wider than a red byte triples what crosses the bus for nothing.
    expect(first.format).toBe(RedFormat)
    expect(first.type).toBe(UnsignedByteType)
    // Sampled smoothly, so a heat map on a 0.3 m grid reads as a field rather
    // than as the mosaic the grid actually is.
    expect(first.minFilter).toBe(LinearFilter)
    expect(first.magFilter).toBe(LinearFilter)

    overlay.setGrid(grid({ cols: 10, rows: 10 }))
    // Every run re-sizes the grid. Holding the old texture would leak one
    // upload per run for the life of the session.
    expect(freed).toBe(1)
    expect(textureOf(overlay)).not.toBe(first)
    expect((textureOf(overlay).image.data as Uint8Array).length).toBe(100)
  })

  it('quantises persons per square metre into the byte the texture carries', () => {
    const overlay = new DensityOverlay()
    overlay.setGrid(grid({ cols: 2, rows: 2 }))
    const texture = textureOf(overlay)
    const version = texture.version

    // The byte is a fraction of the top of the scale, so the scale has to be
    // the one the shader multiplies back up by.
    expect(materialOf(overlay).uniforms.uScale.value).toBe(6)
    overlay.update(new Float32Array([0, 3, 6, 12]))
    expect(Array.from(texture.image.data as Uint8Array)).toEqual([0, 128, 255, 255])
    // Marking the texture bumps its version, which is what makes the renderer
    // upload the frame instead of drawing the last one again.
    expect(texture.version).toBeGreaterThan(version)

    // A crush beyond the top of the scale still reads as the top of the scale,
    // and a negative cell (an empty one, written as -0) as nothing at all.
    overlay.update(new Float32Array([-1, 0.3, 5.9, 6.0001]))
    expect(Array.from(texture.image.data as Uint8Array)).toEqual([0, 13, 251, 255])

    // A frame that arrives short — the last one from a run whose grid has
    // already been resized under it — blanks the cells it does not reach
    // instead of leaving the previous frame's crowd painted there.
    overlay.update(new Float32Array([3]))
    expect(Array.from(texture.image.data as Uint8Array)).toEqual([128, 0, 0, 0])
  })

  it('ignores a frame that arrives before the run has a grid', () => {
    // Frames and grids arrive from the worker as separate messages.
    const overlay = new DensityOverlay()
    expect(() => overlay.update(new Float32Array([1, 2, 3]))).not.toThrow()

    overlay.setVisible(true)
    // Nothing to show is shown as nothing, not as an empty sheet over the plan.
    expect(overlay.mesh.visible).toBe(false)
    overlay.setGrid(grid())
    overlay.setVisible(true)
    expect(overlay.mesh.visible).toBe(true)
  })

  it('classifies by the table for the surface the floor is', () => {
    const overlay = new DensityOverlay()
    const limits = materialOf(overlay).uniforms.uLimits.value as Float32Array

    // 1.5 persons/m2 is a comfortable queue and a failing walkway, so the
    // overlay cannot have one set of bands.
    overlay.setFacility('walkway')
    expect(limits[0]).toBeCloseTo(1 / 3.24, 5)
    expect(limits[4]).toBeCloseTo(1 / 0.46, 5)
    overlay.setFacility('queue')
    expect(limits[0]).toBeCloseTo(1 / 1.21, 5)

    // The last band is open-ended. Infinity in a float uniform makes every
    // comparison in the shader false and the whole map takes the F colour.
    expect(limits[5]).toBe(1e6)
    expect(LOS_TABLES.queue[5].maxDensity).toBe(Infinity)
  })

  it('flags a crush whichever table is in play', () => {
    const overlay = new DensityOverlay()
    const uniforms = materialOf(overlay).uniforms
    overlay.setFacility('queue')
    // Operational practice for standing crowds, independent of level of
    // service: it has to fire in a queue as much as on a walkway.
    expect(uniforms.uWarnDensity.value).toBe(CROWD_SAFETY.warnDensity)
    expect(uniforms.uCriticalDensity.value).toBe(CROWD_SAFETY.criticalDensity)
    expect(uniforms.uShowSafety.value).toBe(1)

    overlay.setSafetyOverlay(false)
    expect(uniforms.uShowSafety.value).toBe(0)
    // Turning the overlay off must not disturb the thresholds it fires on.
    expect(uniforms.uWarnDensity.value).toBe(4)
    expect(uniforms.uCriticalDensity.value).toBe(5)
  })

  it('carries the level-of-service colours into the shader', () => {
    const overlay = new DensityOverlay()
    overlay.setFacility('walkway')

    // SUSPECTED BUG: the same double decode as GroundGrid and the furniture
    // builder. `Color.set('#1a9850')` already gives linear working values under
    // r180's colour management, and `convertSRGBToLinear()`
    // (DensityOverlay.ts:116 and 124-125) decodes again; the shader's
    // `<colorspace_fragment>` encodes once on the way out, so Fruin's level A
    // green paints as #035014 — near black — and level F's red as #ad0805. The
    // heat map is a legend the user reads a number off, and the panel puts the
    // table's hex straight into CSS, so the paint and the key beside it no
    // longer name the same colour. Dropping the conversion fixes it.
    expect(LOS_TABLES.walkway[0].color).toBe('#1a9850')
    expect(LOS_TABLES.walkway[5].color).toBe('#d73027')
    expect(bandHex(overlay, 0)).toBe('035014')
    expect(bandHex(overlay, 5)).toBe('ad0805')

    // The safety colours go through the same call (DensityOverlay.ts:124-125),
    // and they are the ones a steward is looking for.
    const warn = materialOf(overlay).uniforms.uWarnColor.value as Vector3
    expect(new Color(warn.x, warn.y, warn.z).getHexString()).toBe('ce315c')
    expect(CROWD_SAFETY.warnColor).toBe('#e879a2')
  })

  it('fades the whole map without rebuilding it', () => {
    const overlay = new DensityOverlay()
    overlay.setGrid(grid())
    const material = materialOf(overlay)
    const texture = textureOf(overlay)
    expect(material.uniforms.uOpacity.value).toBeCloseTo(0.72, 6)

    overlay.setOpacity(0.35)
    expect(material.uniforms.uOpacity.value).toBeCloseTo(0.35, 6)
    // The opacity is a slider the user drags. Rebuilding the material or the
    // texture behind it would recompile and re-upload on every pointer move.
    expect(materialOf(overlay)).toBe(material)
    expect(textureOf(overlay)).toBe(texture)
  })

  it('gives the texture, the program and the quad back on dispose', () => {
    const overlay = new DensityOverlay()
    overlay.setGrid(grid())
    let freed = 0
    const count = () => {
      freed++
    }
    textureOf(overlay).addEventListener('dispose', count)
    materialOf(overlay).addEventListener('dispose', count)
    overlay.mesh.geometry.addEventListener('dispose', count)

    overlay.dispose()
    expect(freed).toBe(3)
  })
})
