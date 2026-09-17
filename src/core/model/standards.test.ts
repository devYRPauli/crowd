import { describe, expect, it } from 'vitest'
import {
  CODE_MINIMUMS,
  DEFAULT_DOOR_HEIGHT,
  DEFAULT_DOOR_WIDTH,
  DEFAULT_DOUBLE_DOOR_WIDTH,
  DEFAULT_WALL_HEIGHT,
  DEFAULT_WALL_THICKNESS,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_SILL,
  DEFAULT_WINDOW_WIDTH,
  DOOR_HEIGHTS,
  DOOR_WIDTHS,
  DOUBLE_DOOR_FROM,
  OPENING_JAMB,
  WALL_HEIGHTS,
  WALL_THICKNESSES,
  WINDOW_HEIGHTS,
  WINDOW_SILLS,
  WINDOW_WIDTHS,
  isStandard,
  nearestStandard,
} from './standards'
import type { StandardSize } from './standards'
import { formatLength, parseLength } from './units'

/** The inch, as the 1959 agreement defines it and as a supplier prices it. */
const INCH = 0.0254

const CATALOGUES = [
  { name: 'DOOR_WIDTHS', sizes: DOOR_WIDTHS },
  { name: 'DOOR_HEIGHTS', sizes: DOOR_HEIGHTS },
  { name: 'WINDOW_WIDTHS', sizes: WINDOW_WIDTHS },
  { name: 'WINDOW_HEIGHTS', sizes: WINDOW_HEIGHTS },
  { name: 'WINDOW_SILLS', sizes: WINDOW_SILLS },
  { name: 'WALL_THICKNESSES', sizes: WALL_THICKNESSES },
  { name: 'WALL_HEIGHTS', sizes: WALL_HEIGHTS },
]

/**
 * Reads a label the way a user reads it — `3'0"`, `4½"`, `6'0" pair` — rather
 * than the way the table builds it. The label and the number are written on the
 * same line from two different `feet()`/`inches()` calls that look alike in a
 * diff, so a size can end up called one thing and drawn as another. That is the
 * failure worth catching: the picker offers a 2'8" leaf and the plan gets a
 * 2'6" opening, and every egress figure computed from it inherits the error.
 */
const labelInches = (imperial: string): number => {
  const cleaned = imperial.replace(/ pair$/, '').replace('½', '.5')
  const feetAndInches = cleaned.match(/^(\d+)'(\d+(?:\.\d+)?)"$/)
  if (feetAndInches) return Number(feetAndInches[1]) * 12 + Number(feetAndInches[2])
  const bareInches = cleaned.match(/^(\d+(?:\.\d+)?)"$/)
  if (bareInches) return Number(bareInches[1])
  throw new Error(`unreadable imperial label: ${imperial}`)
}

/** A nominal inch figure as the module stores it: 25.4 mm to the inch, to the mm. */
const metricOf = (nominalInches: number): number => Math.round(nominalInches * 25.4) / 1000

const isPair = (size: StandardSize): boolean => size.imperial.endsWith('pair')

/** `WINDOW_WIDTHS 4'0"` — enough to name the offender when a table check fails. */
const named = (name: string, size: StandardSize): string => `${name} ${size.imperial}`

const everySize = CATALOGUES.flatMap(({ name, sizes }) =>
  sizes.map((size) => ({ name, size, sizes })),
)

describe('the size catalogue', () => {
  it.each(CATALOGUES)('$name stores the metric value of every imperial label', ({ sizes }) => {
    expect(sizes.map((size) => [size.imperial, size.metres])).toEqual(
      sizes.map((size) => [size.imperial, metricOf(labelInches(size.imperial))]),
    )
  })

  it('converts at 25.4 mm to the inch, rounded to the millimetre', () => {
    // Hand-computed, deliberately, and spread across every table: 24 x 25.4 =
    // 609.6 mm (rounds up), 36 x 25.4 = 914.4 (rounds down), 80 x 25.4 = 2032
    // (exact), 4.5 x 25.4 = 114.3, 108 x 25.4 = 2743.2. The label check above
    // shares its arithmetic with the module, so it would happily agree with a
    // changed conversion factor; these literals would not.
    expect(DOOR_WIDTHS[0].metres).toBe(0.61)
    expect(DEFAULT_DOOR_WIDTH).toBe(0.914)
    expect(DEFAULT_DOOR_HEIGHT).toBe(2.032)
    expect(DEFAULT_DOUBLE_DOOR_WIDTH).toBe(1.829)
    expect(DEFAULT_WINDOW_WIDTH).toBe(1.219)
    expect(DEFAULT_WINDOW_SILL).toBe(0.914)
    expect(WINDOW_SILLS[0].metres).toBe(0.305)
    expect(DEFAULT_WALL_THICKNESS).toBe(0.165)
    expect(WALL_THICKNESSES[0].metres).toBe(0.114)
    expect(DEFAULT_WALL_HEIGHT).toBe(2.743)
    expect(WALL_HEIGHTS[4].metres).toBe(4.877)
    expect(DOUBLE_DOOR_FROM).toBe(1.524)
    expect(OPENING_JAMB).toBe(0.051)
  })

  it('carries every size in whole millimetres', () => {
    // Sizes are compared, summed and serialised all over the product; a value
    // carrying a fraction of a millimetre of conversion dust makes two plans
    // built the same way differ in the tenth decimal, and the "Not a stock
    // size" hint is decided half a millimetre either side of these numbers.
    const dusty = everySize
      .filter(({ size }) => size.metres * 1000 !== Math.round(size.metres * 1000))
      .map(({ name, size }) => named(name, size))
    expect(dusty).toEqual([])
  })

  it('offers doors and windows only in even inches', () => {
    // Leaves and sashes are made in even inches; a 2'7" door or a 4'3" window
    // is a custom order, and offering one as stock prices the plan wrong.
    const odd = everySize
      .filter(({ name }) => name !== 'WALL_THICKNESSES' && name !== 'WALL_HEIGHTS')
      .filter(({ size }) => labelInches(size.imperial) % 2 !== 0)
      .map(({ name, size }) => named(name, size))
    expect(odd).toEqual([])
  })

  it('reserves the half-inch sizes for walls, where a stud makes them', () => {
    // 3½" of stud plus ½" of board each side is 4½", and the same sum on a 2x6
    // is 6½". These are the only sizes in the product that are not whole
    // inches, and they are not roundable: 4" of wall does not exist.
    expect(WALL_THICKNESSES.map((size) => labelInches(size.imperial))).toEqual([4.5, 6.5, 8, 12])
    const fractional = everySize
      .filter(({ size }) => labelInches(size.imperial) % 1 !== 0)
      .map(({ name, size }) => named(name, size))
    expect(fractional).toEqual([`WALL_THICKNESSES 4½"`, `WALL_THICKNESSES 6½"`])
  })

  it.each(CATALOGUES)('$name ascends with no repeated size', ({ sizes }) => {
    // The picker renders the list in array order and `nearestStandard` walks it
    // in array order, so an out-of-order entry reads as a typo to the user and
    // a duplicate makes one of the two unreachable.
    const metres = sizes.map((size) => size.metres)
    expect(metres.length).toBeGreaterThan(0)
    expect(metres).toEqual([...metres].sort((a, b) => a - b))
    expect(new Set(metres).size).toBe(metres.length)
  })

  it.each(CATALOGUES)('$name labels each size distinctly', ({ sizes }) => {
    // The inspector's stock-size select round-trips through `imperial`: it
    // finds the chosen size by label. Two entries sharing one would silently
    // commit the wrong width.
    const labels = sizes.map((size) => size.imperial)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('the metric round trip', () => {
  it('still measures every size as its own nominal, to the nearest half inch', () => {
    // Back through the inch and onto the nearest half — what a schedule or a
    // dimension string has to come out as. Anything that lands on a different
    // size has re-dimensioned the opening.
    const misread = everySize
      .filter(({ size }) => Math.round((size.metres / INCH) * 2) / 2 !== labelInches(size.imperial))
      .map(({ name, size }) => named(name, size))
    expect(misread).toEqual([])
  })

  it('recognises a size the user typed rather than picked', () => {
    // The inspector accepts a typed length and then asks `isStandard` whether
    // to flag it. Typing the very size the picker offers must not come back
    // "Not a stock size" — but the two paths never produce the same float: the
    // catalogue rounds to the millimetre and `parseLength` does not. The
    // feet-and-inches form means the same thing in a metric document as in an
    // imperial one, so the setting must not decide whether it is recognised.
    const flagged = everySize.flatMap(({ name, size, sizes }) =>
      (['metric', 'imperial'] as const)
        .map((units) => parseLength(size.imperial.replace(/ pair$/, '').replace('½', '.5'), units))
        .filter((typed) => typed === null || !isStandard(sizes, typed))
        .map(() => named(name, size)),
    )
    expect(flagged).toEqual([])
  })

  it('leaves only a tenth of a millimetre of slack in that recognition', () => {
    // Rounding a whole-inch size to the millimetre costs at most 0.4 mm, and
    // `isStandard` forgives 0.5 mm. That 0.1 mm is the whole margin: convert
    // these to the centimetre instead and every typed size turns non-standard.
    const worst = Math.max(
      ...everySize.map(({ size }) => Math.abs(size.metres - labelInches(size.imperial) * INCH)),
    )
    expect(worst).toBeCloseTo(0.0004, 6)
    expect(worst).toBeLessThan(0.0005)
  })

  it('quotes a pair by its total, which is not twice a catalogued leaf', () => {
    // 6'0" is 1828.8 mm rounded up to 1829; a 3'0" leaf is 914.4 rounded down
    // to 914. Half the pair is therefore 0.5 mm off the leaf — the whole of
    // `isStandard`'s tolerance, landing so exactly on it that which side it
    // falls is down to the last bit of the division. Nothing may work out a
    // leaf by halving a pair and then ask whether it is a stock size.
    const pairOf6 = DOOR_WIDTHS.find((size) => size.imperial === `6'0" pair`)
    const leaf = DOOR_WIDTHS.find((size) => size.imperial === `3'0"`)
    expect(Math.abs((pairOf6?.metres ?? 0) / 2 - (leaf?.metres ?? 0))).toBeCloseTo(0.0005, 6)
    // The nominal totals are right even so, which is what a schedule quotes.
    expect(pairOf6?.metres).toBe(metricOf(72))
    expect(leaf?.metres).toBe(metricOf(36))
  })
})

describe('the defaults', () => {
  const DEFAULTS = [
    { name: 'DEFAULT_DOOR_WIDTH', value: DEFAULT_DOOR_WIDTH, sizes: DOOR_WIDTHS, imperial: `3'0"` },
    {
      name: 'DEFAULT_DOUBLE_DOOR_WIDTH',
      value: DEFAULT_DOUBLE_DOOR_WIDTH,
      sizes: DOOR_WIDTHS,
      imperial: `6'0" pair`,
    },
    {
      name: 'DEFAULT_DOOR_HEIGHT',
      value: DEFAULT_DOOR_HEIGHT,
      sizes: DOOR_HEIGHTS,
      imperial: `6'8"`,
    },
    {
      name: 'DEFAULT_WINDOW_WIDTH',
      value: DEFAULT_WINDOW_WIDTH,
      sizes: WINDOW_WIDTHS,
      imperial: `4'0"`,
    },
    {
      name: 'DEFAULT_WINDOW_HEIGHT',
      value: DEFAULT_WINDOW_HEIGHT,
      sizes: WINDOW_HEIGHTS,
      imperial: `4'0"`,
    },
    {
      name: 'DEFAULT_WINDOW_SILL',
      value: DEFAULT_WINDOW_SILL,
      sizes: WINDOW_SILLS,
      imperial: `3'0"`,
    },
    {
      name: 'DEFAULT_WALL_THICKNESS',
      value: DEFAULT_WALL_THICKNESS,
      sizes: WALL_THICKNESSES,
      imperial: `6½"`,
    },
    {
      name: 'DEFAULT_WALL_HEIGHT',
      value: DEFAULT_WALL_HEIGHT,
      sizes: WALL_HEIGHTS,
      imperial: `9'0"`,
    },
  ]

  it.each(DEFAULTS)('$name is the $imperial its name promises', ({ value, sizes, imperial }) => {
    // A default that drifts off its list shows the inspector an opening flagged
    // "Not a stock size" the instant it is placed, and snaps to something else
    // the moment the stock-size picker is touched. A default that stays in the
    // list but moves to the neighbouring entry is worse: nothing complains, and
    // every venue built afterwards is a size out.
    const entry = sizes.find((size) => size.imperial === imperial)
    expect(entry?.metres).toBe(value)
    expect(value).toBe(metricOf(labelInches(imperial)))
  })

  it('places the default door above the egress minimums', () => {
    // 3'0" nominal is what yields IBC 1010.1.1's 32" of *clear* width once the
    // stop and the leaf are taken off, so the nominal has to sit above 32" with
    // room to spare — 4" of it, which the millimetre rounding renders as 101 mm
    // rather than 101.6. Two rounded standards subtracted are up to 0.6 mm off
    // their nominal difference, so a clear-width check has to be a comparison
    // and never an equality.
    expect(DEFAULT_DOOR_WIDTH).toBeGreaterThan(CODE_MINIMUMS.egressDoorClearWidth)
    expect(DEFAULT_DOOR_WIDTH - CODE_MINIMUMS.egressDoorClearWidth).toBeCloseTo(0.101, 9)
    // The height has no margin at all: 6'8" *is* the 80" minimum. Shaving a
    // millimetre off the standard head height puts every door under code.
    expect(DEFAULT_DOOR_HEIGHT).toBe(CODE_MINIMUMS.egressDoorHeight)
  })

  it('offers no leaf wider than IBC 1010.1.1 allows', () => {
    // A pair is catalogued by its total, so the leaf is half of it. The widest
    // thing the picker can commit as one leaf has to stay inside the 48" cap,
    // or the stock list itself hands the user a non-compliant exit.
    for (const size of DOOR_WIDTHS) {
      const leaf = isPair(size) ? size.metres / 2 : size.metres
      expect(leaf).toBeLessThanOrEqual(CODE_MINIMUMS.egressLeafMaxWidth)
    }
  })
})

describe('DOUBLE_DOOR_FROM', () => {
  it('splits the door catalogue exactly where the labels do', () => {
    // `placementTools` and `planBuilder` both turn a width at or above this
    // into kind 'double-door'. If a single leaf reached the threshold, picking
    // that stock size would draw two leaves; if a pair fell below it, a 5'0"
    // pair would be drawn as one 5'0" leaf, which is not a thing that exists.
    for (const size of DOOR_WIDTHS) {
      if (isPair(size)) expect(size.metres).toBeGreaterThanOrEqual(DOUBLE_DOOR_FROM)
      else expect(size.metres).toBeLessThan(DOUBLE_DOOR_FROM)
    }
    expect(DOOR_WIDTHS.some(isPair)).toBe(true)
    expect(DOOR_WIDTHS.some((size) => !isPair(size))).toBe(true)
    // And the two defaults land on the side their names claim: a single door
    // placed at the default width must not arrive as a pair, and the default
    // pair must not arrive as one impossible leaf.
    expect(DEFAULT_DOOR_WIDTH).toBeLessThan(DOUBLE_DOOR_FROM)
    expect(DEFAULT_DOUBLE_DOOR_WIDTH).toBeGreaterThanOrEqual(DOUBLE_DOOR_FROM)
  })

  it('is itself an orderable size, and the smallest pair anybody hangs', () => {
    // The threshold is a size, not a number between two sizes, so the first
    // pair in the picker lands on it and is drawn as a pair rather than one
    // leaf short of the test above. Two 2'6" leaves is that pair.
    expect(DOUBLE_DOOR_FROM).toBe(1.524)
    expect(isStandard(DOOR_WIDTHS, DOUBLE_DOOR_FROM)).toBe(true)
    expect(DOUBLE_DOOR_FROM / 2).toBe(metricOf(30))
  })

  it('leaves a band of widths that are drawn as one leaf and made as two', () => {
    // Anything dragged between the 48" leaf cap and the threshold commits as a
    // single leaf: 4'6" is drawn as one door, and one door that wide is neither
    // made nor allowed on an exit. The catalogue never offers a size in there —
    // its widest single is 3'6" — so this is reachable only by a free drag.
    const widestSingle = DOOR_WIDTHS.filter((size) => !isPair(size)).at(-1)
    expect(widestSingle?.imperial).toBe(`3'6"`)
    expect(widestSingle?.metres).toBeLessThan(CODE_MINIMUMS.egressLeafMaxWidth)
    expect(DOUBLE_DOOR_FROM).toBeGreaterThan(CODE_MINIMUMS.egressLeafMaxWidth)
    // Touching the stock-size picker is the way out of the band: a 4'3" drag
    // reads as the 5'0" pair, which is what the drawing then commits.
    expect(nearestStandard(DOOR_WIDTHS, 1.3)?.imperial).toBe(`5'0" pair`)
  })
})

describe('OPENING_JAMB', () => {
  it('keeps two inches of wall on each side of an opening', () => {
    // `mutations.updateOpening` clamps a width to the wall length less two of
    // these, and the inspector clamps the width box and the position slider to
    // the same. Two inches is the least that reads as construction; at zero the
    // width box accepts the whole wall, which deletes the wall from the plan
    // without deleting it from the document.
    expect(OPENING_JAMB).toBe(0.051)
    expect(OPENING_JAMB).toBeCloseTo(2 * INCH, 3)
  })

  it('lets a standard door fit a wall barely over a metre', () => {
    // Doors land on short wall stubs all the time — a lobby return, the side of
    // a vestibule. A jamb generous enough to squeeze a 3'0" leaf off those
    // walls would silently narrow the plan's main entry.
    expect(DEFAULT_DOOR_WIDTH + 2 * OPENING_JAMB).toBeCloseTo(1.016, 9)
    expect(2 * OPENING_JAMB).toBeLessThan(DOOR_WIDTHS[0].metres)
  })
})

describe('CODE_MINIMUMS', () => {
  it('quotes IBC 1010.1.1 and ADA 404.2.3 at the figures they print', () => {
    // 32" clear width and an 80" head in both codes; 48" is the most a single
    // egress leaf may be. In metres: 32 x 25.4 = 812.8 mm, 80 x 25.4 = 2032,
    // 48 x 25.4 = 1219.2. These are quoted to the user beside a pass or fail,
    // so a number that is merely close is a wrong compliance answer.
    expect(CODE_MINIMUMS.egressDoorClearWidth).toBe(0.813)
    expect(CODE_MINIMUMS.egressDoorClearWidth).toBeCloseTo(32 * INCH, 3)
    expect(CODE_MINIMUMS.egressDoorHeight).toBe(2.032)
    expect(CODE_MINIMUMS.egressDoorHeight).toBeCloseTo(80 * INCH, 3)
    expect(CODE_MINIMUMS.egressLeafMaxWidth).toBe(1.219)
    expect(CODE_MINIMUMS.egressLeafMaxWidth).toBeCloseTo(48 * INCH, 3)
    expect(CODE_MINIMUMS.egressDoorClearWidth).toBeLessThan(CODE_MINIMUMS.egressLeafMaxWidth)
  })

  it('quotes IBC 1020.2 corridors at 44 inches over fifty people and 36 under', () => {
    // 44 x 25.4 = 1117.6 mm, 36 x 25.4 = 914.4. The occupant load of 50 is the
    // step between them, and the wider figure has to be the wider number: a
    // swap would report the busiest corridors in a venue as compliant.
    expect(CODE_MINIMUMS.corridorWidthOver50).toBe(1.118)
    expect(CODE_MINIMUMS.corridorWidthOver50).toBeCloseTo(44 * INCH, 3)
    expect(CODE_MINIMUMS.corridorWidthUnder50).toBe(0.914)
    expect(CODE_MINIMUMS.corridorWidthUnder50).toBeCloseTo(36 * INCH, 3)
    expect(CODE_MINIMUMS.corridorWidthOver50).toBeGreaterThan(CODE_MINIMUMS.corridorWidthUnder50)
  })

  it('quotes IBC 1003.2 headroom at 7\'6", above any door it could be measured over', () => {
    // 90 x 25.4 = 2286 mm, and it is a ceiling over a route, not a door head:
    // it must clear the 80" head, and the shortest stock wall must clear it in
    // turn or every residential plan reads as non-compliant on placement.
    expect(CODE_MINIMUMS.egressCeilingHeight).toBe(2.286)
    expect(CODE_MINIMUMS.egressCeilingHeight).toBeCloseTo(90 * INCH, 3)
    expect(CODE_MINIMUMS.egressCeilingHeight).toBeGreaterThan(CODE_MINIMUMS.egressDoorHeight)
    expect(WALL_HEIGHTS[0].metres).toBeGreaterThan(CODE_MINIMUMS.egressCeilingHeight)
  })

  it('lands three of its clear dimensions on a stock nominal, which is the trap', () => {
    // 32" clear is also a 2'8" leaf, 36" of corridor is also a 3'0" leaf, and
    // the 80" head is the 6'8" door exactly. A nominal leaf does not deliver
    // its own width through the opening — the stop and the open leaf take their
    // share — so a check that compares a nominal against these passes doors
    // that fail. That arithmetic is why 3'0" is the entry door and why the
    // narrower sizes are labelled closet, bathroom and interior rather than
    // offered as a way to save a foot on an exit.
    const interior = DOOR_WIDTHS.find((size) => size.imperial === `2'8"`)
    expect(interior?.metres).toBe(CODE_MINIMUMS.egressDoorClearWidth)
    expect(interior?.note).toBe('Interior standard')
    expect(isStandard(DOOR_WIDTHS, CODE_MINIMUMS.corridorWidthUnder50)).toBe(true)
    expect(isStandard(DOOR_HEIGHTS, CODE_MINIMUMS.egressDoorHeight)).toBe(true)
    // The other three are not sizes anybody orders, and must never read as one.
    expect(isStandard(DOOR_WIDTHS, CODE_MINIMUMS.egressLeafMaxWidth)).toBe(false)
    expect(isStandard(DOOR_WIDTHS, CODE_MINIMUMS.corridorWidthOver50)).toBe(false)
    expect(isStandard(WALL_HEIGHTS, CODE_MINIMUMS.egressCeilingHeight)).toBe(false)
  })
})

describe('nearestStandard', () => {
  it('picks the closest entry, not the first one past the measurement', () => {
    expect(nearestStandard(DOOR_WIDTHS, 0.85)?.imperial).toBe(`2'8"`)
    expect(nearestStandard(DOOR_WIDTHS, 0.87)?.imperial).toBe(`3'0"`)
    expect(nearestStandard(DOOR_WIDTHS, 0.9)?.imperial).toBe(`3'0"`)
  })

  it('hands back the catalogue entry itself, not a copy of it', () => {
    // The inspector re-finds the chosen size in the list by its label and
    // commits *that* entry's metres; a copy that drifted from the list would
    // show one size in the select and commit another.
    expect(nearestStandard(DOOR_WIDTHS, DEFAULT_DOOR_WIDTH)).toBe(
      DOOR_WIDTHS.find((size) => size.imperial === `3'0"`),
    )
    expect(nearestStandard(WALL_HEIGHTS, DEFAULT_WALL_HEIGHT)).toBe(
      WALL_HEIGHTS.find((size) => size.imperial === `9'0"`),
    )
  })

  it('clamps to the ends instead of giving up outside the range', () => {
    // A drag can go anywhere; the picker still has to show a selection.
    expect(nearestStandard(DOOR_WIDTHS, 0.05)?.imperial).toBe(`2'0"`)
    expect(nearestStandard(DOOR_WIDTHS, -3)?.imperial).toBe(`2'0"`)
    expect(nearestStandard(DOOR_WIDTHS, 50)?.imperial).toBe(`8'0" pair`)
  })

  it('stays on the lower size at an exact midpoint', () => {
    // 0.61 and 0.711 are a millimetre grid apart in a way that makes their
    // midpoint an exact tie in binary floating point, so this is a real tie and
    // not a rounding artefact. First-wins is what keeps a drag parked on the
    // midpoint from flickering between two labels.
    const midpoint = (DOOR_WIDTHS[0].metres + DOOR_WIDTHS[1].metres) / 2
    expect(midpoint - DOOR_WIDTHS[0].metres).toBe(DOOR_WIDTHS[1].metres - midpoint)
    expect(nearestStandard(DOOR_WIDTHS, midpoint)?.imperial).toBe(DOOR_WIDTHS[0].imperial)
  })

  it('returns null when there is nothing to pick', () => {
    expect(nearestStandard([], 0.914)).toBeNull()
  })

  it('returns null for a measurement that is not a real length', () => {
    // Current behaviour, and the reason it is worth pinning: every gap against
    // NaN or an infinity compares false against a starting gap of Infinity, so
    // the scan falls through the whole catalogue rather than snapping to an
    // end. The inspector renders that as a blank picker, which beats silently
    // claiming the width is 2'0".
    expect(nearestStandard(DOOR_WIDTHS, Number.NaN)).toBeNull()
    expect(nearestStandard(DOOR_WIDTHS, Infinity)).toBeNull()
    expect(nearestStandard(DOOR_WIDTHS, -Infinity)).toBeNull()
  })
})

describe('isStandard', () => {
  it.each(CATALOGUES)('recognises every $name entry', ({ sizes }) => {
    for (const size of sizes) expect(isStandard(sizes, size.metres)).toBe(true)
  })

  it('rejects the round metric numbers this module exists to replace', () => {
    // A 1.0 m door is 3½" wider than a 3'0" leaf — the difference between two
    // people abreast and one — and nobody makes one. The inspector's "Not a
    // stock size" hint is driven by exactly this call.
    expect(isStandard(DOOR_WIDTHS, 1.0)).toBe(false)
    expect(isStandard(WALL_HEIGHTS, 3.0)).toBe(false)
    expect(isStandard(WALL_THICKNESSES, 0.1)).toBe(false)
  })

  it('is millimetre-tight rather than approximate', () => {
    // Sub-millimetre slack absorbs the float error of a metres/feet round trip;
    // a whole millimetre is a different size and has to read as one. Both signs
    // matter: without the absolute value, everything above a stock size passes.
    expect(isStandard(DOOR_WIDTHS, DEFAULT_DOOR_WIDTH + 0.0004)).toBe(true)
    expect(isStandard(DOOR_WIDTHS, DEFAULT_DOOR_WIDTH - 0.0004)).toBe(true)
    expect(isStandard(DOOR_WIDTHS, DEFAULT_DOOR_WIDTH + 0.0006)).toBe(false)
    expect(isStandard(DOOR_WIDTHS, DEFAULT_DOOR_WIDTH - 0.0006)).toBe(false)
    expect(isStandard(DOOR_WIDTHS, DEFAULT_DOOR_WIDTH + 0.001)).toBe(false)
  })

  it('does not confuse one catalogue with another', () => {
    // 6'8" is a stock door height and a stock storefront window head, but not a
    // door width; the lists are passed in by the caller and mixing them up is
    // the easy mistake.
    expect(isStandard(DOOR_HEIGHTS, DEFAULT_DOOR_HEIGHT)).toBe(true)
    expect(isStandard(WINDOW_HEIGHTS, DEFAULT_DOOR_HEIGHT)).toBe(true)
    expect(isStandard(DOOR_WIDTHS, DEFAULT_DOOR_HEIGHT)).toBe(false)
  })

  it('flags a width it cannot measure rather than waving it through', () => {
    // A half-typed or cleared width box reaches the hint before it reaches the
    // document. "Not a stock size" is the honest answer for a non-number.
    expect(isStandard(DOOR_WIDTHS, Number.NaN)).toBe(false)
    expect(isStandard(DOOR_WIDTHS, Infinity)).toBe(false)
    expect(isStandard([], DEFAULT_DOOR_WIDTH)).toBe(false)
  })
})

describe('the sizes against each other', () => {
  it('fits the tallest stock door into the shortest stock wall exactly', () => {
    // An 8'0" door in an 8'0" room leaves no header at all — the inspector
    // caps a door's height at the wall's, so this is the boundary rather than
    // an impossibility. A door catalogued any taller could not be placed in a
    // residential plan at all.
    const tallestDoor = DOOR_HEIGHTS.at(-1)?.metres ?? 0
    expect(tallestDoor).toBe(WALL_HEIGHTS[0].metres)
    expect(DEFAULT_DOOR_HEIGHT).toBeLessThan(WALL_HEIGHTS[0].metres)
  })

  it('puts the default window head well under the default wall', () => {
    // Sill plus height is where the head lands, and the inspector clamps the
    // height to what the wall has left above the sill. The pair the editor
    // reaches for first must not arrive already clamped.
    expect(DEFAULT_WINDOW_SILL + DEFAULT_WINDOW_HEIGHT).toBeCloseTo(2.133, 9)
    expect(DEFAULT_WINDOW_SILL + DEFAULT_WINDOW_HEIGHT).toBeLessThan(DEFAULT_WALL_HEIGHT)
  })

  it('levels the storefront glass with the door head when it reaches the floor', () => {
    // The 6'8" glass is catalogued "head level with the doors", and that is the
    // window the inspector calls walkable: sill zero, glass to the floor. The
    // two numbers are the same to the last digit, not two conversions that
    // agree to a millimetre, so the elevation lines up rather than stepping.
    const glass = WINDOW_HEIGHTS.find((size) => size.note?.startsWith('Storefront'))
    expect(glass?.imperial).toBe(`6'8"`)
    expect(glass?.metres).toBe(DEFAULT_DOOR_HEIGHT)
    // On the 1'0" bulkhead the same table calls a storefront sill, the head
    // goes to 7'8" instead: the two entries are alternatives, not a pair. It
    // still fits a commercial wall, so nothing clamps and nothing warns.
    expect(WINDOW_SILLS[0].note).toBe('Storefront')
    expect(WINDOW_SILLS[0].metres + (glass?.metres ?? 0)).toBeCloseTo(2.337, 9)
    expect(WINDOW_SILLS[0].metres + (glass?.metres ?? 0)).toBeLessThan(DEFAULT_WALL_HEIGHT)
  })

  it('caps the sill list at the 44 inch escape maximum', () => {
    // IRC R310.2.2 will not let a bedroom's escape window sit higher, so the
    // list must not offer one that does: a sill taken from stock is a sill
    // somebody can climb out of.
    const highest = WINDOW_SILLS.at(-1)
    expect(highest?.metres).toBe(1.118)
    expect(highest?.metres).toBeCloseTo(44 * INCH, 3)
    expect(highest?.note).toBe(`Egress maximum is 44"`)
  })
})

describe('the imperial readout', () => {
  // A confirmed display fault, pinned here because the fix is not in this file.
  // `formatLength` splits the feet off with `Math.floor` and only then rounds
  // the remaining inches, so a total a hair under a whole foot prints `12.0"`
  // instead of carrying into the feet — and totals are always a hair under,
  // because INCHES_PER_METRE is truncated low (0.3048 x 39.37007874 =
  // 11.999999999952, not 12). It is not the catalogue's millimetre rounding: an
  // exact 6'0" of 1.8288 m reads `5' 12.0"` too, and the stock sizes that
  // escape are the ones whose rounding pushed them *up* past the shortfall. The
  // product's own default door is named 3'0" in the picker and reads `2' 12.0"`
  // in the inspector header beside it; the default wall reads `8' 12.0"`, the
  // default window `3' 12.0"`. Fifteen stock sizes are affected, and so is any
  // whole foot a user drags out. Rounding the total inches before splitting
  // them carries it, in src/core/model/units.ts. Nothing dimensional is wrong
  // in the document — see the round trip below — which is what makes it a
  // readout to correct rather than a plan to repair.
  it('names a whole number of feet as one foot short plus twelve inches', () => {
    expect(formatLength(DEFAULT_DOOR_WIDTH, 'imperial')).toBe(`2' 12.0"`)
    expect(formatLength(DEFAULT_WALL_HEIGHT, 'imperial')).toBe(`8' 12.0"`)
    expect(formatLength(DEFAULT_WINDOW_WIDTH, 'imperial')).toBe(`3' 12.0"`)
    expect(formatLength(1.8288, 'imperial')).toBe(`5' 12.0"`)

    // Which stock sizes escape is decided by the rounding direction alone:
    // 2'0" is 609.6 mm stored as 610 and 6'0" is 1828.8 stored as 1829, and
    // both clear the shortfall. That is what makes this a display fault rather
    // than a wrong number in the catalogue.
    expect(formatLength(DOOR_WIDTHS[0].metres, 'imperial')).toBe(`2' 0.0"`)
    expect(formatLength(DEFAULT_DOUBLE_DOOR_WIDTH, 'imperial')).toBe(`6' 0.0"`)

    // Every size named in feet *and* inches reads back exactly its own label,
    // so the fault is confined to the whole feet.
    for (const { size } of everySize) {
      const nominal = labelInches(size.imperial)
      if (nominal % 12 === 0) continue
      const feet = Math.floor(nominal / 12)
      const inches = (nominal % 12).toFixed(1)
      expect(formatLength(size.metres, 'imperial')).toBe(
        feet === 0 ? `${inches}"` : `${feet}' ${inches}"`,
      )
    }
  })

  it('still reads back as the same stock size when the user retypes it', () => {
    // What bounds the fault above: the inspector's own readout, typed straight
    // back into the width box, still commits the size it came from. `2' 12.0"`
    // parses as three feet, and the 0.4 mm that separates that from the stored
    // 0.914 stays inside `isStandard`. A misread size is never a resized one.
    expect(parseLength(`2' 12.0"`, 'imperial')).toBeCloseTo(DEFAULT_DOOR_WIDTH, 3)
    const lost = everySize
      .filter(({ size, sizes }) => {
        const typed = parseLength(formatLength(size.metres, 'imperial'), 'imperial')
        return typed === null || !isStandard(sizes, typed)
      })
      .map(({ name, size }) => named(name, size))
    expect(lost).toEqual([])
  })
})
