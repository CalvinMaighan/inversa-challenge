//! NWS gridpoint forecast per carp site (leaf C4; docs/ingest-modes.md C6; precipitation added
//! for gates/leaf-FX.md): hourly poll of two documents per `locations[].nwsGrid`, both versioned
//! on `properties.updateTime` (per office run, so the five LCH sites usually share one value;
//! `generatedAt` is the request time and never used):
//!
//! - `gridpoints/{office}/{x},{y}/forecast`, the 12 h periods: one `Row::ForecastSnapshot`
//!   (`product = gridpoint`, `source = nws-gridpoint`, `issued_at = updateTime`), whose points
//!   carry the period start times only (stage and flow are null: this is weather, not river),
//!   so the forecast store versions the run and the raw payload keeps the text; plus modeled
//!   readings at a `grid` station named by the lid, `observed_at` = period start: `air_c`
//!   (period temperature, °F converted), `wind_ms` (the upper bound of "5 to 10 mph") and
//!   `pop_pct` (the period's probability of precipitation, a percentage, not a depth);
//! - `gridpoints/{office}/{x},{y}`, the raw grid: `rain_mm` from `quantitativePrecipitation`
//!   (the amount NWS gives for the window that starts at `observed_at`, 6 h at the grid's native
//!   resolution, mm as published) and `wind_gust_ms` from `windGust` (km/h converted, one reading
//!   per hour of each value's window). No snapshot: the periods document is the run's record.
//!
//! A document whose `updateTime` did not change since the last committed poll (the cursor, a
//! JSON map of lid and `<lid>:grid` to updateTime) is not emitted. Period and window times carry
//! their offset (`-05:00` in CDT, `+00:00` on the grid) and are stored as UTC. `User-Agent` is
//! required by api.weather.gov; the rate limit is unpublished, 16 requests an hour is nothing.

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
const KMH_TO_MS: f64 = 1.0 / 3.6;
const HOUR_MS: i64 = 3_600_000;
/// The raw grid's native precipitation window: `quantitativePrecipitation` values are 6-hourly
/// amounts (the first window of a run can be shorter).
#[cfg(test)]
pub const QPF_WINDOW_MS: i64 = 6 * HOUR_MS;

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
    /// The 12 h periods document.
    pub fn url(&self) -> String {
        format!("{}/forecast", self.grid_url())
    }

    /// The raw grid (precipitation amounts, gusts).
    pub fn grid_url(&self) -> String {
        format!("{API}/{}/{},{}", self.office, self.x, self.y)
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

/// ISO 8601 duration as the NWS grid writes it (`PT6H`, `P1DT2H`, `PT30M`) to ms. Whole numbers
/// only; weeks and fractions are not used by the grid.
pub fn iso_duration_ms(s: &str) -> Option<i64> {
    let rest = s.strip_prefix('P')?;
    let (date, time) = rest.split_once('T').unwrap_or((rest, ""));
    let mut ms = 0i64;
    for (part, unit_ms) in [(date, [('D', 86_400_000i64)].as_slice()), (time, [('H', HOUR_MS), ('M', 60_000), ('S', 1000)].as_slice())] {
        let mut num = String::new();
        for ch in part.chars() {
            if ch.is_ascii_digit() {
                num.push(ch);
                continue;
            }
            let n: i64 = num.parse().ok()?;
            num.clear();
            ms += n * unit_ms.iter().find(|(u, _)| *u == ch)?.1;
        }
        if !num.is_empty() {
            return None;
        }
    }
    (ms > 0).then_some(ms)
}

/// A grid value's `validTime` (`2026-10-01T06:00:00+00:00/PT6H`) to (start ms, duration ms).
pub fn parse_valid_time(s: &str) -> Option<(i64, i64)> {
    let (start, dur) = s.split_once('/')?;
    Some((parse_rfc3339_ms(start)?, iso_duration_ms(dur)?))
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

    /// The sites a request URL (periods or raw grid) was made for (several sites may share a
    /// grid cell).
    fn sites_of(&self, url: &str) -> Vec<&GridSite> {
        self.sites.iter().filter(|s| s.url() == url || s.grid_url() == url).collect()
    }
}

/// Which of the two documents a URL is.
fn is_periods(url: &str) -> bool {
    url.ends_with("/forecast")
}

/// Cursor key of a site's document: `<lid>` for the periods, `<lid>:grid` for the raw grid.
fn cursor_key(lid: &str, url: &str) -> String {
    if is_periods(url) {
        lid.to_string()
    } else {
        format!("{lid}:grid")
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
        let mut urls: Vec<String> = self.sites.iter().flat_map(|s| [s.url(), s.grid_url()]).collect();
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
            let keys: Vec<String> = self.sites_of(url).iter().map(|s| cursor_key(&s.lid, url)).collect();
            if keys.iter().all(|k| cursor.get(k) == Some(&update_time)) {
                tracing::debug!(source = SOURCE_ID, url, "updateTime unchanged, not stored again");
                continue;
            }
            for key in keys {
                cursor.insert(key, update_time.clone());
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
            rows.extend(if is_periods(&raw.source_url) { normalize_forecast(site, &doc, raw.fetched_at)? } else { normalize_grid(site, &doc)? });
        }
        Ok(rows)
    }
}

fn grid_station(site: &GridSite) -> StationRef {
    StationRef { ext_id: site.lid.clone(), name: format!("NWS forecast, {}", site.name), lat: site.lat, lon: site.lon, kind: StationKind::Grid }
}

/// Pure: one 12 h periods document to a site's snapshot and modeled readings (air, wind, PoP).
pub fn normalize_forecast(site: &GridSite, doc: &Value, fetched_at: i64) -> anyhow::Result<Vec<Row>> {
    let p = &doc["properties"];
    let update_time = p["updateTime"].as_str().context("nws forecast: no properties.updateTime")?;
    let issued_at = parse_rfc3339_ms(update_time).with_context(|| format!("nws forecast: updateTime {update_time:?}"))?;
    let periods = p["periods"].as_array().context("nws forecast: no periods")?;
    let station = grid_station(site);
    let mut points = Vec::with_capacity(periods.len());
    let mut rows = Vec::with_capacity(periods.len() * 3 + 1);
    for per in periods {
        let Some(start) = per["startTime"].as_str().and_then(parse_rfc3339_ms) else { continue };
        points.push(Point { valid_at: start, stage_ft: None, flow_kcfs: None });
        let temp = per["temperature"].as_f64().map(|t| if per["temperatureUnit"].as_str() == Some("F") { (t - 32.0) * 5.0 / 9.0 } else { t });
        rows.push(reading(&station, Param::AirC, temp, start, Origin::Modeled));
        rows.push(reading(&station, Param::WindMs, per["windSpeed"].as_str().and_then(wind_ms), start, Origin::Modeled));
        // A null value is NWS's "no chance stated"; stored as a missing reading, never as 0.
        rows.push(reading(&station, Param::PopPct, per["probabilityOfPrecipitation"]["value"].as_f64(), start, Origin::Modeled));
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

/// A raw grid layer's `values` as (start ms, duration ms, value), in order; `uom` checked
/// against `expect` (NWS publishes one unit per layer; a different one is an error, never a
/// silent misread).
fn grid_layer(p: &Value, layer: &str, expect: &str) -> anyhow::Result<Vec<(i64, i64, Option<f64>)>> {
    let l = &p[layer];
    let uom = l["uom"].as_str().unwrap_or("");
    anyhow::ensure!(uom == expect, "nws grid: {layer} in {uom:?}, expected {expect:?}");
    let values = l["values"].as_array().with_context(|| format!("nws grid: no {layer}.values"))?;
    values
        .iter()
        .map(|v| {
            let vt = v["validTime"].as_str().unwrap_or("");
            let (start, dur) = parse_valid_time(vt).with_context(|| format!("nws grid: {layer} validTime {vt:?}"))?;
            Ok((start, dur, v["value"].as_f64()))
        })
        .collect()
}

/// Pure: one raw grid document to a site's modeled precipitation amounts and gusts.
pub fn normalize_grid(site: &GridSite, doc: &Value) -> anyhow::Result<Vec<Row>> {
    let p = &doc["properties"];
    anyhow::ensure!(p["updateTime"].is_string(), "nws grid: no properties.updateTime");
    let station = grid_station(site);
    let mut rows = Vec::new();
    // QPF: the amount for the window starting at `start`, as published (mm). The window is the
    // grid's 6 h resolution; a run's first window can be shorter (2 h, 4 h). Stored once at the
    // window start: a reader pairs windows by consecutive starts.
    for (start, _dur, value) in grid_layer(p, "quantitativePrecipitation", "wmoUnit:mm")? {
        rows.push(reading(&station, Param::RainMm, value, start, Origin::Modeled));
    }
    // Gusts are hourly values run-length encoded over equal hours: one reading per hour, so a
    // period's maximum gust is exact.
    for (start, dur, value) in grid_layer(p, "windGust", "wmoUnit:km_h-1")? {
        for h in 0..(dur / HOUR_MS).max(1) {
            rows.push(reading(&station, Param::WindGustMs, value.map(|v| v * KMH_TO_MS), start + h * HOUR_MS, Origin::Modeled));
        }
    }
    anyhow::ensure!(!rows.is_empty(), "nws grid: no precipitation or gust values");
    Ok(rows)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::app::test_support::test_state_for;
    use crate::ingest::poll::physical::testing::{fixture, recorded};
    use crate::ingest::scheduler::{ingest_payload, RunStatus};
    use crate::model::Flag;
    use crate::state::AppState;

    pub const LIDS: [&str; 8] = ["SMML1", "KRZL1", "BLRL1", "MCGL1", "BTRL1", "AEXL1", "MLUL1", "BXAL1"];
    /// 2026-10-01T15:06:42Z, when the fixtures were recorded.
    pub const RECORDED_AT: i64 = 1_790_867_202_000;

    fn adapter() -> NwsForecast {
        NwsForecast::new(&Config::for_tests(), Arc::new(App::builtin("carp").unwrap()))
    }

    /// The periods document of a site.
    pub fn payload(adapter: &NwsForecast, lid: &str) -> RawPayload {
        let site = adapter.sites().iter().find(|s| s.lid == lid).unwrap();
        recorded(&site.url(), "application/geo+json", fixture(&format!("nws_la/forecast/{lid}.json")), 200, RECORDED_AT)
    }

    /// The raw grid document of a site.
    pub fn grid_payload(adapter: &NwsForecast, lid: &str) -> RawPayload {
        let site = adapter.sites().iter().find(|s| s.lid == lid).unwrap();
        recorded(&site.grid_url(), "application/geo+json", fixture(&format!("nws_la/forecast/{lid}.grid.json")), 200, RECORDED_AT)
    }

    pub async fn ingest_all(state: &AppState) -> Vec<crate::ingest::scheduler::IngestOutcome> {
        let a = NwsForecast::new(&state.config, state.app.clone());
        let mut out = Vec::new();
        for lid in LIDS {
            out.push(ingest_payload(state, &a, payload(&a, lid), None).await.unwrap());
            out.push(ingest_payload(state, &a, grid_payload(&a, lid), None).await.unwrap());
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
        assert_eq!(krzl1.grid_url(), "https://api.weather.gov/gridpoints/LCH/115,111");
        let manifest: Value = serde_json::from_slice(&fixture("nws_la/forecast/manifest.json")).unwrap();
        let files = manifest["files"].as_array().unwrap();
        assert_eq!(files.len(), 16, "periods and raw grid per site");
        for (f, site) in files.chunks(2).zip(a.sites()) {
            assert_eq!(f[0]["url"].as_str().unwrap(), site.url(), "{}: the periods fixture was recorded from the configured grid", site.lid);
            assert_eq!(f[1]["url"].as_str().unwrap(), site.grid_url(), "{}: the raw grid fixture too", site.lid);
        }
        assert_eq!(a.info().cadence, Duration::from_secs(3600));
        assert_eq!(wind_ms("5 to 10 mph"), Some(10.0 * MPH_TO_MS));
        assert_eq!(wind_ms("10 mph"), Some(10.0 * MPH_TO_MS));
        assert_eq!(wind_ms("calm"), None);
        assert_eq!(parse_cursor(Some(r#"{"KRZL1":"2026-10-01T12:46:24+00:00"}"#)).get("KRZL1").map(String::as_str), Some("2026-10-01T12:46:24+00:00"));
        assert_eq!((cursor_key("KRZL1", &krzl1.url()), cursor_key("KRZL1", &krzl1.grid_url())), ("KRZL1".into(), "KRZL1:grid".into()));
        assert_eq!(iso_duration_ms("PT6H"), Some(6 * HOUR_MS));
        assert_eq!(iso_duration_ms("P1DT2H"), Some(26 * HOUR_MS));
        assert_eq!(iso_duration_ms("PT30M"), Some(30 * 60_000));
        assert_eq!(iso_duration_ms("P2D"), Some(48 * HOUR_MS));
        assert_eq!(iso_duration_ms("PT"), None);
        assert_eq!(iso_duration_ms("6H"), None);
        assert_eq!(iso_duration_ms("PT6"), None);
        assert_eq!(parse_valid_time("2026-10-01T06:00:00+00:00/PT6H"), Some((parse_rfc3339_ms("2026-10-01T06:00:00Z").unwrap(), QPF_WINDOW_MS)));
        assert_eq!(parse_valid_time("2026-10-01T06:00:00+00:00"), None);
    }

    /// One snapshot versioned on `updateTime` (shared by the LCH sites), period readings in
    /// stored units at UTC times, the period's rain chance as a percentage.
    #[test]
    fn nws_la_forecast_fixture_snapshot_and_period_readings() {
        let a = adapter();
        let rows = a.normalize(&payload(&a, "KRZL1")).unwrap();
        let Row::ForecastSnapshot(s) = &rows[0] else { panic!("{:?}", rows[0]) };
        assert_eq!((s.site.as_str(), s.product.as_str(), s.source), ("KRZL1", "gridpoint", ForecastSource::NwsGridpoint));
        assert_eq!(s.issued_at, parse_rfc3339_ms("2026-10-01T12:46:24+00:00").unwrap());
        assert_eq!(s.points.len(), 14);
        assert!(s.points.iter().all(|p| p.stage_ft.is_none() && p.flow_kcfs.is_none()));
        assert_eq!(rows.len(), 1 + 14 * 3);
        let Row::Reading(r) = &rows[1] else { panic!() };
        assert_eq!((r.station.ext_id.as_str(), r.station.kind, r.origin, r.param), ("KRZL1", StationKind::Grid, Origin::Modeled, Param::AirC));
        assert_eq!(r.observed_at, parse_rfc3339_ms("2026-10-01T10:00:00-05:00").unwrap(), "local offset to UTC");
        assert!((r.value.unwrap() - (92.0 - 32.0) * 5.0 / 9.0).abs() < 1e-9, "92 F");
        let Row::Reading(w) = &rows[2] else { panic!() };
        assert_eq!((w.param, w.value), (Param::WindMs, Some(10.0 * MPH_TO_MS)));
        let Row::Reading(pop) = &rows[3] else { panic!() };
        assert_eq!((pop.param, pop.value, pop.flag, pop.observed_at), (Param::PopPct, Some(47.0), Flag::Ok, r.observed_at), "percent, not a depth");
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
        assert_ne!(issued("MLUL1"), issued("KRZL1"));
        // The same run again is the same hash; a new run is a new version.
        let site = &a.sites()[1];
        let mut doc: Value = serde_json::from_slice(&fixture("nws_la/forecast/KRZL1.json")).unwrap();
        let hash = |rows: &[Row]| match &rows[0] {
            Row::ForecastSnapshot(s) => s.payload_hash.clone(),
            other => panic!("{other:?}"),
        };
        let h1 = hash(&normalize_forecast(site, &doc, RECORDED_AT).unwrap());
        assert_eq!(h1, hash(&normalize_forecast(site, &doc, RECORDED_AT + 1).unwrap()));
        doc["properties"]["updateTime"] = Value::from("2026-10-01T18:00:00+00:00");
        assert_ne!(h1, hash(&normalize_forecast(site, &doc, RECORDED_AT).unwrap()));
        // A period without a stated chance is a missing reading, never 0.
        doc["properties"]["periods"][0]["probabilityOfPrecipitation"]["value"] = Value::Null;
        let rows = normalize_forecast(site, &doc, RECORDED_AT).unwrap();
        let Row::Reading(pop) = &rows[3] else { panic!() };
        assert_eq!((pop.param, pop.value, pop.flag), (Param::PopPct, None, Flag::Missing));
        assert!(normalize_forecast(site, &serde_json::json!({"properties": {}}), RECORDED_AT).is_err());
    }

    /// The raw grid: QPF amounts in mm at their 6 h window starts (the first window of the LIX
    /// run is 2 h), gusts in m/s per hour; a wrong unit or a missing layer is an error.
    #[test]
    fn nws_la_grid_fixture_qpf_and_gusts() {
        let a = adapter();
        let rows = a.normalize(&grid_payload(&a, "KRZL1")).unwrap();
        let qpf: Vec<&crate::model::ReadingRow> = rows.iter().filter_map(|r| if let Row::Reading(r) = r { (r.param == Param::RainMm).then_some(r) } else { None }).collect();
        assert_eq!(qpf.len(), 32);
        assert!(qpf.iter().all(|r| r.station.ext_id == "KRZL1" && r.station.kind == StationKind::Grid && r.origin == Origin::Modeled));
        assert_eq!(qpf[0].observed_at, parse_rfc3339_ms("2026-10-01T06:00:00+00:00").unwrap());
        assert_eq!((qpf[0].value, qpf[0].flag), (Some(0.0), Flag::Ok), "a published 0 is a value, not a gap");
        assert_eq!(qpf[1].observed_at - qpf[0].observed_at, QPF_WINDOW_MS, "consecutive 6 h windows");
        let first_rain = qpf.iter().find(|r| r.value.is_some_and(|v| v > 0.0)).unwrap();
        assert_eq!((first_rain.observed_at, first_rain.value), (parse_rfc3339_ms("2026-10-01T18:00:00+00:00").unwrap(), Some(0.254)), "0.01 in as mm, as published");
        let gust: Vec<&crate::model::ReadingRow> = rows.iter().filter_map(|r| if let Row::Reading(r) = r { (r.param == Param::WindGustMs).then_some(r) } else { None }).collect();
        assert_eq!(gust[0].observed_at, parse_rfc3339_ms("2026-10-01T06:00:00+00:00").unwrap());
        assert!((gust[0].value.unwrap() - 24.076 * KMH_TO_MS).abs() < 1e-9, "km/h to m/s");
        assert_eq!(gust[1].observed_at - gust[0].observed_at, HOUR_MS, "a PT2H value is two hourly readings");
        assert_eq!(gust[1].value, gust[0].value);
        assert_eq!(gust.windows(2).filter(|w| w[1].observed_at - w[0].observed_at != HOUR_MS).count(), 0, "hourly without gaps");
        assert_eq!(rows.len(), qpf.len() + gust.len(), "nothing else from the grid");
        // The LIX run starts on a 2 h window.
        let rows = a.normalize(&grid_payload(&a, "BTRL1")).unwrap();
        let starts: Vec<i64> = rows.iter().filter_map(|r| if let Row::Reading(r) = r { (r.param == Param::RainMm).then_some(r.observed_at) } else { None }).collect();
        assert_eq!(starts[1] - starts[0], 2 * HOUR_MS);
        assert_eq!(starts[2] - starts[1], QPF_WINDOW_MS);
        // Units are checked, never assumed.
        let site = &a.sites()[1];
        let mut doc: Value = serde_json::from_slice(&fixture("nws_la/forecast/KRZL1.grid.json")).unwrap();
        doc["properties"]["quantitativePrecipitation"]["uom"] = Value::from("wmoUnit:in");
        assert!(normalize_grid(site, &doc).unwrap_err().to_string().contains("wmoUnit:in"));
        doc["properties"]["quantitativePrecipitation"]["uom"] = Value::from("wmoUnit:mm");
        doc["properties"]["windGust"] = Value::Null;
        assert!(normalize_grid(site, &doc).is_err());
        assert!(normalize_grid(site, &serde_json::json!({"properties": {}})).is_err());
    }

    /// Through the pipeline: 8 gridpoint snapshots and 8 grid stations with modeled readings
    /// from both documents; a second ingest writes nothing; a payload for an unconfigured grid
    /// fails to normalize.
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
        let a = NwsForecast::new(&state.config, state.app.clone());
        let expected: usize = LIDS
            .iter()
            .map(|lid| {
                a.normalize(&payload(&a, lid)).unwrap().iter().chain(a.normalize(&grid_payload(&a, lid)).unwrap().iter()).filter(|r| matches!(r, Row::Reading(_))).count()
            })
            .sum();
        assert_eq!(readings as usize, expected, "every modeled reading of both documents stored once");
        assert!(readings > 8 * 14 * 3 + 8 * 32, "{readings}");
        let per_param: Vec<(String, i64)> = state
            .obs
            .read(|c| {
                c.prepare("select r.param, count(*) from readings r join stations s on s.id = r.station_id where s.source_id = 'nws-forecast' group by 1 order by 1")?
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect()
            })
            .await
            .unwrap();
        assert_eq!(per_param.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(), ["air_c", "pop_pct", "rain_mm", "wind_gust_ms", "wind_ms"]);
        assert_eq!(per_param.iter().find(|(p, _)| p == "pop_pct").unwrap().1, 8 * 14);
        let again = ingest_all(&state).await;
        assert!(again.iter().all(|o| o.rows_written == 0), "{again:?}");
        let foreign = recorded("https://api.weather.gov/gridpoints/LCH/1,1/forecast", "application/geo+json", fixture("nws_la/forecast/KRZL1.json"), 200, RECORDED_AT);
        let out = ingest_payload(&state, &a, foreign, None).await.unwrap();
        assert_eq!(out.status, RunStatus::Error);
        assert!(out.error.unwrap().contains("not a configured grid"));
    }
}
