/**
 * What is shown, and everything that is in the plan.
 *
 * Doubles as an object browser: a plan with fifty pieces of furniture is easier
 * to select from a list than by clicking around a 3D view, particularly for
 * things hidden under something else.
 */

import { useEditor } from '../../state/editorStore'
import { Checkbox, Slider } from '../components/ui'
import { resolveCatalogItem } from '../../library/catalog'
import { ZONE_COLORS, ZONE_LABELS } from '../../core/model/defaults'
import { formatLength } from '../../core/model/units'
import { wallLength } from '../../core/model/planGeometry'
import type { PlanObjectRef } from '../../core/model/types'
import { LockIcon, TrashIcon } from '../components/icons'

export const LayersPanel = () => {
  const document = useEditor((state) => state.document)
  const view = useEditor((state) => state.view)
  const setView = useEditor((state) => state.setView)
  const selection = useEditor((state) => state.selection)
  const setSelection = useEditor((state) => state.setSelection)
  const toggleSelection = useEditor((state) => state.toggleSelection)
  const apply = useEditor((state) => state.apply)
  const units = document.settings.units

  const isSelected = (ref: PlanObjectRef) =>
    selection.some((item) => item.id === ref.id && item.kind === ref.kind)

  const Row = ({
    refObject,
    label,
    meta,
    color,
    locked,
  }: {
    refObject: PlanObjectRef
    label: string
    meta?: string
    color?: string
    locked?: boolean
  }) => (
    <div
      className={`list-row${isSelected(refObject) ? ' is-active' : ''}`}
      onClick={(event) =>
        // Shift adds and removes, the way it does on a click in the 3D view.
        // Appending unconditionally stored the same object twice, and the
        // inspector then offered to delete two things when one was selected.
        event.shiftKey ? toggleSelection(refObject) : setSelection([refObject])
      }
    >
      {color ? <span className="swatch" style={{ background: color }} /> : null}
      <span className="label">{label}</span>
      {meta ? <span className="meta">{meta}</span> : null}
      {locked ? <LockIcon width={12} height={12} style={{ color: 'var(--text-faint)' }} /> : null}
    </div>
  )

  const groups: Array<{ title: string; rows: React.ReactNode[] }> = [
    {
      title: `Walls (${document.plan.walls.length})`,
      rows: document.plan.walls.map((wall) => (
        <Row
          key={wall.id}
          refObject={{ kind: 'wall', id: wall.id }}
          label={wall.kind === 'wall' ? 'Wall' : wall.kind}
          meta={formatLength(wallLength(wall), units)}
          locked={wall.locked}
        />
      )),
    },
    {
      title: `Openings (${document.plan.openings.length})`,
      rows: document.plan.openings.map((opening) => (
        <Row
          key={opening.id}
          refObject={{ kind: 'opening', id: opening.id }}
          label={
            opening.kind === 'window' ? 'Window' : opening.kind === 'opening' ? 'Opening' : 'Door'
          }
          meta={formatLength(opening.width, units)}
          locked={opening.locked}
        />
      )),
    },
    {
      title: `Areas (${document.plan.zones.length})`,
      rows: document.plan.zones.map((zone) => (
        <Row
          key={zone.id}
          refObject={{ kind: 'zone', id: zone.id }}
          label={zone.name}
          meta={ZONE_LABELS[zone.kind]}
          color={zone.color ?? ZONE_COLORS[zone.kind]}
          locked={zone.locked}
        />
      )),
    },
    {
      title: `Service points (${document.plan.servicePoints.length})`,
      rows: document.plan.servicePoints.map((point) => (
        <Row
          key={point.id}
          refObject={{ kind: 'service', id: point.id }}
          label={point.name}
          meta={`${point.servers} staff`}
          color={point.color ?? '#3f9ab0'}
          locked={point.locked}
        />
      )),
    },
    {
      title: `Furniture (${document.plan.furniture.length})`,
      rows: document.plan.furniture.map((item) => (
        <Row
          key={item.id}
          refObject={{ kind: 'furniture', id: item.id }}
          label={item.name ?? resolveCatalogItem(item.catalogId).name}
          locked={item.locked}
        />
      )),
    },
  ]

  return (
    <>
      <div className="panel-header">
        <span className="panel-title">View &amp; layers</span>
      </div>
      <div className="panel-body">
        <div className="section">
          <div className="section-title">Show</div>
          <Checkbox
            label="Grid"
            checked={view.showGrid}
            onChange={(showGrid) => setView({ showGrid })}
          />
          <Checkbox
            label="Furniture"
            checked={view.showFurniture}
            onChange={(showFurniture) => setView({ showFurniture })}
          />
          <Checkbox
            label="Areas"
            checked={view.showZones}
            onChange={(showZones) => setView({ showZones })}
          />
          <Checkbox
            label="Queues"
            checked={view.showQueues}
            onChange={(showQueues) => setView({ showQueues })}
          />
          <Checkbox
            label="Seat markers"
            checked={view.showSeats}
            onChange={(showSeats) => setView({ showSeats })}
          />
          <Checkbox
            label="Room areas"
            checked={view.showRoomLabels}
            onChange={(showRoomLabels) => setView({ showRoomLabels })}
          />
        </div>

        <div className="section">
          <div className="section-title">Wall height</div>
          <Slider
            label="Cut walls at"
            min={0.3}
            max={4}
            step={0.1}
            value={view.wallCutHeight ?? 4}
            format={(v) => (v >= 4 ? 'full height' : formatLength(v, units))}
            onChange={(value) => setView({ wallCutHeight: value >= 4 ? null : value })}
          />
          <p className="hint">
            Lowering the walls lets you see into the room from an angle without switching to the
            plan view.
          </p>
        </div>

        {document.plan.backdrop ? (
          <div className="section">
            <div className="section-title">Traced plan</div>
            <Checkbox
              label="Show the reference image"
              checked={document.plan.backdrop.visible}
              onChange={(visible) =>
                apply(
                  (doc) => ({
                    ...doc,
                    plan: doc.plan.backdrop
                      ? { ...doc.plan, backdrop: { ...doc.plan.backdrop, visible } }
                      : doc.plan,
                  }),
                  'Toggle backdrop',
                )
              }
            />
            <button
              className="btn is-danger"
              onClick={() =>
                apply((doc) => {
                  const plan = { ...doc.plan }
                  delete plan.backdrop
                  return { ...doc, plan }
                }, 'Remove backdrop')
              }
            >
              <TrashIcon width={14} height={14} /> Remove the image
            </button>
          </div>
        ) : null}

        {groups.map((group) =>
          group.rows.length === 0 ? null : (
            <div className="section" key={group.title}>
              <div className="section-title">{group.title}</div>
              <div className="list" style={{ margin: '0 -12px' }}>
                {group.rows}
              </div>
            </div>
          ),
        )}
      </div>
    </>
  )
}
