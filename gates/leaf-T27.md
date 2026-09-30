# Gates: T27 data-quality end-to-end

Scope: seed each R5 case (stale, missing, duplicate, conflicting, late). Each one must be visible in the UI badge, in the evidence drawer, and in the agent's wording.

- [ ] G1: a fixture seeder produces all 5 cases, and a GraphQL check confirms each (test e2e_quality_cases)
  CHECK: cargo test --manifest-path api/Cargo.toml e2e_quality_cases 2>&1 | grep -E "running [1-9]|test result"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G2: the agent eval includes the 5 quality questions and states each case; the live eval prints the quality subset `EVAL quality passed 5/5`
  CHECK: bun run eval 2>&1 | grep "EVAL quality"
  EXPECT: EVAL quality passed 5/5
  EVIDENCE: pending

- [ ] G3: screenshots of the UI badge and drawer for each case (manual: paths under docs/evidence/quality/)
  EVIDENCE: pending
