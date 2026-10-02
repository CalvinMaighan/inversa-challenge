# Gates: C5 carp "needs review" engine (opus)

Contract: `docs/APPS.md` carp section (output is "Needs review" with specific reasons and sources, never abundance, catch, access or trip safety); store and queries from `api/src/forecast/{store,query}.rs` (C3: `status_at`, conflicts, freshness bands, thresholds, `verify`); questions the engine must answer are in `spec/apps/questions/carp.json` (see `site_status`, `review_history` tool specs under `newTools`). You own: `api/src/review/**` (new), GraphQL `siteReview(site, asOf)`, `reviewHistory(site, from, to)`, `reviewBoard(asOf)` in `api/src/graphql/**` (carp only), `api/schema.graphql` additions, `spec/apps/carp.json` `review` block (thresholds). Do not touch web or adapters. Commit on your worktree branch, no push.

Rules (each reason carries `rule`, `value`, `threshold`, `source`, `observedAt/issuedAt`, `link`): 
1. `stage_rise`: observed rise over 24 h at or above a configured threshold (default 2.0 ft; tidal Morgan City MCGL1 uses a separate larger noise floor).
2. `forecast_category`: forecast peak within horizon crosses action, minor, moderate or major (NWPS stage and thresholds only; USGS stage is never compared with flood thresholds because datums differ).
3. `active_alert`: an active NWS alert (flood, wind, etc.) matched to the site.
4. `rapid_change_forecast`: forecast rise rate above threshold.
5. `stale_input`: observation older than 6 h, or forecast older than 36 h.
6. `missing_input`: no observation, no forecast, or no thresholds.
7. `source_conflict`: gauge vs forecast stage disagree over `conflictFt`, or flows disagree (never blended).
Status values: `review` (one or more rules 1-4,7 fire), `ok` (none fire and inputs fresh), `cannot_assess` (inputs missing or stale so the status would be a guess). Each site returns all reasons ordered by severity and a one-line plain explanation per reason.

- [x] G1: each rule is a pure function with tests for firing, not firing, edge values, missing data and the datum trap (KRZL1 USGS 1.47 ft vs NWPS 3.92 ft must not fire `forecast_category`); tidal site noise floor; test names `review_rule_`
  CHECK: cargo test --manifest-path api/Cargo.toml review_rule_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: `running 14 tests` / `test result: ok. 14 passed; 0 failed`. Rules are `rule_*` in api/src/review/mod.rs over `Inputs`; datum trap `review_rule_forecast_category_datum_trap_krzl1` (USGS 1.47 vs NWPS 3.92 ok; USGS 5.95 above action 4.0 with NWPS 3.5 clear); tidal `review_rule_stage_rise_tidal_noise_floor` (MCGL1 floor 3.0 ft, +-1 ft semidiurnal swing never fires).

- [x] G2: `siteReview(site, asOf)` evaluates strictly with data known at `asOf` (uses C3 as-of queries); the same site at two times gives different statuses when the data differ; `reviewHistory` returns the flips (when and why a site entered or left review); `reviewBoard(asOf)` ranks all sites with counts; test names `review_asof_`
  CHECK: cargo test --manifest-path api/Cargo.toml review_asof_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: `running 5 tests` / `test result: ok. 5 passed; 0 failed`. Same SMML1 ok at f1+30 min (issued, not captured), review at f1+45 min (captured); `review_asof_never_reads_future_rows` (late live capture, late alert poll, thresholds learnt later, archive gated by issuance); history flips ok->review at capture, review->cannot_assess at forecast stale (cleared forecast_category, rapid_change_forecast); board SMML1 review, KRZL1 cannot_assess, BTRL1 ok. 31-day history: `REVIEW-HISTORY-31D evaluations=1644 transitions=30 ms=134` (debug build). GraphQL equivalents in `review_graphql_*`.

- [x] G3: honesty: no output field named risk, probability, catch, abundance, safe; `cannot_assess` is returned rather than `ok` when stale or missing (test with an outage); a schema test asserts the field names; test names `review_honesty_`
  CHECK: cargo test --manifest-path api/Cargo.toml review_honesty_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: `running 2 tests` / `test result: ok. 2 passed; 0 failed`. Outage: ok at T+5 h, cannot_assess at T+5 h+1 ms (observation 6 h old), and at issue+36 h+1 ms (forecast); empty site names observation, forecast, thresholds. Schema test parses the served SDL, checks every review type, enum value and query argument against risk/probab/catch/abundan/safe, pins the exact ReviewReason and SiteReview field lists, and scans every explanation and summary.

- [x] G4: scenario fixtures: an eventful replay scene (`backfill --app carp --scene rise-2026-xx` or a fixture set under `api/fixtures/carp_scene/**`) where one Atchafalaya site starts quiet, then a forecast issuance crosses minor and an alert appears; the review board at three timestamps shows ok then review (forecast_category) then review (+active_alert); prints `REVIEW-SCENE t1=ok t2=review:forecast_category t3=review:forecast_category,active_alert`
  CHECK: cargo test --manifest-path api/Cargo.toml review_scene -- --nocapture 2>&1 | grep REVIEW-SCENE
  EXPECT: /REVIEW-SCENE t1=ok t2=review:forecast_category t3=review:forecast_category,active_alert/
  EVIDENCE: `REVIEW-SCENE t1=ok t2=review:forecast_category t3=review:forecast_category,active_alert`. Fixture `api/fixtures/carp_scene/rise-2026-05/scene.json` (SYNTHETIC, labelled so; SMML1 with real NWPS thresholds) seeded through the C3 store write side; history over t1..t3 has one flip, at the second issuance's capture time.

- [x] G5: GraphQL resolver tests for carp only (species apps get the typed `NOT_CONDITIONS_APP` error); schema-diff test passes; full api suite and clippy clean (state counts)
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep -E "^test result" | tail -2 && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1
  EXPECT: /test result: ok[\s\S]*Finished/
  EVIDENCE: `test result: ok. 307 passed; 0 failed; 4 ignored` / clippy `Finished dev profile` (no warnings). Resolver tests `review_graphql_site_review_asof`, `review_graphql_history_and_board`; species apps get NOT_CONDITIONS_APP for siteReview, reviewHistory, reviewBoard (`forecast_graphql_species_apps_get_typed_error`); `schema_matches_contract` passes with the new SDL.
