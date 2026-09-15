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

const isPair = (size: StandardSize): boolean => size.imperial.endsWith('pair')

const allSizes = (): StandardSize[] => CATALOGUES.flatMap((catalogue) => [...catalogue.sizes])

describe('the size catalogue', () => {
  it.each(CATALOGUES)('$name stores the metric value of every imperial label', ({ sizes }) => {
    for (const size of sizes) {
      expect([size.imperial, size.metres]).toEqual([
        size.imperial,
        Math.round(labelInches(size.imperial) * 25.4) / 1000,
      ])
    }
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

  it.each(CATALOGUES)('$name is stored in whole millimetres', ({ sizes }) => {
    // Sizes are compared, summed and serialised all over the product; a value
    // carrying a fraction of a millimetre of conversion dust makes two plans
    // built the same way differ in the tenth decimal, and the "Not a stock
    // size" hint is decided half a millimetre either side of these numbers.
    for (const size of sizes) {
      expect([size.imperial, size.metres * 1000]).toEqual([
        size.imperial,
        Math.round(size.metres * 1000),
      ])
    }
  })

  it('offers doors and windows only in even inches', () => {
    // Leaves and sashes are made in even inches; a 2'7" door or a 4'3" window
    // is a custom order, and offering one as stock prices the plan wrong.
    for (const sizes of [DOOR_WIDTHS, DOOR_HEIGHTS, WINDOW_WIDTHS, WINDOW_HEIGHTS, WINDOW_SILLS]) {
      for (const size of sizes) {
        const nominal = labelInches(size.imperial)
        expect([size.imperial, nominal % 2]).toEqual([size.imperial, 0])
      }
    }
  })

  it('reserves the half-inch sizes for walls, where a stud makes them', () => {
    // 3½" of stud plus ½" of board each side is 4½", and the same sum on a 2x6
    // is 6½". These are the only sizes in the product that are not whole
    // inches, and they are not roundable: 4" of wall does not exist.
    expect(WALL_THICKNESSES.map((size) => labelInches(size.imperial))).toEqual([4.5, 6.5, 8, 12])
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
  it.each(CATALOGUES)('$name still measures its own nominal in inches', ({ sizes }) => {
    for (const size of sizes) {
      const nominal = labelInches(size.imperial)
      // Back through the inch and onto the nearest half — what a schedule or a
      // dimension string has to come out as. Anything that lands on a different
      // size has re-dimensioned the opening.
      expect([size.imperial, Math.round((size.metres / INCH) * 2) / 2]).toEqual([
        size.imperial,
        nominal,
      ])
      expect(size.metres).toBeCloseTo(nominal * INCH, 3)
    }
  })

  it('recognises a size the user typed rather than picked', () => {
    // The inspector accepts a typed length and then asks `isStandard` whether
    // to flag it. Typing the very size the picker offers must not come back
    // "Not a stock size" — but the two paths never produce the same float: the
    // catalogue rounds to the millimetre and `parseLength` does not.
    for (const size of allSizes()) {
      const typed = parseLength(size.imperial.replace(/ pair$/, '').replace('½', '.5'), 'metric')
      expect([size.imperial, typed === null]).toEqual([size.imperial, false])
      const catalogue = CATALOGUES.find((entry) => entry.sizes.includes(size))
      expect([size.imperial, isStandard(catalogue?.sizes ?? [], typed ?? 0)]).toEqual([
        size.imperial,
        true,
      ])
    }
  })

  it('leaves only a tenth of a millimetre of slack in that recognition', () => {
    // Rounding a whole-inch size to the millimetre costs at most 0.4 mm, and
    // `isStandard` forgives 0.5 mm. That 0.1 mm is the whole margin: convert
    // these to the centimetre instead and every typed size turns non-standard.
    const worst = Math.max(
      ...allSizes().map((size) => Math.abs(size.metres - labelInches(size.imperial) * INCH)),
    )
    expect(worst).toBeCloseTo(0.0004, 6)
    expect(worst).toBeLessThan(0.0005)
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
    expect(value).toBe(Math.round(labelInches(imperial) * 25.4) / 1000)
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

  it('leave the 2\'8" leaf sitting on the number it would have to beat', () => {
    // A 2'8" leaf is 32" *nominal* — the clear-width minimum measured before
    // the stop and the open leaf take their share, so it cannot deliver 32" of
    // clear. This is the arithmetic that makes 3'0" the entry door, and why the
    // narrower sizes are labelled closet, bathroom and interior rather than
    // offered as a way to save a foot on an exit.
    const interior = DOOR_WIDTHS.find((size) => size.imperial === `2'8"`)
    expect(interior?.metres).toBe(CODE_MINIMUMS.egressDoorClearWidth)
    expect(interior?.note).toBe('Interior standard')
  })

  it('offers no leaf wider than IBC 1010.1.1 allows', () => {
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
  })

  it('is itself an orderable size, and the smallest pair anybody hangs', () => {
    // The threshold is a size, not a number between two sizes, so the first
    // pair in the picker lands on it and is drawn as a pair rather than one
    // leaf short of the test above. Two 2'6" leaves is that pair.
    expect(DOUBLE_DOOR_FROM).toBe(1.524)
    expect(isStandard(DOOR_WIDTHS, DOUBLE_DOOR_FROM)).toBe(true)
    expect(DOUBLE_DOOR_FROM / 2).toBeCloseTo(30 * INCH, 3)
  })

  it('leaves a band of widths that are drawn as one leaf and made as two', () => {
    // Anything dragged between the 48" leaf cap and the threshold commits as a
    // single leaf: 4'6" is drawn as one door, and one door that wide is neither
    // made nor allowed on an exit. The catalogue never offers a size in there —
    // its widest single is 3'6" — so this is reachable only by a free drag, and
    // it is why the stock list stops where it does.
    const widestSingle = DOOR_WIDTHS.filter((size) => !isPair(size)).at(-1)
    expect(widestSingle?.imperial).toBe(`3'6"`)
    expect(widestSingle?.metres).toBeLessThan(CODE_MINIMUMS.egressLeafMaxWidth)
    expect(DOUBLE_DOOR_FROM).toBeGreaterThan(CODE_MINIMUMS.egressLeafMaxWidth)
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
    expect(CODE_MINIMUMS.egressDoorClearWidth / INCH).toBeCloseTo(32, 1)
    expect(CODE_MINIMUMS.egressDoorHeight).toBe(2.032)
    expect(CODE_MINIMUMS.egressDoorHeight / INCH).toBe(80)
    expect(CODE_MINIMUMS.egressLeafMaxWidth).toBe(1.219)
    expect(CODE_MINIMUMS.egressLeafMaxWidth / INCH).toBeCloseTo(48, 1)
  })

  it('quotes IBC 1020.2 corridors at 44 inches over fifty people and 36 under', () => {
    // 44 x 25.4 = 1117.6 mm, 36 x 25.4 = 914.4. The occupant load of 50 is the
    // step between them, and the wider figure has to be the wider number: a
    // swap would report the busiest corridors in a venue as compliant.
    expect(CODE_MINIMUMS.corridorWidthOver50).toBe(1.118)
    expect(CODE_MINIMUMS.corridorWidthOver50 / INCH).toBeCloseTo(44, 1)
    expect(CODE_MINIMUMS.corridorWidthUnder50).toBe(0.914)
    expect(CODE_MINIMUMS.corridorWidthUnder50 / INCH).toBeCloseTo(36, 1)
    expect(CODE_MINIMUMS.corridorWidthOver50).toBeGreaterThan(CODE_MINIMUMS.corridorWidthUnder50)
  })

  it('quotes IBC 1003.2 headroom at 7\'6", above any door it could be measured over', () => {
    // 90 x 25.4 = 2286 mm, and it is a ceiling over a route, not a door head:
    // it must clear the 80" head, and the shortest stock wall must clear it in
    // turn or every residential plan reads as non-compliant on placement.
    expect(CODE_MINIMUMS.egressCeilingHeight).toBe(2.286)
    expect(CODE_MINIMUMS.egressCeilingHeight / INCH).toBe(90)
    expect(CODE_MINIMUMS.egressCeilingHeight).toBeGreaterThan(CODE_MINIMUMS.egressDoorHeight)
    expect(WALL_HEIGHTS[0].metres).toBeGreaterThan(CODE_MINIMUMS.egressCeilingHeight)
  })

  it('is a set of clear dimensions, never a nominal one', () => {
    // Every figure here is measured through the opening, which is why none of
    // them may be handed to the width box as a size to order: `isStandard`
    // deliberately disagrees with 32" and 44" as door widths even though both
    // are whole even inches.
    expect(isStandard(DOOR_WIDTHS, CODE_MINIMUMS.egressLeafMaxWidth)).toBe(false)
    expect(isStandard(DOOR_HEIGHTS, CODE_MINIMUMS.egressCeilingHeight)).toBe(false)
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
    expect(nearestStandard(DOOR_WIDTHS, DEFAULT_DOOR_WIDTH)).toBe(DOOR_WIDTHS[4])
    expect(nearestStandard(WALL_HEIGHTS, DEFAULT_WALL_HEIGHT)).toBe(WALL_HEIGHTS[1])
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
    // NaN or Infinity compares false, so the scan falls through the whole
    // catalogue rather than snapping to an end. The inspector renders that as a
    // blank picker, which beats silently claiming the width is 2'0".
    expect(nearestStandard(DOOR_WIDTHS, Number.NaN)).toBeNull()
    expect(nearestStandard(DOOR_WIDTHS, Infinity)).toBeNull()
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
    // a whole millimetre is a different size and has to read as one.
    expect(isStandard(DOOR_WIDTHS, DEFAULT_DOOR_WIDTH + 0.0004)).toBe(true)
    expect(isStandard(DOOR_WIDTHS, DEFAULT_DOOR_WIDTH + 0.001)).toBe(false)
    expect(isStandard(DOOR_WIDTHS, DEFAULT_DOOR_WIDTH - 0.001)).toBe(false)
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

  // SUSPECTED BUG: the 6'8" window is catalogued "Storefront, head level with
  // the doors", but a window's head is its sill plus its height. Paired with
  // the 1'0" sill the same table calls "Storefront", the head lands at 7'8" —
  // a foot above the 6'8" doors beside it, which is the one thing a storefront
  // elevation must not do. The note holds only for a window sitting on the
  // floor. Either the storefront glass should be catalogued at 5'8" (1'0" sill
  // + 5'8" = a 6'8" head) or the note should stop promising alignment; as it
  // stands the picker tells the user the heads will line up and they do not.
  // The metric values themselves are right — 6'8" is 2.032 m either way.
  it('sets a storefront window head a foot above the doors it says it matches', () => {
    const storefrontSill = WINDOW_SILLS[0]
    const storefrontGlass = WINDOW_HEIGHTS.at(-1)
    expect(storefrontSill.note).toBe('Storefront')
    expect(storefrontGlass?.note).toBe('Storefront, head level with the doors')
    expect(storefrontSill.metres + (storefrontGlass?.metres ?? 0)).toBeCloseTo(2.337, 9)
    expect(DEFAULT_DOOR_HEIGHT).toBeCloseTo(2.032, 9)
    // It does at least fit a commercial wall, so the combination is placeable.
    expect(storefrontSill.metres + (storefrontGlass?.metres ?? 0)).toBeLessThan(DEFAULT_WALL_HEIGHT)
  })

  it('caps the sill picker at the 44 inch escape maximum', () => {
    // IRC R310.2.2 will not let a bedroom's escape window sit higher, so the
    // list must not offer one that does: a sill picked from stock is a sill
    // somebody can climb out of.
    const highest = WINDOW_SILLS.at(-1)
    expect(highest?.metres).toBe(1.118)
    expect(highest?.metres).toBeCloseTo(44 * INCH, 3)
  })
})

describe('the imperial readout', () => {
  // SUSPECTED BUG: a size that is a whole number of feet is displayed one foot
  // short plus twelve inches. `formatLength` floors the feet from a value the
  // millimetre rounding left 0.4 mm shy of the nominal (0.914 m is 35.984"),
  // then rounds the remainder to 12.0 instead of carrying it. The product's own
  // default door is named `3'0"` in the picker and reads `2' 12.0"` in the
  // inspector header next to it; the default wall reads `8' 12.0"` and the
  // default window `3' 12.0"`. It should read 3' 0", 9' 0" and 4' 0" — either
  // by carrying the rounded inches into the feet, or by rounding the total
  // inches before splitting them. Nothing dimensional is wrong in the document;
  // what it costs is every imperial length the user reads.
  it('names a whole number of feet as one foot short plus twelve inches', () => {
    expect(formatLength(DEFAULT_DOOR_WIDTH, 'imperial')).toBe(`2' 12.0"`)
    expect(formatLength(DEFAULT_WALL_HEIGHT, 'imperial')).toBe(`8' 12.0"`)
    expect(formatLength(DEFAULT_WINDOW_WIDTH, 'imperial')).toBe(`3' 12.0"`)
  })

  it('reads the sizes that round the other way correctly', () => {
    // 2'8" is 812.8 mm rounded up to 813, so the same arithmetic lands just
    // above the nominal and reads right. That is what makes the fault above a
    // display bug rather than a wrong number in the catalogue.
    expect(formatLength(DOOR_WIDTHS[3].metres, 'imperial')).toBe(`2' 8.0"`)
    expect(formatLength(DEFAULT_DOOR_HEIGHT, 'imperial')).toBe(`6' 8.0"`)
  })
})
