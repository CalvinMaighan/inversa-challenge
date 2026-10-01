# Gates: L3 NOAA Coral Reef Watch adapter (opus)

Contract: PLAN.md C-A1..C-A4; adapters take `Arc<App>` (see `api/src/ingest/poll/openmeteo.rs` for the pattern; `api/src/ingest/source.rs` for the trait). Evidence: `docs/evidence/data-proof.md` (ERDDAP griddap JSON `https://pae-paha.pacioos.hawaii.edu/erddap/griddap/dhw_5km.json`, variables `CRW_SST`, `CRW_SSTANOMALY`, `CRW_DHW`, `CRW_BAA`; about 1.7 days latency; licence: credit NOAA Coral Reef Watch + DOI). Mode per `docs/ingest-modes.md`: ERDDAP dataset-change nudge when available plus 3 h poll backstop. You own: `api/src/ingest/poll/crw.rs`, `api/fixtures/crw/**`, the registration line in `ingest/poll/mod.rs`, `api/src/source_pages.rs` (the CRW page), migration `api/migrations/observations/0004_reef_heat.sql` if a new table is needed (otherwise reuse readings with new `Param`s: sst, sst_anomaly, dhw, baa), `api/src/model.rs` additions for the params. Do not touch web. Commit on your worktree branch, no push.

- [x] G1: adapter fetches CRW for each lionfish region's reef cells at 5 km (use the region bbox from config, request the last N days, subset by stride to the app grid), writes readings with params `sst,sst_anomaly,dhw,baa` per cell with observed date (the product date), `ingestedAt`, source `crw`; fixtures cover a 4-region sample; tests named `crw_` (fixture-driven, no network)
  CHECK: cargo test --manifest-path api/Cargo.toml crw_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: `running 17 tests` / `test result: ok. 16 passed; 0 failed; 1 ignored` (the ignored one is crw_live). Fixtures `api/fixtures/crw/{fl-keys,mx-caribbean,belize,co-caribbean,last}.json` (+ `.url`, manifest): 288 cells, 36 land, 2016 readings over 2 product days. Migration is `0006_reef_heat.sql` (0004 was already taken by taxon_info); it widens the readings param and sources mode CHECKs in place.

- [x] G2: quality rules: product lag over 3 days flags `stale`; masked/NaN cells are `missing` (never zero-filled, `ENV_FLAGGED` in frames); DHW and BAA disagreement is preserved as two values (test with Florida-like DHW 13.65 and BAA 1); land cells are skipped; tests named `crw_quality`
  CHECK: cargo test --manifest-path api/Cargo.toml crw_quality 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: `running 4 tests` / `test result: ok. 4 passed; 0 failed`. Stale is the feed state (`max_latency` 72 h): 41 h and 55 h nominal, 66 h lagging, 73 h stale. Masked/ice/fill/out-of-range values are `flag=missing` with a null value (the frames ENV_FLAGGED convention; EVF2 carries only lst/sst, so CRW params are not in frames today). Looe Key DHW 13.65 + BAA 1 kept as two readings and in evidence. Land (mask 1) skipped.

- [x] G3: nudge: `POST /v1/{app}/ingest/nudge/crw/{token}` (token from env `INGEST_NUDGE_TOKEN`) triggers an immediate fetch, is idempotent within 60 s, rejects bad tokens with 401, unknown app 404; test names `crw_nudge`
  CHECK: cargo test --manifest-path api/Cargo.toml crw_nudge 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: `running 3 tests` / `test result: ok. 3 passed; 0 failed`. Route takes POST and GET (ERDDAP URL actions use GET): 202 accepted, 200 duplicate within 60 s, 401 bad token, 404 unknown app or non-webhook source, 503 token unset. The scheduler loop (3 h backstop) fetched again right after the nudge and not after the duplicate.

- [x] G4: live smoke (ignored test, run explicitly): fetches the real endpoint and returns values for all four regions with a date within 4 days of now; print `CRW-LIVE regions=4 newest=<date>`
  CHECK: cargo test --manifest-path api/Cargo.toml crw_live -- --ignored --nocapture 2>&1 | grep CRW-LIVE
  EXPECT: /CRW-LIVE regions=4 newest=20\d\d-\d\d-\d\d/
  EVIDENCE: `CRW-LIVE regions=4 newest=2026-09-29` (product 42.6 h old; one product day for all four region boxes = 1,500,074 bytes, 63,912 readings, 7.4 s).

- [x] G5: feed-state: `crw` appears in `/health` for lionfish only with mode `webhook` (nudge) + backstop note, not for carp/python; licence/credit and DOI in `source_pages.rs`; clippy clean; full api suite passes (state count)
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep -E "test result" | tail -2 && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1
  EXPECT: /test result: ok[\s\S]*Finished/
  EVIDENCE: `test result: ok. 256 passed; 0 failed; 4 ignored` then clippy `Finished dev profile`. /health: lionfish lists `crw` mode `webhook`, note `webhook nudge on dataset change; poll backstop[ every 3h]`; carp and python do not list it (crw_health_webhook_for_lionfish_only). `source_pages.rs`: `CRW_CREDIT`, `CRW_DOI` (10.3390/rs12233856), crw cell page = PacIOOS ERDDAP htmlTable; reading evidence carries `record.credit` and `record.doi`.
