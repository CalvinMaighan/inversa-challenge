# Gates: node-data (integration of T4 T5 T7 T8 T9 T10 T11)

Scope: the Axum data plane runs end to end on fixtures: ingest pipeline, then DB, then frames/hotspots, then GraphQL.

- [ ] N1: every child leaf gates file is fully met, or its ABANDON lines are live-only
  CHECK: node /Users/calvin/.claude/skills/unlazy/scripts/gate-check.mjs --timeout 120 --status gates/leaf-T4.md gates/leaf-T5.md gates/leaf-T7.md gates/leaf-T8.md gates/leaf-T9.md gates/leaf-T10.md gates/leaf-T11.md 2>&1 | tail -3
  EXPECT: /ALL MET|ABANDON/
  EVIDENCE: pending

- [ ] N2: the full api test suite and clippy are clean on the merged tree
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep -c "test result: ok" && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1
  EXPECT: /[1-9][\s\S]*Finished/
  EVIDENCE: pending

- [ ] N3: an end-to-end fixture run (backfill --fixtures, then a GraphQL query for sightings, frames and evidence) returns non-empty results; the test is named e2e_fixture_pipeline
  CHECK: cargo test --manifest-path api/Cargo.toml e2e_fixture_pipeline 2>&1 | grep -E "running [1-9]|test result"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] N4: the schema contract still holds
  CHECK: cargo test --manifest-path api/Cargo.toml schema_matches_contract 2>&1 | grep "test result"
  EXPECT: /test result: ok\. [1-9]/
  EVIDENCE: pending
