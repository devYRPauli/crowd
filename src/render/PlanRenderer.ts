/**
 * Draws the plan.
 *
 * The document is immutable and structurally shared, so this class can tell
 * exactly what changed by comparing array identities: move one chair and only
 * the furniture layer rebuilds. Each layer keeps its own meshes and its own
 * pickable objects, and every pickable mesh carries the `PlanObjectRef` it
 * stands for, so hit-testing needs no side tables.
 */

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Line,
  LineLoop,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Texture,
  TextureLoader,
} from 'three'
import type { CrowdDocument, Plan, PlanObjectRef } from '../core/model/types'
import type { Room } from '../core/model/rooms'
import { detectRooms } from '../core/model/rooms'
import {
  furnitureSize,
  planSeats,
  serverPositions,
  serviceQueue,
  servicePolygon,
  wallAngle,
  wallLength,
} from '../core/model/planGeometry'
import { resolveCatalogItem } from '../library/catalog'
import type { MaterialLibrary } from './theme'
import { ZONE_COLORS } from '../core/model/defaults'
import {
  buildFloorGeometry,
  buildOpeningGeometry,
  buildWallGeometry,
  polygonGeometry,
} from './builders/planMeshes'
import { getFurnitureGeometry, furnitureGeometryKey, pruneFurnitureGeometry } from './builders/furnitureGeometry'
import type { Vec2 } from '../core/math/vec2'

const OUTLINE_LIFT = 0.012

const polygonLine = (polygon: readonly Vec2[], height: number): BufferGeometry => {
  const positions = new Float32Array(polygon.length * 3)
  polygon.forEach((p, i) => {
    positions[i * 3] = p.x
    positions[i * 3 + 1] = height
    positions[i * 3 + 2] = p.y
  })
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  return geometry
}

const polylineGeometry = (points: readonly Vec2[], height: number): BufferGeometry => {
  const positions = new Float32Array(points.length * 3)
  points.forEach((p, i) => {
    positions[i * 3] = p.x
    positions[i * 3 + 1] = height
    positions[i * 3 + 2] = p.y
  })
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  return geometry
}

const disposeTree = (root: Object3D): void => {
  root.traverse((child) => {
    const mesh = child as Mesh
    if (mesh.geometry) mesh.geometry.dispose()
  })
  root.clear()
}

export interface PlanRenderOptions {
  showZones: boolean
  showSeats: boolean
  showQueues: boolean
  showFurniture: boolean
  showCeilingWalls: boolean
  /** Fade walls down to this height so a plan view stays readable. */
  wallCutHeight: number | null
}

export const DEFAULT_PLAN_OPTIONS: PlanRenderOptions = {
  showZones: true,
  showSeats: false,
  showQueues: true,
  showFurniture: true,
  showCeilingWalls: true,
  wallCutHeight: null,
}

export class PlanRenderer {
  readonly root = new Group()

  private readonly floorGroup = new Group()
  private readonly wallGroup = new Group()
  private readonly openingGroup = new Group()
  private readonly furnitureGroup = new Group()
  private readonly zoneGroup = new Group()
  private readonly serviceGroup = new Group()
  private readonly seatGroup = new Group()
  private readonly backdropGroup = new Group()

  /** Meshes that hit-testing considers, in draw order. */
  readonly pickables: Object3D[] = []

  private lastPlan: Plan | null = null
  private lastOptions: PlanRenderOptions = { ...DEFAULT_PLAN_OPTIONS }
  private rooms: Room[] = []
  private backdropTexture: Texture | null = null
  private backdropSrc: string | null = null

  constructor(private materials: MaterialLibrary) {
    this.root.name = 'plan'
    this.root.add(
      this.backdropGroup,
      this.floorGroup,
      this.zoneGroup,
      this.wallGroup,
      this.openingGroup,
      this.furnitureGroup,
      this.serviceGroup,
      this.seatGroup,
    )
  }

  get detectedRooms(): Room[] {
    return this.rooms
  }

  /** Rebuild only the layers whose inputs changed. */
  update(document: CrowdDocument, options: PlanRenderOptions): void {
    const plan = document.plan
    const previous = this.lastPlan
    const optionsChanged =
      options.showZones !== this.lastOptions.showZones ||
      options.showSeats !== this.lastOptions.showSeats ||
      options.showQueues !== this.lastOptions.showQueues ||
      options.showFurniture !== this.lastOptions.showFurniture ||
      options.wallCutHeight !== this.lastOptions.wallCutHeight

    const wallsChanged = !previous || previous.walls !== plan.walls || previous.openings !== plan.openings
    if (wallsChanged || optionsChanged) {
      this.rebuildWalls(plan, options)
      this.rebuildFloors(plan)
    }
    if (!previous || previous.furniture !== plan.furniture || optionsChanged) {
      this.rebuildFurniture(plan, options)
    }
    if (!previous || previous.zones !== plan.zones || optionsChanged) {
      this.rebuildZones(plan, options)
    }
    if (!previous || previous.servicePoints !== plan.servicePoints || optionsChanged) {
      this.rebuildServicePoints(plan, options)
    }
    if (!previous || previous.furniture !== plan.furniture || optionsChanged) {
      this.rebuildSeats(plan, options)
    }
    if (!previous || previous.backdrop !== plan.backdrop) {
      this.rebuildBackdrop(plan)
    }

    this.lastPlan = plan
    this.lastOptions = { ...options }
    this.refreshPickables()
  }

  private refreshPickables(): void {
    this.pickables.length = 0
    for (const group of [this.furnitureGroup, this.serviceGroup, this.wallGroup, this.openingGroup, this.zoneGroup, this.backdropGroup]) {
      for (const child of group.children) {
        if ((child as Mesh).isMesh && child.userData.ref) this.pickables.push(child)
      }
    }
  }

  private rebuildWalls(plan: Plan, options: PlanRenderOptions): void {
    disposeTree(this.wallGroup)
    disposeTree(this.openingGroup)

    const cut = options.wallCutHeight
    // Walls are drawn per object rather than merged so each can be picked and
    // highlighted on its own; a plan rarely holds enough of them to matter.
    for (const wall of plan.walls) {
      const length = wallLength(wall)
      if (length <= 1e-4) continue
      const height = cut === null ? wall.height : Math.min(wall.height, cut)
      const single: Plan = { ...plan, walls: [wall] }
      const { solid, glass } = buildWallGeometry(
        cut === null ? single : { ...single, walls: [{ ...wall, height }] },
      )
      if (solid) {
        const mesh = new Mesh(solid, this.materials.wall())
        mesh.castShadow = true
        mesh.receiveShadow = true
        mesh.userData.ref = { kind: 'wall', id: wall.id } satisfies PlanObjectRef
        this.wallGroup.add(mesh)
      }
      if (glass) {
        const mesh = new Mesh(glass, this.materials.glass())
        mesh.userData.ref = { kind: 'wall', id: wall.id } satisfies PlanObjectRef
        this.wallGroup.add(mesh)
      }
    }

    const openings = buildOpeningGeometry(plan)
    if (openings) {
      const mesh = new Mesh(openings, this.materials.wall())
      mesh.castShadow = true
      this.openingGroup.add(mesh)
    }

    // A thin pick target at each opening, so doors can be selected directly.
    for (const opening of plan.openings) {
      const wall = plan.walls.find((w) => w.id === opening.wallId)
      if (!wall) continue
      const angle = wallAngle(wall)
      const geometry = new BoxGeometry(opening.width, Math.max(0.4, opening.height), wall.thickness + 0.08)
      const mesh = new Mesh(geometry, new MeshBasicMaterial({ visible: false }))
      mesh.position.set(
        wall.a.x + Math.cos(angle) * opening.offset,
        opening.sill + Math.max(0.4, opening.height) / 2,
        wall.a.y + Math.sin(angle) * opening.offset,
      )
      mesh.rotation.y = -angle
      mesh.userData.ref = { kind: 'opening', id: opening.id } satisfies PlanObjectRef
      this.openingGroup.add(mesh)
    }
  }

  private rebuildFloors(plan: Plan): void {
    disposeTree(this.floorGroup)
    this.rooms = detectRooms(plan.walls)
    const geometry = buildFloorGeometry(this.rooms.map((room) => room.polygon), 0)
    if (!geometry) return
    const mesh = new Mesh(geometry, this.materials.floor())
    mesh.receiveShadow = true
    mesh.name = 'floor'
    this.floorGroup.add(mesh)
  }

  private rebuildFurniture(plan: Plan, options: PlanRenderOptions): void {
    disposeTree(this.furnitureGroup)
    if (!options.showFurniture) {
      pruneFurnitureGeometry(new Set())
      return
    }

    const groups = new Map<string, { geometry: BufferGeometry; ids: string[]; matrices: Matrix4[] }>()
    const liveKeys = new Set<string>()
    const matrix = new Matrix4()

    for (const item of plan.furniture) {
      const entry = resolveCatalogItem(item.catalogId)
      const size = furnitureSize(item)
      const key = furnitureGeometryKey(entry, size, item.color)
      liveKeys.add(key)
      let group = groups.get(key)
      if (!group) {
        group = { geometry: getFurnitureGeometry(entry, size, item.color), ids: [], matrices: [] }
        groups.set(key, group)
      }
      matrix.makeRotationY(-item.rotation)
      matrix.setPosition(item.position.x, 0, item.position.y)
      group.ids.push(item.id)
      group.matrices.push(matrix.clone())
    }

    for (const group of groups.values()) {
      const mesh = new InstancedMesh(group.geometry, this.materials.furniture(), group.matrices.length)
      mesh.instanceMatrix.setUsage(DynamicDrawUsage)
      group.matrices.forEach((m, index) => mesh.setMatrixAt(index, m))
      mesh.instanceMatrix.needsUpdate = true
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.frustumCulled = false
      mesh.userData.itemIds = group.ids
      mesh.userData.instanced = true
      mesh.userData.ref = { kind: 'furniture', id: group.ids[0] } satisfies PlanObjectRef
      this.furnitureGroup.add(mesh)
    }
    pruneFurnitureGeometry(liveKeys)
  }

  private rebuildZones(plan: Plan, options: PlanRenderOptions): void {
    disposeTree(this.zoneGroup)
    if (!options.showZones) return
    for (const zone of plan.zones) {
      const color = zone.color ?? ZONE_COLORS[zone.kind] ?? '#4c7dd4'
      const fill = new Mesh(
        polygonGeometry(zone.polygon, OUTLINE_LIFT),
        this.materials.overlay(color, zone.kind === 'measure' ? 0.12 : 0.2),
      )
      fill.userData.ref = { kind: 'zone', id: zone.id } satisfies PlanObjectRef
      fill.renderOrder = 2
      this.zoneGroup.add(fill)

      const outline = new LineLoop(
        polygonLine(zone.polygon, OUTLINE_LIFT + 0.002),
        this.materials.line(color, 0.95),
      )
      outline.renderOrder = 3
      this.zoneGroup.add(outline)
    }
  }

  private rebuildServicePoints(plan: Plan, options: PlanRenderOptions): void {
    disposeTree(this.serviceGroup)
    for (const point of plan.servicePoints) {
      const color = point.color ?? '#3f9ab0'
      const counter = new Mesh(
        new BoxGeometry(point.width, 1.05, point.depth),
        this.materials.wall(),
      )
      counter.position.set(point.position.x, 1.05 / 2, point.position.y)
      counter.rotation.y = -point.rotation
      counter.castShadow = true
      counter.receiveShadow = true
      counter.userData.ref = { kind: 'service', id: point.id } satisfies PlanObjectRef
      this.serviceGroup.add(counter)

      const top = new Mesh(
        new BoxGeometry(point.width + 0.08, 0.05, point.depth + 0.08),
        this.materials.overlay(color, 0.9),
      )
      top.position.set(point.position.x, 1.07, point.position.y)
      top.rotation.y = -point.rotation
      this.serviceGroup.add(top)

      const outline = new LineLoop(
        polygonLine(servicePolygon(point), OUTLINE_LIFT),
        this.materials.line(color, 0.8),
      )
      this.serviceGroup.add(outline)

      if (options.showQueues) {
        const queue = serviceQueue(point)
        const line = new Line(polylineGeometry(queue, OUTLINE_LIFT + 0.004), this.materials.line(color, 0.75))
        line.renderOrder = 3
        this.serviceGroup.add(line)

        for (const server of serverPositions(point)) {
          const marker = new LineLoop(
            polygonLine(
              Array.from({ length: 12 }, (_, i) => {
                const a = (i / 12) * Math.PI * 2
                return { x: server.x + Math.cos(a) * 0.22, y: server.y + Math.sin(a) * 0.22 }
              }),
              OUTLINE_LIFT + 0.004,
            ),
            this.materials.line(color, 0.6),
          )
          this.serviceGroup.add(marker)
        }
      }
    }
  }

  private rebuildSeats(plan: Plan, options: PlanRenderOptions): void {
    disposeTree(this.seatGroup)
    if (!options.showSeats) return
    const seats = planSeats(plan)
    if (seats.length === 0) return
    const geometry = new PlaneGeometry(0.34, 0.34)
    geometry.rotateX(-Math.PI / 2)
    const mesh = new InstancedMesh(geometry, this.materials.overlay('#8a7fb8', 0.5), seats.length)
    const matrix = new Matrix4()
    seats.forEach((seat, index) => {
      matrix.makeRotationY(-seat.facing)
      matrix.setPosition(seat.position.x, OUTLINE_LIFT + 0.006, seat.position.y)
      mesh.setMatrixAt(index, matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
    mesh.frustumCulled = false
    this.seatGroup.add(mesh)
  }

  private rebuildBackdrop(plan: Plan): void {
    disposeTree(this.backdropGroup)
    const backdrop = plan.backdrop
    if (!backdrop || !backdrop.visible) return
    if (this.backdropSrc !== backdrop.src) {
      this.backdropTexture?.dispose()
      this.backdropTexture = new TextureLoader().load(backdrop.src)
      this.backdropTexture.colorSpace = 'srgb'
      this.backdropSrc = backdrop.src
    }
    const geometry = new PlaneGeometry(backdrop.width, backdrop.depth)
    geometry.rotateX(-Math.PI / 2)
    const material = new MeshBasicMaterial({
      map: this.backdropTexture,
      transparent: true,
      opacity: backdrop.opacity,
      depthWrite: false,
    })
    const mesh = new Mesh(geometry, material)
    mesh.position.set(backdrop.position.x, -0.002, backdrop.position.y)
    mesh.rotation.y = -backdrop.rotation
    mesh.renderOrder = -50
    mesh.userData.ref = { kind: 'backdrop', id: 'backdrop' } satisfies PlanObjectRef
    this.backdropGroup.add(mesh)
  }

  /** Map an instanced hit back to the furniture item it represents. */
  refForInstance(object: Object3D, instanceId: number | undefined): PlanObjectRef | null {
    const ids = object.userData.itemIds as string[] | undefined
    if (ids && instanceId !== undefined && ids[instanceId]) {
      return { kind: 'furniture', id: ids[instanceId] }
    }
    return (object.userData.ref as PlanObjectRef | undefined) ?? null
  }

  setMaterials(materials: MaterialLibrary): void {
    this.materials = materials
    this.lastPlan = null
  }

  dispose(): void {
    for (const group of [
      this.floorGroup,
      this.wallGroup,
      this.openingGroup,
      this.furnitureGroup,
      this.zoneGroup,
      this.serviceGroup,
      this.seatGroup,
      this.backdropGroup,
    ]) {
      disposeTree(group)
    }
    this.backdropTexture?.dispose()
  }
}

export { polygonLine, polylineGeometry, disposeTree, OUTLINE_LIFT }
