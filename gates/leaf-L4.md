# Gates: L4 lionfish ingest across four areas (opus)

Contract: PLAN.md C-A1..C-A4; `spec/apps/lionfish.json` (four regions: fl, mx, bz, co; bboxes from `docs/evidence/data-proof.md`; mark bz and co `thin`); `docs/LIONFISH_WATCH.md` "L1 results" (every correction there is binding); ingest modes in `docs/ingest-modes.md`. You own: `api/src/ingest/poll/{inat,gbif,nas,openmeteo,ndbc,coops}.rs` (shared with python: keep python behaviour via config params), `api/src/ingest/quality_bio.rs`, `api/fixtures/{inat,gbif,nas,openmeteo,ndbc}/**` additions for lionfish regions, `api/src/backfill.rs` lionfish path, `spec/apps/lionfish.json` (feeds, params). Do not touch the score (L5) or web. Commit on your worktree branch, no push.

- [x] G1: iNaturalist: lionfish taxon only (no `introduced=true` filter, per L1), one pager per region bbox, 10 min poll, observed date vs created date both stored, windows default to observed date, 90-day backfill; tests named `lionfish_inat_`
  CHECK: cargo test --manifest-path api/Cargo.toml lionfish_inat_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: running 3 tests | test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 284 filtered out; finished in 0.11s

- [x] G2: GBIF: lionfish in the four bboxes, daily; records whose source dataset is iNaturalist are marked `duplicate_of` the iNat record (matched by iNat id) and never counted as corroboration; tests named `lionfish_gbif_dedupe`
  CHECK: cargo test --manifest-path api/Cargo.toml lionfish_gbif_dedupe 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: running 2 tests | test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 285 filtered out; finished in 0.24s

- [x] G3: USGS NAS: global `genus=Pterois` with no `state=FL`, paged in parallel, filtered to the four bboxes client-side, weekly; records outside Florida are stored; staleness shown (Colombia newest 2016); tests named `lionfish_nas_`
  CHECK: cargo test --manifest-path api/Cargo.toml lionfish_nas_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: running 3 tests | test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 284 filtered out; finished in 0.67s

- [x] G4: Open-Meteo Marine for the lionfish regions: wave height/period and ocean current (km/h converted to m/s with the unit recorded), 72 h horizon, gated on `meta.json` model-run change, forecast values stored with issuance time; buoys (NDBC bulk `latest_obs.txt` with 304 handling, Florida only) provide the SST conflict case against GOES/CRW; tests named `lionfish_marine_`
  CHECK: cargo test --manifest-path api/Cargo.toml lionfish_marine_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: running 6 tests | test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 281 filtered out; finished in 0.08s

- [x] G5: only lionfish feeds run for the lionfish app (no NWS/NWWS, CO-OPS water level, Open-Meteo forecast, GOES LSTC/ACMC/FDCC); `/health` for lionfish lists exactly: inat, gbif, nas, crw, openmeteo-marine, ndbc, goes19-sst; test named `lionfish_feed_set`
  CHECK: cargo test --manifest-path api/Cargo.toml lionfish_feed_set 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: running 1 test | test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 286 filtered out; finished in 0.01s

- [x] G6: `backfill --app lionfish --fixtures` ends with `BACKFILL-OK`; with network (not in CI) `backfill --app lionfish --days 90` ends with `BACKFILL-OK` and per-area iNat counts within 10% of the live iNat API counts (quote both numbers for fl and mx) and prints `LIONFISH-DATA fl=<n> mx=<n> bz=<n> co=<n>`
  CHECK: INVERSA_DATA_DIR=$(mktemp -d) cargo run -q --release --manifest-path api/Cargo.toml -- backfill --fixtures --app lionfish 2>&1 | grep -c BACKFILL-OK
  EXPECT: /^\s*1\s*$/m
  EVIDENCE: 1 (fixtures run prints LIONFISH-DATA fl=22 mx=24 bz=1 co=4 then BACKFILL-OK). Network run 2026-10-01 ~07:05Z, `backfill --app lionfish --days 90`: LIONFISH-LIVE fl=22 mx=24 bz=1 co=4 (iNat API total_results, same boxes, d1=2026-07-03) / LIONFISH-DATA fl=22 mx=24 bz=1 co=4 / BACKFILL-OK. fl 22 stored vs 22 live (0 %), mx 24 vs 24 (0 %). Rows: inat 468 (incl. 2 mirror catch-up pages), nas 4086 (fl 3687, mx 319, bz 33, co 47), gbif 535 (413 iNat copies, all linked).

- [x] G7: full api suite and clippy clean (state counts)
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep -E "^test result" | tail -2 && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1
  EXPECT: /test result: ok[\s\S]*Finished/
  EVIDENCE: test result: ok. 283 passed; 0 failed; 4 ignored; 0 measured; 0 filtered out; finished in 27.04s | Finished `dev` profile [unoptimized + debuginfo] target(s) in 5.90s
