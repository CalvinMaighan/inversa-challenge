# Gates: node-convo (integration of T13 T14 T15)

Scope: text or voice question leads to a cited answer, the globe flies to it, and a citation opens the drawer.

- [ ] N1: every child leaf gates file is met, or its ABANDON lines are live-only
  CHECK: node /Users/calvin/.claude/skills/unlazy/scripts/gate-check.mjs --timeout 120 --status gates/leaf-T13.md gates/leaf-T14.md gates/leaf-T15.md 2>&1 | tail -3
  EXPECT: /ALL MET|ABANDON/
  EVIDENCE: pending

- [ ] N2: agent eval in replay mode passes on the merged tree
  CHECK: cd apps/web && AGENT_EVAL_MODE=replay bun run eval 2>&1 | tail -1
  EXPECT: /EVAL passed (\d+)\/\1/
  EVIDENCE: pending

- [ ] N3: the Playwright convo flow (mock LLM + fixture Axum) produces a view event that moves the camera and a citation that opens the drawer; prints "CONVO-OK"
  CHECK: cd apps/web && bun run e2e:convo 2>&1 | tail -1
  EXPECT: CONVO-OK
  EVIDENCE: pending

- [ ] N4 (live, blocked on H5 H6): a real voice question gives a spoken answer with a citation (transcript quote)
  EVIDENCE: pending
