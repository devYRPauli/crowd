/**
 * Real building dimensions, in metres, from US construction practice.
 *
 * Everything the editor offers by default is a size you could actually order.
 * A 1.0 m door is not a door anybody makes: US leaves come in even inches, and
 * the difference between 1.0 m and a 3'0" leaf is 3½ inches of clear width,
 * which at a doorway is the difference between two people abreast and one. A
 * plan drawn from round metric numbers looks right and prices wrong, and every
 * egress figure computed from it inherits the error.
 *
 * The document stays metric — see `units.ts`; the imperial setting only changes
 * display and parsing — so these are the metric values of the nominal imperial
 * sizes, carried to the millimetre. The `imperial` label on each is what the
 * size is *called*, which is what a user is looking for when they pick one.
 *
 * Code minimums are IBC 2021 and ADA 2010 as cited per entry. They are model
 * codes: local adoption and amendments vary and approval rests with the
 * authority having jurisdiction, which is why they inform the defaults here and
 * are enforced nowhere.
 */

const inches = (value: number): number => Math.round(value * 25.4) / 1000
const feet = (value: number, extraInches = 0): number => inches(value * 12 + extraInches)

export interface StandardSize {
  /** Metres — what the document stores. */
  readonly metres: number
  /** What the size is called, in the imperial nominal a supplier uses. */
  readonly imperial: string
  /** Why you would pick this one. */
  readonly note?: string
}

/**
 * Door leaf widths. A pair is quoted by its total, as it is on a schedule.
 *
 * IBC 1010.1.1 wants 32" of *clear* width for an egress door, which a 3'0" leaf
 * gives and a 2'8" leaf gives only just, once the stop and the open leaf are
 * taken off. ADA 404.2.3 wants the same 32". 3'0" is therefore the entry door
 * in almost every US building, and the default here.
 */
export const DOOR_WIDTHS: readonly StandardSize[] = [
  { metres: feet(2), imperial: `2'0"`, note: 'Closet' },
  { metres: feet(2, 4), imperial: `2'4"` },
  { metres: feet(2, 6), imperial: `2'6"`, note: 'Bathroom' },
  { metres: feet(2, 8), imperial: `2'8"`, note: 'Interior standard' },
  { metres: feet(3), imperial: `3'0"`, note: 'Entry and accessible standard' },
  { metres: feet(3, 6), imperial: `3'6"`, note: 'Wide single' },
  { metres: feet(5), imperial: `5'0" pair`, note: 'Pair of 2\'6"' },
  { metres: feet(6), imperial: `6'0" pair`, note: 'Pair of 3\'0", commercial entry' },
  { metres: feet(8), imperial: `8'0" pair`, note: 'Pair of 4\'0"' },
] as const

/** Head heights. 6'8" is the standard everywhere; commercial goes taller. */
export const DOOR_HEIGHTS: readonly StandardSize[] = [
  { metres: feet(6, 8), imperial: `6'8"`, note: 'Standard' },
  { metres: feet(7), imperial: `7'0"`, note: 'Commercial' },
  { metres: feet(8), imperial: `8'0"`, note: 'Tall commercial' },
] as const

/** Window widths, as ordered. */
export const WINDOW_WIDTHS: readonly StandardSize[] = [
  { metres: feet(2), imperial: `2'0"` },
  { metres: feet(3), imperial: `3'0"` },
  { metres: feet(4), imperial: `4'0"` },
  { metres: feet(5), imperial: `5'0"` },
  { metres: feet(6), imperial: `6'0"` },
  { metres: feet(8), imperial: `8'0"`, note: 'Storefront bay' },
] as const

export const WINDOW_HEIGHTS: readonly StandardSize[] = [
  { metres: feet(3), imperial: `3'0"` },
  { metres: feet(4), imperial: `4'0"`, note: 'Standard' },
  { metres: feet(5), imperial: `5'0"` },
  { metres: feet(6, 8), imperial: `6'8"`, note: 'Storefront, head level with the doors' },
] as const

/**
 * Sill heights. 3'0" is the usual residential sill; a storefront starts near
 * the floor. IRC R310.2.2 caps an emergency-escape sill at 44", which is why
 * bedroom windows sit low.
 */
export const WINDOW_SILLS: readonly StandardSize[] = [
  { metres: feet(1), imperial: `1'0"`, note: 'Storefront' },
  { metres: feet(2, 6), imperial: `2'6"` },
  { metres: feet(3), imperial: `3'0"`, note: 'Standard' },
  { metres: feet(3, 8), imperial: `3'8"`, note: 'Egress maximum is 44"' },
] as const

/**
 * Wall thicknesses, finished.
 *
 * A 2x4 partition is 3½" of stud and ½" of board each side. A 2x6 exterior wall
 * is 5½" plus sheathing and finish. 8" CMU is what a commercial demising wall
 * usually is.
 */
export const WALL_THICKNESSES: readonly StandardSize[] = [
  { metres: inches(4.5), imperial: `4½"`, note: '2x4 partition' },
  { metres: inches(6.5), imperial: `6½"`, note: '2x6 partition' },
  { metres: inches(8), imperial: `8"`, note: '8" CMU or 2x6 exterior' },
  { metres: inches(12), imperial: `12"`, note: 'Heavy exterior' },
] as const

/** Floor-to-ceiling heights. */
export const WALL_HEIGHTS: readonly StandardSize[] = [
  { metres: feet(8), imperial: `8'0"`, note: 'Residential' },
  { metres: feet(9), imperial: `9'0"`, note: 'Commercial' },
  { metres: feet(10), imperial: `10'0"`, note: 'Commercial, generous' },
  { metres: feet(12), imperial: `12'0"`, note: 'Assembly' },
  { metres: feet(16), imperial: `16'0"`, note: 'Concourse' },
] as const

/**
 * At and above this, an opening is drawn as a pair of leaves rather than one.
 *
 * The smallest pair anybody hangs is two 2'6" leaves, and a single leaf wider
 * than 4'0" is not made — IBC 1010.1.1 caps an egress leaf there — so anything
 * from 5'0" up is a pair in practice.
 */
export const DOUBLE_DOOR_FROM = feet(5)

/**
 * Wall that has to survive either side of an opening, in metres.
 *
 * A door is cut into a wall, not instead of one: something has to carry the
 * head, and a leaf needs a jamb to hang from. Two inches is the least that
 * reads as construction rather than as a mistake, and it stops the width box
 * accepting the whole wall — which deletes the wall from the plan without
 * deleting it from the document.
 */
export const OPENING_JAMB = inches(2)

/** What the editor reaches for when nothing says otherwise. */
export const DEFAULT_DOOR_WIDTH = feet(3)
export const DEFAULT_DOOR_HEIGHT = feet(6, 8)
export const DEFAULT_DOUBLE_DOOR_WIDTH = feet(6)
export const DEFAULT_WINDOW_WIDTH = feet(4)
export const DEFAULT_WINDOW_HEIGHT = feet(4)
export const DEFAULT_WINDOW_SILL = feet(3)
export const DEFAULT_WALL_THICKNESS = inches(6.5)
export const DEFAULT_WALL_HEIGHT = feet(9)

/**
 * Model-code minimums, for the checks that report against them.
 *
 * Indicative only, and the UI says so every time one is quoted.
 */
export const CODE_MINIMUMS = {
  /** IBC 1010.1.1 — clear width of an egress door. */
  egressDoorClearWidth: inches(32),
  /** IBC 1010.1.1 — clear height of an egress door. */
  egressDoorHeight: inches(80),
  /** IBC 1010.1.1 — a single leaf may not exceed this. */
  egressLeafMaxWidth: inches(48),
  /** IBC 1020.2 — corridor serving an occupant load of 50 or more. */
  corridorWidthOver50: inches(44),
  /** IBC 1020.2 — corridor serving fewer than 50. */
  corridorWidthUnder50: inches(36),
  /** IBC 1003.2 — ceiling over a means of egress. */
  egressCeilingHeight: inches(90),
} as const

/** The catalogued size closest to a measurement, for snapping a drag. */
export const nearestStandard = (
  sizes: readonly StandardSize[],
  metres: number,
): StandardSize | null => {
  let best: StandardSize | null = null
  let bestGap = Infinity
  for (const size of sizes) {
    const gap = Math.abs(size.metres - metres)
    if (gap < bestGap) {
      bestGap = gap
      best = size
    }
  }
  return best
}

/** True when a measurement is one of the catalogued sizes, to the millimetre. */
export const isStandard = (sizes: readonly StandardSize[], metres: number): boolean =>
  sizes.some((size) => Math.abs(size.metres - metres) < 0.0005)
