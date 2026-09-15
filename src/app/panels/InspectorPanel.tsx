/**
 * Properties of whatever is selected.
 *
 * Numbers here are authoritative: a wall's length is editable, and typing one
 * moves its far end. That matters because plans come with measurements, and a
 * tool that only lets you drag is a tool you cannot be precise with.
 */

import { useEditor } from '../../state/editorStore'
import {
  updateFurniture,
  updateOpening,
  updateServicePoint,
  updateWall,
  updateZone,
  updateBackdrop,
} from '../../core/document/mutations'
import { Checkbox, Field, LengthInput, NumberInput, Select, Slider } from '../components/ui'
import { resolveCatalogItem } from '../../library/catalog'
import { polygonArea } from '../../core/math/geometry'
import { wallLength } from '../../core/model/planGeometry'
import { formatArea, formatLength } from '../../core/model/units'
import { ZONE_LABELS } from '../../core/model/defaults'
import { add, angleOf, fromAngle } from '../../core/math/vec2'
import type { Opening, Zone } from '../../core/model/types'
import {
  DOOR_WIDTHS,
  OPENING_JAMB,
  WINDOW_WIDTHS,
  isStandard,
  nearestStandard,
} from '../../core/model/standards'

const DEGREES = 180 / Math.PI

export const InspectorPanel = ({ inspectedPerson }: { inspectedPerson: React.ReactNode }) => {
  const document = useEditor((state) => state.document)
  const selection = useEditor((state) => state.selection)
  const apply = useEditor((state) => state.apply)
  const deleteSelection = useEditor((state) => state.deleteSelection)
  const units = document.settings.units

  if (inspectedPerson) {
    return (
      <>
        <div className="panel-header">
          <span className="panel-title">Person</span>
        </div>
        <div className="panel-body">{inspectedPerson}</div>
      </>
    )
  }

  if (selection.length === 0) {
    return (
      <>
        <div className="panel-header">
          <span className="panel-title">Inspector</span>
        </div>
        <div className="empty">
          Nothing selected.
          <br />
          Click something in the plan, or drag a box around several things.
        </div>
      </>
    )
  }

  if (selection.length > 1) {
    return (
      <>
        <div className="panel-header">
          <span className="panel-title">Inspector</span>
          <span className="badge is-accent">{selection.length} selected</span>
        </div>
        <div className="panel-body">
          <p className="hint">
            Drag to move them together, or use the rotate ring. Arrow keys nudge by one grid step,
            with Shift for a metre.
          </p>
          <button className="btn is-danger" onClick={deleteSelection}>
            Delete {selection.length} objects
          </button>
        </div>
      </>
    )
  }

  const ref = selection[0]

  const header = (title: string, subtitle?: string) => (
    <div className="panel-header">
      <span className="panel-title">{title}</span>
      {subtitle ? <span className="badge">{subtitle}</span> : null}
    </div>
  )

  if (ref.kind === 'wall') {
    const wall = document.plan.walls.find((item) => item.id === ref.id)
    if (!wall) return null
    const length = wallLength(wall)
    const angle = angleOf({ x: wall.b.x - wall.a.x, y: wall.b.y - wall.a.y })
    return (
      <>
        {header('Wall', formatLength(length, units))}
        <div className="panel-body">
          <Field label="Length" hint="Changing this moves the far end.">
            <LengthInput
              value={length}
              units={units}
              min={0.05}
              onCommit={(next) =>
                apply(
                  (doc) => updateWall(doc, wall.id, { b: add(wall.a, fromAngle(angle, next)) }),
                  'Set wall length',
                )
              }
            />
          </Field>
          <Field label="Angle">
            <NumberInput
              value={Math.round(angle * DEGREES * 10) / 10}
              step={1}
              suffix="°"
              onCommit={(degrees) =>
                apply(
                  (doc) =>
                    updateWall(doc, wall.id, {
                      b: add(wall.a, fromAngle(degrees / DEGREES, length)),
                    }),
                  'Set wall angle',
                )
              }
            />
          </Field>
          <div className="row">
            <Field label="Thickness">
              <LengthInput
                value={wall.thickness}
                units={units}
                min={0.02}
                max={2}
                onCommit={(thickness) =>
                  apply((doc) => updateWall(doc, wall.id, { thickness }), 'Set thickness')
                }
              />
            </Field>
            <Field label="Height">
              <LengthInput
                value={wall.height}
                units={units}
                min={0.1}
                max={12}
                onCommit={(height) =>
                  apply((doc) => updateWall(doc, wall.id, { height }), 'Set height')
                }
              />
            </Field>
          </div>
          <Field label="Type">
            <Select
              value={wall.kind}
              onChange={(kind) =>
                apply((doc) => updateWall(doc, wall.id, { kind }), 'Set wall type')
              }
              options={[
                { value: 'wall', label: 'Solid wall' },
                { value: 'partition', label: 'Partition' },
                { value: 'glass', label: 'Glazed' },
                { value: 'barrier', label: 'Crowd barrier' },
                { value: 'rail', label: 'Handrail' },
              ]}
            />
          </Field>
          <Checkbox
            label="Locked"
            checked={Boolean(wall.locked)}
            onChange={(locked) => apply((doc) => updateWall(doc, wall.id, { locked }), 'Lock wall')}
          />
          <button className="btn is-danger" onClick={deleteSelection}>
            Delete wall
          </button>
        </div>
      </>
    )
  }

  if (ref.kind === 'opening') {
    const opening = document.plan.openings.find((item) => item.id === ref.id)
    if (!opening) return null
    const wall = document.plan.walls.find((item) => item.id === opening.wallId)
    const span = wall ? wallLength(wall) : 10
    // An opening has to leave some wall either side of it. Without this the
    // width box accepted the whole wall, which deletes the wall from the plan
    // without deleting it from the document, and the position slider let an
    // opening hang off the end of one.
    const maxWidth = Math.max(0.3, span - 2 * OPENING_JAMB)
    const halfWidth = Math.min(opening.width, maxWidth) / 2
    const minOffset = Math.min(halfWidth + OPENING_JAMB, span / 2)
    const maxOffset = Math.max(minOffset, span - halfWidth - OPENING_JAMB)
    // A doorway cannot be taller than the wall it is cut into, and a window's
    // head cannot be either.
    const maxHeight = wall ? Math.max(0.2, wall.height - opening.sill) : 10
    const maxSill = wall ? Math.max(0, wall.height - opening.height) : 10
    return (
      <>
        {header(
          opening.kind === 'window' ? 'Window' : 'Doorway',
          formatLength(opening.width, units),
        )}
        <div className="panel-body">
          <Field
            label="Width"
            hint={
              isStandard(opening.kind === 'window' ? WINDOW_WIDTHS : DOOR_WIDTHS, opening.width)
                ? undefined
                : 'Not a stock size'
            }
          >
            <LengthInput
              value={opening.width}
              units={units}
              min={0.3}
              max={maxWidth}
              onCommit={(width) =>
                apply((doc) => updateOpening(doc, opening.id, { width }), 'Set width')
              }
            />
          </Field>
          <Field label="Stock size">
            <Select
              value={
                nearestStandard(
                  opening.kind === 'window' ? WINDOW_WIDTHS : DOOR_WIDTHS,
                  opening.width,
                )?.imperial ?? ''
              }
              onChange={(imperial) => {
                const sizes = opening.kind === 'window' ? WINDOW_WIDTHS : DOOR_WIDTHS
                const chosen = sizes.find((size) => size.imperial === imperial)
                if (!chosen) return
                apply(
                  (doc) => updateOpening(doc, opening.id, { width: chosen.metres }),
                  'Set width',
                )
              }}
              options={(opening.kind === 'window' ? WINDOW_WIDTHS : DOOR_WIDTHS).map((size) => ({
                value: size.imperial,
                label: size.note ? `${size.imperial} — ${size.note}` : size.imperial,
              }))}
            />
          </Field>
          <Slider
            label="Position along the wall"
            min={minOffset}
            max={maxOffset}
            step={0.05}
            value={Math.min(Math.max(opening.offset, minOffset), maxOffset)}
            format={(v) => formatLength(v, units)}
            onChange={(offset) =>
              apply((doc) => updateOpening(doc, opening.id, { offset }), 'Move opening')
            }
          />
          <div className="row">
            <Field label="Height">
              <LengthInput
                value={opening.height}
                units={units}
                min={0.2}
                max={maxHeight}
                onCommit={(height) =>
                  apply((doc) => updateOpening(doc, opening.id, { height }), 'Set height')
                }
              />
            </Field>
            <Field label="Sill" hint={opening.sill > 0 ? 'Not walkable' : 'Walkable'}>
              <LengthInput
                value={opening.sill}
                units={units}
                min={0}
                max={maxSill}
                onCommit={(sill) =>
                  apply((doc) => updateOpening(doc, opening.id, { sill }), 'Set sill')
                }
              />
            </Field>
          </div>
          <Field label="Type">
            <Select
              value={opening.kind}
              onChange={(kind) =>
                apply((doc) => updateOpening(doc, opening.id, { kind }), 'Set type')
              }
              options={[
                { value: 'door', label: 'Door' },
                { value: 'double-door', label: 'Double door' },
                { value: 'opening', label: 'Open doorway' },
                { value: 'gate', label: 'Gate' },
                { value: 'window', label: 'Window' },
              ]}
            />
          </Field>
          {opening.kind !== 'window' && (
            <Field
              label="People use it as"
              hint="A door marked here is where people arrive or leave, and its clear width meters them"
            >
              <Select
                value={opening.use ?? 'none'}
                onChange={(use) =>
                  apply(
                    (doc) =>
                      updateOpening(doc, opening.id, {
                        use: use === 'none' ? undefined : (use as Opening['use']),
                      }),
                    'Set door use',
                  )
                }
                options={[
                  { value: 'none', label: 'Just a doorway' },
                  { value: 'entry', label: 'Way in' },
                  { value: 'exit', label: 'Way out' },
                  { value: 'both', label: 'Way in and out' },
                ]}
              />
            </Field>
          )}
          <button className="btn is-danger" onClick={deleteSelection}>
            Delete opening
          </button>
        </div>
      </>
    )
  }

  if (ref.kind === 'furniture') {
    const item = document.plan.furniture.find((entry) => entry.id === ref.id)
    if (!item) return null
    const entry = resolveCatalogItem(item.catalogId)
    const size = item.size ?? entry.size
    const seats = entry.seats?.(size).length ?? 0
    return (
      <>
        {header(entry.name, seats ? `${seats} seats` : undefined)}
        <div className="panel-body">
          <div className="row">
            <Field label="X">
              <LengthInput
                value={item.position.x}
                units={units}
                min={-10000}
                onCommit={(x) =>
                  apply(
                    (doc) => updateFurniture(doc, item.id, { position: { ...item.position, x } }),
                    'Move',
                  )
                }
              />
            </Field>
            <Field label="Y">
              <LengthInput
                value={item.position.y}
                units={units}
                min={-10000}
                onCommit={(y) =>
                  apply(
                    (doc) => updateFurniture(doc, item.id, { position: { ...item.position, y } }),
                    'Move',
                  )
                }
              />
            </Field>
          </div>
          <Field label="Rotation">
            <NumberInput
              value={Math.round(item.rotation * DEGREES)}
              step={15}
              suffix="°"
              onCommit={(degrees) =>
                apply(
                  (doc) => updateFurniture(doc, item.id, { rotation: degrees / DEGREES }),
                  'Rotate',
                )
              }
            />
          </Field>
          {entry.resize !== 'none' ? (
            <div className="row">
              <Field label="Width">
                <LengthInput
                  value={size.width}
                  units={units}
                  min={0.1}
                  onCommit={(width) =>
                    apply(
                      (doc) =>
                        updateFurniture(doc, item.id, {
                          size: {
                            ...size,
                            width,
                            depth:
                              entry.resize === 'uniform'
                                ? width * (size.depth / size.width)
                                : size.depth,
                          },
                        }),
                      'Resize',
                    )
                  }
                />
              </Field>
              <Field label="Depth">
                <LengthInput
                  value={size.depth}
                  units={units}
                  min={0.1}
                  disabled={entry.resize === 'uniform'}
                  onCommit={(depth) =>
                    apply(
                      (doc) => updateFurniture(doc, item.id, { size: { ...size, depth } }),
                      'Resize',
                    )
                  }
                />
              </Field>
            </div>
          ) : null}
          <Checkbox
            label="People must walk around it"
            checked={item.blocking ?? entry.blocking}
            onChange={(blocking) =>
              apply((doc) => updateFurniture(doc, item.id, { blocking }), 'Set blocking')
            }
          />
          <Checkbox
            label="Locked"
            checked={Boolean(item.locked)}
            onChange={(locked) => apply((doc) => updateFurniture(doc, item.id, { locked }), 'Lock')}
          />
          <button className="btn is-danger" onClick={deleteSelection}>
            Delete
          </button>
        </div>
      </>
    )
  }

  if (ref.kind === 'zone') {
    const zone = document.plan.zones.find((item) => item.id === ref.id)
    if (!zone) return null
    return (
      <>
        {header(ZONE_LABELS[zone.kind], formatArea(polygonArea(zone.polygon), units))}
        <div className="panel-body">
          <Field label="Name">
            <input
              className="input"
              value={zone.name}
              onChange={(event) =>
                apply(
                  (doc) => updateZone(doc, zone.id, { name: event.target.value }),
                  'Rename area',
                )
              }
            />
          </Field>
          <Field label="Role">
            <Select
              value={zone.kind}
              onChange={(kind: Zone['kind']) =>
                apply((doc) => updateZone(doc, zone.id, { kind }), 'Change role')
              }
              options={(Object.keys(ZONE_LABELS) as Array<Zone['kind']>).map((kind) => ({
                value: kind,
                label: ZONE_LABELS[kind],
              }))}
            />
          </Field>
          {zone.kind === 'keep-clear' ? (
            <Slider
              label="How strongly to avoid it"
              min={1}
              max={10}
              step={0.5}
              value={zone.cost ?? 4}
              onChange={(cost) => apply((doc) => updateZone(doc, zone.id, { cost }), 'Change cost')}
            />
          ) : null}
          {zone.kind === 'waypoint' || zone.kind === 'seating' ? (
            <Field label="Time spent here">
              <NumberInput
                value={zone.dwell?.mean ?? 180}
                min={1}
                step={30}
                suffix="s"
                onCommit={(mean) =>
                  apply(
                    (doc) =>
                      updateZone(doc, zone.id, {
                        dwell: { kind: 'lognormal', mean, sd: Math.max(5, mean * 0.35), min: 5 },
                      }),
                    'Change dwell',
                  )
                }
              />
            </Field>
          ) : null}
          <p className="hint">
            {zone.polygon.length} corners. Double-click an edge in the plan to add another, or drag
            a corner to reshape it.
          </p>
          <button className="btn is-danger" onClick={deleteSelection}>
            Delete area
          </button>
        </div>
      </>
    )
  }

  if (ref.kind === 'service') {
    const point = document.plan.servicePoints.find((item) => item.id === ref.id)
    if (!point) return null
    return (
      <>
        {header('Service point', `${point.servers} staff`)}
        <div className="panel-body">
          <Field label="Name">
            <input
              className="input"
              value={point.name}
              onChange={(event) =>
                apply(
                  (doc) => updateServicePoint(doc, point.id, { name: event.target.value }),
                  'Rename',
                )
              }
            />
          </Field>
          <Slider
            label="Staffed positions"
            min={1}
            max={12}
            value={point.servers}
            onChange={(servers) =>
              apply((doc) => updateServicePoint(doc, point.id, { servers }), 'Change staffing')
            }
          />
          <Field label="Service time" hint="Average seconds per person.">
            <NumberInput
              value={point.serviceTime.mean}
              min={0.5}
              step={5}
              suffix="s"
              onCommit={(mean) =>
                apply(
                  (doc) =>
                    updateServicePoint(doc, point.id, {
                      serviceTime: { ...point.serviceTime, mean, sd: Math.max(1, mean * 0.35) },
                    }),
                  'Change service time',
                )
              }
            />
          </Field>
          <Field label="Variability">
            <Select
              value={point.serviceTime.kind}
              onChange={(kind) =>
                apply(
                  (doc) =>
                    updateServicePoint(doc, point.id, {
                      serviceTime: { ...point.serviceTime, kind },
                    }),
                  'Change distribution',
                )
              }
              options={[
                { value: 'lognormal', label: 'Realistic (log-normal)' },
                { value: 'normal', label: 'Normal' },
                { value: 'exponential', label: 'Memoryless (exponential)' },
                { value: 'constant', label: 'Exactly the same every time' },
              ]}
            />
          </Field>
          <div className="row">
            <Field label="Counter width">
              <LengthInput
                value={point.width}
                units={units}
                min={0.3}
                onCommit={(width) =>
                  apply((doc) => updateServicePoint(doc, point.id, { width }), 'Resize')
                }
              />
            </Field>
            <Field label="Queue spacing">
              <LengthInput
                value={point.queueSpacing}
                units={units}
                min={0.3}
                max={3}
                onCommit={(queueSpacing) =>
                  apply(
                    (doc) => updateServicePoint(doc, point.id, { queueSpacing }),
                    'Change spacing',
                  )
                }
              />
            </Field>
          </div>
          <p className="hint">
            Switch to the queue tool to reshape the waiting line. Little's law: at {point.servers}{' '}
            {point.servers === 1 ? 'position' : 'positions'} and {point.serviceTime.mean.toFixed(0)}{' '}
            s each, this counter can clear about{' '}
            <b>{((3600 * point.servers) / Math.max(1, point.serviceTime.mean)).toFixed(0)}</b>{' '}
            people an hour.
          </p>
          <button className="btn is-danger" onClick={deleteSelection}>
            Delete service point
          </button>
        </div>
      </>
    )
  }

  if (ref.kind === 'backdrop' && document.plan.backdrop) {
    const backdrop = document.plan.backdrop
    return (
      <>
        {header('Reference image')}
        <div className="panel-body">
          <p className="hint">
            Set the width to a dimension you know from the original plan; everything else scales
            with it.
          </p>
          <div className="row">
            <Field label="Width">
              <LengthInput
                value={backdrop.width}
                units={units}
                min={0.5}
                onCommit={(width) =>
                  apply(
                    (doc) =>
                      updateBackdrop(doc, {
                        width,
                        depth: backdrop.depth * (width / backdrop.width),
                      }),
                    'Scale image',
                  )
                }
              />
            </Field>
            <Field label="Depth">
              <LengthInput
                value={backdrop.depth}
                units={units}
                min={0.5}
                onCommit={(depth) => apply((doc) => updateBackdrop(doc, { depth }), 'Scale image')}
              />
            </Field>
          </div>
          <Slider
            label="Opacity"
            min={0.05}
            max={1}
            step={0.05}
            value={backdrop.opacity}
            format={(v) => `${(v * 100).toFixed(0)}%`}
            onChange={(opacity) =>
              apply((doc) => updateBackdrop(doc, { opacity }), 'Change opacity')
            }
          />
          <Field label="Rotation">
            <NumberInput
              value={Math.round(backdrop.rotation * DEGREES)}
              step={1}
              suffix="°"
              onCommit={(degrees) =>
                apply((doc) => updateBackdrop(doc, { rotation: degrees / DEGREES }), 'Rotate image')
              }
            />
          </Field>
        </div>
      </>
    )
  }

  return null
}
