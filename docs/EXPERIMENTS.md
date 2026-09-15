# What changing the plan does

CROWD exists to answer one question quickly: _if I change this room, what
happens to the people in it?_ This document is that question asked systematically
— a set of experiments that each change one thing about a venue and report what
it cost, with the numbers that came out.

Everything here is reproducible:

```sh
npx vite-node scripts/study.mjs              # all of it
npx vite-node scripts/study.mjs exits crowd  # named experiments only
```

## How to read these numbers

**The venues are built, not loaded.** `scripts/study/harness.mjs` draws each hall
the way somebody would draw it in the editor — four walls, doors cut into them,
furniture placed on the floor — rather than opening a template. A template is a
fixed answer, and the question here is what happens when a plan _changes_.

**The doors are real doors.** Widths come out of `src/core/model/standards.ts`,
the same stock-size table the inspector offers, so a 3'0" leaf is 0.914 m and not
a round metric number that no supplier sells.

**Every figure is three seeds.** `±` is half the spread across them, so a
difference smaller than the `±` beside it is not a difference. Where a single
number appears without a `±` it is derived from the mean rather than measured
per-seed.

**The hall is 30 × 20 m** unless stated otherwise — 600 m², a mid-sized function
room — and the crowd is 200 people who arrive all at once and head for the exit.

**Two flow figures appear and they are not the same.** The tables below divide
the crowd by the time to clear, which includes the walk to the door and so reads
lower than the door's capacity. `src/sim/validation/egress.test.ts` measures the
saturated middle of a run instead, between the 20th and 80th person out, which is
what a capacity figure means. Where this document quotes a capacity, it is the
second.

---

## The bug this study was written to find

The first thing the harness measured was wrong, and it is worth putting first
because it is the number the tool exists to produce.

A crowd was clearing a 30 × 20 m hall through a single 3'0" door in 20 seconds.
That is about five people a second through a doorway that passes rather more than
one. Widening the door barely helped:

| leaf | clear width | people/s | ratio |
| --- | --- | --- | --- |
| 2'0" | 0.610 m | 7.66 | — |
| 3'0" | 0.914 m | 8.47 | |
| 6'0" pair | 1.829 m | 9.47 | |
| 8'0" pair | 2.438 m | 10.29 | **1.34× for 4× the width** |

Fitting `flow = k(w + c)` to that gives `c ≈ 4.7 m`, which is another way of
saying the leaf width was nearly irrelevant. The door was not metering anybody.

Two causes, both in how leaving was decided.

`atAnyExit` counted somebody as gone once they were within their own radius plus
0.35 m of the **edge** of a doorway's threshold. That dilates a 0.914 m leaf into
a 2.07 m capture front reaching a metre back into the room, so people were
removed while still out on the open floor and never funnelled through the gap at
all. The threshold polygon already _is_ the clear width, so the test is now
containment, with no margin.

That alone was not enough. Deleting somebody the instant they reach the line
leaves the floor beyond every door permanently empty, so the person in the gap
sees clear space ahead — the pace model looks 0.45 m in front of each walker —
and walks out at free speed. Measured directly, moving the removal point outward
settles the figure:

| people removed | persons/m/s |
| --- | --- |
| in the doorway | 2.98 |
| 1 m outside | 1.24 |
| 2 m outside | 1.64 |
| 4 m outside | 1.34 |

against a published 1.2–1.4 for doors and this engine's own corridor peak of
1.19. So people keep their bodies for a metre past the threshold now
(`EXIT_TAIL`), which holds the back pressure that makes a door a bottleneck, and
are still counted as having left at the line, because that is when they left.

After both fixes, measured over three seeds:

| leaf | clear width | people/s | per m clear | per m **effective** |
| --- | --- | --- | --- | --- |
| 2'0" | 0.610 m | 0.52 | 0.85 | 1.68 |
| 3'0" | 0.914 m | 1.00 | 1.10 | 1.63 |
| 6'0" pair | 1.829 m | 2.54 | 1.39 | 1.66 |
| 8'0" pair | 2.438 m | 3.27 | 1.34 | 1.53 |

Four times the width now buys 6.3 times the flow. Charged against clear width the
specific flow rises with the opening, which is what the observational literature
reports: a narrow door loses proportionally more of itself to the clearance
people keep from the jambs. Charged against SFPE's **effective** width — clear
width less a 0.15 m boundary layer each side — it is near-constant at 1.53–1.68,
so the engine is consistent with itself across the whole range and the remaining
disagreement is about how much of an opening is usable, not about how fast people
walk through one.

**Nothing caught this, because nothing measured it.** RiMEA TC12 measures flow
through a gap in a wall, not through a door somebody is routed out of, and the
single-exit case asserts that everybody gets out rather than how fast.
`egress.test.ts` is the measurement that was missing.

One thing fell out of the fix on its own: RiMEA TC12 at a 1.2 m opening went from
1.164 to 1.251 persons/m/s and into the acceptance band, where it had been marked
as a known failure. All five swept widths now pass.

---

## E1 — What a door is worth

200 people, all at once, out of a 30 × 20 m hall. Only the exits change.

| exits | total clear | clearance | people/s | per m | peak density | % of time at LOS E/F |
| --- | --- | --- | --- | --- | --- | --- |
| 1 × 2'0" | 0.610 m | 390.4 s ±35.2 | 0.49 | 0.80 | 7.25 ±0.10 | 97.6 ±0.3 |
| 1 × 3'0" | 0.914 m | 200.2 s ±4.5 | 0.95 | 1.04 | 7.21 ±0.01 | 95.7 ±0.1 |
| **1 × 6'0" pair** | **1.829 m** | **85.9 s ±1.7** | 2.21 | 1.21 | 6.92 ±0.11 | 90.9 ±0.6 |
| 2 × 3'0", same wall | 1.828 m | 109.1 s ±5.7 | 1.74 | 0.95 | 6.60 ±0.05 | 92.6 ±0.2 |
| 2 × 3'0", opposite walls | 1.828 m | 122.6 s ±3.1 | 1.55 | 0.85 | 6.70 ±0.04 | 94.3 ±1.1 |
| 4 × 3'0", one per wall | 3.656 m | 64.4 s ±0.5 | 2.95 | 0.81 | 5.87 ±0.17 | 88.5 ±1.6 |

**One wide opening beats two narrow ones of the same total width, by a lot.**
Three rows of that table have essentially identical clear width — 1.829 m against
1.828 m — and clear the same hall in 85.9 s, 109.1 s and 122.6 s. Putting the
same 6 feet of door into a single pair rather than two separate leaves is worth
**27%** of the clearance time; splitting those two leaves onto opposite walls
costs a further 12%, or **43%** against the pair. All three gaps are many times
the seed spread, so all three are real.

Two things drive it. A doorway loses a fixed strip down each jamb to the
clearance people keep from it, so two openings pay that toll twice while one wide
one pays it once — the same effect that makes specific flow rise with width in
the table at the top of this document. And doors on opposite walls make people
*choose*, which adds travel and splits the crowd unevenly; the tool re-routes
people to the less congested door as queues build, and it still does not recover
the difference.

**The practical reading: if you are adding egress capacity, widen an opening
before you add another one, and if you must add one, put it near the one you
have.** That is not what the arithmetic of "total clear width" alone would tell
you, and total clear width is what codes are written in.

**Diminishing returns set in.** Going from 0.914 m to 1.829 m — double the width
— cuts clearance from 200.2 s to 85.9 s, better than double. Going on to 3.656 m
only reaches 64.4 s, a further 1.33× for another doubling, because by then the
doors have stopped being the only constraint and the time is going into walking
across the room to reach them. There is a width past which more door buys little,
and for this hall and this crowd it is not far past a single 6'0" pair.

**The narrow case is a warning.** A 2'0" leaf — a real door, sold as a closet
door, and narrower than any code would allow for egress — takes 6½ minutes to
clear the room and holds the crowd at level of service E or F for 97.6% of it.
The tool's own code check flags widths like this against IBC minimums; this is
what the number underneath that check looks like.

---

## E2 — What the furniture costs

The same hall and the same 200 people, out through two 3'0" leaves on the south
wall, with the floor laid out five different ways.

| layout | items | floor left | clearance | mean journey | % of time at LOS E/F | µs/person/step |
| --- | --- | --- | --- | --- | --- | --- |
| empty | 0 | 589.6 m² | 109.1 s ±5.7 | 53.3 s ±2.7 | 92.6 ±0.2 | 15.3 |
| standing reception | 8 | 586.4 m² | 110.1 s ±5.3 | 53.2 s ±2.6 | 92.6 ±0.3 | 19.4 |
| classroom | 350 | 511.4 m² | 119.7 s ±4.7 | 60.9 s ±1.4 | 92.9 ±0.6 | 22.9 |
| banquet rounds | 360 | 474.2 m² | 116.0 s ±7.3 | 56.7 s ±1.7 | 94.7 ±0.3 | 34.1 |
| theatre | 28 | 589.6 m² | 109.1 s ±5.7 | 53.3 s ±2.7 | 92.6 ±0.2 | 15.4 |

**Furniture costs much less than the floor it takes away.** The banquet layout
removes 19% of the floor and adds 6% to the clearance time; the classroom removes
13% and adds 10%. For this hall the exits dominate so completely that what is on
the floor barely matters — which is itself the finding, and the reason to be
suspicious of a plan that has been optimised by moving tables around.

**The two furnished layouts invert.** Banquet rounds block *more* floor than the
classroom (474.2 m² left against 511.4 m²) and yet clear *faster* (116.0 s
against 119.7 s), and the gap is about the size of the seed spread so it is
marginal — but the direction is worth understanding. Round tables leave diagonal
routes between them; rectangular ranks in rows create corridors that people have
to follow to their ends. The classroom's mean journey is 60.9 s against the
banquet's 56.7 s, which says the same thing: people walk further in the
classroom, not slower.

**Theatre is identical to empty in every column**, because seat rows are
deliberately not navigation obstacles. See the caveat under "What the study found
about the tool itself" below — for a theatre this is a large simplification.

**Furniture is what costs compute, not people.** Per-person step cost more than
doubles from the empty room to the banquet layout, 15.3 to 34.1 µs, on the same
crowd. Every item is an obstacle the avoidance layer tests against. These figures
were taken with other work on the machine and so are high in absolute terms; the
ratio between rows is the part to trust.

---

## E3 — How it scales with the size of the crowd

Same hall, same two 3'0" exits on the same wall, everybody arriving at once.

| people | clearance | people/s | mean journey | peak density | µs/person/step |
| --- | --- | --- | --- | --- | --- |
| 50 | 26.9 s ±3.3 | 1.76 | 12.5 s ±1.2 | 3.18 ±0.31 | 39.2 |
| 100 | 57.6 s ±2.7 | 1.65 | 28.0 s ±2.4 | 5.41 ±0.05 | 22.4 |
| 200 | 109.1 s ±5.7 | 1.74 | 53.3 s ±2.7 | 6.60 ±0.05 | 15.5 |
| 400 | 199.8 s ±3.7 | 1.90 | 95.1 s ±1.4 | 7.15 ±0.07 | 12.5 |
| 800 | 325.4 s ±12.6 | 2.34 | 148.8 s ±5.1 | 7.53 ±0.03 | 11.3 |

**Clearance is sub-linear in the crowd: sixteen times the people take twelve
times as long.** That is not efficiency, it is the walk-up washing out. With
fifty people the doors are never continuously busy and most of the clearance time
is somebody walking across the room; with eight hundred the doors run at capacity
from the first second to the last, so the marginal person costs only their share
of the doorway. The flow column shows it directly — 1.76 people/s at fifty,
2.34 at eight hundred, approaching what the two leaves can actually pass.

The planning reading is the uncomfortable one: **a hall that clears
comfortably at half occupancy tells you very little about the same hall full.**
Doubling the crowd roughly doubles the time, but the density people experience on
the way out keeps climbing, and it is the density that hurts.

**Cost per person falls as the crowd grows**, from 39.2 to 11.3 µs per person per
step. The fixed work of a step — the flow fields, the grid, the density pass — is
amortised over more people, so the engine gets cheaper per head, not dearer. This
is the shape you want and the opposite of the quadratic blow-up a naive
all-pairs avoidance would give.

---

## E4 — How they arrive

Same hall. 200 people, in through a 6'0" pair on the north wall, out through a
3'0" leaf on the south, varying only how their arrivals are spread.

| arrival | peak inside | peak density | mean journey | served |
| --- | --- | --- | --- | --- |
| all at once | 167 ±1 | 7.06 ±0.02 | 113.9 s ±2.9 | 200 |
| uniform over 120 s | 109 ±9 | 6.81 ±0.08 | 75.6 s ±6.9 | 200 |
| uniform over 600 s | 8 ±0 | 1.07 ±0.02 | 15.3 s ±0.3 | 200 |
| peak at 600 s | 20 ±2 | 1.85 ±0.26 | 15.6 s ±0.3 | 200 |

**This is the largest effect in the whole study, and it costs nothing to change.**
The same 200 people through the same doors into the same room take 113.9 s each
if they all turn up together and 15.3 s each if they are spread over ten minutes
— a 7.5× difference in what each person experiences, with not one thing about the
building altered. Peak occupancy falls from 167 to 8 and peak density from 7.06
to 1.07 persons/m², which is the difference between a crush and a quiet room.

The doors are identical in all four rows. What changed is scheduling, and
scheduling is usually the cheapest thing a venue can change — staggered session
ends, timed tickets, a second coach five minutes later.

Note that the two spread-out profiles are barely distinguishable from each other
(15.3 s against 15.6 s) while both are transformed relative to the bunched ones.
The lesson is not "shape the arrival curve precisely", it is "do not let
everybody arrive at once".

---

## E5 — Counters and queues

120 people arriving evenly over half an hour at a desk that takes 40 s ±10 to
serve one person. Only the number of desks changes. "Offered load" is arrivals
divided by what the desks can serve: below 1 the system keeps up, above 1 it
does not.

| desks | offered load | mean queue | worst wait | mean journey | served of 120 |
| --- | --- | --- | --- | --- | --- |
| 1 | 2.67 | 690 s ±209 | 1472 s ±755 | 1683 s ±962 | **94** |
| 2 | 1.33 | 319 s ±47 | 634 s ±54 | 379 s ±51 | 120 |
| **3** | **0.89** | **14 s ±1** | 51 s ±2 | 69 s ±2 | 120 |
| 4 | 0.67 | 4 s ±1 | 49 s ±6 | 61 s ±1 | 120 |

**The third desk is worth twenty times the fourth.** Going from two desks to
three cuts the mean queue from 319 s to 14 s — a 96% reduction for a 50% increase
in staffing. Going from three to four saves a further 10 s. There is nothing
gradual about it: the third desk is the one that takes the offered load below 1,
and a queue below capacity settles while a queue above capacity just grows until
the doors close. **Half-provisioning a counter is not half as good, it is
qualitatively different**, and this is the single most useful shape in queueing
for anybody deciding how many people to roster.

**Variance explodes with the queue, which is its own warning.** At one desk the
seed spread on the worst wait is ±755 s on a mean of 1472 s — the three runs
differ by more than the whole mean wait at two desks. An oversaturated queue is
not just long, it is unpredictable, so a plan that lands there cannot be planned
around. At three and four desks the spread is ±2 s and ±6 s.

**At one desk, 26 people never got served at all** before the run ended. They
were still in the line. That is the honest output for a desk offered 2.7 times
what it can handle, and it is worth reading alongside the limitation that nobody
in this model ever gives up and walks away.

### Against textbook queueing

M/M/c is the standard closed form for this, and it is a useful outside check as
long as the difference is understood rather than hidden. For λ = 0.0667/s and
μ = 0.025/s:

| desks | M/M/c predicts | low-variability approximation | CROWD measured |
| --- | --- | --- | --- |
| 3 | 96 s | 3 s | 14 s |
| 4 | 11 s | 0.4 s | 4 s |

**CROWD's queues are shorter than M/M/c, and they should be.** M/M/c assumes
Poisson arrivals, which are bursty; these arrivals are spread evenly across the
window, which is much smoother, and smooth arrivals make short queues. The
service time is normal with a standard deviation of 10 s on a mean of 40, so its
coefficient of variation is 0.25 against the 1.0 an exponential assumes. Feeding
both into the Allen–Cunneen adjustment gives the third column, and the measured
figures sit between the two bounds — above the idealised approximation, because
people in a real room also have to walk to the desk and cannot occupy the same
floor on the way, and well below the Poisson figure.

That bracketing is the check. A model that came out *above* M/M/c on smooth
arrivals, or below the low-variability bound, would be wrong in a way worth
chasing. These do not.

---

## What the study found about the tool itself

Running a tool across configurations it has not been run across before is the
fastest way to find out what it is quietly wrong about. Five things turned up.

**1. Doors did not meter crowds.** The headline finding, above. Fixed, and now
pinned by `egress.test.ts`.

**2. A wall chain wiped itself.** Drawing a four-wall room is the first thing
anybody does, and it did not work: the wall tool advertises "click again to
continue", and every other click silently started a new wall instead, so five
clicks produced two walls. `ToolController.refresh` redrew tools by calling
`onActivate`, which for a drawing tool means _start over_, and committing a wall
segment is itself a document change. No unit test could have caught it — the
tools are driven directly in tests, where nothing re-enters `onActivate`, and
chaining works there. It needed the built app.

**3. Peak density does not discriminate between plans.** It is a maximum over
every person on every tick, so it finds the single worst moment of a run and
reads 6–7 persons/m² — in the doorway — for almost any plan with a crowd in it.
It is the right alarm and the wrong comparison. The share of person-seconds spent
at level of service E or F is what actually separates one layout from another,
and it is what the layout table below reports.

**4. A counter backed against a wall sends its queue outside the building.**
Placing a desk 4 m from the far wall put its queue slots past that wall, and
people walked out of the door and around the outside of the venue to join the
back of the line. Nothing warned about it — no finding, no run warning, and the
counter simply reported nobody served. This one is **not fixed**; the study works
around it by placing counters with room to queue into. It is a real trap for a
user, because the plan looks fine.

**5. Theatre seating costs nothing.** In the layout table below, the theatre row
is identical to the empty room in every column. That is a documented modelling
choice — loose chairs and seat rows are deliberately not navigation obstacles,
because eight chairs round a banquet table seal it off entirely once the grid
adds body clearance — but its consequence for a theatre is worth stating plainly:
**CROWD does not model the seating in a theatre evacuation at all.** People walk
through the rows. For a venue whose egress is dominated by row and aisle
geometry, that is a large simplification and the result should not be trusted.

---

## Performance

`npm run bench`, on an idle machine — four cores, no GPU. Rendering is not
measured here because it depends entirely on the GPU and this machine has none;
this is the cost of the physics alone.

| venue | asked | simulated | ms/step | µs/person/step | × real time |
| --- | --- | --- | --- | --- | --- |
| coffee bar | 50 | 50 | 2.15 | 42.9 | 47 |
| conference | 200 | 200 | 4.16 | 20.8 | 24 |
| conference | 500 | 222 | 3.98 | 18.0 | 25 |
| concourse | 500 | 359 | 7.18 | 20.0 | 14 |
| concourse | 1000 | 359 | 6.81 | 19.0 | 15 |
| banquet | 1000 | 258 | 5.85 | 22.7 | 17 |

**Cost per person is flat to falling as the crowd grows** — 42.9 µs at fifty
people, 18–23 µs from two hundred up. The fixed work in a step, the flow fields
and the grid and the density pass, is amortised over more people. This is the
property that matters: an all-pairs avoidance would show the opposite, and by
five hundred people it would be unusable.

**The venues cap themselves.** Asking the concourse for a thousand people
simulates 359, because that is what its arrival doors and itineraries deliver
inside the run. The µs/person figure is against the number actually simulated.

**Real-time factor is the honest weak spot.** Playback offers speeds up to × 60,
and these venues run at × 14 to × 47 on this machine, so the fastest setting does
not keep up for the larger ones — it runs as fast as it can and the clock stretches.
On a normal laptop core rather than a shared cloud one, the numbers are better,
but × 60 with a thousand people is not something this engine does today.

---

## Determinism

Every number above rests on the claim that the same plan run twice gives the same
answer — otherwise a difference between two configurations is partly noise and
nobody can tell which part. That claim is tested directly in
`src/library/determinism.test.ts`, which builds each template twice and compares
the whole summary, and in the fundamental-diagram sweep, which runs itself twice.

Within this study, the three seeds of a configuration differ only in their seed.
The spread across them is the `±` column, and it is what tells you whether a gap
between two rows is real: **2 × 3'0" on one wall clears in 109.1 s ±5.7 and on
opposite walls in 122.6 s ±3.1, so that 13-second gap is a finding; the 1-second
gap between the empty hall and the reception layout is not.**

## What this does not tell you

- **One storey.** No stairs, no escalators, no multi-storey egress, so none of
  the cases where those dominate.
- **Model-code indicative.** The code figures the tool checks against are
  model-code values; adoption and amendments vary and approval rests with the
  authority having jurisdiction. Nothing here is a certification.
- **No theatre seating**, as above.
- **No balking or reneging.** People who join a queue stay in it however long it
  gets, so the counter waits in E5 are longer than real ones would be at the
  saturated end.
- **A narrow door is pessimistic.** Below about 1.2 m the engine's specific flow
  falls under the observed band, because it keeps a fixed clearance between a
  body and a jamb and a narrow opening loses proportionally more of itself to it.
  RiMEA TC12 records this at its 0.8 m and 1.0 m widths and it is not fixed.
- **Three seeds is three seeds.** Enough to tell a 13-second effect from a
  1-second one, not enough for a confidence interval.
