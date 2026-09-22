/**
 * The tool strip.
 *
 * Every tool has a single-key shortcut shown in its tooltip, because a drawing
 * tool people use for an hour is a tool they should be able to drive from the
 * keyboard.
 */

import type { ReactElement } from 'react'
import { useEditor, type ToolId } from '../state/editorStore'
import {
  CursorIcon,
  DoorIcon,
  FurnitureIcon,
  MeasureIcon,
  OrbitIcon,
  QueueIcon,
  RoomIcon,
  ServiceIcon,
  WallIcon,
  WindowIcon,
  ZoneIcon,
} from './components/icons'

interface ToolSpec {
  id: ToolId
  label: string
  shortcut: string
  Icon: (props: { width?: number; height?: number }) => ReactElement
}

const GROUPS: ToolSpec[][] = [
  [
    { id: 'select', label: 'Select and move', shortcut: 'V', Icon: CursorIcon },
    { id: 'view', label: 'Look around', shortcut: 'O', Icon: OrbitIcon },
  ],
  [
    { id: 'wall', label: 'Draw walls', shortcut: 'W', Icon: WallIcon },
    { id: 'room', label: 'Draw a room', shortcut: 'R', Icon: RoomIcon },
    { id: 'door', label: 'Add a doorway', shortcut: 'D', Icon: DoorIcon },
    { id: 'window', label: 'Add a window', shortcut: 'N', Icon: WindowIcon },
  ],
  [
    { id: 'furniture', label: 'Place furniture', shortcut: 'F', Icon: FurnitureIcon },
    { id: 'zone', label: 'Draw an area', shortcut: 'Z', Icon: ZoneIcon },
    { id: 'service', label: 'Place a service point', shortcut: 'S', Icon: ServiceIcon },
    { id: 'queue', label: 'Reshape a queue', shortcut: 'Q', Icon: QueueIcon },
  ],
  [{ id: 'measure', label: 'Tape measure', shortcut: 'M', Icon: MeasureIcon }],
]

export const ToolRail = () => {
  const tool = useEditor((state) => state.tool)
  const setTool = useEditor((state) => state.setTool)

  return (
    <nav className="tool-rail" aria-label="Tools">
      {GROUPS.map((group, index) => (
        <div key={index} style={{ display: 'contents' }}>
          {index > 0 ? <span className="rail-separator" /> : null}
          {group.map((spec) => (
            <button
              key={spec.id}
              className={`tool-button${tool === spec.id ? ' is-active' : ''}`}
              title={`${spec.label}  (${spec.shortcut})`}
              aria-label={spec.label}
              aria-pressed={tool === spec.id}
              onClick={() => setTool(spec.id)}
            >
              <spec.Icon />
            </button>
          ))}
        </div>
      ))}
    </nav>
  )
}
