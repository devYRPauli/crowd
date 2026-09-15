/**
 * The density heat map.
 *
 * Density arrives from the worker as one byte per navigation cell, so the map
 * is a `DataTexture` uploaded each frame and coloured in the fragment shader.
 * Colouring on the GPU means the level-of-service bands can be switched
 * (walkway, queue) or the crowd-safety overlay toggled without touching the
 * data.
 *
 * The map is drawn just above the floor with depth writing off, so it reads as
 * paint on the floor rather than as a slab hovering over it.
 */

import {
  DataTexture,
  DoubleSide,
  LinearFilter,
  Mesh,
  PlaneGeometry,
  RedFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector3,
} from 'three'
import type { GridInfo } from '../../state/simulationStore'
import { CROWD_SAFETY, LOS_TABLES, type FacilityType } from '../../sim/metrics/los'
import { Color } from 'three'

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uDensity;
uniform float uScale;
uniform float uOpacity;
uniform vec3 uBands[6];
uniform float uLimits[6];
uniform float uShowSafety;
uniform vec3 uWarnColor;
uniform vec3 uCriticalColor;
uniform float uWarnDensity;
uniform float uCriticalDensity;

void main() {
  float density = texture2D(uDensity, vUv).r * uScale;
  if (density < 0.02) discard;

  vec3 color = uBands[5];
  for (int i = 0; i < 6; i++) {
    if (density <= uLimits[i]) { color = uBands[i]; break; }
  }
  if (uShowSafety > 0.5) {
    if (density >= uCriticalDensity) color = uCriticalColor;
    else if (density >= uWarnDensity) color = mix(color, uWarnColor, 0.75);
  }

  // Fade in over the first band so empty floor stays clean.
  float alpha = uOpacity * smoothstep(0.02, 0.22, density);
  gl_FragColor = vec4(color, alpha);
  #include <colorspace_fragment>
}
`

export class DensityOverlay {
  readonly mesh: Mesh
  private material: ShaderMaterial
  private texture: DataTexture | null = null
  private grid: GridInfo | null = null

  constructor() {
    this.material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      uniforms: {
        uDensity: { value: null },
        uScale: { value: 6 },
        uOpacity: { value: 0.72 },
        uBands: { value: Array.from({ length: 6 }, () => new Vector3()) },
        uLimits: { value: new Float32Array(6) },
        uShowSafety: { value: 1 },
        uWarnColor: { value: new Vector3() },
        uCriticalColor: { value: new Vector3() },
        uWarnDensity: { value: CROWD_SAFETY.warnDensity },
        uCriticalDensity: { value: CROWD_SAFETY.criticalDensity },
      },
    })
    const geometry = new PlaneGeometry(1, 1)
    geometry.rotateX(-Math.PI / 2)
    this.mesh = new Mesh(geometry, this.material)
    this.mesh.renderOrder = 6
    this.mesh.position.y = 0.02
    this.mesh.visible = false
    this.mesh.name = 'density-overlay'
    this.setFacility('walkway')
    this.setSafetyOverlay(true)
  }

  setFacility(facility: FacilityType): void {
    const table = LOS_TABLES[facility]
    const bands = this.material.uniforms.uBands.value as Vector3[]
    const limits = this.material.uniforms.uLimits.value as Float32Array
    const color = new Color()
    table.forEach((entry, index) => {
      color.set(entry.color).convertSRGBToLinear()
      bands[index].set(color.r, color.g, color.b)
      limits[index] = Number.isFinite(entry.maxDensity) ? entry.maxDensity : 1e6
    })
  }

  setSafetyOverlay(enabled: boolean): void {
    this.material.uniforms.uShowSafety.value = enabled ? 1 : 0
    const warn = new Color(CROWD_SAFETY.warnColor).convertSRGBToLinear()
    const critical = new Color(CROWD_SAFETY.criticalColor).convertSRGBToLinear()
    ;(this.material.uniforms.uWarnColor.value as Vector3).set(warn.r, warn.g, warn.b)
    ;(this.material.uniforms.uCriticalColor.value as Vector3).set(
      critical.r,
      critical.g,
      critical.b,
    )
  }

  setOpacity(value: number): void {
    this.material.uniforms.uOpacity.value = value
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible && this.texture !== null
  }

  /** Size the map to the navigation grid. Call whenever a run starts. */
  setGrid(grid: GridInfo): void {
    this.grid = grid
    this.texture?.dispose()
    this.texture = new DataTexture(
      new Uint8Array(grid.cols * grid.rows),
      grid.cols,
      grid.rows,
      RedFormat,
      UnsignedByteType,
    )
    this.texture.minFilter = LinearFilter
    this.texture.magFilter = LinearFilter
    this.texture.needsUpdate = true
    this.material.uniforms.uDensity.value = this.texture

    const width = grid.cols * grid.cellSize
    const depth = grid.rows * grid.cellSize
    this.mesh.scale.set(width, 1, depth)
    this.mesh.position.set(grid.originX + width / 2, 0.02, grid.originY + depth / 2)
  }

  /** Upload a frame of density values in persons per square metre. */
  update(values: Float32Array): void {
    if (!this.texture || !this.grid) return
    const data = this.texture.image.data as Uint8Array
    const scale = this.material.uniforms.uScale.value as number
    const limit = data.length
    for (let i = 0; i < limit; i++) {
      const byte = Math.round((values[i] / scale) * 255)
      data[i] = byte > 255 ? 255 : byte < 0 ? 0 : byte
    }
    this.texture.needsUpdate = true
  }

  dispose(): void {
    this.texture?.dispose()
    this.material.dispose()
    this.mesh.geometry.dispose()
  }
}
