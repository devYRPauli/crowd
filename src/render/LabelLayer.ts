/**
 * Screen-space labels.
 *
 * Dimensions, room areas and zone names are drawn as HTML positioned over the
 * canvas rather than as 3D text: text stays pixel-crisp at any zoom, inherits
 * the app's typography, and costs nothing in the render loop.
 */

import { Vector3, type Camera } from 'three'

export interface Label {
  id: string
  text: string
  /** World position, in Three.js coordinates. */
  x: number
  y: number
  z: number
  variant?: 'dimension' | 'name' | 'area' | 'warning' | 'accent'
  /** Hide when the label is further than this from the camera. */
  maxDistance?: number
}

export class LabelLayer {
  readonly element: HTMLDivElement
  private nodes = new Map<string, HTMLDivElement>()
  private labels: Label[] = []
  private projected = new Vector3()

  constructor(parent: HTMLElement) {
    this.element = document.createElement('div')
    this.element.className = 'viewport-labels'
    parent.appendChild(this.element)
  }

  set(labels: Label[]): void {
    this.labels = labels
  }

  clear(): void {
    this.labels = []
  }

  update(camera: Camera, width: number, height: number): void {
    const seen = new Set<string>()
    for (const label of this.labels) {
      seen.add(label.id)
      let node = this.nodes.get(label.id)
      if (!node) {
        node = document.createElement('div')
        node.className = 'viewport-label'
        this.element.appendChild(node)
        this.nodes.set(label.id, node)
      }
      const variant = label.variant ?? 'name'
      const className = `viewport-label is-${variant}`
      if (node.className !== className) node.className = className
      if (node.textContent !== label.text) node.textContent = label.text

      this.projected.set(label.x, label.y, label.z).project(camera)
      const behind = this.projected.z > 1
      const distance = camera.position.distanceTo(this.projected.set(label.x, label.y, label.z))
      this.projected.set(label.x, label.y, label.z).project(camera)
      const tooFar = label.maxDistance !== undefined && distance > label.maxDistance
      if (behind || tooFar) {
        node.style.display = 'none'
        continue
      }
      node.style.display = ''
      const sx = (this.projected.x * 0.5 + 0.5) * width
      const sy = (-this.projected.y * 0.5 + 0.5) * height
      node.style.transform = `translate(-50%, -50%) translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`
    }

    for (const [id, node] of this.nodes) {
      if (seen.has(id)) continue
      node.remove()
      this.nodes.delete(id)
    }
  }

  dispose(): void {
    this.element.remove()
    this.nodes.clear()
  }
}
