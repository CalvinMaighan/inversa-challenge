# Gates: C3 bitemporal forecast and alert store (fable)

Contract: PLAN.md C-A1; `docs/APPS.md` carp section "Hero feature: replay what was known at the time"; `docs/evidence/carp-data-proof.md` (NWPS forecasts issue once a day; horizons 5 to 15 days; IEM archive `hml.py` can backfill past NWS river forecasts; flood categories use NWPS stage only; USGS vs NWPS datum differ). You own: migration `api/migrations/observations/0004_forecasts.sql` (renumber to the next free number), `api/src/forecast/**` (new module: store, queries, verification), `api/src/graphql/**` additions only for forecast types (`forecasts(site, asOf, ...)`, `forecastVerify`, `siteStatusAt`), `api/schema.graphql`. Do not write the adapters (C4) and do not touch web. Commit on your worktree branch, no push. Another leaf (L3) adds `crw.rs` and migration 0004_reef_heat concurrently: use the next free migration number at merge time and say so in your report.

Times kept apart on every row: `observed_at`, `issued_at`, `valid_from/valid_to` (and per-point `valid_at`), `ingested_at`. Provenance: `source` (`nwps-live` | `iem-archive` | `nws-gridpoint`), `payload_hash`.

- [x] G1: schema + store: `forecast_snapshots(site, product, issued_at, ingested_at, source, payload_hash, horizon_end)` and `forecast_points(snapshot_id, valid_at, stage_ft, flow_kcfs, category)` (carp site ids from config); alert snapshots table with `first_seen`, `last_seen`, `ended_at`; inserting the same `(site, product, issued_at, payload_hash)` twice is a no-op; a changed payload with the same `issued_at` is a revision, kept; test names `forecast_store`
  CHECK: cargo test --manifest-path api/Cargo.toml forecast_store 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: 2026-10-01 migration `0006_forecasts.sql` (0004/0005 were taken by taxon_info/taxon_ancestry; L3's `0004_reef_heat` must renumber too). `cargo test forecast_store` →
    running 3 tests
    test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 252 filtered out; finished in 0.01s
  Tests: idempotent duplicate (same hash, even with a later ingested_at) is a no-op; changed payload same issued_at → revision 1 kept beside revision 0; categories from NWPS thresholds with -9999 → null; alert first_seen/last_seen/ended_at per site.

- [x] G2: as-of queries: `forecast_asof(site, t)` returns the snapshot with greatest `issued_at <= t` AND `ingested_at <= t` for live-captured data (archive-backfilled snapshots use `issued_at` only and are labelled `iem-archive`); observations after `t` are excluded from an as-of view and present in the later view; two versions of one valid time return different values for different `t`; coverage start (`replayCoverageStart`) per site is returned; tests named `bitemporal_`
  CHECK: cargo test --manifest-path api/Cargo.toml bitemporal_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: 2026-10-01 `cargo test bitemporal_` →
    running 3 tests
    test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 252 filtered out; finished in 0.02s
  Live rows need issued_at <= t AND ingested_at <= t; `iem-archive` rows issued_at only. Observations captured after t are absent at t and present at t+1h. Same valid time, two issuances/revisions: different values for different t. `coverage()` returns replay_coverage_start (first knowable snapshot) and live_coverage_start.

- [x] G3: verification: `forecast_verify(site, issued_at)` pairs each forecast point with the observed stage at the same valid time (nearest within 30 min), returns errors (ft), bias, whether the peak category was hit; missing observations are reported as missing, never interpolated; tests named `forecast_verify`
  CHECK: cargo test --manifest-path api/Cargo.toml forecast_verify 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: 2026-10-01 `cargo test forecast_verify` →
    running 1 test
    test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 254 filtered out; finished in 0.00s
  Pairs nearest observation within 30 min (31 min → missing), per-point error ft, bias, mean/max abs error, forecast vs observed peak category hit; missing points stay null.

- [x] G4: GraphQL: `forecasts`, `forecastVerify`, `siteStatusAt(site, asOf)` (stage, category from NWPS stage thresholds only, freshness bands, conflicts such as gauge vs forecast disagreement over a configurable threshold) exposed per app only for `kind=conditions`; for species apps they return a typed error; schema-diff test passes; resolver tests named `forecast_graphql`
  CHECK: cargo test --manifest-path api/Cargo.toml forecast_graphql 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: 2026-10-01 `cargo test forecast_graphql` →
    running 4 tests
    test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 251 filtered out; finished in 0.06s
  `forecasts(site, asOf, history)`, `forecastVerify(site, issuedAt)`, `siteStatusAt(site, asOf, conflictFt)` on carp; python and lionfish get error code NOT_CONDITIONS_APP with data null; unknown site UNKNOWN_SITE. `schema_matches_contract` passes in the full run (G6).

- [x] G5: performance and size: 60 days x 8 sites x 1 snapshot/day x 15 d hourly points stays under 25 MB in SQLite and `forecast_asof` runs under 5 ms p95 on that data (test prints `FORECAST-PERF p95_ms=<n> size_mb=<n>`)
  CHECK: cargo test --release --manifest-path api/Cargo.toml forecast_perf -- --nocapture 2>&1 | grep FORECAST-PERF
  EXPECT: /FORECAST-PERF p95_ms=([0-4](\.\d+)?) size_mb=([0-9]|1[0-9]|2[0-4])(\.\d+)?/
  EVIDENCE: 2026-10-01 release, file-backed WAL db, 172,800 points →
    FORECAST-PERF p95_ms=0.04 size_mb=6.6 load_ms=296 status_ms=0.11 points=172800

- [x] G6: full api suite and clippy clean (state counts)
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep -E "test result" | tail -2 && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1
  EXPECT: /test result: ok[\s\S]*Finished/
  EVIDENCE: 2026-10-01 →
    test result: ok. 252 passed; 0 failed; 3 ignored; 0 measured; 0 filtered out; finished in 61.01s
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.33s
  Was 240 tests before this leaf (3 ignored unchanged); +12: 3 forecast_store, 3 bitemporal_, 1 forecast_verify, 1 forecast_perf, 4 forecast_graphql. Clippy clean with -D warnings.
