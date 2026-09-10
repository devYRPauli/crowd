# Crowd

Real-world crowd simulation, powered by GPT-6 Astra. Rehearse the event
before the doors open.

Describe your event in plain words, watch simulated people move through your
actual room, and ask GPT-6 Astra to find a better setup within your
constraints. The same loop applies wherever people queue and move: event
venues, registration desks, polling stations, transit halls and street
festivals. Layout candidates reuse the same presampled people. Operating changes require
confirmation; changed arrivals retain people and service times and receive an
explicitly qualified comparison. Built solo in one day at the OpenAI GPT-6 Astra Hackathon NYC.

## Demo

[Watch the demo](https://drive.google.com/file/d/16EyIkHmOk2unT87y4pLUmtnSdRWW8VXG/view?usp=sharing)

Open `http://127.0.0.1:8000/?demo=1` and press the Play the demo button (or
the D key); the page drives itself through the whole flow with captions. Its
Room selector offers open coffee, furnished coffee, and the Puck room. See
[DEMO.md](DEMO.md) for the exact walkthrough and recording commands.

## What it does

1. A floor plan or a sketch becomes a scene (walls, tables, entrances,
   exits, queue route, walkways to keep clear).
2. A plain-English brief becomes a scenario: how many people, how they
   arrive, how many volunteers, how long service takes. Astra lists every
   assumption it made; you confirm them.
3. JuPedSim moves the people. A deterministic engine measures waits,
   walkway conflicts, overflow, and completion.
4. "Find a better setup": Astra proposes up to two permitted changes
   (layout or operations). The engine tests them on the same presampled
   people. Astra explains which numbers moved and why, including
   "neither candidate helps; capacity is the limit."

## What Astra does, and what it does not

Astra interprets briefs, proposes bounded changes, and explains measured
results. Only the engine produces measured results. Astra chooses proposed scenario or
geometry values, which are displayed as assumptions for review.
It cannot touch locked furniture, attendance, or service time. Operations
candidates (arrival waves, staffing) are labeled as changed assumptions
and require confirmation.

## Run it

From this checkout, with [uv](https://docs.astral.sh/uv/) installed:

```sh
uv venv --python 3.12 .venv
source .venv/bin/activate
uv pip sync requirements.txt
python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

Open http://127.0.0.1:8000. The sample and its layout options work without
`data/` or an API key. Set `OPENAI_API_KEY` in your environment or local `.env`
for Astra; keep that file private. Local data and usage logs are gitignored.
`?demo=1` needs `OPENAI_API_KEY`; without a key use the sample room and the
deterministic what-if chips.
The saved-room picker contains the room snapshots bundled when the page was
built; use Open a room for additional or updated files. The primary 3D room view
has Plan, Room and Buffet cameras and shares the measured replay, heatmap,
clock and playback controls. Open `http://127.0.0.1:8000/?view=2d` for the 2D
editor and renderer fallback.

A pinned baseline keeps its scene, scenario and measured people while you preview
other setups. Make a new baseline explicitly when you want to replace it. Matched
runs retain the same people even after an arrival change; only their arrival times
are rescheduled. Cohort handles live in bounded server memory and can expire or
be lost on restart. An unavailable handle produces an explicit error; run and pin
a new baseline to resume matched comparisons.

Plan exports a furniture-and-queue PNG without people, with a measured summary,
and a JSON bundle containing assumptions, results, candidate patches, usage totals
and replay frames. Import restores that replay without calling the engine. The
plain-text setup note is generated locally from the displayed scene, engine
measurements and person events; it makes no Astra call. Advice caches are labeled
and keyed to the exact inputs.

Run tests with `.venv/bin/python -m pytest -q -k 'not live' --tb=short`.
Final full verification: **330 passed, 2 strict expected failures** (dense
dinner), with one existing Starlette/AnyIO deprecation warning. The tracked
viewer harness passes 41 checks and setup notes pass 16 assertions.
The `test_astra_live_tiny_object` test makes a billable
call when a key is available; other model calls in the tests are mocked.

## Results from the hackathon room (Puck Building, 3rd floor, 120 people, 2 volunteers)

| Setup | Walkway conflict (person-s) | Mean wait (s) | Max wait (s) | Completed |
|---|---:|---:|---:|---:|
| Your room: line in the central aisle | 15,295.05 | 128.06 | 174.65 | 120/120 |
| Line in the south corridor | 9,208.80 | 174.18 | 254.10 | 120/120 |
| Third volunteer | 9,346.65 | 79.23 | 126.90 | 120/120 |
| Fourth volunteer | 3,216.10 | 28.35 | 77.80 | 120/120 |
| Five arrival waves over 15 min | 12,463.20 | 104.52 | 218.40 | 120/120 |

Measured after the physical exit correction (`1753837`), with the fourth
volunteer rechecked during the final user pass: Arrival mode, 120
people, front-loaded arrivals over 600 s, seed 1, horizon 1800 s, service mean
15 s. Every completion has a distinct person's exit event inside an exit
polygon. Layout and staffing rows reuse the exact presampled people. The waves
row changes only their arrival times to five batches at 0/180/360/540/720 s;
this is an operating assumption, not a dinner table-call simulation.

The south-corridor layout reduces walkway conflict by about 40% but increases
mean wait by about 36%. A third volunteer cuts mean wait by 38% and walkway
conflict by 39% versus Your room. The staffing sweep rehearses one to four
volunteers with the same people: one volunteer serves only 113 of 120 before
the horizon, and a fourth cuts mean wait to 28 s. Staffing materially
constrains waits in this scenario; geometry and queue handoff also matter. Waves reduce mean wait and conflict but
increase maximum wait. These are measured trade-offs, not safety or optimality
claims. Astra's live candidate can differ; see [DEMO.md](DEMO.md) for the
recorded proposal and API timings.

The simpler examples also finish at exits: open coffee room 60/60, mean wait
89.09 s and max 180.75 s; furnished coffee room 60/60, mean 87.36 s and max
173.30 s. Both have zero measured walkway conflict, with 60 uniform arrivals
over 300 s, two volunteers, 15 s service, seed 1 and an 1800 s horizon.

## Limits, stated plainly

Exploratory planning model, not a safety certification. Locomotion uses
JuPedSim's collision-free speed model. Queue and overflow positions are explicit;
arrival-mode service is followed by a destination waypoint and departure through
an exit. Dinner-call guests return to their assigned seat or standing position
and remain visible. **Dinner call is experimental:** the physically occupied
120-person Puck baseline completes only 24, and its waves variant completes 0.
The two full-size dinner acceptance tests remain explicit strict expected failures;
the verified demo uses Arrival mode. No eating-duration or free-roaming behavior
is modeled. Every supplied obstacle, including a column,
participates in physics; omitted objects cannot be simulated. Room geometry is
provided as a schematic, not reconstructed from event photographs.

The earlier west-wall throughput check remains an unresolved limitation: the west-wall candidate's service
positions were busy 85.9% / 50.9% during nonempty-queue time, and its mean wait
was 2.04 times the baseline's. Some generated layouts can still stall; incomplete
runs are reported and never rewarded for lower waits or fewer completions.
A bounded Chrome 152 check on an Apple M1 Pro measured 120.3 fps across 360
frames with 150 person instances and loaded furniture; this is a local test,
not a performance guarantee. The supplied wide character uses capsule fallback.
Three.js is loaded lazily from a pinned CDN version; if unavailable, 2D remains
usable. Decorative asset bounding boxes approximate the supplied polygons.

Proposal jobs and server caches are in-process and disappear on restart. Astra
latency and connectivity vary; a 28.436 s proposal result is one observed test,
not a latency guarantee. Simulation results depend on the displayed assumptions.

## Built with

Assets: Kenney and KayKit, CC0. See [asset attribution](static/assets/ATTRIBUTION.md).

JuPedSim (LGPL), FastAPI, a plain-JS canvas viewer, Three.js r180, OpenAI Responses
API with structured outputs. Development in Codex with GPT-6 Astra; see
[ASTRA_BUILD.md](ASTRA_BUILD.md) for the build log including the engine deadlock Astra
diagnosed from traces.

## What was built today

Crowd's original application code was built during today's hackathon.
Third-party components include JuPedSim, FastAPI, Three.js, Shapely, NumPy,
Pydantic, Uvicorn and the OpenAI SDK, plus CC0 assets from Kenney and KayKit.
Pinned Python dependencies are listed in requirements.txt.

- `a791aa6`: schema, synthetic sample, API scaffold, Astra usage receipts.
- `90594ea`: deterministic queue rehearsal, presampling, accounting and tests.
- `e6fa1f5`: canvas playback, binary frames and person-event inspection.
- `182caec`, `076c63a`: handoff, overflow, watchdog and entrance regressions.
- `edcb8ac`: interpretation, permitted proposals and grounded explanations.
- `97c0cfd`: compact, polled proposal jobs and bounded API retries.
- `572fbd2`: confirmed operations, arrival waves, judge moves and dragging.
- `d99feab`: furnished room-plan presentation.
- `c2b62f9`: CC0 furniture sprites and models.
- `79d6bde`: five-step guided flow, room palette and sprite fallbacks.
- `6d26641`: replay/export hardening, advice recovery, clean-start verification.
- `58a2199`: live Astra work panel, correction notices and canvas rule feedback.
- `d0ed10d`: shared 3D replay, CC0 furniture models and capsule fallback.
- `9e3b8af`, `1d5cc27`: pinned Your room baseline and immutable comparison cohorts.
- `a71981a`, `31e2755`: concise validation and incomplete-run comparison guard.
- `75ae854`: primary 3D room editor and shared camera/playback state.
- `d9c0396`, `2765dbc`: readable plan controls, cached comparisons and progress.
- `bea546e`, `71a3548`: deterministic setup notes and clean measured PNG exports.
- `6ba1e0b`: dinner release modes; subsequent physical occupancy exposed the documented experimental limit.
- `c15098f`: focused demo and proportioned open/furnished coffee examples.
- `1753837`: physical exit completion, persistent dinner occupancy and explicit experimental status.
- `80189e1`: verified demo runs, measured numbers in the README and the DEMO.md recording guide.

Crowd code is MIT licensed; JuPedSim remains LGPLv3-or-later. See LICENSE.
