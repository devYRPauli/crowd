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
import { NAV_CLEARANCE } from '../sim/world'

const places = (item: CatalogItem, size: Size = item.size): SeatSlot[] => item.seats?.(size) ?? []

const SEATED = CATALOG.filter((item) => item.seats !== undefined)

/** The inspector's own lower bound on width and depth. It offers no upper one. */
const MIN_EDITABLE = 0.1

/** Counters people are served across, which stand at counter rather than table height. */
const SERVED_ACROSS = new Set([
  'counter-bar',
  'counter-reception',
  'counter-buffet',
  'coffee-station',
])

/** Items whose places run in a row, so a longer one holds more people. */
const ROW_SEATING = new Set([
  'table-rect-6ft',
  'table-conference',
  'sofa-2',
  'bench',
  'seat-row',
  'booth',
  'counter-bar',
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

/** Everything wrong with a built item, phrased so a failure names the damage. */
const faults = (prims: Prim[]): string[] => {
  // Nothing to merge is an empty BufferGeometry: an item you can place, select
  // and walk around but cannot see.
  if (prims.length === 0) return ['draws nothing at all']
  const out: string[] = []
  for (const prim of prims) {
    const smallest = Math.min(...extents(prim))
    // A negative or zero extent is not a crash. Three.js winds the part
    // backwards and it renders as a hole you can see straight through.
    if (!(smallest > 0)) out.push(`${prim.type} ${smallest.toFixed(3)} across`)
    if (![prim.x ?? 0, prim.y ?? 0, prim.z ?? 0].every((axis) => Math.abs(axis) < 20)) {
      out.push(`${prim.type} placed off in the distance`)
    }
  }
  // The local origin is the centre of the footprint *on the floor*, so a part
  // below zero is one sunk into the slab.
  const sunk = -bottomOf(prims)
  if (sunk > 1e-9) out.push(`sunk ${sunk.toFixed(3)} m through the floor`)
  return out
}

const built = (item: CatalogItem, size: Size, when = ''): string[] =>
  faults(item.build(size)).map((fault) => `${item.id}${when}: ${fault}`)

/** The nearest point of the item's own footprint to a place, in local coordinates. */
const nearestEdge = (item: CatalogItem, slot: SeatSlot, size: Size): { x: number; z: number } => {
  if (item.footprint === 'circle') {
    const radius = Math.min(size.width, size.depth) / 2
    const range = Math.hypot(slot.x, slot.z)
    if (range === 0) return { x: 0, z: 0 }
    const t = Math.min(range, radius) / range
    return { x: slot.x * t, z: slot.z * t }
  }
  const clamp = (value: number, half: number) => Math.min(half, Math.max(-half, value))
  return { x: clamp(slot.x, size.width / 2), z: clamp(slot.z, size.depth / 2) }
}

/**
 * Whether a place lands on floor the navigation grid leaves free — the same
 * test `buildWorld` applies before it offers the seat to anybody. A blocking
 * item rasterises `furniturePolygon` (its size less the inset, floored at 2 cm)
 * dilated by `NAV_CLEARANCE`, and a place inside that is a place nobody reaches.
 */
const standsOnFreeFloor = (item: CatalogItem, slot: SeatSlot): boolean => {
  if (!item.blocking) return true
  const { width, depth } = item.size
  if (item.footprint === 'circle') {
    const radius = Math.max(0.02, Math.min(width, depth) / 2 - item.inset)
    return Math.hypot(slot.x, slot.z) > radius + NAV_CLEARANCE
  }
  const halfX = Math.max(0.02, width - item.inset * 2) / 2 + NAV_CLEARANCE
  const halfZ = Math.max(0.02, depth - item.inset * 2) / 2 + NAV_CLEARANCE
  return Math.abs(slot.x) > halfX || Math.abs(slot.z) > halfZ
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
    const bare = CATEGORY_ORDER.filter((category) =>
      CATALOG.every((item) => item.category !== category),
    )
    expect(bare).toEqual([])
  })

  it('finds every entry by its name, its id and each word it advertises', () => {
    // The query is lowered and trimmed, and the name is lowered to meet it —
    // but the id and the keywords are compared as they are written. A keyword
    // with a capital or a stray space in it is one nobody can search for.
    const lost: string[] = []
    for (const item of CATALOG) {
      if (item.keywords.length === 0) lost.push(`${item.id} advertises nothing`)
      for (const term of [item.name, item.id, ...item.keywords]) {
        if (!searchCatalog(term).includes(item)) lost.push(`${item.id}/${term}`)
        if (!searchCatalog(term.toUpperCase()).includes(item))
          lost.push(`${item.id}/${term} in caps`)
      }
    }
    expect(lost).toEqual([])
  })

  it('narrows the list as the query gets more specific', () => {
    expect(searchCatalog('table-round').map((item) => item.id)).toEqual([
      'table-round-4',
      'table-round-6',
      'table-round-8',
    ])
    // A plain substring match over three fields, and it shows: 'pos' reaches
    // the till point through its id alone — nothing in its name or keywords
    // says so — and drags in every 'post' on the way.
    expect(searchCatalog('pos').map((item) => item.id)).toEqual([
      'table-poseur',
      'pos-terminal',
      'column-round',
      'column-square',
      'stanchion',
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

  it('spells every imperial size the way the rest of the app rounds it', () => {
    // `standards.ts` converts feet to the nearest millimetre and every length
    // in the product comes from it, so a 6 ft round is 1.829 m. Two spellings
    // of one dimension are two sizes that do not tile, snap or read as equal.
    const feet = (value: number): number => Math.round(value * 12 * 25.4) / 1000
    const claimed: Array<[string, 'width' | 'depth', number]> = [
      ['table-round-6', 'width', 5],
      ['table-round-8', 'width', 6],
      ['table-rect-6ft', 'width', 6],
      ['table-square-4', 'width', 3],
      ['stage', 'width', 16],
      ['stage', 'depth', 8],
    ]
    const misspelt = claimed.filter(
      ([id, axis, ft]) => resolveCatalogItem(id).size[axis] !== feet(ft),
    )
    expect(misspelt.map(([id]) => id)).toEqual([])
    // The trestle and the banquet round are both 6 ft and both say so the same
    // way, to the millimetre: a centimetre-rounded 1.83 beside a 1.829 is two
    // sizes that never line up when they are laid end to end.
    expect(resolveCatalogItem('table-rect-6ft').size.width).toBe(
      resolveCatalogItem('table-round-8').size.width,
    )
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
      if (rows.size === 0) {
        cramped.push(`${item.id} is seating nobody can sit on`)
        continue
      }
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
    // five times longer than it is deep is a screen, a barrier or a picture —
    // or it is a depth somebody typed as 0.08 instead of 0.8.
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
      if (slots.length === 0) {
        crowded.push(`${item.id} offers no places at all`)
        continue
      }
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

  it('seats more people as it gets longer, unless it is a set piece', () => {
    // The inspector header counts the places of the *resized* item, so this is
    // what the user is told about the thing in front of them: a bench drawn
    // twice as long holds more, while a "Round table (4)" is a four-top however
    // big it is drawn and a desk seats one person at any width.
    const wrong: string[] = []
    for (const item of SEATED) {
      const count = (factor: number) => places(item, resized(item.size, factor)).length
      if (count(2) < count(1)) wrong.push(`${item.id} loses places when stretched`)
      if (ROW_SEATING.has(item.id) !== count(2) > count(1)) {
        wrong.push(`${item.id} goes ${count(1)} -> ${count(2)}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('still offers a place at the smallest size the inspector allows', () => {
    // Every row count is clamped with `Math.max(1, ...)`. Without the clamp a
    // bench pulled in to the inspector's floor rounds to no places at all and
    // quietly stops being seating, while still reading "Bench" in the panel.
    const empty: string[] = []
    for (const item of SEATED) {
      const tiny = { width: MIN_EDITABLE, depth: MIN_EDITABLE, height: item.size.height }
      const slots = places(item, tiny)
      if (slots.length === 0) empty.push(`${item.id} seats nobody`)
      for (const slot of slots) {
        if (![slot.x, slot.z, slot.facing].every(Number.isFinite)) {
          empty.push(`${item.id} places somebody at ${slot.x}, ${slot.z}`)
        }
      }
    }
    expect(empty).toEqual([])
  })

  it('keeps every place within reach of the item it belongs to', () => {
    const adrift: string[] = []
    for (const item of SEATED) {
      for (const size of [item.size, resized(item.size, 1.6), resized(item.size, 0.6)]) {
        for (const slot of places(item, size)) {
          // Half a metre past the edge is a chair pulled out from a table. More
          // than that is a person sitting in the aisle, and the engine walks
          // them there and calls it a seat.
          const out = Math.max(Math.abs(slot.x) - size.width / 2, Math.abs(slot.z) - size.depth / 2)
          if (out > 0.5) adrift.push(`${item.id} ${out.toFixed(2)} m out`)
        }
      }
    }
    expect(adrift).toEqual([])
  })

  it('never lays a cover inside the table top it belongs to', () => {
    const inside: string[] = []
    for (const item of SEATED) {
      if (item.category !== 'tables') continue
      const { width, depth } = item.size
      for (const slot of places(item)) {
        const clear =
          item.footprint === 'circle'
            ? Math.hypot(slot.x, slot.z) >= Math.min(width, depth) / 2
            : Math.abs(slot.x) >= width / 2 || Math.abs(slot.z) >= depth / 2
        if (!clear) inside.push(`${item.id} at (${slot.x.toFixed(2)}, ${slot.z.toFixed(2)})`)
      }
    }
    expect(inside).toEqual([])
  })

  it('turns every place that stands off its item back towards it', () => {
    // A facing that is reversed or a quarter turn out seats a whole table
    // looking away, which no check of the positions alone would catch. Against
    // the nearest edge rather than the centre, because a stool at one end of a
    // bar faces the bar in front of it, not the middle of the counter.
    const wrong: string[] = []
    for (const item of SEATED) {
      for (const slot of places(item)) {
        const edge = nearestEdge(item, slot, item.size)
        const dx = edge.x - slot.x
        const dz = edge.z - slot.z
        const range = Math.hypot(dx, dz)
        // A place on the item itself — a sofa cushion, a bench — has no
        // direction to face it from.
        if (range < 1e-6) continue
        const towards = (Math.cos(slot.facing) * dx + Math.sin(slot.facing) * dz) / range
        if (towards < 0.999) wrong.push(`${item.id} faces ${towards.toFixed(2)} of the way at it`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('offers a lean only where people actually stand', () => {
    // `kind` is what the library panel draws hollow and what `tableWithChairs`
    // skips when it sets real chairs out. A lean at a 0.75 m dining table would
    // stand somebody at a table laid for dinner; a seat at a poseur would tuck
    // a chair under a table nobody sits at.
    const leaning = SEATED.filter((item) => places(item).some((slot) => slot.kind === 'lean'))
    expect(leaning.map((item) => item.id).sort()).toEqual(['counter-bar', 'table-poseur'])
    for (const item of leaning) {
      expect(item.size.height).toBeCloseTo(1.1, 6)
      // Mixed kinds at one item would seat half a party and stand the other half.
      expect(places(item).map((slot) => slot.kind)).toEqual(places(item).map(() => 'lean'))
    }
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

  it('lays a bench row down the length of the table it belongs to', () => {
    // A cover laid past the end of the table is one the engine walks somebody
    // out to and seats facing the gangway, with `tableWithChairs` standing a
    // real chair out there for the plan to draw floating in the aisle.
    const trestle = resolveCatalogItem('table-rect-6ft')
    const xs = places(trestle).map((slot) => slot.x)
    expect([...new Set(xs)].sort((a, b) => a - b)).toHaveLength(3)
    // Three a side on a 6 ft trestle, each with 0.61 m of it, and the end pair
    // half a cover in from the ends of a top that runs -0.915 to 0.915.
    expect(places(trestle)).toHaveLength(6)
    expect(Math.min(...xs)).toBeCloseTo(-0.6097, 4)
    expect(Math.max(...xs)).toBeCloseTo(0.6097, 4)
    expect(trestle.size.width / 2 - Math.max(...xs)).toBeCloseTo(0.3048, 4)

    const conference = resolveCatalogItem('table-conference')
    const far = places(conference).map((slot) => slot.x)
    expect(far.filter((x) => Math.abs(x) > conference.size.width / 2)).toEqual([])
    expect(Math.max(...far)).toBeCloseTo(1.125, 6)

    // And every one of a boardroom's covers looks across the table rather than
    // over its shoulder at the wall.
    for (const slot of places(conference)) {
      const edge = nearestEdge(conference, slot, conference.size)
      const dx = edge.x - slot.x
      const dz = edge.z - slot.z
      const range = Math.hypot(dx, dz)
      expect((Math.cos(slot.facing) * dx + Math.sin(slot.facing) * dz) / range).toBeCloseTo(1, 12)
    }
  })

  it('offers places inside items that block, which the world then drops', () => {
    // Decided: a place on a sofa, a bench or an armchair is on the cushion,
    // where a person actually sits, and those three block — so `buildWorld`,
    // which keeps only places on a free navigation cell, drops every one of
    // them. The catalog side of this is right: moving the cushion off the
    // furniture to satisfy the grid would draw people sitting in mid-air beside
    // it, and dropping `blocking` would let the crowd walk through a sofa. The
    // fix belongs in src/sim/world.ts, where the filter would have to ignore
    // the seat's own item — its footprint is not an obstacle to the person
    // sitting on it. Until then the count in the library panel and the
    // inspector's header is a count the simulation will not honour.
    const unreachable = SEATED.filter((item) =>
      places(item).every((slot) => !standsOnFreeFloor(item, slot)),
    )
    expect(unreachable.map((item) => item.id).sort()).toEqual(['armchair', 'bench', 'sofa-2'])

    // Everything else offers every one of its places on free floor: no item is
    // half usable, which is what a borderline seat would look like.
    const partial = SEATED.filter((item) => {
      const free = places(item).filter((slot) => standsOnFreeFloor(item, slot))
      return free.length > 0 && free.length < places(item).length
    })
    expect(partial.map((item) => item.id)).toEqual([])

    // Not a near miss either: a sofa cushion is well over half a metre inside
    // the patch the grid has already closed.
    const sofa = resolveCatalogItem('sofa-2')
    const slot = places(sofa)[0]
    const shortfall = Math.min(
      (sofa.size.width - sofa.inset * 2) / 2 + NAV_CLEARANCE - Math.abs(slot.x),
      (sofa.size.depth - sofa.inset * 2) / 2 + NAV_CLEARANCE - Math.abs(slot.z),
    )
    expect(shortfall).toBeCloseTo(0.59, 2)
  })
})

describe('building the geometry', () => {
  it('builds something solid at its default size', () => {
    const broken = CATALOG.flatMap((item) => built(item, item.size))
    expect(broken).toEqual([])
  })

  it('builds at any size a saved document can carry', () => {
    // Every item is resizable in practice, whatever its `resize` mode says: a
    // document carries a `size` for any item and the loader keeps it, so a
    // builder that only works at its default size breaks on reload. Free resize
    // moves width and depth independently, so the stretches are not all square.
    // The fourth corner — wide and shallow — is where `screen-tv` inverts, and
    // it is pinned in 'turns inside out at sizes the inspector will still
    // accept' instead of here.
    const broken: string[] = []
    for (const item of CATALOG) {
      for (const [w, d] of [
        [0.6, 0.6],
        [1.8, 1.8],
        [0.5, 3],
      ]) {
        const size = {
          width: item.size.width * w,
          depth: item.size.depth * d,
          height: item.size.height,
        }
        broken.push(...built(item, size, ` at ${w} by ${d}`))
      }
    }
    expect(broken).toEqual([])
  })

  it('builds the same thing every time, from a size it never writes to', () => {
    // `planSeats` and the renderer hand the builder the document's own `size`
    // object. A builder that scribbled on it would edit the plan from inside
    // the renderer, outside `apply`, where undo cannot see it. And geometry is
    // merged and cached once per entry, so a builder that answered differently
    // the second time would ship whichever call happened to come first.
    const unstable: string[] = []
    for (const item of CATALOG) {
      const frozen: Size = Object.freeze({ ...item.size })
      try {
        item.build(frozen)
        item.seats?.(frozen)
      } catch (error) {
        unstable.push(`${item.id} writes to its size: ${String(error)}`)
      }
      if (JSON.stringify(item.build(item.size)) !== JSON.stringify(item.build(item.size))) {
        unstable.push(`${item.id} builds differently twice`)
      }
      if (JSON.stringify(places(item)) !== JSON.stringify(places(item))) {
        unstable.push(`${item.id} lays its places out differently twice`)
      }
    }
    expect(unstable).toEqual([])
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

  it('draws its body inside the extent the plan view shows', () => {
    // The plan view and the inspector both report the declared size, and the
    // collision footprint is that size or smaller. A body drawn wider is a
    // thing people walk through on screen. Feet, bases and floor discs are
    // allowed out because you step over them.
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
    // Decided: a builder is plain arithmetic over the size it is handed, and
    // nothing clamps the result. Width and depth are typed straight into the
    // inspector, floored at 0.1 m with no ceiling (src/app/panels/
    // InspectorPanel.tsx), so every size below is one a user can reach by hand
    // and every item here draws something turned inside out at it.
    //
    // Left alone because the alternative is a clamp in each of forty-nine
    // builders — arithmetic nobody could read afterwards — for a fault that is
    // visible the moment it is drawn and that the engine never sees: the
    // footprint people walk around comes from the declared size, not from the
    // geometry. The inventory is pinned instead, so a new item that folds up at
    // an ordinary size shows here rather than in a venue.
    const tv = resolveCatalogItem('screen-tv')
    const pole = (size: Size): number => {
      const prim = tv.build(size).find((part) => part.type === 'cyl')
      return prim?.type === 'cyl' ? prim.h : NaN
    }
    expect(built(tv, { width: 2.9, depth: 0.3, height: 1.7 })).toEqual([])
    expect(pole({ width: 2.9, depth: 0.3, height: 1.7 })).toBeCloseTo(0.018, 6)
    // The pole is `height - width * 0.58`, so past a 2.94 m video wall — an
    // ordinary size to draw one — the screen is taller than the item, the pole
    // inverts, and the panel it holds up hangs 0.6 m through the floor.
    expect(pole({ width: 4, depth: 0.3, height: 1.7 })).toBeCloseTo(-0.62, 6)
    expect(bottomOf(tv.build({ width: 4, depth: 0.3, height: 1.7 }))).toBeCloseTo(-0.6, 6)

    // The same cause, one item over: height never scales, so anything
    // proportioned off width eventually outgrows what holds it up. A potted
    // plant's leaves are `width * 0.312` tall about a pot 0.56 m up, so from
    // 1.79 m across the foliage hangs below the floor it stands on.
    const plant = resolveCatalogItem('plant-small')
    expect(built(plant, resized(plant.size, 3.4))).toEqual([])
    expect(built(plant, resized(plant.size, 4))).toEqual([
      'plant-small: sunk 0.066 m through the floor',
    ])

    // A booth's shared table is `depth - 0.75`, so a shallow banquette — still
    // deep enough for two benches and a table on the drawing — loses its table.
    const booth = resolveCatalogItem('booth')
    expect(built(booth, { width: 1.6, depth: 0.7, height: 1.2 })).toEqual([
      'booth: box -0.050 across',
    ])

    // Pulled in to the inspector's own minimum, fourteen of the forty-nine
    // entries build parts of negative or zero size. Ten of them are items the
    // inspector itself resizes; the rest need a hand-edited document to reach.
    const shrunk = CATALOG.filter(
      (item) =>
        built(item, { width: MIN_EDITABLE, depth: MIN_EDITABLE, height: item.size.height }).length >
        0,
    )
    expect(shrunk.map((item) => item.id).sort()).toEqual([
      'armchair',
      'artwork',
      'booth',
      'counter-buffet',
      'counter-reception',
      'kiosk',
      'plant-small',
      'rug',
      'screen-tv',
      'seat-row',
      'shelving',
      'sofa-2',
      'stool-bar',
      'wheelchair-space',
    ])
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
    expect(built(FALLBACK_ITEM, FALLBACK_ITEM.size)).toEqual([])
    expect(built(FALLBACK_ITEM, { width: 3, depth: 0.4, height: 2 })).toEqual([])
    // It has to survive the sizes that defeat half the real catalog, because a
    // document from a newer build carries whatever size that build allowed.
    expect(built(FALLBACK_ITEM, { width: MIN_EDITABLE, depth: MIN_EDITABLE, height: 0.8 })).toEqual(
      [],
    )
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
