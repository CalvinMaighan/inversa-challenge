# Gates: GE7 integration of GE1-GE5 (driver-requested; docs/GODS_EYE.md)

Scope: make the five merged leaves behave as one product. Work only on `pivot/three-apps` as merged (commit 8513f82 or later). GE6 (place search) is still in flight in its own worktree: do not touch `client/hud/search`, `client/places`, `docs/places.md`.

- [ ] G1: one scope. Today GE1's CSS circle mask (`client/hud/shell/StageShell.tsx`, `setStageScope`, `--scope-feather`) and GE2's shader scope stage (`client/globe/look/install.ts` `inversa_look_scope`) both exist and disagree about the circle. Keep exactly one implementation (prefer GE1's CSS circle driven by the `SCOPE_ON` and `SCOPE_FEATHER` keys, and delete the shader stage and its dead code), so the Look popover's scope switch and feather slider change the stage's real edge. Update `e2e/look.ts` to measure the page (pixels across the circle edge from a screenshot) so the line `SCOPE on=1 off=1 feather0_edge=<px> feather60_edge=<px>` still prints with feather60 > feather0, and the circle stays centred on `[data-stage]`
  CHECK: cd apps/web && bun run e2e:look 2>&1 | grep -E "SCOPE|LOOK presets|LOOK fade"
  EXPECT: /LOOK presets=7 compiled=7 nonblack=7[\s\S]*LOOK fade ms=\d+ monotonic=1[\s\S]*SCOPE on=1 off=1 feather0_edge=\d+ feather60_edge=([1-9]\d*)/
  EVIDENCE: pending

- [ ] G2: framing stays inside the circle. `fitInPane` (`client/globe/fit.ts`) and the agent's camera moves frame targets inside the visible circle, never in the black margin or under a card (intersect the free rect with the opaque part of `[data-stage]`). Unit tests named `stage framing`; e2e prints `FRAMING inside=<n> outside=0` over at least 5 framed targets (agent `set_view`, sighting click, search-free fly) at 1440x900 and 1024x768
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "stage framing" 2>&1 | grep -E "pass|fail" && bun run e2e:stage 2>&1 | grep FRAMING
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail[\s\S]*FRAMING inside=([5-9]|[1-9]\d+) outside=0/
  EVIDENCE: pending

- [ ] G3: carp's "Locations to review" board and the lionfish survey panel no longer cover the circle's centre at 1440x900 and 1024x768 (move them into the right card region or the chat card column, whichever reads cleaner); e2e prints `PANELS carp=ok lionfish=ok` in `e2e:stage` (add app loops there)
  CHECK: cd apps/web && bun run e2e:stage 2>&1 | grep "PANELS"
  EXPECT: /PANELS carp=ok lionfish=ok/
  EVIDENCE: pending

- [ ] G4: a Layers button in the bottom bar (next to Look) opens a popover that holds the toggles for what the app offers: sightings, notes, and for carp and lionfish "Ships", and "Water and weather" (reuse the existing legend/WaterWeather components and layer rows, no duplicate state), grouped and with plain-words lines; default state unchanged (novice rule: only sightings and notes on). Keyboard operable; aria. Unit tests named `layers bar`; e2e prints `LAYERSBAR items=<n> ships=carp,lionfish water=all defaults=ok`
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "layers bar" 2>&1 | grep -E "pass|fail" && bun run e2e:stage 2>&1 | grep LAYERSBAR
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail[\s\S]*LAYERSBAR items=\d+ ships=carp,lionfish water=all defaults=ok/
  EVIDENCE: pending

- [ ] G5: timeline coherence in carp: `LayerContext.timeMs()` honours `CARP.asOf` and layers refresh when it changes, so vessels, alerts and stations in carp follow the same cursor as the overlays (GE5 CONTRACT-REQUEST 2, GE4 request 6); remove the special-case subscriptions the leaves added if they become redundant. Unit tests named `carp cursor`
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "carp cursor" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G6: the agent knows the new layers and looks. `server/agent/prompt.ts` lists, per app, what it can toggle (vessels for carp and lionfish, the five water and weather layers) and the citation rule for `vessel:<mmsi>`; a `set_look` UI tool (shared/voice/ui-tools.ts, client handler, schema tests) sets the preset; the real-agent e2e asks "show me ships near Louisiana" on carp and prints `AGENT-LAYERS toggled=vessels cited=<n> look=set` using real OpenRouter (credit restored, about $9 left: keep the run small)
  CHECK: cd apps/web && bun run e2e:agent -- --ge7 2>&1 | grep "AGENT-LAYERS"
  EXPECT: /AGENT-LAYERS toggled=vessels cited=\d+ look=set/
  EVIDENCE: pending

- [ ] G7: docs and contracts: PLAN.md and docs/GODS_EYE.md amended (GC1 breakpoints: cards float from 768 px, overlap the circle below about 1100, phone docks below 768; GC2 look keys live in `client/state/look.ts`; GC3 GET shape `{id, set, source, vars, writable}`; GC4 VesselFinder link and `aisstream` feed; GC5 overlay time limits; ladder `google3d` is an ordered route list); help sheet entries for Look, Layers, Developer and Ships; README feature table and env table; docs/security.md notes the dev-only key writer and its LAN limit. Quote the changed headings
  EVIDENCE: pending

- [ ] G8: nothing regressed on the merged tree. Web unit, typecheck, lint and build; api tests and clippy; and these e2e lines on the real stack (or the production-build stack where the user's `bun run dev` holds the Next dev lock): `e2e:stage`, `e2e:look`, `e2e:developer`, `e2e:media`, `e2e:vessels`, `e2e:overlays`, `e2e:layout`, `e2e:a11y` (0 serious, 0 critical, keyboard OK, with Look, Layers and Developer popovers scanned), `e2e:links`. Paste each deciding line
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && bun run --cwd apps/web build >/dev/null 2>&1 && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1 && echo CLEAN
  EXPECT: /^ *0 fail[\s\S]*Finished[\s\S]*CLEAN/m
  EVIDENCE: pending

- [ ] G9: screenshots at 1440x900 (carp with ships and radar on, Look NVG with scope feather 40, Layers popover open, Developer panel with no key values visible) and 375x812, saved to docs/evidence/ and viewed; quote one observation each
  EVIDENCE: pending
