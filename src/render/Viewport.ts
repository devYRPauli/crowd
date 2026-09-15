/**
 * The 3D viewport.
 *
 * Owns the renderer, the scene graph and all pointer input, and exposes a small
 * imperative surface to React. Rendering is on demand: a frame is drawn when
 * something changed, when the camera is moving, or continuously while a
 * simulation is playing — an idle editor uses no GPU at all.
 *
 * Input convention: the left button always belongs to the active tool. The
 * right and middle buttons, the wheel and Space-drag navigate. That separation
 * is what lets drawing feel direct rather than modal.
 */

import {
  ACESFilmicToneMapping,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Line,
  LineLoop,
  Mesh,
  PCFSoftShadowMap,
  Plane,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three'
import type { CrowdDocument, PlanObjectRef } from '../core/model/types'
import type { Vec2 } from '../core/math/vec2'
import type { Bounds } from '../core/math/geometry'
import { CameraRig, type ViewPreset } from './CameraRig'
import { MaterialLibrary, type ThemeName } from './theme'
import { GroundGrid } from './overlays/GroundGrid'
import { PlanRenderer, DEFAULT_PLAN_OPTIONS, type PlanRenderOptions, polygonLine, polylineGeometry } from './PlanRenderer'
import { LabelLayer, type Label } from './LabelLayer'
import { furnitureVisualPolygon, servicePolygon, wallPolygon } from '../core/model/planGeometry'

export interface PickHit {
  ref: PlanObjectRef
  /** Ground-plane position of the hit. */
  point: Vec2
  /** Height of the hit above the floor. */
  height: number
}

export interface PointerInfo {
  /** Where the pointer meets the ground plane, if it does. */
  ground: Vec2 | null
  screenX: number
  screenY: number
  button: number
  buttons: number
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  hit: PickHit | null
  /** Metres per screen pixel at the ground plane, for hit tolerances. */
  scale: number
}

export interface ViewportHandlers {
  onPointerDown?: (info: PointerInfo) => void
  onPointerMove?: (info: PointerInfo) => void
  onPointerUp?: (info: PointerInfo) => void
  onDoubleClick?: (info: PointerInfo) => void
  onPointerLeave?: () => void
  onCameraChange?: () => void
}

/** Transient geometry a tool draws while the user is mid-gesture. */
export interface DraftShape {
  kind: 'polyline' | 'polygon' | 'marker' | 'rect'
  points: Vec2[]
  color?: string
  /** Fill a polygon or rect as well as outlining it. */
  filled?: boolean
  height?: number
}

export class Viewport {
  readonly scene = new Scene()
  readonly rig = new CameraRig()
  readonly crowdLayer = new Group()
  readonly overlayLayer = new Group()

  private renderer: WebGLRenderer
  private materials: MaterialLibrary
  private planRenderer: PlanRenderer
  private grid: GroundGrid
  private labels: LabelLayer
  private sun: DirectionalLight
  private ambient: AmbientLight
  private hemisphere: HemisphereLight

  private selectionGroup = new Group()
  private draftGroup = new Group()

  private raycaster = new Raycaster()
  private pointer = new Vector2()
  private groundPlane = new Plane(new Vector3(0, 1, 0), 0)

  private container: HTMLElement
  private resizeObserver: ResizeObserver | null = null
  private frameHandle = 0
  private lastTime = 0
  private dirty = true
  private continuous = false
  private disposed = false

  private width = 1
  private height = 1

  private document: CrowdDocument | null = null
  private planOptions: PlanRenderOptions = { ...DEFAULT_PLAN_OPTIONS }
  private selection: PlanObjectRef[] = []
  private hover: PlanObjectRef | null = null

  private navigating: 'orbit' | 'pan' | null = null
  private lastPointer = { x: 0, y: 0 }
  private spaceHeld = false
  private capturedPointerId: number | null = null

  handlers: ViewportHandlers = {}

  constructor(container: HTMLElement, theme: ThemeName = 'light') {
    this.container = container
    this.materials = new MaterialLibrary(theme)

    this.renderer = new WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.toneMapping = ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = PCFSoftShadowMap
    this.renderer.domElement.className = 'viewport-canvas'
    this.renderer.domElement.tabIndex = 0
    container.appendChild(this.renderer.domElement)

    this.scene.background = new Color(this.materials.palette.background).convertSRGBToLinear()

    this.hemisphere = new HemisphereLight(0xffffff, 0x8a8f96, 1.35)
    this.ambient = new AmbientLight(0xffffff, 0.35)
    this.sun = new DirectionalLight(0xfff6e8, 2.1)
    this.sun.position.set(-18, 30, -14)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.camera.near = 1
    this.sun.shadow.camera.far = 160
    this.sun.shadow.camera.left = -40
    this.sun.shadow.camera.right = 40
    this.sun.shadow.camera.top = 40
    this.sun.shadow.camera.bottom = -40
    this.sun.shadow.bias = -0.0006
    this.sun.shadow.normalBias = 0.02
    this.scene.add(this.hemisphere, this.ambient, this.sun, this.sun.target)

    this.grid = new GroundGrid(this.materials.palette)
    this.scene.add(this.grid.mesh)

    this.planRenderer = new PlanRenderer(this.materials)
    this.scene.add(this.planRenderer.root)
    this.crowdLayer.name = 'crowd'
    this.overlayLayer.name = 'overlay'
    this.selectionGroup.name = 'selection'
    this.draftGroup.name = 'draft'
    this.scene.add(this.crowdLayer, this.overlayLayer, this.selectionGroup, this.draftGroup)

    this.labels = new LabelLayer(container)

    this.rig.onChange = () => {
      this.dirty = true
      this.handlers.onCameraChange?.()
    }
    this.rig.setPreset('iso', false)

    this.attachEvents()
    this.observeResize()
    this.start()
  }

  // --- lifecycle -------------------------------------------------------------

  private observeResize(): void {
    const apply = () => {
      const rect = this.container.getBoundingClientRect()
      this.width = Math.max(1, Math.floor(rect.width))
      this.height = Math.max(1, Math.floor(rect.height))
      this.renderer.setSize(this.width, this.height, false)
      this.rig.setViewportSize(this.width, this.height)
      this.dirty = true
    }
    apply()
    this.resizeObserver = new ResizeObserver(apply)
    this.resizeObserver.observe(this.container)
  }

  private start(): void {
    const loop = (time: number) => {
      if (this.disposed) return
      this.frameHandle = requestAnimationFrame(loop)
      const dt = this.lastTime === 0 ? 0 : Math.min(0.1, (time - this.lastTime) / 1000)
      this.lastTime = time
      const moving = this.rig.update(dt)
      if (!this.dirty && !moving && !this.continuous) return
      this.dirty = false
      this.renderFrame()
    }
    this.frameHandle = requestAnimationFrame(loop)
  }

  private renderFrame(): void {
    const camera = this.rig.camera
    this.grid.update(camera.position, this.rig.distance)
    this.sun.target.position.set(this.rig.targetPoint.x, 0, this.rig.targetPoint.z)
    this.sun.position.set(
      this.rig.targetPoint.x - 18,
      30,
      this.rig.targetPoint.z - 14,
    )
    this.sun.target.updateMatrixWorld()
    this.renderer.render(this.scene, camera)
    this.labels.update(camera, this.width, this.height)
  }

  invalidate(): void {
    this.dirty = true
  }

  /** Keep drawing every frame — used while a simulation plays. */
  setContinuous(value: boolean): void {
    this.continuous = value
    if (value) this.dirty = true
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.frameHandle)
    this.resizeObserver?.disconnect()
    this.detachEvents()
    this.planRenderer.dispose()
    this.grid.dispose()
    this.labels.dispose()
    this.materials.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  // --- content ---------------------------------------------------------------

  setDocument(doc: CrowdDocument, options?: Partial<PlanRenderOptions>): void {
    this.document = doc
    if (options) this.planOptions = { ...this.planOptions, ...options }
    this.grid.setCellSize(doc.settings.gridSize)
    this.planRenderer.update(doc, this.planOptions)
    this.refreshSelectionOverlay()
    this.dirty = true
  }

  setPlanOptions(options: Partial<PlanRenderOptions>): void {
    this.planOptions = { ...this.planOptions, ...options }
    if (this.document) this.planRenderer.update(this.document, this.planOptions)
    this.dirty = true
  }

  setTheme(theme: ThemeName): void {
    this.materials.setTheme(theme)
    this.scene.background = new Color(this.materials.palette.background).convertSRGBToLinear()
    this.grid.setPalette(this.materials.palette)
    this.planRenderer.setMaterials(this.materials)
    if (this.document) this.planRenderer.update(this.document, this.planOptions)
    this.refreshSelectionOverlay()
    this.dirty = true
  }

  get materialLibrary(): MaterialLibrary {
    return this.materials
  }

  get rooms() {
    return this.planRenderer.detectedRooms
  }

  setGridVisible(visible: boolean): void {
    this.grid.setVisible(visible)
    this.dirty = true
  }

  setSelection(refs: PlanObjectRef[]): void {
    this.selection = refs
    this.refreshSelectionOverlay()
    this.dirty = true
  }

  setHover(ref: PlanObjectRef | null): void {
    const changed = ref?.id !== this.hover?.id || ref?.kind !== this.hover?.kind
    this.hover = ref
    if (changed) {
      this.refreshSelectionOverlay()
      this.dirty = true
    }
  }

  setLabels(labels: Label[]): void {
    this.labels.set(labels)
    this.dirty = true
  }

  /** Replace the transient geometry drawn by the active tool. */
  setDraft(shapes: DraftShape[]): void {
    this.draftGroup.traverse((child) => {
      const mesh = child as Mesh
      if (mesh.geometry) mesh.geometry.dispose()
    })
    this.draftGroup.clear()
    const draftColor = this.materials.palette.draft
    for (const shape of shapes) {
      const color = shape.color ?? draftColor
      const height = shape.height ?? 0.03
      if (shape.points.length < 2) {
        if (shape.points.length === 1) {
          const marker = new LineLoop(
            polygonLine(
              Array.from({ length: 16 }, (_, i) => {
                const a = (i / 16) * Math.PI * 2
                return {
                  x: shape.points[0].x + Math.cos(a) * 0.12,
                  y: shape.points[0].y + Math.sin(a) * 0.12,
                }
              }),
              height,
            ),
            this.materials.line(color),
          )
          marker.renderOrder = 20
          this.draftGroup.add(marker)
        }
        continue
      }
      if (shape.kind === 'polygon' || shape.kind === 'rect') {
        const loop = new LineLoop(polygonLine(shape.points, height), this.materials.line(color))
        loop.renderOrder = 20
        this.draftGroup.add(loop)
        if (shape.filled) {
          const fill = new Mesh(
            this.fillGeometry(shape.points, height - 0.004),
            this.materials.overlay(color, 0.16),
          )
          fill.renderOrder = 19
          this.draftGroup.add(fill)
        }
      } else {
        const line = new Line(polylineGeometry(shape.points, height), this.materials.line(color))
        line.renderOrder = 20
        this.draftGroup.add(line)
      }
    }
    this.dirty = true
  }

  private fillGeometry(points: Vec2[], height: number): BufferGeometry {
    // Triangle fan: draft fills are always convex quads or simple polygons.
    const vertices: number[] = []
    for (let i = 1; i < points.length - 1; i++) {
      vertices.push(
        points[0].x, height, points[0].y,
        points[i].x, height, points[i].y,
        points[i + 1].x, height, points[i + 1].y,
      )
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertices), 3))
    return geometry
  }

  private refreshSelectionOverlay(): void {
    this.selectionGroup.traverse((child) => {
      const mesh = child as Mesh
      if (mesh.geometry) mesh.geometry.dispose()
    })
    this.selectionGroup.clear()
    if (!this.document) return
    const draw = (ref: PlanObjectRef, color: string, opacity: number) => {
      const polygon = this.footprintOf(ref)
      if (!polygon || polygon.length < 3) return
      const loop = new LineLoop(polygonLine(polygon, 0.035), this.materials.line(color, opacity))
      loop.renderOrder = 30
      this.selectionGroup.add(loop)
      const fill = new Mesh(this.fillGeometry(polygon, 0.03), this.materials.overlay(color, opacity * 0.22))
      fill.renderOrder = 29
      this.selectionGroup.add(fill)
    }
    if (this.hover && !this.selection.some((r) => r.id === this.hover?.id)) {
      draw(this.hover, this.materials.palette.hover, 0.85)
    }
    for (const ref of this.selection) draw(ref, this.materials.palette.selection, 1)
  }

  /** Ground footprint of a plan object, used for selection and hover feedback. */
  footprintOf(ref: PlanObjectRef): Vec2[] | null {
    const doc = this.document
    if (!doc) return null
    switch (ref.kind) {
      case 'wall': {
        const wall = doc.plan.walls.find((w) => w.id === ref.id)
        return wall ? wallPolygon(wall, 0.02) : null
      }
      case 'furniture': {
        const item = doc.plan.furniture.find((f) => f.id === ref.id)
        return item ? furnitureVisualPolygon(item) : null
      }
      case 'zone': {
        const zone = doc.plan.zones.find((z) => z.id === ref.id)
        return zone ? zone.polygon : null
      }
      case 'service': {
        const point = doc.plan.servicePoints.find((s) => s.id === ref.id)
        return point ? servicePolygon(point, 0.03) : null
      }
      case 'opening': {
        const opening = doc.plan.openings.find((o) => o.id === ref.id)
        if (!opening) return null
        const wall = doc.plan.walls.find((w) => w.id === opening.wallId)
        if (!wall) return null
        const angle = Math.atan2(wall.b.y - wall.a.y, wall.b.x - wall.a.x)
        const cx = wall.a.x + Math.cos(angle) * opening.offset
        const cy = wall.a.y + Math.sin(angle) * opening.offset
        const hw = opening.width / 2
        const hd = wall.thickness / 2 + 0.05
        const c = Math.cos(angle)
        const s = Math.sin(angle)
        return [
          [-hw, -hd],
          [hw, -hd],
          [hw, hd],
          [-hw, hd],
        ].map(([x, y]) => ({ x: cx + x * c - y * s, y: cy + x * s + y * c }))
      }
      case 'backdrop': {
        const backdrop = doc.plan.backdrop
        if (!backdrop) return null
        const hw = backdrop.width / 2
        const hd = backdrop.depth / 2
        const c = Math.cos(backdrop.rotation)
        const s = Math.sin(backdrop.rotation)
        return [
          [-hw, -hd],
          [hw, -hd],
          [hw, hd],
          [-hw, hd],
        ].map(([x, y]) => ({
          x: backdrop.position.x + x * c - y * s,
          y: backdrop.position.y + x * s + y * c,
        }))
      }
    }
  }

  // --- camera ----------------------------------------------------------------

  setView(preset: ViewPreset, animate = true): void {
    this.rig.setPreset(preset, animate)
  }

  frame(bounds: Bounds, animate = true): void {
    this.rig.frame(bounds, animate)
  }

  get isPlanView(): boolean {
    return this.rig.isPlanView
  }

  get worldPerPixel(): number {
    return this.rig.worldPerPixel()
  }

  cameraSnapshot(): string {
    return this.rig.snapshot()
  }

  restoreCamera(snapshot: string): void {
    this.rig.restore(snapshot)
  }

  // --- picking ---------------------------------------------------------------

  private updatePointer(clientX: number, clientY: number): void {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1
  }

  /** Where the pointer meets the floor plane. */
  screenToGround(clientX: number, clientY: number): Vec2 | null {
    this.updatePointer(clientX, clientY)
    this.raycaster.setFromCamera(this.pointer, this.rig.camera)
    const target = new Vector3()
    const hit = this.raycaster.ray.intersectPlane(this.groundPlane, target)
    return hit ? { x: target.x, y: target.z } : null
  }

  /** Project a world point to canvas pixels. */
  worldToScreen(x: number, z: number, y = 0): { x: number; y: number } {
    const v = new Vector3(x, y, z).project(this.rig.camera)
    return { x: (v.x * 0.5 + 0.5) * this.width, y: (-v.y * 0.5 + 0.5) * this.height }
  }

  pickAt(clientX: number, clientY: number): PickHit | null {
    this.updatePointer(clientX, clientY)
    this.raycaster.setFromCamera(this.pointer, this.rig.camera)
    const targets: Object3D[] = this.planRenderer.pickables
    const hits = this.raycaster.intersectObjects(targets, false)
    for (const hit of hits) {
      const ref = this.planRenderer.refForInstance(hit.object, hit.instanceId)
      if (!ref) continue
      return { ref, point: { x: hit.point.x, y: hit.point.z }, height: hit.point.y }
    }
    return null
  }

  private pointerInfo(event: PointerEvent | MouseEvent): PointerInfo {
    const rect = this.renderer.domElement.getBoundingClientRect()
    return {
      ground: this.screenToGround(event.clientX, event.clientY),
      screenX: event.clientX - rect.left,
      screenY: event.clientY - rect.top,
      button: event.button,
      buttons: event.buttons,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      hit: this.pickAt(event.clientX, event.clientY),
      scale: this.rig.worldPerPixel(),
    }
  }

  // --- input -----------------------------------------------------------------

  private onPointerDown = (event: PointerEvent): void => {
    const canvas = this.renderer.domElement
    canvas.focus({ preventScroll: true })
    const navigate =
      event.button === 2 || event.button === 1 || (event.button === 0 && this.spaceHeld)
    if (navigate) {
      event.preventDefault()
      this.navigating = event.button === 1 || this.spaceHeld || event.shiftKey ? 'pan' : 'orbit'
      this.lastPointer = { x: event.clientX, y: event.clientY }
      this.capturedPointerId = event.pointerId
      canvas.setPointerCapture(event.pointerId)
      return
    }
    if (event.button !== 0) return
    this.capturedPointerId = event.pointerId
    canvas.setPointerCapture(event.pointerId)
    this.handlers.onPointerDown?.(this.pointerInfo(event))
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (this.navigating) {
      const dx = event.clientX - this.lastPointer.x
      const dy = event.clientY - this.lastPointer.y
      this.lastPointer = { x: event.clientX, y: event.clientY }
      if (this.navigating === 'orbit') this.rig.orbit(dx, dy)
      else this.rig.pan(dx, dy)
      return
    }
    this.handlers.onPointerMove?.(this.pointerInfo(event))
  }

  private onPointerUp = (event: PointerEvent): void => {
    if (this.capturedPointerId === event.pointerId) {
      this.renderer.domElement.releasePointerCapture?.(event.pointerId)
      this.capturedPointerId = null
    }
    if (this.navigating) {
      this.navigating = null
      return
    }
    if (event.button !== 0) return
    this.handlers.onPointerUp?.(this.pointerInfo(event))
  }

  private onDoubleClick = (event: MouseEvent): void => {
    this.handlers.onDoubleClick?.(this.pointerInfo(event))
  }

  private onPointerLeave = (): void => {
    this.handlers.onPointerLeave?.()
  }

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    const ground = this.screenToGround(event.clientX, event.clientY)
    const normalized = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
    this.rig.zoom(normalized, ground ? { x: ground.x, z: ground.y } : undefined)
  }

  private onContextMenu = (event: MouseEvent): void => {
    event.preventDefault()
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Space') this.spaceHeld = true
  }

  private onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === 'Space') this.spaceHeld = false
  }

  private attachEvents(): void {
    const canvas = this.renderer.domElement
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointerleave', this.onPointerLeave)
    canvas.addEventListener('dblclick', this.onDoubleClick)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('contextmenu', this.onContextMenu)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
  }

  private detachEvents(): void {
    const canvas = this.renderer.domElement
    canvas.removeEventListener('pointerdown', this.onPointerDown)
    canvas.removeEventListener('pointermove', this.onPointerMove)
    canvas.removeEventListener('pointerup', this.onPointerUp)
    canvas.removeEventListener('pointerleave', this.onPointerLeave)
    canvas.removeEventListener('dblclick', this.onDoubleClick)
    canvas.removeEventListener('wheel', this.onWheel)
    canvas.removeEventListener('contextmenu', this.onContextMenu)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
  }

  /** Render one frame and return it as a PNG data URL. */
  captureImage(scale = 2): string {
    const previousRatio = this.renderer.getPixelRatio()
    this.renderer.setPixelRatio(Math.min(scale, 4))
    this.renderer.setSize(this.width, this.height, false)
    this.renderFrame()
    const url = this.renderer.domElement.toDataURL('image/png')
    this.renderer.setPixelRatio(previousRatio)
    this.renderer.setSize(this.width, this.height, false)
    this.dirty = true
    return url
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement
  }

  get webglRenderer(): WebGLRenderer {
    return this.renderer
  }
}


