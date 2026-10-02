# Gates: T14 agent chat (opus), moved to the chat column by T40

Scope: `apps/web/client/agent/**`. T40 replaced the orb and its morph card with a chat column that is always open. The intent stays the same: the agent is one glance away, it streams, it shows its work, and it links to evidence.

- The chat column sits on the left. It is full height, about 420 px wide, and resizes between 360 and 560 px. It has Agent and Missions tabs. Under 768 px it becomes a bottom sheet that is collapsed to the composer bar, and you drag or tap it open to half or full height. Reduced motion is respected: the sheet and the data pop-out animate in 0 ms.
- The thread holds an NDJSON chat stream (deedee `useAskNdjsonStream`), incremental markdown, and ActionTimeline tool rows.
- Citation chips set SELECTION and open the evidence drawer.
- The composer has a mic button wired to T15's voice runtime, which pulses while listening or speaking, and a send button.

- [x] G1: component and logic tests pass
  CHECK: cd apps/web && bun test tests/client/agent 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"
  EXPECT: /([1-9][0-9]*) pass\s+0 fail/
  EVIDENCE: 83 pass | 0 fail

- [x] G2: Playwright flow against the live agent (GPT-6 Luna on OpenRouter, key from Doppler inversa/dev, fixture API). It prints FLOW-OK after these steps:
  - The chat column is visible at load: x=0, full height, 360–560 px wide, with the mic in the composer.
  - Ask a question. Tool rows render, and the globe flies.
  - Click a citation. The drawer opens and the column stays open.
  - Switch to the Missions tab and back. The thread is kept.
  CHECK: cd apps/web && bun run e2e:agent 2>&1 | tail -1
  EXPECT: FLOW-OK
  EVIDENCE: FLOW-OK

- [x] G3: a 375 px viewport screenshot shows the chat sheet opened to full height and fully inside the viewport (manual; attach the screenshot path)
  EVIDENCE: docs/evidence/t14-card-375.png (375×812, written by e2e:agent G2 with a live gpt-6-luna answer). The sheet measured 375×804 at 0,8, so its right edge is 375 ≤ 375 and its bottom 812 ≤ 812. The e2e asserts this box before it takes the shot. Viewed: grab handle, AGENT | MISSIONS tabs, "Agent ready", the question bubble, "Worked for 9s" with 3 tool rows, the answer with chips 1–4, the tegu table (3 rows), source chips, and the composer with the mic and send buttons, all inside the viewport.

- [x] G4: reduced motion turns off the sheet and pop-out animations (a test asserts that both durations are 0 under prefers-reduced-motion)
  CHECK: cd apps/web && bun test tests/client/agent -t "reduced motion" 2>&1 | grep -E "pass|fail"
  EXPECT: /1 pass[\s\S]*0 fail/
  EVIDENCE: 1 pass | 0 fail

- [x] G5: typecheck and lint clean
  CHECK: bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: CLEAN
  EVIDENCE: CLEAN
