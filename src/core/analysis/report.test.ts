import { describe, expect, it } from 'vitest'
import { reportFileName, seriesToCsv, toBrief, toCsv, toJsonBundle } from './report'
import { getTemplate } from '../../library/templates'
import { Simulation } from '../../sim/engine'
import { deriveFindings } from '../../sim/metrics/findings'
import { parseDocument } from '../document/serialize'

const runOnce = () => {
  const doc = getTemplate('coffee-bar')!.build()
  const scenario = {
    ...doc.scenario,
    durationS: 600,
    populations: doc.scenario.populations.map((p) => ({
      ...p,
      count: 16,
      arrival: { ...p.arrival, kind: 'uniform' as const, startS: 0, windowS: 120 },
    })),
  }
  const sim = new Simulation(doc.plan, scenario)
  const time: number[] = []
  const active: number[] = []
  const completed: number[] = []
  const meanSpeed: number[] = []
  const peakDensity: number[] = []
  const queueTotal: number[] = []
  for (let i = 0; i < 3000 && !sim.isFinished; i++) {
    sim.step(0.2)
    if (i % 25 === 0) {
      const stats = sim.stats()
      time.push(stats.time)
      active.push(stats.active)
      completed.push(stats.completed)
      meanSpeed.push(stats.meanSpeed)
      peakDensity.push(stats.peakDensity)
      queueTotal.push(stats.queueLengths.reduce((sum, q) => sum + q.waiting, 0))
    }
  }
  const series = {
    time: Float32Array.from(time),
    active: Float32Array.from(active),
    completed: Float32Array.from(completed),
    meanSpeed: Float32Array.from(meanSpeed),
    peakDensity: Float32Array.from(peakDensity),
    queueTotal: Float32Array.from(queueTotal),
  }
  const summary = sim.summary()
  return {
    document: { ...doc, scenario },
    summary,
    series,
    findings: deriveFindings({ summary, series, totalPeople: 16 }),
  }
}

describe('report export', () => {
  const input = runOnce()

  it('writes a summary CSV with the headline numbers', () => {
    const csv = toCsv(input)
    expect(csv).toContain('Mean journey time')
    expect(csv).toContain('Peak density')
    expect(csv).toContain('Coffee bar')
    // Every row must have the same shape as its header block.
    for (const line of csv.split('\n')) {
      expect(line.split(',').length).toBeLessThan(12)
    }
  })

  it('escapes values containing commas and quotes', () => {
    const tricky = {
      ...input,
      document: { ...input.document, name: 'Bar, "main" room' },
    }
    const csv = toCsv(tricky)
    expect(csv).toContain('"Bar, ""main"" room"')
  })

  it('writes one time-series row per recorded frame', () => {
    const csv = seriesToCsv(input)
    const rows = csv.split('\n')
    expect(rows[0]).toContain('time_s')
    expect(rows).toHaveLength(input.series.time.length + 1)
  })

  it('produces a JSON bundle the app can reopen', () => {
    const bundle = JSON.parse(toJsonBundle(input))
    expect(bundle.format).toBe('crowd-report')
    const reloaded = parseDocument(bundle.document)
    expect(reloaded.warnings).toEqual([])
    expect(reloaded.document.plan.walls).toHaveLength(input.document.plan.walls.length)
    expect(bundle.summary.completed).toBe(input.summary.completed)
    expect(bundle.series.time).toHaveLength(input.series.time.length)
  })

  it('writes a readable brief', () => {
    const brief = toBrief(input)
    expect(brief).toContain('Coffee bar')
    expect(brief).toContain('Service points')
    expect(brief).toContain('Code check')
    expect(brief).toContain('not a safety certification')
    // No placeholder or NaN should ever reach a shared document.
    expect(brief).not.toMatch(/NaN|undefined|Infinity/)
  })

  it('names files safely', () => {
    expect(reportFileName({ ...input.document, name: 'Puck Building / 3rd floor!' }, 'csv')).toBe(
      'puck-building-3rd-floor-report.csv',
    )
    expect(reportFileName({ ...input.document, name: '' }, 'json')).toBe('venue-report.json')
  })
})
