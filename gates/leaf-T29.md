# Gates: T29 cold-snap replay fixture

Scope: pick a real winter cold snap from the backfill, with iguana cold-stun reports and a freeze alert. Package it as a fixture scene that the demo loads.

- [ ] G1: the fixture exists with sightings, readings and alerts in its window
  CHECK: ls api/fixtures/scenes/cold-snap* 2>/dev/null | wc -l | tr -d ' '
  EXPECT: /^[1-9]/m
  EVIDENCE: pending

- [ ] G2: loading the scene gives a timeline window where the iguana activity term flips to cold-stun (test scene_cold_snap)
  CHECK: cargo test --manifest-path api/Cargo.toml scene_cold_snap 2>&1 | grep -E "running [1-9]|test result"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G3: the scene dates and sources are documented in docs/demo-script.md
  CHECK: grep -ciE "cold.?snap" docs/demo-script.md
  EXPECT: /[1-9]/
  EVIDENCE: pending
