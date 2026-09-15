# CROWD

**Constraint-aware Rehearsal and Optimisation of Walking Dynamics.**

Draw a venue in 3D. Say who turns up and what they came to do. Watch them move
through it, and read what went wrong.

CROWD runs entirely in the browser. There is no install, no backend, no licence
and no import step: the plan *is* the model. Every wall you draw is a wall people
collide with, every counter you place is a server with a queue, and every area
you mark is somewhere the simulation measures.

---

## Why this exists

The tools for this problem split into two camps, and neither covers the loop.

**Floor-plan editors** — Floorplanner, Sweet Home 3D, Planner 5D — have the
drawing experience but produce a static picture. They cannot tell you that a
200-person reception will produce a fourteen-minute bar queue.

**Crowd simulators** — MassMotion, Legion, Viswalk, Pathfinder — have the
numbers, but they want a BIM model as input, a desktop install, a five-figure
licence and a trained operator. Nobody draws a room in MassMotion.

CROWD is the gap: draw the room, press Run, change the room, press Run again.
The edit-to-answer loop is seconds, not hours, which is what makes it useful
while you are still deciding where the bar goes.

---

## Running it

```sh
npm install
npm run dev          # http://localhost:5173
```

```sh
npm run build        # typecheck + production bundle into dist/
npm run preview      # serve the build
npm run check        # typecheck, lint and unit tests
npm run smoke        # build, serve, and drive the real app in a real browser
```

The build is a static site. `dist/` can be served from anywhere — no headers,
no COOP/COEP, no server-side anything. That constraint is deliberate and it
shaped several decisions below.

---

## Drawing a venue

| | |
|---|---|
| `V` | Select and move |
| `W` | Walls — click to chain, **type a length and press Enter** to place it exactly |
| `R` | Room — drag a rectangle and get four walls |
| `D` / `N` | Doorway / window — move onto a wall and click; it cuts the wall |
| `F` | Furniture — 49 items, oriented against the nearest wall automatically |
| `Z` | Areas — entry, exit, destination, seating, keep-clear, blocked, measurement |
| `S` | Service point — a counter with staff, a service time and a queue |
| `Q` | Reshape a queue by dragging its points |
| `M` | Tape measure |

The left button always belongs to the active tool. Navigation lives on the
right and middle buttons, the wheel, and Space-drag. Press `?` for the full
keymap.

Some details that make the difference between a plan editor that feels precise
and one that feels approximate:

- **Snapping is measured in screen pixels, not metres**, so it behaves the same
  whether you are looking at a whole floor or at one doorway. Wall endpoints beat
  wall edges, which beat alignment guides, which beat the grid.
- **Rooms are derived, not drawn.** Enclosed spaces are recovered from the wall
  centrelines by extracting the bounded faces of their planar graph, so floors
  and areas come out of the walls you actually drew and update when you delete one.
- **Transform handles are projected to screen space**, so dragging and rotating
  work identically in the plan view and in a tilted 3D view, and never disappear
  behind geometry.
- **Every number in the inspector is editable.** Typing a wall length moves its
  far end. Plans come with measurements.
- **Trace over an existing plan.** Drop in a scan, scale it against a dimension
  you know, and draw on top.

---

## Saying who comes

A scenario is one or more **populations**, each with a headcount, an arrival
profile, a mix of walking abilities, and an **itinerary**:

> arrive at the main door → queue at whichever registration desk is quickest →
> sit in the session room for 25 minutes → leave by the side door

Arrivals can be evenly spread, random (Poisson), in waves, front-loaded, or
clustered around a peak. A service step can name several counters at once, and
people join the one they expect to get through soonest — which is how parallel
desks actually balance, rather than everyone queueing at the first one.

Shipped walking profiles, with free-flow speeds from Weidmann's review: adult
(1.34 m/s), in a hurry (1.65), older adult (0.97), child (1.10), wheelchair user
(0.89), staff (1.40), with luggage (1.10).

Six starter venues cover the shapes of movement the tool is for: a coffee bar,
conference registration, a gallery opening, a polling station, a transit
concourse, and a banquet hall with an unannounced evacuation an hour in.

---

## How the simulation works

Three layers, each doing one job.

**1. Route — flow fields over a Fast Marching solve.**
Each destination gets a potential field solved with the Godunov upwind scheme on
a uniform grid, so its gradient is smooth and free of the 22.5° artefacts a
Dijkstra grid produces. One solve serves every person heading there.

Each destination carries *two* fields. The static one is the shortest path. The
congested one is re-solved periodically with local crowd density lowering the
traversal speed, so its gradient bends around a crowd. Every person follows one
or the other according to how congestion-aware they are — which is what produces
a genuine route split at a bottleneck instead of one thick column.

**2. Avoid — ORCA.**
Optimal Reciprocal Collision Avoidance, ported faithfully from the RVO2
reference, turns "where I want to go" into "where I can go" given the neighbours
and walls right now. Because it is reciprocal, two people resolve a head-on
without either of them stopping.

ORCA has a known failure mode: in a tight crowd its linear program becomes
infeasible and the relaxed fallback can hand every agent a velocity of zero at
once — a deadlock no amount of simulated time resolves. CROWD shortens the time
horizon as pressure builds (people in a crush stop planning two seconds ahead and
deal with the person in front) and lets a jammed person creep forward. A
positional relaxation pass after integration keeps the packing physical; without
it, a jam keeps compressing and reports densities no real crowd reaches.

**3. Act — a state machine per person.**
Walk the itinerary: go here, queue there, be served, sit down, leave. People join
a queue when they reach the back of it, not when they decide to — assigning slots
by intent tells late arrivals to stand at the front and gridlocks the line.

Speed follows **Weidmann's relation**, `v(ρ) = v₀·(1 − exp(−1.913·(1/ρ − 1/5.4)))`,
so a crowd slows the way a real one does rather than only through collision
avoidance. Density is estimated with a 0.7 m Gaussian kernel, not per grid cell:
per-cell counting makes one person alone in a hall read as eleven persons per
square metre.

Everything is deterministic given the seed. The same scenario replayed produces
the same numbers, which is what makes two layouts comparable.

### Modelling choices worth knowing

- **Loose chairs and theatre rows are not navigation obstacles.** Eight chairs
  around a banquet round seal the table off entirely once the grid adds body
  clearance, and nobody can take their seat. The table stays solid; that is what
  actually shapes circulation. Anything you want treated as an obstacle can be
  marked as one per item.
- **People who cannot reach somewhere leave, and the run says so.** A plan that
  strands people is worth reporting, not hiding inside an average.
- **Arrivals block when the doorway is full**, rather than spawning people inside
  each other.

---

## Reading the results

**Fruin level of service, against three tables.** Walkways, stairways and
queueing areas have different thresholds — 1.5 persons/m² is a comfortable queue
and a failing walkway — so colouring a waiting area with the walkway legend makes
every plan look like a disaster. Thresholds are stored as the pedestrian area
module in m²/person, the form Fruin published, and converted once.

Separately, a **crowd-safety overlay** flags 4 persons/m² and above whatever the
facility type. That is operational practice for standing crowds and it fires
regardless of which table is in play.

**Findings, not just heat maps.** A heat map tells you where the red is. After
every run CROWD produces a ranked list of what went wrong in the terms you are
working in — *"Registration 2 ran at 94% utilisation"*, *"the busiest area sat at
level of service F for 4 minutes"* — each carrying the number it fired on, so you
can disagree with the threshold and still use the number.

**Comparison.** Save a run as a baseline and the next one shows deltas against
it. Runs share a seed, so a difference is attributable to the layout rather than
to luck.

**A code check alongside, not instead.** Occupant load and egress width from IBC
Table 1004.5, exit counts with the 50-occupant cliff called out explicitly
(it is a step change, not a gradient), Green Guide capacity, and an SFPE
hydraulic cross-check that subtracts the 150 mm boundary layer from each side of
every opening — the step most often left out of a hand calculation, and worth
about 30% on a 1 m door. Where the hand calculation and the simulation disagree,
that difference is the interesting part.

Everything exports: a written brief, a summary CSV, the full time series, a PNG
of the plan, and a JSON bundle that carries the plan, the scenario and the
results together so a run can be reopened exactly.

---

## Validation

`src/sim/validation/` holds the fidelity checks, and they run in CI like any
other test.

- **Fundamental diagram.** A periodic corridor swept across densities, measured
  against Weidmann's speed–density curve. This is the cheapest credibility
  artefact a crowd simulator has: if a model change silently breaks it, nothing
  else in the output is trustworthy.
- **RiMEA 3.0 cases** TC1 (corridor speed), TC4 (bottleneck flow), TC6 (90°
  corner), TC7 (demographic speeds) and TC11 (congestion at a single exit).
  TC2–TC3 and TC8–TC15 involve stairs and multi-storey geometry, which this
  version does not model; they are listed as not applicable rather than omitted.
- **ORCA** is verified by differential fuzzing against an independent
  transliteration of the RVO2 reference, and its test suite is mutation-tested.

Run `npm test` for everything, or `npx vitest run src/sim/validation` for the
fidelity suite alone. The validation tests print their measured numbers — that
output is the point.

---

## Limits, stated plainly

This is an exploratory planning model, not a safety certification.

- **Single storey.** No stairs, escalators or lifts, and therefore no
  multi-storey egress.
- **Code figures are model-code indicative.** Local adoption and amendments vary
  and approval rests with the authority having jurisdiction.
- **The simulation only knows what you draw.** An obstacle you leave out cannot
  be simulated, and a queue you draw across a table will be snapped onto walkable
  floor rather than reproducing the mistake.
- **Group behaviour is limited.** People can arrive in groups, but there is no
  explicit cohesion model keeping a family together through a crowd.
- **No explicit balking or reneging.** People join the queue they are sent to and
  wait.
- Runs are capped at 6,000 people to keep a browser tab responsive; the run says
  so when it caps.

---

## Architecture

```
src/
  core/        maths, the scene document, units, persistence, analysis
  sim/         the simulation: navigation, avoidance, behaviour, metrics
  render/      Three.js viewport, plan geometry, instanced crowd, overlays
  editor/      tools and snapping — pure state machines over pointer events
  library/     the furniture catalog, the plan builder, the starter venues
  state/       two Zustand stores: the document and the run
  app/         React UI — panels, inspector, timeline, overlays
  worker/      the simulation worker and its protocol
```

The document is immutable and structurally shared, which makes undo cheap (the
history is a list of past versions) and lets the renderer tell what changed by
comparing array identities: move one chair and only the furniture layer rebuilds.

The simulation runs in a Web Worker and streams frames as transferable buffers.
No `SharedArrayBuffer`, because that would need COOP/COEP headers and the app
would stop being a single URL you can put anywhere.

The crowd is one instanced draw call. Per person the CPU writes a transform and
five numbers; the vertex shader rotates each limb about its joint, composes the
shin through the thigh so knees bend, and picks a colour per material zone.

Furniture is described as data — a list of primitives with a footprint and the
seats it offers — so adding a catalog item means adding one entry and touching no
renderer, editor or engine code.

---

## Built with

TypeScript, React, Three.js, Vite, Zustand, Vitest and Playwright. No 3D assets:
the furniture and the people are generated from primitives, which is why the
whole thing is one download and starts instantly.

The pedestrian dynamics follow van den Berg et al. (ORCA / RVO2), Weidmann's
speed–density calibration, Fruin's level-of-service tables, the Fast Marching
Method for the navigation potential, and the RiMEA 3.0 test cases for validation.

An earlier Python and JuPedSim prototype of this idea lives in the git history at
`cc8c210`. This is a ground-up rewrite.

MIT licensed.
