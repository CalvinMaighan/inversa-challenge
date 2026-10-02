# Gates: GE11 the map window: feather fades OUTSIDE the shape; no on/off switch (user review 2026-10-01)

User words: "for the feather I think what is not being understood is I want to not block the edges around the circle, meaning there should not be a toggle needed for 'Show the map through a window' because we never want to show through a window. What I want is for size and soft edge to mean: if the soft edge is set to 0 then yes there are black parts around and we see a circle view, but if we feather it, it should be feathering outside of the circle edge, with its max value meaning there is no vignette at all and we see everything. So with default feather it should be showing some transparency fading outside of the circle. The circle always has full visibility and we feather to create an effect gradually outside."

Semantics (write them in `docs/GODS_EYE.md` GC2 and in the Look popover's plain words):
- The shape (circle by default; oval, rounded, frame from GE9) at its Size is ALWAYS fully visible. Nothing inside it is ever dimmed by the feather.
- Soft edge 0: hard edge, everything outside the shape is black.
- Soft edge above 0: the map fades out gradually OUTSIDE the shape's edge: visibility falls from 1 at the edge toward a floor farther out; the fade distance and the visibility floor both grow with the setting.
- Soft edge at its maximum (100): no vignette at all, the whole map is visible.
- Default soft edge: a visible gentle fade outside the circle (start at 40; tune between 30 and 50 by looking at it and report your choice).
- There is no window on/off switch and no `SCOPE_ON` key any more (remove it from the state catalogue, Look popover, share link writer, tests and docs; an old share link with `scope=` is ignored without error).

Own `client/hud/shell/**` (StageShell, geometry), `client/hud/look/**`, `client/state/look.ts`, `client/globe/look/**` only where it carries scope code, `client/hud/share-link*.ts` for the keys, `e2e/look.ts`, `e2e/stage*.ts` lines about the scope, docs. GE10 (zoom strip) runs in parallel: do not touch `client/hud/zoom/**` or the timeline.

- [ ] G1: pure model with unit tests named `scope feather`: for every shape (circle, oval, rounded, frame), size and feather the mask profile has alpha 1 everywhere inside the shape; 0 beyond the edge at feather 0 (hard); monotonically non-increasing outward from the edge; floor and fade distance non-decreasing in feather; alpha 1 everywhere at feather 100; default feather is within 30..50; `SCOPE_ON` is gone from the catalogue and the share-link writer; a link carrying `scope=0` or `scope=1` loads without error and without effect; shape and size round trip still hold
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "scope feather" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G2: measured on the rendered page (screenshots of the globe pane against the same view with no mask): inside the circle the pixel values equal the unmasked ones within 1 percent at feather 0, 40 and 100; outside at feather 0 the map is black (under 2 percent of unmasked); at the default feather the visibility just outside the edge is between 60 and 95 percent and decreases with distance, ending between 5 and 60 percent far out; at feather 100 outside equals unmasked within 3 percent (no vignette). Prints `SCOPE-FEATHER inside_f0=<pct> inside_f40=<pct> inside_f100=<pct> outside_f0=<pct> near_default=<pct> far_default=<pct> outside_f100=<pct> default=<n>`
  CHECK: cd apps/web && bun run e2e:look 2>&1 | grep "SCOPE-FEATHER"
  EXPECT: /SCOPE-FEATHER inside_f0=(99|100)\S* inside_f40=(99|100)\S* inside_f100=(99|100)\S* outside_f0=[0-1]\S* near_default=(6\d|7\d|8\d|9[0-5])\S* far_default=([5-9]|[1-5]\d)\S* outside_f100=(9[7-9]|100)\S* default=(3\d|4\d|50)/
  EVIDENCE: pending

- [ ] G3: other shapes follow the same rule: for oval, rounded and frame at size 70 and the default feather, inside is fully visible and the fade runs outward from each shape's own edge (measured along a horizontal and a vertical line through the centre); frame at size 100 fades toward the pane edges only. Prints `SCOPE-SHAPES oval=ok rounded=ok frame=ok`
  CHECK: cd apps/web && bun run e2e:look 2>&1 | grep "SCOPE-SHAPES"
  EXPECT: /SCOPE-SHAPES oval=ok rounded=ok frame=ok/
  EVIDENCE: pending

- [ ] G4: the old hard clip is gone: where the map is visible outside the circle it is also interactive (a sighting marker or carp site drawn at alpha 0.3 or more outside the circle can be hovered and clicked, and the globe can be dragged and zoomed from there), while the cards and chat stay on top. Prints `SCOPE-INPUT outside_marker_click=ok drag=ok`
  CHECK: cd apps/web && bun run e2e:look 2>&1 | grep "SCOPE-INPUT"
  EXPECT: /SCOPE-INPUT outside_marker_click=ok drag=ok/
  EVIDENCE: pending

- [ ] G5: the Look popover has no window switch: it holds the seven looks, Shape (circle, oval, rounded, frame), Size and Soft edge in plain words, with Soft edge labelled so a novice understands it ("Soft edge: sharp at 0, no vignette at 100"), keyboard operable, aria for each control, and `LOOK keyboard=ok`; the earlier `LOOK presets=7 compiled=7 nonblack=7`, `LOOK fade ms=...` and `LOOK link=ok` lines still print
  CHECK: cd apps/web && bun run e2e:look 2>&1 | grep -E "LOOK presets|LOOK fade|LOOK keyboard|LOOK link"
  EXPECT: /LOOK presets=7 compiled=7 nonblack=7[\s\S]*LOOK fade ms=\d+ monotonic=1[\s\S]*LOOK keyboard=ok[\s\S]*LOOK link=ok/
  EVIDENCE: pending

- [ ] G6: no per-frame cost: the mask is generated when shape, size, feather or the pane size change, never per frame (idle governor stays idle: `LOOK perf normal=<ms> nvg=<ms>` unchanged in kind and the zoom e2e `ZOOM idle=ok requests_delta=0` still passes); stage e2e lines keep their values: `STAGE centered=ok chat=left details=right margins=black` (margins: the page background outside the stage layout box stays black; the fade only lives inside the globe pane), `TOPRIGHT buttons=4`, `LOOKBTN ...`, a11y 0 serious 0 critical
  CHECK: cd apps/web && bun run e2e:stage 2>&1 | grep -E "STAGE|TOPRIGHT|LOOKBTN" && bun run e2e:look 2>&1 | grep "LOOK perf" && bun run e2e:a11y 2>&1 | grep -E "AXE|KEYBOARD"
  EXPECT: /STAGE centered=ok chat=left details=right margins=black[\s\S]*TOPRIGHT buttons=4[\s\S]*LOOKBTN topright=1[\s\S]*LOOK perf normal=[\s\S]*AXE (app=\w+ )?serious=0 critical=0[\s\S]*KEYBOARD-OK/
  EVIDENCE: pending

- [ ] G7: web unit, typecheck, lint, build clean; docs updated (GODS_EYE.md GC2 text, help sheet entry for Look in plain words); screenshots at 1440x900 with the circle at feather 0, the default, 70 and 100, plus oval and frame at the default, saved to docs/evidence/ and viewed, one observation each
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && bun run --cwd apps/web build >/dev/null 2>&1 && echo CLEAN
  EXPECT: /^ *0 fail[\s\S]*CLEAN/m
  EVIDENCE: pending
