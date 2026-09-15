/**
 * Drawing the crowd.
 *
 * One instanced mesh holds everybody. Per person the CPU writes a transform and
 * five numbers — gait phase, how much they are walking, whether they are
 * sitting, their clothing colour and their skin tone — and the vertex shader
 * does the rest: it rotates each limb about its joint, composes the shin
 * through the thigh so a knee bends properly, and picks the colour for each
 * material zone.
 *
 * That keeps a crowd of a few thousand to a single draw call, and means the
 * per-frame cost on the main thread is a matrix write per person rather than a
 * skeleton update.
 */

import {
  Color,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Camera,
} from 'three'
import { AGENT_FIELD, AGENT_STRIDE } from '../../sim/types'
import { HAIR_COLORS, LEG_COLORS, PIVOTS, SKIN_TONES, buildCharacterGeometry } from './character'
import type { AgentProfile } from '../../core/model/types'

const MAX_INSTANCES = 6000

/** Colours a person by what they are doing rather than who they are. */
export const STATE_COLORS = [
  '#4c7dd4', // walking
  '#e0a23f', // queuing
  '#e0a23f', // waiting
  '#8a5cf6', // served
  '#5f8a9c', // seated
  '#3fb27f', // dwelling
  '#8b95a3', // done
]

export type CrowdColorMode = 'state' | 'population' | 'profile' | 'speed' | 'wait'

const VERTEX_HEAD = /* glsl */ `
attribute float aLimb;
attribute float aZone;
attribute float aPhase;
attribute float aGait;
attribute float aPose;
attribute vec3 aTint;
attribute float aSkin;

uniform vec3 uPivots[7];
uniform vec3 uSkinTones[6];
uniform vec3 uLegColors[5];
uniform vec3 uHairColors[5];

varying vec3 vZoneColor;

vec3 rotateAboutX(vec3 p, vec3 pivot, float angle) {
  vec3 local = p - pivot;
  float c = cos(angle);
  float s = sin(angle);
  return pivot + vec3(local.x, local.y * c - local.z * s, local.y * s + local.z * c);
}

vec3 pickTone(vec3 tones[6], float t) {
  int index = int(clamp(floor(t * 6.0), 0.0, 5.0));
  return tones[index];
}
`

const VERTEX_BODY = /* glsl */ `
  int limb = int(aLimb + 0.5);
  float walk = aGait;
  float sit = aPose;

  // Gait: legs swing in opposition, arms counter them, knees bend on the swing.
  float swing = sin(aPhase);
  float swingOpp = sin(aPhase + 3.14159265);
  float thighAmp = 0.62 * walk;
  float armAmp = 0.42 * walk;

  float thighLeft = mix(swing * thighAmp, 1.45, sit);
  float thighRight = mix(swingOpp * thighAmp, 1.45, sit);
  float shinLeft = mix(-0.75 * walk * max(0.0, sin(aPhase - 0.7)), -1.5, sit);
  float shinRight = mix(-0.75 * walk * max(0.0, sin(aPhase + 3.14159265 - 0.7)), -1.5, sit);
  float armLeft = mix(swingOpp * armAmp, 0.35, sit);
  float armRight = mix(swing * armAmp, 0.35, sit);

  vec3 posed = transformed;
  if (limb == 1) posed = rotateAboutX(posed, uPivots[1], armLeft);
  else if (limb == 2) posed = rotateAboutX(posed, uPivots[2], armRight);
  else if (limb == 3) posed = rotateAboutX(posed, uPivots[3], thighLeft);
  else if (limb == 4) posed = rotateAboutX(posed, uPivots[4], thighRight);
  else if (limb == 5) {
    // The shin hangs off the thigh, so compose the knee through the hip.
    posed = rotateAboutX(posed, uPivots[5], shinLeft);
    posed = rotateAboutX(posed, uPivots[3], thighLeft);
  } else if (limb == 6) {
    posed = rotateAboutX(posed, uPivots[6], shinRight);
    posed = rotateAboutX(posed, uPivots[4], thighRight);
  }

  // A little vertical bob while walking, and hips drop onto the seat when sitting.
  posed.y += 0.022 * walk * abs(sin(aPhase)) - 0.42 * sit;
  transformed = posed;

  int zone = int(aZone + 0.5);
  int legIndex = int(clamp(floor(aSkin * 5.0), 0.0, 4.0));
  if (zone == 0) vZoneColor = pickTone(uSkinTones, aSkin);
  else if (zone == 1) vZoneColor = aTint;
  else if (zone == 2) vZoneColor = uLegColors[legIndex];
  else vZoneColor = uHairColors[legIndex];
`

const FRAGMENT_HEAD = /* glsl */ `
varying vec3 vZoneColor;
`

const FRAGMENT_BODY = /* glsl */ `
  diffuseColor.rgb *= vZoneColor;
`

const toLinearArray = (colors: readonly string[]): Color[] =>
  colors.map((hex) => new Color(hex).convertSRGBToLinear())

export interface CrowdFrameInput {
  agents: Float32Array
  count: number
  profiles: readonly AgentProfile[]
  populationColors: readonly string[]
  colorMode: CrowdColorMode
  /** Simulated time, used to advance the gait phase. */
  time: number
}

export class CrowdRenderer {
  readonly group = new Group()

  private mesh: InstancedMesh
  private material: MeshStandardMaterial
  private phase: Float32Array
  private gait: Float32Array
  private pose: Float32Array
  private tint: Float32Array
  private skin: Float32Array
  private phaseAttr: InstancedBufferAttribute
  private gaitAttr: InstancedBufferAttribute
  private poseAttr: InstancedBufferAttribute
  private tintAttr: InstancedBufferAttribute
  private skinAttr: InstancedBufferAttribute

  private matrix = new Matrix4()
  private quaternion = new Quaternion()
  private position = new Vector3()
  private scale = new Vector3(1, 1, 1)
  private up = new Vector3(0, 1, 0)
  private color = new Color()

  /** Gait phase carried between frames, keyed by person id. */
  private phaseById = new Map<number, number>()
  private lastTime = 0

  constructor(geometry: BufferGeometry = buildCharacterGeometry('full')) {
    this.material = new MeshStandardMaterial({ roughness: 0.82, metalness: 0.02 })
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uPivots = { value: PIVOTS.map((p) => new Vector3(...p)) }
      shader.uniforms.uSkinTones = { value: toLinearArray(SKIN_TONES) }
      shader.uniforms.uLegColors = { value: toLinearArray(LEG_COLORS) }
      shader.uniforms.uHairColors = { value: toLinearArray(HAIR_COLORS) }
      shader.vertexShader =
        VERTEX_HEAD +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n' + VERTEX_BODY,
        )
      shader.fragmentShader =
        FRAGMENT_HEAD +
        shader.fragmentShader.replace(
          '#include <color_fragment>',
          '#include <color_fragment>\n' + FRAGMENT_BODY,
        )
    }
    // Any change to the injected code needs a distinct cache key.
    this.material.customProgramCacheKey = () => 'crowd-character-v1'

    this.phase = new Float32Array(MAX_INSTANCES)
    this.gait = new Float32Array(MAX_INSTANCES)
    this.pose = new Float32Array(MAX_INSTANCES)
    this.tint = new Float32Array(MAX_INSTANCES * 3)
    this.skin = new Float32Array(MAX_INSTANCES)

    this.phaseAttr = new InstancedBufferAttribute(this.phase, 1).setUsage(DynamicDrawUsage)
    this.gaitAttr = new InstancedBufferAttribute(this.gait, 1).setUsage(DynamicDrawUsage)
    this.poseAttr = new InstancedBufferAttribute(this.pose, 1).setUsage(DynamicDrawUsage)
    this.tintAttr = new InstancedBufferAttribute(this.tint, 3).setUsage(DynamicDrawUsage)
    this.skinAttr = new InstancedBufferAttribute(this.skin, 1).setUsage(DynamicDrawUsage)

    geometry.setAttribute('aPhase', this.phaseAttr)
    geometry.setAttribute('aGait', this.gaitAttr)
    geometry.setAttribute('aPose', this.poseAttr)
    geometry.setAttribute('aTint', this.tintAttr)
    geometry.setAttribute('aSkin', this.skinAttr)

    this.mesh = new InstancedMesh(geometry, this.material, MAX_INSTANCES)
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    this.mesh.castShadow = true
    this.mesh.receiveShadow = false
    this.mesh.frustumCulled = false
    this.mesh.count = 0
    this.mesh.name = 'crowd'
    this.group.add(this.mesh)
  }

  /** Colour for one person under the current colouring rule. */
  private colorFor(input: CrowdFrameInput, base: number): string {
    const agents = input.agents
    switch (input.colorMode) {
      case 'population': {
        const index = agents[base + AGENT_FIELD.population] | 0
        return (
          input.populationColors[index % Math.max(1, input.populationColors.length)] ?? '#4c7dd4'
        )
      }
      case 'profile': {
        const index = agents[base + AGENT_FIELD.profile] | 0
        return input.profiles[index]?.color ?? '#4c7dd4'
      }
      case 'speed': {
        // Green at free-flow, red at a standstill.
        const speed = agents[base + AGENT_FIELD.speed]
        const t = Math.min(1, speed / 1.34)
        this.color.setRGB(1 - t * 0.75, 0.25 + t * 0.55, 0.25 + t * 0.2)
        return `#${this.color.getHexString()}`
      }
      case 'wait': {
        const waited = agents[base + AGENT_FIELD.waited]
        const t = Math.min(1, waited / 300)
        this.color.setRGB(0.25 + t * 0.7, 0.62 - t * 0.42, 0.45 - t * 0.2)
        return `#${this.color.getHexString()}`
      }
      case 'state':
      default: {
        const state = agents[base + AGENT_FIELD.state] | 0
        return STATE_COLORS[state] ?? STATE_COLORS[0]
      }
    }
  }

  /** Push one simulation frame into the instanced buffers. */
  update(input: CrowdFrameInput): void {
    const { agents, count } = input
    const drawn = Math.min(count, MAX_INSTANCES)
    const dt = Math.max(0, Math.min(0.5, input.time - this.lastTime))
    this.lastTime = input.time

    const seen = new Set<number>()
    for (let i = 0; i < drawn; i++) {
      const base = i * AGENT_STRIDE
      const id = agents[base + AGENT_FIELD.id]
      const x = agents[base + AGENT_FIELD.x]
      const z = agents[base + AGENT_FIELD.y]
      const heading = agents[base + AGENT_FIELD.heading]
      const speed = agents[base + AGENT_FIELD.speed]
      const state = agents[base + AGENT_FIELD.state] | 0
      const profile = input.profiles[agents[base + AGENT_FIELD.profile] | 0]
      seen.add(id)

      // Step frequency rises with speed, as it does in real walking.
      const stride = 1.9 + speed * 1.15
      const previous = this.phaseById.get(id) ?? (id % 17) * 0.37
      const next = previous + dt * stride * (speed > 0.06 ? 1 : 0.35)
      this.phaseById.set(id, next)

      const heightScale = profile?.heightScale ?? 1
      this.position.set(x, 0, z)
      // Plan space uses +Y as world Z, so a heading of 0 faces +X.
      this.quaternion.setFromAxisAngle(this.up, -heading + Math.PI / 2)
      this.scale.set(heightScale, heightScale, heightScale)
      this.matrix.compose(this.position, this.quaternion, this.scale)
      this.mesh.setMatrixAt(i, this.matrix)

      this.phase[i] = next
      this.gait[i] = Math.min(1, speed / 1.1)
      this.pose[i] = state === 4 ? 1 : 0
      this.skin[i] = ((id * 2654435761) % 1000) / 1000

      this.color.set(this.colorFor(input, base)).convertSRGBToLinear()
      this.tint[i * 3] = this.color.r
      this.tint[i * 3 + 1] = this.color.g
      this.tint[i * 3 + 2] = this.color.b
    }

    // Forget people who have left, so the phase map cannot grow without bound.
    if (this.phaseById.size > drawn * 2 + 64) {
      for (const id of this.phaseById.keys()) if (!seen.has(id)) this.phaseById.delete(id)
    }

    this.mesh.count = drawn
    this.mesh.instanceMatrix.needsUpdate = true
    this.phaseAttr.needsUpdate = true
    this.gaitAttr.needsUpdate = true
    this.poseAttr.needsUpdate = true
    this.tintAttr.needsUpdate = true
    this.skinAttr.needsUpdate = true
  }

  clear(): void {
    this.mesh.count = 0
    this.phaseById.clear()
    this.lastTime = 0
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible
  }

  /** Nearest person to a screen point, for click-to-inspect. */
  pick(
    agents: Float32Array,
    count: number,
    camera: Camera,
    screen: { x: number; y: number },
    viewport: { width: number; height: number },
    tolerancePx = 22,
  ): number | null {
    let best: number | null = null
    let bestDistance = tolerancePx
    const projected = new Vector3()
    for (let i = 0; i < count; i++) {
      const base = i * AGENT_STRIDE
      projected.set(agents[base + AGENT_FIELD.x], 0.9, agents[base + AGENT_FIELD.y])
      projected.project(camera)
      if (projected.z > 1) continue
      const sx = (projected.x * 0.5 + 0.5) * viewport.width
      const sy = (-projected.y * 0.5 + 0.5) * viewport.height
      const d = Math.hypot(sx - screen.x, sy - screen.y)
      if (d < bestDistance) {
        bestDistance = d
        best = i
      }
    }
    return best
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.group.clear()
  }
}
