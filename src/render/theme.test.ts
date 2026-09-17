import { describe, expect, it } from 'vitest'
import { Color, DoubleSide } from 'three'
import {
  AGENT_STATE_COLORS,
  MATERIAL_ROLES,
  MaterialLibrary,
  PALETTES,
  ROLE_INDEX,
  roleColor,
  type Palette,
} from './theme'
import { AGENT_STATE_ORDER } from '../sim/types'

const TOKENS = Object.keys(PALETTES.light) as Array<keyof Palette>

/**
 * WCAG relative luminance. Three's `Color` already holds linear-sRGB values —
 * colour management decodes the hex on the way in — which is exactly the space
 * the luminance weights are defined over.
 */
const luminance = (hex: string): number => {
  const c = new Color(hex)
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
}

const contrast = (a: string, b: string): number => {
  const first = luminance(a)
  const second = luminance(b)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

describe('palettes', () => {
  it('defines every token in both themes', () => {
    // The renderer asks for tokens by name at draw time. A token missing from
    // one theme is a colour that resolves to undefined the moment somebody
    // switches to it — which is not something a type can catch once a palette
    // is edited by hand.
    expect(Object.keys(PALETTES.dark).sort()).toEqual(TOKENS.slice().sort())
    for (const theme of ['light', 'dark'] as const) {
      for (const token of TOKENS) {
        const value = PALETTES[theme][token]
        expect(value).toMatch(/^#[0-9a-f]{6}$/)
        // Round-tripping proves three parses it to the colour that was written.
        expect(new Color(value).getHexString()).toBe(value.slice(1))
      }
    }
  })

  it('keeps label text legible against the background it is drawn over', () => {
    // Dimensions and room names are HTML over the canvas, so they get no
    // outline or shadow to fall back on.
    expect(contrast(PALETTES.light.text, PALETTES.light.background)).toBeGreaterThan(7)
    expect(contrast(PALETTES.dark.text, PALETTES.dark.background)).toBeGreaterThan(7)
  })

  it('shows a selected object against the floor it stands on, in both themes', () => {
    expect(contrast(PALETTES.light.selection, PALETTES.light.floor)).toBeGreaterThan(3)
    expect(contrast(PALETTES.dark.selection, PALETTES.dark.floor)).toBeGreaterThan(3)
  })

  it('reads the major grid line more strongly than the minor one', () => {
    // Major lines every ten cells are what the eye measures against; if they do
    // not out-read the minor lines the grid is just texture.
    for (const theme of ['light', 'dark'] as const) {
      const p = PALETTES[theme]
      expect(contrast(p.gridMajor, p.ground)).toBeGreaterThan(contrast(p.gridMinor, p.ground))
    }
  })

  it('sits the venue floor above the site ground in tone, and darkens the whole sheet at night', () => {
    // A drawn floor has to read as built ground rather than as more site.
    expect(luminance(PALETTES.light.ground)).toBeLessThan(luminance(PALETTES.light.floor))
    expect(luminance(PALETTES.dark.ground)).toBeLessThan(luminance(PALETTES.dark.floor))
    expect(luminance(PALETTES.dark.background)).toBeLessThan(
      luminance(PALETTES.light.background) / 10,
    )
  })
})

describe('material roles', () => {
  it('indexes the roles in the order the vertex attribute is written in', () => {
    // The index is baked into merged furniture geometry as an attribute. If the
    // table and the index disagree, every piece of furniture is painted with
    // somebody else's material.
    expect(MATERIAL_ROLES.length).toBe(new Set(MATERIAL_ROLES).size)
    MATERIAL_ROLES.forEach((role, index) => {
      expect(ROLE_INDEX[role]).toBe(index)
    })
  })

  it('gives every role a colour three can parse', () => {
    for (const role of MATERIAL_ROLES) {
      expect(roleColor(role)).toMatch(/^#[0-9a-f]{6}$/)
    }
    // Roles exist to be told apart; two identical ones are a copy-paste slip.
    const distinct = new Set(MATERIAL_ROLES.map(roleColor))
    expect(distinct.size).toBe(MATERIAL_ROLES.length)
  })

  it('names a colour for every state a person can be reported in', () => {
    // The inspector and the legend look a state up by name. A state the sim can
    // report but the table has no entry for reaches CSS as `undefined`, and the
    // swatch beside the count goes blank.
    for (const state of AGENT_STATE_ORDER) {
      expect(AGENT_STATE_COLORS[state]).toMatch(/^#[0-9a-f]{6}$/)
    }
    // Queuing and waiting share an amber on purpose — to somebody standing in
    // the room they are the same thing — but nothing else may collide, or two
    // states become indistinguishable in the picture and the legend.
    const distinct = new Set(AGENT_STATE_ORDER.map((state) => AGENT_STATE_COLORS[state]))
    expect(distinct.size).toBe(AGENT_STATE_ORDER.length - 1)
    expect(AGENT_STATE_COLORS.queuing).toBe(AGENT_STATE_COLORS.waiting)
  })
})

describe('MaterialLibrary', () => {
  it('hands the same material back for the same request', () => {
    // Every duplicated material is a wasted draw call, and with a few hundred
    // meshes on screen that is the whole budget.
    const library = new MaterialLibrary('light')
    expect(library.wall()).toBe(library.wall())
    expect(library.floor()).toBe(library.floor())
    expect(library.furniture()).toBe(library.furniture())
    expect(library.overlay('#2f7df6', 0.2)).toBe(library.overlay('#2f7df6', 0.2))
    // Opacity is part of what the material is, so it has to be part of the key.
    expect(library.overlay('#2f7df6', 0.2)).not.toBe(library.overlay('#2f7df6', 0.3))
    expect(library.line('#2f7df6', 0.95)).not.toBe(library.line('#8a5cf6', 0.95))
  })

  it('colours the wall from the palette of the theme in force', () => {
    expect(new MaterialLibrary('light').wall().color.getHexString()).toBe(
      PALETTES.light.wall.slice(1),
    )
    expect(new MaterialLibrary('dark').wall().color.getHexString()).toBe(
      PALETTES.dark.wall.slice(1),
    )
  })

  it('rebuilds its materials when the theme changes, and frees the old ones', () => {
    const library = new MaterialLibrary('light')
    const before = library.wall()
    let freed = 0
    before.addEventListener('dispose', () => {
      freed++
    })

    library.setTheme('dark')
    const after = library.wall()

    // The old material's GPU program is released; keeping it would leak one
    // program per theme toggle across an editing session.
    expect(freed).toBe(1)
    expect(after).not.toBe(before)
    expect(after.color.getHexString()).toBe(PALETTES.dark.wall.slice(1))
    expect(library.palette).toBe(PALETTES.dark)
  })

  it('leaves the materials alone when asked for the theme already showing', () => {
    const library = new MaterialLibrary('dark')
    const before = library.floor()
    library.setTheme('dark')
    expect(library.floor()).toBe(before)
  })

  it('marks a line transparent only when it is asked for one', () => {
    const library = new MaterialLibrary('light')
    expect(library.line('#2f7df6').transparent).toBe(false)
    expect(library.line('#2f7df6').opacity).toBe(1)
    const faint = library.line('#2f7df6', 0.6)
    expect(faint.transparent).toBe(true)
    expect(faint.opacity).toBeCloseTo(0.6, 6)
  })

  it('paints furniture and people from vertex colours, and glazes from both sides', () => {
    const library = new MaterialLibrary('light')
    // All the furniture in a plan is merged into a handful of geometries and
    // coloured per vertex; with vertexColors off the whole catalog draws white.
    expect(library.furniture().vertexColors).toBe(true)
    expect(library.agents().vertexColors).toBe(true)

    // A pane is a slab a few centimetres thick standing in a wall. Front-side
    // glass vanishes as soon as you walk round to the other side of the window.
    const glass = library.glass()
    expect(glass.side).toBe(DoubleSide)
    expect(glass.transparent).toBe(true)
    expect(glass.opacity).toBeCloseTo(0.32, 6)
    expect(glass.color.getHexString()).toBe(PALETTES.light.wallGlass.slice(1))
  })

  it('lets an overlay paint on the floor rather than hover over it', () => {
    // Depth writing on a translucent zone fill punches a hole in everything
    // drawn after it.
    const overlay = new MaterialLibrary('light').overlay('#8a5cf6', 0.2)
    expect(overlay.depthWrite).toBe(false)
    expect(overlay.transparent).toBe(true)
    expect(overlay.opacity).toBeCloseTo(0.2, 6)
  })

  it('frees everything on dispose and still works afterwards', () => {
    const library = new MaterialLibrary('light')
    const wall = library.wall()
    const glass = library.glass()
    let freed = 0
    wall.addEventListener('dispose', () => {
      freed++
    })
    glass.addEventListener('dispose', () => {
      freed++
    })

    library.dispose()
    expect(freed).toBe(2)
    // A disposed library is re-used after a document is closed and reopened.
    expect(library.wall()).not.toBe(wall)
    expect(library.wall().color.getHexString()).toBe(PALETTES.light.wall.slice(1))
  })
})
