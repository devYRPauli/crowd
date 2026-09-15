/**
 * The ground plane and its grid.
 *
 * Drawn in a fragment shader on a single large quad rather than as line
 * geometry: the grid then stays crisp at every zoom level, fades out before it
 * turns into moiré, and costs one draw call. Major lines every ten cells give
 * the eye something to measure against.
 */

import { Color, DoubleSide, Mesh, PlaneGeometry, ShaderMaterial, type Vector3 } from 'three'
import type { Palette } from '../theme'

const VERTEX = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`

const FRAGMENT = /* glsl */ `
precision highp float;
varying vec3 vWorld;
uniform vec3 uBase;
uniform vec3 uMinor;
uniform vec3 uMajor;
uniform vec3 uCamera;
uniform float uCell;
uniform float uFade;
uniform float uOpacity;

// Anti-aliased grid line coverage using screen-space derivatives.
float gridLine(vec2 coord, float width) {
  vec2 grid = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
  float line = min(grid.x, grid.y);
  return 1.0 - min(line / width, 1.0);
}

void main() {
  vec2 cell = vWorld.xz / uCell;
  float minor = gridLine(cell, 1.0);
  float major = gridLine(cell / 10.0, 1.2);

  float dist = length(vWorld.xz - uCamera.xz);
  float fade = 1.0 - smoothstep(uFade * 0.45, uFade, dist);

  // Hide the minor grid once cells fall below a few pixels.
  float cellPixels = uCell / max(fwidth(vWorld.x), 1e-5);
  float minorVisible = smoothstep(4.0, 12.0, cellPixels);

  vec3 color = uBase;
  color = mix(color, uMinor, minor * 0.85 * fade * minorVisible);
  color = mix(color, uMajor, major * 0.95 * fade);
  gl_FragColor = vec4(color, uOpacity);
  #include <colorspace_fragment>
}
`

export class GroundGrid {
  readonly mesh: Mesh
  private material: ShaderMaterial

  constructor(palette: Palette, cellSize = 1) {
    this.material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: DoubleSide,
      transparent: false,
      uniforms: {
        uBase: { value: new Color(palette.ground).convertSRGBToLinear() },
        uMinor: { value: new Color(palette.gridMinor).convertSRGBToLinear() },
        uMajor: { value: new Color(palette.gridMajor).convertSRGBToLinear() },
        uCamera: { value: [0, 0, 0] },
        uCell: { value: cellSize },
        uFade: { value: 140 },
        uOpacity: { value: 1 },
      },
    })
    const geometry = new PlaneGeometry(1200, 1200)
    geometry.rotateX(-Math.PI / 2)
    this.mesh = new Mesh(geometry, this.material)
    this.mesh.name = 'ground-grid'
    this.mesh.renderOrder = -100
    // Well below the floor slab: at 5 mm the two z-fight at venue scale and the
    // grid shows through the rooms, which makes a drawn floor look unbuilt.
    this.mesh.position.y = -0.06
    this.mesh.matrixAutoUpdate = false
    this.mesh.updateMatrix()
  }

  setPalette(palette: Palette): void {
    ;(this.material.uniforms.uBase.value as Color).set(palette.ground).convertSRGBToLinear()
    ;(this.material.uniforms.uMinor.value as Color).set(palette.gridMinor).convertSRGBToLinear()
    ;(this.material.uniforms.uMajor.value as Color).set(palette.gridMajor).convertSRGBToLinear()
  }

  setCellSize(size: number): void {
    this.material.uniforms.uCell.value = Math.max(0.05, size)
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible
  }

  /** Follow the camera so the quad always covers the view, and scale the fade to the zoom. */
  update(cameraPosition: Vector3, targetDistance: number): void {
    this.material.uniforms.uCamera.value = [cameraPosition.x, cameraPosition.y, cameraPosition.z]
    this.material.uniforms.uFade.value = Math.max(30, targetDistance * 6)
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
