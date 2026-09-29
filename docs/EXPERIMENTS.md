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

**Measured on the engine committed with this document**, on an Apple M1 Pro
with 8 cores. The previous edition was measured at 15e844e, and the commits
since changed how people route round seating, how they reach a seat in a row,
and how a queue keeps its order. Several of its findings did not survive the
re-measurement; each section below says which, and
[What moved since 15e844e](#what-moved-since-15e844e) says which commit moved
each number.

## How to read these numbers

**The venues are built, not loaded.** `scripts/study/harness.mjs` draws each hall
the way somebody would draw it in the editor — four walls, doors cut into them,
furniture placed on the floor — rather than opening a template. A template is a
fixed answer, and the question here is what happens when a plan _changes_.

**The doors are real doors.** Widths come out of `src/core/model/standards.ts`,
the same stock-size table the inspector offers, so a 3'0" leaf is 0.914 m and not
a round metric number that no supplier sells.

**Every figure is three seeds, except E2, which is twenty.** `±` is half the
spread across them, so a difference smaller than the `±` beside it is not a
difference. Where a single number appears without a `±` it is derived from the
mean rather than measured per-seed. E2's differences are a few seconds against a
seed spread of ten, too small for three seeds to rank, so it runs twenty and
reports each layout's cost over the empty hall with the standard error of that
difference.

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

With both fixes, on today's engine, over three seeds (`npx vite-node
scripts/study.mjs doors`, the saturated flow between the 20th and 80th person
out):

| leaf | clear width | people/s | per m clear | per m **effective** |
| --- | --- | --- | --- | --- |
| 2'0" | 0.610 m | 0.53 ±0.08 | 0.87 | 1.70 |
| 3'0" | 0.914 m | 1.14 ±0.06 | 1.24 | 1.85 |
| 6'0" pair | 1.829 m | 2.61 ±0.09 | 1.43 | 1.71 |
| 8'0" pair | 2.438 m | 3.26 ±0.09 | 1.34 | 1.52 |

Four times the width buys 6.2 times the flow. Charged against clear width the
specific flow rises with the opening up to the 6'0" pair, which is what the
observational literature reports: a narrow door loses proportionally more of
itself to the clearance people keep from the jambs. Charged against SFPE's
**effective** width, clear width less a 0.15 m boundary layer each side, it
reads 1.52 to 1.85, so the disagreement with the literature is mostly about how
much of an opening is usable, not about how fast people walk through one.

The single 3'0" leaf is the one that moved: at 15e844e it passed 1.00 people/s,
1.63 per effective metre and in line with the others, and it now passes 1.14,
the highest per effective metre of the four.
It moved at 30b1fba: the one-leaf clearance in E1 went from 207.9 s to 182.0 s
there and at no other commit (see
[What moved since 15e844e](#what-moved-since-15e844e)).

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
| 1 × 2'0" | 0.610 m | 356.3 s ±41.2 | 0.53 | 0.87 | 7.26 ±0.09 | 97.4 ±0.4 |
| 1 × 3'0" | 0.914 m | 182.0 s ±6.0 | 1.04 | 1.14 | 7.11 ±0.03 | 95.2 ±0.1 |
| **1 × 6'0" pair** | **1.829 m** | **80.8 s ±1.8** | 2.35 | 1.29 | 6.77 ±0.06 | 90.5 ±0.6 |
| 2 × 3'0", same wall | 1.828 m | 110.2 s ±1.9 | 1.72 | 0.94 | 6.64 ±0.02 | 92.6 ±0.2 |
| 2 × 3'0", opposite walls | 1.828 m | 127.7 s ±8.5 | 1.49 | 0.81 | 6.72 ±0.13 | 93.4 ±1.1 |
| 4 × 3'0", one per wall | 3.656 m | 61.4 s ±3.9 | 3.09 | 0.85 | 5.88 ±0.08 | 89.4 ±1.3 |

**One wide opening beats two narrow ones of the same total width, by a lot.**
Three rows of that table have essentially identical clear width, 1.829 m against
1.828 m, and clear the same hall in 80.8 s, 110.2 s and 127.7 s. Putting the
same 6 feet of door into two separate leaves rather than a single pair costs
**36%** more clearance time; splitting those two leaves onto opposite walls
costs a further 16%, or **58%** against the pair. The seed ranges of the three
do not overlap, so all three gaps are real. The finding held from 15e844e, and
grew: the pair got faster and the split doors did not.

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

**Diminishing returns set in.** Going from 0.914 m to 1.829 m, double the width,
cuts clearance from 182.0 s to 80.8 s, better than double. Going on to 3.656 m
only reaches 61.4 s, a further 1.32x for another doubling, because by then the
doors have stopped being the only constraint and the time is going into walking
across the room to reach them. There is a width past which more door buys little,
and for this hall and this crowd it is not far past a single 6'0" pair.

**The narrow case is a warning.** A 2'0" leaf — a real door, sold as a closet
door, and narrower than any code would allow for egress, takes 6 minutes to
clear the room and holds the crowd at level of service E or F for 97.4% of it.
The tool's own code check flags widths like this against IBC minimums; this is
what the number underneath that check looks like.

---

## E2 — What the furniture costs

The same hall and the same 200 people, out through two 3'0" leaves on the south
wall, with the floor laid out six different ways. Twenty seeds each; "vs empty"
is the difference in mean clearance from the empty hall, ± the standard error
of that difference.

| layout | items | floor left | clearance | vs empty | mean journey | % of time at LOS E/F | µs/person/step |
| --- | --- | --- | --- | --- | --- | --- | --- |
| empty | 0 | 590 m² | 108.7 s ±8.9 | | 52.9 s ±5.7 | 92.1 ±1.1 | 10.3 |
| standing reception | 8 | 586 m² | 106.7 s ±8.4 | -2.0 s ±1.6 | 51.6 s ±3.5 | 92.4 ±0.9 | 12.9 |
| classroom | 350 | 511 m² | 113.0 s ±11.6 | +4.4 s ±1.9 | 56.8 s ±5.9 | 93.0 ±1.1 | 14.6 |
| banquet rounds | 360 | 474 m² | 111.2 s ±7.6 | +2.6 s ±1.5 | 55.3 s ±3.9 | 93.5 ±0.7 | 23.8 |
| theatre | 28 | 590 m² | 112.8 s ±10.6 | +4.1 s ±1.5 | 55.7 s ±4.3 | 92.9 ±1.2 | 10.3 |
| theatre, rows marked solid | 28 | 359 m² | 118.0 s ±9.4 | +9.4 s ±1.7 | 58.9 s ±5.7 | 94.2 ±1.6 | 11.3 |

**Furniture costs little.** The classroom adds 4.4 s to the empty hall's 108.7 s,
banquet rounds 2.6 s and theatre rows 4.1 s: 2 to 4%, for layouts that take up
to 20% of the floor. The standing reception is no different from the empty
room. For this hall the exits dominate so completely that what is on the floor
matters far less than the 58% swing between exit arrangements in E1, which is
itself the finding, and the reason to be suspicious of a plan that has been
optimised by moving tables around. Everybody got out in all 120 runs.

**Two findings of the previous edition are withdrawn.** At 15e844e the classroom
cost 16% and banquet rounds cleared faster than the classroom while covering
more floor, which that edition read as round tables leaving diagonal routes
where ranks of desks make corridors. Neither holds now: the classroom costs 4%,
and it and the banquet are 1.8 s apart with a standard error of 1.8, which is no
difference at all. What moved them is in
[What moved since 15e844e](#what-moved-since-15e844e). Three seeds would not
have caught the change either way: the first three put the classroom 3%
*faster* than the empty hall.

**Theatre rows now cost something, and solid ones cost more.** Crossing a seat
row is priced at four times open floor in the flow field, so people go round the
rows by the aisles, and passable rows add 4.1 s. Marking every row an obstacle,
the override the inspector offers per item, takes 231 m², 39% of the floor, out
of circulation and adds 9.4 s, 9%: 5.3 s more than rows left passable.
**Everybody still gets out**, which is the part worth checking: the aisles carry
the crowd rather than stranding it, so this is a usable configuration and not
just a stricter one.

**If you are modelling a theatre, mark the rows as obstacles.** Priced rows keep
people on the aisles when nothing pushes them off, but somebody shoved in among
the seats can still cross a row. The shipped default is chosen for banquet and
reception floors, where solid chairs would wall people into their own tables.

**Furniture is what costs compute, not people.** Per-person step cost more than
doubles from the empty room to the banquet layout, 10.3 to 23.8 µs, on the same
crowd. Every item is an obstacle the avoidance layer tests against.

---

## E3 — How it scales with the size of the crowd

Same hall, same two 3'0" exits on the same wall, everybody arriving at once.

| people | clearance | people/s | mean journey | peak density | % of time at LOS E/F | µs/person/step |
| --- | --- | --- | --- | --- | --- | --- |
| 50 | 24.8 s ±2.8 | 1.92 | 11.7 s ±1.1 | 3.11 ±0.30 | 39.7 ±7.0 | 27.0 |
| 100 | 59.1 s ±4.0 | 1.61 | 28.7 s ±2.6 | 5.60 ±0.02 | 79.7 ±3.1 | 15.8 |
| 200 | 110.2 s ±1.9 | 1.72 | 53.0 s ±1.5 | 6.64 ±0.02 | 92.6 ±0.2 | 11.0 |
| 400 | 191.4 s ±4.0 | 1.99 | 91.8 s ±0.6 | 7.11 ±0.07 | 98.2 ±0.1 | 8.6 |
| 800 | 304.8 s ±14.7 | 2.49 | 139.6 s ±4.9 | 7.55 ±0.08 | 99.6 ±0.0 | 8.1 |

**Clearance is sub-linear in the crowd: sixteen times the people take 12.3
times as long.** That is not efficiency, it is the walk-up washing out. With
fifty people the doors are never continuously busy and most of the clearance time
is somebody walking across the room; with eight hundred the doors run at capacity
from the first second to the last, so the marginal person costs only their share
of the doorway. The flow column shows it directly: 1.92 people/s at fifty, 1.61
at a hundred, 2.49 at eight hundred. That last is 1.25 per leaf, above the 1.14 a
single 3'0" leaf passes in the door table with two hundred behind it, so in this
engine a door passes somewhat more with a bigger crowd pressing on it. Fifty is
the odd one out at the other end, faster than a hundred: most likely because
fifty reach two doors without much of a queue at either and walk through at
close to walking pace instead of shuffling through a jam.

The planning reading is the uncomfortable one: **a hall that clears
comfortably at half occupancy tells you very little about the same hall full.**
Doubling the crowd roughly doubles the time, but the density people experience on
the way out keeps climbing, and it is the density that hurts: the share of time
spent at level of service E or F goes from 40% at fifty to 93% at two hundred and
99.6% at eight hundred.

**Cost per person falls as the crowd grows**, from 27.0 to 8.1 µs per person per
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
| all at once | 170 ±1 | 7.09 ±0.13 | 130.8 s ±13.7 | 200 |
| uniform over 120 s | 112 ±7 | 6.93 ±0.06 | 79.3 s ±8.4 | 200 |
| uniform over 600 s | 8 ±0 | 1.07 ±0.02 | 15.3 s ±0.3 | 200 |
| peak at 600 s | 20 ±2 | 1.91 ±0.29 | 15.6 s ±0.2 | 200 |

**This is the largest effect in the whole study, and it costs nothing to change.**
The same 200 people through the same doors into the same room take 130.8 s each
if they all turn up together and 15.3 s each if they are spread over ten minutes,
an 8.5x difference in what each person experiences, with not one thing about the
building altered. Peak occupancy falls from 170 to 8 and peak density from 7.09
to 1.07 persons/m2, which is the difference between a crush and a quiet room.

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
| 1 | 2.67 | 1494 s ±95 | 2950 s ±121 | 1556 s ±94 | 120 |
| 2 | 1.33 | 314 s ±49 | 636 s ±77 | 372 s ±52 | 120 |
| **3** | **0.89** | **14 s ±0** | 48 s ±4 | 69 s ±1 | 120 |
| 4 | 0.67 | 4 s ±0 | 47 s ±4 | 61 s ±0 | 120 |

**The third desk is worth thirty times the fourth.** Going from two desks to
three cuts the mean queue from 314 s to 14 s, a 96% reduction for a 50% increase
in staffing. Going from three to four saves a further 10 s. There is nothing
gradual about it: the third desk is the one that takes the offered load below 1,
and a queue below capacity settles while a queue above capacity just grows until
the doors close. **Half-provisioning a counter is not half as good, it is
qualitatively different**, and this is the single most useful shape in queueing
for anybody deciding how many people to roster.

**Above capacity the queue is as long as arithmetic says.** With arrivals every
15 s and a desk that takes 40, the k-th person waits about 25k seconds first
come, first served: a mean of 1488 s and a worst of 2975 s at one desk, 298 s
and 595 s at two. Measured, 1494 s and 2950 s at one desk, 314 s and 636 s at
two. The spread across seeds grows with the queue, ±95 s and ±49 s on the mean
against ±0 at three and four desks, because an oversaturated queue carries
every slow service and every early arrival forward to everybody behind it.

Those worst waits are what first come, first served gives because two queue
bugs were fixed during this re-measurement; finding 6 has both. Before them
two desks read 1706 s ±59 and one desk 3507 s ±251.

The previous edition reported 26 of 120 never served at one desk and a mean
queue of 690 s. Everybody is served now. That 690 s is below what any order
of service gives a desk that takes 40 s a person, so part of the wait was not
being counted as queueing. The mean moved at 424e647, which made a queue past
its drawn line carry on from the last person in it: 692 s to 1573 s on seed 1
(see [What moved since 15e844e](#what-moved-since-15e844e)).

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
fastest way to find out what it is quietly wrong about. Five things turned up
the first time and a sixth on the re-measurement.

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

**4. A counter backed against a wall sent its queue outside the building.**
Placing a desk 4 m from the far wall put its queue slots past that wall, and
people walked out of the door and around the outside of the venue to join the
back of the line. Nothing warned about it — no finding, no run warning — and in
the study's own setup the counter served nobody at all.

The trap underneath it was circular: the extent used to decide "inside" came
from the plan's bounding box, which is computed partly *from the queue lines*,
so a queue running out of the building stretched the bounds to contain itself.
The building is what its walls enclose. **Fixed**: the line is mirrored about the
counter when the drawn direction leaves the building and the other does not, and
overflow past the drawn slots is bounded by the building, so a queue longer than
its floor bunches against the wall instead of continuing through it. The counter
that served 0 of 30 now serves 30 of 30.

That bound covered the slots but not the chain past them, where each newcomer
stands behind the person ahead on the side they came from. In the banquet hall
they came through the front door, so guests still outside joined where they
stood and 9, 25 and 30 people (seeds 1, 8, 14) queued outside at once; the bar's
overflow also wound between the tables. **Fixed**: a place past the line is
turned until it is on floor inside the building, clear of seating and doorways,
and nobody joins until they are standing on such floor. No place is outside or
in the seating in those runs now.

**5. Theatre seating cost nothing by default.** At 15e844e the theatre row of
the layout table was identical to the empty room in every column, because loose
chairs and seat rows ship as passable (eight chairs round a banquet table would
seal it off entirely once the grid adds body clearance), and people walked
straight through the rows.

Since then crossing a chair or a seat row costs four times open floor in the
flow field, so people go round by the aisles unless they are shoved in among
the seats, and an audience reaches a seat from the end of its row and leaves
the same way. Passable rows now cost 4.1 s ±1.5 over the empty hall and solid
ones 9.4 s ±1.7. It is still **mitigated rather than fixed**: a row is not an
obstacle unless it is marked as one, somebody pushed out of a row's passage on
the way in can still cross the back of the row (the engine test measures 2
over four seeds), and nothing prompts a user drawing a theatre to mark the
rows solid.

**6. A queue did not serve people in the order they came.** At two desks in
E5 the worst wait was 1706 s ±59, against a mean of 300 s and the roughly 600 s
first come, first served would give. A trace of one run found one person moved
back 35 places while they waited. The desk's line runs away from the door, so
everybody walks up beside it from the front, and a walker joined the queue as
soon as they were within 1.6 m of the back place, or touching the drawn line
anywhere. Joined there they were still ahead of the person at the back, and the
queue's reordering, which keeps the queue in the order people stand in because
a head stranded at the back stops the counter, put them in front. **Fixed**:
somebody beside the line and more than a place ahead of its back does not join
until they have walked past the back. In the traced run the worst wait fell
from 1657 s to 809 s and the number of places anybody was moved back from 224
to 30.

That left one desk at 3699 s ±113 against about 2975 s. There the queue holds
seventy people, ten on the drawn line and the rest in a chain behind them
that winds back beside the line, and the reordering ranked the chain by
distance to the end of the line, which in a winding chain is not the order
anybody stands in. It swapped people 2,000 to 4,000 times a run, and the
longest wait belonged to whoever joined 48th to 62nd of 120. **Fixed**: past
the drawn places each person stands behind the one ahead, so the order they
joined in is kept. The swaps fell to under 35 a run, the longest wait belongs
to the last to join on all three seeds, and one desk reads 2950 s ±121.

`engine.test.ts` pins both. At a 30 s desk with the line running away from
the door, the worst wait was 620 to 682 s and is now 436 to 446 s, against
about 450 s first come, first served. With sixty people over 400 s, 2, 4 and 1
people who arrived well before the last waited longer than the last did, and
now nobody does.

---

## Performance

`npm run bench` on the same M1 Pro, with the engine committed here and with
15e844e's, run back to back. The machine was not idle (other work held its load
average near 10), and run to run these figures move by 10 to 30%, so read
nothing into a smaller difference. Rendering is not measured; this is the
physics alone.

| venue | asked | simulated | ms/step | µs/person/step | × real time | 15e844e ms/step | 15e844e µs/person |
| --- | --- | --- | --- | --- | --- | --- | --- |
| coffee bar | 50 | 42 | 1.27 | 30.1 | 79 | 1.42 | 28.4 |
| conference | 200 | 167 | 6.70 | 40.1 | 15 | 2.52 | 12.6 |
| conference | 500 | 167 | 7.21 | 43.2 | 14 | 2.48 | 11.6 |
| concourse | 500 | 294 | 11.00 | 37.4 | 9 | 4.40 | 12.2 |
| concourse | 1000 | 294 | 11.80 | 40.1 | 8 | 5.25 | 14.6 |
| banquet | 1000 | 181 | 7.06 | 39.0 | 14 | 3.88 | 15.8 |

**A step costs roughly two to three times what it did at 15e844e**, on fewer
people, so 2.5 to 3.7 times as much per person everywhere but the coffee bar.
The same bench at every commit puts it at 30b1fba: the conference went from 2.4
to 8.5 ms a step there, 16 to 63 µs a person. 1bda5cd took back about a third, and
98480ab's conference session, with a seat for every delegate, added 1.2 ms.
A profile of the bench puts two thirds of the time in the eikonal solver and
27% under `ensurePointField`, which 30b1fba added: a field solved for each
cell the person ahead stands on, so that somebody joining a queue past its
drawn line walks to them instead of bouncing off a table. That is the place to
look first.

**The venues cap themselves.** Asking the concourse for a thousand people
simulates 294, because that is what its entrance and ticket gate let in during
the measured window. It was 221 before the second queue fix in finding 6, when
the gate's overflow jammed the entrance, and 359 at 15e844e. The µs/person
figure is against the number actually simulated. In a room without a queue,
cost per person falls as the crowd grows, from 27 µs at fifty to 8 at eight
hundred (E3).

**Real-time factor is the weak spot, and it got weaker.** Playback offers
speeds up to × 60. At 15e844e these venues ran at × 19 to × 70; now only the
coffee bar keeps up, and the concourse manages × 8, so the fastest setting runs
as fast as it can and the clock stretches.

---

## Determinism

Every number above rests on the claim that the same plan run twice gives the same
answer — otherwise a difference between two configurations is partly noise and
nobody can tell which part. That claim is tested directly in
`src/library/determinism.test.ts`, which builds each template twice and compares
the whole summary, and in the fundamental-diagram sweep, which runs itself twice.

Within this study, the three seeds of a configuration differ only in their seed.
The spread across them is the `±` column, and it is what tells you whether a gap
between two rows is real: **2 × 3'0" on one wall clears in 110.2 s ±1.9 and on
opposite walls in 127.7 s ±8.5, so that 17-second gap is a finding; the 2-second
gap between the empty hall and the reception layout, -2.0 s ±1.6 over twenty
seeds, is not.**

The re-measurement is also a check on the claim. E2's first three seeds are the
seeds the other experiments use, and they reproduce the E1 row for the same
hall exactly: 110.2 s ±1.9. The queue fix in finding 6 changed no experiment
without a queue in it, to the tenth of a second.

## What moved since 15e844e

Every commit since 15e844e that touches the engine, run over the study's own
configurations in a separate checkout: the same three seeds for clearance and
journey, seed 1 alone for the E5 rows. Commits that changed only templates, the
code check or the editor were not run.

| commit | what it changed | what moved |
| --- | --- | --- |
| 0d0244d | a shove in a crush no longer carries somebody through a wall | nothing |
| 424e647 | a queue past its drawn line carries on from the last person in it, and the queue follows the order people stand in | E5: two desks' worst wait 689 to 1677 s, one desk's mean queue 692 to 1573 s |
| c57a030 | crossing a chair or a seat row costs four times open floor | theatre 113.9 to 120.6 s, classroom 125.0 to 121.1 s, banquet 116.2 to 119.7 s, the empty hall 0.1 s |
| 30b1fba | somebody pushed into a gap the grid closes heads for the nearest floor they can walk to; nobody counts themselves in the queue at the exit they chose | every egress number, below |
| cf08a0f | guests sit on their chairs | nothing |
| 1bda5cd | an overflowing queue stays inside the building and out of the seating | E5: one desk's mean queue 1569 to 1501 s, two desks' worst wait 1638 to 1657 s |
| 5667501, 4c171e3, da5f7ba, 4524fb7 | how an audience reaches and leaves a seat | nothing: nobody in the study sits down |
| this edition | the two queue-order fixes in finding 6 | E5 only |

30b1fba was written for the banquet buffet, and it moved the study more than
anything else:

| configuration | before | after |
| --- | --- | --- |
| 1 × 3'0" | 207.9 s | 182.0 s |
| 1 × 6'0" pair | 85.7 s | 80.8 s |
| 2 × 3'0", same wall | 114.0 s | 110.2 s |
| 2 × 3'0", opposite walls | 122.5 s | 127.7 s |
| standing reception | 111.9 s | 102.9 s |
| classroom | 121.1 s | 107.0 s |
| banquet rounds | 119.7 s | 108.8 s |
| theatre | 120.6 s | 115.2 s |
| theatre, rows solid | 125.9 s | 117.3 s |
| E4 all at once, mean journey | 118.4 s | 130.8 s |

The scan does not separate its two changes. A room with one exit offers no
choice, so the single leaf's 12% came from where people pushed into a jamb go
next. The opposite-walls case getting slower while every same-wall case got
faster is most likely the exit choice, since only there does the choice decide
which wall people walk to.

The classroom's cost over the empty hall went from 11.1 s at 15e844e to 7.1 s
at c57a030 and to -3.2 s at 30b1fba, on three seeds each. Twenty seeds put it
at +4.4 s ±1.9 now. Most of the previous edition's 16% went at 30b1fba, which
was not written about classrooms at all.

## What this does not tell you

- **One storey.** No stairs, no escalators, no multi-storey egress, so none of
  the cases where those dominate.
- **Model-code indicative.** The code figures the tool checks against are
  model-code values; adoption and amendments vary and approval rests with the
  authority having jurisdiction. Nothing here is a certification.
- **Theatre rows are priced, not solid.** Crossing a row costs four times open
  floor, so people go round by the aisles, but a row is not an obstacle unless
  it is marked as one. See finding 5.
- **No balking or reneging.** People who join a queue stay in it however long it
  gets, so the counter waits in E5 are longer than real ones would be at the
  saturated end.
- **A narrow door is pessimistic.** Below about 1.2 m the engine's specific flow
  falls under the observed band, because it keeps a fixed clearance between a
  body and a jamb and a narrow opening loses proportionally more of itself to it.
  RiMEA TC12 records this at its 0.8 m and 1.0 m widths and it is not fixed.
- **Three seeds is three seeds.** Enough to tell a 17-second effect from a
  2-second one, not enough for a confidence interval. Over three seeds the
  classroom read 3% faster than the empty hall, and over twenty it is 4%
  slower, so E2 runs twenty; the other experiments are three.
