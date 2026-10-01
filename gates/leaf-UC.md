# Gates: UC carp UI: Louisiana Field Conditions (opus)

Contract: PLAN.md C-A5; `docs/APPS.md` carp section; `docs/evidence/carp-data-proof.md` (gaps table with UI treatments, flood thresholds, camera presets); GraphQL from C3/C4 (`forecasts(site, asOf, history)`, `siteStatusAt(site, asOf, conflictFt)`, `forecastVerify(site, issuedAt)`, `readings(params STAGE_M DISCHARGE_CFS AIR_C WIND_MS)`, `alerts`, `feeds`) and from C5 (being built concurrently; code to these names: `siteReview(site, asOf)`, `reviewHistory(site, from, to)`, `reviewBoard(asOf)`; each reason `{rule, value, threshold, source, observedAt, issuedAt, link, text}`, status `review|ok|cannot_assess`). Carp has no hotspot grid and no frames. You own: `apps/web/client/carp/**` (new), carp-specific changes in `client/hud/{timeline,drawer,legend,overlay,topbar}`, `client/globe/layers/*` for site markers, `client/state/` carp keys (register them), `apps/web/e2e/carp.ts` + the `e2e:carp` script, mirrored tests. Do not touch `server/agent` (AG1) or `api/`. Take existing look and feel (Cesium globe, HUD popovers, drawer, timeline); read `apps/web/client/globe/**`, `client/hud/timeline/**`, `client/hud/drawer/**`. Commit on your worktree branch, no push.

Product: an operations manager sees eight demonstration river sites on the globe (Atchafalaya Basin focus) with status colours (review, ok, cannot assess) and freshness, a timeline of observed stage vs forecast bands with a visible "replay coverage begins" marker, a "what we knew" mode (as-of time) that swaps to the forecast issued at that time and shows later observations separately, an evidence drawer (readings with units and timestamps, forecast issuance, thresholds, source links open in a new tab), and a location briefing card (what changed, what is expected, what is missing). Copy states the boundary: conditions only, not carp abundance, catch, access or trip safety; demonstration locations until Inversa supplies operating areas; L'CARP is reported as active in the Atchafalaya Basin.

- [ ] G1: site markers and board: eight sites on the globe from `spec/apps/carp.json` with status colour + icon + shape (not colour only), freshness ring, tooltip; a side board lists sites sorted by severity with reasons; clicking a site flies there and opens the briefing; camera presets `all-sites` and `atchafalaya` as chips. e2e prints `CARP sites=8 board=ok briefing=ok presets=2 keyboard=ok`
  CHECK: cd apps/web && bun run e2e:carp 2>&1 | grep "^CARP "
  EXPECT: /CARP sites=8 board=ok briefing=ok presets=2 keyboard=ok/
  EVIDENCE: pending

- [ ] G2: timeline: observed stage line (USGS, labelled with datum note), NWPS forecast band with horizon, flood threshold lines (action/minor/moderate/major from NWPS), alert spans, a clear marker at `replayCoverageStart`, scrub and play work; discharge shown with its source label, never blended; conflicts (USGS vs NWPS stage; two flows) shown as an explicit "sources disagree" chip with explanation. e2e prints `CARP-TIMELINE series=ok thresholds=ok coverage_marker=ok conflict_chip=ok scrub_median_ms=<n>` with scrub median under 16
  CHECK: cd apps/web && bun run e2e:carp 2>&1 | grep "^CARP-TIMELINE "
  EXPECT: /CARP-TIMELINE series=ok thresholds=ok coverage_marker=ok conflict_chip=ok scrub_median_ms=([0-9]|1[0-5])(\.\d+)?\b/
  EVIDENCE: pending

- [ ] G3: "what we knew" mode: choosing a past time (timeline or "what we knew yesterday afternoon" control) shows the forecast issued at or before that time, labelled with issuance time and source (`nwps-live` vs `iem-archive`), observations after that time drawn in a different style as "what happened next", the board statuses recomputed as-of; leaving the mode returns to live. e2e prints `CARP-ASOF forecast_swap=ok later_obs=ok board_asof=ok label=ok exit=ok`
  CHECK: cd apps/web && bun run e2e:carp 2>&1 | grep "^CARP-ASOF "
  EXPECT: /CARP-ASOF forecast_swap=ok later_obs=ok board_asof=ok label=ok exit=ok/
  EVIDENCE: pending

- [ ] G4: evidence drawer and honesty: readings with units/timestamps, forecast issuance/valid, thresholds, links in a new tab with `rel=noopener`; stale, missing and `cannot_assess` states render explicit words and reasons (never an empty chart presented as fine); boundary notice visible. e2e prints `CARP-EVIDENCE drawer=ok new_tab=ok stale=ok missing=ok cannot_assess=ok boundary=ok`
  CHECK: cd apps/web && bun run e2e:carp 2>&1 | grep "^CARP-EVIDENCE "
  EXPECT: /CARP-EVIDENCE drawer=ok new_tab=ok stale=ok missing=ok cannot_assess=ok boundary=ok/
  EVIDENCE: pending

- [ ] G5: responsive and accessible: 375 px mobile layout without horizontal scroll, board as a bottom sheet; axe 0 serious/critical for carp in light and dark; full keyboard path; prints `CARP-A11Y serious=0 critical=0 mobile_hscroll=0 keyboard=ok`
  CHECK: cd apps/web && bun run e2e:carp 2>&1 | grep "^CARP-A11Y "
  EXPECT: /CARP-A11Y serious=0 critical=0 mobile_hscroll=0 keyboard=ok/
  EVIDENCE: pending

- [ ] G6: app copy comes from config: app name, question, helper questions, legend, boundary notice; the welcome shows the carp question and first helper chips; no Everglades or lionfish strings appear in carp; test `carp copy` asserts no forbidden words (python, tegu, iguana, lionfish, Everglades) in rendered carp text
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "carp copy" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G7: screenshots (looked at, finding stated): `docs/evidence/carp-{board,timeline,asof,drawer,mobile,light}.png`
  EVIDENCE: pending

- [ ] G8: web tests, typecheck, lint clean (state counts)
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: /^ *0 fail[\s\S]*CLEAN/m
  EVIDENCE: pending
