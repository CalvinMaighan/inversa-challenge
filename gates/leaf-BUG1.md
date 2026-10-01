# Gates: BUG1 real defects found by running the graded e2e checks on the real stack (fable)

Found by GRA (its measurements, 2026-10-01, real Axum + production-like stack) and the driver. Each is a product defect, not a test problem. Fix generally and add tests; do not special-case the checks. Work in the worktree the driver created for you (`cd`/`git -C` only there), commit there, never push. macOS has no `timeout`. Do not edit apps/web while an e2e against `next dev` is running; use `E2E_SKIP_BUILD=1` after the first build. Another leaf (GRA2) concurrently finishes the e2e scripts (apps/web/e2e/**); do not edit those except to read them and report. Live model runs via `doppler run --project inversa --config dev --` from apps/web.

1. **Lionfish agent queries the wrong taxon id (wrong answers).** `apps/web/server/agent/tools/evidence.ts:13` `focusSpecies` sets `taxonId: String(index + 1)`; the API's lionfish taxon id is `"4"` (shared taxa seed), python's is `"1"`. `sightings(taxa:["1"])` in the Mexican Caribbean returns 0 rows against 11 unfiltered, and the agent answered "no lionfish reports in the Mexican Caribbean in the last 30 days". The eval stubs use taxon 1 so the benchmark never saw it. Fix at the root: the app config is the single source of the taxon id the API uses (add `taxa[].dbId`/use the existing id consistently, validated in Rust and TS, resolved through GraphQL `taxa` if needed), the web client EVF focus-taxon logic (`client/globe/species.ts`, `shared/frames.ts` `evfSpecies`) uses the same, and the eval stubs for lionfish use the real id (4) so the bug cannot hide again. Add a test that fails if any stub/fixture taxon id differs from the id the real backfill produces for that app (`backfill --fixtures --app <id>` then read taxa).
2. **Carp scrub is not network-free.** Scrubbing "what we knew" sends 13 GraphQL requests over 96 steps (`CarpVerify`, `CarpBoardSite`) from `client/carp/use-carp.ts` refetching per as-of. Fetch the history window once (or page coarsely) and answer as-of changes from memory/worker cache; the rubric needs `requests=0` during a scrub.
3. **Carp markers disagree with the engine.** The map markers show `review` for SMML1, KRZL1, BLRL1 and BTRL1 while `reviewBoard(asOf)` returns `CANNOT_ASSESS` for all 8 (`client/carp/CarpHud.tsx` `deriveReview`, `client/carp/data.ts`). The client must use the API's `reviewBoard`/`siteReview` status (it exists now) and only fall back to a derived status for an API without it, labelled as derived. Markers, board rows and briefing must show the same status and reasons; add an e2e assertion (`CARP-STATUS agree=<n>/8`) that marker status equals API status for all sites.
4. **Python answer-cache repeat missed** (`apps/web/server/agent/cache.ts`; `cache_hit=false`, 14 s repeat) and first-token p50 over 1200 ms for carp (1234) and python (1282). Find out why the repeat is not served from the answer cache (key includes something volatile like view time? data version tick?) and fix generally; then look for cheap first-token wins (system prompt size, tool schema size, prefix caching working, parallel tool calls, fewer round trips). Measure with `e2e:perf -- --app <id>`; do not weaken the 1200 ms bar.
5. **Lionfish heat-area hover labels overlap the numbered priority markers** (`docs/evidence/quality/lionfish-missing-heat.png`): fix overlap/precedence; and check whether reasoning text can render literally as `**Looking into CRW locations**` in the agent panel (if so, render or strip markdown headings in reasoning/debug lines).
6. **Fixture:** `api/fixtures/scenes/cold-snap-2026-02-01/inat/focus-p1.json.gz` has had 0 python results since K1 re-recorded it; the cold-snap scene is the python demo. Replace it with a real recording of Burmese python observations from the window (iNat API, python taxon, the scene's bbox and dates) or document honestly that none exist in that window and pick a window that has some; update the scene tests and `docs/demo-script.md` (FIRSTLOAD line shape at `docs/demo-script.md:65` and `docs/interview-notes.md:119`).

- [ ] G1: (1) fixed: `bun test ... -t "taxon id"` passes: lionfish and python config ids equal the ids the real fixture backfill creates; the lionfish eval stub uses id 4; a live probe shows `sightings` for lionfish by species name in mx-caribbean returns the same count as unfiltered; quote both numbers
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "taxon id" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G2: (2) fixed: e2e scrub on carp prints `SCRUB app=carp ... requests=0 ...` with the current GRA scrub script (`bun run e2e:scrub -- --app carp`), median under 16 ms
  CHECK: cd apps/web && bun run e2e:scrub -- --app carp 2>&1 | grep "^SCRUB "
  EXPECT: /SCRUB app=carp median=([0-9]|1[0-5])(\.\d+)? requests=0/
  EVIDENCE: pending

- [ ] G3: (3) fixed: `CARP-STATUS agree=8/8` in `e2e:carp` and a unit test of the client status mapping against API rows (including CANNOT_ASSESS); no marker says `review` when the API says `CANNOT_ASSESS`
  CHECK: cd apps/web && bun run e2e:carp 2>&1 | grep "^CARP-STATUS "
  EXPECT: /CARP-STATUS agree=8\/8/
  EVIDENCE: pending

- [ ] G4: (4) fixed: `PERF app=<id> first_token_p50_ms<=1200 n>=5 cached_query_ms=<n>` and `cache_hit=true` for carp, lionfish and python (three runs each at most one over; quote all), cost impact stated
  CHECK: cd apps/web && for a in carp lionfish python; do doppler run --project inversa --config dev -- bun run e2e:perf -- --app $a 2>&1 | grep "^PERF "; done
  EXPECT: /PERF app=carp first_token_p50_ms=([0-9]{1,3}|1[01][0-9]{2}|1200) n=([5-9]|[1-9][0-9])[\s\S]*PERF app=lionfish[\s\S]*PERF app=python first_token_p50_ms=([0-9]{1,3}|1[01][0-9]{2}|1200)/
  EVIDENCE: pending

- [ ] G5: (5) and (6) fixed with tests and screenshots looked at; the cold-snap scene has real python observations (or the honest documented alternative) and the scene tests pass (`cargo test scene_cold_snap`); doc lines corrected
  CHECK: cargo test --manifest-path api/Cargo.toml scene_cold_snap 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G6: no regressions: `bun run check`, clippy, one pooled golden run `--runs 3` for lionfish and python (bars met or the residual failures explained; a taxon-id fix may change lionfish answers because tools now return real rows), quote the summaries
  CHECK: bun run check 2>&1 | tail -2 && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1
  EXPECT: /CHECK-OK[\s\S]*Finished/
  EVIDENCE: pending
