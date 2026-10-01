# Gates: GE2 visual presets and scope/feather (see docs/GODS_EYE.md GC2)

Scope: seven presets (normal, crt, nvg, flir, noir, anime, snow) as Cesium PostProcessStages with 500 ms crossfade; scope mask with feather slider; a "Look" popover in the bottom bar. Original GLSL, not copied from the reference. No layer code imports the look module.

- [ ] G1: preset registry and state. Unit tests named `look presets` cover: seven ids, default `normal`, share-link round trip of `look`, `scope`, `feather`, invalid values fall back to defaults
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "look presets" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G2: every preset's GLSL compiles in a real WebGL2 context (headless Chromium) and renders a non-black frame over the globe; the e2e prints `LOOK presets=7 compiled=7 nonblack=7`
  CHECK: cd apps/web && bun run e2e:look 2>&1 | grep "LOOK presets"
  EXPECT: /LOOK presets=7 compiled=7 nonblack=7/
  EVIDENCE: pending

- [ ] G3: switching preset crossfades in about 500 ms (stage intensity ramps, no frame with both stages at full intensity); prints `LOOK fade ms=<n> monotonic=1` with n in 350..700
  CHECK: cd apps/web && bun run e2e:look 2>&1 | grep "LOOK fade"
  EXPECT: /LOOK fade ms=(3[5-9]\d|[4-6]\d\d|700) monotonic=1/
  EVIDENCE: pending

- [ ] G4: scope mask: the circle is centered on the stage, outside is black, the feather slider changes the edge softness (sampled alpha across the edge differs between feather 0 and feather 60), and SCOPE off removes the mask. Prints `SCOPE on=1 off=1 feather0_edge=<px> feather60_edge=<px>` with feather60 edge width greater than feather0
  CHECK: cd apps/web && bun run e2e:look 2>&1 | grep "SCOPE"
  EXPECT: /SCOPE on=1 off=1 feather0_edge=\d+ feather60_edge=\d+/
  EVIDENCE: pending

- [ ] G5: the Look popover is keyboard operable (arrow keys, Escape returns focus), preset buttons have names and `aria-pressed`, and a11y stays at 0 serious, 0 critical
  CHECK: cd apps/web && bun run e2e:a11y 2>&1 | grep -E "AXE|KEYBOARD"
  EXPECT: /AXE serious=0 critical=0[\s\S]*KEYBOARD-OK/
  EVIDENCE: pending

- [ ] G6: frame cost: with NVG active the median frame time on the e2e machine is within 1.5x of normal (prints `LOOK perf normal=<ms> nvg=<ms>`); sighting icons stay legible (screenshot viewed)
  CHECK: cd apps/web && bun run e2e:look 2>&1 | grep "LOOK perf"
  EXPECT: /LOOK perf normal=\d+(\.\d+)? nvg=\d+(\.\d+)?/
  EVIDENCE: pending

- [ ] G7: unit suite, typecheck, lint, build clean
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && bun run --cwd apps/web build >/dev/null 2>&1 && echo CLEAN
  EXPECT: /^ *0 fail[\s\S]*CLEAN/m
  EVIDENCE: pending

- [ ] G8: screenshots of all seven presets over the Florida Keys and one with scope feather at 0 and at 60 saved to docs/evidence/ and viewed
  EVIDENCE: pending
