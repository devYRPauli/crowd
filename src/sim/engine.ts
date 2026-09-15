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

import type { Plan, Scenario } from '../core/model/types'
import type { Vec2 } from '../core/math/vec2'
import { Rng, sampleDistribution } from '../core/math/random'
import { distance, normalize } from '../core/math/vec2'
import { closestPointOnPolyline, pointAlongPolyline, pointInPolygon } from '../core/math/geometry'
import { buildWorld, queueSlotFacing, queueSlotPosition, samplePointInDestination, servicePositionFor, type DestinationRecord, type QueueRecord, type SimWorld } from './world'
import { cellCenter, gridIndex, sampleField, worldToCell } from './nav/eikonal'
import { DensityField, FlowFieldCache, speedFromDensity } from './nav/flowFields'
import { computeNewVelocity, type OrcaAgentState } from './avoidance/orca'
import { ObstacleIndex } from './avoidance/obstacleIndex'
import { SpatialHash } from './spatialHash'
import { scheduleArrivals, splitIntoGroups } from './agents/arrivals'
import {
  AGENT_FIELD,
  AGENT_STRIDE,
  DEFAULT_SIM_OPTIONS,
  agentStateIndex,
  type AgentJourney,
  type AgentState,
  type RunSummary,
  type ServiceSummary,
  type SimOptions,
  type SimStats,
} from './types'
import { WALKWAY_LOS, losFor, losIndex } from './metrics/los'

/** How close counts as having arrived at an exact target. */
const ARRIVE_RADIUS = 0.34
/** Within this range a person steers straight at their target instead of following the field. */
const DIRECT_RANGE = 3.5
const NEIGHBOUR_RANGE = 5.0
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
  stuckTime: number
  progressFrom: Vec2
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

interface QueueState {
  record: QueueRecord
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
  private seatTaken: Uint8Array

  private time = 0
  private completed = 0
  private journeys: AgentJourney[] = []
  private losSeconds = new Float32Array(WALKWAY_LOS.length)
  private peakOccupancy = 0
  private peakDensity = 0
  private warnings: string[] = []
  private evacuated = false

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
    this.density = new DensityField(this.world.grid)
    this.obstacleIndex = new ObstacleIndex(this.world.obstacles, this.world.bounds, 2)
    this.hash = new SpatialHash(NEIGHBOUR_RANGE)
    this.seatTaken = new Uint8Array(this.world.seats.length)

    for (const queue of this.world.queues) {
      this.queues.set(queue.id, {
        record: queue,
        waiting: [],
        servers: new Array(queue.serverCount).fill(-1),
        serverFreeAt: new Array(queue.serverCount).fill(0),
        served: 0,
        totalWait: 0,
        maxWait: 0,
        totalService: 0,
        busyTime: 0,
        maxQueue: 0,
      })
    }

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
      const rng = this.rng.branch(`population:${population.id}`)
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

  private spawnDue(): void {
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

  /** True when the point is far enough from everyone already in the venue. */
  private isClear(x: number, y: number, radius: number): boolean {
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
      rng.truncatedNormal(profile.speed.mean, profile.speed.sd, profile.speed.min, profile.speed.max) *
      this.scenario.speedFactor

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
      distance: 0,
      stoppedTime: 0,
      queueTime: 0,
      stuckTime: 0,
      progressFrom: { x: position.x, y: position.y },
      finishedAt: null,
      straightLineFrom: { x: position.x, y: position.y },
    }
    this.agents.push(agent)
    this.live.push(agent.id)
    this.beginStep(agent)
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
          const queue = this.queues.get(step.targetId ?? '')
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
          agent.fieldTarget = queue.record.id
          agent.exactTarget = this.joinPoint(queue)
          agent.facingTarget = null
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
          this.headForExit(agent)
          return
        }
      }
    }
    this.headForExit(agent)
  }

  private headForExit(agent: Agent): void {
    const best = this.nearestExit(agent)
    agent.state = 'walking'
    agent.stepIndex = this.itineraryOf(agent).length
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

  private nearestExit(agent: Agent): DestinationRecord | null {
    let best: DestinationRecord | null = null
    let bestCost = Infinity
    for (const exit of this.world.exits) {
      const cost = this.fields.cost(exit.id, { x: agent.x, y: agent.y })
      if (cost < bestCost) {
        bestCost = cost
        best = exit
      }
    }
    return best ?? this.world.exits[0] ?? null
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
      const score =
        distance(seat.position, { x: agent.x, y: agent.y }) * rng.uniform(0.85, 1.25)
      if (score < bestScore) {
        bestScore = score
        best = i
      }
    }
    if (best >= 0) this.seatTaken[best] = 1
    return best
  }

  /** Where the next person to arrive should stand. */
  private joinPoint(queue: QueueState): Vec2 {
    const occupied = queue.waiting.length + queue.servers.filter((id) => id >= 0).length
    return queueSlotPosition(queue.record, Math.max(0, occupied))
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
   * Point a queueing person at where they should be standing.
   *
   * Someone approaching from across the room follows the flow field to the back
   * of the line. Once they are on the line they walk *along* it to their slot
   * rather than cutting straight to it, which is what keeps a serpentine queue
   * looking like a queue instead of a scrum.
   */
  private aimAtQueueSlot(queue: QueueState, agent: Agent): void {
    const record = queue.record
    const slotPosition = queueSlotPosition(record, agent.queueSlot)
    const here = { x: agent.x, y: agent.y }
    const toSlot = distance(here, slotPosition)
    if (toSlot <= DIRECT_RANGE) {
      agent.exactTarget = slotPosition
      agent.fieldTarget = null
      return
    }
    const onLine = closestPointOnPolyline(record.line, here)
    if (onLine.distance > 2.0) {
      agent.exactTarget = queueSlotPosition(record, record.slots.length - 1)
      agent.fieldTarget = record.id
      return
    }
    const slotArc = Math.min(agent.queueSlot * record.spacing, record.lineLength)
    const nextArc = Math.max(slotArc, onLine.arc - 1.5)
    agent.exactTarget = pointAlongPolyline(record.line, nextArc)
    agent.fieldTarget = null
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
        const slot = queueSlotPosition(record, 0)
        if (distance({ x: head.x, y: head.y }, slot) > record.spacing * 1.6) continue

        queue.waiting.shift()
        const rng = this.rng.branch(`service:${record.id}:${queue.served}:${head.id}`)
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
    this.integrate(dt)
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
    const itinerary = this.itineraryOf(agent)
    if (agent.stepIndex >= itinerary.length) {
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
        distance({ x: agent.x, y: agent.y }, agent.exactTarget) <= ARRIVE_RADIUS + agent.radius * 0.5

      switch (agent.state) {
        case 'walking': {
          if (agent.pendingQueueId) {
            const queue = this.queues.get(agent.pendingQueueId)
            if (!queue) {
              agent.pendingQueueId = null
              break
            }
            const target = this.joinPoint(queue)
            agent.exactTarget = target
            const reach = Math.max(1.5, queue.record.spacing * 2.5)
            const toJoin = distance({ x: agent.x, y: agent.y }, target)
            if (toJoin <= reach) {
              this.joinQueue(agent, queue)
            } else if (toJoin <= DIRECT_RANGE) {
              agent.fieldTarget = null
            }
            break
          }
          const step = this.itineraryOf(agent)[agent.stepIndex]
          if (agent.stepIndex >= this.itineraryOf(agent).length) {
            // Heading for the exit.
            if (arrived || this.insideAnyExit(agent)) this.finish(agent, i)
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

  private insideAnyExit(agent: Agent): boolean {
    const point = { x: agent.x, y: agent.y }
    for (const exit of this.world.exits) {
      if (pointInPolygon(point, exit.polygon)) return true
    }
    return false
  }

  private finish(agent: Agent, liveIndex: number): void {
    agent.state = 'done'
    agent.finishedAt = this.time
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
          radius: other.radius,
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
      state.timeHorizon = 2.2 * agent.caution
      state.timeHorizonObst = 0.8
      state.responsibility = 0.5

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

    if (target && toTarget <= DIRECT_RANGE) {
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
      if (route) {
        dirX = route.dx
        dirY = route.dy
      } else if (target) {
        const d = normalize({ x: target.x - agent.x, y: target.y - agent.y })
        dirX = d.x
        dirY = d.y
      }
    } else if (target) {
      const d = normalize({ x: target.x - agent.x, y: target.y - agent.y })
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

    // People slow down in a crowd even before anyone is in their way.
    const localDensity = sampleField(this.world.grid, this.density.values, agent.x, agent.y, 0)
    speed *= speedFromDensity(localDensity)

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
      if (agent.state === 'walking') {
        agent.stuckTime += dt
        if (agent.stuckTime >= 30) {
          const progress = distance({ x: agent.x, y: agent.y }, agent.progressFrom)
          if (progress < 0.75) this.replan(agent)
          agent.stuckTime = 0
          agent.progressFrom = { x: agent.x, y: agent.y }
        }
      } else {
        agent.stuckTime = 0
        agent.progressFrom = { x: agent.x, y: agent.y }
      }
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
      stuckTime: agent.stuckTime,
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
    let stopped = 0
    let densitySum = 0
    let peak = 0
    let waitSum = 0
    let maxWait = 0
    for (const id of this.live) {
      const agent = this.agents[id]
      const speed = Math.hypot(agent.vx, agent.vy)
      speedSum += speed
      if (speed < SLOW_SPEED) stopped++
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
      stoppedShare: stopped / count,
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
    const p95 = times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] : 0
    const queueTimes = this.journeys.map((j) => j.queueTime)
    const services = this.serviceSummaries()
    const totalLos = Array.from(this.losSeconds).reduce((s, v) => s + v, 0) || 1
    const losShare: Record<string, number> = {}
    WALKWAY_LOS.forEach((band, index) => {
      losShare[band.level] = this.losSeconds[index] / totalLos
    })

    const clearanceIndex = Math.floor(finished.length * 0.95)
    const clearance = finished.length
      ? [...finished].sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))[
          Math.min(finished.length - 1, clearanceIndex)
        ].finishedAt ?? 0
      : 0

    const warnings = [...this.warnings]
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
          Math.max(1, services.reduce((s, v) => s + v.served, 0))
        : 0,
      maxWait: services.reduce((s, v) => Math.max(s, v.maxWait), 0),
      meanQueueTime: queueTimes.length ? queueTimes.reduce((s, t) => s + t, 0) / queueTimes.length : 0,
      clearanceTime: clearance,
      walkableArea: this.world.stats.walkableArea,
      peakOccupancy: this.peakOccupancy,
      peakDensity: this.peakDensity,
      losShare,
      services,
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
