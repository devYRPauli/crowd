import { describe, expect, it } from 'vitest'
import { readBrief, BRIEF_EXAMPLES } from './brief'
import { getTemplate } from '../../library/templates'
import type { CrowdDocument } from '../model/types'

const base = (): CrowdDocument => getTemplate('coffee-bar')!.build()

const applyAll = (doc: CrowdDocument, text: string): CrowdDocument => {
  const result = readBrief(text, doc)
  return result.assumptions.reduce((next, assumption) => assumption.apply(next), doc)
}

describe('brief parser', () => {
  it('reads a headcount, in digits or in words', () => {
    expect(applyAll(base(), '250 people').scenario.populations[0].count).toBe(250)
    expect(applyAll(base(), 'about 1,200 guests').scenario.populations[0].count).toBe(1200)
    expect(applyAll(base(), 'twenty visitors').scenario.populations[0].count).toBe(20)
  })

  it('reads an arrival window in any unit', () => {
    expect(
      applyAll(base(), '100 people over 45 minutes').scenario.populations[0].arrival.windowS,
    ).toBe(2700)
    expect(
      applyAll(base(), '100 people arriving over two hours').scenario.populations[0].arrival
        .windowS,
    ).toBe(7200)
    expect(
      applyAll(base(), '100 people over 90 seconds').scenario.populations[0].arrival.windowS,
    ).toBe(90)
  })

  it('reads the shape of the arrivals', () => {
    expect(applyAll(base(), '300 guests in six waves').scenario.populations[0].arrival.kind).toBe(
      'waves',
    )
    expect(applyAll(base(), '300 guests in six waves').scenario.populations[0].arrival.waves).toBe(
      6,
    )
    expect(applyAll(base(), '300 guests all at once').scenario.populations[0].arrival.kind).toBe(
      'all-at-once',
    )
    expect(applyAll(base(), '300 guests, front-loaded').scenario.populations[0].arrival.kind).toBe(
      'front-loaded',
    )
    expect(
      applyAll(base(), '300 guests arriving randomly').scenario.populations[0].arrival.kind,
    ).toBe('poisson')
  })

  it('reads staffing and spreads it across the counters', () => {
    const doc = applyAll(base(), 'four baristas')
    expect(doc.plan.servicePoints[0].servers).toBe(4)
    expect(applyAll(base(), 'three staff').plan.servicePoints[0].servers).toBe(3)
  })

  it('reads a service time', () => {
    expect(applyAll(base(), '30 seconds each').plan.servicePoints[0].serviceTime.mean).toBe(30)
    expect(applyAll(base(), 'a minute per person').plan.servicePoints[0].serviceTime.mean).toBe(60)
    expect(
      applyAll(base(), 'serving takes about 90 seconds').plan.servicePoints[0].serviceTime.mean,
    ).toBe(90)
  })

  it('reads a run length and an evacuation', () => {
    expect(applyAll(base(), 'run for 40 minutes').scenario.durationS).toBe(2400)
    expect(applyAll(base(), 'fire alarm at 30 minutes').scenario.evacuationAtS).toBe(1800)
    expect(applyAll(base(), 'with an evacuation').scenario.evacuationAtS).toBeGreaterThan(0)
  })

  it('reads who the crowd is', () => {
    const older = applyAll(base(), '100 older voters')
    const seniorWeight = older.scenario.populations[0].profileMix.find(
      (m) => m.profileId === 'senior',
    )
    expect(seniorWeight?.weight).toBeGreaterThan(30)

    const hurried = applyAll(base(), '100 commuters in a hurry')
    const hurriedWeight = hurried.scenario.populations[0].profileMix.find(
      (m) => m.profileId === 'hurried',
    )
    expect(hurriedWeight?.weight).toBeGreaterThan(30)
  })

  it('handles a full sentence', () => {
    const doc = base()
    const text = '200 guests arriving over 45 minutes, three staff on the bar, a minute each'
    const result = readBrief(text, doc)
    expect(result.assumptions.map((a) => a.id).sort()).toEqual([
      'count',
      'service',
      'staff',
      'window',
    ])

    const applied = result.assumptions.reduce((next, a) => a.apply(next), doc)
    expect(applied.scenario.populations[0].count).toBe(200)
    expect(applied.scenario.populations[0].arrival.windowS).toBe(2700)
    expect(applied.plan.servicePoints[0].servers).toBe(3)
    expect(applied.plan.servicePoints[0].serviceTime.mean).toBe(60)
  })

  it('understands every shipped example', () => {
    for (const example of BRIEF_EXAMPLES) {
      const result = readBrief(example, base())
      expect(result.assumptions.length, `"${example}" was not understood`).toBeGreaterThan(1)
    }
  })

  it('invents nothing from an empty or meaningless brief', () => {
    expect(readBrief('', base()).assumptions).toHaveLength(0)
    expect(readBrief('   ', base()).assumptions).toHaveLength(0)
    expect(readBrief('the vibe should be nice', base()).assumptions).toHaveLength(0)
  })

  it('says what it could not read rather than ignoring it', () => {
    const result = readBrief('200 guests, with a cloakroom for 40 coats', base())
    expect(result.assumptions.some((a) => a.id === 'count')).toBe(true)
    expect(result.unread.join(' ')).toMatch(/cloakroom/)
  })

  it('leaves the document untouched until an assumption is applied', () => {
    const doc = base()
    const before = JSON.stringify(doc)
    readBrief('500 people over ten minutes, six staff', doc)
    expect(JSON.stringify(doc)).toBe(before)
  })

  it('reports every assumption with the phrase it came from', () => {
    const result = readBrief('300 delegates in four waves', base())
    for (const assumption of result.assumptions) {
      expect(assumption.source.length).toBeGreaterThan(0)
      expect(assumption.label.length).toBeGreaterThan(0)
    }
  })
})
