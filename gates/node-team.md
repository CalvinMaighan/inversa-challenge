# Gates: node-team (integration of T12 T20 T21)

Scope: two browsers converge over RTC via the local signal worker, and over WS when RTC is off.

- [ ] N1: every child leaf gates file is met, or its ABANDON lines are live-only
  CHECK: node /Users/calvin/.claude/skills/unlazy/scripts/gate-check.mjs --timeout 120 --status gates/leaf-T12.md gates/leaf-T20.md gates/leaf-T21.md 2>&1 | tail -3
  EXPECT: /ALL MET|ABANDON/
  EVIDENCE: pending

- [ ] N2: CRDT vectors pass in both languages on the merged tree
  CHECK: cargo test --manifest-path api/Cargo.toml crdt -- --nocapture 2>&1 | grep "CRDT vectors passed" && cd apps/web && bun test tests/client/threads/crdt 2>&1 | grep "CRDT vectors passed"
  EXPECT: /CRDT vectors passed: (\d+)\/\1[\s\S]*CRDT vectors passed: (\d+)\/\2/
  EVIDENCE: pending

- [ ] N3: e2e:team re-run on the merged tree
  CHECK: cd apps/web && bun run e2e:team 2>&1 | grep TEAM
  EXPECT: /converged=1/
  EVIDENCE: pending
