/**
 * The pedestrian simulation.
 *
 * Three layers, each doing one job:
 *
 *  1. Route — a flow field per destination says which way to go, with a
 *     congestion-aware variant so people split around crowding rather than all
 *     following one line (see `nav/flowFields`).
 *  2. Avoid — ORCA turns "where I want to go" into "where I can go" given the
 *     neighbours and walls right now, reciprocally, so two people resolve a
 *     head-on without either of them stopping.
 *  3. Act — a small state machine per person walks their itinerary: go here,
 *     queue there, be served, sit down, leave.
 *
 * Everything is deterministic given the seed. The same scenario replayed
 * produces the same numbers, which is what makes two layouts comparable.
 */

import type { ItineraryStep, Plan, Scenario } from '../core/model/types'
import type { Vec2 } from '../core/math/vec2'
import { Rng, distributionMean, sampleDistribution } from '../core/math/random'
import { distance, normalize } from '../core/math/vec2'
import type { Bounds } from '../core/math/geometry'
import {
  boundsOf,
  closestPointOnPolyline,
  pointAlongPolyline,
  pointInPolygon,
} from '../core/math/geometry'
import {
  buildWorld,
  nearestFreeCell,
  queueSlotFacing,
  queueSlotPosition,
  samplePointInDestination,
  servicePositionFor,
  type DestinationRecord,
  type QueueRecord,
  type SimWorld,
} from './world'
import { cellCenter, gridIndex, sampleField, worldToCell } from './nav/eikonal'
import { DensityField, FlowFieldCache, PACE_LOOKAHEAD, speedFromDensity } from './nav/flowFields'
import { computeNewVelocity, type OrcaAgentState } from './avoidance/orca'
import { ObstacleIndex } from './avoidance/obstacleIndex'
import { SEPARATION, separationScale } from './avoidance/separation'
import { personalSpace } from './behaviour/proxemics'
import { SpatialHash } from './spatialHash'
import { scheduleArrivals, splitIntoGroups } from './agents/arrivals'
import {
  AGENT_FIELD,
  AGENT_STRIDE,
  DEFAULT_SIM_OPTIONS,
  agentStateIndex,
  type AgentJourney,
  type AgentState,
  type AreaSummary,
  type RunSummary,
  type ServiceSummary,
  type SimOptions,
  type SimStats,
} from './types'
import { CROWD_SAFETY, WALKWAY_LOS, losFor, losIndex } from './metrics/los'

/** How close counts as having arrived at an exact target. */
const ARRIVE_RADIUS = 0.34

/**
 * How far past the doorway somebody goes on taking up room.
 *
 * A doorway meters a crowd because the people already through it are still
 * there, in the way, a step further on. Delete them the instant they reach the
 * threshold and the space beyond the door is permanently empty: the person in
 * the gap sees clear floor ahead — the pace model looks `PACE_LOOKAHEAD` in
 * front — and walks out at full speed. Measured, that put a 3'0" leaf at 2.98
 * persons/m/s against the 1.2–1.4 the literature reports, and this engine's own
 * corridors peak at 1.19.
 *
 * So they keep their body for a metre after the threshold, which is enough to
 * hold the back pressure that makes a door a bottleneck. They are counted as
 * having left at the threshold, not here, because that is when they left.
 */
const EXIT_TAIL = 1.0

/**
 * Give up on the tail after this long.
 *
 * Somebody who gets through the door and straight into an obstruction would
 * otherwise stand in the tail forever, holding the doorway shut behind them.
 */
const EXIT_TAIL_TIMEOUT = 10
/**
 * Within this range a person steers straight at their target instead of
 * following the field — but only if the straight line is actually walkable.
 * Without that check, anybody whose seat or queue slot sits on the far side of a
 * wall 1.8 m away walks into the wall and stays there: the field knew the way
 * round and the shortcut threw it away. In the conference venue that stranded a
 * quarter of the room for the whole run, and they were only ever reported as
 * not having left in time, because somebody still pressing forward at 0.16 m/s
 * is not what either the jam detector or the give-up check is looking for.
 */
const DIRECT_RANGE = 3.5
const NEIGHBOUR_RANGE = 5.0
/** Velocity passes spent keeping bodies from walking into each other. */
const CONTACT_PASSES = 2
/** Seconds between a person reconsidering which way out they are heading. */
const EXIT_REVIEW_INTERVAL = 6
/**
 * How much better another door has to look before somebody changes their mind.
 *
 * Without a margin, two doors of nearly equal cost swap places every time the
 * congested field is re-solved and people oscillate between them instead of
 * leaving by either. A quarter better is a decision worth walking back for.
 */
const EXIT_SWITCH_MARGIN = 0.75
const MAX_NEIGHBOURS = 12
const SLOW_SPEED = 0.3

interface Agent {
  id: number
  populationIndex: number
  profileIndex: number
  groupId: number

  radius: number
  preferredSpeed: number
  maxSpeed: number
  caution: number
  assertiveness: number
  /** 0 follows the shortest path, 1 follows the congestion-aware field. */
  routeAwareness: number
  /** Lateral preference in metres, giving each person their own line. */
  lateralBias: number

  x: number
  y: number
  vx: number
  vy: number
  heading: number

  state: AgentState
  stepIndex: number
  fieldTarget: string | null
  exactTarget: Vec2 | null
  facingTarget: number | null

  spawnedAt: number
  timer: number
  queueId: string | null
  /** Set while walking towards a queue they have not joined yet. */
  pendingQueueId: string | null
  queueSlot: number
  serverIndex: number
  seatIndex: number
  joinedQueueAt: number

  distance: number
  stoppedTime: number
  queueTime: number
  /** When they reached the doorway, which is when they count as having left. */
  leftAt: number | null
  /** Where they were standing at that moment; the tail is measured from it. */
  leftFrom: Vec2 | null
  /** The exit they came through, kept because the tail clears `fieldTarget`. */
  leftVia: string | null
  /** How many times this person has been re-planned after getting stuck. */
  replanCount: number
  /** True once they have given up on their itinerary, so it is reported once. */
  gaveUp: boolean
  /** The step index `beginStep` last started, so patience resets per destination. */
  lastStepBegun: number
  /** Seconds since the last progress check. */
  walkTime: number
  /** Simulated time at which to reconsider the way out. */
  exitReviewAt: number
  /** Ways out this person's itinerary allows, or null for any of them. */
  allowedExits: readonly string[] | null
  /** Closest this person has come to their current destination. */
  bestDistance: number
  /** Seconds spent barely moving while trying to walk, for jam breaking. */
  jamTime: number
  finishedAt: number | null
  straightLineFrom: Vec2
}

interface PendingArrival {
  time: number
  populationIndex: number
  profileIndex: number
  entryIndex: number
  groupId: number
}

/** Running totals for one measurement area. */
interface AreaState {
  record: DestinationRecord
  bounds: Bounds
  peakOccupancy: number
  occupancySeconds: number
  peakDensity: number
  densitySeconds: number
  speedSeconds: number
  personSeconds: number
  secondsAtLosE: number
  secondsAtLosF: number
  secondsAtCrushRisk: number
  worstLosIndex: number
  elapsed: number
}

/** Live state of one way out; see `Simulation.exitLoads`. */
interface ExitLoad {
  /** People currently walking towards it. */
  heading: number
  /** People who have left through it. */
  through: number
  /** Simulated time of the first and most recent of those, for the rate. */
  firstAt: number
  lastAt: number
}

interface QueueState {
  record: QueueRecord
  /**
   * Position of this queue in the plan.
   *
   * Random-draw streams are named after it rather than after `record.id`: ids
   * are minted per document, so keying on one makes the same venue built twice
   * simulate differently. Two structurally identical plans have to produce
   * identical numbers or comparing a layout against a baseline measures nothing
   * but which ids each happened to get.
   */
  index: number
  /** Agent ids in queue order, head first. */
  waiting: number[]
  /** Agent id occupying each server, or -1. */
  servers: number[]
  serverFreeAt: number[]
  served: number
  totalWait: number
  maxWait: number
  totalService: number
  busyTime: number
  maxQueue: number
  /** Resolved positions for slots past the end of the drawn line. */
  overflowPositions: Map<number, Vec2>
}

export interface SimSnapshot {
  time: number
  /** Packed agent records; see AGENT_FIELD. */
  agents: Float32Array
  count: number
  stats: SimStats
}

export class Simulation {
  readonly world: SimWorld
  readonly options: SimOptions

  private scenario: Scenario
  private rng: Rng
  private fields: FlowFieldCache
  private density: DensityField
  private obstacleIndex: ObstacleIndex
  private hash: SpatialHash

  private agents: Agent[] = []
  private live: number[] = []
  private pending: PendingArrival[] = []
  private pendingCursor = 0
  private queues = new Map<string, QueueState>()
  private areas: AreaState[] = []
  /**
   * What each way out is doing: how many people are heading for it, and how
   * fast it has actually been letting them through.
   *
   * A door's discharge rate is a property of the door and of the crowd using
   * it, and nothing in the plan states it — an exit is a zone, and the
   * constriction that meters it is a doorway somewhere upstream. So it is
   * measured rather than assumed. Until a door has let enough people through to
   * have a rate worth trusting, choosing between doors falls back to walking
   * time alone, which is where this model started.
   */
  private exitLoads = new Map<string, ExitLoad>()
  private seatTaken: Uint8Array

  private time = 0
  private completed = 0
  private journeys: AgentJourney[] = []
  private losSeconds = new Float32Array(WALKWAY_LOS.length)
  private peakOccupancy = 0
  private peakDensity = 0
  private warnings: string[] = []
  private abandoned = 0
  private evacuated = false

  private overlapScratch = new Float32Array(0)
  private positionScratch: Float32Array
  private packed: Float32Array
  private neighbourScratch: OrcaAgentState[] = []
  private obstacleScratch: number[] = []
  private orcaState: OrcaAgentState = {
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    radius: 0.23,
    maxSpeed: 1.4,
    prefVelocity: { x: 0, y: 0 },
    timeHorizon: 2.5,
    timeHorizonObst: 0.9,
    responsibility: 0.5,
  }

  constructor(plan: Plan, scenario: Scenario, options: Partial<SimOptions> = {}) {
    this.options = { ...DEFAULT_SIM_OPTIONS, ...options }
    this.scenario = scenario
    this.world = buildWorld(plan, scenario, { cellSize: this.options.cellSize })
    this.rng = new Rng(scenario.seed)

    this.fields = new FlowFieldCache(this.world.grid, this.world.navBlocked, this.world.baseSpeed, {
      congestionWeight: scenario.routing.adaptive ? scenario.routing.congestionWeight : 0,
      replanIntervalS: scenario.routing.replanIntervalS,
      budgetPerTick: 2,
    })
    this.density = new DensityField(this.world.grid, 0.7, this.world.solid)
    this.obstacleIndex = new ObstacleIndex(this.world.obstacles, this.world.bounds, 2)
    this.hash = new SpatialHash(NEIGHBOUR_RANGE)
    this.seatTaken = new Uint8Array(this.world.seats.length)
    for (const exit of this.world.exits) {
      this.exitLoads.set(exit.id, { heading: 0, through: 0, firstAt: 0, lastAt: 0 })
    }

    this.world.queues.forEach((queue, queueIndex) => {
      this.queues.set(queue.id, {
        record: queue,
        index: queueIndex,
        waiting: [],
        servers: new Array(queue.serverCount).fill(-1),
        serverFreeAt: new Array(queue.serverCount).fill(0),
        served: 0,
        totalWait: 0,
        maxWait: 0,
        totalService: 0,
        busyTime: 0,
        maxQueue: 0,
        overflowPositions: new Map(),
      })
    })

    // Measurement areas report what happened inside them, so a planner can ask
    // about the doorway or the dance floor rather than about the whole venue.
    this.areas = this.world.measures.map((record) => ({
      record,
      bounds: boundsOf(record.polygon),
      peakOccupancy: 0,
      occupancySeconds: 0,
      peakDensity: 0,
      densitySeconds: 0,
      speedSeconds: 0,
      personSeconds: 0,
      secondsAtLosE: 0,
      secondsAtLosF: 0,
      secondsAtCrushRisk: 0,
      worstLosIndex: 0,
      elapsed: 0,
    }))

    this.prepareFields()
    this.buildSchedule()

    const capacity = Math.min(this.options.maxAgents, this.pending.length)
    this.positionScratch = new Float32Array(capacity * 2)
    this.packed = new Float32Array(capacity * AGENT_STRIDE)
    this.validate()
  }

  // --- setup -----------------------------------------------------------------

  private prepareFields(): void {
    for (const record of [...this.world.exits, ...this.world.waypoints]) {
      this.fields.ensure(record.id, record.goalCells)
    }
    for (const queue of this.world.queues) {
      this.fields.ensure(queue.id, queue.goalCells)
    }
  }

  /** A field to a specific point, solved once and never congestion-refreshed. */
  private ensurePointField(id: string, point: Vec2): boolean {
    if (this.fields.has(id)) return true
    if (this.fields.size > 96) return false
    const { col, row } = worldToCell(this.world.grid, point.x, point.y)
    const index = gridIndex(this.world.grid, col, row)
    if (index < 0 || index >= this.world.navBlocked.length) return false
    const cells: number[] = []
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = col + dx
        const r = row + dy
        if (c < 0 || r < 0 || c >= this.world.grid.cols || r >= this.world.grid.rows) continue
        const cell = gridIndex(this.world.grid, c, r)
        if (!this.world.navBlocked[cell]) cells.push(cell)
      }
    }
    if (cells.length === 0) return false
    this.fields.ensure(id, cells)
    return true
  }

  private buildSchedule(): void {
    const arrivals: PendingArrival[] = []
    this.scenario.populations.forEach((population, populationIndex) => {
      // Keyed on the population's place in the scenario, not its id: see
      // `QueueState.index`.
      const rng = this.rng.branch(`population:${populationIndex}`)
      const count = Math.max(0, Math.round(population.count))
      const groups = splitIntoGroups(count, population.groupSize, rng.branch('groups'))
      const times = scheduleArrivals(population.arrival, count, rng.branch('arrivals'))
      const weights = population.profileMix.map((entry) => entry.weight)
      const entryCount = Math.max(1, population.entryIds.length || this.world.entries.length)

      let index = 0
      groups.forEach((size, groupIndex) => {
        const groupTime = times[Math.min(index, times.length - 1)] ?? 0
        const entryIndex = rng.int(0, entryCount - 1)
        for (let member = 0; member < size && index < count; member++, index++) {
          const mixIndex = rng.weightedIndex(weights)
          const profileId = population.profileMix[mixIndex]?.profileId ?? 'adult'
          const profileIndex = Math.max(
            0,
            this.scenario.profiles.findIndex((p) => p.id === profileId),
          )
          arrivals.push({
            time: size > 1 ? groupTime : (times[index] ?? groupTime),
            populationIndex,
            profileIndex,
            entryIndex,
            groupId: groupIndex + populationIndex * 100000,
          })
        }
      })
    })
    arrivals.sort((a, b) => a.time - b.time)
    if (arrivals.length > this.options.maxAgents) {
      this.warnings.push(
        `This scenario asks for ${arrivals.length} people; the run was capped at ${this.options.maxAgents}.`,
      )
      arrivals.length = this.options.maxAgents
    }
    this.pending = arrivals
  }

  private validate(): void {
    if (this.world.entries.length === 0) {
      this.warnings.push('No entry areas: people are placed at the edge of the plan instead.')
    }
    if (this.world.exits.length === 0) {
      this.warnings.push('No exit areas: people stay in the venue once they finish.')
    }
    if (this.world.stats.freeCells === 0) {
      this.warnings.push('The plan has no walkable floor.')
    }
    // An alarm past the end of the run is never reached by `applyEvacuation`,
    // and the warning it would have pushed never arrives either — so the
    // results read as a clean evacuation for a drill that never happened. Say
    // it here instead, carrying both figures, rather than letting the run go
    // quiet about the one thing it was set up to measure.
    const alarm = this.scenario.evacuationAtS
    if (alarm !== null && alarm > this.scenario.durationS) {
      this.warnings.push(
        `The evacuation is set for ${Math.round(alarm)} s but the run ends at ${Math.round(
          this.scenario.durationS,
        )} s, so the alarm never sounds.`,
      )
    }
  }

  // --- spawning --------------------------------------------------------------

  private entryFor(population: number, entryIndex: number): DestinationRecord | null {
    const ids = this.scenario.populations[population]?.entryIds ?? []
    const named = ids
      .map((id) => this.world.entries.find((entry) => entry.id === id))
      .filter((entry): entry is DestinationRecord => Boolean(entry))
    const pool = named.length ? named : this.world.entries
    if (pool.length === 0) return null
    return pool[entryIndex % pool.length]
  }

  private spawnedThisTick: Array<{ x: number; y: number; radius: number }> = []

  private spawnDue(): void {
    this.spawnedThisTick.length = 0
    while (
      this.pendingCursor < this.pending.length &&
      this.pending[this.pendingCursor].time <= this.time
    ) {
      // If the doorway is full, the next person waits outside rather than
      // materialising inside somebody else — which ORCA cannot recover from and
      // which shows up as people squeezed through walls.
      if (!this.spawn(this.pending[this.pendingCursor])) return
      this.pendingCursor++
    }
  }

  /**
   * True when the point is far enough from everyone already in the venue.
   *
   * The spatial hash is rebuilt at the start of the tick, so it does not know
   * about anyone spawned during this one. Without also checking those, a batch
   * of arrivals all lands on the same spot and ORCA is handed an overlap it
   * cannot undo.
   */
  private isClear(x: number, y: number, radius: number): boolean {
    for (const placed of this.spawnedThisTick) {
      const minimum = (radius + placed.radius) * 1.05
      if ((placed.x - x) ** 2 + (placed.y - y) ** 2 < minimum * minimum) return false
    }
    let clear = true
    this.hash.query(x, y, radius + 0.6, (id) => {
      if (!clear) return
      const other = this.agents[id]
      if (!other) return
      const minimum = (radius + other.radius) * 1.05
      if ((other.x - x) ** 2 + (other.y - y) ** 2 < minimum * minimum) clear = false
    })
    return clear
  }

  private spawn(arrival: PendingArrival): boolean {
    const profile = this.scenario.profiles[arrival.profileIndex] ?? this.scenario.profiles[0]
    if (!profile) return true
    const rng = this.rng.branch(`agent:${this.agents.length}`)
    const entry = this.entryFor(arrival.populationIndex, arrival.entryIndex)
    let position = entry
      ? samplePointInDestination(this.world, entry, () => rng.next())
      : { x: this.world.bounds.minX + 1, y: this.world.bounds.minY + 1 }
    if (entry) {
      let placed = this.isClear(position.x, position.y, profile.radius)
      for (let attempt = 0; attempt < 12 && !placed; attempt++) {
        position = samplePointInDestination(this.world, entry, () => rng.next())
        placed = this.isClear(position.x, position.y, profile.radius)
      }
      if (!placed) return false
    }

    const speed =
      rng.truncatedNormal(
        profile.speed.mean,
        profile.speed.sd,
        profile.speed.min,
        profile.speed.max,
      ) * this.scenario.speedFactor

    const agent: Agent = {
      id: this.agents.length,
      populationIndex: arrival.populationIndex,
      profileIndex: arrival.profileIndex,
      groupId: arrival.groupId,
      radius: profile.radius,
      preferredSpeed: speed,
      maxSpeed: speed * 1.35,
      caution: profile.caution,
      assertiveness: profile.assertiveness,
      routeAwareness: this.scenario.routing.adaptive
        ? Math.min(1, Math.max(0, 1 - rng.uniform(0, this.scenario.routing.routeVariety * 2)))
        : 0,
      lateralBias: rng.uniform(-1, 1) * 0.12,
      x: position.x,
      y: position.y,
      vx: 0,
      vy: 0,
      heading: rng.uniform(-Math.PI, Math.PI),
      state: 'walking',
      stepIndex: 0,
      fieldTarget: null,
      exactTarget: null,
      facingTarget: null,
      spawnedAt: this.time,
      timer: 0,
      queueId: null,
      pendingQueueId: null,
      queueSlot: -1,
      serverIndex: -1,
      seatIndex: -1,
      joinedQueueAt: 0,
      leftAt: null,
      leftFrom: null,
      leftVia: null,
      distance: 0,
      stoppedTime: 0,
      queueTime: 0,
      replanCount: 0,
      gaveUp: false,
      lastStepBegun: -1,
      walkTime: 0,
      exitReviewAt: 0,
      allowedExits: null,
      bestDistance: Infinity,
      jamTime: 0,
      finishedAt: null,
      straightLineFrom: { x: position.x, y: position.y },
    }
    this.agents.push(agent)
    this.live.push(agent.id)
    this.beginStep(agent)
    this.spawnedThisTick.push({ x: agent.x, y: agent.y, radius: agent.radius })
    this.peakOccupancy = Math.max(this.peakOccupancy, this.live.length)
    return true
  }

  // --- itinerary -------------------------------------------------------------

  private itineraryOf(agent: Agent) {
    return this.scenario.populations[agent.populationIndex]?.itinerary ?? []
  }

  /** Enter the current itinerary step, choosing a destination for it. */
  private beginStep(agent: Agent): void {
    const itinerary = this.itineraryOf(agent)
    const rng = this.rng.branch(`step:${agent.id}:${agent.stepIndex}`)
    // Whatever they were walking towards before, this step replaces it.
    agent.pendingQueueId = null
    // Patience is per destination. Somebody who struggled to reach the bar has
    // not used up their allowance for finding the door afterwards.
    if (agent.lastStepBegun !== agent.stepIndex) {
      agent.lastStepBegun = agent.stepIndex
      agent.replanCount = 0
    }
    agent.walkTime = 0
    agent.bestDistance = Infinity

    while (agent.stepIndex < itinerary.length) {
      const step = itinerary[agent.stepIndex]
      const probability = step.probability ?? 1
      if (probability < 1 && rng.next() > probability) {
        agent.stepIndex++
        continue
      }
      switch (step.kind) {
        case 'goto':
        case 'dwell': {
          const zone =
            this.world.waypoints.find((w) => w.id === step.targetId) ??
            this.world.waypoints.find((w) => w.id === step.targetId)
          if (!zone) {
            agent.stepIndex++
            continue
          }
          agent.state = 'walking'
          agent.fieldTarget = zone.id
          agent.exactTarget = samplePointInDestination(this.world, zone, () => rng.next())
          agent.facingTarget = null
          agent.timer = step.duration ? sampleDistribution(rng, step.duration) : 0
          return
        }
        case 'service': {
          const queue = this.chooseQueue(agent, step)
          if (!queue) {
            agent.stepIndex++
            continue
          }
          // Walk to the back of the line first. Joining on arrival rather than
          // on intent is what makes the queue order match the physical order —
          // otherwise people who arrive last are told to stand at the front and
          // the whole queue gridlocks trying to swap places.
          agent.state = 'walking'
          agent.pendingQueueId = queue.record.id
          agent.facingTarget = null
          this.aimAtQueue(queue, agent, this.nextFreeSlot(queue))
          return
        }
        case 'seat': {
          const seat = this.claimSeat(agent, step.targetId, rng)
          if (seat === -1) {
            // No seat free: wait nearby rather than teleporting or vanishing.
            const fallback = this.world.waypoints.find((w) => w.id === step.targetId)
            agent.state = 'walking'
            agent.fieldTarget = fallback?.id ?? null
            agent.exactTarget = fallback
              ? samplePointInDestination(this.world, fallback, () => rng.next())
              : null
            agent.timer = step.duration ? sampleDistribution(rng, step.duration) : 120
            return
          }
          const record = this.world.seats[seat]
          agent.state = 'walking'
          agent.seatIndex = seat
          agent.exactTarget = record.position
          agent.facingTarget = record.facing
          agent.timer = step.duration ? sampleDistribution(rng, step.duration) : 900
          const fieldId = `seat:${record.furnitureId}`
          agent.fieldTarget = this.ensurePointField(fieldId, record.position) ? fieldId : null
          return
        }
        case 'exit': {
          // An itinerary may name the way out, and when it does that is not a
          // hint: a commuter heading for the platforms must not be sent out to
          // the street because the street door happens to be emptier. Naming
          // several leaves the choice between them open, which is where
          // congestion gets a say.
          this.headForExit(agent, Simulation.stepTargets(step))
          return
        }
      }
    }
    this.headForExit(agent)
  }

  /** Destinations an itinerary step names, in either of the two shapes it allows. */
  private static stepTargets(step: ItineraryStep): string[] {
    if (step.targetIds?.length) return step.targetIds
    return step.targetId ? [step.targetId] : []
  }

  private headForExit(agent: Agent, allowed?: readonly string[]): void {
    agent.allowedExits = allowed && allowed.length > 0 ? allowed : null
    const best = this.nearestExit(agent)
    agent.state = 'walking'
    agent.pendingQueueId = null
    agent.stepIndex = this.itineraryOf(agent).length
    // Stagger the first review across the crowd. Everybody reconsidering on the
    // same tick makes a queue shed people in lumps, which is both wrong and
    // very visible.
    agent.exitReviewAt = this.time + EXIT_REVIEW_INTERVAL * (0.5 + ((agent.id * 37) % 100) / 100)
    if (!best) {
      // Nowhere to go: stand still rather than walking into a wall.
      agent.fieldTarget = null
      agent.exactTarget = null
      return
    }
    agent.fieldTarget = best.id
    agent.exactTarget = best.center
    agent.facingTarget = null
  }

  /**
   * The way out this person would pick from where they are standing.
   *
   * Cost is travel time, and how much of the crowd is counted in it is the
   * person's own `routeAwareness` — the same number that decides whether they
   * follow the shortest route or the one that bends around a jam. Somebody who
   * pays no attention to congestion walks to the nearest door whatever is
   * happening at it; somebody who does will take a longer walk to a door they
   * can actually get through. A crowd of mixed awareness therefore splits
   * across the available doors by degrees rather than all at once, which is
   * what a real one does.
   */
  /**
   * Seconds of queueing a person should expect if they head for this door.
   *
   * The same reasoning `chooseQueue` uses for a counter — how many people are
   * ahead of you, divided by how fast the thing in front of them is going —
   * except that a door's rate is measured rather than configured. Eight people
   * through is enough to tell a wide door from a narrow one, and few enough to
   * know within the first seconds of a crush.
   *
   * A door nobody has used yet borrows the slowest rate anyone has measured,
   * rather than counting as free. Treating it as free is the obvious thing and
   * it is wrong in a way that bites: a door with no measurement looks like a
   * door with no queue however many people are already walking towards it, so
   * a crowd piles onto it and only discovers the queue it built once the door
   * starts metering. Borrowing a rate makes an unknown door fill up like a
   * known one. The slowest is the conservative choice — it will not promise
   * more capacity than anything in this venue has actually delivered.
   */
  private expectedExitWait(id: string): number {
    const load = this.exitLoads.get(id)
    if (!load) return 0
    const rate = this.exitRate(load) ?? this.slowestMeasuredExitRate()
    return rate === null ? 0 : load.heading / rate
  }

  /**
   * Seconds until this person is through this door, walk and queue together.
   *
   * Not the sum of the two. The queue drains while you walk towards it, so you
   * leave when the door has cleared everybody already ahead of you or when you
   * get there, whichever is later — and adding them instead double-counts the
   * walk, which is the whole advantage the far door has. Summed, the 40 m walk
   * across a hall reads as pure cost and a crowd under-uses the second door:
   * 26% of them took it, and the hall cleared in 128 s where the same crowd
   * splitting properly clears in 98.
   *
   * `awareness` is how much of the queue the person is paying attention to at
   * all. At zero this is just the walk, and they head for the nearest door
   * whatever is happening at it.
   */
  private exitCost(id: string, from: Vec2, awareness: number): number {
    const walk = this.fields.cost(id, from, awareness)
    if (!Number.isFinite(walk) || awareness <= 0.01) return walk
    const throughput = Math.max(walk, this.expectedExitWait(id))
    return walk * (1 - awareness) + throughput * awareness
  }

  /** People per second this door has actually let through, once that is known. */
  private exitRate(load: ExitLoad): number | null {
    if (load.through < 8) return null
    const elapsed = load.lastAt - load.firstAt
    return elapsed > 0 ? load.through / elapsed : null
  }

  /** The slowest rate any door in this venue has demonstrated, if any has. */
  private slowestMeasuredExitRate(): number | null {
    let slowest: number | null = null
    for (const load of this.exitLoads.values()) {
      const rate = this.exitRate(load)
      if (rate !== null && (slowest === null || rate < slowest)) slowest = rate
    }
    return slowest
  }

  /**
   * The ways out this person is willing to use.
   *
   * Everything, unless their itinerary named some — in which case those, and
   * only if at least one of them still exists in the plan. A named exit that
   * has been deleted since leaves them with every exit rather than none.
   */
  private exitsFor(agent: Agent): readonly DestinationRecord[] {
    if (!agent.allowedExits) return this.world.exits
    const allowed = this.world.exits.filter((exit) => agent.allowedExits?.includes(exit.id))
    return allowed.length > 0 ? allowed : this.world.exits
  }

  /** Recount who is heading where. One pass, once a step. */
  private updateExitLoads(): void {
    for (const load of this.exitLoads.values()) load.heading = 0
    for (const id of this.live) {
      const target = this.agents[id]?.fieldTarget
      if (!target) continue
      const load = this.exitLoads.get(target)
      if (load) load.heading++
    }
  }

  private nearestExit(agent: Agent): DestinationRecord | null {
    let best: DestinationRecord | null = null
    let bestCost = Infinity
    for (const exit of this.exitsFor(agent)) {
      const cost = this.exitCost(exit.id, { x: agent.x, y: agent.y }, agent.routeAwareness)
      if (cost < bestCost) {
        bestCost = cost
        best = exit
      }
    }
    return best ?? this.world.exits[0] ?? null
  }

  /**
   * Reconsider the way out.
   *
   * Choosing once on the way in is not enough: the queue that makes the far
   * door worth the walk has not formed yet when a person sets off, and a model
   * that never looks again has everybody queueing at the nearest door while an
   * identical one stands open — 300 people through a single 1.2 m door in a
   * hall that had two of them, and the second never used.
   */
  private reviewExit(agent: Agent): void {
    agent.exitReviewAt = this.time + EXIT_REVIEW_INTERVAL
    const current = agent.fieldTarget
    if (!current || agent.routeAwareness <= 0.01 || this.exitsFor(agent).length < 2) return
    const here = { x: agent.x, y: agent.y }
    const currentCost = this.exitCost(current, here, agent.routeAwareness)
    if (!Number.isFinite(currentCost)) return
    let best: DestinationRecord | null = null
    let bestCost = currentCost * EXIT_SWITCH_MARGIN
    for (const exit of this.exitsFor(agent)) {
      if (exit.id === current) continue
      const cost = this.exitCost(exit.id, here, agent.routeAwareness)
      if (cost < bestCost) {
        bestCost = cost
        best = exit
      }
    }
    if (!best) return
    agent.fieldTarget = best.id
    agent.exactTarget = best.center
    // They are going somewhere else now, so how well they were doing at getting
    // to the old door says nothing about whether they are stuck.
    agent.walkTime = 0
    agent.bestDistance = Infinity
  }

  private claimSeat(agent: Agent, zoneId: string | undefined, rng: Rng): number {
    const zone = zoneId ? this.world.waypoints.find((w) => w.id === zoneId) : undefined
    let best = -1
    let bestScore = Infinity
    for (let i = 0; i < this.world.seats.length; i++) {
      if (this.seatTaken[i]) continue
      const seat = this.world.seats[i]
      if (zone && !pointInPolygon(seat.position, zone.polygon)) continue
      // Prefer near seats, but jitter so a table fills plausibly rather than in index order.
      const score = distance(seat.position, { x: agent.x, y: agent.y }) * rng.uniform(0.85, 1.25)
      if (score < bestScore) {
        bestScore = score
        best = i
      }
    }
    if (best >= 0) this.seatTaken[best] = 1
    return best
  }

  /**
   * Pick which counter to head for.
   *
   * People do not join the nearest queue, they join the one they expect to get
   * through soonest — so the estimate is walking time plus the line ahead
   * multiplied by the mean service time and divided by the number of staff.
   * With one candidate this is just that counter.
   */
  private chooseQueue(agent: Agent, step: ItineraryStep): QueueState | undefined {
    const ids = step.targetIds?.length ? step.targetIds : step.targetId ? [step.targetId] : []
    const candidates = ids
      .map((id) => this.queues.get(id))
      .filter((queue): queue is QueueState => Boolean(queue))
    if (candidates.length <= 1) return candidates[0]

    const here = { x: agent.x, y: agent.y }
    let best: QueueState | undefined
    let bestCost = Infinity
    for (const queue of candidates) {
      if (this.time < queue.record.opensAt || this.time >= queue.record.closesAt) continue
      const walk = this.fields.cost(queue.record.id, here)
      const ahead = queue.waiting.length + queue.servers.filter((id) => id >= 0).length
      const serviceMean = distributionMean(queue.record.serviceTime)
      const wait = (ahead * serviceMean) / Math.max(1, queue.record.serverCount)
      // Walk and wait are added here, and taken as a maximum when choosing
      // between exits, and that difference is deliberate rather than drift.
      // Strictly the line moves while you walk to it, so a maximum is the
      // better estimate of your own wait, and for exits it is worth a third off
      // the time to clear a hall. For counters it was measured and it is not:
      // mean wait fell a tenth, but total desk utilisation fell from 3.00 to
      // 2.13 across four registration desks, because a maximum sends people to
      // a far desk whose queue will have drained by the time they arrive and
      // leaves the near one idle meanwhile. Better for the person, worse for
      // the venue. Doors have no such problem — nobody serves a door — so they
      // get the sharper estimate and counters keep the conservative one.
      const cost = (Number.isFinite(walk) ? walk : 120) + wait
      if (cost < bestCost) {
        bestCost = cost
        best = queue
      }
    }
    return best ?? candidates[0]
  }

  /** The slot index the next person to arrive should aim for. */
  private nextFreeSlot(queue: QueueState): number {
    return Math.max(0, queue.waiting.length)
  }

  private joinQueue(agent: Agent, queue: QueueState): void {
    agent.state = 'queuing'
    agent.queueId = queue.record.id
    agent.pendingQueueId = null
    agent.joinedQueueAt = this.time
    queue.waiting.push(agent.id)
    queue.maxQueue = Math.max(queue.maxQueue, queue.waiting.length)
    this.assignQueueSlots(queue)
  }

  private assignQueueSlots(queue: QueueState): void {
    queue.waiting.forEach((id, index) => {
      const agent = this.agents[id]
      if (!agent || agent.state !== 'queuing') return
      agent.queueSlot = index
      agent.facingTarget = queueSlotFacing(queue.record, index)
      this.aimAtQueueSlot(queue, agent)
    })
  }

  /**
   * Point someone at the place in a queue they are heading for.
   *
   * Approaching from across the room, they follow the flow field to the back of
   * the line. Once they are on or near the line they walk *along* it rather
   * than cutting straight across, which is what keeps a queue that bends round
   * a room looking like a queue instead of a scrum — and, more importantly,
   * stops them stalling at the field's goal while their slot is still metres
   * further up the line.
   */
  /**
   * Where slot `index` actually is.
   *
   * Past the end of the drawn queue line the slots continue in a straight
   * extension, which can run through a wall or off the floor. Anything that
   * lands outside walkable space is snapped to the nearest cell that is not,
   * so an overflowing queue backs up into the room instead of pressing a crowd
   * into the geometry.
   */
  private slotPosition(queue: QueueState, index: number): Vec2 {
    const record = queue.record
    if (index < record.slots.length) return record.slots[index]
    const cached = queue.overflowPositions.get(index)
    if (cached) return cached
    const ideal = queueSlotPosition(record, index)
    let resolved = ideal
    const { col, row } = worldToCell(this.world.grid, ideal.x, ideal.y)
    const inside =
      col >= 0 &&
      row >= 0 &&
      col < this.world.grid.cols &&
      row < this.world.grid.rows &&
      !this.world.navBlocked[gridIndex(this.world.grid, col, row)]
    if (!inside) {
      const cell = nearestFreeCell(this.world.grid, this.world.navBlocked, ideal)
      if (cell >= 0) {
        const c = cell % this.world.grid.cols
        const r = (cell / this.world.grid.cols) | 0
        resolved = cellCenter(this.world.grid, c, r)
      } else {
        resolved = record.overflowAnchor
      }
    }
    queue.overflowPositions.set(index, resolved)
    return resolved
  }

  /**
   * Is the straight line from a person to a point wide enough to walk?
   *
   * Sampled from the clearance field at grid resolution, which is signed: a
   * sample inside a wall or a table comes back negative, so anything that would
   * not fit a body fails. A target the person cannot walk straight to is not
   * necessarily unreachable — it usually just needs going round — so a failure
   * here means keep following the field, not give up.
   */
  private lineIsWalkable(agent: Agent, to: Vec2): boolean {
    const dx = to.x - agent.x
    const dy = to.y - agent.y
    const length = Math.hypot(dx, dy)
    if (length < 1e-6) return true
    const steps = Math.ceil(length / this.world.grid.cellSize)
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const clearance = sampleField(
        this.world.grid,
        this.world.clearance,
        agent.x + dx * t,
        agent.y + dy * t,
        10,
      )
      if (clearance < agent.radius) return false
    }
    return true
  }

  /**
   * Heading for somebody steering at their exact target with no usable field.
   *
   * Usually that means they are nearly there and the potential has flattened
   * out, and aiming at the target is exactly right. But a person can also be
   * squeezed into the sliver beside a wall that the navigation grid excludes
   * for body clearance, and there the potential was never solved at all: the
   * field has no gradient to offer and aiming at the target walks into the wall
   * and stays there. One person in a 150-person evacuation ended up pinned like
   * that for the remaining five minutes of the run.
   *
   * So the outward push is for that case only — standing somewhere the field
   * cannot reach — and not for every blocked line. A target that is genuinely
   * unreachable has to keep reading as unreachable, so that the person gives up
   * on it and the run reports that it happened.
   */
  private directHeading(agent: Agent, target: Vec2): Vec2 {
    const toTarget = normalize({ x: target.x - agent.x, y: target.y - agent.y })
    if (!this.inNavDeadZone(agent.x, agent.y)) return toTarget
    if (this.lineIsWalkable(agent, target)) return toTarget
    const out = this.clearanceGradient(agent.x, agent.y)
    return out.x === 0 && out.y === 0 ? toTarget : out
  }

  /** Is this point somewhere the navigation grid never solved a route for? */
  private inNavDeadZone(x: number, y: number): boolean {
    const { cols, rows, cellSize, originX, originY } = this.world.grid
    const col = Math.round((x - originX) / cellSize - 0.5)
    const row = Math.round((y - originY) / cellSize - 0.5)
    if (col < 0 || row < 0 || col >= cols || row >= rows) return true
    return this.world.navBlocked[row * cols + col] === 1
  }

  private aimAtQueue(queue: QueueState, agent: Agent, slotIndex: number): void {
    const record = queue.record
    const slotPosition = this.slotPosition(queue, slotIndex)
    const here = { x: agent.x, y: agent.y }
    if (distance(here, slotPosition) <= DIRECT_RANGE && this.lineIsWalkable(agent, slotPosition)) {
      agent.exactTarget = slotPosition
      agent.fieldTarget = null
      return
    }
    const onLine = closestPointOnPolyline(record.line, here)
    const tailPosition = record.slots[record.slots.length - 1]
    const nearLine = onLine.distance <= 2.0 || distance(here, tailPosition) <= 2.5
    if (!nearLine) {
      agent.exactTarget = tailPosition
      agent.fieldTarget = record.id
      return
    }
    const slotArc = Math.min(slotIndex * record.spacing, record.lineLength)
    const startArc = onLine.distance <= 2.0 ? onLine.arc : record.lineLength
    const nextArc = Math.max(slotArc, startArc - 1.5)
    agent.exactTarget = pointAlongPolyline(record.line, nextArc)
    agent.fieldTarget = null
  }

  private aimAtQueueSlot(queue: QueueState, agent: Agent): void {
    this.aimAtQueue(queue, agent, agent.queueSlot)
  }

  private updateQueues(dt: number): void {
    for (const queue of this.queues.values()) {
      const record = queue.record
      const open = this.time >= record.opensAt && this.time < record.closesAt
      let busy = 0
      for (let s = 0; s < queue.servers.length; s++) {
        const occupant = queue.servers[s]
        if (occupant >= 0) {
          busy++
          const agent = this.agents[occupant]
          if (!agent) {
            queue.servers[s] = -1
            continue
          }
          if (agent.state === 'served' && this.time >= queue.serverFreeAt[s]) {
            queue.servers[s] = -1
            queue.served++
            agent.queueId = null
            agent.serverIndex = -1
            agent.stepIndex++
            this.beginStep(agent)
          }
          continue
        }
        if (!open) continue
        const headId = queue.waiting[0]
        if (headId === undefined) continue
        const head = this.agents[headId]
        if (!head || head.state !== 'queuing') {
          queue.waiting.shift()
          continue
        }
        // Only start service once the person has actually reached the front.
        const slot = record.slots[0]
        if (distance({ x: head.x, y: head.y }, slot) > record.spacing * 1.6) continue

        queue.waiting.shift()
        const rng = this.rng.branch(`service:${queue.index}:${queue.served}:${head.id}`)
        const duration = Math.max(0.5, sampleDistribution(rng, record.serviceTime))
        head.state = 'served'
        head.serverIndex = s
        head.exactTarget = servicePositionFor(record, s)
        head.facingTarget = Math.atan2(
          record.servers[s % record.servers.length].y - head.exactTarget.y,
          record.servers[s % record.servers.length].x - head.exactTarget.x,
        )
        head.fieldTarget = null
        queue.servers[s] = head.id
        queue.serverFreeAt[s] = this.time + duration
        const wait = this.time - head.joinedQueueAt
        queue.totalWait += wait
        queue.maxWait = Math.max(queue.maxWait, wait)
        queue.totalService += duration
        this.assignQueueSlots(queue)
        busy++
      }
      queue.busyTime += (busy / Math.max(1, queue.servers.length)) * dt
      queue.maxQueue = Math.max(queue.maxQueue, queue.waiting.length)
    }
  }

  // --- stepping --------------------------------------------------------------

  /** Advance the simulation by one timestep. */
  step(dt = this.options.timeStep): void {
    this.time += dt
    this.rebuildHash()
    this.spawnDue()
    this.applyEvacuation()
    this.updateQueues(dt)
    this.updateStates(dt)
    this.updateDensity()
    this.fields.update(this.time, this.density.values)
    this.steer(dt)
    this.resolveContacts(dt)
    this.integrate(dt)
    this.updateExitLoads()
    this.relaxOverlaps()
    this.accumulateAreas(dt)
    this.accumulateLos(dt)
  }

  private applyEvacuation(): void {
    const at = this.scenario.evacuationAtS
    if (at === null || this.evacuated || this.time < at) return
    this.evacuated = true
    for (const id of this.live) {
      const agent = this.agents[id]
      if (!agent || agent.state === 'done') continue
      this.leaveQueue(agent)
      if (agent.seatIndex >= 0) {
        this.seatTaken[agent.seatIndex] = 0
        agent.seatIndex = -1
      }
      // Under evacuation everyone moves with urgency, as observed in drills.
      agent.preferredSpeed = Math.min(agent.maxSpeed, agent.preferredSpeed * 1.25)
      agent.caution = Math.max(0.6, agent.caution * 0.8)
      this.headForExit(agent)
    }
    this.warnings.push(`Evacuation triggered at ${Math.round(at)} s.`)
  }

  /**
   * Give a stuck person a fresh destination of the same kind, and shake their
   * exact target so they do not walk straight back into whatever held them.
   */
  private replan(agent: Agent): void {
    const rng = this.rng.branch(`replan:${agent.id}:${Math.round(this.time)}`)
    agent.walkTime = 0
    agent.bestDistance = Infinity
    const itinerary = this.itineraryOf(agent)
    agent.replanCount++
    // After a few attempts, accept that this person cannot do what they came
    // for and send them to an exit. Leaving them wandering would quietly skew
    // every average for the rest of the run, and a plan that strands people is
    // worth reporting rather than hiding.
    if (agent.replanCount > 3 || agent.stepIndex >= itinerary.length) {
      if (agent.replanCount > 3 && !agent.gaveUp) {
        agent.gaveUp = true
        this.abandoned++
        if (agent.seatIndex >= 0) {
          this.seatTaken[agent.seatIndex] = 0
          agent.seatIndex = -1
        }
        this.leaveQueue(agent)
      }
      this.headForExit(agent)
    } else {
      this.beginStep(agent)
    }
    if (agent.exactTarget) {
      agent.exactTarget = {
        x: agent.exactTarget.x + rng.uniform(-0.5, 0.5),
        y: agent.exactTarget.y + rng.uniform(-0.5, 0.5),
      }
    }
  }

  private leaveQueue(agent: Agent): void {
    if (!agent.queueId) return
    const queue = this.queues.get(agent.queueId)
    if (queue) {
      const index = queue.waiting.indexOf(agent.id)
      if (index >= 0) queue.waiting.splice(index, 1)
      if (agent.serverIndex >= 0 && queue.servers[agent.serverIndex] === agent.id) {
        queue.servers[agent.serverIndex] = -1
      }
      this.assignQueueSlots(queue)
    }
    agent.queueId = null
    agent.pendingQueueId = null
    agent.serverIndex = -1
    agent.queueSlot = -1
  }

  private updateStates(dt: number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const agent = this.agents[this.live[i]]
      if (!agent) continue
      const arrived =
        agent.exactTarget !== null &&
        distance({ x: agent.x, y: agent.y }, agent.exactTarget) <=
          ARRIVE_RADIUS + agent.radius * 0.5

      switch (agent.state) {
        case 'walking': {
          if (agent.pendingQueueId) {
            const queue = this.queues.get(agent.pendingQueueId)
            if (!queue) {
              agent.pendingQueueId = null
              break
            }
            const slot = this.nextFreeSlot(queue)
            const target = this.slotPosition(queue, slot)
            const reach = Math.max(1.5, queue.record.spacing * 2.5)
            if (distance({ x: agent.x, y: agent.y }, target) <= reach) {
              this.joinQueue(agent, queue)
            } else {
              this.aimAtQueue(queue, agent, slot)
            }
            break
          }
          const step = this.itineraryOf(agent)[agent.stepIndex]
          if (agent.stepIndex >= this.itineraryOf(agent).length) {
            // Heading for the exit.
            // Containment only: `arrived` is a fixed radius around a point, so
            // it would re-widen a narrow door and pinch a wide one.
            if (agent.leftFrom === null && this.atAnyExit(agent)) this.beginLeaving(agent)
            if (agent.leftFrom !== null) {
              const out = distance({ x: agent.x, y: agent.y }, agent.leftFrom)
              const stalled = this.time - (agent.leftAt ?? this.time) > EXIT_TAIL_TIMEOUT
              if (out >= EXIT_TAIL || stalled) this.finish(agent, i)
            }
            break
          }
          if (!arrived) break
          if (agent.seatIndex >= 0) {
            agent.state = 'seated'
            agent.vx = 0
            agent.vy = 0
            break
          }
          if (step && step.kind === 'dwell') {
            agent.state = 'dwelling'
            break
          }
          agent.stepIndex++
          this.beginStep(agent)
          break
        }
        case 'queuing': {
          agent.queueTime += dt
          const queue = agent.queueId ? this.queues.get(agent.queueId) : undefined
          if (queue) this.aimAtQueueSlot(queue, agent)
          break
        }
        case 'served':
          // Held by the queue manager until the server frees.
          break
        case 'seated':
        case 'dwelling': {
          agent.timer -= dt
          if (agent.timer <= 0) {
            if (agent.seatIndex >= 0) {
              this.seatTaken[agent.seatIndex] = 0
              agent.seatIndex = -1
            }
            agent.stepIndex++
            this.beginStep(agent)
          }
          break
        }
        case 'waiting':
        case 'done':
          break
      }
    }
  }

  /**
   * Has this person left?
   *
   * Reaching the doorway counts, not just standing on its centre. Someone
   * pressed along the wall beside a door has plainly got out, and requiring
   * them to reach an exact point leaves a handful of people stranded at every
   * exit — which then shows up as an evacuation that never finishes.
   */
  /**
   * Has this person actually left?
   *
   * The polygon of a door exit is the gap itself — the leaf's clear width,
   * straddling the wall — so standing inside it means standing in the doorway,
   * which is the one place a crowd has to come through one or two abreast. That
   * is what makes a door meter a crowd, and it is the whole basis of an egress
   * figure.
   *
   * This used to accept anyone within `radius + 0.35` of the polygon's *edge*,
   * which quietly dilated every doorway by 1.16 m of capture front and let
   * people vanish while still out on the open floor. A 2'0" door and an 8'0"
   * pair then cleared a hall at almost the same rate — four times the width
   * bought 1.3 times the flow — and every egress number the tool produced was
   * between five and ten times too optimistic. Width has to bite, so the test
   * is containment, with no margin.
   */
  private atAnyExit(agent: Agent): boolean {
    const point = { x: agent.x, y: agent.y }
    for (const exit of this.world.exits) {
      if (pointInPolygon(point, exit.polygon)) return true
    }
    return false
  }

  /**
   * Walk somebody out of the doorway they have just reached.
   *
   * They are pointed straight on, well past the tail, so that the last stride
   * easing in `desiredVelocity` never slows them inside the gap, and taken off
   * the flow field, which would otherwise keep steering them at the threshold
   * they are standing in.
   */
  private beginLeaving(agent: Agent): void {
    agent.leftAt = this.time
    agent.leftFrom = { x: agent.x, y: agent.y }
    agent.leftVia = agent.fieldTarget
    const speed = Math.hypot(agent.vx, agent.vy)
    const heading = speed > 0.05 ? Math.atan2(agent.vy, agent.vx) : agent.heading
    const far = EXIT_TAIL * 6
    agent.exactTarget = {
      x: agent.x + Math.cos(heading) * far,
      y: agent.y + Math.sin(heading) * far,
    }
    agent.fieldTarget = null
  }

  private finish(agent: Agent, liveIndex: number): void {
    agent.state = 'done'
    // Timed at the threshold: the tail past it is bookkeeping, not journey.
    agent.finishedAt = agent.leftAt ?? this.time
    const via = agent.leftVia ?? agent.fieldTarget
    const load = via ? this.exitLoads.get(via) : undefined
    if (load) {
      if (load.through === 0) load.firstAt = this.time
      load.through++
      load.lastAt = this.time
    }
    this.live.splice(liveIndex, 1)
    this.completed++
    const straight = distance(agent.straightLineFrom, { x: agent.x, y: agent.y })
    this.journeys.push({
      id: agent.id,
      populationId: this.scenario.populations[agent.populationIndex]?.id ?? '',
      profileId: this.scenario.profiles[agent.profileIndex]?.id ?? '',
      spawnedAt: agent.spawnedAt,
      finishedAt: agent.finishedAt,
      distance: agent.distance,
      stoppedTime: agent.stoppedTime,
      queueTime: agent.queueTime,
      totalTime: agent.finishedAt - agent.spawnedAt,
      directness: agent.distance > 0.1 ? Math.min(1, straight / agent.distance) : 1,
    })
  }

  private updateDensity(): void {
    const count = this.live.length
    if (this.positionScratch.length < count * 2) {
      this.positionScratch = new Float32Array(count * 2)
    }
    for (let i = 0; i < count; i++) {
      const agent = this.agents[this.live[i]]
      this.positionScratch[i * 2] = agent.x
      this.positionScratch[i * 2 + 1] = agent.y
    }
    this.density.update(this.positionScratch, count)
  }

  private rebuildHash(): void {
    const { minX, minY, maxX, maxY } = this.world.bounds
    this.hash.reset(minX, minY, maxX, maxY, Math.max(1, this.live.length))
    for (const id of this.live) {
      const agent = this.agents[id]
      this.hash.countAt(agent.x, agent.y)
    }
    this.hash.finalize()
    for (const id of this.live) {
      const agent = this.agents[id]
      this.hash.placeAt(agent.x, agent.y, id)
    }
  }

  /** Preferred velocity, then ORCA, for every live agent. */
  private steer(dt: number): void {
    const count = this.live.length
    if (count === 0) return
    this.rebuildHash()

    for (const id of this.live) {
      const agent = this.agents[id]
      const pref = this.preferredVelocity(agent)

      // Stationary people still occupy space: they take no avoidance
      // responsibility, so those walking past have to go around them.
      const stationary = agent.state === 'seated' || agent.state === 'served'
      if (stationary) {
        agent.vx = 0
        agent.vy = 0
        if (agent.facingTarget !== null) agent.heading = agent.facingTarget
        continue
      }

      // Air this person keeps around themselves, at the crowding they are in.
      // It is added to each *neighbour's* radius rather than their own, because
      // their own is what ORCA measures walls with and people brush a doorjamb
      // in a way they will not brush a stranger.
      const localDensity = this.density.othersAt(
        agent.x,
        agent.y,
        sampleField(this.world.grid, this.density.values, agent.x, agent.y, 0),
      )
      const ownSpace = personalSpace(localDensity, agent.assertiveness)

      this.neighbourScratch.length = 0
      this.hash.query(agent.x, agent.y, NEIGHBOUR_RANGE, (otherId) => {
        if (otherId === id) return
        if (this.neighbourScratch.length >= MAX_NEIGHBOURS) return
        const other = this.agents[otherId]
        if (!other) return
        const dx = other.x - agent.x
        const dy = other.y - agent.y
        if (dx * dx + dy * dy > NEIGHBOUR_RANGE * NEIGHBOUR_RANGE) return
        const otherStationary = other.state === 'seated' || other.state === 'served'
        this.neighbourScratch.push({
          position: { x: other.x, y: other.y },
          velocity: { x: other.vx, y: other.vy },
          radius: other.radius + ownSpace + personalSpace(localDensity, other.assertiveness),
          maxSpeed: other.maxSpeed,
          prefVelocity: { x: other.vx, y: other.vy },
          timeHorizon: 2.5,
          timeHorizonObst: 0.9,
          // Someone who is not going to move cannot help avoid a collision.
          responsibility: otherStationary ? 0 : 0.5,
        })
      })

      this.obstacleIndex.query(agent.x, agent.y, NEIGHBOUR_RANGE, this.obstacleScratch)

      const state = this.orcaState
      state.position.x = agent.x
      state.position.y = agent.y
      state.velocity.x = agent.vx
      state.velocity.y = agent.vy
      state.radius = agent.radius
      state.maxSpeed = agent.maxSpeed
      state.prefVelocity.x = pref.x
      state.prefVelocity.y = pref.y

      // In a tight crowd ORCA's linear program becomes infeasible and its
      // relaxed fallback can hand every agent a velocity of zero at once — a
      // deadlock that no amount of simulated time resolves. Looking a shorter
      // way ahead as pressure builds is the standard remedy: people in a crush
      // stop planning two seconds out and deal with the person in front.
      const pressure = Math.min(1, agent.jamTime / 5)
      state.timeHorizon = Math.max(0.5, 2.2 * agent.caution * (1 - 0.65 * pressure))
      state.timeHorizonObst = Math.max(0.35, 0.8 * (1 - 0.55 * pressure))

      // A neighbour who will not move takes none of the responsibility.
      const anyStationary = this.neighbourScratch.some((n) => n.responsibility === 0)
      state.responsibility = anyStationary ? 0.75 : 0.5

      const velocity = computeNewVelocity(
        state,
        this.neighbourScratch,
        this.world.obstacles,
        this.obstacleScratch,
      )
      agent.vx = velocity.x
      agent.vy = velocity.y

      // If avoidance still leaves them motionless after several seconds, let
      // them creep towards where they are going. The overlap relaxation keeps
      // the crowd at a physical packing, so this presses forward without
      // anybody passing through anybody.
      if (agent.jamTime > 4 && Math.hypot(agent.vx, agent.vy) < 0.05) {
        const push = Math.hypot(pref.x, pref.y)
        if (push > 1e-6) {
          const creep = 0.14
          agent.vx = (pref.x / push) * creep
          agent.vy = (pref.y / push) * creep
        }
      }
    }
    void dt
  }

  private preferredVelocity(agent: Agent): Vec2 {
    if (agent.state === 'seated' || agent.state === 'served') return { x: 0, y: 0 }

    let dirX = 0
    let dirY = 0
    let speed = agent.preferredSpeed

    const target = agent.exactTarget
    const toTarget = target ? distance({ x: agent.x, y: agent.y }, target) : Infinity

    if (target && toTarget <= DIRECT_RANGE && this.lineIsWalkable(agent, target)) {
      const d = normalize({ x: target.x - agent.x, y: target.y - agent.y })
      dirX = d.x
      dirY = d.y
      // Ease in over the last stride so people stop on their mark.
      if (toTarget < 1.2) speed *= Math.max(0.12, toTarget / 1.2)
    } else if (agent.fieldTarget) {
      const route = this.fields.direction(
        agent.fieldTarget,
        { x: agent.x, y: agent.y },
        agent.routeAwareness,
      )
      // A degenerate route means the field has nothing left to say — usually
      // because the person is already standing inside a large destination.
      // Fall back to heading for the exact spot they were given.
      if (route && (route.dx !== 0 || route.dy !== 0)) {
        dirX = route.dx
        dirY = route.dy
      } else if (target) {
        const d = this.directHeading(agent, target)
        dirX = d.x
        dirY = d.y
      }
    } else if (target) {
      const d = this.directHeading(agent, target)
      dirX = d.x
      dirY = d.y
    }

    if (dirX === 0 && dirY === 0) return { x: 0, y: 0 }

    const clearance = sampleField(this.world.grid, this.world.clearance, agent.x, agent.y, 10)

    // Each person keeps to their own line, which spreads a crowd across an open
    // hall instead of funnelling it down one ideal path. The bias fades out in
    // anything narrow, where the only sensible line is the middle of the gap.
    if (agent.lateralBias !== 0 && toTarget > 1.5) {
      const room = Math.min(1, Math.max(0, (clearance - agent.radius - 0.4) / 1.2))
      const bias = agent.lateralBias * room
      if (bias !== 0) {
        const baseX = dirX
        const baseY = dirY
        dirX = baseX - baseY * bias
        dirY = baseY + baseX * bias
        const length = Math.hypot(dirX, dirY)
        dirX /= length
        dirY /= length
      }
    }

    // Keep clear of walls: nudge away when the clearance field says we are close.
    if (clearance < agent.radius + 0.35) {
      const push = this.clearanceGradient(agent.x, agent.y)
      const strength = (agent.radius + 0.35 - clearance) * 1.6
      dirX += push.x * strength
      dirY += push.y * strength
      const length = Math.hypot(dirX, dirY)
      if (length > 1e-6) {
        dirX /= length
        dirY /= length
      }
    }

    // People slow down in a crowd even before anyone is in their way — but they
    // read the floor they are walking into, not a ring around themselves, and
    // not their own body, so the lookahead moves the sample and their own
    // contribution comes off it. Looking through a wall would read the empty
    // floor on the far side as free space, so a blocked sight line falls back to
    // where the walker is standing.
    let senseX = agent.x + dirX * PACE_LOOKAHEAD
    let senseY = agent.y + dirY * PACE_LOOKAHEAD
    let senseDistance = PACE_LOOKAHEAD
    if (sampleField(this.world.grid, this.world.clearance, senseX, senseY, 0) < agent.radius) {
      senseX = agent.x
      senseY = agent.y
      senseDistance = 0
    }
    const sampled = sampleField(this.world.grid, this.density.values, senseX, senseY, 0)
    speed *= speedFromDensity(this.density.othersAt(senseX, senseY, sampled, senseDistance))

    // Somebody who has been going nowhere for a few seconds tries stepping
    // around the obstruction instead of pushing into it. Real crowds unjam by
    // shuffling sideways, and without it a dense group can lock solid: every
    // person pressing straight ahead leaves nobody with room to give way.
    if (agent.jamTime > 2.5) {
      const side = agent.id % 2 === 0 ? 1 : -1
      const strength = Math.min(1, (agent.jamTime - 2.5) / 3)
      // Both components rotate from the heading they started at. Feeding the
      // already-rotated x back into y is not a rotation at all: somebody walking
      // north at full sidestep strength came out heading due west, having lost
      // every bit of their forward component, which is the opposite of getting
      // round the obstruction.
      const aheadX = dirX
      const aheadY = dirY
      dirX = aheadX - aheadY * side * strength
      dirY = aheadY + aheadX * side * strength
      const length = Math.hypot(dirX, dirY)
      if (length > 1e-6) {
        dirX /= length
        dirY /= length
      }
      speed = Math.max(speed, agent.preferredSpeed * 0.35)
    }

    return { x: dirX * speed, y: dirY * speed }
  }

  /** Direction of increasing clearance, i.e. away from the nearest wall. */
  private clearanceGradient(x: number, y: number): Vec2 {
    const h = this.world.grid.cellSize
    const left = sampleField(this.world.grid, this.world.clearance, x - h, y, 0)
    const right = sampleField(this.world.grid, this.world.clearance, x + h, y, 0)
    const down = sampleField(this.world.grid, this.world.clearance, x, y - h, 0)
    const up = sampleField(this.world.grid, this.world.clearance, x, y + h, 0)
    const gx = right - left
    const gy = up - down
    const length = Math.hypot(gx, gy)
    return length > 1e-6 ? { x: gx / length, y: gy / length } : { x: 0, y: 0 }
  }

  private integrate(dt: number): void {
    for (const id of this.live) {
      const agent = this.agents[id]
      const nextX = agent.x + agent.vx * dt
      const nextY = agent.y + agent.vy * dt
      const moved = Math.hypot(nextX - agent.x, nextY - agent.y)
      agent.x = nextX
      agent.y = nextY
      agent.distance += moved

      const speed = moved / dt
      if (speed < SLOW_SPEED && agent.state !== 'seated' && agent.state !== 'served') {
        agent.stoppedTime += dt
      }
      // Track how long someone has been going nowhere, so the steering layer
      // can try stepping around rather than pressing harder.
      if (agent.state === 'walking' || agent.state === 'queuing') {
        if (speed < 0.06) agent.jamTime += dt
        else if (speed > 0.25) agent.jamTime = 0
      } else {
        agent.jamTime = 0
      }
      if (speed > 0.05) {
        agent.heading = Math.atan2(agent.vy, agent.vx)
      } else if (agent.facingTarget !== null) {
        agent.heading = agent.facingTarget
      }

      // Safety net: ORCA can be pushed into geometry in a dense jam. Nudge back
      // out along the clearance gradient rather than letting anyone tunnel.
      // ORCA prevents new collisions but will not resolve an existing overlap,
      // and in a dense jam people do get pressed into geometry. The clearance
      // field gives a cheap, stable way to ease them back out.
      // Nobody leaves the modelled area, whatever else goes wrong.
      const bounds = this.world.bounds
      agent.x = Math.min(Math.max(agent.x, bounds.minX + 0.3), bounds.maxX - 0.3)
      agent.y = Math.min(Math.max(agent.y, bounds.minY + 0.3), bounds.maxY - 0.3)

      const clearance = sampleField(this.world.grid, this.world.clearance, agent.x, agent.y, 10)
      if (clearance < agent.radius) {
        const push = this.clearanceGradient(agent.x, agent.y)
        const correction = Math.min(agent.radius - clearance, 0.25)
        agent.x += push.x * correction
        agent.y += push.y * correction
      }

      // Someone who has barely moved for half a minute is stuck on geometry we
      // did not anticipate. Re-planning beats leaving them there for the rest
      // of the run, quietly skewing every average.
      // Somebody on their way out looks again at which way out, now that the
      // queues they will meet actually exist.
      if (
        agent.state === 'walking' &&
        this.time >= agent.exitReviewAt &&
        agent.fieldTarget !== null &&
        this.exitLoads.has(agent.fieldTarget)
      ) {
        this.reviewExit(agent)
      }

      // Are they closing on where they are going?
      //
      // Progress towards the target is the right test, not speed and not
      // elapsed time. Someone inching through a busy doorway is fine and will
      // get there; someone circling a hall at full speed, or pressed against
      // geometry they cannot pass, will not — and both look identical to a
      // stopwatch.
      if (agent.state === 'walking') {
        agent.walkTime += dt
        if (agent.walkTime >= 30) {
          agent.walkTime = 0
          const target = agent.exactTarget
          const remaining = target ? distance({ x: agent.x, y: agent.y }, target) : 0
          if (remaining < agent.bestDistance - 0.5) {
            agent.bestDistance = remaining
          } else {
            // Not closing — but waiting your turn at a busy door is not being
            // stuck, and re-planning someone in a queue of thirty people only
            // sends them somewhere worse. Only count it against them when
            // there is nobody in the way — and "nobody" has to mean nobody
            // else. The field counts this person too, and their own kernel
            // peak is most of this threshold on its own, so reading it raw let
            // one neighbour standing nearby excuse any amount of not getting
            // anywhere. People pressed against geometry sat there for the rest
            // of the run without ever being counted as stuck.
            const others = this.density.othersAt(
              agent.x,
              agent.y,
              sampleField(this.world.grid, this.density.values, agent.x, agent.y, 0),
            )
            if (others <= 0.8) this.replan(agent)
          }
        }
      } else {
        agent.walkTime = 0
        agent.bestDistance = Infinity
      }
    }
  }

  /**
   * Nobody walks into anybody.
   *
   * ORCA guarantees no new collision only while its linear program is
   * feasible. In a crush it is not, and the relaxed fallback returns the
   * least-bad velocity it can find — which, when a hundred people are pressing
   * at one door, is still a velocity that closes the gap. `relaxOverlaps` then
   * has to undo the overlap afterwards against a capped budget, and in a real
   * crush it cannot keep up: a single-exit evacuation measured pairs 0.271 m
   * inside each other on a 0.46 m pair distance, which is most of a body.
   *
   * So contact is resolved where it is cheap to resolve — in velocity, before
   * anybody moves, and *before* the overlap exists rather than after. A pair is
   * allowed to close only as fast as the gap between them permits in one step:
   * approach until they touch, and no faster. Waiting until they already
   * overlap is a step too late, because a pair a millimetre clear of contact is
   * not yet overlapping and can cross most of a body in the tick that follows.
   *
   * Only the closing part of the relative velocity is touched. Everything along
   * the tangent survives, so a crowd still slides and shuffles past itself and
   * this cannot deadlock anybody the way zeroing a velocity outright would.
   *
   * Two passes, because contact comes in chains: fixing A against B changes B,
   * which was also being held off C. Two is most of the benefit; the positional
   * relaxation after integration mops up what is left.
   */
  private resolveContacts(dt: number): void {
    const count = this.live.length
    if (count < 2 || dt <= 0) return
    for (let pass = 0; pass < CONTACT_PASSES; pass++) {
      let touched = false
      for (let i = 0; i < count; i++) {
        const agent = this.agents[this.live[i]]
        this.hash.query(agent.x, agent.y, agent.radius * 2 + 0.6, (otherId) => {
          if (otherId <= agent.id) return
          const other = this.agents[otherId]
          if (!other || other.state === 'done') return
          const dx = other.x - agent.x
          const dy = other.y - agent.y
          const distanceSq = dx * dx + dy * dy
          if (distanceSq < 1e-12) return
          const length = Math.sqrt(distanceSq)
          const touching = agent.radius + other.radius
          const nx = dx / length
          const ny = dy / length
          // Along the line between them, positive is separating.
          const closing = (other.vx - agent.vx) * nx + (other.vy - agent.vy) * ny
          // The fastest they may close and still not be inside each other after
          // this step. Negative while there is a gap to spend.
          const allowed = (touching - length) / dt
          if (closing >= allowed) return
          // Someone seated or being served holds their place; the mover gives way.
          const agentFixed = agent.state === 'seated' || agent.state === 'served'
          const otherFixed = other.state === 'seated' || other.state === 'served'
          if (agentFixed && otherFixed) return
          const agentShare = agentFixed ? 0 : otherFixed ? 1 : 0.5
          const otherShare = otherFixed ? 0 : agentFixed ? 1 : 0.5
          const correction = allowed - closing
          agent.vx -= nx * correction * agentShare
          agent.vy -= ny * correction * agentShare
          other.vx += nx * correction * otherShare
          other.vy += ny * correction * otherShare
          touched = true
        })
      }
      if (!touched) break
    }
  }

  /**
   * Push apart anyone who ended the step overlapping.
   *
   * ORCA prevents collisions it can see coming, but when a crowd is pressed
   * against a wall or a closed counter its linear program becomes infeasible
   * and the relaxed fallback lets people drift into each other. Without this
   * pass a jam keeps compressing and reports densities no real crowd reaches —
   * twenty-plus persons per square metre — which then poisons every measure
   * derived from density. One positional relaxation per step is enough to hold
   * the crowd at a physical packing.
   */
  private relaxOverlaps(): void {
    const count = this.live.length
    if (count < 2) return
    // The hash is built once and reused across the passes. Each pass moves a
    // body by at most a third of the step budget, well inside the slack in the
    // query radius below, so the neighbour set cannot go stale within a step.
    this.rebuildHash()
    if (this.overlapScratch.length < count * 2) this.overlapScratch = new Float32Array(count * 2)
    const corrections = this.overlapScratch

    const index = new Map<number, number>()
    for (let i = 0; i < count; i++) index.set(this.live[i], i)

    const bounds = this.world.bounds
    for (let pass = 0; pass < SEPARATION.iterations; pass++) {
      corrections.fill(0, 0, count * 2)

      for (let i = 0; i < count; i++) {
        const agent = this.agents[this.live[i]]
        this.hash.query(agent.x, agent.y, agent.radius * 2 + 0.4, (otherId) => {
          if (otherId <= agent.id) return
          const slot = index.get(otherId)
          if (slot === undefined) return
          const other = this.agents[otherId]
          const dx = other.x - agent.x
          const dy = other.y - agent.y
          const minimum = agent.radius + other.radius
          const distanceSq = dx * dx + dy * dy
          if (distanceSq >= minimum * minimum || distanceSq < 1e-12) return
          const length = Math.sqrt(distanceSq)
          const penetration = (minimum - length) * 0.5
          const nx = dx / length
          const ny = dy / length
          // Someone seated or being served holds their place; the mover gives way.
          const agentFixed = agent.state === 'seated' || agent.state === 'served'
          const otherFixed = other.state === 'seated' || other.state === 'served'
          const agentShare = agentFixed ? 0 : otherFixed ? 1 : 0.5
          const otherShare = otherFixed ? 0 : agentFixed ? 1 : 0.5
          corrections[i * 2] -= nx * penetration * 2 * agentShare
          corrections[i * 2 + 1] -= ny * penetration * 2 * agentShare
          corrections[slot * 2] += nx * penetration * 2 * otherShare
          corrections[slot * 2 + 1] += ny * penetration * 2 * otherShare
        })
      }

      let resolved = true
      for (let i = 0; i < count; i++) {
        const agent = this.agents[this.live[i]]
        const scale = separationScale(corrections[i * 2], corrections[i * 2 + 1])
        if (scale === 0) continue
        resolved = false
        agent.x += corrections[i * 2] * scale
        agent.y += corrections[i * 2 + 1] * scale
        agent.x = Math.min(Math.max(agent.x, bounds.minX + 0.3), bounds.maxX - 0.3)
        agent.y = Math.min(Math.max(agent.y, bounds.minY + 0.3), bounds.maxY - 0.3)
      }
      // Nobody was touching: the remaining passes have nothing to do.
      if (resolved) break
    }

    // Push anyone the passes left inside geometry back out — once for the step,
    // not once per pass. The passes are iterations of one correction and the
    // constraint belongs after them, not inside the loop; running it per pass
    // would triple the shove somebody gets while easing through a gap with a
    // few centimetres of slack, for no gain, since the last pass is the only
    // one whose positions survive the step anyway.
    for (let i = 0; i < count; i++) {
      const agent = this.agents[this.live[i]]
      const clearance = sampleField(this.world.grid, this.world.clearance, agent.x, agent.y, 10)
      if (clearance >= agent.radius) continue
      const push = this.clearanceGradient(agent.x, agent.y)
      const correction = Math.min(agent.radius - clearance, 0.2)
      agent.x += push.x * correction
      agent.y += push.y * correction
    }
  }

  /**
   * Per-area statistics.
   *
   * Occupancy counts the people actually inside the polygon, and the area's
   * density is derived from that count rather than sampled from the density
   * field: the field is smoothed over 0.7 m and would bleed a crowd standing
   * just outside the line into the measurement.
   */
  private accumulateAreas(dt: number): void {
    if (this.areas.length === 0) return
    for (const area of this.areas) {
      let inside = 0
      let speedSum = 0
      for (const id of this.live) {
        const agent = this.agents[id]
        if (
          agent.x < area.bounds.minX ||
          agent.x > area.bounds.maxX ||
          agent.y < area.bounds.minY ||
          agent.y > area.bounds.maxY
        ) {
          continue
        }
        if (!pointInPolygon({ x: agent.x, y: agent.y }, area.record.polygon)) continue
        inside++
        speedSum += Math.hypot(agent.vx, agent.vy)
      }

      const density = area.record.area > 0 ? inside / area.record.area : 0
      area.elapsed += dt
      area.peakOccupancy = Math.max(area.peakOccupancy, inside)
      area.occupancySeconds += inside * dt
      area.peakDensity = Math.max(area.peakDensity, density)
      area.densitySeconds += density * dt
      area.speedSeconds += speedSum * dt
      area.personSeconds += inside * dt

      const band = losIndex(density)
      area.worstLosIndex = Math.max(area.worstLosIndex, band)
      if (band >= WALKWAY_LOS.length - 1) area.secondsAtLosF += dt
      if (band >= WALKWAY_LOS.length - 2) area.secondsAtLosE += dt
      if (density >= CROWD_SAFETY.warnDensity) area.secondsAtCrushRisk += dt
    }
  }

  private accumulateLos(dt: number): void {
    for (const id of this.live) {
      const agent = this.agents[id]
      const density = sampleField(this.world.grid, this.density.values, agent.x, agent.y, 0)
      this.peakDensity = Math.max(this.peakDensity, density)
      this.losSeconds[losIndex(density)] += dt
    }
  }

  // --- output ----------------------------------------------------------------

  /** Internal state for a single person, for debugging and the inspector. */
  inspect(id: number) {
    const agent = this.agents[id]
    if (!agent) return null
    return {
      id: agent.id,
      x: agent.x,
      y: agent.y,
      state: agent.state,
      stepIndex: agent.stepIndex,
      fieldTarget: agent.fieldTarget,
      exactTarget: agent.exactTarget,
      queueId: agent.queueId,
      queueSlot: agent.queueSlot,
      speed: Math.hypot(agent.vx, agent.vy),
      queueTime: agent.queueTime,
      jamTime: agent.jamTime,
      replanCount: agent.replanCount,
      gaveUp: agent.gaveUp,
      distanceToTarget: agent.exactTarget
        ? distance({ x: agent.x, y: agent.y }, agent.exactTarget)
        : null,
      route: agent.fieldTarget
        ? this.fields.direction(agent.fieldTarget, { x: agent.x, y: agent.y }, agent.routeAwareness)
        : null,
      clearance: sampleField(this.world.grid, this.world.clearance, agent.x, agent.y, 10),
      // The crowd this person is in, which does not include this person. The
      // field itself counts everybody, because a person standing alone still
      // occupies floor and that is what level of service measures — but asked
      // about one person, the honest answer leaves their own body out. Without
      // that, somebody alone in an empty hall reports 0.40 persons/m², which is
      // their own kernel peak and nothing else.
      density: this.density.othersAt(
        agent.x,
        agent.y,
        sampleField(this.world.grid, this.density.values, agent.x, agent.y, 0),
      ),
    }
  }

  /** Ids of the people currently waiting at a queue, head first. */
  queueOrder(id: string): number[] {
    return this.queues.get(id)?.waiting ?? []
  }

  get currentTime(): number {
    return this.time
  }

  get isFinished(): boolean {
    return (
      this.time >= this.scenario.durationS ||
      (this.pendingCursor >= this.pending.length && this.live.length === 0)
    )
  }

  get densityField(): Float32Array {
    return this.density.values
  }

  /** Packed agent state for the renderer. The buffer is reused between calls. */
  snapshot(): SimSnapshot {
    const count = this.live.length
    if (this.packed.length < count * AGENT_STRIDE) {
      this.packed = new Float32Array(count * AGENT_STRIDE)
    }
    for (let i = 0; i < count; i++) {
      const agent = this.agents[this.live[i]]
      const base = i * AGENT_STRIDE
      this.packed[base + AGENT_FIELD.x] = agent.x
      this.packed[base + AGENT_FIELD.y] = agent.y
      this.packed[base + AGENT_FIELD.heading] = agent.heading
      this.packed[base + AGENT_FIELD.speed] = Math.hypot(agent.vx, agent.vy)
      this.packed[base + AGENT_FIELD.state] = agentStateIndex(agent.state)
      this.packed[base + AGENT_FIELD.profile] = agent.profileIndex
      this.packed[base + AGENT_FIELD.population] = agent.populationIndex
      this.packed[base + AGENT_FIELD.waited] = agent.queueTime
      this.packed[base + AGENT_FIELD.radius] = agent.radius
      this.packed[base + AGENT_FIELD.id] = agent.id
    }
    return {
      time: this.time,
      agents: this.packed.subarray(0, count * AGENT_STRIDE),
      count,
      stats: this.stats(),
    }
  }

  stats(): SimStats {
    let speedSum = 0
    let walkingSpeedSum = 0
    let walking = 0
    let stopped = 0
    let densitySum = 0
    let peak = 0
    let waitSum = 0
    let maxWait = 0
    for (const id of this.live) {
      const agent = this.agents[id]
      const speed = Math.hypot(agent.vx, agent.vy)
      speedSum += speed
      // Somebody sitting at a table, or standing in a queue where they are
      // meant to be, is not congestion. Only people actually trying to get
      // somewhere count towards how well the crowd is flowing.
      if (agent.state === 'walking') {
        walking++
        walkingSpeedSum += speed
        if (speed < SLOW_SPEED) stopped++
      }
      const density = sampleField(this.world.grid, this.density.values, agent.x, agent.y, 0)
      densitySum += density
      peak = Math.max(peak, density)
      if (agent.state === 'queuing') {
        const wait = this.time - agent.joinedQueueAt
        waitSum += wait
        maxWait = Math.max(maxWait, wait)
      }
    }
    const count = Math.max(1, this.live.length)
    const queueing = this.live.filter((id) => this.agents[id].state === 'queuing').length
    const worst = losFor(peak)
    return {
      time: this.time,
      spawned: this.agents.length,
      active: this.live.length,
      completed: this.completed,
      meanDensity: densitySum / count,
      peakDensity: peak,
      meanSpeed: speedSum / count,
      meanWalkingSpeed: walking > 0 ? walkingSpeedSum / walking : 0,
      walking,
      stoppedShare: walking > 0 ? stopped / walking : 0,
      meanWait: queueing > 0 ? waitSum / queueing : 0,
      maxWait,
      queueLengths: [...this.queues.values()].map((queue) => ({
        id: queue.record.id,
        name: queue.record.name,
        waiting: queue.waiting.length,
        served: queue.served,
        meanWait: queue.served > 0 ? queue.totalWait / queue.served : 0,
      })),
      worstLos: worst.level,
    }
  }

  /** What happened inside each measurement area over the whole run. */
  private areaSummaries(): AreaSummary[] {
    return this.areas.map((area) => {
      const elapsed = Math.max(area.elapsed, 1e-6)
      return {
        id: area.record.id,
        name: area.record.name,
        areaSqm: area.record.area,
        peakOccupancy: area.peakOccupancy,
        meanOccupancy: area.occupancySeconds / elapsed,
        peakDensity: area.peakDensity,
        meanDensity: area.densitySeconds / elapsed,
        meanSpeed: area.personSeconds > 0 ? area.speedSeconds / area.personSeconds : 0,
        personSeconds: area.personSeconds,
        secondsAtLosE: area.secondsAtLosE,
        secondsAtLosF: area.secondsAtLosF,
        secondsAtCrushRisk: area.secondsAtCrushRisk,
        worstLos: WALKWAY_LOS[area.worstLosIndex].level,
      }
    })
  }

  private serviceSummaries(): ServiceSummary[] {
    return [...this.queues.values()].map((queue) => ({
      id: queue.record.id,
      name: queue.record.name,
      servers: queue.servers.length,
      served: queue.served,
      meanWait: queue.served > 0 ? queue.totalWait / queue.served : 0,
      maxWait: queue.maxWait,
      meanService: queue.served > 0 ? queue.totalService / queue.served : 0,
      utilisation: this.time > 0 ? Math.min(1, queue.busyTime / this.time) : 0,
      maxQueue: queue.maxQueue,
      unserved: queue.waiting.length,
    }))
  }

  /** Aggregate results for the finished (or paused) run. */
  summary(): RunSummary {
    const finished = this.journeys.filter((j) => j.totalTime !== null)
    const times = finished.map((j) => j.totalTime as number).sort((a, b) => a - b)
    const mean = times.length ? times.reduce((s, t) => s + t, 0) / times.length : 0
    const p95 = times.length
      ? times[Math.min(times.length - 1, Math.floor(times.length * 0.95))]
      : 0
    const queueTimes = this.journeys.map((j) => j.queueTime)
    const services = this.serviceSummaries()
    const totalLos = Array.from(this.losSeconds).reduce((s, v) => s + v, 0) || 1
    const losShare: Record<string, number> = {}
    WALKWAY_LOS.forEach((band, index) => {
      losShare[band.level] = this.losSeconds[index] / totalLos
    })

    const clearanceIndex = Math.floor(finished.length * 0.95)
    const clearance = finished.length
      ? ([...finished].sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))[
          Math.min(finished.length - 1, clearanceIndex)
        ].finishedAt ?? 0)
      : 0

    const warnings = [...this.warnings]
    if (this.abandoned > 0) {
      warnings.push(
        `${this.abandoned} ${this.abandoned === 1 ? 'person' : 'people'} could not reach somewhere on their route and left instead. Check for a destination that is blocked or hard to get to.`,
      )
    }
    if (this.live.length > 0 && this.time >= this.scenario.durationS) {
      warnings.push(
        `${this.live.length} people had not left when the run ended; extend the duration for a complete picture.`,
      )
    }
    for (const service of services) {
      if (service.unserved > 0) {
        warnings.push(`${service.name} still had ${service.unserved} people waiting at the end.`)
      }
    }

    return {
      durationS: this.time,
      seed: this.scenario.seed,
      totalPeople: this.agents.length,
      completed: this.completed,
      meanJourney: mean,
      p95Journey: p95,
      meanWait: services.length
        ? services.reduce((s, v) => s + v.meanWait * v.served, 0) /
          Math.max(
            1,
            services.reduce((s, v) => s + v.served, 0),
          )
        : 0,
      maxWait: services.reduce((s, v) => Math.max(s, v.maxWait), 0),
      meanQueueTime: queueTimes.length
        ? queueTimes.reduce((s, t) => s + t, 0) / queueTimes.length
        : 0,
      clearanceTime: clearance,
      walkableArea: this.world.stats.walkableArea,
      peakOccupancy: this.peakOccupancy,
      peakDensity: this.peakDensity,
      losShare,
      services,
      areas: this.areaSummaries(),
      warnings,
    }
  }

  get allJourneys(): AgentJourney[] {
    return this.journeys
  }

  /** Cell centres and density, for the heat map. */
  densitySample(index: number): { point: Vec2; value: number } {
    const col = index % this.world.grid.cols
    const row = (index / this.world.grid.cols) | 0
    return { point: cellCenter(this.world.grid, col, row), value: this.density.values[index] }
  }
}
