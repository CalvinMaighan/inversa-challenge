# Gates: T30 accessibility + mobile

Scope:
- Keyboard access for the orb, card, drawer and scrubber, with a visible focus ring and ARIA labels.
- A 375 px layout where panels become sheets.
- Reduced motion.

- [ ] G1: an axe-core scan on the main view reports 0 serious or critical violations; Playwright prints `AXE serious=0 critical=0`
  CHECK: cd apps/web && bun run e2e:a11y 2>&1 | grep AXE
  EXPECT: AXE serious=0 critical=0
  EVIDENCE: pending

- [ ] G2: a keyboard-only walk (Tab/Enter/Esc) reaches the orb, card, drawer and scrubber; the script prints `KEYBOARD-OK`
  CHECK: cd apps/web && bun run e2e:a11y 2>&1 | grep KEYBOARD
  EXPECT: KEYBOARD-OK
  EVIDENCE: pending

- [ ] G3: 375 px screenshots show no horizontal scroll and panels as sheets (manual: paths)
  EVIDENCE: pending

- [ ] G4: under `prefers-reduced-motion: reduce` the card opens without its morph beats, the agent's camera move does not fly, and no endless CSS animation runs (orb pulse, live pulses, working rows)
  CHECK: cd apps/web && E2E_SKIP_BUILD=1 bun run e2e:a11y 2>&1 | grep REDUCED-MOTION
  EXPECT: REDUCED-MOTION-OK
  EVIDENCE: pending
