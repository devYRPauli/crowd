/**
 * Who comes, when, and what they do.
 *
 * A scenario is where most of a planner's intent lives, so the panel is built
 * around editing an itinerary directly: each step names a destination that
 * exists in the plan, and a service step can name several counters at once,
 * which is how parallel desks get balanced rather than all queued at one.
 */

import { useMemo } from 'react'
import { useEditor } from '../../state/editorStore'
import {
  addPopulation,
  removePopulation,
  updatePopulation,
  updateScenario,
} from '../../core/document/mutations'
import { createItineraryStep, createPopulation, POPULATION_COLORS } from '../../core/model/defaults'
import type { ArrivalKind, ItineraryStep, Population } from '../../core/model/types'
import { Checkbox, Field, NumberInput, Select, Slider } from '../components/ui'
import { formatDuration } from '../../core/model/units'
import { PlusIcon, TrashIcon } from '../components/icons'
import { BriefBox } from './BriefBox'

const ARRIVAL_LABELS: Record<ArrivalKind, string> = {
  uniform: 'Evenly spread',
  poisson: 'Random (Poisson)',
  waves: 'In waves',
  'front-loaded': 'Front-loaded',
  peak: 'Around a peak',
  'all-at-once': 'All at once',
}

const STEP_LABELS: Record<ItineraryStep['kind'], string> = {
  goto: 'Go to',
  service: 'Queue at',
  dwell: 'Spend time in',
  seat: 'Sit down in',
  exit: 'Leave by',
}

const ItineraryEditor = ({ population }: { population: Population }) => {
  const document = useEditor((state) => state.document)
  const apply = useEditor((state) => state.apply)

  const zones = document.plan.zones
  const services = document.plan.servicePoints

  const targetsFor = (kind: ItineraryStep['kind']) => {
    if (kind === 'service') return services.map((s) => ({ value: s.id, label: s.name }))
    if (kind === 'exit') {
      return zones.filter((z) => z.kind === 'exit').map((z) => ({ value: z.id, label: z.name }))
    }
    if (kind === 'seat') {
      return zones
        .filter((z) => z.kind === 'seating' || z.kind === 'waypoint')
        .map((z) => ({ value: z.id, label: z.name }))
    }
    return zones
      .filter((z) => z.kind === 'waypoint' || z.kind === 'seating')
      .map((z) => ({ value: z.id, label: z.name }))
  }

  const patchStep = (stepId: string, patch: Partial<ItineraryStep>) => {
    apply(
      (doc) =>
        updatePopulation(doc, population.id, {
          itinerary: population.itinerary.map((step) =>
            step.id === stepId ? { ...step, ...patch } : step,
          ),
        }),
      'Edit itinerary',
    )
  }

  return (
    <div className="section">
      <div className="section-title">
        <span>Itinerary</span>
        <button
          className="btn is-ghost is-icon"
          title="Add a step"
          onClick={() =>
            apply(
              (doc) =>
                updatePopulation(doc, population.id, {
                  itinerary: [
                    ...population.itinerary.slice(0, -1),
                    createItineraryStep('goto', zones.find((z) => z.kind === 'waypoint')?.id),
                    ...population.itinerary.slice(-1),
                  ],
                }),
              'Add itinerary step',
            )
          }
        >
          <PlusIcon width={15} height={15} />
        </button>
      </div>

      {population.itinerary.length === 0 ? (
        <p className="hint">No steps yet. People will walk straight to the nearest exit.</p>
      ) : null}

      {population.itinerary.map((step, index) => {
        const targets = targetsFor(step.kind)
        const multi = step.kind === 'service' && services.length > 1
        return (
          <div
            key={step.id}
            style={{
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              padding: 9,
              display: 'flex',
              flexDirection: 'column',
              gap: 7,
              background: 'var(--surface-2)',
            }}
          >
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span className="badge">{index + 1}</span>
              <Select
                value={step.kind}
                onChange={(kind) =>
                  patchStep(step.id, { kind, targetId: undefined, targetIds: undefined })
                }
                options={(Object.keys(STEP_LABELS) as Array<ItineraryStep['kind']>).map((kind) => ({
                  value: kind,
                  label: STEP_LABELS[kind],
                }))}
              />
              <button
                className="btn is-ghost is-icon"
                title="Remove this step"
                onClick={() =>
                  apply(
                    (doc) =>
                      updatePopulation(doc, population.id, {
                        itinerary: population.itinerary.filter((s) => s.id !== step.id),
                      }),
                    'Remove itinerary step',
                  )
                }
              >
                <TrashIcon width={14} height={14} />
              </button>
            </div>

            {targets.length === 0 ? (
              <p className="hint" style={{ margin: 0 }}>
                Nothing in the plan can be a {STEP_LABELS[step.kind].toLowerCase()} target yet.
              </p>
            ) : multi ? (
              <div className="field">
                <span className="field-label">Counters (people pick the quickest)</span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {services.map((service) => {
                    const chosen = step.targetIds ?? (step.targetId ? [step.targetId] : [])
                    return (
                      <Checkbox
                        key={service.id}
                        label={service.name}
                        checked={chosen.includes(service.id)}
                        onChange={(on) => {
                          const next = on
                            ? [...chosen, service.id]
                            : chosen.filter((id) => id !== service.id)
                          patchStep(step.id, {
                            targetIds: next,
                            targetId: next[0],
                          })
                        }}
                      />
                    )
                  })}
                </div>
              </div>
            ) : (
              <Select
                value={step.targetId ?? targets[0]?.value ?? ''}
                onChange={(targetId) => patchStep(step.id, { targetId })}
                options={targets}
              />
            )}

            {step.kind === 'dwell' || step.kind === 'seat' ? (
              <Field label="How long they stay">
                <NumberInput
                  value={step.duration?.mean ?? 300}
                  min={1}
                  step={30}
                  suffix="s"
                  onCommit={(mean) =>
                    patchStep(step.id, {
                      duration: { kind: 'lognormal', mean, sd: Math.max(5, mean * 0.35), min: 5 },
                    })
                  }
                />
              </Field>
            ) : null}

            {step.kind !== 'exit' ? (
              <Slider
                label="How many do this"
                min={0}
                max={1}
                step={0.05}
                value={step.probability ?? 1}
                format={(v) => `${(v * 100).toFixed(0)}%`}
                onChange={(probability) => patchStep(step.id, { probability })}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

const PopulationEditor = ({ population, index }: { population: Population; index: number }) => {
  const document = useEditor((state) => state.document)
  const apply = useEditor((state) => state.apply)
  const entries = document.plan.zones.filter((zone) => zone.kind === 'entry')

  const patch = (changes: Partial<Population>, label: string) =>
    apply((doc) => updatePopulation(doc, population.id, changes), label)

  return (
    <div
      className="section"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: 10,
      }}
    >
      <div className="section-title">
        <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span className="swatch" style={{ background: population.color }} />
          <input
            className="doc-name"
            style={{ padding: '1px 4px', fontSize: 12 }}
            value={population.name}
            onChange={(event) => patch({ name: event.target.value }, 'Rename group')}
          />
        </span>
        {document.scenario.populations.length > 1 ? (
          <button
            className="btn is-ghost is-icon"
            title="Remove this group"
            onClick={() => apply((doc) => removePopulation(doc, population.id), 'Remove group')}
          >
            <TrashIcon width={14} height={14} />
          </button>
        ) : null}
      </div>

      <div className="row">
        <Field label="People">
          <NumberInput
            value={population.count}
            min={0}
            max={6000}
            step={10}
            onCommit={(count) => patch({ count: Math.round(count) }, 'Change headcount')}
          />
        </Field>
        <Field label="Colour">
          <Select
            value={population.color}
            onChange={(color) => patch({ color }, 'Change colour')}
            options={POPULATION_COLORS.map((color, i) => ({
              value: color,
              label: `Colour ${i + 1}`,
            }))}
          />
        </Field>
      </div>

      <Field label="Arrivals">
        <Select
          value={population.arrival.kind}
          onChange={(kind) =>
            patch({ arrival: { ...population.arrival, kind } }, 'Change arrivals')
          }
          options={(Object.keys(ARRIVAL_LABELS) as ArrivalKind[]).map((kind) => ({
            value: kind,
            label: ARRIVAL_LABELS[kind],
          }))}
        />
      </Field>

      {population.arrival.kind !== 'all-at-once' ? (
        <div className="row">
          <Field label="Starting at">
            <NumberInput
              value={population.arrival.startS}
              min={0}
              step={60}
              suffix="s"
              onCommit={(startS) =>
                patch({ arrival: { ...population.arrival, startS } }, 'Change arrivals')
              }
            />
          </Field>
          <Field label="Over">
            <NumberInput
              value={population.arrival.windowS}
              min={0}
              step={60}
              suffix="s"
              onCommit={(windowS) =>
                patch({ arrival: { ...population.arrival, windowS } }, 'Change arrivals')
              }
            />
          </Field>
        </div>
      ) : null}

      {population.arrival.kind === 'waves' ? (
        <Slider
          label="Number of waves"
          min={2}
          max={12}
          value={population.arrival.waves ?? 4}
          onChange={(waves) =>
            patch({ arrival: { ...population.arrival, waves } }, 'Change arrivals')
          }
        />
      ) : null}

      {population.arrival.kind === 'peak' ? (
        <Slider
          label="Peak position"
          min={0.05}
          max={0.95}
          step={0.05}
          value={population.arrival.peakAt ?? 0.5}
          format={(v) => formatDuration(v * population.arrival.windowS)}
          onChange={(peakAt) =>
            patch({ arrival: { ...population.arrival, peakAt } }, 'Change arrivals')
          }
        />
      ) : null}

      <Field
        label="Entering through"
        hint={entries.length === 0 ? 'Draw an entry area to choose one.' : undefined}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {entries.map((zone) => (
            <Checkbox
              key={zone.id}
              label={zone.name}
              checked={population.entryIds.includes(zone.id)}
              onChange={(on) =>
                patch(
                  {
                    entryIds: on
                      ? [...population.entryIds, zone.id]
                      : population.entryIds.filter((id) => id !== zone.id),
                  },
                  'Change entrances',
                )
              }
            />
          ))}
        </div>
      </Field>

      <ItineraryEditor population={population} />
      <span className="hint">
        Group {index + 1} of {document.scenario.populations.length}
      </span>
    </div>
  )
}

export const ScenarioPanel = () => {
  const document = useEditor((state) => state.document)
  const apply = useEditor((state) => state.apply)
  const scenario = document.scenario

  const total = useMemo(
    () => scenario.populations.reduce((sum, p) => sum + p.count, 0),
    [scenario.populations],
  )

  return (
    <>
      <div className="panel-header">
        <span className="panel-title">Scenario</span>
        <span className="badge is-accent">{total} people</span>
      </div>
      <div className="panel-body">
        <BriefBox />

        <div className="section">
          <div className="row">
            <Field label="Run length">
              <NumberInput
                value={scenario.durationS}
                min={30}
                step={300}
                suffix="s"
                onCommit={(durationS) =>
                  apply((doc) => updateScenario(doc, { durationS }), 'Change run length')
                }
              />
            </Field>
            <Field label="Seed" hint="Same seed, same people.">
              <NumberInput
                value={scenario.seed}
                min={0}
                step={1}
                onCommit={(seed) =>
                  apply((doc) => updateScenario(doc, { seed: Math.round(seed) }), 'Change seed')
                }
              />
            </Field>
          </div>
        </div>

        {scenario.populations.map((population, index) => (
          <PopulationEditor key={population.id} population={population} index={index} />
        ))}

        <button
          className="btn"
          onClick={() =>
            apply(
              (doc) => addPopulation(doc, createPopulation(doc.scenario.populations.length)),
              'Add group',
            )
          }
        >
          <PlusIcon width={15} height={15} /> Add another group
        </button>

        <div className="section">
          <div className="section-title">Movement</div>
          <Checkbox
            label="Route around congestion"
            checked={scenario.routing.adaptive}
            onChange={(adaptive) =>
              apply(
                (doc) => updateScenario(doc, { routing: { ...scenario.routing, adaptive } }),
                'Change routing',
              )
            }
          />
          <p className="hint">
            When on, a second route is planned against live crowd density and people who pay
            attention to it take a different way round. With it off, everybody follows the shortest
            path.
          </p>
          {scenario.routing.adaptive ? (
            <>
              <Slider
                label="How much congestion matters"
                min={0}
                max={1}
                step={0.05}
                value={scenario.routing.congestionWeight}
                format={(v) => `${(v * 100).toFixed(0)}%`}
                onChange={(congestionWeight) =>
                  apply(
                    (doc) =>
                      updateScenario(doc, { routing: { ...scenario.routing, congestionWeight } }),
                    'Change routing',
                  )
                }
              />
              <Slider
                label="Variety between people"
                min={0}
                max={1}
                step={0.05}
                value={scenario.routing.routeVariety}
                format={(v) => `${(v * 100).toFixed(0)}%`}
                onChange={(routeVariety) =>
                  apply(
                    (doc) =>
                      updateScenario(doc, { routing: { ...scenario.routing, routeVariety } }),
                    'Change routing',
                  )
                }
              />
            </>
          ) : null}
          <Slider
            label="Walking speed"
            min={0.5}
            max={1.5}
            step={0.05}
            value={scenario.speedFactor}
            format={(v) => `${(v * 100).toFixed(0)}% of normal`}
            onChange={(speedFactor) =>
              apply((doc) => updateScenario(doc, { speedFactor }), 'Change walking speed')
            }
          />
        </div>

        <div className="section">
          <div className="section-title">Evacuation</div>
          <Checkbox
            label="Evacuate partway through"
            checked={scenario.evacuationAtS !== null}
            onChange={(on) =>
              apply(
                (doc) =>
                  updateScenario(doc, {
                    evacuationAtS: on ? Math.round(scenario.durationS * 0.6) : null,
                  }),
                'Change evacuation',
              )
            }
          />
          {scenario.evacuationAtS !== null ? (
            <Field label="Alarm at">
              <NumberInput
                value={scenario.evacuationAtS}
                min={0}
                step={60}
                suffix="s"
                onCommit={(evacuationAtS) =>
                  apply((doc) => updateScenario(doc, { evacuationAtS }), 'Change evacuation')
                }
              />
            </Field>
          ) : null}
          <p className="hint">
            Everyone drops what they are doing and heads for the nearest exit by travel time, moving
            with more urgency than they were.
          </p>
        </div>
      </div>
    </>
  )
}
