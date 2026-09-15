# Validation

What this model reproduces, what it does not, and the numbers either way.

Everything here is printed by the test suite itself — `npx vitest run
src/sim/validation` — and every figure below was copied from a run of it rather
than typed from memory. Where the model misses a criterion the test stays at the
criterion and is marked failing with the measured value; no threshold in the
suite has been loosened to make a result look better.

This is an exploratory planning model. It is not a safety certification, and
nothing below should be read as one.

---

## Fundamental diagram

A 3 m × 20 m corridor whose x axis wraps, swept across densities and compared
against Weidmann's speed–density calibration. Each point runs 120 s of simulated
time and the first 60 s are discarded.

What is under test is the locomotion model rather than the whole engine: ORCA
local avoidance, the crowd slowdown applied to the preferred speed, the density
estimator, and the positional passes that stop bodies interpenetrating. The
engine's jam-breaking heuristics are deliberately left out — they exist so a
venue never deadlocks, and including them would measure the recovery machinery
instead of the model.

`rho box` is the measured density in the central box, `rho felt` the density the
walkers themselves acted on. The two diverging is the signature of a crowd that
has clustered, which is why it is printed: a speed-against-density table on its
own hides it.

```
   N  rho set  rho box  rho felt   v box  v all  v Weidmann   error  J=rho·v  max overlap
  18     0.30    0.325     0.220   1.338  1.338       1.335   0.004    0.435         0.0%
  30     0.50    0.500     0.354   1.331  1.330       1.299   0.032    0.665         0.0%
  45     0.75    0.780     0.584   1.263  1.267       1.176   0.087    0.985         0.0%
  60     1.00    0.963     0.896   1.105  1.114       1.078   0.027    1.064         0.0%
  75     1.25    1.250     1.207   0.926  0.949       0.926  -0.001    1.158         0.0%
  90     1.50    1.476     1.476   0.788  0.818       0.817  -0.030    1.163         0.0%
 105     1.75    1.809     1.798   0.682  0.682       0.677   0.005    1.233         0.0%
 120     2.00    2.079     2.099   0.540  0.574       0.579  -0.040    1.121         0.0%
 135     2.25    2.399     2.437   0.446  0.473       0.480  -0.034    1.070         0.0%
 150     2.50    2.656     2.747   0.364  0.392       0.411  -0.047    0.967         0.0%
 180     3.00    3.307     3.402   0.235  0.257       0.269  -0.034    0.778         0.0%
 210     3.50    3.614     3.977   0.168  0.176       0.215  -0.047    0.608         0.0%
 240     4.00    4.067     4.679   0.161  0.161       0.147   0.014    0.654         0.0%
 270     4.50    4.545     5.286   0.161  0.161       0.086   0.074    0.731         0.1%
RMSE vs Weidmann over 0.5–4.0 persons/m²: 0.0418 m/s   peak J 1.2327 p/m/s at 1.809 p/m²
```

Pooled the way the experimental literature extracts a fundamental diagram —
every tick of every measurement window binned by its own local density, rather
than a whole run averaged into one point:

```
 rho box  samples   v meas  v Weidmann   error  J=rho·v
   0.144      162    1.339       1.340  -0.001    0.192
   0.386      571    1.334       1.327   0.007    0.515
   0.605      729    1.299       1.259   0.040    0.787
   0.870      654    1.175       1.128   0.047    1.023
   1.108      628    1.006       1.000   0.006    1.115
   1.365      532    0.848       0.870  -0.022    1.157
   1.616      428    0.757       0.755   0.001    1.223
   1.854      594    0.659       0.659  -0.001    1.222
   2.126      551    0.534       0.564  -0.029    1.136
   2.380      507    0.448       0.485  -0.037    1.067
   2.588      429    0.393       0.428  -0.035    1.016
   2.875      206    0.333       0.358  -0.025    0.959
   3.098      251    0.284       0.310  -0.026    0.879
   3.378      343    0.198       0.256  -0.058    0.670
   3.612      443    0.176       0.216  -0.040    0.635
   3.860      355    0.165       0.177  -0.011    0.639
   4.106      331    0.161       0.141   0.020    0.661
   4.368      280    0.161       0.108   0.053    0.702
   4.592      307    0.161       0.081   0.080    0.738
   4.812       90    0.161       0.057   0.104    0.774
RMSE vs Weidmann over 0.5–4.0 persons/m²: 0.0318 m/s   peak J 1.2229 p/m/s at 1.616 p/m²
```

**Free-flow speed** comes out at 1.338 m/s against a configured 1.34.
**Body exclusion** holds: no pair overlaps by more than 0.1% of two radii
anywhere in the sweep. **Capacity** — the number a model like this is most
likely to be quoted on — peaks at 1.233 persons/m/s at 1.81 persons/m², against
Weidmann's own peak of 1.225 at 1.75.

Above about 3.6 persons/m² the model walks faster than Weidmann, and that is
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
| **TC1** Corridor speed           | 40 m in 40 ± 1 s at 1.0 m/s                           | 40.00 s per 40 m; mean gate speed 1.000 m/s                                                                        | pass                 |
| **TC6** 90° corner               | Nobody walks through a wall                           | 20/20 round the bend; deepest centre inside a wall 0.0000 m; closest centre-to-wall 0.2328 m against a 0.23 m body | pass                 |
| **TC7** Demographic speeds       | Per-profile free-flow mean within 10% of its profile  | Worst error 4.3% (adult, 1.398 vs 1.34 m/s); all seven profiles within 4.3%; overall sd 0.328 vs 0.327 implied     | pass                 |
| **TC12** Bottleneck flow         | 1.2–1.4 persons/m/s of clear width                    | 1.5 m: **1.379** · 2.0 m: **1.318**                                                                                | pass                 |
|                                  |                                                       | 0.8 m: 1.078 · 1.0 m: 0.996 · 1.2 m: 1.040                                                                         | **fail, below band** |
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

Doors of 1.2 m and under pass 1.0–1.1 persons/m/s where the standard wants
1.2–1.4: about 15–20% too few people, too slowly. Wider openings are in band, so
this is specifically a narrow-door result, and it is in the direction that
understates rather than overstates what a door will carry.

The suite keeps the band and marks these failing with the measured number. It is
worth being blunt about what that means: **do not use this model to size a door
narrower than about 1.5 m.** The hand calculation alongside it — SFPE hydraulic,
with the 150 mm boundary layer taken off each side — is the better instrument at
that width, and the tool reports both precisely so the disagreement is visible.

---

## Choice of exit

Not a RiMEA case either, for the same reason: RiMEA's TC11 covers exactly this
behaviour, but its geometry and acceptance criterion could not be read from a
primary source here, and a test that invents them and prints "TC11" is the same
kind of lie as loosening a threshold.

A 40 m × 20 m hall with a 1.2 m door at each end and everybody starting by the
west one. Each case runs twice: once with congestion-aware routing on, once off.
The difference between the two runs is the feature.

| People | Routing          | Near door | Far door      | Cleared in |
| ------ | ---------------- | --------- | ------------- | ---------- |
| 40     | congestion-aware | 40        | 0             | 25.9 s     |
| 40     | shortest path    | 40        | 0             | 19.7 s     |
| 300    | congestion-aware | 173       | **127 (42%)** | **98.2 s** |
| 300    | shortest path    | 300       | 0             | 146.8 s    |

With nobody in the way the nearer door is simply the right answer and both
settings give it. With a crowd too big for one door, congestion-aware routing
spreads 42% of it to the far door and the hall clears **33% sooner**.

This is the behaviour the tool exists to show, and it did not work until this
was measured. Exit choice compared travel time over the _static_ field, so
everybody queued at the nearest door however long the line grew and the second
door was never used. A planner asking "is a door on the far wall worth it?"
would have been told it bought nothing — wrong in the direction that gets exits
left out of a design.

People now weigh the walk against the wait, the same way they already chose
between service counters: how many people are ahead of you, divided by how fast
the thing in front of them is going. A door's rate is measured rather than
configured, because nothing in a plan states it — an exit is a zone and the
constriction that meters it is a doorway somewhere upstream — so until a door
has let eight people through, doors are compared on walking time alone. The
choice is also revisited every six seconds, because the queue that makes the far
door worth the walk has not formed yet when a person sets off, and it only
changes for a door a quarter better, or people oscillate between two doors of
nearly equal cost instead of leaving by either.

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
| Everybody gets out | 150/150; 25% by 20.6 s, 50% by 37.9 s, 95% by 85.0 s, last at 88.5 s                               | pass     |
| A queue forms      | peaked at 85 people in the 3 m upstream; peak density 7.31 persons/m²                              | pass     |
| Bodies stay apart  | max overlap 0.271 m on a 0.46 m pair distance (p95 0.141 m, median tick 0.057 m), tolerance 0.10 m | **fail** |

The overlap is the honest weak point of a crush at 7 persons/m². It is a
transient at the densest moment rather than the typical state — the median tick
is 0.057 m — but the model does let bodies interpenetrate more than it should
when a whole room presses into one door. Read peak densities in a crush as
indicative, not as measurements.

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

---

## ORCA

The collision-avoidance kernel is checked two ways that do not depend on each
other. It is **differentially fuzzed** against an independent transliteration of
the RVO2 reference — random agents, random neighbours, random obstacles, and the
two implementations must agree — and its own test suite is **mutation-tested**,
so a test that would not notice the kernel being broken is itself reported as a
gap.

---

## What is not validated

Stated so that nobody has to infer it from silence.

- **Stairs, escalators and lifts.** Not modelled, so not validated, so no
  multi-storey egress.
- **Group cohesion.** People can arrive in groups; nothing keeps a family
  together through a crowd, and nothing here measures whether it should.
- **Balking and reneging.** Nobody looks at a long queue and leaves. Waiting
  times in a badly under-provisioned venue will therefore be longer than real
  ones, because real people give up.
- **Counterflow and crossing flows.** The fundamental diagram above is
  unidirectional. Bidirectional lane formation is not measured.
- **Code figures.** Occupant load, egress width and capacity are model-code
  indicative. Local adoption and amendments vary and approval rests with the
  authority having jurisdiction.
