import { describe, expect, it, vi } from 'vitest'
import { MathUtils } from 'three'
import { CameraRig, VIEW_PRESETS } from './CameraRig'
import type { Bounds } from '../core/math/geometry'

/** Half the visible height at the target plane, per metre of distance. */
const TAN_HALF_FOV = Math.tan(MathUtils.degToRad(46) / 2)

/**
 * Where `frame` parks the camera: the distance that just fits `needed` metres
 * through the lens, plus a quarter of it again and two metres of margin.
 */
const framedDistance = (needed: number): number => (needed / 2 / TAN_HALF_FOV) * 1.25 + 2

const rig = (width = 1000, height = 500): CameraRig => {
  const camera = new CameraRig()
  camera.setViewportSize(width, height)
  return camera
}

const bounds = (minX: number, minY: number, maxX: number, maxY: number): Bounds => ({
  minX,
  minY,
  maxX,
  maxY,
})

/** The compass bearing the camera currently sits at, read back off its position. */
const azimuthOf = (camera: CameraRig): number => {
  const offset = camera.camera.position.clone().sub(camera.targetPoint)
  return Math.atan2(offset.z, offset.x)
}

describe('framing a plan', () => {
  it('centres on the plan and pulls back far enough to see all of it', () => {
    const camera = rig(1000, 500)
    const before = azimuthOf(camera)
    camera.frame(bounds(-10, 0, 10, 10), false)

    expect(camera.targetPoint.toArray()).toEqual([0, 0, 5])
    // Zoom-to-fit moves the camera, it does not reorient it: a user who has
    // set up a view angle keeps it when they press it.
    expect(azimuthOf(camera)).toBeCloseTo(before, 9)
    // 10 m of depth through a 46 degree lens, plus the margin.
    expect(camera.distance).toBeCloseTo(framedDistance(10), 4)

    // What the margin is for: the panels and labels sit over the edges, so the
    // plan has to finish well inside the frustum.
    const halfHeight = TAN_HALF_FOV * camera.distance
    expect(halfHeight).toBeGreaterThan(5)
    expect(halfHeight * 2).toBeGreaterThan(10)
  })

  it('frames a wide plan by its width and a deep one by its depth', () => {
    // In a 2:1 viewport a 60 m frontage and a 30 m depth are the same shot.
    const wide = rig(1000, 500)
    wide.frame(bounds(0, 0, 60, 4), false)
    const deep = rig(1000, 500)
    deep.frame(bounds(0, 0, 4, 30), false)
    expect(wide.distance).toBeCloseTo(deep.distance, 6)
    expect(wide.distance).toBeCloseTo(framedDistance(30), 4)
  })

  it('keeps a usable view of a plan too small to frame', () => {
    // Framing a single chair, or a plan with one wall in it, must not put the
    // camera inside the geometry.
    const camera = rig()
    camera.frame(bounds(3, 3, 3.2, 3.2), false)
    expect(camera.targetPoint.x).toBeCloseTo(3.1, 6)
    expect(camera.targetPoint.z).toBeCloseTo(3.1, 6)
    expect(camera.distance).toBeCloseTo(framedDistance(1), 4)
    expect(camera.distance).toBeGreaterThanOrEqual(camera.minDistance)
  })

  it('stops at the far limit rather than framing a site it cannot draw', () => {
    const camera = rig()
    camera.frame(bounds(-2500, -2500, 2500, 2500), false)
    expect(camera.distance).toBe(camera.maxDistance)
  })

  it('frames the same extent through either projection', () => {
    // Switching between plan and 3D must not jump, so the orthographic frustum
    // is sized from the perspective camera's field of view.
    const camera = rig(1000, 500)
    camera.frame(bounds(0, 0, 20, 10), false)
    const halfHeight = TAN_HALF_FOV * camera.distance
    expect(camera.orthographicCamera.top).toBeCloseTo(halfHeight, 6)
    expect(camera.orthographicCamera.bottom).toBeCloseTo(-halfHeight, 6)
    expect(camera.orthographicCamera.right).toBeCloseTo(halfHeight * 2, 6)
    expect(camera.orthographicCamera.left).toBeCloseTo(-halfHeight * 2, 6)
  })

  it('reports metres per pixel from the distance and the viewport', () => {
    const camera = rig(1000, 500)
    camera.frame(bounds(0, 0, 20, 10), false)
    const perPixel = camera.worldPerPixel()
    expect(perPixel).toBeCloseTo((TAN_HALF_FOV * camera.distance * 2) / 500, 9)

    // Snap tolerances are quoted in pixels, so a taller viewport has to mean
    // finer metres per pixel at the same zoom.
    camera.setViewportSize(1000, 1000)
    expect(camera.worldPerPixel()).toBeCloseTo(perPixel / 2, 9)
  })

  it('survives a viewport with no area', () => {
    // A collapsed panel reports 0 x 0 before it settles. Snap tolerances are
    // quoted in pixels and divided by this, so an infinite or zero metres per
    // pixel puts either everything or nothing under the cursor.
    const camera = rig(0, 0)
    expect(camera.perspectiveCamera.aspect).toBe(1)
    expect(camera.worldPerPixel()).toBeCloseTo(TAN_HALF_FOV * camera.distance * 2, 9)
    expect(camera.orthographicCamera.right).toBeCloseTo(TAN_HALF_FOV * camera.distance, 9)
  })

  it('stops framing on the aspect when the viewport is a sliver', () => {
    // A docked panel can leave the canvas one tenth as wide as it is tall.
    // Fitting a 30 m frontage across that would put the camera 440 m up; the
    // rig caps the aspect it will divide by at 0.2 instead, and the frontage
    // spills off the sides rather than the view retreating into orbit.
    const camera = rig(100, 1000)
    camera.frame(bounds(0, 0, 30, 4), false)
    expect(camera.distance).toBeCloseTo(framedDistance(30 / 0.2), 4)

    const halfWidth = TAN_HALF_FOV * camera.distance * 0.1
    expect(halfWidth * 2).toBeLessThan(30)
  })
})

describe('navigating', () => {
  it('moves the ground exactly as far as the pointer dragged it', () => {
    const camera = rig(1000, 500)
    const perPixel = camera.worldPerPixel()
    const start = camera.targetPoint.clone()

    camera.pan(100, 0)
    const across = camera.targetPoint.clone().sub(start)
    expect(across.length()).toBeCloseTo(100 * perPixel, 9)
    // Panning is along the ground; the camera never rises off the target plane.
    expect(camera.targetPoint.y).toBe(0)

    const middle = camera.targetPoint.clone()
    camera.pan(0, 100)
    const down = camera.targetPoint.clone().sub(middle)
    expect(down.length()).toBeCloseTo(100 * perPixel, 9)
    // The two drag axes have to stay square or the plan skews as you move.
    expect(across.dot(down)).toBeCloseTo(0, 9)
    expect(camera.distance).toBeCloseTo(26, 9)
  })

  it('zooms towards the point under the cursor', () => {
    const camera = rig()
    const before = camera.distance
    camera.zoom(-500, { x: 10, z: 4 })
    const ratio = camera.distance / before
    expect(ratio).toBeCloseTo(Math.exp(-500 * 0.0014), 9)

    // The point under the cursor keeps its place on screen: its offset from the
    // target shrinks by exactly the zoom ratio. That is what makes wheel zoom
    // feel aimed rather than approximate.
    expect(10 - camera.targetPoint.x).toBeCloseTo(10 * ratio, 6)
    expect(4 - camera.targetPoint.z).toBeCloseTo(4 * ratio, 6)
  })

  it('stops sliding the view once it has nothing left to zoom', () => {
    const camera = rig()
    camera.zoom(-100000, { x: 10, z: 4 })
    expect(camera.distance).toBe(camera.minDistance)

    const stuck = camera.targetPoint.clone()
    camera.zoom(-100000, { x: 10, z: 4 })
    expect(camera.targetPoint.toArray()).toEqual(stuck.toArray())
  })

  it('never lets an orbit put the camera under the floor', () => {
    const camera = rig()
    camera.orbit(0, 100000)
    const offset = camera.camera.position.clone().sub(camera.targetPoint)
    // Below the ground plane the whole plan would be drawn from underneath.
    expect(offset.y).toBeGreaterThan(0)
    expect(offset.y).toBeCloseTo(camera.distance * Math.cos(Math.PI / 2 - 0.02), 4)

    camera.orbit(0, -100000)
    expect(camera.camera.position.y).toBeCloseTo(camera.distance, 3)
  })

  it('leaves the plan view as soon as the user tips the camera', () => {
    const camera = rig()
    camera.setPreset('plan', false)
    expect(camera.isPlanView).toBe(true)
    expect(camera.camera).toBe(camera.orthographicCamera)

    camera.orbit(0, 40)
    // A tipped orthographic view reads as a broken drawing, so tipping means 3D.
    expect(camera.isPlanView).toBe(false)
    expect(camera.camera).toBe(camera.perspectiveCamera)
  })

  it('turns the camera around the plan by the pixels dragged', () => {
    const camera = rig()
    const before = azimuthOf(camera)
    camera.orbit(100, 0)
    expect(azimuthOf(camera)).toBeCloseTo(before - 100 * 0.006, 6)
  })

  it('tells the host to redraw whenever the camera has moved', () => {
    // Rendering is on demand: a camera that moves without saying so leaves the
    // viewport showing the last frame.
    const camera = rig()
    const onChange = vi.fn()
    camera.onChange = onChange
    camera.pan(10, 10)
    camera.zoom(-100)
    camera.orbit(5, 5)
    expect(onChange).toHaveBeenCalledTimes(3)
  })

  it('pulls in close for the eye-level view and keeps the near plane off the lens', () => {
    const camera = rig()
    camera.setPreset('eye', false)
    expect(camera.distance).toBe(14)
    expect(camera.perspectiveCamera.near).toBeCloseTo(Math.max(0.05, 14 * 0.008), 9)
    expect(camera.perspectiveCamera.far).toBeCloseTo(14 * 12 + 200, 9)
    // Standing on the floor, not hovering over it.
    expect(camera.camera.position.y).toBeCloseTo(14 * Math.cos(VIEW_PRESETS.eye.polar), 6)
  })
})

describe('transitions', () => {
  it('eases into the preset and lands exactly on it', () => {
    const camera = rig()
    camera.setPreset('plan')
    expect(camera.isPlanView).toBe(false)

    let moving = camera.update(0.2)
    expect(moving).toBe(true)
    let guard = 0
    while (moving && guard++ < 100) moving = camera.update(0.1)

    expect(guard).toBeLessThan(100)
    expect(camera.isPlanView).toBe(true)
    expect(camera.camera).toBe(camera.orthographicCamera)
    expect(azimuthOf(camera)).toBeCloseTo(VIEW_PRESETS.plan.azimuth, 6)
    // Nothing left to advance once it has arrived.
    expect(camera.update(0.1)).toBe(false)
  })

  it('takes the short way round when the azimuth wraps', () => {
    const camera = rig()
    camera.restore(JSON.stringify([0, 0, 3.0, 1.0, 20, 1]))
    camera.setPreset('front')

    camera.update(0.55 / 2)
    // Half way through a cubic ease is half the turn. Going the long way would
    // swing the whole plan past the camera and back.
    const delta = VIEW_PRESETS.front.azimuth - 3.0 + Math.PI * 2
    expect(azimuthOf(camera)).toBeCloseTo(3.0 + delta / 2 - Math.PI * 2, 4)
  })

  it('gives the camera up the moment the user grabs it', () => {
    const camera = rig()
    camera.setPreset('front')
    expect(camera.update(0.1)).toBe(true)

    camera.orbit(20, 0)
    // The tween must not keep dragging the view out from under the drag.
    expect(camera.update(0.1)).toBe(false)
  })

  it('jumps straight there when asked not to animate', () => {
    const camera = rig()
    camera.lookAtPoint(12, -4, false)
    expect(camera.targetPoint.toArray()).toEqual([12, 0, -4])
    expect(camera.update(0.1)).toBe(false)
  })
})

describe('saving the view', () => {
  it('comes back to the same shot after a reload', () => {
    const camera = rig()
    camera.frame(bounds(2, 2, 22, 14), false)
    camera.orbit(30, 20)
    camera.zoom(-120)
    const snapshot = camera.snapshot()

    const restored = rig()
    restored.restore(snapshot)
    expect(restored.distance).toBeCloseTo(camera.distance, 9)
    expect(restored.targetPoint.toArray()).toEqual(camera.targetPoint.toArray())
    expect(restored.camera.position.distanceTo(camera.camera.position)).toBeCloseTo(0, 9)
  })

  it('keeps the default view when the stored pose cannot be read', () => {
    const camera = rig()
    const before = camera.camera.position.clone()
    for (const stored of ['', 'not json', '[1,2,3]', '[null,0,0,0,0,0]', '{}']) {
      camera.restore(stored)
      expect(camera.camera.position.distanceTo(before)).toBeCloseTo(0, 9)
    }
  })

  it('pulls a stored pose back inside the limits', () => {
    // A pose from an older build, or an edited one, must not be able to put the
    // camera under the floor or beyond the far plane.
    const camera = rig()
    camera.restore(JSON.stringify([0, 0, 0.5, 3.0, 99999, 1]))
    expect(camera.distance).toBe(camera.maxDistance)
    expect(camera.camera.position.clone().sub(camera.targetPoint).y).toBeGreaterThan(0)

    camera.restore(JSON.stringify([0, 0, 0.5, -5, 0.001, 1]))
    expect(camera.distance).toBe(camera.minDistance)
    expect(camera.camera.position.clone().sub(camera.targetPoint).y).toBeCloseTo(
      camera.minDistance,
      3,
    )
  })

  it('stores the pose as six numbers in the order it reads them back', () => {
    // `restore` destructures this array positionally, so the two have to agree
    // on the order; a pose written by one build and read by the next would
    // otherwise land the user somewhere unrelated with no way to say why.
    const camera = rig()
    camera.lookAtPoint(5, 7, false)
    const stored = JSON.parse(camera.snapshot()) as number[]
    expect(stored).toHaveLength(6)

    const [x, z, azimuth, polar, distance, perspective] = stored
    expect([x, z]).toEqual([5, 7])
    // Centring on a point must not turn the camera or change the zoom.
    expect(azimuth).toBeCloseTo(VIEW_PRESETS.iso.azimuth, 9)
    expect(polar).toBeCloseTo(VIEW_PRESETS.iso.polar, 9)
    expect(distance).toBeCloseTo(26, 9)
    expect(perspective).toBe(1)
  })
})
