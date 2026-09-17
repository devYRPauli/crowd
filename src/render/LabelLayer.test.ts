/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PerspectiveCamera } from 'three'
import { LabelLayer, type Label } from './LabelLayer'

const WIDTH = 800
const HEIGHT = 600

/** Ten metres back along +z, looking at the origin. */
const camera = (): PerspectiveCamera => {
  const view = new PerspectiveCamera(50, WIDTH / HEIGHT, 0.1, 100)
  view.position.set(0, 0, 10)
  view.lookAt(0, 0, 0)
  view.updateMatrixWorld(true)
  return view
}

const label = (extra: Partial<Label> = {}): Label => ({
  id: 'a',
  text: '4.20 m',
  x: 0,
  y: 0,
  z: 0,
  ...extra,
})

let parent: HTMLDivElement
let layer: LabelLayer

beforeEach(() => {
  parent = document.createElement('div')
  document.body.appendChild(parent)
  layer = new LabelLayer(parent)
})

afterEach(() => {
  layer.dispose()
  parent.remove()
})

const nodes = (): HTMLElement[] => Array.from(layer.element.children) as HTMLElement[]

/** The screen pixels a node has been transformed to. */
const px = (node: HTMLElement): number[] =>
  (node.style.transform.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/) ?? []).slice(1).map(Number)

describe('label layer', () => {
  it('hangs one node per label off the viewport', () => {
    layer.set([label(), label({ id: 'b', text: 'Foyer' })])
    layer.update(camera(), WIDTH, HEIGHT)

    expect(layer.element.className).toBe('viewport-labels')
    expect(layer.element.parentElement).toBe(parent)
    expect(nodes().map((node) => node.textContent)).toEqual(['4.20 m', 'Foyer'])
  })

  it('moves the same node rather than rebuilding it every frame', () => {
    // Labels are updated on every camera change. Replacing the nodes would
    // restart CSS transitions and thrash layout at 60 Hz.
    layer.set([label()])
    layer.update(camera(), WIDTH, HEIGHT)
    const [node] = nodes()

    layer.set([label({ text: '4.30 m' })])
    layer.update(camera(), WIDTH, HEIGHT)
    expect(nodes()[0]).toBe(node)
    expect(node.textContent).toBe('4.30 m')
  })

  it('puts the label over the point it names', () => {
    layer.set([
      label(),
      label({ id: 'right', x: 1 }),
      label({ id: 'further', x: 2 }),
      label({ id: 'up', y: 1 }),
    ])
    layer.update(camera(), WIDTH, HEIGHT)
    const [centre, right, further, up] = nodes()

    expect(centre.style.transform).toBe('translate(-50%, -50%) translate(400.0px, 300.0px)')
    // A metre to the right of the target is to the right on screen, and a metre
    // up is up: the y axis has to be flipped on the way to CSS pixels.
    expect(px(right)[0]).toBeGreaterThan(400)
    expect(px(right)[1]).toBeCloseTo(300, 6)
    expect(px(up)[1]).toBeLessThan(300)
    // At a fixed depth the projection is linear, so two metres out lands twice
    // as far from the centre as one. A dimension that crept off its own wall as
    // the room got bigger would show up as a break in that. The transform is
    // written to a tenth of a pixel, which is all the agreement there is.
    expect(px(further)[0] - 400).toBeCloseTo((px(right)[0] - 400) * 2, 0)
  })

  it('hides a label that has gone behind the camera', () => {
    // Projection wraps behind the eye: without this the dimension for a wall
    // behind you appears mirrored across the screen.
    layer.set([label({ z: 20 })])
    layer.update(camera(), WIDTH, HEIGHT)
    expect(nodes()[0].style.display).toBe('none')

    layer.set([label({ z: 0 })])
    layer.update(camera(), WIDTH, HEIGHT)
    expect(nodes()[0].style.display).toBe('')
    // Coming back into view has to restore the position too, not just the
    // display: a node left on its stale transform reappears in the wrong place.
    expect(px(nodes()[0])).toEqual([400, 300])
  })

  it('drops a label once the camera is further away than it asked', () => {
    // Room names and areas would otherwise pile into illegible confetti when
    // the whole site is in frame.
    layer.set([label({ maxDistance: 5 })])
    layer.update(camera(), WIDTH, HEIGHT)
    expect(nodes()[0].style.display).toBe('none')

    layer.set([label({ maxDistance: 12 })])
    layer.update(camera(), WIDTH, HEIGHT)
    expect(nodes()[0].style.display).toBe('')
  })

  it('names the variant in the class so the stylesheet can tell them apart', () => {
    layer.set([label(), label({ id: 'b', variant: 'warning' })])
    layer.update(camera(), WIDTH, HEIGHT)
    // An unmarked label is a name; dimensions, areas and warnings each read
    // differently.
    expect(nodes()[0].className).toBe('viewport-label is-name')
    expect(nodes()[1].className).toBe('viewport-label is-warning')

    layer.set([label({ variant: 'dimension' }), label({ id: 'b', variant: 'warning' })])
    layer.update(camera(), WIDTH, HEIGHT)
    expect(nodes()[0].className).toBe('viewport-label is-dimension')
  })

  it('takes down the labels a tool has finished with', () => {
    layer.set([label(), label({ id: 'b', text: 'Foyer' })])
    layer.update(camera(), WIDTH, HEIGHT)
    const [kept] = nodes()

    layer.set([label()])
    layer.update(camera(), WIDTH, HEIGHT)
    // A stale dimension left hanging over the plan is worse than none.
    expect(nodes()).toEqual([kept])

    layer.clear()
    layer.update(camera(), WIDTH, HEIGHT)
    expect(nodes()).toEqual([])
  })

  it('leaves nothing behind when the viewport goes away', () => {
    layer.set([label()])
    layer.update(camera(), WIDTH, HEIGHT)
    layer.dispose()
    expect(parent.children.length).toBe(0)

    // Disposing twice happens on a fast unmount and must not throw.
    layer.dispose()
  })
})
