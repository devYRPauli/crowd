/**
 * Reading a plain-English brief.
 *
 * "About 200 guests arriving over 45 minutes, three staff on the bar, a minute
 * each, and a fire drill at half past" is how someone actually describes an
 * event. This turns that into scenario changes.
 *
 * It is a deterministic parser, not a language model: it runs offline, it never
 * makes anything up, and everything it understood is listed back for the user
 * to confirm before it is applied. Anything it could not read is reported too —
 * silently ignoring half a sentence is worse than saying so.
 */

import type { CrowdDocument, Scenario } from '../model/types'
import { updateScenario, updateServicePoint } from '../document/mutations'

export interface BriefAssumption {
  id: string
  /** What the parser understood, in the user's terms. */
  label: string
  /** The phrase it came from, so the user can see why. */
  source: string
  apply: (doc: CrowdDocument) => CrowdDocument
}

export interface BriefResult {
  assumptions: BriefAssumption[]
  /** Phrases that looked meaningful but were not understood. */
  unread: string[]
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  hundred: 100,
}

const toNumber = (token: string | undefined): number | null => {
  if (!token) return null
  const cleaned = token.replace(/,/g, '').trim().toLowerCase()
  const numeric = Number(cleaned)
  if (Number.isFinite(numeric)) return numeric
  return NUMBER_WORDS[cleaned] ?? null
}

/** `NUM UNIT` where the unit is minutes, hours or seconds; returns seconds. */
const toSeconds = (value: number, unit: string): number => {
  const u = unit.toLowerCase()
  if (u.startsWith('h')) return value * 3600
  if (u.startsWith('m')) return value * 60
  return value
}

const NUMBER =
  '(\\d[\\d,]*|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|hundred)'
const UNIT = '(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)'

const PEOPLE_WORDS =
  'people|guests?|attendees?|delegates?|visitors?|customers?|passengers?|voters?|patrons?|persons?'

/**
 * Turn a brief into a list of proposed changes.
 *
 * Nothing is applied here — the caller shows the assumptions and applies the
 * ones the user keeps. That confirmation step is the point: a parser that
 * guesses silently is a parser you cannot trust with a plan.
 */
export const readBrief = (text: string, document: CrowdDocument): BriefResult => {
  const assumptions: BriefAssumption[] = []
  const unread: string[] = []
  const source = text.trim()
  if (!source) return { assumptions, unread }

  const lower = source.toLowerCase()
  const population = document.scenario.populations[0]
  const services = document.plan.servicePoints

  const add = (
    id: string,
    label: string,
    phrase: string,
    apply: (doc: CrowdDocument) => CrowdDocument,
  ) => {
    if (assumptions.some((entry) => entry.id === id)) return
    assumptions.push({ id, label, source: phrase, apply })
  }

  const patchPopulation = (
    doc: CrowdDocument,
    changes: Partial<Scenario['populations'][number]>,
  ): CrowdDocument => {
    if (!doc.scenario.populations[0]) return doc
    return updateScenario(doc, {
      populations: doc.scenario.populations.map((entry, index) =>
        index === 0 ? { ...entry, ...changes } : entry,
      ),
    })
  }

  // --- how many people -----------------------------------------------------
  const headcount = lower.match(
    new RegExp(`(?:about|around|roughly|up to|~)?\\s*${NUMBER}\\s+(?:${PEOPLE_WORDS})`),
  )
  if (headcount && population) {
    const count = toNumber(headcount[1])
    if (count !== null && count > 0) {
      add('count', `${Math.round(count)} people`, headcount[0].trim(), (doc) =>
        patchPopulation(doc, { count: Math.round(count) }),
      )
    }
  }

  // --- when they arrive ----------------------------------------------------
  const window = lower.match(
    new RegExp(`(?:arriv\\w*\\s+)?(?:over|across|within|during|in)\\s+${NUMBER}\\s*${UNIT}\\b`),
  )
  if (window && population) {
    const value = toNumber(window[1])
    if (value !== null && value > 0) {
      const seconds = toSeconds(value, window[2])
      add(
        'window',
        `Arrivals spread over ${Math.round(seconds / 60)} minutes`,
        window[0].trim(),
        (doc) =>
          patchPopulation(doc, {
            arrival: { ...doc.scenario.populations[0].arrival, startS: 0, windowS: seconds },
          }),
      )
    }
  }

  const waves = lower.match(new RegExp(`${NUMBER}\\s+(?:waves?|coaches|buses|batches|groups)`))
  if (waves && population) {
    const count = toNumber(waves[1])
    if (count !== null && count >= 2) {
      add('waves', `Arriving in ${count} waves`, waves[0].trim(), (doc) =>
        patchPopulation(doc, {
          arrival: {
            ...doc.scenario.populations[0].arrival,
            kind: 'waves',
            waves: Math.round(count),
          },
        }),
      )
    }
  } else if (/\ball at once\b|\bat the same time\b|\bdoors open\b/.test(lower) && population) {
    add('all-at-once', 'Everybody arrives at once', 'all at once', (doc) =>
      patchPopulation(doc, {
        arrival: { ...doc.scenario.populations[0].arrival, kind: 'all-at-once', windowS: 0 },
      }),
    )
  } else if (/\bfront[- ]loaded\b|\bmost(?:ly)? early\b|\bearly rush\b/.test(lower) && population) {
    add('front-loaded', 'Most people arrive early', 'front-loaded', (doc) =>
      patchPopulation(doc, {
        arrival: { ...doc.scenario.populations[0].arrival, kind: 'front-loaded' },
      }),
    )
  } else if (/\bpeak\w*\b|\brush\b|\bbusiest\b/.test(lower) && population) {
    add('peak', 'Arrivals cluster around a peak', 'peak', (doc) =>
      patchPopulation(doc, {
        arrival: {
          ...doc.scenario.populations[0].arrival,
          kind: 'peak',
          peakAt: 0.5,
          spread: 0.18,
        },
      }),
    )
  } else if (/\brandom\w*\b|\bsteadily\b|\btrickl\w+\b/.test(lower) && population) {
    add('poisson', 'Arrivals are random rather than regular', 'randomly', (doc) =>
      patchPopulation(doc, {
        arrival: { ...doc.scenario.populations[0].arrival, kind: 'poisson' },
      }),
    )
  }

  // --- staffing ------------------------------------------------------------
  const staff = lower.match(
    new RegExp(
      `${NUMBER}\\s+(staff|servers?|volunteers?|baristas?|cashiers?|stewards?|bar\\s?staff|tills?|desks?|positions?)`,
    ),
  )
  if (staff && services.length > 0) {
    const count = toNumber(staff[1])
    if (count !== null && count >= 1) {
      const perPoint = Math.max(1, Math.round(count / services.length))
      add(
        'staff',
        services.length === 1
          ? `${Math.round(count)} staff on ${services[0].name}`
          : `${perPoint} staff on each of ${services.length} counters`,
        staff[0].trim(),
        (doc) =>
          doc.plan.servicePoints.reduce(
            (next, point) => updateServicePoint(next, point.id, { servers: perPoint }),
            doc,
          ),
      )
    }
  }

  // --- service time --------------------------------------------------------
  const service = lower.match(
    new RegExp(`${NUMBER}\\s*${UNIT}\\s*(?:each|per\\s+person|to\\s+serve|service|a\\s+head)`),
  )
  const serviceAlt = lower.match(
    new RegExp(`(?:serv\\w+|takes?|taking)\\s+(?:about\\s+|around\\s+)?${NUMBER}\\s*${UNIT}\\b`),
  )
  const serviceMatch = service ?? serviceAlt
  if (serviceMatch && services.length > 0) {
    const value = toNumber(serviceMatch[1])
    if (value !== null && value > 0) {
      const seconds = toSeconds(value, serviceMatch[2])
      if (seconds >= 1 && seconds <= 1800) {
        add(
          'service',
          `${Math.round(seconds)} seconds to serve each person`,
          serviceMatch[0].trim(),
          (doc) =>
            doc.plan.servicePoints.reduce(
              (next, point) =>
                updateServicePoint(next, point.id, {
                  serviceTime: {
                    ...point.serviceTime,
                    mean: seconds,
                    sd: Math.max(1, seconds * 0.35),
                  },
                }),
              doc,
            ),
        )
      }
    }
  }

  // --- run length and evacuation -------------------------------------------
  const runLength = lower.match(
    new RegExp(
      `(?:run|simulate|over a|lasting|for)\\s+${NUMBER}\\s*${UNIT}\\s*(?:event|run|long)?\\b`,
    ),
  )
  if (runLength) {
    const value = toNumber(runLength[1])
    if (value !== null && value > 0) {
      const seconds = toSeconds(value, runLength[2])
      if (seconds >= 60) {
        add('duration', `Run for ${Math.round(seconds / 60)} minutes`, runLength[0].trim(), (doc) =>
          updateScenario(doc, { durationS: seconds }),
        )
      }
    }
  }

  const evacuation = lower.match(
    new RegExp(
      `(?:evacuat\\w*|fire\\s*(?:drill|alarm)|alarm)\\s*(?:at|after)?\\s*${NUMBER}\\s*${UNIT}\\b`,
    ),
  )
  if (evacuation) {
    const value = toNumber(evacuation[1])
    if (value !== null && value >= 0) {
      const seconds = toSeconds(value, evacuation[2])
      add(
        'evacuation',
        `Evacuation alarm at ${Math.round(seconds / 60)} minutes`,
        evacuation[0].trim(),
        (doc) => updateScenario(doc, { evacuationAtS: seconds }),
      )
    }
  } else if (/\bevacuat\w*|fire\s*(drill|alarm)\b/.test(lower)) {
    add('evacuation-midway', 'Evacuation alarm halfway through', 'evacuation', (doc) =>
      updateScenario(doc, { evacuationAtS: Math.round(doc.scenario.durationS * 0.5) }),
    )
  }

  // --- who they are --------------------------------------------------------
  const mixes: Array<[RegExp, string, Array<{ profileId: string; weight: number }>]> = [
    [
      /\bolder\b|\belderly\b|\bseniors?\b|\bretire\w+\b/,
      'An older crowd',
      [
        { profileId: 'senior', weight: 45 },
        { profileId: 'adult', weight: 40 },
        { profileId: 'wheelchair', weight: 8 },
        { profileId: 'luggage', weight: 4 },
        { profileId: 'child', weight: 3 },
      ],
    ],
    [
      /\bfamil\w+\b|\bchildren\b|\bkids\b|\bschool\b/,
      'Families with children',
      [
        { profileId: 'adult', weight: 45 },
        { profileId: 'child', weight: 35 },
        { profileId: 'senior', weight: 12 },
        { profileId: 'wheelchair', weight: 4 },
        { profileId: 'luggage', weight: 4 },
      ],
    ],
    [
      /\bluggage\b|\bsuitcases?\b|\bbags\b|\bairport\b|\bstation\b/,
      'Many people carrying luggage',
      [
        { profileId: 'adult', weight: 40 },
        { profileId: 'luggage', weight: 32 },
        { profileId: 'hurried', weight: 18 },
        { profileId: 'senior', weight: 6 },
        { profileId: 'child', weight: 4 },
      ],
    ],
    [
      /\bin a hurry\b|\brushing\b|\bcommut\w+\b|\blate\b/,
      'People in a hurry',
      [
        { profileId: 'hurried', weight: 55 },
        { profileId: 'adult', weight: 33 },
        { profileId: 'luggage', weight: 6 },
        { profileId: 'senior', weight: 4 },
        { profileId: 'child', weight: 2 },
      ],
    ],
  ]
  for (const [pattern, label, mix] of mixes) {
    const match = lower.match(pattern)
    if (match && population) {
      add(`mix-${label}`, label, match[0], (doc) => patchPopulation(doc, { profileMix: mix }))
      break
    }
  }

  // --- what we could not read ----------------------------------------------
  const consumed = assumptions.map((entry) => entry.source.toLowerCase())
  for (const clause of source.split(/[,.;]|\band\b/i)) {
    const trimmed = clause.trim()
    if (trimmed.length < 6) continue
    const lowerClause = trimmed.toLowerCase()
    if (consumed.some((phrase) => phrase && lowerClause.includes(phrase))) continue
    // Only report clauses that look like they were meant to mean something.
    if (
      /\d|\b(people|staff|minute|hour|second|queue|seat|wave|arriv|serv|evacuat)\w*/i.test(trimmed)
    ) {
      unread.push(trimmed)
    }
  }

  return { assumptions, unread }
}

/** Example briefs, shown as a starting point rather than a blank box. */
export const BRIEF_EXAMPLES = [
  '200 guests arriving over 45 minutes, three staff on the bar, a minute each',
  '120 delegates all at once, four desks, 30 seconds each, run for 40 minutes',
  '400 passengers in six waves, mostly with luggage and in a hurry',
  '80 older voters arriving randomly over two hours, two check-in desks',
  '250 people, peak arrival, fire alarm at 30 minutes',
]
