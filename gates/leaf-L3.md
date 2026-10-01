# Gates: L3 NOAA Coral Reef Watch adapter (opus)

Contract: PLAN.md C-A1..C-A4; adapters take `Arc<App>` (see `api/src/ingest/poll/openmeteo.rs` for the pattern; `api/src/ingest/source.rs` for the trait). Evidence: `docs/evidence/data-proof.md` (ERDDAP griddap JSON `https://pae-paha.pacioos.hawaii.edu/erddap/griddap/dhw_5km.json`, variables `CRW_SST`, `CRW_SSTANOMALY`, `CRW_DHW`, `CRW_BAA`; about 1.7 days latency; licence: credit NOAA Coral Reef Watch + DOI). Mode per `docs/ingest-modes.md`: ERDDAP dataset-change nudge when available plus 3 h poll backstop. You own: `api/src/ingest/poll/crw.rs`, `api/fixtures/crw/**`, the registration line in `ingest/poll/mod.rs`, `api/src/source_pages.rs` (the CRW page), migration `api/migrations/observations/0004_reef_heat.sql` if a new table is needed (otherwise reuse readings with new `Param`s: sst, sst_anomaly, dhw, baa), `api/src/model.rs` additions for the params. Do not touch web. Commit on your worktree branch, no push.

- [ ] G1: adapter fetches CRW for each lionfish region's reef cells at 5 km (use the region bbox from config, request the last N days, subset by stride to the app grid), writes readings with params `sst,sst_anomaly,dhw,baa` per cell with observed date (the product date), `ingestedAt`, source `crw`; fixtures cover a 4-region sample; tests named `crw_` (fixture-driven, no network)
  CHECK: cargo test --manifest-path api/Cargo.toml crw_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G2: quality rules: product lag over 3 days flags `stale`; masked/NaN cells are `missing` (never zero-filled, `ENV_FLAGGED` in frames); DHW and BAA disagreement is preserved as two values (test with Florida-like DHW 13.65 and BAA 1); land cells are skipped; tests named `crw_quality`
  CHECK: cargo test --manifest-path api/Cargo.toml crw_quality 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G3: nudge: `POST /v1/{app}/ingest/nudge/crw/{token}` (token from env `INGEST_NUDGE_TOKEN`) triggers an immediate fetch, is idempotent within 60 s, rejects bad tokens with 401, unknown app 404; test names `crw_nudge`
  CHECK: cargo test --manifest-path api/Cargo.toml crw_nudge 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G4: live smoke (ignored test, run explicitly): fetches the real endpoint and returns values for all four regions with a date within 4 days of now; print `CRW-LIVE regions=4 newest=<date>`
  CHECK: cargo test --manifest-path api/Cargo.toml crw_live -- --ignored --nocapture 2>&1 | grep CRW-LIVE
  EXPECT: /CRW-LIVE regions=4 newest=20\d\d-\d\d-\d\d/
  EVIDENCE: pending

- [ ] G5: feed-state: `crw` appears in `/health` for lionfish only with mode `webhook` (nudge) + backstop note, not for carp/python; licence/credit and DOI in `source_pages.rs`; clippy clean; full api suite passes (state count)
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep -E "test result" | tail -2 && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1
  EXPECT: /test result: ok[\s\S]*Finished/
  EVIDENCE: pending
