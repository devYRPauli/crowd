# Crowd demo

Open `http://127.0.0.1:8000/?demo=1` at 1920 × 1080.

## Demo strings

Brief:

> 120 guests arrive for the event over 600 seconds, front-loaded, with two volunteers and 15 seconds of service per guest. Use seed 1 and a 1800 second horizon.

Constraints:

> Keep two volunteers and the dining tables. Keep the central aisle clear.

These defaults were written for this pass because no DEMO.md existed when demo mode was requested.

Coffee example brief (open and furnished rooms):

> 60 guests arrive for coffee uniformly over 300 seconds, with two volunteers and 15 seconds of service per guest. Use seed 1 and a 1800 second horizon.

## The presentation workflow

Use **Arrival**, not Dinner call. Plan is the default camera. People enter,
queue, receive service, pass the destination and finish only at an exit.

| Order | Click or key | Expected screen |
|---:|---|---|
| 1 | Open `/?demo=1` | Puck Building in Plan view, four rail steps, 120 people and two volunteers in the title. |
| 2 | Event → Interpret | Editable assumptions from the prefilled brief. Verify 120 people, 600 s, front-loaded, seed 1, horizon 1800 s, Arrival, two volunteers and 15 s service. Pause 2 s. |
| 3 | Confirm | Rehearse opens and Run becomes available. |
| 4 | Run | Your room is pinned; completion is 120/120. Max wait is 174.65 s and walkway conflict is 15,295.05 person-s. |
| 5 | Select 10× → Play | The simulation clock advances; guests enter through the door and move along the measured route. |
| 6 | Click a person | Their queue, service and exit events appear. Scrubbing changes visible positions, not the measured totals. |
| 7 | Press 2, 3, then 1 | Room, Buffet, then Plan camera. Focus a button first; shortcuts do not intercept typing. |
| 8 | Improve → Find a better setup | The working panel shows constraints, legal operations, rationale, validation and simulation progress. |
| 9 | Candidate A | Side-by-side measurements against Your room and a grounded explanation. Pause 3 s. An operations proposal requires Confirm before measurement. |
| 10 | Press R → Improve | Restores the pinned Original without another simulation; return to Improve for the next chip. |
| Optional | Only one volunteer → Confirm | A labeled operating preview. The recorded check completed 113/120 and correctly shows the red incomplete-run message; these waits are not comparable. |
| Optional | Press R → Improve → Call tables in waves (15 min) → Confirm | Arrival preview uses five batches across 900 s. One extended recording received HTTP 409; its retained baseline was not a measured waves result. |
| Optional | After a successful waves measurement, Rehearse → scrub to 175 s → Play at 10× | Watch the second arrival wave at 180 s. Pause, then restore Original with R. |
| 11 | Improve → Add a third volunteer → Confirm | A three-volunteer preview compared with the same pinned baseline. |

If Astra or Wi-Fi fails, retain the last successful labeled cache or use Run
and the deterministic what-if chips. Do not describe an unavailable candidate
as tested. A red incomplete-run message means no better-layout claim is allowed.

## Current seed-1 measurements

These rows use the final physical-exit engine and 15 s mean service. Each row
has exactly one exit event per guest, with its position inside an exit polygon.
Puck uses 120 people over 600 s front-loaded; coffee uses 60 over 300 s uniformly.
Every row uses seed 1 and horizon 1800 s. The first three Puck rows share exact
presampled people; waves changes only arrival times.

| Configuration | Mean wait (s) | Max wait (s) | Walkway conflict (person-s) | Done | Engine wall time (s) |
|---|---:|---:|---:|---:|---:|
| Puck, Your room | 128.06 | 174.65 | 15,295.05 | 120/120 | 4.62 |
| Puck, permitted south-corridor layout | 174.18 | 254.10 | 9,208.80 | 120/120 | 5.61 |
| Puck, third-volunteer preset | 79.23 | 126.90 | 9,346.65 | 120/120 | 3.78 |
| Puck, five arrival waves / 900 s | 104.52 | 218.40 | 12,463.20 | 120/120 | 4.31 |
| Open coffee room | 89.09 | 180.75 | 0 | 60/60 | 2.50 |
| Furnished coffee room | 87.36 | 173.30 | 0 | 60/60 | 2.60 |

Engine wall times are direct local measurements, distinct from the HTTP and
model-call timings below. Live Astra proposals can choose a different legal
patch; Candidate A is not guaranteed to equal the south-corridor preset.

## Browser checks and remaining limits

At 1920 × 1080, verified all six palette placements and removals, realistic
footprints, lock/unlock, Plan and perspective dragging, rotation, Escape,
queue-vertex movement, keep-clear drawing and invalid-drag rollback. Also
checked baseline preservation, cached toggles, camera/playback controls,
clean PNG export and deterministic setup-note download. These are bounded
checks, not a claim that every possible generated room works.

Fixed during the final walkthrough: assumptions were clipped; the canvas
pushed transport below the viewport; dinner assumptions incorrectly claimed
all guests were seated. The recorder initially selected both the body and rail
button with `data-step`; it now targets navigation buttons explicitly. A second
recording tried a what-if button while Reset had returned to Rehearse; the
script now returns to Improve before each chip and opens Rehearse for playback.
Both failed recording receipts are retained locally.

Dinner call remains **experimental**. With all 120 Puck guests physically
present and returning to their places, baseline/south/third/waves completed
24/16/23/0 respectively. These are incomplete and not comparable. The two
full-size dinner acceptance assertions remain strict expected failures.
The earlier west-wall utilization result remains unresolved at 85.9%/50.9%.
No universal corridor-width or crowd-safety conclusion is claimed.

## Final recorded run — September 10, 2026

The final core recording completed successfully: **1920 × 1080, 99.8 seconds**.
Every recorded request returned HTTP 200, and all three measured runs finished
120/120. Interpret took **8.300 s**; the first Run took **4.537 s**; proposal
click to Candidate A becoming available, including the first explanation,
took **29.317 s**. These are observations, not latency guarantees.

| Recorded selection | Mean wait (s) | Max wait (s) | Walkway conflict (person-s) | Completed |
|---|---:|---:|---:|---:|
| Your room | 128.06 | 174.65 | 15,295.05 | 120/120 |
| Astra Candidate A | 174.69 | 258.55 | 9,146.30 | 120/120 |
| Third volunteer | 79.23 | 126.90 | 9,346.65 | 120/120 |

Candidate A retained the desk and staffing. Its queue vertices were
`[[17,5.3],[16.9,4.9],[16.9,2],[12.4,2]]` and its overflow polygon was
`[[7.5,4.2],[11.7,4.2],[11.7,5.8],[7.5,5.8]]`. It reduced walkway conflict
while increasing both wait measures. The recording waits for Astra's actual
explanation before the three-second comparison pause.

The five completed model calls in this recording used 6,955 input and 1,629
output tokens, an estimated **$0.151** at the requested rates. The local JSON
receipt contains exact metrics, accounting, candidate scene/patch, step times
and all request timings. It is separate from the video and is gitignored.

Visual inspection of the saved comparison frame confirmed the room, measured
columns, completion count and explanation. Remaining presentation rough edges:
long explanations require scrolling in the right panel, and unchanged arrival
previews repeat the original schedule. These were left in place to finish the
verified workflow promptly. The video is encoded at 25 fps; that is distinct
from the live renderer's measured frame rate.

<details>
<summary>Every API request in the final recording</summary>

| # | Request | Elapsed (s) | HTTP |
|---:|---|---:|---:|
| 1 | `GET /api/usage` | 0.077 | 200 |
| 2 | `POST /api/interpret` | 8.300 | 200 |
| 3 | `POST /api/scene/validate` | 0.016 | 200 |
| 4 | `POST /api/run` | 4.537 | 200 |
| 5 | `GET /api/frames/{run_id}` | 0.047 | 200 |
| 6 | `POST /api/propose` | 0.012 | 200 |
| 7 | `GET /api/propose/{job_id}` | 0.003 | 200 |
| 8 | `GET /api/propose/{job_id}` | 0.005 | 200 |
| 9 | `GET /api/propose/{job_id}` | 0.002 | 200 |
| 10 | `GET /api/propose/{job_id}` | 0.003 | 200 |
| 11 | `GET /api/propose/{job_id}` | 0.002 | 200 |
| 12 | `GET /api/propose/{job_id}` | 0.004 | 200 |
| 13 | `GET /api/propose/{job_id}` | 0.003 | 200 |
| 14 | `GET /api/propose/{job_id}` | 0.005 | 200 |
| 15 | `GET /api/propose/{job_id}` | 0.002 | 200 |
| 16 | `GET /api/propose/{job_id}` | 0.002 | 200 |
| 17 | `GET /api/propose/{job_id}` | 0.002 | 200 |
| 18 | `GET /api/propose/{job_id}` | 0.004 | 200 |
| 19 | `GET /api/propose/{job_id}` | 0.003 | 200 |
| 20 | `GET /api/propose/{job_id}` | 0.024 | 200 |
| 21 | `GET /api/propose/{job_id}` | 0.004 | 200 |
| 22 | `GET /api/propose/{job_id}` | 0.004 | 200 |
| 23 | `GET /api/propose/{job_id}` | 0.003 | 200 |
| 24 | `GET /api/propose/{job_id}` | 0.003 | 200 |
| 25 | `GET /api/propose/{job_id}` | 0.022 | 200 |
| 26 | `GET /api/propose/{job_id}` | 0.016 | 200 |
| 27 | `GET /api/propose/{job_id}` | 0.002 | 200 |
| 28 | `GET /api/propose/{job_id}` | 0.008 | 200 |
| 29 | `GET /api/propose/{job_id}` | 0.004 | 200 |
| 30 | `GET /api/usage` | 0.005 | 200 |
| 31 | `POST /api/explain` | 7.053 | 200 |
| 32 | `GET /api/usage` | 0.004 | 200 |
| 33 | `POST /api/propose/{job_id}/run` | 5.202 | 200 |
| 34 | `GET /api/frames/{run_id}` | 0.043 | 200 |
| 35 | `POST /api/explain` | 9.838 | 200 |
| 36 | `GET /api/usage` | 0.009 | 200 |
| 37 | `POST /api/operations` | 7.846 | 200 |
| 38 | `GET /api/frames/{run_id}` | 0.033 | 200 |
| 39 | `POST /api/explain` | 8.462 | 200 |
| 40 | `GET /api/usage` | 0.007 | 200 |

</details>

## Backup recording

The script uses installed Chrome in a separate headed 1920 × 1080 profile.
It makes real API calls, pauses 2 s at assumptions and 3 s at comparisons, and
writes video plus a JSON timing/measurement receipt. Install its optional
video encoder once, then record:

```sh
uv run --no-project --with playwright --python 3.12 -m playwright install ffmpeg
uv run --no-project --with playwright --python 3.12 scripts/record_demo.py --timeout-s 120 --chips third
```

The final backup follows the core workflow and the third-volunteer preview;
the optional one-volunteer and waves detours are omitted. The script supports
`--chips one waves third` for a longer check and fails on rejected measurements.

Output: `out/demo_backup.webm` and `out/demo_backup.json` (gitignored).
Existing recordings are protected; use `--overwrite` deliberately to replace
one. Failed runs preserve a partial video and an explicit failed receipt.
