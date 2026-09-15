/**
 * The furniture catalog.
 *
 * Adding a thing to the product is meant to be adding data here: no renderer,
 * editor or engine change. That is exactly why these tests run over every entry
 * rather than over a chosen few. An item with a depth typed a decimal place out,
 * a seat inside its own table or a `blocking` flag it should not have reaches
 * the navigation grid, the geometry cache and the engine without anybody
 * writing a line of code that review could have caught.
 */

import { describe, expect, it } from 'vitest'
import {
  CATALOG,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  FALLBACK_ITEM,
  getCatalogItem,
  resolveCatalogItem,
  searchCatalog,
  type CatalogItem,
  type SeatSlot,
  type Size,
} from './catalog'
import type { Prim } from './primitives'

const places = (item: CatalogItem, size: Size = item.size): SeatSlot[] => item.seats?.(size) ?? []

const SEATED = CATALOG.filter((item) => item.seats !== undefined)

/**
 * The two tables whose rows run off the end of the table — see 'runs a bench
 * row off the end of the table'. Until that is fixed they break the general
 * rules about where a place may sit, so those rules are asserted without them
 * and their real positions are pinned in that test instead.
 */
const BENCH_SEAT_TABLES = new Set(['table-rect-6ft', 'table-conference'])

/** Counters people are served across, which stand at counter rather than table height. */
const SERVED_ACROSS = new Set([
  'counter-bar',
  'counter-reception',
  'counter-buffet',
  'coffee-station',
])

/** The two items drawn where they hang rather than on the floor. */
const HANGS = new Set(['artwork', 'pendant-light'])

/**
 * A resize the product can actually produce. The inspector edits width and
 * depth with a 0.1 m floor and no ceiling, and never edits height, so a resized
 * item is a differently proportioned one rather than a scale model.
 */
const resized = (size: Size, factor: number): Size => ({
  width: size.width * factor,
  depth: size.depth * factor,
  height: size.height,
})

/** Every dimension a primitive declares, so a builder cannot hide a negative one. */
const extents = (prim: Prim): number[] => {
  switch (prim.type) {
    case 'box':
      return [prim.w, prim.h, prim.d]
    case 'cyl':
      return [prim.r, prim.r2 ?? prim.r, prim.h]
    case 'sphere':
      return [prim.r]
    case 'torus':
      return [prim.r, prim.tube]
  }
}

/** Half the vertical extent, for asking where a part starts and ends. */
const halfHeight = (prim: Prim): number => {
  switch (prim.type) {
    case 'box':
    case 'cyl':
      return prim.h / 2
    case 'sphere':
      return prim.r * (prim.squash ?? 1)
    case 'torus':
      // A torus is authored in XY and stood up by the renderer, so it is as
      // thin as its tube and as wide as its ring.
      return prim.tube
  }
}

/** Half extents on the floor plan, with the primitive's own Y rotation taken in. */
const halfPlan = (prim: Prim): { x: number; z: number } => {
  if (prim.type !== 'box') {
    const r = prim.type === 'cyl' ? Math.max(prim.r, prim.r2 ?? prim.r) : prim.r
    const spread = prim.type === 'torus' ? r + prim.tube : r
    return { x: spread, z: spread }
  }
  const c = Math.abs(Math.cos(prim.rot ?? 0))
  const s = Math.abs(Math.sin(prim.rot ?? 0))
  return { x: (prim.w / 2) * c + (prim.d / 2) * s, z: (prim.w / 2) * s + (prim.d / 2) * c }
}

const topOf = (prims: Prim[]): number =>
  Math.max(...prims.map((prim) => (prim.y ?? 0) + halfHeight(prim)))

const bottomOf = (prims: Prim[]): number =>
  Math.min(...prims.map((prim) => (prim.y ?? 0) - halfHeight(prim)))

const expectSoundGeometry = (prims: Prim[]): void => {
  // Nothing to merge is an empty BufferGeometry: an item you can place, select
  // and walk around but cannot see.
  expect(prims.length).toBeGreaterThan(0)
  for (const prim of prims) {
    for (const extent of extents(prim)) {
      // A negative or NaN extent is not a crash. Three.js builds the geometry
      // inside out and the part renders as a hole you can see straight through.
      expect(extent).toBeGreaterThan(0)
      expect(extent).toBeLessThan(20)
    }
    for (const axis of [prim.x ?? 0, prim.y ?? 0, prim.z ?? 0]) {
      expect(Math.abs(axis)).toBeLessThan(20)
    }
  }
}

describe('the catalog as a registry', () => {
  it('reaches every entry by the id a saved document stores', () => {
    // A duplicate id silently shadows the first entry in the lookup map, and a
    // plan drawn with the shadowed item reopens as the other one.
    expect(new Set(CATALOG.map((item) => item.id)).size).toBe(CATALOG.length)
    for (const item of CATALOG) {
      expect(getCatalogItem(item.id)).toBe(item)
      expect(resolveCatalogItem(item.id)).toBe(item)
    }
  })

  it('gives every entry a name of its own to pick it out by', () => {
    expect(new Set(CATALOG.map((item) => item.name)).size).toBe(CATALOG.length)
    const untidy = CATALOG.filter((item) => item.name.trim() !== item.name || !item.name)
    expect(untidy.map((item) => item.id)).toEqual([])
  })

  it('files every entry under a category the library panel lays out', () => {
    // The panel renders by CATEGORY_ORDER, not by the catalog array: an item in
    // a category it does not order is an item nobody can find.
    const unlisted = CATALOG.filter(
      (item) => !CATEGORY_ORDER.includes(item.category) || !CATEGORY_LABELS[item.category],
    )
    expect(unlisted.map((item) => item.id)).toEqual([])
    expect(new Set(CATEGORY_ORDER).size).toBe(CATEGORY_ORDER.length)
    expect(CATEGORY_ORDER).toHaveLength(Object.keys(CATEGORY_LABELS).length)
    // Every category the panel offers has something in it, or it renders empty.
    for (const category of CATEGORY_ORDER) {
      expect(CATALOG.some((item) => item.category === category)).toBe(true)
    }
  })

  it('finds every entry by each of the words it advertises', () => {
    // The query is lowered and trimmed; the keywords are not. A keyword with a
    // capital or a stray space in it is a keyword nobody can search for.
    const lost: string[] = []
    for (const item of CATALOG) {
      expect(item.keywords.length).toBeGreaterThan(0)
      for (const keyword of item.keywords) {
        if (!searchCatalog(keyword).includes(item)) lost.push(`${item.id}/${keyword}`)
      }
    }
    expect(lost).toEqual([])
  })

  it('searches names, ids and keywords whatever the case', () => {
    expect(searchCatalog('BANQUET').map((item) => item.id)).toContain('table-round-8')
    expect(searchCatalog('Trestle').map((item) => item.id)).toContain('table-rect-6ft')
    expect(searchCatalog('table-round').map((item) => item.id)).toEqual([
      'table-round-4',
      'table-round-6',
      'table-round-8',
    ])
    expect(searchCatalog('helicopter')).toEqual([])
  })

  it('hands back the whole catalog, by identity, for an empty query', () => {
    // The library panel re-renders off this. A fresh array on every keystroke
    // is a fresh list of every item in the product.
    expect(searchCatalog('')).toBe(CATALOG)
    expect(searchCatalog('   ')).toBe(CATALOG)
  })
})

describe('sizes somebody could order', () => {
  it('gives every entry a size out of a real product range', () => {
    const wrong: string[] = []
    for (const item of CATALOG) {
      const { width, depth, height } = item.size
      const plan = [width, depth]
      // Nothing in a venue is under 8 cm across but a panel seen on edge, and
      // nothing is wider than the 16 ft stage deck or taller than a 3.2 m
      // column. A dimension typed a decimal place out lands outside both.
      if (plan.some((side) => !(side >= 0.08 && side <= 5)))
        wrong.push(`${item.id} ${width}x${depth}`)
      // 2 cm is a rug or a floor marking; anything thinner is a modelling slip.
      if (!(height >= 0.02 && height <= 3.2)) wrong.push(`${item.id} h=${height}`)
    }
    expect(wrong).toEqual([])
  })

  it('stands every work surface at a height people use', () => {
    // Heights are the dimension nobody can edit, so a wrong one is wrong for
    // good: the chairs that belong to a table are built to meet these.
    const bands: Array<[string, number, number]> = [
      ['coffee table', 0.35, 0.5],
      ['dining or desk top', 0.7, 0.8],
      ['servery counter', 0.85, 0.95],
      ['bar or poseur top', 1.0, 1.15],
    ]
    const odd: string[] = []
    for (const item of CATALOG) {
      if (item.category !== 'tables' && !SERVED_ACROSS.has(item.id)) continue
      const height = item.size.height
      if (!bands.some(([, low, high]) => height >= low && height <= high)) {
        odd.push(`${item.id}=${height}`)
      }
    }
    expect(odd).toEqual([])
  })

  it('sizes every seat for the number of people it holds', () => {
    // A row of places is only worth what each person gets of it. Under 0.4 m of
    // frontage is narrower than a stacking chair; over 0.95 m and the item is
    // claiming fewer places than it has room for, which is how a 3 m wide
    // dining chair or a bench seating one would slip in.
    const cramped: string[] = []
    for (const item of CATALOG) {
      if (item.category !== 'seating') continue
      const rows = new Map<string, number>()
      for (const slot of places(item))
        rows.set(slot.z.toFixed(2), (rows.get(slot.z.toFixed(2)) ?? 0) + 1)
      expect(rows.size).toBeGreaterThan(0)
      const widest = Math.max(...rows.values())
      const frontage = item.size.width / widest
      const reach = item.size.depth / rows.size
      if (frontage < 0.4 || frontage > 0.95)
        cramped.push(`${item.id} frontage=${frontage.toFixed(2)}`)
      // Deeper than a wheelchair bay and it is a room, not a seat.
      if (reach > 1.35) cramped.push(`${item.id} depth=${reach.toFixed(2)}`)
    }
    expect(cramped).toEqual([])
  })

  it('draws only the panels as slivers on the floor plan', () => {
    // The plan view is the drawing people check their venue against. A thing
    // fifteen times longer than it is deep is a screen, a barrier or a picture
    // — or it is a depth somebody typed as 0.08 instead of 0.8.
    const slivers = CATALOG.filter(
      (item) => Math.max(item.size.width / item.size.depth, item.size.depth / item.size.width) > 5,
    ).map((item) => item.id)
    expect(slivers.sort()).toEqual([
      'artwork',
      'barrier',
      'partition',
      'projector-screen',
      'screen-tv',
    ])
  })

  it('keeps a footprint to walk around once its inset is taken off', () => {
    // `furniturePolygon` trims `inset` from every side and floors the result at
    // 2 cm. An item whose inset swallows its own width hits that floor and
    // stops being an obstacle at its default size, which no visual check shows.
    const swallowed: string[] = []
    for (const item of CATALOG) {
      if (item.inset < 0 || item.inset * 2 >= Math.min(item.size.width, item.size.depth)) {
        swallowed.push(`${item.id} inset=${item.inset}`)
      }
    }
    expect(swallowed).toEqual([])
  })

  it('keeps round and uniformly resized items square in plan', () => {
    // A circular footprint collides as `min(width, depth)`, so an oblong one
    // loses the difference to the collision model; and uniform resize scales
    // depth off the width ratio, which only means anything if they match.
    const oblong = CATALOG.filter(
      (item) =>
        (item.footprint === 'circle' || item.resize === 'uniform') &&
        item.size.width !== item.size.depth,
    )
    expect(oblong.map((item) => item.id)).toEqual([])
  })

  it('spells one imperial size the same way twice', () => {
    const sixFeet = 12 * 6 * 0.0254
    const round = resolveCatalogItem('table-round-8').size.width
    const trestle = resolveCatalogItem('table-rect-6ft').size.width
    expect(Math.abs(round - sixFeet)).toBeLessThan(0.0005)
    // SUSPECTED BUG (minor): the banquet round is 1.829 — the millimetre-rounded
    // 6 ft that `standards.ts` produces — while the trestle is 1.83, a
    // millimetre out, which is why it needs the looser bound here. The comment
    // on `table-round-8` says in so many words that two items claiming one
    // imperial dimension should not round it differently, and they still do.
    // Asserting the current spellings rather than fixing them.
    expect(Math.abs(trestle - sixFeet)).toBeLessThan(0.0015)
    expect(round).toBe(1.829)
    expect(trestle).toBe(1.83)
  })
})

describe('what people have to walk around', () => {
  it('leaves the furniture people walk into, over and under walkable', () => {
    // Loose seating is furniture you pull out, not a wall. Blocking, eight
    // chairs would ring a banquet round with obstacle once the navigation grid
    // adds body clearance and nobody could take their seat; a solid seat row
    // closes the gap between rows the same way. The flat and hung decor is here
    // because you walk over or under it.
    expect(
      CATALOG.filter((item) => !item.blocking)
        .map((item) => item.id)
        .sort(),
    ).toEqual([
      'artwork',
      'booth',
      'chair',
      'chair-stacking',
      'pendant-light',
      'rug',
      'seat-row',
      'stool-bar',
      'wheelchair-space',
    ])
  })

  it('blocks everything with a body people cannot walk through', () => {
    // Tables and counters are what actually shapes circulation; one of them
    // turning non-blocking is a plan that simulates as an empty room. And
    // anything ankle-high enough to step over must not block, or a rug becomes
    // an island.
    const wrong: string[] = []
    for (const item of CATALOG) {
      if ((item.category === 'tables' || item.category === 'service') && !item.blocking) {
        wrong.push(`${item.id} should block`)
      }
      if (item.size.height < 0.05 && item.blocking) wrong.push(`${item.id} should not block`)
    }
    expect(wrong).toEqual([])
  })
})

describe('the places people can take', () => {
  it('gives every place its own share of the item', () => {
    // Two places closer together than a pair of shoulders are the same patch of
    // floor counted twice, and the engine will seat two people in it.
    const crowded: string[] = []
    for (const item of SEATED) {
      const slots = places(item)
      expect(slots.length).toBeGreaterThan(0)
      for (let a = 0; a < slots.length; a++) {
        for (let b = a + 1; b < slots.length; b++) {
          const gap = Math.hypot(slots[a].x - slots[b].x, slots[a].z - slots[b].z)
          if (gap < 0.55) crowded.push(`${item.id} ${gap.toFixed(2)} m apart`)
        }
      }
      // And each of them gets a share of the item's own edge: the trade lays a
      // banquet at about 0.6 m of table per cover, and people stand closer than
      // they sit.
      const edge =
        item.footprint === 'circle'
          ? Math.PI * item.size.width
          : 2 * (item.size.width + item.size.depth)
      const share = edge / slots.length
      const leaning = slots.every((slot) => slot.kind !== 'seat')
      if (share < (leaning ? 0.45 : 0.6)) crowded.push(`${item.id} ${share.toFixed(2)} m of edge`)
    }
    expect(crowded).toEqual([])
  })

  it('offers the number of places its name promises', () => {
    // The name is the promise in the library panel and the inspector header:
    // "Banquet round (8)" that lays eight covers is the whole product claim.
    const promised = CATALOG.filter((item) => /\((\d+)(?: seat)?\)$/.test(item.name))
    expect(promised.map((item) => item.id)).toEqual([
      'table-round-4',
      'table-round-6',
      'table-round-8',
      'table-square-4',
      'sofa-2',
    ])
    for (const item of promised) {
      const claim = Number(/\((\d+)/.exec(item.name)![1])
      expect(places(item)).toHaveLength(claim)
    }
  })

  it('keeps every place within reach of the item it belongs to', () => {
    const adrift: string[] = []
    for (const item of SEATED) {
      if (BENCH_SEAT_TABLES.has(item.id)) continue
      for (const size of [item.size, resized(item.size, 1.6), resized(item.size, 0.6)]) {
        for (const slot of places(item, size)) {
          // Half a metre past the edge is a chair pulled out from a table. More
          // than that is a person sitting in the aisle, and the engine walks
          // them there and calls it a seat.
          const out = Math.max(Math.abs(slot.x) - size.width / 2, Math.abs(slot.z) - size.depth / 2)
          if (!(out <= 0.5) || !Number.isFinite(slot.facing)) {
            adrift.push(`${item.id} ${out.toFixed(2)} m out`)
          }
        }
      }
    }
    expect(adrift).toEqual([])
  })

  it('seats a diner beside the table, facing it', () => {
    // A facing that is reversed or a quarter turn out seats the whole table
    // looking away, which no check of the positions alone would catch.
    const wrong: string[] = []
    for (const item of SEATED) {
      if (item.category !== 'tables' || BENCH_SEAT_TABLES.has(item.id)) continue
      for (const slot of places(item)) {
        const { width, depth } = item.size
        const clear =
          item.footprint === 'circle'
            ? Math.hypot(slot.x, slot.z) >= Math.min(width, depth) / 2 - item.inset
            : Math.abs(slot.x) >= width / 2 - item.inset ||
              Math.abs(slot.z) >= depth / 2 - item.inset
        if (!clear) wrong.push(`${item.id} sits a diner in the table`)
        const range = Math.hypot(slot.x, slot.z)
        const towards = (-slot.x * Math.cos(slot.facing) - slot.z * Math.sin(slot.facing)) / range
        if (towards < 0.999) wrong.push(`${item.id} faces ${towards.toFixed(2)} of the way in`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('lays its places out from the size it is handed', () => {
    // A builder returning fixed offsets leaves the chairs where the default
    // size put them, so a stretched table seats people in its own top.
    const fixed: string[] = []
    for (const item of SEATED) {
      if (item.resize === 'none') continue
      const furthest = (size: Size) =>
        Math.max(...places(item, size).map((slot) => Math.hypot(slot.x, slot.z)))
      if (!(furthest(resized(item.size, 1.5)) > furthest(item.size))) fixed.push(item.id)
    }
    expect(fixed).toEqual([])
  })

  it('runs a bench row off the end of the table', () => {
    // SUSPECTED BUG. `benchSeats` steps across `width * 0.82 * 2` from a start
    // of `-width / 2 * 0.82`, so the row spans twice the table and hangs off
    // the +X end; dropping the `* 2` would centre it. Asserting what it does
    // now, not what it should do.
    const trestle = resolveCatalogItem('table-rect-6ft')
    const xs = places(trestle).map((slot) => slot.x)
    expect([...new Set(xs)].sort((a, b) => a - b)).toHaveLength(3)
    // The table runs from -0.915 to 0.915: the first pair is nowhere near the
    // left end and the last pair is 0.84 m past the right one, in the aisle.
    expect(Math.min(...xs)).toBeCloseTo(-0.2501, 3)
    expect(Math.max(...xs)).toBeCloseTo(1.7507, 3)
    expect(Math.max(...xs) - trestle.size.width / 2).toBeCloseTo(0.8357, 3)

    const conference = resolveCatalogItem('table-conference')
    const far = places(conference).map((slot) => slot.x)
    // Half of a boardroom's covers are off the end of a 3 m table.
    expect(far.filter((x) => Math.abs(x) > conference.size.width / 2)).toHaveLength(4)
    expect(Math.max(...far)).toBeCloseTo(3.075, 6)
  })

  it('offers places inside items that block, which the world then drops', () => {
    // SUSPECTED BUG. `buildWorld` keeps only the places that land on a free
    // navigation cell, and a blocking item rasterises its own footprint with
    // body clearance. A place at the middle of one is never free, so these three
    // advertise seats — in the library panel, in the inspector header — that the
    // simulation silently discards: nobody ever sits on a sofa, a bench or an
    // armchair. The loose seating avoids it by not blocking.
    const sealed = CATALOG.filter(
      (item) =>
        item.blocking &&
        places(item).length > 0 &&
        places(item).every(
          (slot) =>
            Math.abs(slot.x) < item.size.width / 2 - item.inset &&
            Math.abs(slot.z) < item.size.depth / 2 - item.inset,
        ),
    )
    expect(sealed.map((item) => item.id).sort()).toEqual(['armchair', 'bench', 'sofa-2'])
  })
})

describe('building the geometry', () => {
  it('builds something solid at its default size', () => {
    for (const item of CATALOG) {
      const prims = item.build(item.size)
      expectSoundGeometry(prims)
      // The local origin is the centre of the footprint *on the floor*, so a
      // part below zero is one sunk into the slab.
      expect(bottomOf(prims)).toBeGreaterThan(-1e-9)
    }
  })

  it('builds at any size a saved document can carry', () => {
    // Every item is resizable in practice, whatever its `resize` mode says: a
    // document carries a `size` for any item and the loader keeps it, so a
    // builder that only works at its default size breaks on reload.
    for (const item of CATALOG) {
      for (const factor of [0.6, 1.8]) expectSoundGeometry(item.build(resized(item.size, factor)))
    }
  })

  it('draws itself within the height it declares', () => {
    const wrong: string[] = []
    for (const item of CATALOG) {
      if (HANGS.has(item.id)) continue
      const top = topOf(item.build(item.size))
      // Slack upwards for the things that stand proud of the surface they sit
      // on: a buffet sneeze guard, a coffee machine, a lectern microphone.
      if (top < item.size.height - 0.1 || top > item.size.height + 0.45) {
        wrong.push(`${item.id} tops out at ${top.toFixed(2)} of ${item.size.height}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('hangs the two things that hang, well above the height they declare', () => {
    // The source calls artwork "the one item whose height is its own height
    // rather than its extent above the floor". The pendant is a second one:
    // 0.5 m tall, drawn between 2.3 m and the ceiling.
    const artwork = resolveCatalogItem('artwork')
    const pendant = resolveCatalogItem('pendant-light')
    expect(bottomOf(artwork.build(artwork.size))).toBeCloseTo(1.023, 3)
    expect(topOf(pendant.build(pendant.size))).toBeCloseTo(3.3, 3)
    // Resizing a picture changes the picture, not how high it is hung: whatever
    // size it is given, it stays on the 58 inch centre line.
    for (const size of [
      artwork.size,
      resized(artwork.size, 2),
      { width: 0.4, depth: 0.08, height: 1.8 },
    ]) {
      const prims = artwork.build(size)
      expect((topOf(prims) + bottomOf(prims)) / 2).toBeCloseTo(1.473, 6)
      expect(topOf(prims) - bottomOf(prims)).toBeCloseTo(size.height, 6)
    }
  })

  it('draws its body inside the footprint people walk around', () => {
    // Collision is the declared size, trimmed by the inset. A body drawn wider
    // than that is a thing people walk through on screen. Feet, bases and floor
    // discs are allowed out because you step over them.
    const overhanging: string[] = []
    for (const item of CATALOG) {
      let worst = 0
      for (const prim of item.build(item.size)) {
        if ((prim.y ?? 0) + halfHeight(prim) <= 0.2) continue
        const half = halfPlan(prim)
        worst = Math.max(
          worst,
          Math.abs(prim.x ?? 0) + half.x - item.size.width / 2,
          Math.abs(prim.z ?? 0) + half.z - item.size.depth / 2,
        )
      }
      if (worst > 0.06) overhanging.push(item.id)
    }
    // The buffet's sneeze guard and the tree's canopy are real cantilevers:
    // they hang over floor people can still stand on.
    expect(overhanging.sort()).toEqual(['counter-buffet', 'plant-tree'])
  })

  it('tints a role it actually draws with', () => {
    // The per-instance colour override replaces the colour of exactly this
    // role. Naming one the builder never uses makes recolouring a no-op the
    // user can only discover by trying it.
    const missing: string[] = []
    for (const item of CATALOG) {
      if (!item.tintRole) {
        missing.push(`${item.id} has no tintable role`)
        continue
      }
      const drawn = new Set(item.build(item.size).map((prim) => prim.color))
      if (!drawn.has(item.tintRole)) missing.push(`${item.id} never draws ${item.tintRole}`)
    }
    expect(missing).toEqual([])
  })

  it('turns inside out at sizes the inspector will still accept', () => {
    // SUSPECTED BUG. Width and depth are typed in with a 0.1 m floor and no
    // ceiling, so these are reachable sizes rather than fuzzed ones.
    const tv = resolveCatalogItem('screen-tv')
    const wall = tv.build({ width: 4, depth: 0.3, height: 1.7 })
    const stand = wall[2]
    // The stand is `height - width * 0.58`: past a 2.93 m wide video wall the
    // screen is taller than the item and the pole inverts — and the panel it
    // holds up sinks 0.6 m through the floor.
    expect(stand.type === 'cyl' && stand.h).toBeCloseTo(-0.62, 6)
    expect(bottomOf(wall)).toBeCloseTo(-0.6, 6)

    const sofa = resolveCatalogItem('sofa-2')
    const cushion = sofa.build({ width: 0.1, depth: 0.88, height: 0.8 })[1]
    // Cushions are `width - 0.34` against fixed 0.18 m arms: a sofa pulled
    // narrower than its own arms turns inside out the same way.
    expect(cushion.type === 'box' && cushion.w).toBeCloseTo(-0.24, 6)
  })
})

describe('resolving an id a document carries', () => {
  it('resolves a known id to the entry itself', () => {
    const round = resolveCatalogItem('table-round-8')
    expect(round.name).toBe('Banquet round (8)')
    expect(round.size.width).toBeCloseTo(1.829, 6)
    expect(places(round)).toHaveLength(8)
    // Identity, not a copy: the renderer caches geometry per entry.
    expect(resolveCatalogItem('table-round-8')).toBe(round)
  })

  it('stands in for an id from a newer build instead of throwing', () => {
    // Documents outlive builds. A plan saved by a future version must still
    // open, and the item it references must not become a hole in the obstacle
    // set that people walk through on the way to the renderer.
    expect(getCatalogItem('table-round-24')).toBeUndefined()
    expect(resolveCatalogItem('table-round-24')).toBe(FALLBACK_ITEM)
    expect(FALLBACK_ITEM.blocking).toBe(true)
    // No places: a stand-in that offered seats would seat people in a thing
    // this build cannot even draw.
    expect(FALLBACK_ITEM.seats).toBeUndefined()
    expect(CATEGORY_ORDER).toContain(FALLBACK_ITEM.category)
    expectSoundGeometry(FALLBACK_ITEM.build(FALLBACK_ITEM.size))
    expectSoundGeometry(FALLBACK_ITEM.build({ width: 3, depth: 0.4, height: 2 }))
  })

  it('never offers the stand-in as a thing to place', () => {
    // It stands in for a broken reference, not a product: in the library panel
    // it would read "Unknown item".
    expect(CATALOG).not.toContain(FALLBACK_ITEM)
    expect(getCatalogItem(FALLBACK_ITEM.id)).toBeUndefined()
    expect(searchCatalog('unknown')).toEqual([])
  })

  it('falls back for ids that are not ids at all', () => {
    // The lookup is a Map. Were it a plain object, 'constructor' would resolve
    // to a function and every one of these would take a different path.
    for (const id of ['', ' ', 'constructor', '__proto__', 'toString']) {
      expect(resolveCatalogItem(id)).toBe(FALLBACK_ITEM)
    }
  })
})
