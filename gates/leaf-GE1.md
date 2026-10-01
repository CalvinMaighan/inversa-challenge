# Gates: GE1 centered stage layout (see docs/GODS_EYE.md GC1, GC6, GC7)

Scope: black page, centered circular globe stage, chat card left, sighting details card right, top-right icon buttons (About/status, Theme, Developer), bottom-center bar. Narrow screens keep today's docked behaviour. Do not touch globe internals, look shaders, imagery, vessels or overlays.

- [ ] G1: at 1440x900 the page background is black outside the stage; the globe stage is horizontally centered (stage centre within 2 px of the viewport centre), chat card is left of the stage and the evidence card right of it, neither overlapping the stage centre. The e2e prints `STAGE centered=ok chat=left details=right margins=black`
  CHECK: cd apps/web && bun run e2e:stage 2>&1 | grep STAGE
  EXPECT: /STAGE centered=ok chat=left details=right margins=black/
  EVIDENCE: pending

- [ ] G2: the top right holds exactly three icon buttons (status, theme, developer) with accessible names, no visible text; the Developer button toggles `data-testid="developer-panel"` mount point (the panel body is GE3's; GE1 ships an empty slot component `DeveloperSlot` GE3 fills). The e2e prints `TOPRIGHT buttons=3 names=ok`
  CHECK: cd apps/web && bun run e2e:stage 2>&1 | grep TOPRIGHT
  EXPECT: /TOPRIGHT buttons=3 names=ok/
  EVIDENCE: pending

- [ ] G3: clicking a sighting opens its evidence in the right card; with nothing selected the right card is absent (stage still centered); closing returns focus. Prints `DETAILS open=1 closed=1 focus=ok`
  CHECK: cd apps/web && bun run e2e:stage 2>&1 | grep DETAILS
  EXPECT: /DETAILS open=1 closed=1 focus=ok/
  EVIDENCE: pending

- [ ] G4: at 375 px width the layout falls back to the existing mobile docks with no horizontal scroll; at 1024 px the cards overlap the stage edges without covering its centre. Prints `RESPONSIVE mobile=ok tablet=ok`
  CHECK: cd apps/web && bun run e2e:stage 2>&1 | grep RESPONSIVE
  EXPECT: /RESPONSIVE mobile=ok tablet=ok/
  EVIDENCE: pending

- [ ] G5: existing suites still pass on the new shell: layout, a11y (0 serious, 0 critical, keyboard walk), links
  CHECK: cd apps/web && bun run e2e:layout 2>&1 | grep LAYOUT && bun run e2e:a11y 2>&1 | grep -E "AXE|KEYBOARD" && bun run e2e:links 2>&1 | grep EXTERNAL-LINKS
  EXPECT: /LAYOUT [\s\S]*AXE serious=0 critical=0[\s\S]*KEYBOARD-OK[\s\S]*EXTERNAL-LINKS total=([1-9]\d*) new_tab=\1 unsafe=0/
  EVIDENCE: pending

- [ ] G6: unit suite, typecheck, lint, build clean
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && bun run --cwd apps/web build >/dev/null 2>&1 && echo CLEAN
  EXPECT: /^ *0 fail[\s\S]*CLEAN/m
  EVIDENCE: pending

- [ ] G7: screenshots at 1440x900 (nothing selected, a sighting selected) and 375x812 saved to docs/evidence/ and viewed; quote one observation per image
  EVIDENCE: pending
