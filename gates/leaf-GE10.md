# Gates: GE10 zoom control inline with the timeline, icons for the scale (user review 2026-10-01)

User words: "This zoom component is useful, but I think we could move it to be right of the timeline inline, and move the drag thing to the left side and replace the words with icons."

Interpretation (state it in your report, and keep it easy to flip): the zoom control leaves its floating vertical column and becomes a compact horizontal strip in the same row as the timeline, at its right end, the timeline narrowing to make room, one 12 px (`--gap-m`) gap between them and from the right edge and bottom. Inside the strip, left to right: the drag track with its handle on the LEFT, the seven scale stops drawn as icons instead of words, then the `-` and `+` buttons, the altitude readout ("2,170 km up") and the Reset view (home) button; Fit sightings stays where it is today if it exists as a button. The strip is the same height as the timeline's bar on python, carp (the taller stage timeline: align its bottom edge and keep the strip no taller than the bar) and lionfish.

Own only `client/hud/zoom/**`, `client/globe/zoom/**` (only if needed), `e2e/zoom.ts`, `docs/icons.md`, and the minimum append-only lines in the timeline components to reserve the strip's room (`client/hud/timeline/**`, `client/carp/CarpTimeline.tsx`) and `client/hud/index.tsx`. Keep GE9's spacing rules (`--gap-m`, the `stage spacing` test: extend it so the zoom strip's pairs are measured at 12 px, the exclusion now disappears).

- [ ] G1: icons replace the words. Seven stops, in order from close to far: Street, Neighbourhood, City, County, State or region, Country, World. Use Lucide icons (ISC licence, same pack as `docs/icons.md`, record the licence line and each icon id there): route (street), house (neighbourhood), building-2 (city), map-pinned or layers (county), map (state or region), flag (country), globe (world), or better ones you can justify. The current stop is highlighted; each icon has an accessible name and a tooltip with the old word; the slider keeps `role=slider` and `aria-valuetext` ("City, 12 km up"); no visible word labels remain except the altitude readout. Unit tests named `zoom strip` cover the icon map, ordering, thresholds (reuse GE8's model) and names
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "zoom strip" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G2: placement. At 1440x900 and 1024x768 on python, carp and lionfish the strip is in the timeline's row, to the right of it, 12 px from the timeline, the right edge and the bottom edge of the pane, the same top and bottom as the timeline's bar (strip height at most the bar height), and the drag track is the leftmost element inside the strip. Nothing floats in the right column any more (the old column and its free-slot placement logic are removed, not left as dead code). Prints `ZOOMSTRIP placed=ok gap=12 right=12 bottom=12 leftmost_track=1 height_le_bar=1 apps=python,carp,lionfish`
  CHECK: cd apps/web && bun run e2e:zoom 2>&1 | grep "ZOOMSTRIP"
  EXPECT: /ZOOMSTRIP placed=ok gap=12 right=12 bottom=12 leftmost_track=1 height_le_bar=1 apps=python,carp,lionfish/
  EVIDENCE: pending

- [ ] G3: everything GE8 promised still works through the new strip: `+` and `-` buttons and keys (`+`, `-`, Home), dragging the handle changes altitude on the log scale, clicking an icon stop flies to that scale, wheel and double click unchanged, limits and ground guard unchanged, the 3D tilt hint still shows once. The existing e2e lines pass unchanged in meaning: `ZOOM controls buttons=ok slider=ok keys=ok reset=ok fit=ok overlap=0 mobile=ok`, `ZOOM motion ...`, `ZOOM limits ...`, plus a new `ZOOMSTRIP icon_stops=7 click_stop=ok drag=ok`
  CHECK: cd apps/web && bun run e2e:zoom 2>&1 | grep -E "ZOOM controls|ZOOMSTRIP icon_stops|ZOOM motion|ZOOM limits"
  EXPECT: /ZOOM controls buttons=ok slider=ok keys=ok reset=ok fit=ok overlap=0[\s\S]*ZOOM motion step_ms=\d+ end_err_pct=[0-3][\s\S]*ZOOM limits min_3d_m=\d+[\s\S]*ZOOMSTRIP icon_stops=7 click_stop=ok drag=ok/
  EVIDENCE: pending

- [ ] G4: responsive and accessible: at 768 px the strip drops the icon stops and keeps track, `-`, `+`, readout and home in one row; at 375 px (phone docks) it collapses to `-` and `+` only above the dock with 12 px gutters and no horizontal scroll; keyboard order is track, then buttons; axe 0 serious and 0 critical with the strip focused; touch pinch still works; the idle governor stays idle
  CHECK: cd apps/web && bun run e2e:a11y 2>&1 | grep -E "AXE|KEYBOARD"
  EXPECT: /AXE (app=\w+ )?serious=0 critical=0[\s\S]*KEYBOARD-OK/
  EVIDENCE: pending

- [ ] G5: the 12 px spacing e2e has no zoom exclusion and passes: `SPACING pairs=<n> off=0` and `SPACING apps=python,carp,lionfish off=0 mobile_off=0` from `bun run e2e:stage` (fix the stage e2e's other two known misses while you are in there if they are layout bugs rather than test fragility: the tablet line `RESPONSIVE mobile=ok tablet=ok` (something other than the globe sits at the stage centre at 1024x768 with the sighting card open: find out what and fix it or the test), and `FRAMING inside=<n> outside=0` (carp's sites at 1024 load under the board: keep the sites in view))
  CHECK: cd apps/web && bun run e2e:stage 2>&1 | grep -E "SPACING|RESPONSIVE|FRAMING"
  EXPECT: /RESPONSIVE mobile=ok tablet=ok[\s\S]*FRAMING inside=\d+ outside=0[\s\S]*SPACING pairs=\d+ off=0[\s\S]*SPACING apps=python,carp,lionfish off=0 mobile_off=0/
  EVIDENCE: pending

- [ ] G6: web unit, typecheck, lint, build clean; screenshots at 1440x900 (python, carp, lionfish), 1024x768 and 375x812 saved to docs/evidence/ and viewed, one observation each
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && bun run --cwd apps/web build >/dev/null 2>&1 && echo CLEAN
  EXPECT: /^ *0 fail[\s\S]*CLEAN/m
  EVIDENCE: pending
