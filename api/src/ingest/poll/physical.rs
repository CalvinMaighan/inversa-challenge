//! Physical source registry (T8) plus the helpers the physical adapters share: the app's
//! regions (PLAN.md C-A4), reading construction with missing-value flags, and time parsing.

use std::sync::Arc;

use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};

pub use crate::app::config::BBox;
use crate::app::config::App;
use crate::ingest::poll::{coops, iem, ndbc, nwps, nws, nws_forecast, openmeteo, usgs};
use crate::ingest::source::{RawPayload, Source};
use crate::model::{Flag, Origin, Param, ReadingRow, Row, StationRef};
use crate::state::Config;

/// The physical pollers the app's `feeds[]` lists, in registry order. NWWS-OI is a push source
/// and lives in `push::nwws`. The carp (conditions) adapters come last: `nwps` before `iem`, so
/// a fixture or network backfill stores the NWPS thresholds before the archive issuances they
/// categorise.
pub fn sources(config: &Config, app: &Arc<App>) -> Vec<Arc<dyn Source>> {
    let mut out: Vec<Arc<dyn Source>> = Vec::new();
    if app.cfg.has_feed("nws") || app.cfg.has_feed("nws-alerts") {
        out.push(Arc::new(nws::Nws::new(config, app.clone())));
    }
    if app.cfg.has_feed(usgs::SOURCE_ID) {
        out.push(Arc::new(usgs::Usgs::new(config, app.clone())));
    }
    if app.cfg.has_feed("ndbc") {
        out.push(Arc::new(ndbc::Ndbc::for_app(app.clone())));
    }
    if app.cfg.has_feed("coops") {
        out.push(Arc::new(coops::Coops::new()));
    }
    if app.cfg.has_feed("openmeteo") {
        out.push(Arc::new(openmeteo::OpenMeteo::new(app.clone())));
    }
    if app.cfg.has_feed(openmeteo::MARINE_SOURCE_ID) {
        out.push(Arc::new(openmeteo::OpenMeteoMarine::new(app.clone())));
    }
    if app.cfg.has_feed(nwps::SOURCE_ID) {
        out.push(Arc::new(nwps::Nwps::new(app.clone())));
    }
    if app.cfg.has_feed(nws_forecast::SOURCE_ID) {
        out.push(Arc::new(nws_forecast::NwsForecast::new(config, app.clone())));
    }
    if app.cfg.has_feed(iem::SOURCE_ID) {
        out.push(Arc::new(iem::Iem::new(app.clone())));
    }
    out
}

/// The bbox of every region, in config order.
pub fn region_boxes(app: &App) -> Vec<BBox> {
    app.regions.iter().map(|r| r.cfg.bbox).collect()
}

pub const FEET_TO_M: f64 = 0.3048;

/// A reading row. A missing (or non-finite) value is kept as `flag = missing` with a null value,
/// never dropped, so gaps stay visible downstream.
pub fn reading(station: &StationRef, param: Param, value: Option<f64>, observed_at: i64, origin: Origin) -> Row {
    let value = value.filter(|v| v.is_finite());
    Row::Reading(ReadingRow {
        station: station.clone(),
        param,
        flag: if value.is_some() { Flag::Ok } else { Flag::Missing },
        value,
        observed_at,
        origin,
    })
}

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// A payload as fetched over HTTP.
pub fn payload(source_url: &str, content_type: &str, bytes: Vec<u8>, http_status: u16, next_cursor: Option<String>) -> RawPayload {
    RawPayload {
        source_url: source_url.to_string(),
        content_type: content_type.to_string(),
        bytes,
        http_status: Some(http_status),
        fetched_at: now_ms(),
        next_cursor,
        ack: None,
    }
}

/// Content type of a response, without parameters, defaulting to `fallback`.
pub fn content_type(res: &reqwest::Response, fallback: &str) -> String {
    res.headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or(v).trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

/// RFC 3339 / ISO 8601 with offset to unix ms.
pub fn parse_rfc3339_ms(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s.trim()).ok().map(|t| t.timestamp_millis())
}

/// A naive UTC timestamp in `fmt` to unix ms.
pub fn parse_utc_ms(s: &str, fmt: &str) -> Option<i64> {
    NaiveDateTime::parse_from_str(s.trim(), fmt).ok().map(|t| Utc.from_utc_datetime(&t).timestamp_millis())
}

/// Parse a number, treating empty strings and non-finite values as missing.
pub fn parse_num(s: &str) -> Option<f64> {
    s.trim().parse::<f64>().ok().filter(|v| v.is_finite())
}

#[cfg(test)]
pub(crate) mod testing {
    //! Fixture loading and the fake-fetch idempotency harness shared by the adapter tests.

    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;

    use async_trait::async_trait;

    use crate::app::test_support::test_state;
    use crate::ingest::scheduler::{ingest_payload, IngestOutcome};
    use crate::ingest::source::{FetchCtx, RawPayload, Source, SourceInfo};
    use crate::model::Row;
    use crate::state::AppState;

    /// The python app's single region (the pre-pivot bbox every physical fixture was recorded for).
    pub fn python_region() -> super::BBox {
        crate::app::config::App::builtin("python").unwrap().regions[0].cfg.bbox
    }

    pub fn python_app() -> Arc<crate::app::config::App> {
        Arc::new(crate::hotspot::score::testkit::python_app())
    }

    pub fn fixture_path(rel: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures").join(rel)
    }

    pub fn fixture(rel: &str) -> Vec<u8> {
        let path = fixture_path(rel);
        std::fs::read(&path).unwrap_or_else(|e| panic!("fixture {}: {e}", path.display()))
    }

    pub fn fixture_str(rel: &str) -> String {
        String::from_utf8(fixture(rel)).expect("utf-8 fixture")
    }

    /// A recorded payload, as `fetch` would have produced it at `fetched_at`.
    pub fn recorded(source_url: &str, content_type: &str, bytes: Vec<u8>, http_status: u16, fetched_at: i64) -> RawPayload {
        RawPayload {
            source_url: source_url.to_string(),
            content_type: content_type.to_string(),
            bytes,
            http_status: Some(http_status),
            fetched_at,
            next_cursor: None,
            ack: None,
        }
    }

    /// Wraps a real adapter: `fetch` replays recorded payloads, `normalize` is the adapter's.
    pub struct FakeFetch<S: Source> {
        pub inner: S,
        pub payloads: Vec<RawPayload>,
    }

    #[async_trait]
    impl<S: Source> Source for FakeFetch<S> {
        fn info(&self) -> SourceInfo {
            self.inner.info()
        }
        fn min_interval(&self) -> Duration {
            self.inner.min_interval()
        }
        async fn fetch(&self, _ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
            Ok(self.payloads.clone())
        }
        fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
            self.inner.normalize(raw)
        }
    }

    pub async fn table_counts(state: &AppState) -> Vec<(&'static str, i64)> {
        let mut out = Vec::new();
        for t in ["stations", "readings", "alerts", "raw_objects"] {
            let n: i64 =
                state.obs.read(move |c| c.query_row(&format!("select count(*) from {t}"), [], |r| r.get(0))).await.unwrap();
            out.push((t, n));
        }
        out
    }

    /// Fetch (fake) and ingest twice through `scheduler::ingest_payload`. Asserts the first run
    /// wrote rows and the second wrote none and left every table unchanged. Returns the state and
    /// the first run's outcomes for further assertions.
    pub async fn assert_idempotent<S: Source>(source: FakeFetch<S>) -> (AppState, Vec<IngestOutcome>) {
        let state = test_state();
        let source: Arc<dyn Source> = Arc::new(source);
        let mut first = Vec::new();
        for raw in source.fetch(&FetchCtx { state: &state, cursor: None }).await.unwrap() {
            first.push(ingest_payload(&state, source.as_ref(), raw, None).await.unwrap());
        }
        assert!(!first.is_empty(), "fake fetch returned payloads");
        for out in &first {
            assert!(out.error.is_none(), "first run failed: {out:?}");
        }
        let written: usize = first.iter().map(|o| o.rows_written).sum();
        assert!(written > 0, "first run wrote rows: {first:?}");
        let before = table_counts(&state).await;

        for raw in source.fetch(&FetchCtx { state: &state, cursor: None }).await.unwrap() {
            let again = ingest_payload(&state, source.as_ref(), raw, None).await.unwrap();
            assert!(again.error.is_none(), "second run failed: {again:?}");
            assert_eq!(again.rows_written, 0, "second run added rows: {again:?}");
            assert_eq!(again.window, None);
        }
        assert_eq!(table_counts(&state).await, before, "second run changed table counts");
        (state, first)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn region_contains_and_registry_lists_five_pollers() {
        let region = testing::python_region();
        assert!(region.contains(25.76, -80.19), "Miami");
        assert!(region.contains(24.55, -81.80), "Key West");
        assert!(!region.contains(28.5, -81.4), "Orlando");
        let ids: Vec<&str> = sources(&Config::for_tests(), &testing::python_app()).iter().map(|s| s.info().id).collect();
        assert_eq!(ids, ["nws", "usgs", "ndbc", "coops", "openmeteo"]);
        // Lionfish Watch lists no NWS, USGS, CO-OPS or Open-Meteo forecast feed; carp runs the river adapters (C4).
        let lf = Arc::new(App::builtin("lionfish").unwrap());
        let ids: Vec<&str> = sources(&Config::for_tests(), &lf).iter().map(|s| s.info().id).collect();
        assert_eq!(ids, ["ndbc", "openmeteo-marine"], "bulk buoys and marine only (L4)");
        let carp = Arc::new(App::builtin("carp").unwrap());
        let ids: Vec<&str> = sources(&Config::for_tests(), &carp).iter().map(|s| s.info().id).collect();
        assert_eq!(ids, ["nws-alerts", "usgs", "nwps", "nws-forecast", "iem"]);
        assert_eq!(region_boxes(&lf).len(), 4);
    }

    // ---- C4 G5: carp scope guard and /health ---------------------------------------------

    /// Rows for sites outside carp.json are skipped and counted; implausible observations too;
    /// carp has no hotspot grid and no frames; `/health` lists the five carp pollers (plus the
    /// hook and NWWS registrations) with their modes.
    #[tokio::test]
    async fn carp_scope_guard_skips_foreign_sites_and_implausible_values() {
        use crate::app::test_support::test_state_for;
        use crate::forecast::store::NewSnapshot;
        use crate::forecast::{Observation, Point, Source as FSource, Thresholds};
        use crate::ingest::scheduler::{ingest_payload, RunStatus};
        use crate::model::{ForecastObservationsRow, SiteAlertsRow, ThresholdsRow};
        let state = test_state_for("carp");
        let t = 1_790_838_063_000;
        let snap = |site: &str, stage: f64| {
            Row::ForecastSnapshot(NewSnapshot {
                site: site.into(),
                product: "stageflow".into(),
                issued_at: t,
                ingested_at: t,
                source: FSource::NwpsLive,
                payload_hash: format!("h-{site}-{stage}"),
                points: vec![Point { valid_at: t + 3_600_000, stage_ft: Some(stage), flow_kcfs: None }],
            })
        };
        let gauge = |ext: &str, lat: f64, lon: f64, value: f64| {
            reading(&StationRef { ext_id: ext.into(), name: ext.into(), lat, lon, kind: crate::model::StationKind::Gage }, Param::StageM, Some(value), t, Origin::Measured)
        };
        let rows = vec![
            snap("KRZL1", 4.0),
            snap("VLSL1", 4.0),
            snap("MCGL1", 999.0),
            Row::ForecastObservations(ForecastObservationsRow {
                site: "BTRL1".into(),
                source: FSource::NwpsLive,
                observations: vec![Observation { observed_at: t, stage_ft: Some(8.0), flow_kcfs: Some(245.0) }, Observation { observed_at: t + 1, stage_ft: Some(-9999.0), flow_kcfs: None }],
            }),
            Row::ForecastObservations(ForecastObservationsRow { site: "RRVL1".into(), source: FSource::NwpsLive, observations: vec![Observation { observed_at: t, stage_ft: Some(1.0), flow_kcfs: None }] }),
            Row::Thresholds(ThresholdsRow { site: "NOPE1".into(), thresholds: Thresholds::from_feed(1.0, 2.0, 3.0, 4.0) }),
            Row::SiteAlerts(SiteAlertsRow { site: "NOPE1".into(), seen_at: t, alerts: vec![] }),
            gauge("07381500", 30.5689, -91.7614, 1.0),
            gauge("07380000", 30.6, -91.7, 1.0),
            gauge("07381490", 30.9825, -91.7983, 500.0),
        ];
        let raw = crate::ingest::poll::physical::testing::recorded("test://scope", "application/json", serde_json::to_vec(&rows).unwrap(), 200, t);
        let hook = crate::ingest::push::hook::HookSource::web();
        let out = ingest_payload(&state, &hook, raw, None).await.unwrap();
        assert_eq!(out.rows_in, 10);
        // Skipped: VLSL1 snapshot, the 999 ft point (its snapshot still lands, empty), RRVL1
        // observations, NOPE1 thresholds and alerts, the -9999 observation, the foreign gauge
        // and the 500 m stage.
        assert_eq!(out.rows_skipped, 8, "{out:?}");
        assert_eq!(out.status, RunStatus::Partial);
        let (snaps, points, obs, thr, stations): (i64, i64, i64, i64, i64) = state
            .obs
            .read(|c| {
                c.query_row(
                    "select (select count(*) from forecast_snapshots), (select count(*) from forecast_points),
                            (select count(*) from forecast_observations), (select count(*) from forecast_thresholds),
                            (select count(*) from stations)",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
            })
            .await
            .unwrap();
        assert_eq!((snaps, points, obs, thr, stations), (2, 1, 1, 0, 1), "only configured sites and plausible values are stored");
        assert!(!state.app.is_species(), "carp has no hotspot grid");
        assert!(state.app.cfg.locations.len() == 8 && state.app.cfg.taxa.is_empty());

        // /health for carp: the river pollers with their modes, once the scheduler registered them.
        crate::ingest::scheduler::start(state.clone(), crate::ingest::scheduler::Supervision::default()).await.unwrap();
        let router = crate::app::test_support::router_for(&state);
        let res = tower::ServiceExt::oneshot(router, axum::http::Request::get("/health").body(axum::body::Body::empty()).unwrap()).await.unwrap();
        let body: serde_json::Value =
            serde_json::from_slice(&http_body_util::BodyExt::collect(res.into_body()).await.unwrap().to_bytes()).unwrap();
        let carp = &body["apps"][0];
        assert_eq!(carp["id"], "carp");
        let modes: std::collections::BTreeMap<&str, &str> =
            carp["feeds"].as_array().unwrap().iter().map(|f| (f["source"].as_str().unwrap(), f["mode"].as_str().unwrap())).collect();
        for (source, mode) in [("usgs", "poll"), ("nwps", "poll"), ("nws-forecast", "poll"), ("nws-alerts", "poll"), ("iem", "poll"), ("nwws", "push"), ("web", "push")] {
            assert_eq!(modes.get(source), Some(&mode), "{source}: {carp}");
        }
        assert!(!modes.contains_key("nws"), "carp runs nws-alerts, not the python nws id");
        let nwws = carp["feeds"].as_array().unwrap().iter().find(|f| f["source"] == "nwws").unwrap();
        assert_eq!(nwws["state"], "down");
        assert!(nwws["note"].as_str().unwrap().contains("NWWS_USER"), "{nwws}");
        let res = tower::ServiceExt::oneshot(crate::app::test_support::router_for(&state), axum::http::Request::get("/v1/carp/frames?from=0&to=0").body(axum::body::Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), axum::http::StatusCode::NOT_FOUND, "no frames for a conditions app");
    }

    /// `backfill --app carp --fixtures` replays every recorded carp payload through the real
    /// pipeline, in an order that stores thresholds before the archive, and ends with BACKFILL-OK.
    #[tokio::test]
    async fn carp_scope_fixture_backfill_covers_every_site() {
        use crate::app::test_support::test_state_for;
        let state = test_state_for("carp");
        let ids: Vec<&str> = crate::backfill::fixture_sources(&state).iter().map(|s| s.info().id).collect();
        assert_eq!(ids, ["nws-alerts", "usgs", "nwps", "nws-forecast", "iem"]);
        crate::backfill::run(state.clone(), &["--fixtures".to_string(), "--app".to_string(), "carp".to_string()]).await.unwrap();
        let (sites_with_obs, sites_with_snaps, iem, gridpoint, gauges): (i64, i64, i64, i64, i64) = state
            .obs
            .read(|c| {
                c.query_row(
                    "select (select count(distinct site) from forecast_observations),
                            (select count(distinct site) from forecast_snapshots where source = 'nwps-live'),
                            (select count(*) from forecast_snapshots where source = 'iem-archive'),
                            (select count(*) from forecast_snapshots where source = 'nws-gridpoint'),
                            (select count(*) from stations where source_id = 'usgs')",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
            })
            .await
            .unwrap();
        assert_eq!((sites_with_obs, sites_with_snaps, iem, gridpoint, gauges), (8, 8, 56, 8, 8));
        let m = crate::backfill::measure(&state, "iem").await.unwrap();
        assert_eq!(m.snapshots, 56);
        assert_eq!(crate::backfill::measure(&state, "nwps").await.unwrap().snapshots, 8);
        crate::backfill::run(state.clone(), &["--fixtures".to_string()]).await.unwrap();
        let n: i64 = state.obs.read(|c| c.query_row("select count(*) from forecast_snapshots", [], |r| r.get(0))).await.unwrap();
        assert_eq!(n, 72, "a second fixture backfill adds nothing");
    }

    /// Live smoke (C4 G6): every carp poller fetches from its real API into a memory state, then
    /// prints `CARP-LIVE sites=8 usgs=N nwps=N nws=N snapshots=N iem=N` (sites with readings,
    /// NWPS observations, gridpoint snapshots; snapshots overall; archive issuances).
    /// `cargo test --manifest-path api/Cargo.toml carp_live -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "network: calls the live USGS, NWPS, NWS and IEM APIs"]
    async fn carp_live_fetch_and_ingest() {
        use crate::ingest::scheduler::ingest_payload;
        use crate::ingest::source::FetchCtx;
        let mut config = Config::for_tests();
        config.user_agent = Config::from_env().user_agent;
        config.usgs_api_key = Config::from_env().usgs_api_key;
        let state = crate::state::AppState::memory(config.clone(), App::builtin("carp").unwrap());
        let mut failures = Vec::new();
        // The archive over 7 days (the data proof's window), not the 30-day default.
        let mut sources = sources(&config, &state.app);
        sources.retain(|s| s.info().id != iem::SOURCE_ID);
        sources.push(Arc::new(iem::Iem::new(state.app.clone()).with_days(7)));
        for source in sources {
            let id = source.info().id;
            let ctx = FetchCtx { state: &state, cursor: None };
            let payloads = match source.fetch(&ctx).await {
                Ok(p) if !p.is_empty() => p,
                Ok(_) => {
                    failures.push(format!("{id}: first fetch returned nothing"));
                    continue;
                }
                Err(e) => {
                    failures.push(format!("{id}: fetch: {e:#}"));
                    continue;
                }
            };
            let (mut rows_in, mut written, mut skipped, mut bytes) = (0, 0, 0, 0);
            for raw in payloads.clone() {
                bytes += raw.bytes.len();
                let out = ingest_payload(&state, source.as_ref(), raw, None).await.unwrap();
                if let Some(e) = &out.error {
                    failures.push(format!("{id}: {e}"));
                }
                rows_in += out.rows_in;
                written += out.rows_written;
                skipped += out.rows_skipped;
            }
            println!("{id}: {} payloads, {bytes} bytes, {rows_in} rows, {written} written, {skipped} skipped", payloads.len());
        }
        let (usgs, nwps, nws, snapshots, iem): (i64, i64, i64, i64, i64) = state
            .obs
            .read(|c| {
                c.query_row(
                    "select (select count(distinct s.ext_id) from stations s join readings r on r.station_id = s.id where s.source_id = 'usgs' and s.kind = 'gage'),
                            (select count(distinct site) from forecast_observations where source = 'nwps-live'),
                            (select count(distinct site) from forecast_snapshots where source = 'nws-gridpoint'),
                            (select count(*) from forecast_snapshots),
                            (select count(*) from forecast_snapshots where source = 'iem-archive')",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
            })
            .await
            .unwrap();
        println!("CARP-LIVE sites={} usgs={usgs} nwps={nwps} nws={nws} snapshots={snapshots} iem={iem}", state.app.cfg.locations.len());
        assert!(failures.is_empty(), "{failures:#?}");
    }

    /// Live smoke test: every poller fetches from its real API and the payloads ingest cleanly.
    /// `cargo test --manifest-path api/Cargo.toml live_physical -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "network: calls the five live upstream APIs"]
    async fn live_physical_fetch_and_ingest() {
        use crate::ingest::scheduler::ingest_payload;
        use crate::ingest::source::FetchCtx;
        let mut config = Config::for_tests();
        config.user_agent = Config::from_env().user_agent;
        let state = crate::state::AppState::memory(config.clone(), App::builtin("python").unwrap());
        // Every source runs even when an earlier one fails (upstreams are flaky); failures are
        // collected and reported together.
        let mut failures = Vec::new();
        for source in sources(&config, &state.app) {
            let id = source.info().id;
            let ctx = FetchCtx { state: &state, cursor: None };
            let payloads = match source.fetch(&ctx).await {
                Ok(p) if !p.is_empty() => p,
                Ok(_) => {
                    failures.push(format!("{id}: first fetch returned nothing"));
                    continue;
                }
                Err(e) => {
                    failures.push(format!("{id}: fetch: {e:#}"));
                    continue;
                }
            };
            let (mut rows_in, mut written, mut bytes) = (0, 0, 0);
            for raw in payloads.clone() {
                bytes += raw.bytes.len();
                let out = ingest_payload(&state, source.as_ref(), raw, None).await.unwrap();
                assert!(out.error.is_none(), "{id}: {out:?}");
                rows_in += out.rows_in;
                written += out.rows_written;
            }
            let again = source.fetch(&ctx).await.map(|p| p.len().to_string()).unwrap_or_else(|e| format!("error {e:#}"));
            println!("{id}: {} payloads, {bytes} bytes, {rows_in} rows, {written} written; second fetch: {again} payloads", payloads.len());
        }
        assert!(failures.is_empty(), "{failures:#?}");
    }

    #[test]
    fn missing_values_are_flagged_not_dropped() {
        let st = StationRef { ext_id: "X".into(), name: "X".into(), lat: 25.0, lon: -80.0, kind: crate::model::StationKind::Buoy };
        match reading(&st, Param::AirC, Some(f64::NAN), 1, Origin::Measured) {
            Row::Reading(r) => assert_eq!((r.value, r.flag), (None, Flag::Missing)),
            other => panic!("{other:?}"),
        }
        match reading(&st, Param::AirC, Some(21.5), 1, Origin::Measured) {
            Row::Reading(r) => assert_eq!((r.value, r.flag), (Some(21.5), Flag::Ok)),
            other => panic!("{other:?}"),
        }
    }
}
