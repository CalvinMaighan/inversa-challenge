# Gates: T30 accessibility + mobile

Scope:
- Keyboard access for the orb, card, drawer and scrubber, with a visible focus ring and ARIA labels.
- A 375 px layout where panels become sheets.
- Reduced motion.

- [x] G1: an axe-core scan on the main view reports 0 serious or critical violations; Playwright prints `AXE serious=0 critical=0`
  CHECK: cd apps/web && bun run e2e:a11y 2>&1 | grep AXE
  EXPECT: AXE serious=0 critical=0
  EVIDENCE: AXE serious=0 critical=0 (scans: 1440 loaded, 1440 answer, 1440 drawer, 1440 legend, 1440 help, 1440 missions, 375 main, 375 chat-sheet, 375 missions-sheet, 375 drawer-sheet, 375 legend, 375 help)

- [x] G2: a keyboard-only walk (Tab/Enter/Esc) reaches the orb, card, drawer and scrubber; the script prints `KEYBOARD-OK` (after T40 removed the orb: the chat column composer, a citation, the drawer, the timeline scrubber, the Layers legend, the help sheet and the Missions tab, each with a visible focus ring)
  CHECK: cd apps/web && bun run e2e:a11y 2>&1 | grep KEYBOARD
  EXPECT: KEYBOARD-OK
  EVIDENCE: KEYBOARD-OK

- [x] G3: 375 px screenshots show no horizontal scroll and panels as sheets (manual: paths)
  EVIDENCE: e2e:a11y on the T40 layout, 2026-10-01: `MOBILE main|chat-sheet|missions-sheet|drawer-sheet|legend|help overflow=0 hscroll=0 pagescroll=0`, sheet=yes for main (collapsed composer bar), chat-sheet (half), missions-sheet and drawer-sheet (full width, resting on the chat bar). Screenshots, all looked at: docs/evidence/mobile/main.png, chat-sheet.png, missions-sheet.png, drawer-sheet.png, legend.png, help.png. Before the fixes (pre-T40 run): feed chips scrolled sideways (ul 1203>337 px), the timeline date field spilled out of its bar, and the orb covered the sheets' last rows; fixed (phone feed summary toggle, step buttons hidden on phones, sheet bottom padding), then T40 replaced the orb.

- [x] G4: under `prefers-reduced-motion: reduce` the card opens without its morph beats, the agent's camera move does not fly, and no endless CSS animation runs (orb pulse, live pulses, working rows) (after T40: the card morph became the phone sheet, which must snap with a 0 ms transition)
  CHECK: cd apps/web && E2E_SKIP_BUILD=1 bun run e2e:a11y 2>&1 | grep REDUCED-MOTION
  EXPECT: REDUCED-MOTION-OK
  EVIDENCE: REDUCED-MOTION-OK flights=0 sheet=instant infinite-animations=0
