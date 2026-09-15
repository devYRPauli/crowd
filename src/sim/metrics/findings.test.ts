import { describe, expect, it } from 'vitest'
import { deriveFindings } from './findings'
import type { Finding, FindingInput } from './findings'
import { losFor } from './los'
import type { AreaSummary, RunSummary, ServiceSummary } from '../types'

type Series = FindingInput['series']

/** Seconds between samples in the fixtures; the worker records one per frame. */
const SAMPLE_S = 10
const SAMPLES = 61

/** A counter nobody had to wait at, so an override turns one thing bad at a time. */
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
 * A channel that sits at `value` for `seconds` and at zero afterwards. Each
 * sample is credited with the interval that ended at it, so the value has to
 * start at the second sample to buy any time at all — see "does not see a spike
 * that only exists in the first frame".
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
  // Failing on the whole list says which detector fired instead of this one.
  if (!found) expect(idsOf(findings)).toContain(id)
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
    // Clicking a finding selects the object it is about, so it has to carry its id.
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

  it('turns a five-minute mean wait from a note into a problem', () => {
    const note = expectFinding(
      run(summaryOf({ services: [serviceOf({ meanWait: 300 })] })),
      'wait-svc-bar',
    )
    expect(note.severity).toBe('low')
    expect(note.headline).toBe('Coffee bar averaged a 5 min wait')

    const problem = expectFinding(
      run(summaryOf({ services: [serviceOf({ meanWait: 301 })] })),
      'wait-svc-bar',
    )
    expect(problem.severity).toBe('medium')
    expect(problem.headline).toBe('Coffee bar kept people waiting 5 min 1 s on average')
  })

  it('escalates once the mean wait passes ten minutes', () => {
    expect(
      expectFinding(run(summaryOf({ services: [serviceOf({ meanWait: 600 })] })), 'wait-svc-bar')
        .severity,
    ).toBe('medium')
    const worse = expectFinding(
      run(summaryOf({ services: [serviceOf({ meanWait: 700 })] })),
      'wait-svc-bar',
    )
    expect(worse.severity).toBe('high')
    expect(worse.headline).toContain('11 min 40 s')
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
    expect(idsOf(run(summaryOf({ services: [serviceOf({ meanWait: 90 })] })))).toEqual([
      'all-clear',
    ])
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

    expect(
      expectFinding(
        run(summaryOf({ services: [serviceOf({ utilisation: 0.95 })] })),
        'util-svc-bar',
      ).severity,
    ).toBe('medium')

    const hotter = expectFinding(
      run(summaryOf({ services: [serviceOf({ utilisation: 0.96 })] })),
      'util-svc-bar',
    )
    expect(hotter.severity).toBe('high')
    expect(hotter.headline).toContain('96%')
  })

  it('says nothing about a counter sitting exactly on the 85% threshold', () => {
    expect(idsOf(run(summaryOf({ services: [serviceOf({ utilisation: 0.85 })] })))).toEqual([
      'all-clear',
    ])
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

  it('stops calling a counter idle once it is busy a quarter of the time', () => {
    expect(idsOf(run(summaryOf({ services: [serviceOf({ utilisation: 0.249 })] })))).toContain(
      'idle-svc-bar',
    )
    expect(idsOf(run(summaryOf({ services: [serviceOf({ utilisation: 0.25 })] })))).toEqual([
      'all-clear',
    ])
  })

  it('never calls one counter both busy and idle', () => {
    for (const utilisation of [0, 0.1, 0.24, 0.25, 0.5, 0.85, 0.86, 1]) {
      const ids = idsOf(run(summaryOf({ services: [serviceOf({ utilisation })] })))
      expect(
        ids.filter((id) => id.startsWith('util-') || id.startsWith('idle-')).length,
        `utilisation ${utilisation}`,
      ).toBeLessThan(2)
    }
  })

  it('reports the wait and the utilisation of one hot counter separately', () => {
    const findings = run(summaryOf({ services: [serviceOf({ meanWait: 400, utilisation: 0.92 })] }))
    expect(idsOf(findings)).toEqual(['wait-svc-bar', 'util-svc-bar'])
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
    // Venue-wide, so there is no single object for the panel to select.
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

  it('stays quiet about a minute at level of service F and speaks at 70 s', () => {
    expect(
      idsOf(run(summaryOf({ peakDensity: 2.5 }), seriesOf({ peakDensity: heldFor(2.5, 60) }))),
    ).toEqual(['all-clear'])
    expect(
      expectFinding(
        run(summaryOf({ peakDensity: 2.5 }), seriesOf({ peakDensity: heldFor(2.5, 70) })),
        'density-fail',
      ).headline,
    ).toBe('The busiest area sat at level of service F for 1 min 10 s')
  })

  it('measures the time in the band by the clock, not by how many samples landed in it', () => {
    // The worker samples once per frame, so the gap between samples moves with
    // frame rate and playback speed. Counting samples would make the same crowd
    // fire at 60 fps and stay silent at 15.
    const sparse = seriesOf({
      time: Float32Array.from([0, 5, 60, 65]),
      peakDensity: Float32Array.from([0, 4.5, 4.5, 0]),
    })
    expect(
      expectFinding(run(summaryOf({ peakDensity: 4.5 }), sparse), 'density-crush').headline,
    ).toContain('for 1 min')

    const dense = seriesOf({
      time: Float32Array.from([0, 5, 10, 15]),
      peakDensity: Float32Array.from([0, 4.5, 4.5, 0]),
    })
    expect(idsOf(run(summaryOf({ peakDensity: 4.5 }), dense))).toEqual(['all-clear'])
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
    // SUSPECTED BUG: findings.ts hardcodes 2.17 while the table this claim comes
    // from puts the E/F boundary at 1 / 0.46 = 2.1739 per m². AGENTS.md says the
    // numbers that define a rule are shared, not copied and rounded. Densities in
    // this sliver are called F in the findings list and coloured E by the legend
    // beside it, on the same run.
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

  it('escalates only once F alone is past 15%', () => {
    expect(
      expectFinding(run(summaryOf({ losShare: { E: 0.06, F: 0.15 } })), 'los-share').severity,
    ).toBe('low')
    expect(
      expectFinding(run(summaryOf({ losShare: { E: 0.05, F: 0.2 } })), 'los-share').severity,
    ).toBe('medium')
  })

  it('leaves a run sitting exactly on 20% alone', () => {
    expect(idsOf(run(summaryOf({ losShare: { E: 0.2 } })))).toEqual(['all-clear'])
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
    // SUSPECTED BUG: a measured area is a zone — world.ts builds measures from
    // zones of kind 'measure' — but ResultsPanel selects every targetId as
    // { kind: 'service' }. Finding carries an id with no kind, so clicking the
    // worst finding in a run selects nothing at all. Either Finding names the
    // kind or the panel has to infer it.
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

  it('leaves an area exactly on each threshold alone and speaks a second later', () => {
    expect(
      idsOf(run(summaryOf({ areas: [areaOf({ secondsAtCrushRisk: 10, secondsAtLosF: 60 })] }))),
    ).toEqual(['all-clear'])
    expect(idsOf(run(summaryOf({ areas: [areaOf({ secondsAtCrushRisk: 11 })] })))).toEqual([
      'area-crush-zone-foyer',
    ])
    expect(idsOf(run(summaryOf({ areas: [areaOf({ secondsAtLosF: 61 })] })))).toEqual([
      'area-los-zone-foyer',
    ])
  })

  it('keeps two measured areas apart', () => {
    const findings = run(
      summaryOf({
        areas: [
          areaOf({ id: 'zone-gate', name: 'Gate line', secondsAtCrushRisk: 45 }),
          areaOf({ id: 'zone-bar', name: 'Bar corner', secondsAtLosF: 120 }),
        ],
      }),
    )
    expect(expectFinding(findings, 'area-crush-zone-gate').headline).toContain('Gate line')
    expect(expectFinding(findings, 'area-los-zone-bar').headline).toContain('Bar corner')
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

  it('starts at twenty in a queue and escalates at forty', () => {
    const peaking = (people: number): Finding[] => {
      const queueTotal = new Float32Array(SAMPLES)
      queueTotal[2] = people
      return run(summaryOf(), seriesOf({ queueTotal }))
    }
    expect(idsOf(peaking(19))).toEqual(['all-clear'])
    expect(expectFinding(peaking(20), 'queue-peak').severity).toBe('low')
    expect(expectFinding(peaking(39), 'queue-peak').severity).toBe('low')
    expect(expectFinding(peaking(40), 'queue-peak').severity).toBe('medium')
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
    expect(idsOf(run(summaryOf({ totalPeople: 100, completed: 100 }), seriesOf(), 100))).toEqual([
      'all-clear',
    ])
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
    expect(idsOf(run(summaryOf({ meanJourney: 120, p95Journey: 264 })))).toEqual(['all-clear'])
    expect(idsOf(run(summaryOf({ meanJourney: 120, p95Journey: 265 })))).toContain('journey-spread')
  })

  it('never divides by a zero mean journey', () => {
    // Nobody finished, so there is no ratio to report. A findings list that said
    // "Infinity times longer" would be worse than saying nothing.
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
    // SUSPECTED BUG: the id is a 24-character slice of the warning text and
    // ResultsPanel uses finding.id as the React key. The engine emits
    // "<name> still had N people waiting at the end.", so two counters whose
    // names differ only late in the string collide and React renders one.
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
    expect(warningIds[0]).toBe(warningIds[1]) // Current behaviour, not the wanted one.
  })

  it('reads the same problem back twice when the engine warned about it too', () => {
    // SUSPECTED BUG: every fact the engine warns about is also detected here, so
    // a real run reports each of these twice — once at the severity the detector
    // chose and again as a medium warning, in two different places in the list.
    // The warning strings below are the ones engine.ts emits verbatim.
    const findings = run(
      summaryOf({
        totalPeople: 600,
        completed: 570,
        services: [serviceOf({ id: 'svc-reg', name: 'Registration', unserved: 4 })],
        warnings: [
          'Registration still had 4 people waiting at the end.',
          '30 people had not left when the run ended; extend the duration for a complete picture.',
          'This scenario asks for 1500 people; the run was capped at 600.',
        ],
      }),
      seriesOf(),
      1500,
    )
    const saying = (text: string) => findings.filter((f) => f.headline.includes(text))
    expect(saying('Registration')).toHaveLength(2)
    expect(saying('had not left')).toHaveLength(2)
    expect(saying('capped')).toHaveLength(2)
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

  it('never mixes the all-clear with a real finding', () => {
    const findings = run(summaryOf({ services: [serviceOf({ utilisation: 0.9 })] }))
    expect(idsOf(findings)).not.toContain('all-clear')
    expect(findings.some((finding) => finding.severity === 'good')).toBe(false)
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

  it('will not call a run clean when nobody got out', () => {
    // Results are never fabricated: a venue that jammed solid has to say so,
    // and a summary with a zero mean journey must not read as a quiet night.
    const findings = run(
      summaryOf({ totalPeople: 50, completed: 0, meanJourney: 0, p95Journey: 0, peakDensity: 0 }),
    )
    expect(idsOf(findings)).toEqual(['incomplete'])
    expect(findings[0].headline).toBe('50 of 50 people had not left when the run ended')
  })

  it('judges the run by the summary when no samples were recorded', () => {
    const noSamples = seriesOf({ time: new Float32Array(0) })
    expect(idsOf(run(summaryOf(), noSamples))).toEqual(['all-clear'])
    const findings = run(summaryOf({ completed: 60, totalPeople: 100 }), noSamples)
    expect(idsOf(findings)).toEqual(['incomplete'])
    expect(findings[0].detail).not.toMatch(/NaN|Infinity|undefined/)
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

  it('puts the worst thing first and keeps the order the detectors ran in within a severity', () => {
    // The panel shows the first ten, so anything that sorts late is unread.
    expect(idsOf(run(busy, busySeries))).toEqual([
      'unserved-svc-reg',
      'wait-svc-reg',
      'util-svc-reg',
      'density-crush',
      'area-crush-zone-gate',
      'incomplete',
      'los-share',
      'queue-peak',
      'idle-svc-cloak',
      'journey-spread',
    ])
  })

  it('never lets a severity climb back up the list', () => {
    const ranks = run(busy, busySeries).map((finding) =>
      ['high', 'medium', 'low', 'good'].indexOf(finding.severity),
    )
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    expect(ranks[0]).toBe(0)
  })

  it('gives every finding in a busy run its own id', () => {
    const ids = idsOf(run(busy, busySeries))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('carries the number it fired on, on every finding', () => {
    for (const finding of run(busy, busySeries)) {
      expect(`${finding.headline} ${finding.detail}`, finding.id).toMatch(/\d/)
    }
  })

  it('points only the findings about one object at that object', () => {
    const objectPrefixes = ['unserved-', 'wait-', 'util-', 'idle-', 'area-crush-', 'area-los-']
    for (const finding of run(busy, busySeries)) {
      const prefix = objectPrefixes.find((candidate) => finding.id.startsWith(candidate))
      if (prefix) expect(finding.targetId, finding.id).toBe(finding.id.slice(prefix.length))
      else expect(finding.targetId, finding.id).toBeUndefined()
    }
  })
})
