/**
 * The furniture catalog.
 *
 * Each entry is data: a default size, a collision footprint, the seats or
 * standing spaces it offers the simulation, and a builder that emits drawing
 * primitives at any size. Adding an item to the product means adding one entry
 * here — no renderer, editor or engine change is needed.
 *
 * Default sizes follow event-industry conventions (banquet rounds, 6 ft
 * trestles, 750 mm desk height, 1100 mm bar height) so that a plan drawn with
 * defaults is realistic without the user tuning anything.
 */

import type { MaterialRole, Prim } from './primitives'
import { box, cone, cyl, legs, pedestal, sphere, torus, translated } from './primitives'

export type CatalogCategory = 'tables' | 'seating' | 'service' | 'structure' | 'equipment' | 'decor'

export interface Size {
  width: number
  depth: number
  height: number
}

/** A place a person can occupy, in item-local coordinates. */
export interface SeatSlot {
  x: number
  z: number
  /** Direction the occupant faces, in local radians (0 = +X). */
  facing: number
  kind: 'seat' | 'stand' | 'lean'
}

export interface CatalogItem {
  id: string
  name: string
  category: CatalogCategory
  size: Size
  /** Whether people must walk around this item. */
  blocking: boolean
  footprint: 'rect' | 'circle'
  /**
   * Extra metres trimmed from the blocking footprint. Chairs tuck under tables
   * and people brush past sofas, so their physical footprint is slightly
   * smaller than their visual one.
   */
  inset: number
  resize: 'none' | 'uniform' | 'free'
  keywords: string[]
  /** Which material the per-instance colour override tints. */
  tintRole?: MaterialRole
  build: (size: Size) => Prim[]
  seats?: (size: Size) => SeatSlot[]
}

const TAU = Math.PI * 2

// --- shared sub-assemblies ---------------------------------------------------

const chairShell = (
  w: number,
  d: number,
  h: number,
  seatH: number,
  frame: MaterialRole,
): Prim[] => [
  box(0, seatH, 0, w, 0.06, d, 'fabric'),
  box(0, seatH + (h - seatH) / 2, -d / 2 + 0.05, w * 0.92, h - seatH, 0.07, 'fabric'),
  ...legs(w, d, seatH - 0.03, frame, 0.045, 0.03),
]

const tableTop = (w: number, d: number, h: number, role: MaterialRole = 'wood'): Prim =>
  box(0, h - 0.02, 0, w, 0.04, d, role)

const roundTop = (r: number, h: number, role: MaterialRole = 'wood'): Prim =>
  cyl(0, h - 0.02, 0, r, 0.04, role, 28)

/** Seats spaced evenly around a circular table. */
const roundSeats = (radius: number, count: number): SeatSlot[] =>
  Array.from({ length: count }, (_, i) => {
    const a = (i / count) * TAU
    return {
      x: Math.cos(a) * radius,
      z: Math.sin(a) * radius,
      facing: a + Math.PI,
      kind: 'seat' as const,
    }
  })

/** Seats along both long sides of a rectangular table. */
const benchSeats = (width: number, depth: number, perSide: number): SeatSlot[] => {
  const out: SeatSlot[] = []
  const z = depth / 2 + 0.38
  for (let i = 0; i < perSide; i++) {
    const x = (-width / 2) * 0.82 + ((i + 0.5) / perSide) * width * 0.82 * 2
    out.push({ x, z, facing: -Math.PI / 2, kind: 'seat' })
    out.push({ x, z: -z, facing: Math.PI / 2, kind: 'seat' })
  }
  return out
}

// --- tables ------------------------------------------------------------------

const TABLES: CatalogItem[] = [
  {
    id: 'table-round-4',
    name: 'Round table (4)',
    category: 'tables',
    size: { width: 1.0, depth: 1.0, height: 0.75 },
    blocking: true,
    footprint: 'circle',
    inset: 0,
    resize: 'uniform',
    keywords: ['banquet', 'dining', 'cafe', 'round'],
    tintRole: 'wood',
    build: ({ width, height }) => [
      roundTop(width / 2, height),
      ...pedestal(height - 0.04, width / 2, 'metalDark', 'metalDark'),
    ],
    seats: ({ width }) => roundSeats(width / 2 + 0.42, 4),
  },
  {
    id: 'table-round-6',
    name: 'Round table (6)',
    category: 'tables',
    // A true 5 ft round. The trade sets these for eight; six is the
    // comfortable setting and what this one is named for.
    size: { width: 1.524, depth: 1.524, height: 0.75 },
    blocking: true,
    footprint: 'circle',
    inset: 0,
    resize: 'uniform',
    keywords: ['banquet', 'dining', 'round', '5ft'],
    tintRole: 'wood',
    build: ({ width, height }) => [
      roundTop(width / 2, height),
      ...pedestal(height - 0.04, width / 2, 'metalDark', 'metalDark'),
    ],
    seats: ({ width }) => roundSeats(width / 2 + 0.42, 6),
  },
  {
    id: 'table-round-8',
    name: 'Banquet round (8)',
    category: 'tables',
    // A true 6 ft round — the sibling `table-rect-6ft` spells the same size
    // 1.83, and two items claiming one imperial dimension should not round it
    // differently. The trade sets these for ten; eight is the comfortable
    // setting and what this one is named for.
    size: { width: 1.829, depth: 1.829, height: 0.75 },
    blocking: true,
    footprint: 'circle',
    inset: 0,
    resize: 'uniform',
    keywords: ['banquet', 'wedding', 'dining', '6ft', 'round'],
    tintRole: 'paper',
    build: ({ width, height }) => [
      roundTop(width / 2, height, 'paper'),
      cyl(0, (height - 0.04) / 2, 0, width / 2 - 0.02, height - 0.04, 'paper', 28),
    ],
    seats: ({ width }) => roundSeats(width / 2 + 0.42, 8),
  },
  {
    id: 'table-rect-6ft',
    name: 'Trestle table (6 ft)',
    category: 'tables',
    size: { width: 1.83, depth: 0.76, height: 0.75 },
    blocking: true,
    footprint: 'rect',
    inset: 0,
    resize: 'free',
    keywords: ['trestle', 'banquet', 'registration', 'rectangular'],
    tintRole: 'wood',
    build: ({ width, depth, height }) => [
      tableTop(width, depth, height),
      ...legs(width, depth, height - 0.04, 'metal', 0.05, 0.1),
    ],
    seats: ({ width, depth }) => benchSeats(width, depth, Math.max(1, Math.round(width / 0.7))),
  },
  {
    id: 'table-square-4',
    name: 'Square table (4)',
    category: 'tables',
    // 3 ft square. A 0.8 m square is a two-top in any real cafe: it gives each
    // of four diners 0.8 m of edge but only about 0.4 m of frontage once the
    // corners are taken off.
    size: { width: 0.914, depth: 0.914, height: 0.75 },
    blocking: true,
    footprint: 'rect',
    inset: 0,
    resize: 'uniform',
    keywords: ['cafe', 'bistro', 'dining'],
    tintRole: 'wood',
    build: ({ width, depth, height }) => [
      tableTop(width, depth, height),
      ...pedestal(height - 0.04, Math.min(width, depth) / 2, 'metalDark'),
    ],
    seats: ({ width, depth }) => [
      { x: width / 2 + 0.4, z: 0, facing: Math.PI, kind: 'seat' },
      { x: -width / 2 - 0.4, z: 0, facing: 0, kind: 'seat' },
      { x: 0, z: depth / 2 + 0.4, facing: -Math.PI / 2, kind: 'seat' },
      { x: 0, z: -depth / 2 - 0.4, facing: Math.PI / 2, kind: 'seat' },
    ],
  },
  {
    id: 'table-poseur',
    name: 'Poseur table',
    category: 'tables',
    size: { width: 0.6, depth: 0.6, height: 1.1 },
    blocking: true,
    footprint: 'circle',
    inset: 0,
    resize: 'uniform',
    keywords: ['cocktail', 'standing', 'high', 'bar table', 'reception'],
    tintRole: 'wood',
    build: ({ width, height }) => [
      roundTop(width / 2, height),
      ...pedestal(height - 0.04, width / 2, 'chrome'),
    ],
    seats: ({ width }) =>
      roundSeats(width / 2 + 0.34, 4).map((s) => ({ ...s, kind: 'lean' as const })),
  },
  {
    id: 'table-conference',
    name: 'Conference table',
    category: 'tables',
    size: { width: 3.0, depth: 1.2, height: 0.75 },
    blocking: true,
    footprint: 'rect',
    inset: 0,
    resize: 'free',
    keywords: ['boardroom', 'meeting', 'office'],
    tintRole: 'woodDark',
    build: ({ width, depth, height }) => [
      box(0, height - 0.03, 0, width, 0.06, depth, 'woodDark'),
      box(-width / 4, (height - 0.06) / 2, 0, 0.12, height - 0.06, depth * 0.6, 'metalDark'),
      box(width / 4, (height - 0.06) / 2, 0, 0.12, height - 0.06, depth * 0.6, 'metalDark'),
    ],
    seats: ({ width, depth }) => benchSeats(width, depth, Math.max(2, Math.round(width / 0.75))),
  },
  {
    id: 'desk',
    name: 'Desk',
    category: 'tables',
    size: { width: 1.4, depth: 0.7, height: 0.75 },
    blocking: true,
    footprint: 'rect',
    inset: 0,
    resize: 'free',
    keywords: ['office', 'workstation', 'work'],
    tintRole: 'woodLight',
    build: ({ width, depth, height }) => [
      box(0, height - 0.02, 0, width, 0.04, depth, 'woodLight'),
      box(-width / 2 + 0.03, (height - 0.04) / 2, 0, 0.05, height - 0.04, depth * 0.9, 'metal'),
      box(width / 2 - 0.03, (height - 0.04) / 2, 0, 0.05, height - 0.04, depth * 0.9, 'metal'),
      box(width / 2 - 0.28, (height - 0.1) / 2, 0.02, 0.44, height - 0.14, depth * 0.8, 'metal'),
    ],
    seats: ({ depth }) => [{ x: 0, z: depth / 2 + 0.42, facing: -Math.PI / 2, kind: 'seat' }],
  },
  {
    id: 'table-coffee',
    name: 'Coffee table',
    category: 'tables',
    size: { width: 1.1, depth: 0.6, height: 0.42 },
    blocking: true,
    footprint: 'rect',
    inset: 0.05,
    resize: 'free',
    keywords: ['lounge', 'low', 'living'],
    tintRole: 'wood',
    build: ({ width, depth, height }) => [
      tableTop(width, depth, height),
      box(0, height / 2 - 0.08, 0, width * 0.8, 0.03, depth * 0.7, 'wood'),
      ...legs(width, depth, height - 0.04, 'woodDark', 0.05, 0.05),
    ],
  },
]

// --- seating -----------------------------------------------------------------

const SEATING: CatalogItem[] = [
  {
    id: 'chair',
    name: 'Chair',
    category: 'seating',
    size: { width: 0.46, depth: 0.5, height: 0.86 },
    // A loose chair is furniture you pull out, not a wall. Eight chairs around
    // a banquet round would otherwise seal the table off entirely once the
    // navigation grid adds body clearance, and nobody could take their seat.
    // The table itself stays solid, which is what actually shapes circulation.
    blocking: false,
    footprint: 'rect',
    inset: 0.1,
    resize: 'none',
    keywords: ['seat', 'dining', 'side chair'],
    tintRole: 'fabric',
    build: ({ width, depth, height }) => chairShell(width, depth, height, 0.45, 'woodDark'),
    seats: () => [{ x: 0, z: 0, facing: Math.PI / 2, kind: 'seat' }],
  },
  {
    id: 'chair-stacking',
    name: 'Stacking chair',
    category: 'seating',
    size: { width: 0.45, depth: 0.48, height: 0.8 },
    blocking: false,
    footprint: 'rect',
    inset: 0.1,
    resize: 'none',
    keywords: ['event', 'conference', 'banquet', 'seat'],
    tintRole: 'fabricAlt',
    build: ({ width, depth, height }) => [
      box(0, 0.44, 0, width, 0.05, depth, 'fabricAlt'),
      box(
        0,
        0.44 + (height - 0.44) / 2,
        -depth / 2 + 0.04,
        width * 0.9,
        height - 0.46,
        0.05,
        'fabricAlt',
      ),
      ...legs(width, depth, 0.42, 'chrome', 0.03, 0.02),
    ],
    seats: () => [{ x: 0, z: 0, facing: Math.PI / 2, kind: 'seat' }],
  },
  {
    id: 'armchair',
    name: 'Armchair',
    category: 'seating',
    size: { width: 0.85, depth: 0.85, height: 0.78 },
    blocking: true,
    footprint: 'rect',
    inset: 0.05,
    resize: 'none',
    keywords: ['lounge', 'soft', 'seat'],
    tintRole: 'fabric',
    build: ({ width, depth, height }) => [
      box(0, 0.2, 0, width, 0.4, depth, 'fabric'),
      box(0, 0.45, 0, width - 0.24, 0.12, depth - 0.2, 'fabric'),
      box(0, height / 2 + 0.16, -depth / 2 + 0.1, width, height - 0.32, 0.2, 'fabric'),
      box(-width / 2 + 0.1, 0.46, 0.04, 0.18, 0.18, depth - 0.24, 'fabric'),
      box(width / 2 - 0.1, 0.46, 0.04, 0.18, 0.18, depth - 0.24, 'fabric'),
      ...legs(width, depth, 0.1, 'woodDark', 0.05, 0.1),
    ],
    seats: () => [{ x: 0, z: 0.05, facing: Math.PI / 2, kind: 'seat' }],
  },
  {
    id: 'sofa-2',
    name: 'Sofa (2 seat)',
    category: 'seating',
    size: { width: 1.6, depth: 0.88, height: 0.8 },
    blocking: true,
    footprint: 'rect',
    inset: 0.05,
    resize: 'free',
    keywords: ['lounge', 'couch', 'soft'],
    tintRole: 'fabric',
    build: ({ width, depth, height }) => [
      box(0, 0.2, 0, width, 0.4, depth, 'fabric'),
      box(0, 0.46, 0.02, width - 0.34, 0.12, depth - 0.24, 'fabric'),
      box(0, height / 2 + 0.16, -depth / 2 + 0.11, width, height - 0.32, 0.22, 'fabric'),
      box(-width / 2 + 0.09, 0.48, 0.04, 0.18, 0.22, depth - 0.22, 'fabric'),
      box(width / 2 - 0.09, 0.48, 0.04, 0.18, 0.22, depth - 0.22, 'fabric'),
      ...legs(width, depth, 0.1, 'woodDark', 0.05, 0.12),
    ],
    seats: ({ width }) => {
      const count = Math.max(1, Math.round(width / 0.78))
      return Array.from({ length: count }, (_, i) => ({
        x: -width / 2 + ((i + 0.5) / count) * width,
        z: 0.06,
        facing: Math.PI / 2,
        kind: 'seat' as const,
      }))
    },
  },
  {
    id: 'bench',
    name: 'Bench',
    category: 'seating',
    size: { width: 1.5, depth: 0.45, height: 0.45 },
    blocking: true,
    footprint: 'rect',
    inset: 0.05,
    resize: 'free',
    keywords: ['waiting', 'transit', 'public', 'seat'],
    tintRole: 'wood',
    build: ({ width, depth, height }) => [
      box(0, height - 0.03, 0, width, 0.06, depth, 'wood'),
      box(
        -width / 2 + 0.12,
        (height - 0.06) / 2,
        0,
        0.06,
        height - 0.06,
        depth * 0.85,
        'metalDark',
      ),
      box(width / 2 - 0.12, (height - 0.06) / 2, 0, 0.06, height - 0.06, depth * 0.85, 'metalDark'),
    ],
    seats: ({ width }) => {
      const count = Math.max(1, Math.floor(width / 0.55))
      return Array.from({ length: count }, (_, i) => ({
        x: -width / 2 + ((i + 0.5) / count) * width,
        z: 0,
        facing: Math.PI / 2,
        kind: 'seat' as const,
      }))
    },
  },
  {
    id: 'stool-bar',
    name: 'Bar stool',
    category: 'seating',
    size: { width: 0.4, depth: 0.4, height: 0.76 },
    blocking: false,
    footprint: 'circle',
    inset: 0.08,
    resize: 'none',
    keywords: ['bar', 'high', 'seat'],
    tintRole: 'leather',
    build: ({ width, height }) => [
      cyl(0, height - 0.03, 0, width / 2, 0.06, 'leather', 18),
      cyl(0, (height - 0.06) / 2, 0, 0.035, height - 0.06, 'chrome', 12),
      torus(0, 0.2, 0, width / 2 - 0.06, 0.018, 'chrome', 16),
      cyl(0, 0.015, 0, width / 2 - 0.02, 0.03, 'chrome', 18),
    ],
    seats: () => [{ x: 0, z: 0, facing: Math.PI / 2, kind: 'seat' }],
  },
  {
    id: 'seat-row',
    name: 'Seat row (theatre)',
    category: 'seating',
    size: { width: 3.0, depth: 0.7, height: 0.95 },
    // Rows are not obstacles to the people filling them: an audience reaches
    // its seats by moving along the row. Treating a row as solid closes the
    // gap between rows once the navigation grid adds body clearance, and then
    // nobody can sit down at all.
    blocking: false,
    footprint: 'rect',
    inset: 0.04,
    resize: 'free',
    keywords: ['theatre', 'auditorium', 'cinema', 'row', 'seats'],
    tintRole: 'fabricAlt',
    build: ({ width, depth, height }) => {
      const count = Math.max(1, Math.round(width / 0.55))
      const unit = width / count
      const out: Prim[] = []
      for (let i = 0; i < count; i++) {
        const x = -width / 2 + (i + 0.5) * unit
        out.push(box(x, 0.44, 0.04, unit - 0.06, 0.09, depth - 0.18, 'fabricAlt'))
        out.push(box(x, 0.7, -depth / 2 + 0.08, unit - 0.06, height - 0.55, 0.1, 'fabricAlt'))
        out.push(box(x - unit / 2, 0.55, 0.06, 0.05, 0.1, depth - 0.24, 'metalDark'))
      }
      out.push(box(width / 2, 0.55, 0.06, 0.05, 0.1, depth - 0.24, 'metalDark'))
      out.push(box(0, 0.19, 0, width, 0.38, 0.1, 'metalDark'))
      return out
    },
    seats: ({ width }) => {
      const count = Math.max(1, Math.round(width / 0.55))
      return Array.from({ length: count }, (_, i) => ({
        x: -width / 2 + ((i + 0.5) / count) * width,
        z: 0.04,
        facing: Math.PI / 2,
        kind: 'seat' as const,
      }))
    },
  },
  {
    id: 'booth',
    name: 'Booth',
    category: 'seating',
    size: { width: 1.6, depth: 1.9, height: 1.2 },
    // People slide into a booth rather than walking round it.
    blocking: false,
    footprint: 'rect',
    inset: 0.02,
    resize: 'free',
    keywords: ['diner', 'restaurant', 'banquette'],
    tintRole: 'leather',
    build: ({ width, depth, height }) => [
      box(0, 0.22, -depth / 2 + 0.3, width, 0.44, 0.6, 'leather'),
      box(0, height / 2, -depth / 2 + 0.06, width, height, 0.12, 'leather'),
      box(0, 0.22, depth / 2 - 0.3, width, 0.44, 0.6, 'leather'),
      box(0, height / 2, depth / 2 - 0.06, width, height, 0.12, 'leather'),
      box(0, 0.73, 0, width - 0.2, 0.05, depth - 0.75, 'wood'),
      cyl(0, 0.36, 0, 0.05, 0.72, 'metalDark', 10),
    ],
    seats: ({ width, depth }) => {
      const perSide = Math.max(1, Math.round(width / 0.7))
      const out: SeatSlot[] = []
      for (let i = 0; i < perSide; i++) {
        const x = -width / 2 + ((i + 0.5) / perSide) * width
        out.push({ x, z: -depth / 2 + 0.34, facing: Math.PI / 2, kind: 'seat' })
        out.push({ x, z: depth / 2 - 0.34, facing: -Math.PI / 2, kind: 'seat' })
      }
      return out
    },
  },
  {
    id: 'wheelchair-space',
    name: 'Wheelchair space',
    category: 'seating',
    size: { width: 0.9, depth: 1.3, height: 0.02 },
    blocking: false,
    footprint: 'rect',
    inset: 0,
    resize: 'none',
    keywords: ['accessible', 'access', 'bay'],
    tintRole: 'accent',
    build: ({ width, depth }) => [
      box(0, 0.006, 0, width, 0.012, depth, 'accent'),
      box(0, 0.008, 0, width - 0.1, 0.014, depth - 0.1, 'white'),
    ],
    seats: () => [{ x: 0, z: 0, facing: Math.PI / 2, kind: 'seat' }],
  },
]

// --- service -----------------------------------------------------------------

const counterBody = (width: number, depth: number, height: number, top: MaterialRole): Prim[] => [
  box(0, (height - 0.04) / 2, 0, width, height - 0.04, depth, 'woodDark'),
  box(0, height - 0.02, 0, width + 0.06, 0.04, depth + 0.06, top),
]

const SERVICE: CatalogItem[] = [
  {
    id: 'counter-bar',
    name: 'Bar counter',
    category: 'service',
    size: { width: 2.4, depth: 0.7, height: 1.1 },
    blocking: true,
    footprint: 'rect',
    inset: 0,
    resize: 'free',
    keywords: ['bar', 'drinks', 'service', 'counter'],
    tintRole: 'woodDark',
    build: ({ width, depth, height }) => [
      ...counterBody(width, depth, height, 'stone'),
      box(0, height - 0.28, depth / 2 - 0.02, width, 0.5, 0.04, 'wood'),
    ],
    seats: ({ width, depth }) => {
      const count = Math.max(1, Math.round(width / 0.7))
      return Array.from({ length: count }, (_, i) => ({
        x: -width / 2 + ((i + 0.5) / count) * width,
        z: depth / 2 + 0.45,
        facing: -Math.PI / 2,
        kind: 'lean' as const,
      }))
    },
  },
  {
    id: 'counter-reception',
    name: 'Reception desk',
    category: 'service',
    size: { width: 1.8, depth: 0.8, height: 1.05 },
    blocking: true,
    footprint: 'rect',
    inset: 0,
    resize: 'free',
    keywords: ['registration', 'welcome', 'check-in', 'front desk'],
    tintRole: 'woodLight',
    build: ({ width, depth, height }) => [
      box(0, (height - 0.3) / 2, -0.1, width, height - 0.3, depth - 0.2, 'woodLight'),
      box(0, height - 0.02, 0, width + 0.08, 0.04, depth, 'white'),
      box(0, height - 0.16, depth / 2 - 0.04, width, 0.26, 0.06, 'accent'),
    ],
  },
  {
    id: 'counter-buffet',
    name: 'Buffet station',
    category: 'service',
    size: { width: 2.4, depth: 0.8, height: 0.9 },
    blocking: true,
    footprint: 'rect',
    inset: 0,
    resize: 'free',
    keywords: ['food', 'catering', 'servery', 'hot table'],
    tintRole: 'chrome',
    build: ({ width, depth, height }) => [
      box(0, (height - 0.06) / 2, 0, width, height - 0.06, depth, 'chrome'),
      box(0, height - 0.04, 0, width, 0.05, depth, 'metal'),
      box(-width / 4, height + 0.02, 0, width / 2 - 0.1, 0.06, depth - 0.16, 'metalDark'),
      box(width / 4, height + 0.02, 0, width / 2 - 0.1, 0.06, depth - 0.16, 'metalDark'),
      box(0, height + 0.32, -depth / 2 + 0.08, width, 0.03, 0.4, 'glass', 0),
    ],
  },
  {
    id: 'coffee-station',
    name: 'Coffee station',
    category: 'service',
    size: { width: 1.2, depth: 0.7, height: 0.9 },
    blocking: true,
    footprint: 'rect',
    inset: 0,
    resize: 'free',
    keywords: ['coffee', 'barista', 'drinks', 'espresso'],
    tintRole: 'woodDark',
    build: ({ width, depth, height }) => [
      ...counterBody(width, depth, height, 'stone'),
      box(-width / 4, height + 0.2, -0.05, 0.42, 0.4, 0.34, 'chrome'),
      cyl(width / 4, height + 0.16, -0.05, 0.11, 0.32, 'metalDark', 14),
      cyl(width / 4 - 0.26, height + 0.09, 0.08, 0.05, 0.18, 'white', 12),
    ],
  },
  {
    id: 'pos-terminal',
    name: 'Till point',
    category: 'service',
    size: { width: 0.6, depth: 0.5, height: 1.0 },
    blocking: true,
    footprint: 'rect',
    inset: 0,
    resize: 'none',
    keywords: ['checkout', 'cashier', 'pay', 'register'],
    tintRole: 'metal',
    build: ({ width, depth, height }) => [
      box(0, (height - 0.3) / 2, 0, width, height - 0.3, depth, 'metal'),
      box(0, height - 0.16, 0, width, 0.04, depth, 'metalDark'),
      box(0, height - 0.02, -0.04, width * 0.6, 0.26, 0.03, 'screen', 0),
    ],
  },
  {
    id: 'kiosk',
    name: 'Self-service kiosk',
    category: 'service',
    size: { width: 0.7, depth: 0.55, height: 1.5 },
    blocking: true,
    footprint: 'rect',
    inset: 0,
    resize: 'none',
    keywords: ['ticket', 'machine', 'atm', 'self service', 'terminal'],
    tintRole: 'metalDark',
    build: ({ width, depth, height }) => [
      box(0, height / 2, 0, width, height, depth, 'metalDark'),
      box(0, height - 0.32, depth / 2 - 0.01, width - 0.12, 0.42, 0.03, 'screen'),
      box(0, height - 0.66, depth / 2 - 0.02, width - 0.2, 0.1, 0.04, 'metal'),
      box(0, 0.06, 0, width + 0.04, 0.12, depth + 0.04, 'dark'),
    ],
  },
  {
    id: 'security-scanner',
    name: 'Security scanner',
    category: 'service',
    size: { width: 1.1, depth: 0.7, height: 2.2 },
    blocking: true,
    footprint: 'rect',
    inset: 0,
    resize: 'none',
    keywords: ['metal detector', 'screening', 'airport', 'entry'],
    tintRole: 'white',
    build: ({ width, depth, height }) => [
      box(-width / 2 + 0.09, height / 2, 0, 0.18, height, depth, 'white'),
      box(width / 2 - 0.09, height / 2, 0, 0.18, height, depth, 'white'),
      box(0, height - 0.1, 0, width, 0.2, depth, 'white'),
      box(-width / 2 + 0.09, height - 0.5, depth / 2 - 0.02, 0.06, 0.2, 0.03, 'emissive'),
    ],
  },
  {
    id: 'ballot-booth',
    name: 'Polling booth',
    category: 'service',
    size: { width: 0.8, depth: 0.7, height: 1.4 },
    blocking: true,
    footprint: 'rect',
    inset: 0,
    resize: 'none',
    keywords: ['voting', 'election', 'privacy', 'booth'],
    tintRole: 'accent',
    build: ({ width, depth, height }) => [
      box(0, 0.78, 0, width, 0.04, depth, 'white'),
      box(0, height / 2, -depth / 2 + 0.02, width, height, 0.03, 'accent'),
      box(-width / 2 + 0.02, height / 2, 0, 0.03, height, depth, 'accent'),
      box(width / 2 - 0.02, height / 2, 0, 0.03, height, depth, 'accent'),
      ...legs(width, depth, 0.76, 'metal', 0.03, 0.04),
    ],
  },
  {
    id: 'lectern',
    name: 'Lectern',
    category: 'service',
    size: { width: 0.6, depth: 0.5, height: 1.2 },
    blocking: true,
    footprint: 'rect',
    inset: 0,
    resize: 'none',
    keywords: ['podium', 'speaker', 'stage', 'presentation'],
    tintRole: 'woodDark',
    build: ({ width, depth, height }) => [
      box(0, (height - 0.1) / 2, 0, width * 0.7, height - 0.1, depth * 0.6, 'woodDark'),
      box(0, height - 0.04, 0, width, 0.06, depth, 'woodDark', 0),
      cyl(0.12, height + 0.14, 0.1, 0.012, 0.3, 'metalDark', 8),
    ],
  },
]

// --- structure ---------------------------------------------------------------

const STRUCTURE: CatalogItem[] = [
  {
    id: 'column-round',
    name: 'Column (round)',
    category: 'structure',
    size: { width: 0.5, depth: 0.5, height: 3.2 },
    blocking: true,
    footprint: 'circle',
    inset: 0,
    resize: 'uniform',
    keywords: ['pillar', 'structural', 'post'],
    tintRole: 'stone',
    build: ({ width, height }) => [
      cyl(0, height / 2, 0, width / 2, height, 'stone', 20),
      cyl(0, 0.06, 0, width / 2 + 0.05, 0.12, 'stone', 20),
    ],
  },
  {
    id: 'column-square',
    name: 'Column (square)',
    category: 'structure',
    size: { width: 0.6, depth: 0.6, height: 3.2 },
    blocking: true,
    footprint: 'rect',
    inset: 0,
    resize: 'uniform',
    keywords: ['pillar', 'structural', 'post'],
    tintRole: 'stone',
    build: ({ width, depth, height }) => [
      box(0, height / 2, 0, width, height, depth, 'stone'),
      box(0, 0.07, 0, width + 0.1, 0.14, depth + 0.1, 'stone'),
    ],
  },
  {
    id: 'stage',
    name: 'Stage platform',
    category: 'structure',
    // Staging is assembled from 8 x 4 ft decks, so a stage is a multiple of
    // them: this is four decks, 16 ft by 8 ft. 6.0 x 4.0 tiles from nothing.
    size: { width: 4.877, depth: 2.438, height: 0.6 },
    blocking: true,
    footprint: 'rect',
    inset: 0,
    resize: 'free',
    keywords: ['riser', 'platform', 'performance', 'dais'],
    tintRole: 'dark',
    build: ({ width, depth, height }) => [
      box(0, height / 2, 0, width, height, depth, 'dark'),
      box(0, height - 0.02, 0, width + 0.04, 0.05, depth + 0.04, 'woodDark'),
    ],
  },
  {
    id: 'barrier',
    name: 'Crowd barrier',
    category: 'structure',
    size: { width: 2.0, depth: 0.12, height: 1.1 },
    blocking: true,
    footprint: 'rect',
    inset: 0,
    resize: 'free',
    keywords: ['fence', 'pedestrian barrier', 'queue', 'control'],
    tintRole: 'metal',
    build: ({ width, height }) => {
      const out: Prim[] = [
        box(-width / 2 + 0.03, height / 2, 0, 0.05, height, 0.05, 'metal'),
        box(width / 2 - 0.03, height / 2, 0, 0.05, height, 0.05, 'metal'),
        box(0, height - 0.04, 0, width, 0.05, 0.05, 'metal'),
        box(0, 0.08, 0, width, 0.04, 0.05, 'metal'),
      ]
      const bars = Math.max(2, Math.round(width / 0.22))
      for (let i = 1; i < bars; i++) {
        out.push(
          box(-width / 2 + (i / bars) * width, height / 2, 0, 0.025, height - 0.1, 0.025, 'metal'),
        )
      }
      out.push(box(-width / 2 + 0.03, 0.02, 0, 0.36, 0.04, 0.36, 'metalDark'))
      out.push(box(width / 2 - 0.03, 0.02, 0, 0.36, 0.04, 0.36, 'metalDark'))
      return out
    },
  },
  {
    id: 'stanchion',
    name: 'Rope stanchion',
    category: 'structure',
    size: { width: 0.34, depth: 0.34, height: 1.0 },
    blocking: true,
    footprint: 'circle',
    inset: 0.06,
    resize: 'none',
    keywords: ['queue', 'velvet rope', 'post', 'line'],
    tintRole: 'chrome',
    build: ({ width, height }) => [
      cyl(0, 0.03, 0, width / 2, 0.06, 'metalDark', 18),
      cyl(0, height / 2, 0, 0.035, height, 'chrome', 12),
      sphere(0, height + 0.03, 0, 0.055, 'chrome'),
      torus(0, height - 0.12, 0, 0.055, 0.012, 'chrome', 12),
    ],
  },
  {
    id: 'turnstile',
    name: 'Turnstile',
    category: 'structure',
    size: { width: 0.7, depth: 1.2, height: 1.0 },
    blocking: true,
    footprint: 'rect',
    inset: 0,
    resize: 'none',
    keywords: ['gate', 'access', 'transit', 'barrier'],
    tintRole: 'chrome',
    build: ({ width, depth, height }) => [
      box(-width / 2 + 0.11, height / 2, 0, 0.22, height, depth, 'chrome'),
      box(width / 2 - 0.11, height / 2, 0, 0.22, height, depth, 'chrome'),
      box(-width / 2 + 0.11, height + 0.01, 0, 0.24, 0.03, depth, 'glass'),
      box(width / 2 - 0.11, height + 0.01, 0, 0.24, 0.03, depth, 'glass'),
      box(-width / 2 + 0.11, height - 0.28, depth / 2 - 0.05, 0.12, 0.12, 0.04, 'emissive'),
    ],
  },
  {
    id: 'partition',
    name: 'Partition screen',
    category: 'structure',
    size: { width: 1.8, depth: 0.08, height: 1.8 },
    blocking: true,
    footprint: 'rect',
    inset: 0,
    resize: 'free',
    keywords: ['divider', 'panel', 'screen', 'room divider'],
    tintRole: 'fabricAlt',
    build: ({ width, depth, height }) => [
      box(0, height / 2 + 0.05, 0, width, height - 0.05, depth, 'fabricAlt'),
      box(0, 0.03, 0, width * 0.4, 0.06, 0.4, 'metalDark'),
      box(0, height + 0.01, 0, width, 0.03, depth + 0.02, 'metal'),
    ],
  },
  {
    id: 'planter-box',
    name: 'Planter',
    category: 'structure',
    size: { width: 1.2, depth: 0.4, height: 0.8 },
    blocking: true,
    footprint: 'rect',
    inset: 0,
    resize: 'free',
    keywords: ['greenery', 'divider', 'plants', 'trough'],
    tintRole: 'stone',
    build: ({ width, depth, height }) => {
      const out: Prim[] = [
        box(0, height * 0.35, 0, width, height * 0.7, depth, 'stone'),
        box(0, height * 0.72, 0, width - 0.06, 0.06, depth - 0.06, 'plantDark'),
      ]
      const bushes = Math.max(2, Math.round(width / 0.45))
      for (let i = 0; i < bushes; i++) {
        const x = -width / 2 + ((i + 0.5) / bushes) * width
        out.push(
          sphere(
            x,
            height * 0.78 + 0.1,
            0,
            Math.min(depth, width / bushes) * 0.42,
            'plant',
            0.8,
            10,
          ),
        )
      }
      return out
    },
  },
]

// --- equipment and decor -----------------------------------------------------

const EQUIPMENT: CatalogItem[] = [
  {
    id: 'screen-tv',
    name: 'Display screen',
    category: 'equipment',
    size: { width: 1.6, depth: 0.3, height: 1.7 },
    blocking: true,
    footprint: 'rect',
    inset: 0.02,
    resize: 'free',
    keywords: ['tv', 'monitor', 'signage', 'display'],
    tintRole: 'screen',
    build: ({ width, depth, height }) => [
      box(0, height - width * 0.29, 0, width, width * 0.57, 0.07, 'dark'),
      box(0, height - width * 0.29, 0.04, width - 0.06, width * 0.57 - 0.06, 0.02, 'screen'),
      cyl(0, (height - width * 0.58) / 2, 0, 0.05, height - width * 0.58, 'metalDark', 12),
      box(0, 0.03, 0, width * 0.4, 0.06, depth, 'metalDark'),
    ],
  },
  {
    id: 'projector-screen',
    name: 'Projection screen',
    category: 'equipment',
    size: { width: 3.2, depth: 0.2, height: 2.4 },
    blocking: true,
    footprint: 'rect',
    inset: 0.02,
    resize: 'free',
    keywords: ['presentation', 'av', 'conference', 'screen'],
    tintRole: 'white',
    build: ({ width, depth, height }) => [
      box(0, height * 0.6, 0, width, height * 0.72, 0.03, 'white'),
      box(0, height - 0.04, 0, width + 0.1, 0.08, 0.08, 'metalDark'),
      box(-width / 2 + 0.05, height * 0.12, 0, 0.05, height * 0.24, depth, 'metalDark'),
      box(width / 2 - 0.05, height * 0.12, 0, 0.05, height * 0.24, depth, 'metalDark'),
    ],
  },
  {
    id: 'banner',
    name: 'Banner stand',
    category: 'equipment',
    size: { width: 0.9, depth: 0.35, height: 2.1 },
    blocking: true,
    footprint: 'rect',
    inset: 0.04,
    resize: 'free',
    keywords: ['signage', 'roll up', 'pull up', 'branding'],
    tintRole: 'accent',
    build: ({ width, depth, height }) => [
      box(0, height / 2 + 0.06, 0, width, height - 0.12, 0.02, 'accent'),
      box(0, 0.04, 0, width * 0.8, 0.08, depth, 'metalDark'),
      cyl(0, height / 2, -0.04, 0.012, height, 'metal', 8),
    ],
  },
  {
    id: 'shelving',
    name: 'Shelving unit',
    category: 'equipment',
    size: { width: 1.2, depth: 0.45, height: 1.8 },
    blocking: true,
    footprint: 'rect',
    inset: 0,
    resize: 'free',
    keywords: ['storage', 'retail', 'gondola', 'rack', 'bookcase'],
    tintRole: 'wood',
    build: ({ width, depth, height }) => {
      const out: Prim[] = [
        box(-width / 2 + 0.02, height / 2, 0, 0.04, height, depth, 'wood'),
        box(width / 2 - 0.02, height / 2, 0, 0.04, height, depth, 'wood'),
        box(0, height - 0.02, 0, width, 0.04, depth, 'wood'),
        box(0, 0.02, 0, width, 0.04, depth, 'wood'),
      ]
      const shelves = Math.max(2, Math.round(height / 0.42))
      for (let i = 1; i < shelves; i++) {
        const y = (i / shelves) * height
        out.push(box(0, y, 0, width - 0.08, 0.03, depth, 'wood'))
        out.push(box(0, y + 0.13, -0.02, width - 0.2, 0.22, depth * 0.6, 'paper'))
      }
      return out
    },
  },
  {
    id: 'cabinet',
    name: 'Cabinet',
    category: 'equipment',
    size: { width: 1.0, depth: 0.45, height: 0.9 },
    blocking: true,
    footprint: 'rect',
    inset: 0,
    resize: 'free',
    keywords: ['storage', 'sideboard', 'credenza'],
    tintRole: 'wood',
    build: ({ width, depth, height }) => [
      box(0, height / 2, 0, width, height - 0.08, depth, 'wood'),
      box(0, height - 0.02, 0, width + 0.04, 0.04, depth + 0.04, 'woodDark'),
      box(
        -width / 4,
        height / 2,
        depth / 2 + 0.005,
        width / 2 - 0.04,
        height - 0.2,
        0.02,
        'woodDark',
      ),
      box(
        width / 4,
        height / 2,
        depth / 2 + 0.005,
        width / 2 - 0.04,
        height - 0.2,
        0.02,
        'woodDark',
      ),
      ...legs(width, depth, 0.08, 'metalDark', 0.04, 0.06),
    ],
  },
  {
    id: 'coat-rail',
    name: 'Coat rail',
    category: 'equipment',
    size: { width: 1.6, depth: 0.55, height: 1.7 },
    blocking: true,
    footprint: 'rect',
    inset: 0.05,
    resize: 'free',
    keywords: ['cloakroom', 'coat check', 'wardrobe', 'rack'],
    tintRole: 'chrome',
    build: ({ width, depth, height }) => {
      const out: Prim[] = [
        cyl(-width / 2 + 0.05, height / 2, 0, 0.022, height, 'chrome', 10),
        cyl(width / 2 - 0.05, height / 2, 0, 0.022, height, 'chrome', 10),
        box(0, height - 0.02, 0, width, 0.04, 0.04, 'chrome'),
        box(-width / 2 + 0.05, 0.02, 0, 0.06, 0.04, depth, 'metalDark'),
        box(width / 2 - 0.05, 0.02, 0, 0.06, 0.04, depth, 'metalDark'),
      ]
      const coats = Math.max(3, Math.round(width / 0.12))
      for (let i = 0; i < coats; i++) {
        const x = -width / 2 + 0.12 + (i / coats) * (width - 0.24)
        out.push(
          box(x, height - 0.42, 0, 0.06, 0.74, depth * 0.55, i % 3 === 0 ? 'fabricAlt' : 'fabric'),
        )
      }
      return out
    },
  },
  {
    id: 'bin',
    name: 'Waste bin',
    category: 'equipment',
    size: { width: 0.4, depth: 0.4, height: 0.8 },
    blocking: true,
    footprint: 'circle',
    inset: 0,
    resize: 'none',
    keywords: ['rubbish', 'trash', 'recycling'],
    tintRole: 'metalDark',
    build: ({ width, height }) => [
      cone(0, height / 2, 0, width / 2, width / 2 - 0.04, height, 'metalDark', 16),
      torus(0, height, 0, width / 2 - 0.01, 0.02, 'metal', 16),
    ],
  },
  {
    id: 'water-cooler',
    name: 'Water cooler',
    category: 'equipment',
    size: { width: 0.35, depth: 0.35, height: 1.3 },
    blocking: true,
    footprint: 'rect',
    inset: 0,
    resize: 'none',
    keywords: ['water', 'drink', 'dispenser'],
    tintRole: 'white',
    build: ({ width, depth, height }) => [
      box(0, (height - 0.4) / 2, 0, width, height - 0.4, depth, 'white'),
      cone(0, height - 0.18, 0, 0.09, 0.14, 0.36, 'glass', 14),
      box(0, height - 0.46, depth / 2 - 0.02, 0.12, 0.08, 0.04, 'metalDark'),
    ],
  },
]

const DECOR: CatalogItem[] = [
  {
    id: 'plant-small',
    name: 'Potted plant',
    category: 'decor',
    size: { width: 0.5, depth: 0.5, height: 0.9 },
    blocking: true,
    footprint: 'circle',
    inset: 0.06,
    resize: 'uniform',
    keywords: ['greenery', 'pot', 'decoration'],
    tintRole: 'plant',
    build: ({ width, height }) => {
      const potH = height * 0.32
      const out: Prim[] = [
        cone(0, potH / 2, 0, width / 2, width / 2 - 0.07, potH, 'stone', 16),
        cyl(0, potH - 0.01, 0, width / 2 - 0.02, 0.03, 'plantDark', 16),
      ]
      const leaves = 6
      for (let i = 0; i < leaves; i++) {
        const a = (i / leaves) * Math.PI * 2
        const r = width * 0.26
        out.push(
          sphere(
            Math.cos(a) * r,
            potH + height * 0.3 + (i % 2) * 0.1,
            Math.sin(a) * r,
            width * 0.24,
            'plant',
            1.3,
            8,
          ),
        )
      }
      out.push(sphere(0, potH + height * 0.46, 0, width * 0.27, 'plant', 1.2, 10))
      return out
    },
  },
  {
    id: 'plant-tree',
    name: 'Indoor tree',
    category: 'decor',
    size: { width: 1.1, depth: 1.1, height: 2.3 },
    blocking: true,
    footprint: 'circle',
    inset: 0.15,
    resize: 'uniform',
    keywords: ['greenery', 'ficus', 'large plant'],
    tintRole: 'plant',
    build: ({ width, height }) => {
      const potH = height * 0.2
      const out: Prim[] = [
        cone(0, potH / 2, 0, width * 0.33, width * 0.26, potH, 'stone', 18),
        cyl(0, height * 0.5, 0, 0.055, height * 0.7, 'woodDark', 10),
      ]
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2
        out.push(
          sphere(
            Math.cos(a) * width * 0.28,
            height * 0.76 + (i % 2) * height * 0.08,
            Math.sin(a) * width * 0.28,
            width * 0.3,
            i % 2 ? 'plant' : 'plantDark',
            0.85,
            10,
          ),
        )
      }
      out.push(sphere(0, height * 0.9, 0, width * 0.3, 'plant', 0.8, 12))
      return out
    },
  },
  {
    id: 'rug',
    name: 'Rug',
    category: 'decor',
    size: { width: 2.4, depth: 1.6, height: 0.02 },
    blocking: false,
    footprint: 'rect',
    inset: 0,
    resize: 'free',
    keywords: ['carpet', 'floor', 'soft'],
    tintRole: 'carpet',
    build: ({ width, depth }) => [
      box(0, 0.006, 0, width, 0.012, depth, 'carpet'),
      box(0, 0.009, 0, width - 0.22, 0.014, depth - 0.22, 'fabricAlt'),
    ],
  },
  {
    id: 'artwork',
    name: 'Artwork',
    category: 'decor',
    size: { width: 1.2, depth: 0.08, height: 0.9 },
    blocking: false,
    footprint: 'rect',
    inset: 0,
    resize: 'free',
    keywords: ['picture', 'painting', 'frame', 'gallery', 'exhibit'],
    tintRole: 'accent',
    // The one item whose `height` is its own height rather than its extent above
    // the floor: a picture hangs, so resizing it changes the picture and not how
    // high it is hung. Galleries hang to a centre line about 1.5 m up, which is
    // eye level for a standing adult and what the trade calls 58 inches.
    build: ({ width, depth, height }) => [
      box(0, ARTWORK_CENTRE_LINE, 0, width, height, depth, 'woodDark'),
      box(0, ARTWORK_CENTRE_LINE, depth / 2, width - 0.1, height - 0.1, 0.01, 'accent'),
    ],
  },
  {
    id: 'pendant-light',
    name: 'Pendant light',
    category: 'decor',
    size: { width: 0.4, depth: 0.4, height: 0.5 },
    blocking: false,
    footprint: 'circle',
    inset: 0,
    resize: 'uniform',
    keywords: ['lamp', 'lighting', 'ceiling'],
    tintRole: 'metalDark',
    build: ({ width }) => [
      cyl(0, 2.9, 0, 0.008, 0.8, 'metalDark', 6),
      cone(0, 2.42, 0, width * 0.16, width / 2, 0.26, 'metalDark', 16),
      sphere(0, 2.34, 0, width * 0.18, 'emissive', 1, 10),
    ],
  },
  {
    id: 'floor-sign',
    name: 'Floor sign',
    category: 'decor',
    size: { width: 0.5, depth: 0.4, height: 1.2 },
    blocking: true,
    footprint: 'rect',
    inset: 0.05,
    resize: 'none',
    keywords: ['wayfinding', 'signage', 'a-frame', 'direction'],
    tintRole: 'accent',
    build: ({ width, depth, height }) => [
      box(0, height / 2, -depth / 4, width, height, 0.03, 'accent', 0),
      box(0, height / 2, depth / 4, width, height, 0.03, 'accent', 0),
      box(0, 0.02, 0, width, 0.04, depth, 'metalDark'),
    ],
  },
]

// --- registry ----------------------------------------------------------------

/** Gallery hanging height, to the centre of the work: 58 inches. */
const ARTWORK_CENTRE_LINE = 1.473

export const CATALOG: CatalogItem[] = [
  ...TABLES,
  ...SEATING,
  ...SERVICE,
  ...STRUCTURE,
  ...EQUIPMENT,
  ...DECOR,
]

const BY_ID = new Map(CATALOG.map((item) => [item.id, item]))

export const getCatalogItem = (id: string): CatalogItem | undefined => BY_ID.get(id)

/** A stand-in used when a document references an item this build does not have. */
export const FALLBACK_ITEM: CatalogItem = {
  id: 'unknown',
  name: 'Unknown item',
  category: 'decor',
  size: { width: 0.6, depth: 0.6, height: 0.8 },
  blocking: true,
  footprint: 'rect',
  inset: 0,
  resize: 'free',
  keywords: [],
  build: ({ width, depth, height }) => [box(0, height / 2, 0, width, height, depth, 'plastic')],
}

export const resolveCatalogItem = (id: string): CatalogItem => BY_ID.get(id) ?? FALLBACK_ITEM

export const CATEGORY_LABELS: Record<CatalogCategory, string> = {
  tables: 'Tables',
  seating: 'Seating',
  service: 'Service',
  structure: 'Structure',
  equipment: 'Equipment',
  decor: 'Decor',
}

export const CATEGORY_ORDER: CatalogCategory[] = [
  'tables',
  'seating',
  'service',
  'structure',
  'equipment',
  'decor',
]

/** Case-insensitive search over names and keywords. */
export const searchCatalog = (query: string): CatalogItem[] => {
  const q = query.trim().toLowerCase()
  if (!q) return CATALOG
  return CATALOG.filter(
    (item) =>
      item.name.toLowerCase().includes(q) ||
      item.id.includes(q) ||
      item.keywords.some((k) => k.includes(q)),
  )
}

export { translated }
