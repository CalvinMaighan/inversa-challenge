# Gates: T14 agent orb + morph card (opus)

Scope: `apps/web/client/agent/**`:
- The orb: a presence dot at idle, with a pulse ring while listening or speaking (deedee `voice-mode.styled.ts`).
- A click morphs it into a card of about 360×480 via a port of deedee `RectMorphPortal`/`useRectMorph`. Esc or click-away collapses it, and reduced motion is respected.
- The card holds an NDJSON chat stream (deedee `useAskNdjsonStream`), incremental markdown, and ActionTimeline tool rows.
- Citation chips set SELECTION and open the evidence drawer.
- A mic toggle wired to T15's voice runtime.

- [x] G1: component and logic tests pass
  CHECK: cd apps/web && bun test tests/client/agent 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"
  EXPECT: /([1-9][0-9]*) pass\s+0 fail/
  EVIDENCE: 55 pass | 0 fail

- [x] G2: Playwright flow against the mock agent: open the card, ask, tool rows render, click a citation, the drawer opens; prints FLOW-OK
  CHECK: cd apps/web && bun run e2e:agent 2>&1 | tail -1
  EXPECT: FLOW-OK
  EVIDENCE: FLOW-OK

- [x] G3: a 375 px viewport screenshot shows the card fully inside the viewport (manual; attach the screenshot path)
  EVIDENCE: docs/evidence/t14-card-375.png (written by e2e:agent at 375×812). Card measured 375×480 at x=0,y=332, so right edge 375 ≤ 375 and bottom 812 ≤ 812. e2e asserts this box before it takes the shot. Viewed: header, question, "Worked for" rows, answer with chips 1–3, and the composer all visible.

- [x] G4: reduced motion disables the morph animation (test asserts duration 0 under prefers-reduced-motion)
  CHECK: cd apps/web && bun test tests/client/agent -t "reduced motion" 2>&1 | grep -E "pass|fail"
  EXPECT: /1 pass[\s\S]*0 fail/
  EVIDENCE: 1 pass | 0 fail

- [x] G5: typecheck and lint clean
  CHECK: bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: CLEAN
  EVIDENCE: CLEAN
