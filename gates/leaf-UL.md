# Gates: UL Lionfish Watch UI (opus)

Contract: PLAN.md C-A5, P3; `docs/LIONFISH_WATCH.md` (honesty rules, ocean-data relevance R10); GraphQL from L5 (`hotspots(species, at, bbox, top, region, weights, basis)`, `explainCell`, `backtest`; `HotspotCell {components {recentReports idQuality heatStress completeness}, heat {dhw baa sst anomaly observedAt}, fieldWindow, rankScore, thin, regionId}`), L3 (CRW readings params `SST SST_ANOMALY DHW BAA`), L4 (`sightings` with observed vs submitted dates, duplicates, `marine` params `WAVE_PERIOD_S CURRENT_MS CURRENT_DIR_DEG`, `feeds` ids `inat gbif nas crw openmeteo-marine ndbc goes19-sst`), E1 (evidence kinds, `sources`; concurrent). You own: lionfish-specific UI in `apps/web/client/lionfish/**` (new), layers in `client/globe/layers/*` for heat (CRW) and survey priority, legend/help/tooltip content for lionfish, `apps/web/e2e/lionfish.ts` + `e2e:lionfish` script, mirrored tests, `docs/evidence/lionfish-*.png`. Reuse the species-app shell (globe, species bar becomes a single lionfish chip, timeline, drawer, notes/messages). Do not touch `server/agent` (AG2) or `api/`. Commit on your worktree branch, no push.

Product: a conservation analyst sees four area chips (Florida, Mexican Caribbean, Belize, Colombian Caribbean) that fly the globe; layers: sightings (observed date basis by default, toggle submitted), reef heat stress (CRW SST anomaly / DHW / BAA, with both DHW and BAA visible when they disagree), survey priority (ranked cells, each cell opens an evidence card with the four components shown separately, never a single percent), field window (waves/currents, kept visually separate from priority). Thin areas (Belize, Colombia) show an honest sparse-data state. Honesty banner copy from `copy`: sightings are not abundance; more reports can mean more observers; heat stress is context, not proof of damage. Ocean-data help panel explains SST, anomaly, DHW, BAA, waves, currents and why each is used, with sources and limits (R10). Timeline replays sightings and CRW over the window (default 30 days; 7/90 options).

- [ ] G1: area chips and layers: four chips fly to the right regions; layer toggles for sightings, heat, priority, field window; thin areas show a labelled sparse state; GBIF copies of iNat are visually marked and never counted as corroboration in chips or counts; e2e prints `LIONFISH areas=4 layers=ok thin=2 duplicates=ok keyboard=ok`
  CHECK: cd apps/web && bun run e2e:lionfish 2>&1 | grep "^LIONFISH "
  EXPECT: /LIONFISH areas=4 layers=ok thin=2 duplicates=ok keyboard=ok/
  EVIDENCE: pending

- [ ] G2: priority evidence card: clicking a ranked cell opens a card with the four components (value + state ok/unknown/stale + rationale + inputs) side by side, heat values (DHW and BAA both), field window separate, observation list with observed and submitted dates and photo links (new tab), CRW product date and credit, caveats; no single risk/probability/percent anywhere in the DOM (test scans for `%` next to "risk", "probability", "chance"); e2e prints `LIONFISH-CARD components=4 heat_both=ok field_separate=ok links_new_tab=ok no_percent=ok`
  CHECK: cd apps/web && bun run e2e:lionfish 2>&1 | grep "^LIONFISH-CARD "
  EXPECT: /LIONFISH-CARD components=4 heat_both=ok field_separate=ok links_new_tab=ok no_percent=ok/
  EVIDENCE: pending

- [ ] G3: data-quality UX: observed-vs-submitted basis toggle changes the counts with an explanation (median lag 5 days; 24 of 74 records uploaded more than 30 days late); "newly submitted reports of older sightings" is a visible filter; stale CRW (over 72 h) and missing cells render explicit words and hatching (never zero); buoy-vs-satellite SST disagreement shown for Florida; feed chips show mode (push/webhook/poll) and state; e2e prints `LIONFISH-QUALITY basis_toggle=ok late_filter=ok stale=ok missing=ok conflict=ok chips=ok`
  CHECK: cd apps/web && bun run e2e:lionfish 2>&1 | grep "^LIONFISH-QUALITY "
  EXPECT: /LIONFISH-QUALITY basis_toggle=ok late_filter=ok stale=ok missing=ok conflict=ok chips=ok/
  EVIDENCE: pending

- [ ] G4: timeline replay: scrub and play over the 30-day window update sightings, CRW heat and priority; scrub median under 16 ms with 0 requests; "known at that time" semantics are labelled (priority at past time uses data submitted by then); e2e prints `LIONFISH-REPLAY play=ok step=ok asof=ok scrub_median_ms=<n> requests=0`
  CHECK: cd apps/web && bun run e2e:lionfish 2>&1 | grep "^LIONFISH-REPLAY "
  EXPECT: /LIONFISH-REPLAY play=ok step=ok asof=ok scrub_median_ms=([0-9]|1[0-5])(\.\d+)? requests=0/
  EVIDENCE: pending

- [ ] G5: ocean-data help and honesty: help panel content (SST, anomaly, DHW, BAA, waves, currents, relevance, source, limits, why DHW and BAA can disagree) opens from the HUD and from the card; honesty banner visible on first load and dismissible only per session; prints `LIONFISH-HELP topics=6 sources=ok banner=ok`
  CHECK: cd apps/web && bun run e2e:lionfish 2>&1 | grep "^LIONFISH-HELP "
  EXPECT: /LIONFISH-HELP topics=6 sources=ok banner=ok/
  EVIDENCE: pending

- [ ] G6: accessibility and mobile: axe 0 serious/critical for lionfish in light and dark, 375 px layout without horizontal scroll, keyboard path through chips, layers, card and help; prints `LIONFISH-A11Y serious=0 critical=0 mobile_hscroll=0 keyboard=ok`
  CHECK: cd apps/web && bun run e2e:lionfish 2>&1 | grep "^LIONFISH-A11Y "
  EXPECT: /LIONFISH-A11Y serious=0 critical=0 mobile_hscroll=0 keyboard=ok/
  EVIDENCE: pending

- [ ] G7: copy comes from config and no other app's words leak: test `lionfish copy` asserts no forbidden words (python, tegu, iguana, Everglades, river, flood, NWPS) in rendered lionfish text; no `Burmese` etc.
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "lionfish copy" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G8: screenshots (looked at, finding stated): `docs/evidence/lionfish-{areas,priority-card,heat,quality,replay,help,mobile,light}.png`; web tests, typecheck, lint clean (state counts)
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: /^ *0 fail[\s\S]*CLEAN/m
  EVIDENCE: pending
