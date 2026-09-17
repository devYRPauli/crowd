import { describe, expect, it } from 'vitest'
import {
  Box3,
  DoubleSide,
  Vector3,
  type BufferAttribute,
  type Color,
  type ShaderMaterial,
} from 'three'
import { GroundGrid } from './GroundGrid'
import { MaterialLibrary, PALETTES } from '../theme'

const materialOf = (grid: GroundGrid): ShaderMaterial => grid.mesh.material as ShaderMaterial
const hexOf = (material: ShaderMaterial, name: string): string =>
  (material.uniforms[name].value as Color).getHexString()

describe('the ground grid', () => {
  it('lies flat under the whole view, facing up', () => {
    const grid = new GroundGrid(PALETTES.light)
    const box = new Box3().setFromBufferAttribute(
      grid.mesh.geometry.getAttribute('position') as BufferAttribute,
    )
    // One quad big enough to cover any view, so the grid is one draw call.
    expect(box.min.x).toBeCloseTo(-600, 6)
    expect(box.max.z).toBeCloseTo(600, 6)
    expect(box.max.y).toBeCloseTo(0, 6)

    const normal = grid.mesh.geometry.getAttribute('normal')
    expect(normal.getY(0)).toBeCloseTo(1, 6)
    // Visible from underneath too: the eye-level view can dip below the ground.
    expect(materialOf(grid).side).toBe(DoubleSide)
  })

  it('sits far enough below the floor slab not to fight it', () => {
    const grid = new GroundGrid(PALETTES.light)
    // At 5 mm the two z-fight at venue scale and the grid shows through the
    // rooms, which makes a drawn floor look unbuilt.
    expect(grid.mesh.position.y).toBeCloseTo(-0.06, 6)
    expect(grid.mesh.renderOrder).toBe(-100)

    // The grid moves only when the camera does, so it is taken off the
    // per-frame matrix update and baked by hand — which means the bake has to
    // happen, or the quad sits at the origin whatever its position says.
    expect(grid.mesh.matrixAutoUpdate).toBe(false)
    expect(grid.mesh.matrix.elements[13]).toBeCloseTo(-0.06, 6)
  })

  it('takes its three tones from the palette it is given', () => {
    const grid = new GroundGrid(PALETTES.light)
    const material = materialOf(grid)

    // The site is painted the tone the palette names, and the same tone the
    // walls standing on it are: `MaterialLibrary` takes the token through one
    // decode, and a second one here left the ground darker than the building.
    expect(PALETTES.light.ground).toBe('#dae0e8')
    expect(hexOf(material, 'uBase')).toBe('dae0e8')
    expect(new MaterialLibrary('light').ground().color.getHexString()).toBe('dae0e8')

    // Same again for the two line tones. A second decode is a curve, not a
    // scale, so it does not merely darken them: it took the major line from
    // 1.43:1 against the ground to 2.08:1, and a grid tuned to sit quietly
    // behind the plan started competing with the drawing on top of it.
    expect(PALETTES.light.gridMinor).toBe('#ccd4de')
    expect(PALETTES.light.gridMajor).toBe('#b3bdcb')
    expect(hexOf(material, 'uMinor')).toBe('ccd4de')
    expect(hexOf(material, 'uMajor')).toBe('b3bdcb')
  })

  it('repaints in place when the theme changes', () => {
    const grid = new GroundGrid(PALETTES.light)
    const material = materialOf(grid)
    const uniform = material.uniforms.uBase.value as Color
    const before = uniform.getHexString()
    const wasBright = uniform.r

    grid.setPalette(PALETTES.dark)
    // The same Color object is updated, so the uniform keeps its binding and
    // the material never needs recompiling to change theme.
    expect(material.uniforms.uBase.value).toBe(uniform)
    expect(uniform.getHexString()).not.toBe(before)
    // The night site is darker than the day site.
    expect(uniform.r).toBeLessThan(wasBright)
    expect(PALETTES.dark.ground).toBe('#141920')
    expect(uniform.getHexString()).toBe('141920')
  })

  it('refuses a cell size too small to draw', () => {
    const grid = new GroundGrid(PALETTES.light, 1)
    expect(materialOf(grid).uniforms.uCell.value).toBe(1)

    grid.setCellSize(0.25)
    expect(materialOf(grid).uniforms.uCell.value).toBe(0.25)

    // The shader divides world coordinates by the cell size.
    grid.setCellSize(0)
    expect(materialOf(grid).uniforms.uCell.value).toBe(0.05)
    grid.setCellSize(-2)
    expect(materialOf(grid).uniforms.uCell.value).toBe(0.05)
  })

  it('widens the fade as the view pulls back, and carries the ground with it', () => {
    const grid = new GroundGrid(PALETTES.light)
    const material = materialOf(grid)

    grid.update(new Vector3(12, 20, -3), 40)
    expect(material.uniforms.uCamera.value).toEqual([12, 20, -3])
    // The grid fades before it turns to moiré, and how far away that is
    // depends on how much ground a pixel covers.
    expect(material.uniforms.uFade.value).toBe(240)

    grid.update(new Vector3(0, 2, 0), 1)
    // Zoomed right in, the fade still has to reach past the near clip or the
    // grid disappears from under the thing being drawn.
    expect(material.uniforms.uFade.value).toBe(30)

    // The quad is only 1200 m across and panning is not clamped, so a ground
    // left at the origin runs out from under a plan drawn past 600 m and the
    // background shows through — two drags at the far zoom limit, where a pixel
    // is around 0.4 m.
    grid.update(new Vector3(900, 20, 900), 40)
    expect(grid.mesh.position.x).toBeCloseTo(900, 6)
    expect(grid.mesh.position.z).toBeCloseTo(900, 6)
    // Moving it means nothing until the matrix is rebuilt: auto-update is off,
    // so a bare `position` write never reaches the scene.
    expect(grid.mesh.matrix.elements[12]).toBeCloseTo(900, 6)
    expect(grid.mesh.matrix.elements[14]).toBeCloseTo(900, 6)
    // And it stays on its own level, below the floor slab it must not fight.
    expect(grid.mesh.matrix.elements[13]).toBeCloseTo(-0.06, 6)
  })

  it('switches off without giving up its program', () => {
    const grid = new GroundGrid(PALETTES.light)
    const material = materialOf(grid)
    grid.setVisible(false)
    expect(grid.mesh.visible).toBe(false)
    grid.setVisible(true)
    expect(grid.mesh.visible).toBe(true)
    // Hiding the grid is a checkbox in the view menu. Rebuilding the material
    // each time it is ticked would recompile the shader on that frame.
    expect(materialOf(grid)).toBe(material)
    expect(grid.mesh.geometry.getAttribute('position').count).toBe(4)
  })

  it('gives its buffers and its program back on dispose', () => {
    const grid = new GroundGrid(PALETTES.light)
    let freed = 0
    grid.mesh.geometry.addEventListener('dispose', () => {
      freed++
    })
    materialOf(grid).addEventListener('dispose', () => {
      freed++
    })

    grid.dispose()
    // A grid is rebuilt when the viewport is; leaking the 1200 m quad and its
    // compiled shader on every rebuild is a page reload's worth of memory.
    expect(freed).toBe(2)
  })
})
