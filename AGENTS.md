# Crowd operating invariants

- Keep changes surgical and verify each milestone before claiming completion.
- The engine is a pure function independent of FastAPI and OpenAI.
- JuPedSim moves people; the deterministic engine measures behavior.
- People are presampled once per seed and reused across layout comparisons.
- The model never produces numbers shown in the UI; only the engine does.
- Validate every model output with schema checks and validate all resulting
  scene geometry with Shapely before use. Validate proposals against the original
  scene, preserve locked obstacles, and reject changes outside permitted scope.
- 3D is presentation-only playback of the existing measured frames; no 3D physics,
  no photo reconstruction, and no per-person model calls.
- Do not claim native steering unless it is actually implemented.
- Keep secrets out of source control and logs; never log prompts or image bytes.
- Commit after each milestone, with a one-line summary appended to ASTRA_BUILD.md.
