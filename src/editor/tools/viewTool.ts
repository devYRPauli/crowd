import type { Tool } from '../types'

/** Look around: the left button orbits, and pans with Shift, and nothing is edited. */
export class ViewTool implements Tool {
  readonly id = 'view' as const
  readonly hint = 'Drag to orbit · Shift-drag to pan · Wheel to zoom · Nothing is edited'
  readonly cursor = 'grab'
  readonly leftButtonNavigates = true
}
