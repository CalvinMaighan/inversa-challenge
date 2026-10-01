//! NWS gridpoint forecast per carp site (leaf C4; docs/ingest-modes.md C6): hourly poll of
//! `gridpoints/{office}/{x},{y}/forecast` for every `locations[].nwsGrid`, versioned on
//! `properties.updateTime` (per office run, so the five LCH sites usually share one value;
//! `generatedAt` is the request time and never used). A grid whose `updateTime` did not change
//! since the last committed poll (the cursor, a JSON map per lid) is not emitted.
//!
//! Each payload becomes:
//! - one `Row::ForecastSnapshot` (`product = gridpoint`, `source = nws-gridpoint`,
//!   `issued_at = updateTime`), whose points carry the period start times only (stage and flow
//!   are null: this is weather, not river), so the forecast store versions the run and the raw
//!   payload keeps the text;
//! - modeled readings at a `grid` station named by the lid: `air_c` (period temperature, °F
//!   converted) and `wind_ms` (the upper bound of "5 to 10 mph"), `observed_at` = period start.
//!   Probability of precipitation is a percentage, not a depth, so no `rain_mm` row.
//!
//! Period times carry the local offset (`-05:00` in CDT) and are stored as UTC. `User-Agent`
//! is required by api.weather.gov; the rate limit is unpublished, 8 requests an hour is nothing.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use async_trait::async_trait;
use reqwest::header::{ACCEPT, USER_AGENT};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::app::config::App;
use crate::forecast::store::NewSnapshot;
use crate::forecast::{Point, Source as ForecastSource};
use crate::ingest::governor;
use crate::ingest::poll::physical::{self, parse_rfc3339_ms, reading};
use crate::ingest::source::{FetchCtx, Mode, RawPayload, Source, SourceInfo};
use crate::model::{Origin, Param, Row, StationKind, StationRef};
use crate::state::Config;

pub const SOURCE_ID: &str = "nws-forecast";
pub const API: &str = "https://api.weather.gov/gridpoints";
const POLITE_GAP: Duration = Duration::from_millis(300);
const MPH_TO_MS: f64 = 0.44704;

/// A site with its forecast grid.
#[derive(Debug, Clone, PartialEq)]
pub struct GridSite {
    pub lid: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    pub office: String,
    pub x: u32,
    pub y: u32,
}

impl GridSite {
    pub fn url(&self) -> String {
        format!("{API}/{}/{},{}/forecast", self.office, self.x, self.y)
    }
}

pub type Cursor = BTreeMap<String, String>;

pub fn parse_cursor(s: Option<&str>) -> Cursor {
    s.and_then(|c| serde_json::from_str(c).ok()).unwrap_or_default()
}

/// Wind speed text ("5 to 10 mph", "10 mph") to m/s, the upper bound.
pub fn wind_ms(text: &str) -> Option<f64> {
    let mph = text.split_whitespace().filter_map(|w| w.parse::<f64>().ok()).fold(None, |m: Option<f64>, v| Some(m.map_or(v, |m| m.max(v))))?;
    Some(mph * MPH_TO_MS)
}

pub struct NwsForecast {
    user_agent: String,
    sites: Vec<GridSite>,
}

impl NwsForecast {
    pub fn new(config: &Config, app: Arc<App>) -> Self {
        let sites = app
            .cfg
            .locations
            .iter()
            .filter_map(|l| {
                let g = l.nws_grid.as_ref()?;
                Some(GridSite { lid: l.nwps.clone()?, name: l.name.clone(), lat: l.lat, lon: l.lon, office: g.office.clone(), x: g.x, y: g.y })
            })
            .collect();
        NwsForecast { user_agent: config.user_agent.clone(), sites }
    }

    #[cfg(test)]
    pub fn sites(&self) -> &[GridSite] {
        &self.sites
    }

    /// The sites a request URL was made for (several sites may share a grid cell).
    fn sites_of(&self, url: &str) -> Vec<&GridSite> {
        self.sites.iter().filter(|s| s.url() == url).collect()
    }
}

#[async_trait]
impl Source for NwsForecast {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: SOURCE_ID,
            name: "NWS gridpoint forecast",
            homepage: "https://www.weather.gov/documentation/services-web-api",
            mode: Mode::Poll,
            cadence: Duration::from_secs(3600),
            // Runs were 0.6-6.5 h old at the data proof; half a day without one is stale.
            max_latency: Duration::from_secs(12 * 3600),
        }
    }

    async fn fetch(&self, ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
        let http = &ctx.state.http;
        let mut cursor = parse_cursor(ctx.cursor.as_deref());
        let mut out = Vec::new();
        let mut urls: Vec<String> = self.sites.iter().map(GridSite::url).collect();
        urls.dedup();
        for (i, url) in urls.iter().enumerate() {
            if i > 0 {
                tokio::time::sleep(POLITE_GAP).await;
            }
            let res = http.get(url).header(USER_AGENT, &self.user_agent).header(ACCEPT, "application/geo+json").send().await.context("nws forecast request")?;
            let res = governor::check_response(res)?;
            let status = res.status().as_u16();
            let content_type = physical::content_type(&res, "application/geo+json");
            let bytes = res.bytes().await.context("nws forecast body")?.to_vec();
            let doc: Value = serde_json::from_slice(&bytes).with_context(|| format!("nws forecast json for {url}"))?;
            let update_time = doc["properties"]["updateTime"].as_str().context("nws forecast: no updateTime")?.to_string();
            let lids: Vec<String> = self.sites_of(url).iter().map(|s| s.lid.clone()).collect();
            if lids.iter().all(|lid| cursor.get(lid) == Some(&update_time)) {
                tracing::debug!(source = SOURCE_ID, url, "updateTime unchanged, not stored again");
                continue;
            }
            for lid in lids {
                cursor.insert(lid, update_time.clone());
            }
            out.push(physical::payload(url, &content_type, bytes, status, None));
        }
        if let Some(last) = out.last_mut() {
            last.next_cursor = Some(serde_json::to_string(&cursor).expect("cursor json"));
        }
        Ok(out)
    }

    fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
        let sites = self.sites_of(&raw.source_url);
        anyhow::ensure!(!sites.is_empty(), "nws forecast: {} is not a configured grid", raw.source_url);
        let doc: Value = serde_json::from_slice(&raw.bytes).context("nws forecast json")?;
        let mut rows = Vec::new();
        for site in sites {
            rows.extend(normalize_forecast(site, &doc, raw.fetched_at)?);
        }
        Ok(rows)
    }
}

/// Pure: one gridpoint forecast body to a site's snapshot and modeled readings.
pub fn normalize_forecast(site: &GridSite, doc: &Value, fetched_at: i64) -> anyhow::Result<Vec<Row>> {
    let p = &doc["properties"];
    let update_time = p["updateTime"].as_str().context("nws forecast: no properties.updateTime")?;
    let issued_at = parse_rfc3339_ms(update_time).with_context(|| format!("nws forecast: updateTime {update_time:?}"))?;
    let periods = p["periods"].as_array().context("nws forecast: no periods")?;
    let station = StationRef { ext_id: site.lid.clone(), name: format!("NWS forecast, {}", site.name), lat: site.lat, lon: site.lon, kind: StationKind::Grid };
    let mut points = Vec::with_capacity(periods.len());
    let mut rows = Vec::with_capacity(periods.len() * 2 + 1);
    for per in periods {
        let Some(start) = per["startTime"].as_str().and_then(parse_rfc3339_ms) else { continue };
        points.push(Point { valid_at: start, stage_ft: None, flow_kcfs: None });
        let temp = per["temperature"].as_f64().map(|t| if per["temperatureUnit"].as_str() == Some("F") { (t - 32.0) * 5.0 / 9.0 } else { t });
        rows.push(reading(&station, Param::AirC, temp, start, Origin::Modeled));
        rows.push(reading(&station, Param::WindMs, per["windSpeed"].as_str().and_then(wind_ms), start, Origin::Modeled));
    }
    anyhow::ensure!(!points.is_empty(), "nws forecast: no periods with a start time");
    let mut h = Sha256::new();
    h.update(update_time.as_bytes());
    h.update(serde_json::to_string(&p["periods"]).expect("json").as_bytes());
    rows.insert(
        0,
        Row::ForecastSnapshot(NewSnapshot {
            site: site.lid.clone(),
            product: "gridpoint".into(),
            issued_at,
            ingested_at: fetched_at,
            source: ForecastSource::NwsGridpoint,
            payload_hash: hex::encode(h.finalize()),
            points,
        }),
    );
    Ok(rows)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::app::test_support::test_state_for;
    use crate::ingest::poll::physical::testing::{fixture, recorded};
    use crate::ingest::scheduler::{ingest_payload, RunStatus};
    use crate::state::AppState;

    pub const LIDS: [&str; 8] = ["SMML1", "KRZL1", "BLRL1", "MCGL1", "BTRL1", "AEXL1", "MLUL1", "BXAL1"];
    /// 2026-10-01T07:01:03Z, when the fixtures were recorded.
    pub const RECORDED_AT: i64 = 1_790_838_063_000;

    fn adapter() -> NwsForecast {
        NwsForecast::new(&Config::for_tests(), Arc::new(App::builtin("carp").unwrap()))
    }

    pub fn payload(adapter: &NwsForecast, lid: &str) -> RawPayload {
        let site = adapter.sites().iter().find(|s| s.lid == lid).unwrap();
        recorded(&site.url(), "application/geo+json", fixture(&format!("nws_la/forecast/{lid}.json")), 200, RECORDED_AT)
    }

    pub async fn ingest_all(state: &AppState) -> Vec<crate::ingest::scheduler::IngestOutcome> {
        let a = NwsForecast::new(&state.config, state.app.clone());
        let mut out = Vec::new();
        for lid in LIDS {
            out.push(ingest_payload(state, &a, payload(&a, lid), None).await.unwrap());
        }
        out
    }

    #[test]
    fn nws_la_forecast_grids_from_config() {
        let a = adapter();
        assert_eq!(a.sites().len(), 8);
        let krzl1 = &a.sites()[1];
        assert_eq!((krzl1.lid.as_str(), krzl1.office.as_str(), krzl1.x, krzl1.y), ("KRZL1", "LCH", 115, 111));
        assert_eq!(krzl1.url(), "https://api.weather.gov/gridpoints/LCH/115,111/forecast");
        let manifest: Value = serde_json::from_slice(&fixture("nws_la/forecast/manifest.json")).unwrap();
        for (f, site) in manifest["files"].as_array().unwrap().iter().zip(a.sites()) {
            assert_eq!(f["url"].as_str().unwrap(), site.url(), "{}: the fixture was recorded from the configured grid", site.lid);
        }
        assert_eq!(a.info().cadence, Duration::from_secs(3600));
        assert_eq!(wind_ms("5 to 10 mph"), Some(10.0 * MPH_TO_MS));
        assert_eq!(wind_ms("10 mph"), Some(10.0 * MPH_TO_MS));
        assert_eq!(wind_ms("calm"), None);
        assert_eq!(parse_cursor(Some(r#"{"KRZL1":"2026-10-01T06:50:35+00:00"}"#)).get("KRZL1").map(String::as_str), Some("2026-10-01T06:50:35+00:00"));
    }

    /// One snapshot versioned on `updateTime` (shared by the LCH sites), period readings in
    /// stored units at UTC times.
    #[test]
    fn nws_la_forecast_fixture_snapshot_and_period_readings() {
        let a = adapter();
        let rows = a.normalize(&payload(&a, "KRZL1")).unwrap();
        let Row::ForecastSnapshot(s) = &rows[0] else { panic!("{:?}", rows[0]) };
        assert_eq!((s.site.as_str(), s.product.as_str(), s.source), ("KRZL1", "gridpoint", ForecastSource::NwsGridpoint));
        assert_eq!(s.issued_at, parse_rfc3339_ms("2026-10-01T06:50:35+00:00").unwrap());
        assert_eq!(s.points.len(), 14);
        assert!(s.points.iter().all(|p| p.stage_ft.is_none() && p.flow_kcfs.is_none()));
        assert_eq!(rows.len(), 1 + 14 * 2);
        let Row::Reading(r) = &rows[1] else { panic!() };
        assert_eq!((r.station.ext_id.as_str(), r.station.kind, r.origin, r.param), ("KRZL1", StationKind::Grid, Origin::Modeled, Param::AirC));
        assert_eq!(r.observed_at, parse_rfc3339_ms("2026-10-01T02:00:00-05:00").unwrap(), "local offset to UTC");
        assert!((r.value.unwrap() - (73.0 - 32.0) * 5.0 / 9.0).abs() < 1e-9, "73 F");
        let Row::Reading(w) = &rows[2] else { panic!() };
        assert_eq!((w.param, w.value), (Param::WindMs, Some(5.0 * MPH_TO_MS)));
        // Every LCH site shares the office run's updateTime; LIX and SHV have their own.
        let issued = |lid: &str| match &a.normalize(&payload(&a, lid)).unwrap()[0] {
            Row::ForecastSnapshot(s) => s.issued_at,
            other => panic!("{other:?}"),
        };
        for lid in ["SMML1", "BLRL1", "MCGL1", "AEXL1"] {
            assert_eq!(issued(lid), issued("KRZL1"), "{lid}");
        }
        assert_ne!(issued("BTRL1"), issued("KRZL1"));
        assert_eq!(issued("BTRL1"), issued("BXAL1"));
        // The same run again is the same hash; a new run is a new version.
        let site = &a.sites()[1];
        let mut doc: Value = serde_json::from_slice(&fixture("nws_la/forecast/KRZL1.json")).unwrap();
        let hash = |rows: &[Row]| match &rows[0] {
            Row::ForecastSnapshot(s) => s.payload_hash.clone(),
            other => panic!("{other:?}"),
        };
        let h1 = hash(&normalize_forecast(site, &doc, RECORDED_AT).unwrap());
        assert_eq!(h1, hash(&normalize_forecast(site, &doc, RECORDED_AT + 1).unwrap()));
        doc["properties"]["updateTime"] = Value::from("2026-10-01T08:00:00+00:00");
        assert_ne!(h1, hash(&normalize_forecast(site, &doc, RECORDED_AT).unwrap()));
        assert!(normalize_forecast(site, &serde_json::json!({"properties": {}}), RECORDED_AT).is_err());
    }

    /// Through the pipeline: 8 gridpoint snapshots and 8 grid stations with modeled readings;
    /// a second ingest writes nothing; a payload for an unconfigured grid fails to normalize.
    #[tokio::test]
    async fn nws_la_forecast_ingest_idempotent() {
        let state = test_state_for("carp");
        let first = ingest_all(&state).await;
        assert!(first.iter().all(|o| o.status == RunStatus::Ok && o.rows_skipped == 0), "{first:?}");
        let (snaps, stations, readings): (i64, i64, i64) = state
            .obs
            .read(|c| {
                c.query_row(
                    "select (select count(*) from forecast_snapshots where source = 'nws-gridpoint' and product = 'gridpoint'),
                            (select count(*) from stations where source_id = 'nws-forecast'),
                            (select count(*) from readings r join stations s on s.id = r.station_id where s.source_id = 'nws-forecast' and r.origin = 'modeled')",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
            })
            .await
            .unwrap();
        assert_eq!((snaps, stations), (8, 8));
        assert_eq!(readings, 8 * 14 * 2);
        let again = ingest_all(&state).await;
        assert!(again.iter().all(|o| o.rows_written == 0), "{again:?}");
        let a = NwsForecast::new(&state.config, state.app.clone());
        let foreign = recorded("https://api.weather.gov/gridpoints/LCH/1,1/forecast", "application/geo+json", fixture("nws_la/forecast/KRZL1.json"), 200, RECORDED_AT);
        let out = ingest_payload(&state, &a, foreign, None).await.unwrap();
        assert_eq!(out.status, RunStatus::Error);
        assert!(out.error.unwrap().contains("not a configured grid"));
    }
}
