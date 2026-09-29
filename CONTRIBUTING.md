# Contributing

Issues and pull requests are welcome.

## Before you open a pull request

- `npm run check` passes: typecheck, lint, formatting and the tests.
- `npm run smoke` passes if you touched the app, the renderer or the worker. It
  builds the site and drives it in Chromium; run `npx playwright install
  chromium` once first (with `--with-deps` on Linux).
- Read `AGENTS.md`. It lists the rules the code relies on: every edit goes
  through a mutation, the simulation is deterministic given its seed, default
  sizes come from `standards.ts`, and so on. A change that breaks one of them
  usually breaks something far from where it was made.

## Changes to the simulation

The validation suite in `src/sim/validation/` is a public claim, and
`docs/VALIDATION.md` reports it. Do not loosen a threshold to make a test pass.
If a change moves a figure, say which one and by how much in the pull request,
and update the doc.

`src/library/determinism.test.ts` pins a hash of each template's run. A change
to the engine that alters behaviour will change them; update the pins in the
same commit and say why they moved.

## Reporting a bug

Say what you did, what you expected and what happened. If it concerns a venue,
attach the project file: the download button in the top bar saves it as
`<name>.crowd.json`.
