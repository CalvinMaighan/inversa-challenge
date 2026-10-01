# Gates: GRB mobile and UI polish, and the failing grader criteria (opus)

Findings from D1 and from `bun run grade --fast`: (1) carp at 375 px opens showing only 2-3 of the 8 sites and the timeline hint text is clipped on both sides; (2) lionfish at 375 px: the honesty banner covers the top third of the map and markers are cut off at both edges; (3) carp "Data attribution" link sits under the timeline and is not clickable (`ATTRIBUTION clickable=0`); (4) carp board rows at the fixture clock all say "no NWPS flood thresholds were known" (thresholds are ingested-gated: make the fixture/backfill load thresholds with an ingest time that precedes the fixture clock, or label the as-of semantics clearly if that is the honest behaviour); (5) lionfish desktop: survey panel plus banner cover much of the map; (6) grader FAIL criteria: `three-apps` carp has 5 helper questions (needs >= 6 starter chips, up to the max the schema allows: add a sixth good one that exists in the question file as `helper`), `push-first` (`docs/ingest-modes.md` must justify every poll row: 10 poll rows, 5 justified: add the 'why no push' reasoning with the provider URL for the rest, honestly), `only-three-species` (`SPECIES configs=3 removed_refs=23`: find the 23 references the grader counts (see the check in `docs/grading/rubric.json`) and remove or legitimately exclude them, e.g. history docs by path, but never hide live references). Read `docs/grading/rubric.json` for the exact checks.

Owns: `apps/web/client/**` UI (carp, lionfish, hud layout, timeline hint, attribution), `spec/apps/{carp,lionfish}.json` copy/helpers only, `docs/ingest-modes.md`, `api` fixture/backfill loading of carp thresholds only if needed, mirrored tests, screenshots under `docs/evidence/`. Do not edit `apps/web/e2e/**` except the screenshot capture (GRA owns e2e), agent code or the eval. Work in the worktree the driver created for you (`cd`/`git -C` only there), commit there, never push. macOS has no `timeout`. Do not edit apps/web while an e2e against `next dev` is running.

- [x] G1: carp at 375 px: the first view frames at least 6 of the 8 sites clear of the bottom sheet and timeline (or the sheet starts collapsed), timeline hint text wraps without clipping, no horizontal scroll; the attribution link is clickable (e2e `ATTRIBUTION clickable=1` for every app at desktop and 375); screenshot `docs/evidence/mobile/carp-375.png` retaken and looked at
  CHECK: cd apps/web && bun run e2e:carp 2>&1 | grep -E "^CARP-A11Y|^ATTRIBUTION"
  EXPECT: /CARP-A11Y serious=0 critical=0 mobile_hscroll=0 keyboard=ok/
  EVIDENCE: CARP-A11Y serious=0 critical=0 mobile_hscroll=0 keyboard=ok

- [x] G2: lionfish at 375 px: the banner is dismissible/collapsible to a single line and does not cover more than 15% of the viewport; markers are not cut off (frame fits all four areas in the free part of the screen); desktop: the survey panel and banner leave at least 55% of the map area visible by default (measure and print `LIONFISH-LAYOUT map_visible_pct=<n> mobile_banner_pct=<n>`); screenshots retaken and looked at
  CHECK: cd apps/web && bun run e2e:lionfish 2>&1 | grep -E "^LIONFISH-LAYOUT|^LIONFISH-A11Y"
  EXPECT: /LIONFISH-LAYOUT map_visible_pct=(5[5-9]|[6-9]\d|100) mobile_banner_pct=(\d|1[0-5])\b[\s\S]*LIONFISH-A11Y serious=0 critical=0 mobile_hscroll=0 keyboard=ok/
  EVIDENCE: LIONFISH-LAYOUT map_visible_pct=61 mobile_banner_pct=4 mobile_markers_clear=32/32 | LIONFISH-A11Y serious=0 critical=0 mobile_hscroll=0 keyboard=ok

- [x] G3: carp as-of honesty at the fixture clock: the board shows statuses derived from thresholds that were known then, or says plainly why not; an e2e line `CARP-ASOF threshold_state=<known|unknown_labelled>` shows which; no row says "no thresholds" when thresholds exist in the DB for that time (test with the backfilled data)
  CHECK: cd apps/web && bun run e2e:carp 2>&1 | grep "^CARP-ASOF"
  EXPECT: /CARP-ASOF forecast_swap=ok later_obs=ok board_asof=ok label=ok exit=ok/
  EVIDENCE: CARP-ASOF forecast_swap=ok later_obs=ok board_asof=ok label=ok exit=ok threshold_state=unknown_labelled

- [ ] G4: grader failures fixed legitimately: `bun scripts/grade.ts --fast --no-write --only three-apps,push-first,only-three-species` shows PASS for all three apps (or PASS with the check's own per-app evidence), and the diff shows no weakened check
  CHECK: bun scripts/grade.ts --fast --no-write --only three-apps,push-first,only-three-species 2>&1 | grep -E "^GRADE "
  EXPECT: /GRADE three-apps [\d.]+\/3 PASS[\s\S]*GRADE push-first [\d.]+\/3 (PASS|PENDING)[\s\S]*GRADE only-three-species [\d.]+\/1 PASS/
  EVIDENCE: 2026-10-01 GRADE three-apps 1.8/3 PENDING (only firstload@carp|lionfish|python: firstload.ts lacks "FIRSTLOAD app=", GRA-owned; questions, config-copy@carp|lionfish|python PASS) | GRADE push-first 1.8/3 PENDING (ingest-modes@carp|lionfish|python PASS; signed-hook skipped by --fast) | GRADE only-three-species 1.0/1 PASS SPECIES configs=3 removed_refs=0. See ABANDON G4.

- [x] G5: web tests, typecheck, lint clean; screenshots looked at with findings; `e2e:layout`/`panels` (if GRA has landed) show no regressions on desktop
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: /^ *0 fail[\s\S]*CLEAN/m
  EVIDENCE: 0 fail | CLEAN

ABANDON: G4 three-apps cannot reach PASS from this leaf: its firstload sub-check requires apps/web/e2e/firstload.ts to emit "FIRSTLOAD app=<id> ..." lines, which GRA owns and is changing concurrently. Every sub-check this leaf owns passes: three-apps/questions, config-copy@carp/lionfish/python (helpers=8), push-first/ingest-modes@carp/lionfish/python (poll_justified=poll, urls=rows), only-three-species (removed_refs=0). push-first shows PENDING only for the cargo signed-hook check skipped by --fast.
