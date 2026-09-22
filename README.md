# CROWD

**Constraint-aware Rehearsal and Optimisation of Walking Dynamics.**

Draw a venue in 3D. Say who turns up and what they came to do. Watch them move
through it, and read what went wrong.

CROWD runs entirely in the browser. There is no install, no backend, no licence
and no import step: the plan _is_ the model. Every wall you draw is a wall people
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
npm run check        # typecheck, lint, format check and unit tests
npm run smoke        # build, serve, and drive the real app in a real browser
```

The build is a static site. `dist/` can be served from anywhere — no headers,
no COOP/COEP, no server-side anything. That constraint is deliberate and it
shaped several decisions below.

---

## Drawing a venue

|           |                                                                               |
| --------- | ----------------------------------------------------------------------------- |
| `V`       | Select and move                                                               |
| `O`       | Look around: the left button orbits, Shift pans, and nothing is edited        |
| `W`       | Walls — click to chain, **type a length and press Enter** to place it exactly |
| `R`       | Room — drag a rectangle and get four walls                                    |
| `D` / `N` | Doorway / window — move onto a wall and click; it cuts the wall               |
| `F`       | Furniture — 49 items, oriented against the nearest wall automatically         |
| `Z`       | Areas — entry, exit, destination, seating, keep-clear, blocked, measurement   |
| `S`       | Service point — a counter with staff, a service time and a queue              |
| `Q`       | Reshape a queue by dragging its points                                        |
| `M`       | Tape measure                                                                  |

The left button always belongs to the active tool. Navigation lives on the
right and middle buttons, the wheel, and Space-drag. Press `?` for the full
keymap.

**Everything is a size you could order.** Doors come in even inches — 2'8"
interior, 3'0" entry and accessible, pairs at 5'0" and 6'0" — with a 6'8" head,
and windows, wall thicknesses and ceiling heights likewise. A 1.0 m door is not
a door anybody makes, and the three and a half inches between it and a 3'0" leaf
are, at a doorway, the difference between two people abreast and one. The
inspector offers the stock sizes and says so when a dimension is not one of
them. The document stays metric; the imperial setting reads them back as what
they are called.

**A door can be the way in, the way out, or both.** Mark it in the inspector and
people arrive through that doorway and leave through it — as many of each as the
building has. It matters because the door's own clear width is then what meters
them, which is the number every egress calculation turns on. Drawing a zone next
to a door only approximates that, and approximates it generously.

Some other details that make the difference between a plan editor that feels
precise and one that feels approximate:

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

Each destination carries _two_ fields. The static one is the shortest path. The
congested one is re-solved periodically with local crowd density lowering the
traversal speed, so its gradient bends around a crowd. Every person follows one
or the other according to how congestion-aware they are — which is what produces
a genuine route split at a bottleneck instead of one thick column.

The same reasoning picks the **way out**, not just the way there. People weigh
the walk against the wait — how many are ahead of them at a door, divided by how
fast that door has actually been letting people through — and think again every
few seconds, because the queue that makes the far door worth the walk has not
formed yet when they set off. Without it a crowd queues at the nearest exit
however long the line grows while an identical door stands open, and a planner
asking whether a second exit is worth it gets told it bought nothing. In a hall
with a door at each end, 300 people clear 22% faster for using both.

**2. Avoid — ORCA.**
Optimal Reciprocal Collision Avoidance, ported faithfully from the RVO2
reference, turns "where I want to go" into "where I can go" given the neighbours
and walls right now. Because it is reciprocal, two people resolve a head-on
without either of them stopping.

ORCA has a known failure mode: in a tight crowd its linear program becomes
infeasible and the relaxed fallback can hand every agent a velocity of zero at
once — a deadlock no amount of simulated time resolves. CROWD shortens the time
horizon as pressure builds (people in a crush stop planning two seconds ahead and
deal with the person in front) and lets a jammed person creep forward.

Velocity-space avoidance cannot guarantee separation on its own — when the
program is infeasible the fallback returns the least-bad velocity, and in a crush
the least-bad velocity still closes the gap — so positional relaxation passes
after integration keep the packing physical. One pass is enough up to about
3 persons/m² and not above it: pushing A off B moves A into C, and with a single
pass the residual grows with density, reaching 27% of a body radius at 4.7
persons/m². Three passes hold the pack at contact, and across the whole
fundamental-diagram sweep no pair now overlaps by more than 0.1% of two radii.

**3. Act — a state machine per person.**
Walk the itinerary: go here, queue there, be served, sit down, leave. People join
a queue when they reach the back of it, not when they decide to — assigning slots
by intent tells late arrivals to stand at the front and gridlocks the line.

People also keep out of each other's way before anybody is in it. A body radius
says where somebody _is_; it says nothing about whether they will let a
stranger's shoulder touch theirs, and they will not. That margin is deliberately
small — five centimetres a person — because the proxemic distance proper is
already inside the speed law below, and modelling it twice caps density before
Weidmann gets to. It is spent by crowding, on Fruin's own scale, and by how
willing somebody is to take a tight gap. In a crush there is none of it left,
which is what a crush is.

Speed follows **Weidmann's relation**, `v(ρ) = v₀·(1 − exp(−1.913·(1/ρ − 1/5.4)))`,
so a crowd slows the way a real one does rather than only through collision
avoidance. Density is estimated with a 0.7 m Gaussian kernel, not per grid cell:
per-cell counting makes one person alone in a hall read as eleven persons per
square metre.

Two details of that estimate matter more than they look.

**It is read one stride ahead, not in a ring.** A ring counts the people behind
you, so whoever reaches the front of a bunch is told to slow down — which closes
the gap behind them and makes the bunch tighter. That feedback has the sign the
wrong way round, and it shows: with a ring, a corridor held at a steady
1.5 persons/m² does not stay steady, it clots into platoons that each report
2.7 persons/m² to the people inside them. Read the floor you are walking into
instead and the front of a bunch pulls away, which is what dissolves it.

**It is corrected for the space bodies cannot occupy.** A kernel estimator is
unbiased for points that may lie anywhere, including on top of each other.
People may not: a disc of two body radii around everybody is guaranteed empty,
and the kernel expects to find about a fifth of its mass in it. Uncorrected, a
4.0 persons/m² crush paints on the heat map as 3.2 and the safety overlay says
nothing — while the per-area occupancy in the same report, which counts heads in
a polygon, disagrees by that same fifth.

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
working in — _"Registration 2 ran at 94% utilisation"_, _"the busiest area sat at
level of service F for 4 minutes"_ — each carrying the number it fired on, so you
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
  else in the output is trustworthy. It tracks the curve to **0.044 m/s RMSE**
  over 0.5–4.0 persons/m² per run, **0.032** pooled, and peaks at **1.194
  persons/m/s at 1.72 persons/m²** — capacity being the number a model like this
  is most likely to be quoted on.
- **RiMEA 3.0 cases** TC1 (corridor speed), TC6 (90° corner), TC7 (demographic
  speeds) and TC12 (bottleneck flow), plus a single-exit evacuation that is
  CROWD's own check rather than a RiMEA case. TC2, TC3, TC8 and TC13 turn on
  stairs, which this version does not model and will not fake as a sloped
  corridor; the rest are listed as not written yet rather than omitted, with
  escape-route choice (TC11) called out as the gap that matters most.
- **Egress through a door** is measured directly, because it is the number the
  tool is actually asked for and it went wrong once without anything noticing.
  A pair of 3'0" leaves passes **1.33 persons per metre per second** of clear
  width, against the 1.2–1.4 the observational literature reports, and doubling
  a door's width roughly doubles what it passes. The test that holds that
  relationship exists because for a long time it did not hold: see
  [docs/EXPERIMENTS.md](docs/EXPERIMENTS.md).
- **ORCA** is verified by differential fuzzing against an independent
  transliteration of the RVO2 reference, and its test suite is mutation-tested.
- **Choice of exit**, run with congestion-aware routing on and off so the
  difference between the two is visible: 40 people take the near door either
  way; 300 spread across both and clear a third faster for it.
- **Determinism**, because a comparison that is partly noise is worse than no
  comparison: every starter venue is built twice and has to produce identical
  numbers.

Run `npm test` for everything, or `npx vitest run src/sim/validation` for the
fidelity suite alone. The validation tests print their measured numbers — that
output is the point, and [docs/VALIDATION.md](docs/VALIDATION.md) records the
current ones, including what still misses and by how much.

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
- **Loose seating is passable by default, and a theatre needs it not to be.**
  Chairs and seat rows are not navigation obstacles as shipped, because eight
  chairs round a banquet round would seal the table off entirely once the grid
  adds body clearance and nobody could take their seat. For a theatre that is the
  wrong default: people walk through the rows. Mark the rows as obstacles per
  item and the aisles carry the crowd properly — measured, that costs 39% of the
  floor and 15% of the clearance time, and everybody still gets out. See
  [docs/EXPERIMENTS.md](docs/EXPERIMENTS.md). Nothing prompts you to do it, which
  is the part still worth fixing.
- **Narrow doors are pessimistic.** Below about 1.2 m the engine passes fewer
  people per metre than the observational literature reports, because it keeps a
  fixed clearance between a body and a jamb and a narrow opening loses
  proportionally more of itself to it. See `docs/VALIDATION.md`.
- **No balking or reneging at a counter.** Somebody heading for a door will
  change doors when the queue at one makes the walk to the other worth it, but
  somebody who has joined a service queue stays in it however long the line
  gets. Real people give up, so waiting times at a badly under-provisioned
  counter come out longer here than they would be.
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
