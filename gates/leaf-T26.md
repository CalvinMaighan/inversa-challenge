# Gates: T26 node-root

Scope: all branches are integrated. The root GATES.md checks are met.

- [ ] G1: all four node gates files are met
  CHECK: node /Users/calvin/.claude/skills/unlazy/scripts/gate-check.mjs --timeout 120 --status gates/node-data.md gates/node-client.md gates/node-convo.md gates/node-team.md 2>&1 | tail -2
  EXPECT: /ALL MET|ABANDON/
  EVIDENCE: pending

- [ ] G2: bun run check prints CHECK-OK
  CHECK: bun run check 2>&1 | tail -1
  EXPECT: CHECK-OK
  EVIDENCE: pending
