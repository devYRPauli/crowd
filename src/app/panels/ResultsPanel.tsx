/**
 * What the run found.
 *
 * Ordered by what a planner does next: the findings first, because they are the
 * answer; then the numbers behind them; then the comparison against a saved
 * run, because "is this better?" is the real question; then the code
 * calculations, which are a cross-check on the simulation rather than an output
 * of it.
 */

import { useMemo, useState } from 'react'
import { useEditor } from '../../state/editorStore'
import { useSimulation } from '../../state/simulationStore'
import { deriveFindings } from '../../sim/metrics/findings'
import {
  computeCompliance,
  OCCUPANT_LOAD_FACTORS,
  type OccupancyId,
} from '../../core/analysis/compliance'
import { LOS_TABLES, type FacilityType } from '../../sim/metrics/los'
import { formatArea, formatDuration, formatNumber, formatPercent } from '../../core/model/units'
import { Checkbox, Field, NumberInput, Segmented, Select, Sparkline, Stat } from '../components/ui'
import { TrashIcon } from '../components/icons'
import { downloadText } from '../../core/document/storage'
import {
  reportFileName,
  seriesToCsv,
  toBrief,
  toCsv,
  toJsonBundle,
} from '../../core/analysis/report'
import type { RunSummary } from '../../sim/types'

const compare = (
  current: number,
  previous: number,
  lowerIsBetter = true,
): { text: string; tone: 'better' | 'worse' | 'same' } => {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) {
    return { text: '—', tone: 'same' }
  }
  const delta = current - previous
  const pct = (delta / previous) * 100
  if (Math.abs(pct) < 1) return { text: 'no change', tone: 'same' }
  const better = lowerIsBetter ? delta < 0 : delta > 0
  return {
    text: `${delta > 0 ? '+' : ''}${pct.toFixed(0)}% vs baseline`,
    tone: better ? 'better' : 'worse',
  }
}

const SummaryStats = ({ summary, baseline }: { summary: RunSummary; baseline?: RunSummary }) => (
  <div className="stat-grid">
    <Stat
      value={`${summary.completed}/${summary.totalPeople}`}
      label="Completed"
      delta={baseline ? compare(summary.completed, baseline.completed, false) : undefined}
    />
    <Stat
      value={formatDuration(summary.meanJourney)}
      label="Mean journey"
      delta={baseline ? compare(summary.meanJourney, baseline.meanJourney) : undefined}
    />
    <Stat
      value={formatDuration(summary.p95Journey)}
      label="95th percentile"
      delta={baseline ? compare(summary.p95Journey, baseline.p95Journey) : undefined}
    />
    <Stat
      value={formatDuration(summary.meanWait)}
      label="Mean queue wait"
      delta={baseline ? compare(summary.meanWait, baseline.meanWait) : undefined}
    />
    <Stat
      value={`${formatNumber(summary.peakDensity, 1)}/m²`}
      label="Peak density"
      delta={baseline ? compare(summary.peakDensity, baseline.peakDensity) : undefined}
    />
    <Stat
      value={formatDuration(summary.clearanceTime)}
      label="95% cleared by"
      delta={baseline ? compare(summary.clearanceTime, baseline.clearanceTime) : undefined}
    />
  </div>
)

const LosLegend = ({ facility }: { facility: FacilityType }) => (
  <div className="los-legend">
    {LOS_TABLES[facility].map((band) => (
      <div className="los-row" key={band.level}>
        <span className="los-swatch" style={{ background: band.color }} />
        <span className="los-level">{band.level}</span>
        <span className="los-desc" title={band.description}>
          {band.description}
        </span>
        <span className="los-value">
          {Number.isFinite(band.maxDensity) ? `≤${band.maxDensity.toFixed(2)}` : '>'}
        </span>
      </div>
    ))}
  </div>
)

const CompliancePanel = () => {
  const plan = useEditor((state) => state.document.plan)
  const scenario = useEditor((state) => state.document.scenario)
  const [occupancy, setOccupancy] = useState<OccupancyId>('assembly-tables')
  const [sprinklered, setSprinklered] = useState(false)
  const [minutes, setMinutes] = useState(8)

  const attendance = scenario.populations.reduce((sum, p) => sum + p.count, 0)
  const result = useMemo(
    () =>
      computeCompliance({
        plan,
        occupancy,
        sprinklered,
        plannedAttendance: attendance,
        targetEgressMinutes: minutes,
      }),
    [plan, occupancy, sprinklered, attendance, minutes],
  )

  return (
    <div className="section">
      <div className="section-title">Code check</div>
      <Field label="Use of the space">
        <Select
          value={occupancy}
          onChange={setOccupancy}
          options={OCCUPANT_LOAD_FACTORS.map((entry) => ({
            value: entry.id,
            label: `${entry.label} — ${entry.sqft} sq ft ${entry.basis}`,
          }))}
        />
      </Field>
      <div className="row">
        <Field label="Egress target">
          <NumberInput value={minutes} min={1} max={30} onCommit={setMinutes} suffix="min" />
        </Field>
        <div style={{ paddingBottom: 4 }}>
          <Checkbox label="Sprinklered" checked={sprinklered} onChange={setSprinklered} />
        </div>
      </div>

      <table className="table">
        <tbody>
          <tr>
            <td>Enclosed floor area</td>
            <td className="num">{formatArea(result.floorAreaSqm, 'metric')}</td>
          </tr>
          <tr>
            <td>Occupant load (IBC)</td>
            <td className="num">{result.calculatedOccupantLoad}</td>
          </tr>
          <tr>
            <td>Design load used</td>
            <td className="num">{result.designOccupantLoad}</td>
          </tr>
          <tr>
            <td>Exits required / marked</td>
            <td className="num">
              {result.exitsRequired} / {result.exitsProvided}
            </td>
          </tr>
          <tr>
            <td>Egress width required</td>
            <td className="num">{result.requiredWidthM.toFixed(2)} m</td>
          </tr>
          <tr>
            <td>Doorway width drawn</td>
            <td className="num">{result.totalExitWidthM.toFixed(2)} m</td>
          </tr>
          <tr>
            <td title="After subtracting a 150 mm boundary layer from each side">
              Effective width (SFPE)
            </td>
            <td className="num">{result.effectiveWidthM.toFixed(2)} m</td>
          </tr>
          <tr>
            <td>Hand-calculated egress</td>
            <td className="num">{formatDuration(result.hydraulicEgressSeconds)}</td>
          </tr>
          <tr>
            <td>Green Guide capacity</td>
            <td className="num">{result.greenGuideCapacity}</td>
          </tr>
        </tbody>
      </table>

      {result.issues.map((issue, index) => (
        <div
          key={index}
          className={`finding is-${issue.severity === 'fail' ? 'high' : issue.severity === 'warn' ? 'medium' : 'low'}`}
        >
          <div className="body">
            <div className="detail" style={{ marginTop: 0 }}>
              {issue.message}
            </div>
          </div>
        </div>
      ))}

      <p className="hint">
        Model-code indicative only. Local adoption and amendments vary, and approval rests with the
        authority having jurisdiction.
      </p>
    </div>
  )
}

const ExportSection = ({ onExportImage }: { onExportImage: () => void }) => {
  const document = useEditor((state) => state.document)
  const toast = useEditor((state) => state.toast)
  const summary = useSimulation((state) => state.summary)
  const series = useSimulation((state) => state.series)
  const totalPeople = useSimulation((state) => state.totalPeople)

  const findings = useMemo(
    () => (summary && series ? deriveFindings({ summary, series, totalPeople }) : []),
    [summary, series, totalPeople],
  )

  if (!summary || !series) return null
  const input = { document, summary, series, findings }

  const save = (extension: string, text: string, mime: string, label: string) => {
    downloadText(reportFileName(document, extension), text, mime)
    toast(`${label} downloaded.`, 'success')
  }

  return (
    <div className="section">
      <div className="section-title">Export</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <button className="btn" onClick={() => save('txt', toBrief(input), 'text/plain', 'Brief')}>
          Written brief
        </button>
        <button className="btn" onClick={onExportImage}>
          Image of the plan
        </button>
        <button className="btn" onClick={() => save('csv', toCsv(input), 'text/csv', 'Summary')}>
          Summary CSV
        </button>
        <button
          className="btn"
          onClick={() => save('series.csv', seriesToCsv(input), 'text/csv', 'Time series')}
        >
          Time series CSV
        </button>
      </div>
      <button
        className="btn"
        onClick={() => save('json', toJsonBundle(input), 'application/json', 'Report')}
      >
        Full report bundle (.json)
      </button>
      <p className="hint">
        The bundle carries the plan, the scenario and the results together, so opening it in CROWD
        restores exactly the run it describes.
      </p>
    </div>
  )
}

export const ResultsPanel = ({
  heatmapFacility,
  onHeatmapFacility,
  onExportImage,
}: {
  heatmapFacility: FacilityType
  onHeatmapFacility: (facility: FacilityType) => void
  onExportImage: () => void
}) => {
  const document = useEditor((state) => state.document)
  const setSelection = useEditor((state) => state.setSelection)
  const summary = useSimulation((state) => state.summary)
  const series = useSimulation((state) => state.series)
  const savedRuns = useSimulation((state) => state.savedRuns)
  const comparisonId = useSimulation((state) => state.comparisonId)
  const setComparison = useSimulation((state) => state.setComparison)
  const removeRun = useSimulation((state) => state.removeRun)
  const saveCurrentRun = useSimulation((state) => state.saveCurrentRun)
  const phase = useSimulation((state) => state.phase)
  const totalPeople = useSimulation((state) => state.totalPeople)
  const runDocument = useSimulation((state) => state.runDocument)

  const baseline = savedRuns.find((run) => run.id === comparisonId)

  // A run is kept across an edit on purpose — the whole point of the panel is
  // to read it while trying the change it suggests — but the code check below
  // recomputes from the live plan on every render, so the two halves of the
  // panel can be describing different venues. Identity is enough to notice:
  // every edit goes through a mutation that returns a new plan or scenario.
  const stale =
    runDocument !== null &&
    (document.plan !== runDocument.plan || document.scenario !== runDocument.scenario)

  const findings = useMemo(
    () => (summary && series ? deriveFindings({ summary, series, totalPeople }) : []),
    [summary, series, totalPeople],
  )

  const queueSeries = useMemo(
    () => (series ? Array.from(series.time, (t, i) => ({ x: t, y: series.queueTotal[i] })) : []),
    [series],
  )
  const densitySeries = useMemo(
    () => (series ? Array.from(series.time, (t, i) => ({ x: t, y: series.peakDensity[i] })) : []),
    [series],
  )
  const activeSeries = useMemo(
    () => (series ? Array.from(series.time, (t, i) => ({ x: t, y: series.active[i] })) : []),
    [series],
  )

  return (
    <>
      <div className="panel-header">
        <span className="panel-title">Results</span>
        {summary ? (
          <button
            className="btn is-ghost"
            onClick={() => saveCurrentRun(document.name || 'Run')}
            title="Keep this run to compare against"
          >
            Save as baseline
          </button>
        ) : null}
      </div>
      <div className="panel-body">
        {!summary ? (
          <div className="empty">
            {phase === 'running' || phase === 'preparing'
              ? 'Running — results appear when it finishes.'
              : 'No results yet. Press Run to rehearse this scenario.'}
          </div>
        ) : (
          <>
            {stale ? (
              <div className="section">
                <div className="finding is-medium">
                  <div className="body">
                    <div className="headline">The plan has changed since this run</div>
                    <div className="detail">
                      These figures were measured on the plan as it stood when Run was pressed. The
                      code check below is calculated from the plan as it is now, so the two answer
                      for different venues until this is run again.
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {findings.length > 0 ? (
              <div className="section">
                <div className="section-title">What happened</div>
                {findings.slice(0, 10).map((finding) => (
                  <div
                    key={finding.id}
                    className={`finding is-${finding.severity}`}
                    style={{ cursor: finding.targetId ? 'pointer' : 'default' }}
                    onClick={() =>
                      finding.targetId && setSelection([{ kind: 'service', id: finding.targetId }])
                    }
                  >
                    <div className="body">
                      <div className="headline">{finding.headline}</div>
                      {finding.detail ? <div className="detail">{finding.detail}</div> : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="section">
              <div className="section-title">
                <span>Summary</span>
                {baseline ? <span className="badge is-accent">vs {baseline.label}</span> : null}
              </div>
              <SummaryStats summary={summary} baseline={baseline?.summary} />
            </div>

            {summary.services.length > 0 ? (
              <div className="section">
                <div className="section-title">Service points</div>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Counter</th>
                      <th style={{ textAlign: 'right' }}>Served</th>
                      <th style={{ textAlign: 'right' }}>Mean wait</th>
                      <th style={{ textAlign: 'right' }}>Busy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.services.map((service) => (
                      <tr
                        key={service.id}
                        style={{ cursor: 'pointer' }}
                        onClick={() => setSelection([{ kind: 'service', id: service.id }])}
                      >
                        <td>{service.name}</td>
                        <td className="num">{service.served}</td>
                        <td className="num">{formatDuration(service.meanWait)}</td>
                        <td className="num">{formatPercent(service.utilisation)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {summary.areas.length > 0 ? (
              <div className="section">
                <div className="section-title">Measured areas</div>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Area</th>
                      <th style={{ textAlign: 'right' }}>Peak</th>
                      <th style={{ textAlign: 'right' }}>Peak density</th>
                      <th style={{ textAlign: 'right' }}>Worst</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.areas.map((area) => {
                      const band = LOS_TABLES.walkway.find((entry) => entry.level === area.worstLos)
                      return (
                        <tr
                          key={area.id}
                          style={{ cursor: 'pointer' }}
                          onClick={() => setSelection([{ kind: 'zone', id: area.id }])}
                        >
                          <td>{area.name}</td>
                          <td className="num">{area.peakOccupancy}</td>
                          <td className="num">{formatNumber(area.peakDensity, 2)}</td>
                          <td className="num" style={{ color: band?.color }}>
                            {area.worstLos}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {summary.areas.some((area) => area.secondsAtCrushRisk > 0) ? (
                  <p className="hint">
                    {summary.areas
                      .filter((area) => area.secondsAtCrushRisk > 0)
                      .map(
                        (area) =>
                          `${area.name} was at 4 people per m² or more for ${formatDuration(area.secondsAtCrushRisk)}.`,
                      )
                      .join(' ')}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="hint">
                Draw a measurement area to get numbers for one part of the venue — a doorway, a
                dance floor, the space in front of a stage.
              </p>
            )}

            <div className="section">
              <div className="section-title">People in the venue</div>
              <Sparkline series={activeSeries} label="People inside" />
              <div className="section-title">Queueing</div>
              <Sparkline series={queueSeries} color="var(--warn)" label="People queueing" />
              <div className="section-title">Peak density</div>
              <Sparkline series={densitySeries} color="var(--danger)" label="Peak density" />
            </div>

            <div className="section">
              <div className="section-title">Level of service</div>
              <Segmented
                value={heatmapFacility}
                onChange={onHeatmapFacility}
                options={[
                  { value: 'walkway', label: 'Walkway' },
                  { value: 'queue', label: 'Queue' },
                  { value: 'stair', label: 'Stair' },
                ]}
              />
              <LosLegend facility={heatmapFacility} />
              <table className="table">
                <tbody>
                  {Object.entries(summary.losShare).map(([level, share]) => (
                    <tr key={level}>
                      <td>Time at {level}</td>
                      <td className="num">{formatPercent(share)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="hint">
                Measured in person-seconds, so it reflects what people experienced rather than how
                much floor was busy.
              </p>
            </div>
          </>
        )}

        {savedRuns.length > 0 ? (
          <div className="section">
            <div className="section-title">Saved runs</div>
            <div className="list">
              {savedRuns.map((run) => (
                <div
                  key={run.id}
                  className={`list-row${run.id === comparisonId ? ' is-active' : ''}`}
                  onClick={() => setComparison(run.id === comparisonId ? null : run.id)}
                >
                  <span className="label">{run.label}</span>
                  <span className="meta">{formatDuration(run.summary.meanJourney)}</span>
                  <button
                    className="btn is-ghost is-icon"
                    title="Forget this run"
                    onClick={(event) => {
                      event.stopPropagation()
                      removeRun(run.id)
                    }}
                  >
                    <TrashIcon width={13} height={13} />
                  </button>
                </div>
              ))}
            </div>
            <p className="hint">
              Select a run to compare against. Runs share the same seed, so differences come from
              the layout rather than from luck.
            </p>
          </div>
        ) : null}

        <ExportSection onExportImage={onExportImage} />
        <CompliancePanel />
      </div>
    </>
  )
}
