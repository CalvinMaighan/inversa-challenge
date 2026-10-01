# Gates: node-team (integration of T12 T20 T21)

Scope: two browsers converge over RTC via the local signal worker, and over WS when RTC is off.

- [x] N1: every child leaf gates file is met, or its ABANDON lines are live-only
  CHECK: node /Users/calvin/.claude/skills/unlazy/scripts/gate-check.mjs --timeout 120 --status gates/leaf-T12.md gates/leaf-T20.md gates/leaf-T21.md 2>&1 | tail -3
  EXPECT: /ALL MET|ABANDON/
  EVIDENCE: gates/leaf-T21.md: 4 gates | ALL MET (13 met, 1 abandoned)

- [x] N2: CRDT vectors pass in both languages on the merged tree
  CHECK: cargo test --manifest-path api/Cargo.toml crdt -- --nocapture 2>&1 | grep "CRDT vectors passed" && cd apps/web && bun test tests/client/threads/crdt 2>&1 | grep "CRDT vectors passed"
  EXPECT: /CRDT vectors passed: (\d+)\/\1[\s\S]*CRDT vectors passed: (\d+)\/\2/
  EVIDENCE: CRDT vectors passed: 17/17 | CRDT vectors passed: 17/17

- [x] N3: e2e:team re-run on the merged tree
  CHECK: cd apps/web && bun run e2e:team 2>&1 | grep TEAM
  EXPECT: /converged=1/
  EVIDENCE: TEAM local_same_frame=20/20 local_p50=0.8 rtc_p50=11 rtc_p95=25 ws_p50=82 ws_p95=87 converged=1
