/**
 * Turning a run into findings.
 *
 * A heat map tells you where the red is; it does not tell you what to do. These
 * detectors read the summary and the time series and state the problem in the
 * terms the user is working in — which counter, how long the queue got, how
 * long the room held a failing level of service — ranked so the worst thing is
 * first.
 *
 * Every threshold here is a judgement, so each finding carries the number it
 * fired on. A planner can disagree with the threshold and still use the number.
 */

import type { RunSummary } from '../types'
import { CROWD_SAFETY, WALKWAY_LOS } from './los'
import { formatDuration } from '../../core/model/units'

export type FindingSeverity = 'high' | 'medium' | 'low' | 'good'

export interface Finding {
  id: string
  severity: FindingSeverity
  headline: string
  detail: string
  /** Plan object the finding is about, so the UI can select it. */
  targetId?: string
}

export interface FindingInput {
  summary: RunSummary
  series: {
    time: Float32Array
    active: Float32Array
    completed: Float32Array
    meanSpeed: Float32Array
    peakDensity: Float32Array
    queueTotal: Float32Array
  }
  /** Total people the scenario asked for. */
  totalPeople: number
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2, good: 3 }

/**
 * Where a walkway tips from E into F, read from the table rather than copied
 * out of it. The heat map colours a cell through the same table and the engine
 * counts a measured area's LOS-F seconds through it, so a rounded copy here put
 * a sliver of densities in the position of producing a venue-wide "level of
 * service F" line beside a zone that reported nothing and a cell coloured E.
 */
const LOS_F_FROM = WALKWAY_LOS[4].maxDensity

/**
 * The density the safety overlay warns on, read from the same constant the
 * engine counts a measured area's crush seconds with (engine.ts:1977). It was
 * a bare 4 here, which is the LOS-F copy one row down in a different disguise:
 * two detectors reporting the same band from two numbers that only happened to
 * agree, and a headline stating one of them in prose.
 */
const CRUSH_FROM = CROWD_SAFETY.warnDensity

/** Seconds the series spent at or above a threshold. */
const timeAbove = (time: Float32Array, values: Float32Array, threshold: number): number => {
  let total = 0
  for (let i = 1; i < values.length; i++) {
    if (values[i] >= threshold) total += time[i] - time[i - 1]
  }
  return total
}

const peakOf = (values: Float32Array): { value: number; index: number } => {
  let value = -Infinity
  let index = 0
  for (let i = 0; i < values.length; i++) {
    if (values[i] > value) {
      value = values[i]
      index = i
    }
  }
  return { value: Number.isFinite(value) ? value : 0, index }
}

export const deriveFindings = ({ summary, series, totalPeople }: FindingInput): Finding[] => {
  const findings: Finding[] = []

  // --- service points ------------------------------------------------------
  for (const service of summary.services) {
    if (service.unserved > 0) {
      findings.push({
        id: `unserved-${service.id}`,
        severity: 'high',
        headline: `${service.name} never cleared its queue`,
        detail: `${service.unserved} ${service.unserved === 1 ? 'person was' : 'people were'} still waiting when the run ended, after serving ${service.served}. The counter cannot keep up with this arrival pattern.`,
        targetId: service.id,
      })
    }

    if (service.meanWait > 300) {
      findings.push({
        id: `wait-${service.id}`,
        severity: service.meanWait > 600 ? 'high' : 'medium',
        headline: `${service.name} kept people waiting ${formatDuration(service.meanWait)} on average`,
        detail: `The longest wait was ${formatDuration(service.maxWait)}, and the queue peaked at ${service.maxQueue} people. Mean service time is ${service.meanService.toFixed(0)} s across ${service.servers} ${service.servers === 1 ? 'position' : 'positions'}.`,
        targetId: service.id,
      })
    } else if (service.meanWait > 90) {
      findings.push({
        id: `wait-${service.id}`,
        severity: 'low',
        headline: `${service.name} averaged a ${formatDuration(service.meanWait)} wait`,
        detail: `Longest ${formatDuration(service.maxWait)}, queue peaked at ${service.maxQueue}. Comfortable for a bar; long for a registration desk.`,
        targetId: service.id,
      })
    }

    if (service.utilisation > 0.85 && service.served > 0) {
      findings.push({
        id: `util-${service.id}`,
        severity: service.utilisation > 0.95 ? 'high' : 'medium',
        headline: `${service.name} ran at ${(service.utilisation * 100).toFixed(0)}% utilisation`,
        detail:
          'Above about 85% a queue stops recovering between arrivals and waits grow quickly. Adding one position here is usually the cheapest change worth testing.',
        targetId: service.id,
      })
    } else if (service.served > 0 && service.utilisation < 0.25) {
      findings.push({
        id: `idle-${service.id}`,
        severity: 'low',
        headline: `${service.name} was idle ${((1 - service.utilisation) * 100).toFixed(0)}% of the time`,
        detail: `It served ${service.served} ${service.served === 1 ? 'person' : 'people'} with ${service.servers} ${service.servers === 1 ? 'position' : 'positions'}. Staff could be moved to a busier counter.`,
        targetId: service.id,
      })
    }
  }

  // --- density -------------------------------------------------------------
  const crushTime = timeAbove(series.time, series.peakDensity, CRUSH_FROM)
  const failTime = timeAbove(series.time, series.peakDensity, LOS_F_FROM)
  if (crushTime > 20) {
    findings.push({
      id: 'density-crush',
      severity: 'high',
      headline: `Somewhere in the venue held ${CRUSH_FROM} people per m² or more for ${formatDuration(crushTime)}`,
      detail: `Peak density reached ${summary.peakDensity.toFixed(1)} per m². This is the density band where stewarding is normally planned and where crowd pressure becomes a safety concern, not just a comfort one.`,
    })
  } else if (failTime > 60) {
    findings.push({
      id: 'density-fail',
      severity: 'medium',
      headline: `The busiest area sat at level of service F for ${formatDuration(failTime)}`,
      detail: `Peak density was ${summary.peakDensity.toFixed(1)} per m². Above ${LOS_F_FROM.toFixed(2)} per m² on a walkway people cannot choose their own speed and reverse flow stops.`,
    })
  }

  const losF = summary.losShare.F ?? 0
  const losE = summary.losShare.E ?? 0
  if (losF + losE > 0.2) {
    findings.push({
      id: 'los-share',
      severity: losF > 0.15 ? 'medium' : 'low',
      headline: `${((losF + losE) * 100).toFixed(0)}% of time on the floor was spent at level of service E or F`,
      detail:
        'Measured as a share of person-seconds, not of floor area, so it reflects what people experienced rather than how much of the room was busy.',
    })
  }

  // --- measured areas ------------------------------------------------------
  for (const area of summary.areas) {
    if (area.secondsAtCrushRisk > 10) {
      findings.push({
        id: `area-crush-${area.id}`,
        severity: 'high',
        headline: `${area.name} held ${CRUSH_FROM} people per m² or more for ${formatDuration(area.secondsAtCrushRisk)}`,
        detail: `It peaked at ${area.peakDensity.toFixed(1)} per m² with ${area.peakOccupancy} people in ${area.areaSqm.toFixed(0)} m². This is the density band where stewarding is normally planned.`,
        targetId: area.id,
      })
    } else if (area.secondsAtLosF > 60) {
      findings.push({
        id: `area-los-${area.id}`,
        severity: 'medium',
        headline: `${area.name} sat at level of service F for ${formatDuration(area.secondsAtLosF)}`,
        detail: `Peak ${area.peakDensity.toFixed(1)} per m², and people inside averaged ${area.meanSpeed.toFixed(2)} m/s against a free-flow speed of about 1.34.`,
        targetId: area.id,
      })
    }
  }

  // --- flow ----------------------------------------------------------------
  const queuePeak = peakOf(series.queueTotal)
  if (queuePeak.value >= 20) {
    findings.push({
      id: 'queue-peak',
      severity: queuePeak.value >= 40 ? 'medium' : 'low',
      headline: `${queuePeak.value.toFixed(0)} people were queueing at once`,
      detail: `The peak came at ${formatDuration(series.time[queuePeak.index] ?? 0)} into the run. Check that the queue has somewhere to go that does not block a walkway.`,
    })
  }

  if (summary.completed < summary.totalPeople) {
    const stranded = summary.totalPeople - summary.completed
    findings.push({
      id: 'incomplete',
      severity: stranded > summary.totalPeople * 0.1 ? 'high' : 'medium',
      headline: `${stranded} of ${summary.totalPeople} people had not left when the run ended`,
      detail: `The run covered ${formatDuration(summary.durationS)}. Either the venue cannot clear this many people in that time, or the run is too short to show the whole picture.`,
    })
  }

  if (summary.totalPeople < totalPeople) {
    findings.push({
      id: 'capped',
      severity: 'medium',
      headline: `The run was capped at ${summary.totalPeople} of ${totalPeople} people`,
      detail: 'Reduce the population, or split the scenario, to see the whole crowd.',
    })
  }

  // --- journeys ------------------------------------------------------------
  if (summary.p95Journey > 0 && summary.meanJourney > 0) {
    const spread = summary.p95Journey / summary.meanJourney
    if (spread > 2.2) {
      findings.push({
        id: 'journey-spread',
        severity: 'low',
        headline: 'Some people had a much worse time than the average',
        detail: `The mean journey was ${formatDuration(summary.meanJourney)} but one in twenty took ${formatDuration(summary.p95Journey)} — ${spread.toFixed(1)} times longer. An average alone would hide that.`,
      })
    }
  }

  summary.warnings.forEach((warning, index) => {
    findings.push({
      // Position, not text: the id was a 24-character slice of the warning, and
      // the list is keyed on it, so two counters whose names agreed that far
      // rendered as one finding. The one that vanished was the one nobody fixed.
      id: `warning-${index}`,
      severity: 'medium',
      headline: warning,
      detail: '',
    })
  })

  if (findings.length === 0 && summary.completed > 0) {
    findings.push({
      id: 'all-clear',
      severity: 'good',
      headline: 'Nothing worth flagging',
      detail: `Everybody got through: mean journey ${formatDuration(summary.meanJourney)}, peak density ${summary.peakDensity.toFixed(1)} per m², and no counter ran hot. Try a busier arrival pattern to find the limit.`,
    })
  }

  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}
