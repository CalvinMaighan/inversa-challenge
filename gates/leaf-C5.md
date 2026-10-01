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

- [ ] G1: each rule is a pure function with tests for firing, not firing, edge values, missing data and the datum trap (KRZL1 USGS 1.47 ft vs NWPS 3.92 ft must not fire `forecast_category`); tidal site noise floor; test names `review_rule_`
  CHECK: cargo test --manifest-path api/Cargo.toml review_rule_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G2: `siteReview(site, asOf)` evaluates strictly with data known at `asOf` (uses C3 as-of queries); the same site at two times gives different statuses when the data differ; `reviewHistory` returns the flips (when and why a site entered or left review); `reviewBoard(asOf)` ranks all sites with counts; test names `review_asof_`
  CHECK: cargo test --manifest-path api/Cargo.toml review_asof_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G3: honesty: no output field named risk, probability, catch, abundance, safe; `cannot_assess` is returned rather than `ok` when stale or missing (test with an outage); a schema test asserts the field names; test names `review_honesty_`
  CHECK: cargo test --manifest-path api/Cargo.toml review_honesty_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G4: scenario fixtures: an eventful replay scene (`backfill --app carp --scene rise-2026-xx` or a fixture set under `api/fixtures/carp_scene/**`) where one Atchafalaya site starts quiet, then a forecast issuance crosses minor and an alert appears; the review board at three timestamps shows ok then review (forecast_category) then review (+active_alert); prints `REVIEW-SCENE t1=ok t2=review:forecast_category t3=review:forecast_category,active_alert`
  CHECK: cargo test --manifest-path api/Cargo.toml review_scene -- --nocapture 2>&1 | grep REVIEW-SCENE
  EXPECT: /REVIEW-SCENE t1=ok t2=review:forecast_category t3=review:forecast_category,active_alert/
  EVIDENCE: pending

- [ ] G5: GraphQL resolver tests for carp only (species apps get the typed `NOT_CONDITIONS_APP` error); schema-diff test passes; full api suite and clippy clean (state counts)
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep -E "^test result" | tail -2 && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1
  EXPECT: /test result: ok[\s\S]*Finished/
  EVIDENCE: pending
