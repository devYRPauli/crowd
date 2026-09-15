/**
 * The furniture library and the options for whatever tool is active.
 *
 * Catalog thumbnails are drawn as top-down SVG footprints with their seats
 * marked, rather than as rendered previews: in a floor-plan tool the thing you
 * need to judge is the footprint and how many people it seats, and a plan
 * silhouette answers both at a glance and costs nothing to draw.
 */

import { useMemo, useState } from 'react'
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  CATALOG,
  resolveCatalogItem,
  searchCatalog,
  type CatalogCategory,
  type CatalogItem,
} from '../../library/catalog'
import { useEditor } from '../../state/editorStore'
import { formatLength } from '../../core/model/units'
import { ZONE_LABELS } from '../../core/model/defaults'
import { Field, LengthInput, Segmented, Select } from '../components/ui'
import type { UnitSystem } from '../../core/model/types'

const Thumbnail = ({ item }: { item: CatalogItem }) => {
  const { width, depth } = item.size
  const seats = item.seats?.(item.size) ?? []
  // Pad the viewbox so seats drawn outside the footprint still fit.
  const extent = Math.max(width, depth) + 1.4
  const scale = 100 / extent
  const cx = 60
  const cy = 45
  const w = width * scale
  const d = depth * scale

  return (
    <svg className="thumb" viewBox="0 0 120 90" role="img" aria-label={`${item.name} footprint`}>
      {item.footprint === 'circle' ? (
        <circle
          cx={cx}
          cy={cy}
          r={Math.min(w, d) / 2}
          fill="var(--accent-soft)"
          stroke="var(--accent)"
          strokeWidth={1.2}
        />
      ) : (
        <rect
          x={cx - w / 2}
          y={cy - d / 2}
          width={w}
          height={d}
          rx={2}
          fill="var(--accent-soft)"
          stroke="var(--accent)"
          strokeWidth={1.2}
        />
      )}
      {seats.map((seat, index) => (
        <circle
          key={index}
          cx={cx + seat.x * scale}
          cy={cy + seat.z * scale}
          r={2.6}
          fill={seat.kind === 'seat' ? 'var(--text-dim)' : 'none'}
          stroke="var(--text-dim)"
          strokeWidth={1}
        />
      ))}
      {/* Face marker: which way the item points. */}
      <path
        d={`M${cx - 3},${cy + d / 2 + 5} L${cx + 3},${cy + d / 2 + 5} L${cx},${cy + d / 2 + 9} Z`}
        fill="var(--text-faint)"
      />
    </svg>
  )
}

const CatalogBrowser = ({ units }: { units: UnitSystem }) => {
  const catalogId = useEditor((state) => state.toolOptions.catalogId)
  const setToolOptions = useEditor((state) => state.setToolOptions)
  const setTool = useEditor((state) => state.setTool)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<CatalogCategory | 'all'>('all')

  const items = useMemo(() => {
    const matched = query.trim() ? searchCatalog(query) : CATALOG
    return category === 'all' ? matched : matched.filter((item) => item.category === category)
  }, [query, category])

  return (
    <>
      <div className="library-search">
        <input
          className="input"
          placeholder="Search furniture…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search the furniture catalog"
        />
      </div>
      <div className="category-tabs">
        <button
          className={`chip${category === 'all' ? ' is-active' : ''}`}
          onClick={() => setCategory('all')}
        >
          All
        </button>
        {CATEGORY_ORDER.map((id) => (
          <button
            key={id}
            className={`chip${category === id ? ' is-active' : ''}`}
            onClick={() => setCategory(id)}
          >
            {CATEGORY_LABELS[id]}
          </button>
        ))}
      </div>
      {items.length === 0 ? (
        <div className="empty">
          Nothing matches “{query}”.
          <br />
          Try a room name like “bar”, “banquet” or “queue”.
        </div>
      ) : (
        <div className="catalog-grid">
          {items.map((item) => (
            <button
              key={item.id}
              className={`catalog-item${item.id === catalogId ? ' is-active' : ''}`}
              onClick={() => {
                setToolOptions({ catalogId: item.id })
                setTool('furniture')
              }}
              title={`${item.name} — ${item.keywords.join(', ')}`}
            >
              <Thumbnail item={item} />
              <span className="name">{item.name}</span>
              <span className="size">
                {formatLength(item.size.width, units)} × {formatLength(item.size.depth, units)}
                {item.seats ? ` · ${item.seats(item.size).length} seats` : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  )
}

const ToolOptions = ({ units }: { units: UnitSystem }) => {
  const tool = useEditor((state) => state.tool)
  const options = useEditor((state) => state.toolOptions)
  const setToolOptions = useEditor((state) => state.setToolOptions)

  if (tool === 'wall' || tool === 'room') {
    return (
      <div className="section">
        <div className="section-title">Wall</div>
        <Field label="Type">
          <Select
            value={options.wallKind}
            onChange={(wallKind) => setToolOptions({ wallKind })}
            options={[
              { value: 'wall', label: 'Solid wall' },
              { value: 'partition', label: 'Partition' },
              { value: 'glass', label: 'Glazed' },
              { value: 'barrier', label: 'Crowd barrier' },
              { value: 'rail', label: 'Handrail' },
            ]}
          />
        </Field>
        <div className="row">
          <Field label="Thickness">
            <LengthInput
              value={options.wallThickness}
              units={units}
              min={0.02}
              max={2}
              onCommit={(wallThickness) => setToolOptions({ wallThickness })}
            />
          </Field>
          <Field label="Height">
            <LengthInput
              value={options.wallHeight}
              units={units}
              min={0.1}
              max={12}
              onCommit={(wallHeight) => setToolOptions({ wallHeight })}
            />
          </Field>
        </div>
        <p className="hint">
          Click to start a wall, click again to continue the chain. Type a length and press Enter to
          place it exactly. Escape or a double-click finishes.
        </p>
      </div>
    )
  }

  if (tool === 'door' || tool === 'window') {
    return (
      <div className="section">
        <div className="section-title">{tool === 'door' ? 'Doorway' : 'Window'}</div>
        <Field label="Width">
          <LengthInput
            value={tool === 'door' ? options.doorWidth : options.windowWidth}
            units={units}
            min={0.3}
            max={6}
            onCommit={(value) =>
              setToolOptions(tool === 'door' ? { doorWidth: value } : { windowWidth: value })
            }
          />
        </Field>
        {tool === 'door' ? (
          <Segmented
            value={options.doorWidth >= 1.5 ? 'double' : 'single'}
            onChange={(value) => setToolOptions({ doorWidth: value === 'double' ? 1.8 : 0.9 })}
            options={[
              { value: 'single', label: 'Single' },
              { value: 'double', label: 'Double' },
            ]}
          />
        ) : null}
        <p className="hint">
          Move onto a wall and click. Openings at floor level are walkable; windows are not.
        </p>
      </div>
    )
  }

  if (tool === 'zone') {
    return (
      <div className="section">
        <div className="section-title">Area type</div>
        <div className="category-tabs" style={{ padding: 0, border: 'none' }}>
          {(
            ['entry', 'exit', 'waypoint', 'seating', 'keep-clear', 'obstacle', 'measure'] as const
          ).map((kind) => (
            <button
              key={kind}
              className={`chip${options.zoneKind === kind ? ' is-active' : ''}`}
              onClick={() => setToolOptions({ zoneKind: kind })}
            >
              {ZONE_LABELS[kind]}
            </button>
          ))}
        </div>
        <p className="hint">
          Drag a rectangle, or click once to start a free-form outline and double-click to close it.
          {options.zoneKind === 'entry' ? ' People appear inside an entry area.' : ''}
          {options.zoneKind === 'exit' ? ' Reaching an exit area is how someone leaves.' : ''}
          {options.zoneKind === 'keep-clear'
            ? ' Routing avoids a keep-clear area without treating it as a wall.'
            : ''}
          {options.zoneKind === 'measure' ? ' Measurement areas are reported separately.' : ''}
        </p>
      </div>
    )
  }

  if (tool === 'service' || tool === 'queue') {
    return (
      <div className="section">
        <div className="section-title">Service point</div>
        <p className="hint">
          {tool === 'service'
            ? 'Click to place a counter. It faces away from the nearest wall and its queue is created running into the room.'
            : 'Drag a queue point to reshape the line. Click the line to add a point, Alt-click a point to remove it.'}
        </p>
      </div>
    )
  }

  if (tool === 'measure') {
    return (
      <div className="section">
        <div className="section-title">Tape measure</div>
        <p className="hint">
          Click to drop points. Each leg is labelled and the total is shown at the end. Escape
          clears.
        </p>
      </div>
    )
  }

  return null
}

export const LibraryPanel = () => {
  const units = useEditor((state) => state.document.settings.units)
  const tool = useEditor((state) => state.tool)
  const showCatalog = tool === 'furniture' || tool === 'select'

  return (
    <>
      <div className="panel-header">
        <span className="panel-title">Library</span>
        <span className="badge">{CATALOG.length} items</span>
      </div>
      {showCatalog ? (
        <div className="panel-body is-flush" style={{ gap: 0 }}>
          <CatalogBrowser units={units} />
        </div>
      ) : (
        <div className="panel-body">
          <ToolOptions units={units} />
          <button className="btn" onClick={() => useEditor.getState().setTool('furniture')}>
            Browse furniture
          </button>
        </div>
      )}
      {showCatalog && tool === 'furniture' ? (
        <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)' }}>
          <p className="hint" style={{ margin: 0 }}>
            <b>{resolveCatalogItem(useEditor.getState().toolOptions.catalogId).name}</b> — click in
            the plan to place. <span className="kbd">R</span> rotates.
          </p>
        </div>
      ) : null}
    </>
  )
}
