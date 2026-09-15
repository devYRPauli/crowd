# CROWD — operating invariants

Rules that hold across the codebase. Break one and something subtle goes wrong
somewhere else.

## The document

- The scene document is the single source of truth, and it is plain, immutable
  and serialisable. No derived geometry, no renderer state, no results.
- Every edit goes through a pure function in `core/document/mutations.ts` that
  returns a new document sharing everything it did not touch. Structural sharing
  is what makes undo cheap and lets the renderer diff by array identity.
- Every edit reaches the store through `apply`, which is the only place history
  is written. An edit that escapes it escapes undo.
- Lengths are metres, angles are radians, time is seconds. The imperial setting
  only changes display and parsing.
- Every default dimension is a size somebody could order, and it comes from
  `core/model/standards.ts`. A door is 2'8" or 3'0" or a 6'0" pair, not 1.0 m.
  Four places used to each carry their own numbers and disagree about them; if
  you are about to write a dimension literal, it belongs there instead.

## The simulation

- Deterministic given the seed. Every stochastic decision draws from a seeded
  `Rng`; nothing calls `Math.random`, `Date.now` or an argless `new Date()`.
- Random streams are named after a thing's _position_ in the plan, never after
  its id. Ids are minted per document from `Math.random`, so a stream named
  after one makes the same venue built twice simulate differently — and a
  comparison against a baseline then measures the ids rather than the layout.
- The engine is pure: no DOM, no Three.js, no React, no I/O. It takes a plan and
  a scenario and produces numbers.
- Derived geometry lives in `core/model/planGeometry.ts` and is shared by the
  renderer and the engine, so the picture on screen and the world people walk
  through cannot disagree.
- Density is measured over an area a person occupies, never per grid cell.
- The navigation grid is sized by the narrowest opening people have to get
  through, not by the extent of the venue. A doorway is rasterised like anything
  else, and a grid too coarse to resolve one quietly closes it: at a fixed 0.3 m
  cell a 0.8 m door passed a fifth of what it should, and moved 15% on three
  millimetres of wall thickness.
- People never overlap. Contact is resolved in velocity before anyone moves and
  predictively — a pair may close only as fast as the gap allows in one step.
  Fixing an overlap after the fact cannot keep up, because the step that caused
  it has already happened.
- A density used to decide how fast somebody walks is read _ahead_ of them and
  excludes their own body. A ring counts the crowd behind you and turns a bunch
  into a platoon; the walker's own kernel peak is most of a level-of-service
  band on its own. The field itself counts everybody, because a person standing
  alone still occupies floor — it is the per-person questions that take their
  own body off.
- Results are never fabricated. If people could not finish, the run says so.
- Thresholds shown to the user carry the number they fired on.

## The renderer

- Rendering is on demand. An idle editor uses no GPU.
- The crowd is one instanced draw call; per-person work on the main thread is a
  matrix write, not a skeleton update.
- The left mouse button belongs to the active tool, always. Navigation lives on
  the right and middle buttons, the wheel and Space-drag.

## Tools

- A tool is a state machine over pointer and keyboard events. It reaches the
  store, the renderer and the DOM only through its `ToolContext`.
- A gesture is one undo step: pass a `coalesceKey` while it runs and seal it when
  it ends.
- Nothing is committed to the document until the gesture commits. A half-typed
  value never reaches it.

## Validation and honesty

- The validation suite is a public claim. Never loosen a threshold to make a test
  green: mark it failing, state the measured value and the target, and say so.
- Where the validation harness reimplements a rule the engine also has, the
  numbers that define the rule are shared between them. A harness that has
  drifted from the engine is measuring something nobody ships.
- Code-compliance figures are model-code indicative and the UI says so every
  time.
- Comments explain why, not what. If a line exists because of something that bit
  us, the comment says what bit us.

## Working on it

- `npm run check` before committing: typecheck, lint, tests.
- `npm run smoke` before claiming the app works. A unit suite cannot tell you
  that WebGL initialised, that the worker started or that a shader compiled.
