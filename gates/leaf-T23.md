# Gates: T23 node-client

Scope: integration node; see gates/node-client.md.

- [ ] G1: node gates met
  CHECK: node /Users/calvin/.claude/skills/unlazy/scripts/gate-check.mjs --timeout 120 --status gates/node-client.md 2>&1 | tail -2
  EXPECT: /ALL MET|ABANDON/
  EVIDENCE: pending
