/**
 * Camera and navigation for the viewport.
 *
 * Written by hand rather than reusing OrbitControls because this is a drawing
 * tool first: the left mouse button belongs to the active tool, always.
 * Navigation lives on the right and middle buttons, the wheel, and Space-drag —
 * the convention people already know from Figma, SketchUp and Blender.
 *
 * One rig drives two cameras. The plan view is a true orthographic top-down
 * projection (so a drawn dimension is the dimension), and every other view is
 * perspective. Switching between them tweens, so the user never loses their
 * place.
 */

import { MathUtils, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three'
import type { Bounds } from '../core/math/geometry'

export type ViewPreset = 'plan' | 'iso' | 'front' | 'eye'

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

interface RigState {
  /** Point the camera looks at, on the ground plane. */
  target: Vector3
  /** Horizontal angle, radians. */
  azimuth: number
  /** Angle from vertical: 0 is straight down. */
  polar: number
  /** Distance from the target. */
  distance: number
  /** Blend between orthographic (0) and perspective (1). */
  perspective: number
}

const cloneState = (s: RigState): RigState => ({
  target: s.target.clone(),
  azimuth: s.azimuth,
  polar: s.polar,
  distance: s.distance,
  perspective: s.perspective,
})

export const VIEW_PRESETS: Record<ViewPreset, Omit<RigState, 'target' | 'distance'>> = {
  plan: { azimuth: -Math.PI / 2, polar: 0.0001, perspective: 0 },
  iso: { azimuth: -Math.PI / 2.35, polar: 1.02, perspective: 1 },
  front: { azimuth: -Math.PI / 2, polar: 1.35, perspective: 1 },
  eye: { azimuth: -Math.PI / 2, polar: 1.53, perspective: 1 },
}

export class CameraRig {
  readonly perspectiveCamera = new PerspectiveCamera(46, 1, 0.1, 2000)
  readonly orthographicCamera = new OrthographicCamera(-10, 10, 10, -10, -500, 1000)

  private state: RigState = {
    target: new Vector3(0, 0, 0),
    azimuth: VIEW_PRESETS.iso.azimuth,
    polar: VIEW_PRESETS.iso.polar,
    distance: 26,
    perspective: 1,
  }

  private from: RigState | null = null
  private to: RigState | null = null
  private tweenT = 1
  private tweenDuration = 0.55

  private viewportWidth = 1
  private viewportHeight = 1

  minDistance = 1.2
  maxDistance = 400

  /** Called whenever the camera moves, so the host can request a redraw. */
  onChange: (() => void) | null = null

  get camera(): PerspectiveCamera | OrthographicCamera {
    return this.state.perspective > 0.5 ? this.perspectiveCamera : this.orthographicCamera
  }

  get isPlanView(): boolean {
    return this.state.perspective <= 0.5
  }

  get distance(): number {
    return this.state.distance
  }

  get targetPoint(): Vector3 {
    return this.state.target
  }

  setViewportSize(width: number, height: number): void {
    this.viewportWidth = Math.max(1, width)
    this.viewportHeight = Math.max(1, height)
    this.perspectiveCamera.aspect = this.viewportWidth / this.viewportHeight
    this.apply()
  }

  /** Orbit by screen-space deltas, in pixels. */
  orbit(dx: number, dy: number): void {
    this.cancelTween()
    this.state.azimuth -= dx * 0.006
    this.state.polar = clamp(this.state.polar + dy * 0.006, 0.0001, Math.PI / 2 - 0.02)
    // Leaving the top-down pose implies a perspective view.
    if (this.state.polar > 0.12) this.state.perspective = 1
    this.apply()
  }

  /** Pan across the ground plane by screen-space deltas, in pixels. */
  pan(dx: number, dy: number): void {
    this.cancelTween()
    const scale = this.worldPerPixel()
    const right = new Vector3(Math.cos(this.state.azimuth), 0, Math.sin(this.state.azimuth))
    const forward = new Vector3(-Math.sin(this.state.azimuth), 0, Math.cos(this.state.azimuth))
    this.state.target.addScaledVector(right, -dx * scale)
    this.state.target.addScaledVector(forward, -dy * scale)
    this.apply()
  }

  /**
   * Zoom by a wheel delta. When a ground point is supplied the view zooms
   * towards it, which is what makes wheel-zoom feel precise rather than
   * approximate.
   */
  zoom(delta: number, groundPoint?: { x: number; z: number }): void {
    this.cancelTween()
    const factor = Math.exp(delta * 0.0014)
    const next = clamp(this.state.distance * factor, this.minDistance, this.maxDistance)
    if (groundPoint) {
      const t = 1 - next / this.state.distance
      this.state.target.x += (groundPoint.x - this.state.target.x) * t
      this.state.target.z += (groundPoint.z - this.state.target.z) * t
    }
    this.state.distance = next
    this.apply()
  }

  /**
   * Half the visible height at the target plane, in metres.
   *
   * The orthographic camera is sized from the perspective camera's field of
   * view rather than from the distance directly, so the two projections frame
   * exactly the same extent and switching between plan and 3D does not jump.
   */
  private halfExtent(): number {
    return Math.tan(MathUtils.degToRad(this.perspectiveCamera.fov) / 2) * this.state.distance
  }

  /** Metres per screen pixel at the target plane — used for panning and snap tolerances. */
  worldPerPixel(): number {
    return (this.halfExtent() * 2) / this.viewportHeight
  }

  setPreset(preset: ViewPreset, animate = true): void {
    const target = VIEW_PRESETS[preset]
    const next = cloneState(this.state)
    next.azimuth = target.azimuth
    next.polar = target.polar
    next.perspective = target.perspective
    if (preset === 'eye') {
      next.distance = Math.min(next.distance, 14)
    }
    this.startTween(next, animate)
  }

  /** Frame a region of the plan, leaving a comfortable margin. */
  frame(bounds: Bounds, animate = true): void {
    const width = Math.max(1, bounds.maxX - bounds.minX)
    const depth = Math.max(1, bounds.maxY - bounds.minY)
    const next = cloneState(this.state)
    next.target.set((bounds.minX + bounds.maxX) / 2, 0, (bounds.minY + bounds.maxY) / 2)
    const aspect = this.viewportWidth / this.viewportHeight
    const needed = Math.max(depth, width / Math.max(aspect, 0.2))
    // Frame the extent within the field of view, with a margin for the labels
    // and panels that sit over the edges of the viewport.
    const fit = needed / 2 / Math.tan(MathUtils.degToRad(this.perspectiveCamera.fov) / 2)
    next.distance = clamp(fit * 1.25 + 2, this.minDistance, this.maxDistance)
    this.startTween(next, animate)
  }

  /** Immediately centre on a point without changing the angle. */
  lookAtPoint(x: number, z: number, animate = true): void {
    const next = cloneState(this.state)
    next.target.set(x, 0, z)
    this.startTween(next, animate)
  }

  private startTween(next: RigState, animate: boolean): void {
    if (!animate) {
      this.state = next
      this.tweenT = 1
      this.from = null
      this.to = null
      this.apply()
      return
    }
    this.from = cloneState(this.state)
    this.to = next
    this.tweenT = 0
  }

  private cancelTween(): void {
    this.from = null
    this.to = null
    this.tweenT = 1
  }

  /** Advance any running transition. Returns true while the camera is still moving. */
  update(dt: number): boolean {
    if (!this.from || !this.to) return false
    this.tweenT = Math.min(1, this.tweenT + dt / this.tweenDuration)
    const t = this.tweenT
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    const from = this.from
    const to = this.to
    // Take the short way round when the azimuth wraps.
    let deltaAzimuth = to.azimuth - from.azimuth
    while (deltaAzimuth > Math.PI) deltaAzimuth -= Math.PI * 2
    while (deltaAzimuth < -Math.PI) deltaAzimuth += Math.PI * 2
    this.state = {
      target: from.target.clone().lerp(to.target, e),
      azimuth: from.azimuth + deltaAzimuth * e,
      polar: MathUtils.lerp(from.polar, to.polar, e),
      distance: MathUtils.lerp(from.distance, to.distance, e),
      perspective: MathUtils.lerp(from.perspective, to.perspective, e),
    }
    this.apply()
    if (this.tweenT >= 1) {
      this.state = cloneState(to)
      this.cancelTween()
      this.apply()
      return false
    }
    return true
  }

  private apply(): void {
    const { target, azimuth, polar, distance } = this.state
    const sinPolar = Math.sin(polar)
    const offset = new Vector3(
      Math.cos(azimuth) * sinPolar,
      Math.cos(polar),
      Math.sin(azimuth) * sinPolar,
    ).multiplyScalar(distance)

    this.perspectiveCamera.position.copy(target).add(offset)
    this.perspectiveCamera.lookAt(target)
    this.perspectiveCamera.near = Math.max(0.05, distance * 0.008)
    this.perspectiveCamera.far = distance * 12 + 200
    this.perspectiveCamera.updateProjectionMatrix()

    const aspect = this.viewportWidth / this.viewportHeight
    const halfHeight = this.halfExtent()
    const halfWidth = halfHeight * aspect
    this.orthographicCamera.left = -halfWidth
    this.orthographicCamera.right = halfWidth
    this.orthographicCamera.top = halfHeight
    this.orthographicCamera.bottom = -halfHeight
    // Keep the ortho camera well above anything in the scene so nothing clips.
    this.orthographicCamera.position
      .copy(target)
      .add(offset.clone().setLength(Math.max(distance, 60)))
    this.orthographicCamera.lookAt(target)
    this.orthographicCamera.updateProjectionMatrix()

    this.onChange?.()
  }

  /** Serialisable pose, so the view survives a reload. */
  snapshot(): string {
    const s = this.state
    return JSON.stringify([s.target.x, s.target.z, s.azimuth, s.polar, s.distance, s.perspective])
  }

  restore(snapshot: string): void {
    try {
      const [x, z, azimuth, polar, distance, perspective] = JSON.parse(snapshot) as number[]
      if (![x, z, azimuth, polar, distance, perspective].every(Number.isFinite)) return
      this.state = {
        target: new Vector3(x, 0, z),
        azimuth,
        polar: clamp(polar, 0.0001, Math.PI / 2 - 0.02),
        distance: clamp(distance, this.minDistance, this.maxDistance),
        perspective,
      }
      this.cancelTween()
      this.apply()
    } catch {
      // A malformed stored pose just means we keep the default view.
    }
  }
}
