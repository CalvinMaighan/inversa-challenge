# Gates: C3 bitemporal forecast and alert store (fable)

Contract: PLAN.md C-A1; `docs/APPS.md` carp section "Hero feature: replay what was known at the time"; `docs/evidence/carp-data-proof.md` (NWPS forecasts issue once a day; horizons 5 to 15 days; IEM archive `hml.py` can backfill past NWS river forecasts; flood categories use NWPS stage only; USGS vs NWPS datum differ). You own: migration `api/migrations/observations/0004_forecasts.sql` (renumber to the next free number), `api/src/forecast/**` (new module: store, queries, verification), `api/src/graphql/**` additions only for forecast types (`forecasts(site, asOf, ...)`, `forecastVerify`, `siteStatusAt`), `api/schema.graphql`. Do not write the adapters (C4) and do not touch web. Commit on your worktree branch, no push. Another leaf (L3) adds `crw.rs` and migration 0004_reef_heat concurrently: use the next free migration number at merge time and say so in your report.

Times kept apart on every row: `observed_at`, `issued_at`, `valid_from/valid_to` (and per-point `valid_at`), `ingested_at`. Provenance: `source` (`nwps-live` | `iem-archive` | `nws-gridpoint`), `payload_hash`.

- [ ] G1: schema + store: `forecast_snapshots(site, product, issued_at, ingested_at, source, payload_hash, horizon_end)` and `forecast_points(snapshot_id, valid_at, stage_ft, flow_kcfs, category)` (carp site ids from config); alert snapshots table with `first_seen`, `last_seen`, `ended_at`; inserting the same `(site, product, issued_at, payload_hash)` twice is a no-op; a changed payload with the same `issued_at` is a revision, kept; test names `forecast_store`
  CHECK: cargo test --manifest-path api/Cargo.toml forecast_store 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G2: as-of queries: `forecast_asof(site, t)` returns the snapshot with greatest `issued_at <= t` AND `ingested_at <= t` for live-captured data (archive-backfilled snapshots use `issued_at` only and are labelled `iem-archive`); observations after `t` are excluded from an as-of view and present in the later view; two versions of one valid time return different values for different `t`; coverage start (`replayCoverageStart`) per site is returned; tests named `bitemporal_`
  CHECK: cargo test --manifest-path api/Cargo.toml bitemporal_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G3: verification: `forecast_verify(site, issued_at)` pairs each forecast point with the observed stage at the same valid time (nearest within 30 min), returns errors (ft), bias, whether the peak category was hit; missing observations are reported as missing, never interpolated; tests named `forecast_verify`
  CHECK: cargo test --manifest-path api/Cargo.toml forecast_verify 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G4: GraphQL: `forecasts`, `forecastVerify`, `siteStatusAt(site, asOf)` (stage, category from NWPS stage thresholds only, freshness bands, conflicts such as gauge vs forecast disagreement over a configurable threshold) exposed per app only for `kind=conditions`; for species apps they return a typed error; schema-diff test passes; resolver tests named `forecast_graphql`
  CHECK: cargo test --manifest-path api/Cargo.toml forecast_graphql 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G5: performance and size: 60 days x 8 sites x 1 snapshot/day x 15 d hourly points stays under 25 MB in SQLite and `forecast_asof` runs under 5 ms p95 on that data (test prints `FORECAST-PERF p95_ms=<n> size_mb=<n>`)
  CHECK: cargo test --release --manifest-path api/Cargo.toml forecast_perf -- --nocapture 2>&1 | grep FORECAST-PERF
  EXPECT: /FORECAST-PERF p95_ms=([0-4](\.\d+)?) size_mb=([0-9]|1[0-9]|2[0-4])(\.\d+)?/
  EVIDENCE: pending

- [ ] G6: full api suite and clippy clean (state counts)
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep -E "test result" | tail -2 && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1
  EXPECT: /test result: ok[\s\S]*Finished/
  EVIDENCE: pending
