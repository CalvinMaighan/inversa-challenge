# Gates: GE9 uniform 12 px spacing, Look in the top-right cluster, scope shape and size (user review 2026-10-01)

User words: "fix the padding and gap alignments so that there is uniform padding and gap of 12px `--gap-m` around the ui elements, and between the top species button and the chat, and between timeline and chat. Also this look thing should be an icon button top right with popover anchor position bottom right aligned. Also for the feather and round window map I want to be able to have it not just be circle with only the feather dictating how much circle there is."

Start after GE7 (integration) and GE8 (zoom) are merged: this leaf touches the layout and the scope they also touch. `--gap-m` is `12px` (`client/themes/palette.ts`). This supersedes the earlier idea of putting Look inside the Theme popover: Look is its own icon button.

- [ ] G1: one spacing unit. `GUTTER_PX` and every hand-written 8, 10, 14, 16, 18, 20 px outer margin or gap on the stage chrome is replaced by the `--gap-m` token (CSS) or a constant derived from it (geometry maths), so the numbers cannot drift. A unit test named `stage spacing` asserts `GUTTER_PX === 12` and that geometry.ts, StageShell, BottomBar, TopBar, Timeline, EvidenceDrawer, chat column and zoom controls take their spacing from the token (grep for stray px values in those files fails the test)
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "stage spacing" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G2: measured on the page at 1440x900 and 1024x768 (desktop layout), every pair below is exactly 12 px (tolerance 0.5 px): viewport edge to chat card on the left, top and bottom; chat card to the species or app button row (the top-left controls) horizontally; chat card to the timeline horizontally; timeline to the bottom and right viewport edges; right card to the right and top viewport edges; the top-right icon buttons to each other and to the top and right edges; the zoom controls (GE8) and the bottom bar to their neighbours. The e2e prints one line `SPACING pairs=<n> off=0` with the list of measured pairs in the log
  CHECK: cd apps/web && bun run e2e:stage 2>&1 | grep "SPACING"
  EXPECT: /SPACING pairs=([1-9]\d+) off=0/
  EVIDENCE: pending

- [ ] G3: the same holds for the carp and lionfish apps (their extra panels: sites board, survey panel, timelines) and on the tablet width, and at 375x812 the phone docks use 12 px gutters too. Prints `SPACING apps=python,carp,lionfish off=0 mobile_off=0`
  CHECK: cd apps/web && bun run e2e:stage 2>&1 | grep "SPACING apps"
  EXPECT: /SPACING apps=python,carp,lionfish off=0 mobile_off=0/
  EVIDENCE: pending

- [ ] G4: Look is an icon button in the top-right cluster (order: About, Theme, Look, Developer; icon only, accessible name "Look: filters and map window", `aria-haspopup="dialog"`), and its popover opens below the button with the popover's right edge aligned to the button's right edge (use the existing `PopoverBox align="right"` pattern from the top bar), staying inside the viewport at 1440x900 and 375x812. The Look button is removed from the bottom bar. Prints `LOOKBTN topright=1 aligned_right=1 inside_viewport=1 bottombar_has_look=0`
  CHECK: cd apps/web && bun run e2e:stage 2>&1 | grep "LOOKBTN"
  EXPECT: /LOOKBTN topright=1 aligned_right=1 inside_viewport=1 bottombar_has_look=0/
  EVIDENCE: pending

- [ ] G5: the scope has shape, size and edge as three independent controls. Keys `SCOPE_SHAPE` (`circle|oval|rounded|frame`, default `circle`), `SCOPE_SIZE` (30..100 percent of the available stage, default 100) and the existing `SCOPE_ON` and `SCOPE_FEATHER`. Circle and oval keep their aspect rules, rounded is a rounded rectangle, frame is the whole free area with only the feathered edge. Size scales the shape about the stage centre; feather only softens the edge. The popover shows Shape (segmented), Size slider and Soft edge slider in plain words, plus the window on/off switch and the seven looks. Unit tests named `scope shape` cover the mask maths for every shape (CSS or canvas, whichever the single scope implementation uses), validators, defaults and share-link round trip (`shape`, `size`, `feather`)
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "scope shape" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G6: measured on screenshots: the visible window area differs per shape (circle, oval, rounded, frame), size 50 shows about a quarter of the area of size 100 (area scales with the square of the size), feather 0 vs 60 changes only the edge width, and the window stays centred on the stage. Prints `SCOPE-SHAPE circle=<n> oval=<n> rounded=<n> frame=<n> size50_over_size100=<r> feather_edge0=<px> feather_edge60=<px> centred=1` with all four shape areas distinct, r between 0.20 and 0.30 and feather_edge60 greater than feather_edge0
  CHECK: cd apps/web && bun run e2e:look 2>&1 | grep "SCOPE-SHAPE"
  EXPECT: /SCOPE-SHAPE circle=\d+ oval=\d+ rounded=\d+ frame=\d+ size50_over_size100=0\.(2\d|30) feather_edge0=\d+ feather_edge60=([1-9]\d*) centred=1/
  EVIDENCE: pending

- [ ] G7: nothing regressed: the earlier stage, look, zoom, layers, vessels, overlays, places, developer, media, layout, a11y (0 serious, 0 critical, keyboard OK with the Look popover open from the top right) and links e2e lines still print their expected values; picking a shape or size updates the share link and the cards never cover the window centre
  CHECK: cd apps/web && bun run e2e:stage 2>&1 | grep -E "STAGE|TOPRIGHT|DETAILS|RESPONSIVE" && bun run e2e:look 2>&1 | grep -E "LOOK presets|SCOPE " && bun run e2e:a11y 2>&1 | grep -E "AXE|KEYBOARD"
  EXPECT: /STAGE centered=ok[\s\S]*TOPRIGHT buttons=4[\s\S]*LOOK presets=7 compiled=7[\s\S]*AXE (app=\w+ )?serious=0 critical=0[\s\S]*KEYBOARD-OK/
  EVIDENCE: pending

- [ ] G8: web unit, typecheck, lint, build clean; screenshots at 1440x900 with the four shapes (circle size 100, oval, rounded size 70, frame) and the Look popover open top right, plus 375x812, saved to docs/evidence/ and viewed with one observation each; the 12 px rhythm is visible in at least one annotated screenshot
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && bun run --cwd apps/web build >/dev/null 2>&1 && echo CLEAN
  EXPECT: /^ *0 fail[\s\S]*CLEAN/m
  EVIDENCE: pending
