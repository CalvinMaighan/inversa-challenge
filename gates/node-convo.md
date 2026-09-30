# Gates: node-convo (integration of T13 T14 T15)

Scope: text or voice question leads to a cited answer, the globe flies to it, and a citation opens the drawer. The agent is live (GPT-6 Luna on OpenRouter, key from Doppler `inversa`/`dev`); there is no mock LLM.

- [x] N1: every child leaf gates file is met, or its ABANDON lines are live-only
  CHECK: node /Users/calvin/.claude/skills/unlazy/scripts/gate-check.mjs --timeout 120 --status gates/leaf-T13.md gates/leaf-T14.md gates/leaf-T15.md 2>&1 | tail -3
  EXPECT: /ALL MET|ABANDON/
  EVIDENCE: gates/leaf-T15.md: 9 gates | ALL MET (19 met, 1 abandoned)

- [x] N2: live agent eval passes on the merged tree (at least 13 of 15, quality at least 4 of 5)
  CHECK: bun run eval 2>&1 | grep -E "^EVAL (quality )?passed" | tr '\n' ' '
  EXPECT: /EVAL quality passed [45]\/5 EVAL passed 1[3-5]\/15/
  EVIDENCE: EVAL quality passed 5/5 EVAL passed 15/15

- [x] N3: the Playwright flow against the live agent and the fixture API produces a view event that moves the camera and a citation that opens the drawer; prints "FLOW-OK"
  CHECK: bun run --cwd apps/web e2e:agent 2>&1 | tail -1
  EXPECT: FLOW-OK
  EVIDENCE: FLOW-OK

- [ ] N4: (live, blocked on H6) a real voice question gives a spoken answer with a citation (transcript quote)
  EVIDENCE: pending

ABANDON: N4 blocked on H6 (XAI_API_KEY) for the spoken half; the agent half runs live in tests/live/agent/voice-runner.test.ts
