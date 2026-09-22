/**
 * Inline icons.
 *
 * Drawn by hand rather than pulled from a library: there are twenty of them,
 * they need to sit on a 24-unit grid with a consistent 1.6 stroke, and an icon
 * dependency would be larger than the icons.
 */

import type { SVGProps } from 'react'

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

type IconProps = SVGProps<SVGSVGElement>

export const CursorIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M5 3.5l13.5 7.5-6 1.4-2.4 5.8z" />
  </svg>
)

export const OrbitIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <ellipse cx="12" cy="12" rx="9.5" ry="4.2" />
    <path d="M16.6 5.2l2.2 3-3.6.6" />
    <circle cx="12" cy="12" r="2.2" />
  </svg>
)

export const WallIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M3 17h18" />
    <path d="M3 13.5v3.5M9 13.5v3.5M15 13.5v3.5M21 13.5v3.5" />
    <path d="M3 13.5h18" />
    <path d="M6 10v3.5M12 10v3.5M18 10v3.5" />
    <path d="M3 10h18" />
  </svg>
)

export const RoomIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="1" />
    <path d="M3.5 12h7M14 12h6.5" />
  </svg>
)

export const DoorIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4 20h4M16 20h4" />
    <path d="M8 20V6l8-2v16" />
    <circle cx="10" cy="13" r="0.9" fill="currentColor" stroke="none" />
  </svg>
)

export const WindowIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <rect x="4" y="6" width="16" height="12" rx="1" />
    <path d="M12 6v12M4 12h16" />
  </svg>
)

export const FurnitureIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="11" r="5" />
    <path d="M12 16v4M8 20h8" />
    <circle cx="4.5" cy="8" r="1.6" />
    <circle cx="19.5" cy="8" r="1.6" />
  </svg>
)

export const ZoneIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4 7l8-3 8 3v10l-8 3-8-3z" strokeDasharray="3 2.4" />
  </svg>
)

export const ServiceIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <rect x="3" y="5" width="18" height="4.5" rx="1" />
    <path d="M7 14h.01M12 14h.01M17 14h.01M7 18h.01M12 18h.01" />
  </svg>
)

export const QueueIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="6" cy="12" r="2" />
    <circle cx="12" cy="12" r="2" />
    <circle cx="18" cy="12" r="2" />
    <path d="M8.4 12h1.2M14.4 12h1.2" />
  </svg>
)

export const MeasureIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <rect x="2.5" y="8.5" width="19" height="7" rx="1" transform="rotate(-8 12 12)" />
    <path d="M7 9.4v2.4M11 8.8v3.2M15 8.2v2.4M19 7.6v3.2" />
  </svg>
)

export const PlayIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M7 4.5l12 7.5-12 7.5z" fill="currentColor" />
  </svg>
)

export const PauseIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M8.5 4.5v15M15.5 4.5v15" strokeWidth={2.4} />
  </svg>
)

export const StopIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" />
  </svg>
)

export const UndoIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4 9h11a5 5 0 010 10h-6" />
    <path d="M8 5L4 9l4 4" />
  </svg>
)

export const RedoIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M20 9H9a5 5 0 000 10h6" />
    <path d="M16 5l4 4-4 4" />
  </svg>
)

export const LayersIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M12 3.5l9 4.5-9 4.5-9-4.5z" />
    <path d="M3 13l9 4.5 9-4.5" />
  </svg>
)

export const ChartIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4 20V4" />
    <path d="M4 20h16" />
    <path d="M8 17v-5M12.5 17V8M17 17v-7" />
  </svg>
)

export const PeopleIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="9" cy="7.5" r="2.8" />
    <path d="M3.8 19.5c0-3 2.3-5.2 5.2-5.2s5.2 2.2 5.2 5.2" />
    <path d="M16 5.2a2.8 2.8 0 010 5.3" />
    <path d="M17 14.6c2.1.5 3.5 2.4 3.5 4.9" />
  </svg>
)

export const SettingsIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 14.5a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5v.2a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1h.2a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z" />
  </svg>
)

export const GridIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
  </svg>
)

export const HeatIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M12 3c2.5 3.2 4.5 5.4 4.5 8.4a4.5 4.5 0 11-9 0C7.5 8.4 9.5 6.2 12 3z" />
    <path d="M12 19a2.4 2.4 0 002.4-2.4c0-1.5-1-2.4-2.4-4-1.4 1.6-2.4 2.5-2.4 4A2.4 2.4 0 0012 19z" />
  </svg>
)

export const CameraIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M3 8.5l9-5 9 5-9 5z" />
    <path d="M3 8.5v7l9 5 9-5v-7" />
  </svg>
)

export const CloseIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
)

export const HelpIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.6 9.3a2.5 2.5 0 114.2 2c-.9.8-1.8 1.3-1.8 2.6" />
    <path d="M12 17.2h.01" />
  </svg>
)

export const FolderIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M3 6.5A1.5 1.5 0 014.5 5h4l2 2.5h9A1.5 1.5 0 0121 9v8.5a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 17.5z" />
  </svg>
)

export const SaveIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M5 3.5h11L20.5 8v12.5a1 1 0 01-1 1h-14a1 1 0 01-1-1v-16a1 1 0 011-1z" />
    <path d="M8 3.5v6h7v-6M8 21.5V15h8v6.5" />
  </svg>
)

export const TrashIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4 6.5h16M9.5 6.5V4h5v2.5" />
    <path d="M6.5 6.5l1 13.5h9l1-13.5" />
  </svg>
)

export const PlusIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const LockIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <rect x="5" y="10.5" width="14" height="10" rx="1.6" />
    <path d="M8.5 10.5V7.8a3.5 3.5 0 017 0v2.7" />
  </svg>
)

export const EyeIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </svg>
)
