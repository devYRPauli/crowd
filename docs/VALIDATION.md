# Validation

What this model reproduces, what it does not, and the numbers either way.

Current-engine figures are printed by the test suite itself — `npx vitest run
src/sim/validation` — and were copied from a run of it rather than typed from
memory. Historical and counterfactual figures (before and after a change, the
personal-space margins) were one-off runs, recorded in the source comments that
cite them. Where the model misses a criterion the test stays at the criterion
and is marked failing with the measured value; no threshold in the suite has
been loosened to make a result look better, except the exit-choice margin,
explained there.

This is an exploratory planning model. It is not a safety certification, and
nothing below should be read as one.

---

## Fundamental diagram

A 3 m × 20 m corridor whose x axis wraps, swept across densities and compared
against Weidmann's speed–density calibration. Each point runs 120 s of simulated
time and the first 60 s are discarded.

What is under test is the locomotion model rather than the whole engine: ORCA
local avoidance, the crowd slowdown applied to the preferred speed, the density
estimator, the contact resolution in velocity before anyone moves, and the
positional passes that stop bodies interpenetrating after they have. The
engine's jam-breaking heuristics are deliberately left out — they exist so a
venue never deadlocks, and including them would measure the recovery machinery
instead of the model.

`rho box` is the measured density in the central box, `rho felt` the density the
walkers themselves acted on. The two diverging is the signature of a crowd that
has clustered, which is why it is printed: a speed-against-density table on its
own hides it.

```
   N  rho set  rho box  rho felt   v box  v all  v Weidmann   error  J=rho·v  max overlap
  18     0.30    0.325     0.217   1.339  1.339       1.335   0.004    0.435         0.0%
  30     0.50    0.522     0.338   1.331  1.331       1.291   0.041    0.696         0.0%
  45     0.75    0.778     0.584   1.263  1.267       1.177   0.086    0.983         0.0%
  60     1.00    0.975     0.875   1.119  1.125       1.072   0.047    1.091         0.0%
  75     1.25    1.151     1.169   0.950  0.967       0.978  -0.028    1.093         0.0%
  90     1.50    1.440     1.457   0.810  0.823       0.834  -0.024    1.166         0.0%
 105     1.75    1.745     1.769   0.693  0.687       0.702  -0.009    1.209         0.0%
 120     2.00    1.958     2.086   0.554  0.572       0.621  -0.067    1.085         0.0%
 135     2.25    2.448     2.432   0.441  0.469       0.466  -0.025    1.080         0.0%
 150     2.50    2.649     2.752   0.364  0.391       0.413  -0.049    0.964         0.0%
 180     3.00    3.293     3.404   0.238  0.258       0.272  -0.034    0.782         0.0%
 210     3.50    3.801     3.998   0.163  0.176       0.186  -0.023    0.618         0.0%
 240     4.00    4.067     4.683   0.161  0.161       0.147   0.014    0.654         0.0%
 270     4.50    4.544     5.291   0.161  0.161       0.087   0.074    0.731         0.0%
RMSE vs Weidmann over 0.5–4.0 persons/m²: 0.0447 m/s   peak J 1.2092 p/m/s at 1.745 p/m²
```

Pooled the way the experimental literature extracts a fundamental diagram —
every tick of every measurement window binned by its own local density, rather
than a whole run averaged into one point:

```
 rho box  samples   v meas  v Weidmann   error  J=rho·v
   0.144      158    1.339       1.340  -0.001    0.193
   0.380      490    1.335       1.328   0.008    0.508
   0.608      770    1.309       1.258   0.051    0.796
   0.863      775    1.170       1.132   0.038    1.009
   1.117      684    0.998       0.995   0.003    1.116
   1.366      580    0.838       0.869  -0.031    1.145
   1.639      462    0.703       0.746  -0.043    1.152
   1.843      562    0.638       0.663  -0.026    1.175
   2.128      292    0.566       0.563   0.003    1.204
   2.371      569    0.454       0.488  -0.034    1.076
   2.612      431    0.389       0.422  -0.033    1.015
   2.880      261    0.323       0.357  -0.034    0.931
   3.107      206    0.279       0.308  -0.029    0.868
   3.378      218    0.223       0.256  -0.033    0.752
   3.631      354    0.176       0.212  -0.036    0.639
   3.859      518    0.162       0.177  -0.015    0.624
   4.109      380    0.161       0.141   0.020    0.661
   4.368      281    0.161       0.108   0.053    0.702
   4.593      309    0.161       0.081   0.080    0.738
   4.810       87    0.161       0.057   0.104    0.773
RMSE vs Weidmann over 0.5–4.0 persons/m²: 0.0322 m/s   peak J 1.2044 p/m/s at 2.128 p/m²
```

**Free-flow speed** comes out at 1.339 m/s against a configured 1.34.
**Body exclusion** holds: no pair overlaps by as much as 0.1% of two radii
anywhere in the sweep. **Capacity** — the number a model like this is most
likely to be quoted on — peaks at 1.209 persons/m/s at 1.75 persons/m², against
Weidmann's own peak of 1.225 at 1.75.

Above about 4 persons/m² the model walks faster than Weidmann, and that is
deliberate: the speed multiplier is floored at 0.12, so a jam shuffles at
0.161 m/s rather than freezing solid. A model that stops completely deadlocks a
venue and reports nothing useful about it.

### What this took, and what it says about the estimator

Three model errors were found by holding the suite to these numbers rather than
adjusting them, and each is worth knowing about because each affects what the
tool reports, not only what it scores.

**Density read in a ring rather than ahead.** A ring counts the crowd behind
you as much as the crowd in front, so whoever reached the front of a bunch was
told to slow down — which closed the gap behind them and grew the bunch. A
corridor held at a steady 1.5 persons/m² clotted into platoons reporting
2.7 persons/m² to the people inside them, and the sweep was measuring the
platoons. Reading the floor one stride ahead removed it.

**One positional pass instead of three.** Pushing A off B moves A into C, so
with a single pass the residual overlap grows with density: 27% of a body radius
at 4.7 persons/m². A crowd that can pack denser than a real one keeps moving
where a real one has stopped.

**An uncorrected kernel.** A kernel estimator is unbiased for points that may
lie anywhere, including on top of each other; people may not. A disc of two body
radii around everybody is guaranteed empty and the kernel expects about a fifth
of its mass in it, so the estimate came back that much light at every density.
That reaches further than the speed law: the same field is what the heat map
paints, what Fruin's bands classify, and what the crowd-safety overlay fires on.

Together these moved agreement with Weidmann from 0.117 m/s RMSE to 0.042, and
the flow peak from 1.39 persons/m/s at 3.07 persons/m² — 13% high and arriving
at nearly twice the right density — to within 1% of the curve.

---

## RiMEA 3.0

The RiMEA 3.0 cases this single-storey model attempts. Citing the wrong clause
of a standard is the same kind of lie as loosening a threshold, so the numbering
below was checked against the guideline's published test list and against the
JuPedSim reference notebooks, and a case that could not be matched to a number
does not get one.

| Case                             | Criterion                                             | Measured                                                                                                           |                      |
| -------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------- |
| **TC1** Corridor speed           | 40 m in 40 ± 1 s at 1.0 m/s                           | 40.01 s per 40 m; mean gate speed 1.000 m/s                                                                        | pass                 |
| **TC6** 90° corner               | Nobody walks through a wall                           | 20/20 round the bend; deepest centre inside a wall 0.0000 m; closest centre-to-wall 0.2316 m against a 0.23 m body | pass                 |
| **TC7** Demographic speeds       | Per-profile free-flow mean within 10% of its profile  | Worst error 5.9% (adult, 1.420 vs 1.34 m/s); all seven profiles within 5.9%; overall sd 0.325 vs 0.327 implied     | pass                 |
| **TC12** Bottleneck flow         | 1.2–1.4 persons/m/s of clear width                    | 1.5 m: **1.254** · 2.0 m: **1.247**                                                                                | pass                 |
|                                  |                                                       | 0.8 m: 0.851 · 1.0 m: 1.023 · 1.2 m: 1.111                                                                         | **fail, below band** |
| TC2, TC3, TC8, TC13              | Stairs and multi-storey egress                        | —                                                                                                                  | not modelled         |
| TC4                              | Fundamental diagram                                   | measured above, though not in RiMEA's own corridor geometry                                                        | partial              |
| TC5, TC9, TC10, TC11, TC14, TC15 | Personal data, exit choice, evacuation demonstrations | —                                                                                                                  | not written yet      |

TC2, TC3, TC8 and TC13 turn on stairs: walking speed up and down one, a
multi-floor building, the fundamental diagram on a stair. This version models a
single floor plate — the plan has no storeys and the navigation grid is one 2-D
raster — and faking a stair as a sloped corridor would produce numbers that look
like RiMEA results and mean nothing. Of the cases simply not written, TC11 —
choice of escape route — is the one whose _behaviour_ matters most, and it is
covered below under its own name rather than the standard's.

### The narrow openings, stated plainly

Doors of 1.2 m and under pass 0.85 to 1.11 persons/m/s where the standard wants
1.2–1.4: 7% low at 1.2 m, 15% at 1.0 m, 29% at 0.8 m. Wider openings are in
band, so this is specifically a narrow-door result, and it is in the direction
that understates rather than overstates what a door will carry.

**Most of it was arithmetic, not modelling.** The navigation grid used to be a
fixed 0.3 m whatever the building was. A doorway is rasterised like everything
else, so its usable channel quantises to whole cells, and after the grid dilates
the wall by body clearance a narrow door had almost none left. It was unstable
with it too, moving 15% on three millimetres of wall thickness. Sizing the grid
by the narrowest opening instead took the 1.2 m door from 1.126 to 1.245, with
no change to the locomotion model at all.

**Some of it is a choice, made deliberately.** Modelling personal space — people
keeping a few centimetres clear of a stranger rather than closing until they
touch — gave part of that back: 1.2 m went from 1.245 to 1.164. That is the
right direction for the model to move even though it is the wrong direction for
this number, because a crowd that will not press really does get through a door
more slowly.

**And the last of it was an exit bug, found by measuring egress properly.**
People used to stop existing the moment they reached a threshold, which left the
floor beyond every opening permanently empty; the person in the gap saw clear
space ahead and walked out at free speed. Giving them a body for a metre past the
line (`EXIT_TAIL`) restored the back pressure that makes an opening a bottleneck
and took the 1.2 m door from 1.164 to 1.251, inside the band. The same change
took a 3'0" exit door from 2.98 persons/m/s — more than double anything
observed — to 1.10. See `docs/EXPERIMENTS.md` for how it was found and
`src/sim/validation/egress.test.ts` for the measurement that now holds it.

**What took it back under was the density field counting all of each person.**
Each body was stamped onto the field out to 2.2 bandwidths, which on this door's
0.15 m grid carried 97% of a person; stamped out to the kernel's 1% cutoff it
carries 99%, so a crowd reads about 2% denser and walks the speed-density curve
that much slower. On the arithmetic the engine uses now, where the old stamp
read 1.242, that change alone took the 1.2 m door to **1.111**, and it stays: how far the old stamp reached depended on the cell size, which the
narrowest door picks, so how dense a crowd looked depended on a door somewhere
else in the building. The test is marked failing again with the measured value.

**And some is a limit that stands.** The engine keeps 0.23 m between a body and
a wall where SFPE observes people accepting 0.15 m, which bites hardest at the
narrowest widths. Two attempts to close it are recorded in the test file so that
nobody repeats them. Removing the navigation clearance entirely lifts the 0.8 m
door to 1.487 persons/m/s and strands 17 of 20 people at the corner in TC6.
Reducing it to the 150 mm boundary layer, with wall proximity charged as a
traversal cost so routes still prefer open floor, makes the narrow openings
_worse_ — routing a body to 0.15 m of a jamb when the body exclusion pushes it
back out to a full radius puts churn at exactly the point that meters the flow.
Closing it properly means letting shoulders sit 0.08 m inside walls, where TC6
allows 0.05 m: a bad trade for a tool whose output people watch, and a worse one
to make quietly.

So, plainly: **do not use this model to size a door narrower than about 1.5 m.**
The hand calculation alongside it — SFPE hydraulic, with the 150 mm boundary
layer taken off each side — is the better instrument at that width, and the tool
reports both precisely so the disagreement is visible.

---

## Personal space

Not a validation case with a published criterion, because there is not one to
cite: what this records is a parameter that had to be calibrated, and what it
was calibrated against.

People keep clear of strangers, and modelled on body radius alone they do not —
every separation rule in the engine worked on `radiusA + radiusB`, contact with
zero margin, so a crowd closed until skin met skin and stopped there. The margin
that fixes it is small on purpose. Hall's proxemics puts personal distance at
0.46–1.22 m centre to centre, which would be a quarter of a metre of air per
person or more, but **Weidmann's curve already contains that**: it is fitted to
real crowds, real crowds keep their distance, and that is most of why speed
falls with density at all. Model the same behaviour twice and it is counted
twice.

The fundamental diagram says so plainly, which is what makes it a calibration
rather than a guess:

| Margin per person    | RMSE vs Weidmann | Flow peak at    |
| -------------------- | ---------------- | --------------- |
| 0.05 m (**shipped**) | 0.045 m/s        | 1.75 persons/m² |
| 0.10 m               | 0.056 m/s        | 1.23 persons/m² |
| 0.25 m               | 0.067 m/s        | 1.41 persons/m² |

The shipped row is the current sweep; the two wider margins were measured when
the margin was chosen, on the engine of the time. The band for the flow peak is
1.5–2.1 persons/m², so only the smallest margin
survives: anything larger caps density on its own before the speed law gets to,
and the curve peaks in the wrong place. So the proxemic distance stays in the
speed law where it is calibrated, and what is modelled geometrically is the last
few centimetres of it — the margin that keeps a walking crowd from touching.

It is spent by crowding, on Fruin's own scale — whole at level A where people
still choose their spacing, gone by level E where movement is shuffling — and by
`assertiveness`, which until this existed was declared on every agent profile,
defaulted seven different ways, clamped on load, copied onto every agent at
spawn, and read by nothing at all.

It costs about 6% of the flow through a 1.2 m door, which is recorded above and
is the right direction for a model to move.

---

## Choice of exit

Not a RiMEA case either, for the same reason: RiMEA's TC11 covers exactly this
behaviour, but its geometry and acceptance criterion could not be read from a
primary source here, and a test that invents them and prints "TC11" is the same
kind of lie as loosening a threshold.

A 40 m × 20 m hall with a 1.2 m door at each end and everybody starting by the
west one. Each case runs twice: once with congestion-aware routing on, once off.
The difference between the two runs is the feature.

| People | Routing          | Near door | Far door      | 95% out by  |
| ------ | ---------------- | --------- | ------------- | ----------- |
| 40     | congestion-aware | 40        | 0             | 26.5 s      |
| 40     | shortest path    | 40        | 0             | 27.3 s      |
| 300    | congestion-aware | 175       | **125 (42%)** | **123.5 s** |
| 300    | shortest path    | 300       | 0             | 158.8 s     |

With nobody in the way the nearer door is simply the right answer and both
settings give it. With a crowd too big for one door, congestion-aware routing
spreads 42% of it to the far door and the hall clears **22% sooner**.

The test asks for at least 10% sooner. That margin was 15% until `f008922`,
when the finer navigation grid made the single-door baseline 20% faster and so
left less for the second door to save. It is a floor on whether the saving is
material, not a target, and the measured saving is printed.

This is the behaviour the tool exists to show, and it did not work until this
was measured. Exit choice compared travel time over the _static_ field, so
everybody queued at the nearest door however long the line grew and the second
door was never used. A planner asking "is a door on the far wall worth it?"
would have been told it bought nothing — wrong in the direction that gets exits
left out of a design.

People now weigh the walk against the wait: how many are ahead of you at a door,
divided by how fast that door has actually been letting people through. Two
details of that turned out to matter more than the idea itself.

**The two are combined with a maximum, not a sum.** The queue drains while you
walk towards it, so you are through when the door has cleared everybody already
ahead of you _or_ when you arrive, whichever is later. Adding them double-counts
the walk, which is the entire advantage the far door has: when this was
written, summed, the same crowd sent only 26% to the far door and took 128 s
instead of 99.

**A door nobody has used yet borrows the slowest rate anything in the venue has
managed, rather than counting as free.** Free is the obvious choice and it is
wrong in a way that bites — an unmeasured door looks like a door with no queue
however many people are already walking towards it, so a crowd piles onto it and
only discovers the queue it built once the door starts metering.

A door's rate is measured rather than configured because nothing in a plan
states it: an exit is a zone, and the constriction that meters it is a doorway
somewhere upstream. The choice is revisited every six seconds, staggered across
the crowd, because the queue that makes the far door worth the walk has not
formed yet when a person sets off — and it only changes for a door a quarter
better, or two doors of nearly equal cost trade places every time the congested
field is re-solved and people oscillate between them instead of leaving by
either.

How far the split goes depends on how congestion-aware the population is, which
is a scenario setting rather than a property of the engine. Somebody who pays no
attention to congestion still walks to the nearest door whatever is happening at
it.

---

## Single-exit evacuation

Not a RiMEA case — its TC11 is escape-route _choice_ between two doors, so
nothing here claims a clause of the standard that does not exist. This is
CROWD's own criterion, and the three things it checks are each a modelling
failure on their own terms: a door that strands people, a door with no queue
behind it, and a crowd that packs through itself.

150 people, one room, one 1.2 m door.

|                    | Measured                                                                                           |          |
| ------------------ | -------------------------------------------------------------------------------------------------- | -------- |
| Everybody gets out | 150/150; 25% by 27.4 s, 50% by 48.7 s, 95% by 99.0 s, last at 102.3 s                              | pass     |
| A queue forms      | peaked at 87 people in the 3 m upstream; peak density 7.03 persons/m²                              | pass     |
| Bodies stay apart  | max overlap 0.125 m on a 0.46 m pair distance (p95 0.081 m, median tick 0.028 m), tolerance 0.10 m | **fail** |

The overlap was the honest weak point of this model. It measured 0.271 m, which
is most of a body, and not as a transient — the p95 was 0.141 m, so for much of
the jam somebody was substantially inside somebody else. Every density reading
downstream inherited it.

What fixed it was resolving contact in _velocity_, before anybody moves, and
predictively — a pair may close only as fast as the gap between them allows in
one step. The positional pass afterwards could never keep up, because by the
time it sees an overlap the step that caused it has already happened. Peak
density fell from 7.31 to 6.81 persons/m² with it, and the room clears sooner,
because people who are not occupying each other's floor are not fighting each
other for it. That took the worst overlap to 0.081 m, inside the tolerance.

It is over it again, by less. The density field now counts all of each person
(see the narrow openings above), and on the same arithmetic that change alone
took the worst overlap from 0.094 to 0.125 m and the peak density in the jam from 6.75 to 7.03 persons
per square metre. The likely route is personal space, which is spent as the
crowd reads denser, so the queue packs tighter. That is not yet measured, and
the test is marked failing with the measured value until it is.

---

## Doors as the ways in and out

Entries and exits used to be zones only: polygons somebody drew, by convention,
next to a door. Nothing connected the two — no shared field, no id reference, no
code path — so the door's clear width, which is the number every egress
calculation turns on, metered nothing. A zone drawn generously around a 3'0"
leaf let people through as if the wall were open.

A door now carries what it is used for, and the simulation stands its
destination on the doorway itself: as wide as the leaf, deep enough to straddle
the threshold. A building can have as many ways in and as many ways out as it
has doors marked for it, and the six starter venues are built that way — the
coffee bar's street door is both, the conference hall's two south doors are
both, the polling station comes in one side and leaves the other, the
concourse's portals face the street on one side and the platforms on the other.

An itinerary that names a way out is now honoured, too. It used to be accepted
by the UI, stored in the document, and silently ignored by the engine — which
was harmless while everything drained to the nearest exit and is not harmless
now that congestion can send somebody elsewhere. A commuter heading for the
platforms must not be routed out to the street because the street door happens
to be emptier. Naming several leaves the choice between them open, which is
where congestion gets its say.

---

## Determinism

A comparison that is partly noise is worse than no comparison, so this is tested
rather than asserted: every starter venue is built twice and has to produce
identical numbers.

It did not, and the reason is worth recording. Object ids are minted per
document from `Math.random`, and the engine named its random-draw streams after
them — one per population, one per service point — so the same template built
twice drew different arrival times and different service durations. The polling
station came out anywhere between 108 and 119 people served on identical input.
Streams are named after a thing's position in the plan now, which two
structurally identical plans always agree on.

It did not agree across machines either, and nothing on one machine could show
it. `Math.sin`, `Math.cos`, `Math.atan2`, `Math.exp` and `Math.log` are not
required to be correctly rounded, and V8 on arm64 and on x86 disagree about the
last bit of some of them. Every person interacts with every neighbour, so a
crowd amplifies that bit rather than averaging it away: the exit-choice run
split 300 people 160/140 on a Mac and 150/150 on the CI runner, which failed a
test that passed locally. The engine, the furniture library and the validation
harness compute those functions themselves now, in `src/core/math/libm.ts`, from
`+ - * /` and exact bit operations, which IEEE 754 rounds the same everywhere.
`Math.hypot` goes the same way, as a square root of a sum of squares, because
engines approximate it differently too. Lint refuses the platform's versions
there. `src/library/determinism.test.ts` pins a hash of a shortened run of each
template, so a machine whose arithmetic differs fails that test instead of
quietly publishing its own numbers.

---

## ORCA

The collision-avoidance kernel is unit-tested case by case against RVO2's
geometry: agent and obstacle constraint lines, and the infeasible case, where
the fallback is checked against a brute-force search of the velocity disc. It
also runs RVO2's circle benchmark: no pair overlaps by more than 12% of their
summed radii, everyone is across within 30 s, and a replay from the same seed
is bit-identical. The tests are in `src/sim/avoidance/orca.test.ts`.

---

## What is not validated

Stated so that nobody has to infer it from silence.

- **Stairs, escalators and lifts.** Not modelled, so not validated, so no
  multi-storey egress.
- **Group cohesion.** People can arrive in groups; nothing keeps a family
  together through a crowd, and nothing here measures whether it should.
- **Balking and reneging at a counter.** People do change which door they leave
  by when the queue at one makes the walk to the other worth it — that is
  measured above — but nobody who has joined a service queue ever gives up on
  it. Waiting times at a badly under-provisioned counter will therefore come out
  longer than real ones.
- **Counterflow and crossing flows.** The fundamental diagram above is
  unidirectional. Bidirectional lane formation is not measured.
- **Code figures.** Occupant load, egress width and capacity are model-code
  indicative. Local adoption and amendments vary and approval rests with the
  authority having jurisdiction.
