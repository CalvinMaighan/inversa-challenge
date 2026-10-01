# Gates: C4 carp adapters: NWPS, USGS OGC, NWS forecast and alerts, IEM archive (opus)

Contract: PLAN.md C-A1..C-A4; `spec/apps/carp.json` (locations; replace the provisional placeholders with the 8 real sites from `docs/evidence/carp-data-proof.md`: SMML1/07381490, KRZL1/07381500, BLRL1/07381515, MCGL1/07381600, BTRL1/07374000, AEXL1/07355500, MLUL1/07367005, BXAL1/02489500, with lat/lon, NWS grid, camera presets; remove `provisional`); store API from `api/src/forecast/store.rs` (C3: `insert_snapshot`, `insert_observations`, `upsert_thresholds`, `record_alerts`); ingest modes from `docs/ingest-modes.md` (USGS 15 min batched OGC request; NWPS 15 min 12:00-18:00Z else hourly, store only when `issuedTime` changes; NWS gridpoint hourly versioned on `updateTime`; NWS alerts `area=LA` every 1-2 min with NWWS-OI as the push path once credentialed; IEM HML archive backfill then daily). You own: `api/src/ingest/poll/{nwps,usgs,nws,iem}.rs` (usgs.rs and nws.rs are shared with python: keep python behaviour via config params), `api/fixtures/{nwps,usgs_ogc,nws_la,iem}/**`, `spec/apps/carp.json`, `api/src/backfill.rs` additions (`backfill --app carp --days N` and `--fixtures`), and the `#[allow(dead_code)]` removal in `forecast/store.rs`. Commit on your worktree branch, no push.

- [ ] G1: USGS OGC API adapter (continuous stage 00065 and discharge 00060 for the carp sites, ONE batched request per poll, optional `USGS_API_KEY`, 429 and `Retry-After` honoured, readings stored with parameter, unit, site, observed_at); python's usgs source also moves off the legacy `waterservices` endpoint to the same OGC adapter via config; tests named `usgs_ogc_`
  CHECK: cargo test --manifest-path api/Cargo.toml usgs_ogc_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G2: NWPS adapter: gauge metadata (flood category thresholds with -9999 as missing), observed series into `forecast_observations`, stage/flow forecast into snapshots with `source=nwps-live` only when `issuedTime` changed, schedule window per ingest-modes, USGS id mapping from config because NWPS `usgsId` is empty for 4 of 8 sites; tests named `nwps_`
  CHECK: cargo test --manifest-path api/Cargo.toml nwps_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G3: NWS adapters for carp: gridpoint forecast snapshots (`nws-gridpoint`, versioned on `updateTime`) and alerts for `area=LA` matched to sites (record_alerts, ended alerts closed); "no active alerts" is a recorded check with timestamp, not silence; NWWS-OI source stays registered but down with a clear note when credentials are missing; tests named `nws_la_`
  CHECK: cargo test --manifest-path api/Cargo.toml nws_la_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G4: IEM archive backfill: `hml.py` river forecast issuances for the last N days (default 30) land as snapshots with `source=iem-archive` and their true `issued_at`; re-running is idempotent; tests named `iem_`
  CHECK: cargo test --manifest-path api/Cargo.toml iem_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G5: out-of-scope guard: rows for sites not in carp.json and observations outside plausible ranges are skipped and counted (`rows_skipped`); carp has no hotspot grid and no frames; `/health` for carp lists usgs, nwps, nws-forecast, nws-alerts, iem with the right modes
  CHECK: cargo test --manifest-path api/Cargo.toml carp_scope_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G6: live smoke (ignored tests run explicitly): prints `CARP-LIVE sites=8 usgs=8 nwps=8 nws=8 snapshots>=8 iem>=8`; and `backfill --app carp --days 7` into a temp dir ends with `BACKFILL-OK` and leaves at least 2 forecast snapshots per site (quote the SQL count)
  CHECK: cargo test --manifest-path api/Cargo.toml carp_live -- --ignored --nocapture 2>&1 | grep CARP-LIVE
  EXPECT: /CARP-LIVE sites=8 usgs=8 nwps=8 nws=8 snapshots=([8-9]|[1-9][0-9]+) iem=([8-9]|[1-9][0-9]+)/
  EVIDENCE: pending

- [ ] G7: full api suite and clippy clean (state counts)
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep -E "^test result" | tail -2 && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1
  EXPECT: /test result: ok[\s\S]*Finished/
  EVIDENCE: pending
