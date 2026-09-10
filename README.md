# Crowd

Rehearse the event before the doors open.

Describe your event, watch simulated people move through your actual room,
and ask GPT-6 Astra to find a better setup within your constraints. Layout candidates reuse the same presampled people. Operating changes require
confirmation; changed arrivals retain people and service times and receive an
explicitly qualified comparison. Built solo in one day at the OpenAI GPT-6 Astra Hackathon NYC.

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
The saved-room picker contains the room snapshots bundled when the page was
built; use Open scene for additional or updated files. Plan exports a PNG with
measured overlays and a JSON bundle containing assumptions, results, candidate
patches, usage totals and replay frames. Import restores that replay without
calling the engine. Advice caches are labeled and keyed to the exact inputs.
Rehearse also has a presentation-only **Watch in 3D** toggle with Door, Buffet
and Overhead cameras. It reuses the same frames, heatmap and playback controls;
2D remains the default and the place to edit furniture.

Run tests with `.venv/bin/python -m pytest -q -k 'not live' --tb=short`.
The `test_astra_live_tiny_object` test makes a billable
call when a key is available; all other API tests use mocks.

## Results from the hackathon room (Puck Building, 3rd floor, 120 people, 2 volunteers)

| Setup | Walkway conflict (person-s) | Mean wait | Overflow | Completed |
|---|---:|---:|---:|---:|
| Line in the central aisle | 15,377 | 129 s | 99 | 120 |
| Line in the south corridor | 9,274 | 176 s | 90 | 120 |
| Third volunteer | 9,430 | 80 s | 82 | 120 |
| Tables called in waves, 15 min | 12,435 | 104 s | 81 | 120 |
| Tables called in waves, 20 min | 10,483 | 88 s | 65 | 120 |

Re-measured with the current engine: 120 people, front-loaded arrivals over
600 s, seed 1, horizon 1800 s, service mean 15 s. Rows use the same individual
speeds and service durations. Wave rows change arrivals to five equal scheduled
batches across 900/1200 s; they are different operating assumptions. The third
volunteer uses the current deterministic preset position. These rows replace
earlier unverified numbers, whose staffing placement and arrival scheduling
were not fully recorded.

The south-corridor line reduced walkway conflict about 40%, while mean wait
increased. Current staffing and wave presets have their own measured trade-offs;
changed arrivals are never automatically ranked as a better layout.

## Limits, stated plainly

Exploratory planning model, not a safety certification. Locomotion uses
JuPedSim's collision-free speed model. Queue and overflow positions are explicit;
service is followed by movement to a destination centroid and despawning, with no
detailed seating or dwell model. Every supplied obstacle, including a column,
participates in physics; omitted objects cannot be simulated. Room geometry is
provided as a schematic, not reconstructed from event photographs.

The throughput check remains unresolved: the west-wall candidate's service
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
ASTRA_BUILD.md for the build log including the engine deadlock Astra
diagnosed from traces.
## What was built today

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

Crowd code is MIT licensed; JuPedSim remains LGPLv3-or-later. See LICENSE.
