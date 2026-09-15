import { describe, expect, it } from 'vitest'
import { deriveFindings } from './findings'
import type { Finding, FindingInput } from './findings'
import { losFor } from './los'
import type { AreaSummary, RunSummary, ServiceSummary } from '../types'

type Series = FindingInput['series']

/** Seconds between samples in the fixtures, matching how the app records a run. */
const SAMPLE_S = 10
const SAMPLES = 61

/** A counter nobody had to wait at. Overrides turn one thing bad at a time. */
const serviceOf = (over: Partial<ServiceSummary> = {}): ServiceSummary => ({
  id: 'svc-bar',
  name: 'Coffee bar',
  servers: 2,
  served: 120,
  meanWait: 15,
  maxWait: 40,
  meanService: 25,
  utilisation: 0.5,
  maxQueue: 3,
  unserved: 0,
  ...over,
})

const areaOf = (over: Partial<AreaSummary> = {}): AreaSummary => ({
  id: 'zone-foyer',
  name: 'Foyer',
  areaSqm: 120,
  peakOccupancy: 40,
  meanOccupancy: 12,
  peakDensity: 0.4,
  meanDensity: 0.1,
  meanSpeed: 1.2,
  personSeconds: 7200,
  secondsAtLosE: 0,
  secondsAtLosF: 0,
  secondsAtCrushRisk: 0,
  worstLos: 'B',
  ...over,
})

/** A run in which nothing went wrong, so any finding comes from the override. */
const summaryOf = (over: Partial<RunSummary> = {}): RunSummary => ({
  durationS: 600,
  seed: 7,
  totalPeople: 100,
  completed: 100,
  meanJourney: 180,
  p95Journey: 300,
  meanWait: 15,
  maxWait: 40,
  meanQueueTime: 10,
  clearanceTime: 480,
  walkableArea: 400,
  peakOccupancy: 40,
  peakDensity: 0.9,
  losShare: { A: 0.8, B: 0.15, C: 0.05 },
  services: [],
  areas: [],
  warnings: [],
  ...over,
})

const seriesOf = (over: Partial<Series> = {}): Series => {
  const time = over.time ?? Float32Array.from({ length: SAMPLES }, (_, i) => i * SAMPLE_S)
  const flat = () => new Float32Array(time.length)
  return {
    time,
    active: flat(),
    completed: flat(),
    meanSpeed: flat(),
    peakDensity: flat(),
    queueTotal: flat(),
    ...over,
  }
}

/**
 * A channel that sits at `value` for `seconds` and at zero afterwards. The
 * detector credits each sample with the interval that ended at it, so the value
 * has to start at the second sample to buy any time at all — see the "spike in
 * the first frame" test below.
 */
const heldFor = (value: number, seconds: number): Float32Array => {
  const channel = new Float32Array(SAMPLES)
  for (let i = 1; i <= Math.round(seconds / SAMPLE_S); i++) channel[i] = value
  return channel
}

const run = (summary: RunSummary, series: Series = seriesOf(), totalPeople?: number): Finding[] =>
  deriveFindings({ summary, series, totalPeople: totalPeople ?? summary.totalPeople })

const idsOf = (findings: Finding[]): string[] => findings.map((finding) => finding.id)

const expectFinding = (findings: Finding[], id: string): Finding => {
  const found = findings.find((finding) => finding.id === id)
  expect(
    found,
    `expected a "${id}" finding; got ${idsOf(findings).join(', ') || 'none'}`,
  ).toBeDefined()
  return found as Finding
}

describe('service point findings', () => {
  it('names the counter and carries how many people were left waiting', () => {
    const findings = run(
      summaryOf({
        services: [serviceOf({ id: 'svc-reg', name: 'Registration', unserved: 7, served: 42 })],
      }),
    )
    const finding = expectFinding(findings, 'unserved-svc-reg')
    expect(finding.severity).toBe('high')
    expect(finding.headline).toBe('Registration never cleared its queue')
    expect(finding.detail).toContain('7 people were still waiting')
    expect(finding.detail).toContain('after serving 42')
    // The UI selects the object a finding is about, so it has to carry its id.
    expect(finding.targetId).toBe('svc-reg')
  })

  it('says "1 person was" rather than "1 people were"', () => {
    const findings = run(summaryOf({ services: [serviceOf({ unserved: 1 })] }))
    expect(expectFinding(findings, 'unserved-svc-bar').detail).toContain(
      '1 person was still waiting',
    )
  })

  it('carries the mean wait, the longest wait and the peak queue', () => {
    const findings = run(
      summaryOf({
        services: [
          serviceOf({ meanWait: 420, maxWait: 905, maxQueue: 22, meanService: 25, servers: 2 }),
        ],
      }),
    )
    const finding = expectFinding(findings, 'wait-svc-bar')
    expect(finding.severity).toBe('medium')
    expect(finding.headline).toBe('Coffee bar kept people waiting 7 min on average')
    expect(finding.detail).toContain('longest wait was 15 min 5 s')
    expect(finding.detail).toContain('queue peaked at 22 people')
    expect(finding.detail).toContain('25 s across 2 positions')
  })

  it('escalates a ten-minute mean wait to high', () => {
    const findings = run(summaryOf({ services: [serviceOf({ meanWait: 700 })] }))
    const finding = expectFinding(findings, 'wait-svc-bar')
    expect(finding.severity).toBe('high')
    expect(finding.headline).toContain('11 min 40 s')
  })

  it('reports a two-minute wait as a note, under the same id as the serious one', () => {
    const findings = run(
      summaryOf({ services: [serviceOf({ meanWait: 120, maxWait: 300, maxQueue: 9 })] }),
    )
    const finding = expectFinding(findings, 'wait-svc-bar')
    expect(finding.severity).toBe('low')
    expect(finding.headline).toBe('Coffee bar averaged a 2 min wait')
    expect(finding.detail).toContain('Longest 5 min, queue peaked at 9')
    // One counter must never produce two wait findings: the id is a React key.
    expect(idsOf(findings).filter((id) => id.startsWith('wait-'))).toHaveLength(1)
  })

  it('leaves a 90 s wait alone and flags 91 s', () => {
    expect(idsOf(run(summaryOf({ services: [serviceOf({ meanWait: 90 })] })))).not.toContain(
      'wait-svc-bar',
    )
    expect(
      expectFinding(run(summaryOf({ services: [serviceOf({ meanWait: 91 })] })), 'wait-svc-bar')
        .headline,
    ).toContain('1 min 31 s')
  })

  it('quotes the utilisation it fired on and escalates past 95%', () => {
    const hot = expectFinding(
      run(summaryOf({ services: [serviceOf({ utilisation: 0.9 })] })),
      'util-svc-bar',
    )
    expect(hot.severity).toBe('medium')
    expect(hot.headline).toBe('Coffee bar ran at 90% utilisation')

    const hotter = expectFinding(
      run(summaryOf({ services: [serviceOf({ utilisation: 0.96 })] })),
      'util-svc-bar',
    )
    expect(hotter.severity).toBe('high')
    expect(hotter.headline).toContain('96%')
  })

  it('says nothing about a counter sitting exactly on the 85% threshold', () => {
    const findings = run(summaryOf({ services: [serviceOf({ utilisation: 0.85 })] }))
    expect(idsOf(findings)).toEqual(['all-clear'])
  })

  it('will not call a counter busy or idle when it served nobody', () => {
    // A rate with no throughput behind it is a fabricated number, not a finding.
    const busy = run(summaryOf({ services: [serviceOf({ served: 0, utilisation: 0.99 })] }))
    const quiet = run(summaryOf({ services: [serviceOf({ served: 0, utilisation: 0.01 })] }))
    for (const findings of [busy, quiet]) {
      expect(
        idsOf(findings).filter((id) => id.startsWith('util-') || id.startsWith('idle-')),
      ).toEqual([])
    }
  })

  it('reports an idle counter with the share of time it was idle', () => {
    const findings = run(
      summaryOf({ services: [serviceOf({ utilisation: 0.1, served: 8, servers: 3 })] }),
    )
    const finding = expectFinding(findings, 'idle-svc-bar')
    expect(finding.severity).toBe('low')
    expect(finding.headline).toBe('Coffee bar was idle 90% of the time')
    expect(finding.detail).toContain('served 8 people with 3 positions')
    expect(finding.targetId).toBe('svc-bar')
  })

  it('reports the wait and the utilisation of one hot counter separately', () => {
    const findings = run(summaryOf({ services: [serviceOf({ meanWait: 400, utilisation: 0.92 })] }))
    expect(idsOf(findings)).toEqual(expect.arrayContaining(['wait-svc-bar', 'util-svc-bar']))
    for (const finding of findings) expect(finding.targetId).toBe('svc-bar')
  })

  it('keeps findings from different counters apart', () => {
    const findings = run(
      summaryOf({
        services: [
          serviceOf({ id: 'svc-a', name: 'Bar A', unserved: 2 }),
          serviceOf({ id: 'svc-b', name: 'Bar B', utilisation: 0.1, served: 4 }),
        ],
      }),
    )
    expect(expectFinding(findings, 'unserved-svc-a').headline).toContain('Bar A')
    expect(expectFinding(findings, 'idle-svc-b').headline).toContain('Bar B')
  })
})

describe('density findings', () => {
  it('reports crush-band time with the duration and the peak it fired on', () => {
    const findings = run(
      summaryOf({ peakDensity: 4.6 }),
      seriesOf({ peakDensity: heldFor(4.5, 30) }),
    )
    const finding = expectFinding(findings, 'density-crush')
    expect(finding.severity).toBe('high')
    expect(finding.headline).toBe('Somewhere in the venue held 4 people per m² or more for 30 s')
    expect(finding.detail).toContain('4.6 per m²')
    // Venue-wide: there is no single object to select.
    expect(finding.targetId).toBeUndefined()
  })

  it('needs more than 20 s in the crush band, and falls back to level of service F', () => {
    const peakDensity = new Float32Array(SAMPLES)
    for (let i = 1; i <= 2; i++) peakDensity[i] = 4.5 // 20 s, exactly on the threshold
    for (let i = 3; i <= 9; i++) peakDensity[i] = 2.5 // 70 s more above 2.17
    const findings = run(summaryOf({ peakDensity: 4.5 }), seriesOf({ peakDensity }))
    expect(idsOf(findings)).not.toContain('density-crush')
    const finding = expectFinding(findings, 'density-fail')
    expect(finding.severity).toBe('medium')
    expect(finding.headline).toBe('The busiest area sat at level of service F for 1 min 30 s')
  })

  it('reports crush or failure but never both', () => {
    const findings = run(
      summaryOf({ peakDensity: 5.2 }),
      seriesOf({ peakDensity: heldFor(5, 300) }),
    )
    expect(idsOf(findings).filter((id) => id.startsWith('density-'))).toEqual(['density-crush'])
  })

  it('does not see a spike that only exists in the first frame', () => {
    // Each sample is credited with the interval that ended at it, so sample 0
    // has no interval behind it. Harmless for a recorded run, which starts
    // empty, but it means a fixture has to hold the value for a sample.
    const peakDensity = new Float32Array(SAMPLES)
    peakDensity[0] = 6
    expect(idsOf(run(summaryOf(), seriesOf({ peakDensity })))).toEqual(['all-clear'])
  })

  it('fires level of service F slightly below the Fruin walkway boundary', () => {
    // SUSPECTED BUG: findings.ts hardcodes 2.17 while the table this claim
    // comes from puts the E/F boundary at 1/0.46 = 2.1739. AGENTS.md says the
    // numbers that define a rule are shared, not copied and rounded; densities
    // in this sliver are called F here and E by the legend on screen.
    expect(losFor(2.172, 'walkway').level).toBe('E')
    const findings = run(
      summaryOf({ peakDensity: 2.172 }),
      seriesOf({ peakDensity: heldFor(2.172, 120) }),
    )
    expect(expectFinding(findings, 'density-fail').headline).toContain('level of service F')
  })
})

describe('level of service share', () => {
  it('quotes the combined E and F share as a share of person-seconds', () => {
    const findings = run(summaryOf({ losShare: { E: 0.2, F: 0.05 } }))
    const finding = expectFinding(findings, 'los-share')
    expect(finding.severity).toBe('low')
    expect(finding.headline).toBe('25% of time on the floor was spent at level of service E or F')
    expect(finding.detail).toContain('person-seconds')
  })

  it('escalates when F alone is over 15%', () => {
    const findings = run(summaryOf({ losShare: { E: 0.05, F: 0.2 } }))
    expect(expectFinding(findings, 'los-share').severity).toBe('medium')
  })

  it('leaves a run sitting exactly on 20% alone', () => {
    expect(idsOf(run(summaryOf({ losShare: { E: 0.2 } })))).not.toContain('los-share')
  })

  it('treats a missing band as zero rather than as a failure', () => {
    expect(idsOf(run(summaryOf({ losShare: {} })))).toEqual(['all-clear'])
  })
})

describe('measured area findings', () => {
  it('names the area and carries its peak, its headcount and its floor area', () => {
    const findings = run(
      summaryOf({
        areas: [
          areaOf({
            id: 'zone-gate',
            name: 'Gate line',
            secondsAtCrushRisk: 15,
            peakDensity: 4.42,
            peakOccupancy: 61,
            areaSqm: 13.8,
          }),
        ],
      }),
    )
    const finding = expectFinding(findings, 'area-crush-zone-gate')
    expect(finding.severity).toBe('high')
    expect(finding.headline).toBe('Gate line held 4 people per m² or more for 15 s')
    expect(finding.detail).toContain('peaked at 4.4 per m² with 61 people in 14 m²')
    // ResultsPanel selects this id as { kind: 'service' }, but an area is a zone.
    expect(finding.targetId).toBe('zone-gate')
  })

  it('reports a long stretch at level of service F with the speed people managed', () => {
    const findings = run(
      summaryOf({
        areas: [
          areaOf({ secondsAtCrushRisk: 10, secondsAtLosF: 90, peakDensity: 2.8, meanSpeed: 0.351 }),
        ],
      }),
    )
    const finding = expectFinding(findings, 'area-los-zone-foyer')
    expect(finding.severity).toBe('medium')
    expect(finding.headline).toBe('Foyer sat at level of service F for 1 min 30 s')
    expect(finding.detail).toContain('averaged 0.35 m/s')
    expect(finding.detail).toContain('1.34')
  })

  it('reports the crush, not the level of service, when an area did both', () => {
    const findings = run(
      summaryOf({ areas: [areaOf({ secondsAtCrushRisk: 40, secondsAtLosF: 400 })] }),
    )
    expect(idsOf(findings).filter((id) => id.startsWith('area-'))).toEqual([
      'area-crush-zone-foyer',
    ])
  })

  it('leaves an area exactly on each threshold alone', () => {
    const findings = run(
      summaryOf({ areas: [areaOf({ secondsAtCrushRisk: 10, secondsAtLosF: 60 })] }),
    )
    expect(idsOf(findings)).toEqual(['all-clear'])
  })
})

describe('queueing and completion', () => {
  it('carries the peak queue and when it happened', () => {
    const queueTotal = new Float32Array(SAMPLES)
    queueTotal[5] = 26
    const finding = expectFinding(run(summaryOf(), seriesOf({ queueTotal })), 'queue-peak')
    expect(finding.severity).toBe('low')
    expect(finding.headline).toBe('26 people were queueing at once')
    expect(finding.detail).toContain('50 s into the run')
  })

  it('escalates a queue of 40', () => {
    const queueTotal = new Float32Array(SAMPLES)
    queueTotal[2] = 40
    expect(expectFinding(run(summaryOf(), seriesOf({ queueTotal })), 'queue-peak').severity).toBe(
      'medium',
    )
  })

  it('says nothing about a queue of 19', () => {
    const queueTotal = new Float32Array(SAMPLES)
    queueTotal[2] = 19
    expect(idsOf(run(summaryOf(), seriesOf({ queueTotal })))).not.toContain('queue-peak')
  })

  it('says how many people were still inside, and how long the run was', () => {
    const findings = run(summaryOf({ completed: 90, totalPeople: 100, durationS: 600 }))
    const finding = expectFinding(findings, 'incomplete')
    expect(finding.headline).toBe('10 of 100 people had not left when the run ended')
    expect(finding.detail).toContain('10 min')
  })

  it('escalates once more than a tenth of the crowd is stranded', () => {
    expect(
      expectFinding(run(summaryOf({ completed: 90, totalPeople: 100 })), 'incomplete').severity,
    ).toBe('medium')
    expect(
      expectFinding(run(summaryOf({ completed: 88, totalPeople: 100 })), 'incomplete').severity,
    ).toBe('high')
  })

  it('says the run was capped, with both the simulated and the requested crowd', () => {
    const findings = run(summaryOf({ totalPeople: 600, completed: 600 }), seriesOf(), 1500)
    const finding = expectFinding(findings, 'capped')
    expect(finding.severity).toBe('medium')
    expect(finding.headline).toBe('The run was capped at 600 of 1500 people')
  })

  it('does not claim a cap when everybody the scenario asked for was simulated', () => {
    expect(
      idsOf(run(summaryOf({ totalPeople: 100, completed: 100 }), seriesOf(), 100)),
    ).not.toContain('capped')
  })
})

describe('journey spread', () => {
  it('carries the mean, the p95 and the ratio between them', () => {
    const findings = run(summaryOf({ meanJourney: 120, p95Journey: 300 }))
    const finding = expectFinding(findings, 'journey-spread')
    expect(finding.severity).toBe('low')
    expect(finding.detail).toContain('mean journey was 2 min')
    expect(finding.detail).toContain('one in twenty took 5 min')
    expect(finding.detail).toContain('2.5 times longer')
  })

  it('leaves a spread of exactly 2.2 alone', () => {
    expect(idsOf(run(summaryOf({ meanJourney: 120, p95Journey: 264 })))).not.toContain(
      'journey-spread',
    )
  })

  it('never divides by a zero mean journey', () => {
    // Nobody finished, so there is no ratio to report. A findings list that
    // said "Infinity times longer" would be worse than saying nothing.
    const findings = run(summaryOf({ completed: 0, meanJourney: 0, p95Journey: 0, peakDensity: 0 }))
    expect(idsOf(findings)).not.toContain('journey-spread')
    for (const finding of findings) {
      expect(`${finding.headline} ${finding.detail}`).not.toMatch(/NaN|Infinity|undefined/)
    }
  })
})

describe('engine warnings', () => {
  it('passes a warning through as a medium finding with no detail', () => {
    const findings = run(summaryOf({ warnings: ['The plan has no walkable floor.'] }))
    const finding = expectFinding(findings, 'warning-The plan has no walkable')
    expect(finding.severity).toBe('medium')
    expect(finding.headline).toBe('The plan has no walkable floor.')
    expect(finding.detail).toBe('')
    expect(finding.targetId).toBeUndefined()
  })

  it('gives two warnings that agree for 24 characters the same id', () => {
    // SUSPECTED BUG: the id is a slice of the warning text, and ResultsPanel
    // uses finding.id as the React key. Two counters whose names differ late —
    // the engine emits "<name> still had N people waiting at the end." — collide.
    const findings = run(
      summaryOf({
        warnings: [
          'Ground floor registration desk north still had 3 people waiting at the end.',
          'Ground floor registration desk south still had 5 people waiting at the end.',
        ],
      }),
    )
    const warningIds = idsOf(findings).filter((id) => id.startsWith('warning-'))
    expect(warningIds).toHaveLength(2)
    expect(warningIds[0]).toBe(warningIds[1]) // Current behaviour, not the desired one.
  })

  it('restates the engine warning alongside the finding derived from the same fact', () => {
    // Current behaviour: the unserved detector and the engine's own warning both
    // fire, so the user reads the same queue twice at two severities.
    const findings = run(
      summaryOf({
        services: [serviceOf({ id: 'svc-reg', name: 'Registration', unserved: 4 })],
        warnings: ['Registration still had 4 people waiting at the end.'],
      }),
    )
    expect(expectFinding(findings, 'unserved-svc-reg').severity).toBe('high')
    expect(expectFinding(findings, 'warning-Registration still had 4').severity).toBe('medium')
  })
})

describe('a clean run', () => {
  it('says so once, with the numbers that make it clean', () => {
    const findings = run(summaryOf({ meanJourney: 180, peakDensity: 0.9 }))
    expect(findings).toHaveLength(1)
    expect(findings[0].id).toBe('all-clear')
    expect(findings[0].severity).toBe('good')
    expect(findings[0].headline).toBe('Nothing worth flagging')
    expect(findings[0].detail).toContain('mean journey 3 min')
    expect(findings[0].detail).toContain('peak density 0.9 per m²')
  })

  it('returns nothing at all rather than inventing an all-clear for an empty run', () => {
    const empty = summaryOf({
      totalPeople: 0,
      completed: 0,
      meanJourney: 0,
      p95Journey: 0,
      peakDensity: 0,
      losShare: {},
    })
    expect(run(empty, seriesOf(), 0)).toEqual([])
  })

  it('never mixes the all-clear with a real finding', () => {
    const findings = run(summaryOf({ services: [serviceOf({ utilisation: 0.9 })] }))
    expect(idsOf(findings)).not.toContain('all-clear')
    expect(findings.some((finding) => finding.severity === 'good')).toBe(false)
  })
})

describe('ranking', () => {
  const busy = summaryOf({
    completed: 70,
    totalPeople: 100,
    meanJourney: 120,
    p95Journey: 400,
    peakDensity: 4.8,
    losShare: { E: 0.1, F: 0.2 },
    services: [
      serviceOf({
        id: 'svc-reg',
        name: 'Registration',
        unserved: 9,
        meanWait: 650,
        utilisation: 0.97,
      }),
      serviceOf({ id: 'svc-cloak', name: 'Cloakroom', utilisation: 0.05, served: 3 }),
    ],
    areas: [
      areaOf({ id: 'zone-gate', name: 'Gate line', secondsAtCrushRisk: 45, peakDensity: 4.8 }),
    ],
  })
  const busySeries = seriesOf({ peakDensity: heldFor(4.6, 120), queueTotal: heldFor(44, 60) })

  it('puts the worst thing first and never lets a severity climb back up', () => {
    const findings = run(busy, busySeries)
    const ranks = findings.map((finding) =>
      ['high', 'medium', 'low', 'good'].indexOf(finding.severity),
    )
    expect(findings[0].severity).toBe('high')
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    expect(ranks).toContain(0)
    expect(ranks).toContain(1)
    expect(ranks).toContain(2)
  })

  it('gives every finding in a busy run its own id', () => {
    const ids = idsOf(run(busy, busySeries))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('carries a number on every finding it fired on a threshold', () => {
    for (const finding of run(busy, busySeries)) {
      expect(`${finding.headline} ${finding.detail}`, finding.id).toMatch(/\d/)
    }
  })

  it('points only the findings about one object at that object', () => {
    const objectPrefixes = ['unserved-', 'wait-', 'util-', 'idle-', 'area-crush-', 'area-los-']
    for (const finding of run(busy, busySeries)) {
      const aboutAnObject = objectPrefixes.some((prefix) => finding.id.startsWith(prefix))
      if (aboutAnObject) expect(finding.targetId, finding.id).toBeTruthy()
      else expect(finding.targetId, finding.id).toBeUndefined()
    }
  })
})
