import { describe, expect, it } from 'vitest'
import { TEMPLATES } from './templates'
import { Simulation } from '../sim/engine'
import { parseDocument, serializeDocument } from '../core/document/serialize'
import { detectRooms } from '../core/model/rooms'
import { planSeats } from '../core/model/planGeometry'
import { buildWorld } from '../sim/world'

describe('starter templates', () => {
  it.each(TEMPLATES.map((t) => [t.id, t] as const))(
    '%s builds a coherent plan',
    (_id, template) => {
      const doc = template.build()
      expect(doc.plan.walls.length).toBeGreaterThan(3)
      // A way in and a way out, which may be a door marked for it or a zone.
      const waysIn = [
        ...doc.plan.zones.filter((z) => z.kind === 'entry'),
        ...doc.plan.openings.filter((o) => o.use === 'entry' || o.use === 'both'),
      ]
      const waysOut = [
        ...doc.plan.zones.filter((z) => z.kind === 'exit'),
        ...doc.plan.openings.filter((o) => o.use === 'exit' || o.use === 'both'),
      ]
      expect(waysIn.length).toBeGreaterThan(0)
      expect(waysOut.length).toBeGreaterThan(0)
      expect(doc.scenario.populations.length).toBeGreaterThan(0)

      // Every opening must belong to a wall that exists.
      const wallIds = new Set(doc.plan.walls.map((w) => w.id))
      for (const opening of doc.plan.openings) expect(wallIds.has(opening.wallId)).toBe(true)

      // Every itinerary step must point at something in the plan.
      const targets = new Set([
        ...doc.plan.zones.map((z) => z.id),
        ...doc.plan.servicePoints.map((s) => s.id),
        // A door people arrive or leave through is a destination in its own
        // right; see `openingThreshold`.
        ...doc.plan.openings.filter((o) => o.use).map((o) => o.id),
      ])
      for (const population of doc.scenario.populations) {
        for (const entryId of population.entryIds) expect(targets.has(entryId)).toBe(true)
        for (const step of population.itinerary) {
          if (step.targetId) expect(targets.has(step.targetId)).toBe(true)
          for (const id of step.targetIds ?? []) expect(targets.has(id)).toBe(true)
        }
      }
    },
  )

  it.each(TEMPLATES.map((t) => [t.id, t] as const))(
    '%s survives a save and reload',
    (_id, template) => {
      const doc = template.build()
      const reloaded = parseDocument(JSON.parse(serializeDocument(doc)))
      expect(reloaded.warnings).toEqual([])
      expect(reloaded.document.plan.walls).toHaveLength(doc.plan.walls.length)
      expect(reloaded.document.plan.furniture).toHaveLength(doc.plan.furniture.length)
      expect(reloaded.document.plan.servicePoints).toHaveLength(doc.plan.servicePoints.length)
      expect(reloaded.document.scenario.populations).toHaveLength(doc.scenario.populations.length)
    },
  )

  it.each(TEMPLATES.map((t) => [t.id, t] as const))(
    '%s encloses at least one room',
    (_id, template) => {
      const rooms = detectRooms(template.build().plan.walls)
      expect(rooms.length).toBeGreaterThan(0)
    },
  )

  it.each(TEMPLATES.map((t) => [t.id, t] as const))(
    '%s runs to completion without deadlocking',
    (_id, template) => {
      const doc = template.build()
      // Compress the timeline so every template gets a crowd inside the sampled
      // window, whatever its own schedule looks like.
      const scenario = {
        ...doc.scenario,
        durationS: 1800,
        evacuationAtS: null,
        populations: doc.scenario.populations.map((p) => ({
          ...p,
          count: Math.max(8, Math.round(p.count * 0.12)),
          arrival: { ...p.arrival, startS: 0, windowS: Math.min(p.arrival.windowS, 240) },
          itinerary: p.itinerary.map((s) =>
            s.duration ? { ...s, duration: { kind: 'constant' as const, mean: 30 } } : s,
          ),
        })),
      }
      const sim = new Simulation(doc.plan, scenario)

      let peakDensity = 0
      let lastCompleted = 0
      let plateau = 0
      let worstPlateau = 0
      const dt = 0.25
      for (let i = 0; i < 7200; i++) {
        if (sim.isFinished) break
        sim.step(dt)
        if (i % 20 !== 0) continue
        const stats = sim.stats()
        peakDensity = Math.max(peakDensity, stats.peakDensity)
        if (stats.completed > lastCompleted) {
          lastCompleted = stats.completed
          plateau = 0
        } else if (stats.active > 0 && stats.spawned > 4) {
          plateau += dt * 20
          worstPlateau = Math.max(worstPlateau, plateau)
        }
      }

      const spawned = sim.stats().spawned
      expect(spawned).toBeGreaterThan(0)
      // Everybody should get out, one way or another.
      expect(sim.summary().completed / spawned).toBeGreaterThan(0.95)
      // Hardly anyone should have to give up on their route to do it. Some
      // will in a venue deliberately built to be busy, and the run says so —
      // but it should be a handful, not a systemic failure to reach anything.
      const gaveUp = sim.summary().warnings.find((w) => w.includes('could not reach'))
      const count = gaveUp ? Number(gaveUp.match(/^(\d+)/)?.[1] ?? 0) : 0
      expect(count / spawned).toBeLessThan(0.15)
      // No physically impossible packing.
      expect(peakDensity).toBeLessThan(6.5)
      // And no long stretch where the venue stops draining: that is a deadlock.
      expect(worstPlateau).toBeLessThan(600)
    },
    40000,
  )

  it('offers seats where the template lays out seating', () => {
    for (const template of TEMPLATES) {
      const doc = template.build()
      const needsSeats = doc.scenario.populations.some((p) =>
        p.itinerary.some((s) => s.kind === 'seat'),
      )
      if (!needsSeats) continue
      expect(planSeats(doc.plan).length).toBeGreaterThan(0)
    }
  })

  it('turns every theatre seat towards the stage', () => {
    // The conference rows were turned half round, and the delegates sat with
    // their backs to the stage, facing the doors.
    let checked = 0
    for (const template of TEMPLATES) {
      const { plan } = template.build()
      const stage = plan.furniture.find((item) => item.catalogId === 'stage')
      if (!stage) continue
      const rows = new Set(
        plan.furniture.filter((item) => item.catalogId === 'seat-row').map((item) => item.id),
      )
      for (const seat of planSeats(plan)) {
        if (!rows.has(seat.furnitureId)) continue
        const toStage = {
          x: stage.position.x - seat.position.x,
          y: stage.position.y - seat.position.y,
        }
        expect(
          Math.cos(seat.facing) * toStage.x + Math.sin(seat.facing) * toStage.y,
        ).toBeGreaterThan(0)
        checked++
      }
    }
    expect(checked).toBe(360)
  })

  it.each(TEMPLATES.map((t) => [t.id, t] as const))(
    '%s gives the simulation every seat it lays out',
    (_id, template) => {
      // A sofa's or a bench's seats lie inside its own footprint, and the world
      // dropped them as unreachable: the coffee bar lost its sofa and the
      // concourse every seat it has.
      const doc = template.build()
      expect(buildWorld(doc.plan, doc.scenario).seats).toHaveLength(planSeats(doc.plan).length)
    },
  )
})
