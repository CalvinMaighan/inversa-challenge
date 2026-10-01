# Gates: GE1 centered stage layout (see docs/GODS_EYE.md GC1, GC6, GC7)

Scope: black page, centered circular globe stage, chat card left, sighting details card right, top-right icon buttons (About/status, Theme, Developer), bottom-center bar. Narrow screens keep today's docked behaviour. Do not touch globe internals, look shaders, imagery, vessels or overlays.

- [x] G1: at 1440x900 the page background is black outside the stage; the globe stage is horizontally centered (stage centre within 2 px of the viewport centre), chat card is left of the stage and the evidence card right of it, neither overlapping the stage centre. The e2e prints `STAGE centered=ok chat=left details=right margins=black`
  CHECK: cd apps/web && bun run e2e:stage 2>&1 | grep STAGE
  EXPECT: /STAGE centered=ok chat=left details=right margins=black/
  EVIDENCE: STAGE centered=ok chat=left details=right margins=black

- [x] G2: the top right holds exactly three icon buttons (status, theme, developer) with accessible names, no visible text; the Developer button toggles `data-testid="developer-panel"` mount point (the panel body is GE3's; GE1 ships an empty slot component `DeveloperSlot` GE3 fills). The e2e prints `TOPRIGHT buttons=3 names=ok`
  CHECK: cd apps/web && bun run e2e:stage 2>&1 | grep TOPRIGHT
  EXPECT: /TOPRIGHT buttons=3 names=ok/
  EVIDENCE: TOPRIGHT buttons=3 names=ok

- [x] G3: clicking a sighting opens its evidence in the right card; with nothing selected the right card is absent (stage still centered); closing returns focus. Prints `DETAILS open=1 closed=1 focus=ok`
  CHECK: cd apps/web && bun run e2e:stage 2>&1 | grep DETAILS
  EXPECT: /DETAILS open=1 closed=1 focus=ok/
  EVIDENCE: DETAILS open=1 closed=1 focus=ok

- [x] G4: at 375 px width the layout falls back to the existing mobile docks with no horizontal scroll; at 1024 px the cards overlap the stage edges without covering its centre. Prints `RESPONSIVE mobile=ok tablet=ok`
  CHECK: cd apps/web && bun run e2e:stage 2>&1 | grep RESPONSIVE
  EXPECT: /RESPONSIVE mobile=ok tablet=ok/
  EVIDENCE: RESPONSIVE mobile=ok tablet=ok

- [ ] G5: existing suites still pass on the new shell: layout, a11y (0 serious, 0 critical, keyboard walk), links
  CHECK: cd apps/web && bun run e2e:layout 2>&1 | grep LAYOUT && bun run e2e:a11y 2>&1 | grep -E "AXE|KEYBOARD" && bun run e2e:links 2>&1 | grep EXTERNAL-LINKS
  EXPECT: /LAYOUT [\s\S]*AXE serious=0 critical=0[\s\S]*KEYBOARD-OK[\s\S]*EXTERNAL-LINKS total=([1-9]\d*) new_tab=\1 unsafe=0/
  EVIDENCE: pending

- [x] G6: unit suite, typecheck, lint, build clean
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && bun run --cwd apps/web build >/dev/null 2>&1 && echo CLEAN
  EXPECT: /^ *0 fail[\s\S]*CLEAN/m
  EVIDENCE: 0 fail | CLEAN

- [x] G7: screenshots at 1440x900 (nothing selected, a sighting selected) and 375x812 saved to docs/evidence/ and viewed; quote one observation per image
  EVIDENCE: docs/evidence/stage-1440.png: black page, the globe a feathered circle centred between the chat card (16..436 px) and an empty black right margin, three round icons top right, timeline from the card's edge to the right gutter, attribution "Data attribution" visible right of the card. docs/evidence/stage-1440-selected.png: "Burmese python spotted near Biscayne National Park" card at the right (x 1028..1428), the bracketed marker with its "SIGHTING 1" label at the stage centre, nothing covers the centre. docs/evidence/stage-375.png: phone docks unchanged, full-screen satellite globe, no circle, timeline above the collapsed "Ask the field agent..." sheet. (Also docs/evidence/stage-1024.png: both cards overlap the circle's edges, the marker at the centre stays clear.)

ABANDON: G5 blocked outside this leaf: every python a11y and links run fails at its first real agent turn with "OpenRouter: 402 This request requires more credits, or fewer max_tokens. You requested up to 16384 tokens, but can only afford 13825" (Doppler inversa/dev key limit; topping it up is the user's call). Layout-side evidence on the new shell: e2e:layout prints "LAYOUT app=python chat=left globe=right legend=ok tooltip=ok tabs=ok mobile=ok" and "THEMES light=ok dark=ok tactical=ok"; e2e:a11y with --app carp and --app lionfish (no agent turn) print "AXE serious=0 critical=0 scans=8" and "KEYBOARD-OK" for both; e2e:links reached total=1 new_tab=1 unsafe=0 (python) and total=6 new_tab=6 unsafe=0 (lionfish) before the 402. Re-run G5's CHECK once the key has credit.
