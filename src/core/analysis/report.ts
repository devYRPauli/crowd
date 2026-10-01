/**
 * Exporting results.
 *
 * Three formats, for three audiences: a CSV of the per-run numbers for someone
 * who wants to do their own arithmetic, a JSON bundle that carries the plan and
 * scenario alongside the results so a run can be reproduced exactly, and a
 * plain-text brief for pasting into an email — which is, in practice, how most
 * of this gets shared.
 */

import type { CrowdDocument } from '../model/types'
import type { RunSummary } from '../../sim/types'
import type { Finding } from '../../sim/metrics/findings'
import { formatArea, formatDuration, formatLength } from '../model/units'
import { computeCompliance, type CodeCheckSettings, type ComplianceIssue } from './compliance'

export interface ReportInput {
  document: CrowdDocument
  summary: RunSummary
  findings: Finding[]
  series?: {
    time: Float32Array
    active: Float32Array
    completed: Float32Array
    meanSpeed: Float32Array
    peakDensity: Float32Array
    queueTotal: Float32Array
  }
  /** What the code check panel is set to, so the brief checks what the planner sees. */
  codeCheck: CodeCheckSettings
}

const csvEscape = (value: string): string =>
  /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value

const csvRow = (cells: Array<string | number>): string =>
  cells.map((cell) => csvEscape(String(cell))).join(',')

/** Per-run summary and per-counter detail, as one CSV. */
export const toCsv = ({ document, summary }: ReportInput): string => {
  const lines: string[] = []
  lines.push(csvRow(['CROWD run summary']))
  lines.push(csvRow(['Project', document.name]))
  lines.push(csvRow(['Scenario', document.scenario.name]))
  lines.push(csvRow(['Exported', new Date().toISOString()]))
  lines.push('')

  lines.push(csvRow(['Metric', 'Value', 'Units']))
  const metrics: Array<[string, number | string | null, string]> = [
    ['Run length', summary.durationS, 's'],
    ['Seed', summary.seed, ''],
    ['People simulated', summary.totalPeople, ''],
    ['People completed', summary.completed, ''],
    ['Mean journey time', summary.meanJourney, 's'],
    ['95th percentile journey time', summary.p95Journey, 's'],
    ['Mean queue wait', summary.meanWait, 's'],
    ['Longest queue wait', summary.maxWait, 's'],
    ['Mean time queueing per person', summary.meanQueueTime, 's'],
    ['95% cleared by', summary.clearanceTime, 's'],
    ['Walkable floor area', summary.walkableArea, 'm2'],
    ['Peak occupancy', summary.peakOccupancy, 'people'],
    ['Peak density', summary.peakDensity, 'persons/m2'],
  ]
  for (const [name, value, units] of metrics) {
    // A figure with nothing to measure is a blank cell, not a zero.
    lines.push(csvRow([name, typeof value === 'number' ? value.toFixed(3) : (value ?? ''), units]))
  }
  lines.push('')

  lines.push(csvRow(['Level of service', 'Share of person-seconds']))
  for (const [level, share] of Object.entries(summary.losShare)) {
    lines.push(csvRow([level, share.toFixed(4)]))
  }
  lines.push('')

  if (summary.services.length > 0) {
    lines.push(
      csvRow([
        'Service point',
        'Positions',
        'Served',
        'Mean wait (s)',
        'Longest wait (s)',
        'Mean service (s)',
        'Utilisation',
        'Longest queue',
        'Still waiting',
      ]),
    )
    for (const service of summary.services) {
      lines.push(
        csvRow([
          service.name,
          service.servers,
          service.served,
          service.meanWait?.toFixed(2) ?? '',
          service.maxWait.toFixed(2),
          service.meanService?.toFixed(2) ?? '',
          service.utilisation.toFixed(4),
          service.maxQueue,
          service.unserved,
        ]),
      )
    }
    lines.push('')
  }

  if (summary.areas.length > 0) {
    lines.push(
      csvRow([
        'Measured area',
        'Floor area (m2)',
        'Peak people',
        'Mean people',
        'Peak density',
        'Mean density',
        'Mean speed (m/s)',
        'Person-seconds',
        'Seconds at LOS E+',
        'Seconds at LOS F',
        'Seconds at 4+/m2',
        'Worst LOS',
      ]),
    )
    for (const area of summary.areas) {
      lines.push(
        csvRow([
          area.name,
          area.areaSqm.toFixed(2),
          area.peakOccupancy,
          area.meanOccupancy.toFixed(2),
          area.peakDensity.toFixed(3),
          area.meanDensity.toFixed(3),
          area.meanSpeed.toFixed(3),
          area.personSeconds.toFixed(1),
          area.secondsAtLosE.toFixed(1),
          area.secondsAtLosF.toFixed(1),
          area.secondsAtCrushRisk.toFixed(1),
          area.worstLos,
        ]),
      )
    }
    lines.push('')
  }

  if (summary.warnings.length > 0) {
    lines.push(csvRow(['Warnings']))
    for (const warning of summary.warnings) lines.push(csvRow([warning]))
  }

  return lines.join('\n')
}

/** The time series, one row per recorded frame. */
export const seriesToCsv = (input: ReportInput): string => {
  const series = input.series
  if (!series) return ''
  const lines = [
    csvRow([
      'time_s',
      'people_inside',
      'people_completed',
      'mean_speed_ms',
      'peak_density_m2',
      'people_queueing',
    ]),
  ]
  for (let i = 0; i < series.time.length; i++) {
    lines.push(
      csvRow([
        series.time[i].toFixed(2),
        series.active[i],
        series.completed[i],
        series.meanSpeed[i].toFixed(3),
        series.peakDensity[i].toFixed(3),
        series.queueTotal[i],
      ]),
    )
  }
  return lines.join('\n')
}

/**
 * Everything needed to reproduce and review the run: the document it came from,
 * the results, and the findings. Opening this file restores the plan exactly.
 */
export const toJsonBundle = (input: ReportInput): string =>
  JSON.stringify(
    {
      format: 'crowd-report',
      version: 1,
      exportedAt: new Date().toISOString(),
      document: input.document,
      summary: input.summary,
      findings: input.findings,
      series: input.series
        ? {
            time: Array.from(input.series.time),
            active: Array.from(input.series.active),
            completed: Array.from(input.series.completed),
            meanSpeed: Array.from(input.series.meanSpeed),
            peakDensity: Array.from(input.series.peakDensity),
            queueTotal: Array.from(input.series.queueTotal),
          }
        : null,
    },
    null,
    2,
  )

const ISSUE_LEAD: Record<ComplianceIssue['severity'], string> = {
  fail: 'Fails: ',
  warn: 'Check: ',
  info: '',
}

/** A brief someone can read without opening the app. */
export const toBrief = (input: ReportInput): string => {
  const { document, summary, findings } = input
  const compliance = computeCompliance({
    ...input.codeCheck,
    plan: document.plan,
    plannedAttendance: document.scenario.populations.reduce((sum, p) => sum + p.count, 0),
    units: document.settings.units,
  })
  const units = document.settings.units

  const lines: string[] = []
  lines.push(`${document.name} — ${document.scenario.name}`)
  lines.push('='.repeat(Math.min(72, document.name.length + document.scenario.name.length + 3)))
  lines.push('')
  lines.push(
    `${summary.totalPeople} people over ${formatDuration(summary.durationS)}, seed ${summary.seed}.`,
  )
  lines.push(
    `${summary.completed} of them left. Mean journey ${formatDuration(summary.meanJourney)}, ` +
      `with one in twenty taking ${formatDuration(summary.p95Journey)}.`,
  )
  lines.push(
    `Peak density ${summary.peakDensity.toFixed(1)} persons/m² across ${formatArea(summary.walkableArea, units)} of walkable floor.`,
  )
  lines.push('')

  if (findings.length > 0) {
    lines.push('What to look at')
    lines.push('-'.repeat(15))
    for (const finding of findings.slice(0, 8)) {
      lines.push(`• ${finding.headline}`)
      if (finding.detail) lines.push(`  ${finding.detail}`)
    }
    lines.push('')
  }

  if (summary.services.length > 0) {
    lines.push('Service points')
    lines.push('-'.repeat(14))
    for (const service of summary.services) {
      lines.push(
        `• ${service.name}: ${service.served} served across ${service.servers} ` +
          `${service.servers === 1 ? 'position' : 'positions'}, mean wait ${formatDuration(service.meanWait)}, ` +
          `longest ${formatDuration(service.maxWait)}, busy ${(service.utilisation * 100).toFixed(0)}% of the time.`,
      )
    }
    lines.push('')
  }

  if (summary.areas.length > 0) {
    lines.push('Measured areas')
    lines.push('-'.repeat(14))
    for (const area of summary.areas) {
      lines.push(
        `• ${area.name} (${formatArea(area.areaSqm, units)}): peaked at ${area.peakOccupancy} people, ` +
          `${area.peakDensity.toFixed(1)} per m², worst level of service ${area.worstLos}.` +
          (area.secondsAtCrushRisk > 0
            ? ` At or above 4 per m² for ${formatDuration(area.secondsAtCrushRisk)}.`
            : ''),
      )
    }
    lines.push('')
  }

  lines.push('Code check (model-code indicative)')
  lines.push('-'.repeat(33))
  lines.push(
    `• Occupant load for ${compliance.occupancyLabel.toLowerCase()}: ${compliance.calculatedOccupantLoad}.`,
  )
  lines.push(
    `• Exits: ${compliance.exitsProvided} marked, ${compliance.exitsRequired} required for ${compliance.designOccupantLoad} occupants.`,
  )
  lines.push(
    `• Egress width: ${formatLength(compliance.totalExitWidthM, units)} drawn against ${formatLength(compliance.requiredWidthM, units)} required, ${input.codeCheck.sprinklered ? 'sprinklered' : 'not sprinklered'}.`,
  )
  lines.push(
    `• SFPE hand calculation: ${formatDuration(compliance.hydraulicEgressSeconds)} to clear, using ${formatLength(compliance.effectiveWidthM, units)} of effective width.`,
  )
  lines.push(
    `• Green Guide capacity: ${compliance.greenGuideCapacity} people in ${input.codeCheck.targetEgressMinutes} minutes.`,
  )
  // What the panel says under its figures. Without it a venue that failed by a
  // fraction of an inch read "1.83 m drawn against 1.83 m required", and
  // nothing in the brief said it had failed.
  for (const issue of compliance.issues)
    lines.push(`• ${ISSUE_LEAD[issue.severity]}${issue.message}`)
  lines.push('')
  lines.push(
    'Local adoption and amendments vary and approval rests with the authority having jurisdiction. ' +
      'This is an exploratory planning model, not a safety certification.',
  )
  lines.push('')
  lines.push(`Generated by CROWD on ${new Date().toISOString().slice(0, 10)}.`)

  return lines.join('\n')
}

export const reportFileName = (document: CrowdDocument, extension: string): string => {
  const slug =
    document.name
      .replace(/[^\w\- ]+/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .toLowerCase() || 'venue'
  return `${slug}-report.${extension}`
}
