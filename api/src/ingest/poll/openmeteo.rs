//! Open-Meteo forecast and marine models (T8, PRD §2), hourly, on a 0.25° grid over every
//! region of the app (the python region: 13 rows x 14 columns = 182 points), one request per
//! API with comma-separated coordinates.
//!
//! - Forecast: `temperature_2m` (air_c), `precipitation` (rain_mm), `wind_speed_10m` (wind_ms,
//!   requested in m/s), yesterday plus 48 h ahead.
//! - Marine: `wave_height` (wave_m), `sea_surface_temperature` (sst_c). Land points return
//!   nulls; the first marine poll asks for every point and learns the sea mask, later polls ask
//!   only for sea points (re-learned daily). That keeps the two APIs near 7,400 location-calls a
//!   day, under the free tier's 10,000.
//!
//! All rows are `origin = modeled`, station kind `grid`, `ext_id` = "lat,lon" of the requested
//! point (3 decimals; Open-Meteo snaps to its own model cell, reported separately in the body).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Context;
use async_trait::async_trait;
use serde_json::Value;

use crate::app::config::App;
use crate::ingest::governor;
use crate::ingest::poll::physical::{self, reading, BBox};
use crate::ingest::source::{FetchCtx, Mode, RawPayload, Source, SourceInfo};
use crate::model::{ForecastRow, Origin, Param, Row, StationKind, StationRef};

pub const FORECAST_URL: &str = "https://api.open-meteo.com/v1/forecast";
pub const MARINE_URL: &str = "https://marine-api.open-meteo.com/v1/marine";
pub const STEP_DEG: f64 = 0.25;
const MASK_TTL: Duration = Duration::from_secs(24 * 3600);

const FORECAST_VARS: [(&str, Param); 3] =
    [("temperature_2m", Param::AirC), ("precipitation", Param::RainMm), ("wind_speed_10m", Param::WindMs)];
const MARINE_VARS: [(&str, Param); 2] = [("wave_height", Param::WaveM), ("sea_surface_temperature", Param::SstC)];

/// Grid cell centres over every region, region by region, south-west first, row-major.
pub fn grid(regions: &[BBox]) -> Vec<(f64, f64)> {
    // Every cell centre inside the box (the last row/column may be a partial cell).
    let centres = |from: f64, to: f64| -> Vec<f64> {
        (0..).map(|i| round3(from + STEP_DEG * (i as f64 + 0.5))).take_while(|v| *v <= to).collect()
    };
    let mut out = Vec::new();
    for r in regions {
        let lats = centres(r.south, r.north);
        let lons = centres(r.west, r.east);
        out.extend(lats.iter().flat_map(|lat| lons.iter().map(move |lon| (*lat, *lon))));
    }
    out
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

fn coord_list(points: &[(f64, f64)]) -> (String, String) {
    let lats: Vec<String> = points.iter().map(|(lat, _)| format!("{lat:.3}")).collect();
    let lons: Vec<String> = points.iter().map(|(_, lon)| format!("{lon:.3}")).collect();
    (lats.join(","), lons.join(","))
}

pub fn forecast_url(points: &[(f64, f64)]) -> String {
    let (lat, lon) = coord_list(points);
    format!(
        "{FORECAST_URL}?latitude={lat}&longitude={lon}&hourly=temperature_2m,precipitation,wind_speed_10m\
         &wind_speed_unit=ms&timeformat=unixtime&timezone=GMT&past_days=1&forecast_days=2"
    )
}

pub fn marine_url(points: &[(f64, f64)]) -> String {
    let (lat, lon) = coord_list(points);
    format!(
        "{MARINE_URL}?latitude={lat}&longitude={lon}&hourly=wave_height,sea_surface_temperature\
         &timeformat=unixtime&timezone=GMT&past_days=1&forecast_days=2&cell_selection=nearest"
    )
}

/// Requested points, recovered from a request URL.
pub fn points_from_url(url: &str) -> anyhow::Result<Vec<(f64, f64)>> {
    let query = url.split_once('?').map(|(_, q)| q).context("openmeteo: url has no query")?;
    let list = |key: &str| -> anyhow::Result<Vec<f64>> {
        let raw = query
            .split('&')
            .find_map(|kv| kv.strip_prefix(key).and_then(|v| v.strip_prefix('=')))
            .with_context(|| format!("openmeteo: {key} in url"))?;
        raw.split(',').map(|v| v.parse::<f64>().with_context(|| format!("openmeteo: {key} value {v:?}"))).collect()
    };
    let (lats, lons) = (list("latitude")?, list("longitude")?);
    anyhow::ensure!(lats.len() == lons.len(), "openmeteo: {} latitudes vs {} longitudes", lats.len(), lons.len());
    Ok(lats.into_iter().zip(lons).collect())
}

struct SeaMask {
    sea: Vec<(f64, f64)>,
    learned: Instant,
}

pub struct OpenMeteo {
    regions: Vec<BBox>,
    sea: Mutex<Option<SeaMask>>,
}

impl OpenMeteo {
    pub fn new(app: Arc<App>) -> Self {
        OpenMeteo { regions: physical::region_boxes(&app), sea: Mutex::new(None) }
    }
}

async fn get(http: &reqwest::Client, url: &str) -> anyhow::Result<RawPayload> {
    let res = http.get(url).send().await.context("openmeteo request")?;
    let res = governor::check_response(res)?;
    let status = res.status().as_u16();
    let content_type = physical::content_type(&res, "application/json");
    let bytes = res.bytes().await.context("openmeteo body")?.to_vec();
    Ok(physical::payload(url, &content_type, bytes, status, None))
}

#[async_trait]
impl Source for OpenMeteo {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: "openmeteo",
            name: "Open-Meteo forecast + marine",
            homepage: "https://open-meteo.com/",
            mode: Mode::Poll,
            cadence: Duration::from_secs(3600),
            max_latency: Duration::from_secs(3 * 3600),
        }
    }

    async fn fetch(&self, ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
        let http = &ctx.state.http;
        let all = grid(&self.regions);
        let forecast = get(http, &forecast_url(&all)).await?;

        let known_sea = {
            let mask = self.sea.lock().expect("sea mask");
            mask.as_ref().filter(|m| m.learned.elapsed() < MASK_TTL).map(|m| m.sea.clone())
        };
        let marine = match get(http, &marine_url(known_sea.as_deref().unwrap_or(&all))).await {
            Ok(raw) => {
                if known_sea.is_none() {
                    match sea_points(&raw) {
                        // An all-null answer (upstream trouble) must not become an empty mask.
                        Ok(sea) if sea.is_empty() => tracing::warn!(source = "openmeteo", "no sea points in marine response"),
                        Ok(sea) => *self.sea.lock().expect("sea mask") = Some(SeaMask { sea, learned: Instant::now() }),
                        Err(e) => tracing::warn!(source = "openmeteo", "sea mask: {e:#}"),
                    }
                }
                Some(raw)
            }
            // The forecast still lands; the marine failure is logged and retried next hour.
            Err(e) => {
                tracing::warn!(source = "openmeteo", "marine fetch failed: {e:#}");
                None
            }
        };
        Ok(std::iter::once(forecast).chain(marine).collect())
    }

    fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
        normalize_payload(raw)
    }
}

/// Points of a marine response with any non-null value.
fn sea_points(raw: &RawPayload) -> anyhow::Result<Vec<(f64, f64)>> {
    let points = points_from_url(&raw.source_url)?;
    let body = locations(&raw.bytes)?;
    anyhow::ensure!(body.len() == points.len(), "openmeteo: {} locations for {} points", body.len(), points.len());
    Ok(points.into_iter().zip(&body).filter(|(_, loc)| has_values(loc, &MARINE_VARS)).map(|(p, _)| p).collect())
}

/// A multi-location response is an array; a single location is a bare object.
fn locations(bytes: &[u8]) -> anyhow::Result<Vec<Value>> {
    let doc: Value = serde_json::from_slice(bytes).context("openmeteo json")?;
    if let Some(reason) = doc.get("reason").and_then(Value::as_str).filter(|_| doc["error"].as_bool() == Some(true)) {
        anyhow::bail!("openmeteo error: {reason}");
    }
    Ok(match doc {
        Value::Array(items) => items,
        obj @ Value::Object(_) => vec![obj],
        other => anyhow::bail!("openmeteo: unexpected body {other}"),
    })
}

fn has_values(loc: &Value, vars: &[(&str, Param)]) -> bool {
    vars.iter().any(|(name, _)| loc["hourly"][*name].as_array().is_some_and(|vs| vs.iter().any(|v| v.is_number())))
}

pub fn normalize_payload(raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
    let marine = raw.source_url.starts_with(MARINE_URL);
    let vars: &[(&str, Param)] = if marine { &MARINE_VARS } else { &FORECAST_VARS };
    let points = points_from_url(&raw.source_url)?;
    let body = locations(&raw.bytes)?;
    anyhow::ensure!(body.len() == points.len(), "openmeteo: {} locations for {} requested points", body.len(), points.len());

    let mut rows = Vec::new();
    for ((lat, lon), loc) in points.into_iter().zip(&body) {
        // Land cell in the marine model: not a marine grid point at all.
        if marine && !has_values(loc, vars) {
            continue;
        }
        let hourly = &loc["hourly"];
        let times: Vec<i64> = hourly["time"].as_array().map(|t| t.iter().filter_map(Value::as_i64).map(|s| s * 1000).collect()).unwrap_or_default();
        let station = StationRef {
            ext_id: format!("{lat:.3},{lon:.3}"),
            name: format!("Open-Meteo grid {lat:.3},{lon:.3}"),
            lat,
            lon,
            kind: StationKind::Grid,
        };
        for (name, param) in vars {
            let Some(values) = hourly[*name].as_array() else { continue };
            let unit = loc["hourly_units"][*name].as_str().unwrap_or_default();
            let scale = if *param == Param::WindMs && unit == "km/h" { 1.0 / 3.6 } else { 1.0 };
            for (i, at) in times.iter().enumerate() {
                let value = values.get(i).and_then(Value::as_f64).map(|v| v * scale);
                rows.push(reading(&station, *param, value, *at, Origin::Modeled));
            }
        }
    }
    Ok(rows)
}

// ---------------------------------------------------------------------------------------------
// Open-Meteo Marine for Lionfish Watch (`openmeteo-marine`, L4)
// ---------------------------------------------------------------------------------------------
//
// Waves (`wave_height`, `wave_period`) from one wave model and currents
// (`ocean_current_velocity`, `ocean_current_direction`) from one current model, each requested
// with `models=` so every value has one known model run. Per region one request per model on a
// `stepDeg` grid, `forecast_hours` ahead (72 h). Currents arrive in km/h and are stored in m/s;
// `marine_forecasts` records both units.
//
// Gate: every `metaCheckMinutes` the poller reads both models' `meta.json`; data is fetched only
// for a model whose `last_run_initialisation_time` differs from the cursor, so a run is read
// once (MF wave runs every 12 h, MF currents every 24 h). An unchanged gate returns no payload
// (an `empty` fetch run). The run time rides on the stored source URL as `#issued=<unix s>`, so
// `normalize` stays a pure function of the payload.

pub const MARINE_SOURCE_ID: &str = "openmeteo-marine";
const MARINE_DATA_HOST: &str = "https://marine-api.open-meteo.com/data/";

/// The Lionfish Watch marine feed's settings (`feeds[openmeteo-marine].params`).
#[derive(Debug, Clone, PartialEq)]
pub struct MarineCfg {
    pub step_deg: f64,
    pub forecast_hours: u32,
    pub wave_model: String,
    pub current_model: String,
    pub meta_check: Duration,
}

pub fn marine_cfg(app: &App) -> MarineCfg {
    let p = app.cfg.feed(MARINE_SOURCE_ID).map(|f| f.params.clone()).unwrap_or_default();
    let s = |k: &str, d: &str| p.get(k).and_then(Value::as_str).unwrap_or(d).to_string();
    MarineCfg {
        step_deg: p.get("stepDeg").and_then(Value::as_f64).filter(|v| *v > 0.0).unwrap_or(0.5),
        forecast_hours: p.get("forecastHours").and_then(Value::as_u64).filter(|v| *v > 0).unwrap_or(72) as u32,
        wave_model: s("waveModel", "meteofrance_wave"),
        current_model: s("currentModel", "meteofrance_currents"),
        meta_check: Duration::from_secs(p.get("metaCheckMinutes").and_then(Value::as_u64).filter(|v| *v > 0).unwrap_or(15) * 60),
    }
}

pub fn meta_url(model: &str) -> String {
    format!("{MARINE_DATA_HOST}{model}/static/meta.json")
}

/// Cell centres of one region at `step` degrees, south-west first, row-major.
pub fn marine_grid(r: &BBox, step: f64) -> Vec<(f64, f64)> {
    let centres = |from: f64, to: f64| -> Vec<f64> {
        (0..).map(|i| round3(from + step * (i as f64 + 0.5))).take_while(|v| *v <= to).collect()
    };
    let lats = centres(r.south, r.north);
    let lons = centres(r.west, r.east);
    lats.iter().flat_map(|lat| lons.iter().map(move |lon| (*lat, *lon))).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarineKind {
    Wave,
    Current,
}

impl MarineKind {
    fn vars(self) -> &'static str {
        match self {
            MarineKind::Wave => "wave_height,wave_period",
            MarineKind::Current => "ocean_current_velocity,ocean_current_direction",
        }
    }
}

/// One marine data request. The fragment carries the model run (unix seconds) for `normalize`.
pub fn marine_data_url(points: &[(f64, f64)], kind: MarineKind, model: &str, hours: u32, issued_s: i64) -> String {
    let (lat, lon) = coord_list(points);
    format!(
        "{MARINE_URL}?latitude={lat}&longitude={lon}&hourly={}&models={model}&timeformat=unixtime&timezone=GMT\
         &forecast_hours={hours}&cell_selection=nearest#issued={issued_s}",
        kind.vars()
    )
}

/// `meta.json`: the run the model currently serves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
pub struct ModelMeta {
    /// Unix seconds.
    pub last_run_initialisation_time: i64,
    pub last_run_availability_time: i64,
}

pub fn parse_meta(bytes: &[u8]) -> anyhow::Result<ModelMeta> {
    serde_json::from_slice(bytes).context("openmeteo meta.json")
}

/// The gate cursor: the run (initialisation time, unix s) last read per model.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct MarineCursor {
    pub wave: Option<i64>,
    pub current: Option<i64>,
}

/// The gate: which models have a run the cursor has not read.
pub fn marine_plan(seen: &MarineCursor, now: &MarineCursor) -> Vec<MarineKind> {
    let mut out = Vec::new();
    if now.wave.is_some() && seen.wave != now.wave {
        out.push(MarineKind::Wave);
    }
    if now.current.is_some() && seen.current != now.current {
        out.push(MarineKind::Current);
    }
    out
}

pub struct OpenMeteoMarine {
    regions: Vec<BBox>,
    cfg: MarineCfg,
}

impl OpenMeteoMarine {
    pub fn new(app: Arc<App>) -> Self {
        OpenMeteoMarine { regions: physical::region_boxes(&app), cfg: marine_cfg(&app) }
    }

    /// Every data URL of one model run, region by region.
    pub fn urls(&self, kind: MarineKind, issued_s: i64) -> Vec<String> {
        let model = match kind {
            MarineKind::Wave => &self.cfg.wave_model,
            MarineKind::Current => &self.cfg.current_model,
        };
        self.regions
            .iter()
            .map(|r| marine_data_url(&marine_grid(r, self.cfg.step_deg), kind, model, self.cfg.forecast_hours, issued_s))
            .collect()
    }
}

#[async_trait]
impl Source for OpenMeteoMarine {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: MARINE_SOURCE_ID,
            name: "Open-Meteo Marine (waves, currents)",
            homepage: "https://open-meteo.com/en/docs/marine-weather-api",
            mode: Mode::Poll,
            cadence: self.cfg.meta_check,
            // MF currents run once a day and land ~12 h after initialisation.
            max_latency: Duration::from_secs(36 * 3600),
        }
    }

    fn min_interval(&self) -> Duration {
        self.cfg.meta_check
    }

    async fn fetch(&self, ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
        let http = &ctx.state.http;
        let seen: MarineCursor = ctx.cursor.as_deref().and_then(|c| serde_json::from_str(c).ok()).unwrap_or_default();
        let wave = parse_meta(&get(http, &meta_url(&self.cfg.wave_model)).await?.bytes)?.last_run_initialisation_time;
        let current = parse_meta(&get(http, &meta_url(&self.cfg.current_model)).await?.bytes)?.last_run_initialisation_time;
        let next = MarineCursor { wave: Some(wave), current: Some(current) };
        let urls: Vec<String> = marine_plan(&seen, &next)
            .into_iter()
            .flat_map(|kind| self.urls(kind, if kind == MarineKind::Wave { wave } else { current }))
            .collect();
        let mut out = Vec::with_capacity(urls.len());
        for url in &urls {
            let (request, _) = url.split_once('#').unwrap_or((url, ""));
            let mut raw = get(http, request).await?;
            raw.source_url = url.clone();
            out.push(raw);
        }
        // The cursor commits with the last page, so a failed walk re-reads the run next time.
        if let Some(last) = out.last_mut() {
            last.next_cursor = Some(serde_json::to_string(&next).expect("cursor json"));
        }
        Ok(out)
    }

    fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
        normalize_marine(raw)
    }
}

/// A marine variable: its param, stored unit, and the factor from the provider's unit.
fn marine_param(name: &str, unit: &str) -> anyhow::Result<(Param, &'static str, f64)> {
    Ok(match (name, unit) {
        ("wave_height", "m") => (Param::WaveM, "m", 1.0),
        ("wave_period", "s") => (Param::WavePeriodS, "s", 1.0),
        ("ocean_current_velocity", "km/h") => (Param::CurrentMs, "m/s", 1.0 / 3.6),
        ("ocean_current_velocity", "m/s") => (Param::CurrentMs, "m/s", 1.0),
        ("ocean_current_velocity", "kn") => (Param::CurrentMs, "m/s", 1852.0 / 3600.0),
        ("ocean_current_direction", "°") => (Param::CurrentDirDeg, "deg", 1.0),
        (n, u) => anyhow::bail!("openmeteo marine: no conversion for {n} in {u:?}"),
    })
}

/// Pure: one marine data payload to readings (latest run, `modeled`) and forecast rows (every
/// run, with its issuance time). Land points (all null) are skipped.
pub fn normalize_marine(raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
    let (url, fragment) = raw.source_url.split_once('#').context("openmeteo marine: no #issued in url")?;
    let issued_s: i64 = fragment
        .strip_prefix("issued=")
        .and_then(|v| v.parse().ok())
        .with_context(|| format!("openmeteo marine: bad fragment {fragment:?}"))?;
    let model = url
        .split('&')
        .find_map(|kv| kv.strip_prefix("models="))
        .context("openmeteo marine: no models= in url")?
        .to_string();
    let points = points_from_url(url)?;
    let body = locations(&raw.bytes)?;
    anyhow::ensure!(body.len() == points.len(), "openmeteo marine: {} locations for {} points", body.len(), points.len());
    let issued_at = issued_s * 1000;
    let mut rows = Vec::new();
    for ((lat, lon), loc) in points.into_iter().zip(&body) {
        let hourly = &loc["hourly"];
        let Some(obj) = hourly.as_object() else { continue };
        let vars: Vec<&String> = obj.keys().filter(|k| *k != "time").collect();
        let any = vars.iter().any(|k| hourly[k.as_str()].as_array().is_some_and(|vs| vs.iter().any(Value::is_number)));
        if !any {
            continue;
        }
        let times: Vec<i64> = hourly["time"].as_array().map(|t| t.iter().filter_map(Value::as_i64).map(|s| s * 1000).collect()).unwrap_or_default();
        let station = StationRef {
            ext_id: format!("{lat:.3},{lon:.3}"),
            name: format!("Open-Meteo Marine {lat:.3},{lon:.3}"),
            lat,
            lon,
            kind: StationKind::Grid,
        };
        for name in vars {
            let unit = loc["hourly_units"][name.as_str()].as_str().unwrap_or_default();
            let (param, stored_unit, factor) = marine_param(name, unit)?;
            let Some(values) = hourly[name.as_str()].as_array() else { continue };
            for (i, at) in times.iter().enumerate() {
                let value = values.get(i).and_then(Value::as_f64).map(|v| v * factor);
                rows.push(reading(&station, param, value, *at, Origin::Modeled));
                rows.push(Row::Forecast(ForecastRow {
                    station: station.clone(),
                    param,
                    value: value.filter(|v| v.is_finite()),
                    unit: stored_unit.to_string(),
                    source_unit: unit.to_string(),
                    model: model.clone(),
                    issued_at,
                    valid_at: *at,
                }));
            }
        }
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::poll::physical::testing::{assert_idempotent, fixture, fixture_str, python_app, python_region, recorded, FakeFetch};
    use crate::model::{Flag, ReadingRow};

    const RECORDED_AT: i64 = 1_790_800_600_000;

    fn raw(kind: &str) -> RawPayload {
        recorded(fixture_str(&format!("openmeteo/{kind}.url")).trim(), "application/json", fixture(&format!("openmeteo/{kind}.json")), 200, RECORDED_AT)
    }

    fn readings(kind: &str) -> Vec<ReadingRow> {
        normalize_payload(&raw(kind))
            .unwrap()
            .into_iter()
            .map(|r| match r {
                Row::Reading(r) => r,
                other => panic!("{other:?}"),
            })
            .collect()
    }

    #[test]
    fn openmeteo_grid_covers_region() {
        let region = python_region();
        let g = grid(&[region]);
        assert_eq!(g.len(), 13 * 14);
        assert_eq!(g[0], (round3(region.south + 0.125), round3(region.west + 0.125)));
        assert_eq!(*g.last().unwrap(), (round3(region.north - 0.075), round3(region.east - 0.025)));
        assert!(g.iter().all(|(lat, lon)| region.contains(*lat, *lon)));
        let url = forecast_url(&g);
        assert_eq!(points_from_url(&url).unwrap(), g);
        // Several regions: each gets its own centres, in region order.
        let lf = crate::app::config::App::builtin("lionfish").unwrap();
        let boxes = physical::region_boxes(&lf);
        let multi = grid(&boxes);
        assert_eq!(multi.len(), boxes.iter().map(|b| grid(&[*b]).len()).sum::<usize>());
        assert!(multi.iter().all(|(lat, lon)| boxes.iter().any(|b| b.contains(*lat, *lon))));
    }

    #[test]
    fn openmeteo_fixture_forecast() {
        let rows = readings("forecast");
        // 4 points x 3 variables x 72 hours.
        assert_eq!(rows.len(), 4 * 3 * 72);
        assert!(rows.iter().all(|r| r.origin == Origin::Modeled && r.station.kind == StationKind::Grid));
        let first = &rows[0];
        assert_eq!(first.station.ext_id, "24.925,-80.575");
        assert_eq!(first.param, Param::AirC);
        let wind: Vec<&ReadingRow> = rows.iter().filter(|r| r.param == Param::WindMs && r.station.ext_id == "24.925,-80.575").collect();
        assert_eq!(wind.len(), 72);
        assert_eq!(wind[30].value, Some(3.32), "m/s as requested");
        let times: std::collections::BTreeSet<i64> = rows.iter().map(|r| r.observed_at).collect();
        assert_eq!(times.len(), 72);
        assert_eq!(times.iter().nth(1).unwrap() - times.iter().next().unwrap(), 3_600_000);
    }

    #[test]
    fn openmeteo_fixture_marine_skips_land() {
        let rows = readings("marine");
        let mut ids: Vec<&str> = rows.iter().map(|r| r.station.ext_id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        // 25.675,-80.825 is Everglades land: null marine values, not a marine point.
        assert_eq!(ids, ["24.425,-81.825", "24.925,-80.575", "25.175,-80.825"]);
        assert_eq!(rows.len(), 3 * 2 * 72);
        let sst: Vec<&ReadingRow> = rows.iter().filter(|r| r.param == Param::SstC && r.station.ext_id == "24.925,-80.575").collect();
        assert_eq!(sst[30].value, Some(30.1));
        assert!(rows.iter().filter(|r| r.value.is_none()).all(|r| r.flag == Flag::Missing));
        let sea = sea_points(&raw("marine")).unwrap();
        assert_eq!(sea.len(), 3);
    }

    #[test]
    fn openmeteo_rejects_mismatched_body() {
        let mut r = raw("forecast");
        r.source_url = forecast_url(&[(25.0, -80.0)]);
        assert!(normalize_payload(&r).is_err());
        r.bytes = br#"{"error":true,"reason":"Latitude must be in range of -90 to 90"}"#.to_vec();
        assert!(normalize_payload(&r).unwrap_err().to_string().contains("Latitude"));
    }

    #[tokio::test]
    async fn openmeteo_idempotent() {
        let (_, first) = assert_idempotent(FakeFetch { inner: OpenMeteo::new(python_app()), payloads: vec![raw("forecast"), raw("marine")] }).await;
        assert_eq!(first.len(), 2);
    }

    // ---- Lionfish Watch marine (L4, gates/leaf-L4.md G4) ----

    const WAVE_RUN_S: i64 = 1_790_769_600; // meteofrance_wave 2026-09-30T12:00Z
    const CURRENT_RUN_S: i64 = 1_790_726_400; // meteofrance_currents 2026-09-30T00:00Z

    /// A recorded lionfish marine payload, by manifest file name.
    fn lionfish_raw(file: &str) -> RawPayload {
        let m: Value = serde_json::from_slice(&fixture("openmeteo/manifest.lionfish.json")).unwrap();
        let url = m["files"].as_array().unwrap().iter().find(|f| f["file"] == file).unwrap()["url"].as_str().unwrap().to_string();
        recorded(&url, "application/json", fixture(&format!("openmeteo/{file}")), 200, 1_790_838_120_000)
    }

    fn lionfish_app() -> Arc<App> {
        Arc::new(App::builtin("lionfish").unwrap())
    }

    /// Settings, URLs and the model-run gate: a run is fetched once per model.
    #[test]
    fn lionfish_marine_gate_reads_each_model_run_once() {
        let app = lionfish_app();
        let cfg = marine_cfg(&app);
        assert_eq!(
            cfg,
            MarineCfg {
                step_deg: 0.5,
                forecast_hours: 72,
                wave_model: "meteofrance_wave".into(),
                current_model: "meteofrance_currents".into(),
                meta_check: Duration::from_secs(900),
            }
        );
        let src = OpenMeteoMarine::new(app.clone());
        assert_eq!((src.info().id, src.info().cadence, src.min_interval()), (MARINE_SOURCE_ID, Duration::from_secs(900), Duration::from_secs(900)));
        // The recorded meta.json files are the runs the recorded payloads came from.
        let wave = parse_meta(&fixture("openmeteo/meta-meteofrance_wave.json")).unwrap();
        let current = parse_meta(&fixture("openmeteo/meta-meteofrance_currents.json")).unwrap();
        assert_eq!((wave.last_run_initialisation_time, current.last_run_initialisation_time), (WAVE_RUN_S, CURRENT_RUN_S));
        assert!(wave.last_run_availability_time > wave.last_run_initialisation_time);
        // Every recorded URL is exactly what the adapter asks for at that run.
        let urls: Vec<String> = src.urls(MarineKind::Wave, WAVE_RUN_S).into_iter().chain(src.urls(MarineKind::Current, CURRENT_RUN_S)).collect();
        let m: Value = serde_json::from_slice(&fixture("openmeteo/manifest.lionfish.json")).unwrap();
        let recorded: Vec<&str> = m["files"].as_array().unwrap().iter().map(|f| f["url"].as_str().unwrap()).collect();
        assert_eq!(urls, recorded);
        assert!(urls.iter().all(|u| u.contains("&forecast_hours=72&") && u.contains("&models=meteofrance_")));

        let run = |w, c| MarineCursor { wave: Some(w), current: Some(c) };
        let now = run(WAVE_RUN_S, CURRENT_RUN_S);
        assert_eq!(marine_plan(&MarineCursor::default(), &now), [MarineKind::Wave, MarineKind::Current], "first poll reads both");
        assert!(marine_plan(&now, &now).is_empty(), "unchanged runs: no data request");
        assert_eq!(marine_plan(&run(WAVE_RUN_S - 43_200, CURRENT_RUN_S), &now), [MarineKind::Wave], "new MF wave run only");
        // Areas lie on the grid: fl 6 x 7, mx 7 x 3, bz 4 x 2, co 8 x 16 cell centres.
        let sizes: Vec<usize> = physical::region_boxes(&app).iter().map(|b| marine_grid(b, 0.5).len()).collect();
        assert_eq!(sizes, [42, 21, 8, 128]);
    }

    /// Currents arrive in km/h and are stored in m/s with both units recorded; every value keeps
    /// its model run; 72 hourly steps; land points are skipped.
    #[test]
    fn lionfish_marine_normalize_units_horizon_and_issuance() {
        let rows = normalize_marine(&lionfish_raw("lionfish-current-fl-keys.json")).unwrap();
        let body: Value = serde_json::from_slice(&fixture("openmeteo/lionfish-current-fl-keys.json")).unwrap();
        assert_eq!(body[0]["hourly_units"]["ocean_current_velocity"], "km/h");
        let kmh = body[0]["hourly"]["ocean_current_velocity"][0].as_f64().unwrap();
        let forecasts: Vec<&ForecastRow> = rows.iter().filter_map(|r| if let Row::Forecast(f) = r { Some(f) } else { None }).collect();
        let first = forecasts.iter().find(|f| f.param == Param::CurrentMs).unwrap();
        assert_eq!(first.station.ext_id, "24.550,-82.950");
        assert!((first.value.unwrap() - kmh / 3.6).abs() < 1e-12, "{} km/h", kmh);
        assert_eq!((first.unit.as_str(), first.source_unit.as_str(), first.model.as_str()), ("m/s", "km/h", "meteofrance_currents"));
        assert!(forecasts.iter().all(|f| f.issued_at == CURRENT_RUN_S * 1000));
        let dir = forecasts.iter().find(|f| f.param == Param::CurrentDirDeg).unwrap();
        assert_eq!((dir.unit.as_str(), dir.source_unit.as_str()), ("deg", "°"));
        // The same value lands in readings (the latest run).
        let reading = rows.iter().find_map(|r| match r {
            Row::Reading(x) if x.param == Param::CurrentMs && x.station.ext_id == first.station.ext_id && x.observed_at == first.valid_at => Some(x),
            _ => None,
        });
        assert_eq!(reading.unwrap().value, first.value);
        assert_eq!(reading.unwrap().origin, Origin::Modeled);
        // 72 hourly valid times per point.
        let times: std::collections::BTreeSet<i64> = forecasts.iter().map(|f| f.valid_at).collect();
        assert_eq!(times.len(), 72);
        assert_eq!(times.iter().nth(1).unwrap() - times.iter().next().unwrap(), 3_600_000);
        let points: std::collections::BTreeSet<&str> = forecasts.iter().map(|f| f.station.ext_id.as_str()).collect();
        assert!(points.len() < 42, "land cells of the Florida box are skipped: {} of 42 kept", points.len());
        assert_eq!(forecasts.len(), points.len() * 2 * 72);

        let waves = normalize_marine(&lionfish_raw("lionfish-wave-belize.json")).unwrap();
        let units: std::collections::BTreeSet<(String, &str)> = waves
            .iter()
            .filter_map(|r| if let Row::Forecast(f) = r { Some((f.param.as_str().to_string(), f.unit.as_str())) } else { None })
            .collect();
        assert_eq!(units.into_iter().collect::<Vec<_>>(), [("wave_m".to_string(), "m"), ("wave_period_s".to_string(), "s")]);
        assert!(waves.iter().all(|r| !matches!(r, Row::Forecast(f) if f.issued_at != WAVE_RUN_S * 1000)));
        // A unit the adapter does not know is an error, never a silent wrong number.
        let mut odd = lionfish_raw("lionfish-current-belize.json");
        odd.bytes = String::from_utf8(odd.bytes).unwrap().replace("\"km/h\"", "\"mph\"").into_bytes();
        assert!(normalize_marine(&odd).unwrap_err().to_string().contains("mph"));
        let mut no_run = lionfish_raw("lionfish-current-belize.json");
        no_run.source_url = no_run.source_url.split('#').next().unwrap().to_string();
        assert!(normalize_marine(&no_run).is_err(), "a payload without its run is rejected");
    }

    /// Each run is stored once; a new run adds a forecast row per point and hour while
    /// `readings` holds the latest values.
    #[tokio::test]
    async fn lionfish_marine_forecasts_are_stored_per_run() {
        let state = crate::app::test_support::test_state_for("lionfish");
        let src = OpenMeteoMarine::new(state.app.clone());
        let count = |state: &crate::state::AppState| {
            let state = state.clone();
            async move {
                state
                    .obs
                    .read(|c| {
                        Ok((
                            c.query_row("select count(*) from marine_forecasts", [], |r| r.get::<_, i64>(0))?,
                            c.query_row("select count(distinct issued_at) from marine_forecasts", [], |r| r.get::<_, i64>(0))?,
                            c.query_row("select count(*) from readings where param in ('current_ms', 'current_dir_deg')", [], |r| r.get::<_, i64>(0))?,
                        ))
                    })
                    .await
                    .unwrap()
            }
        };
        let raw = lionfish_raw("lionfish-current-belize.json");
        let first = crate::ingest::scheduler::ingest_payload(&state, &src, raw.clone(), None).await.unwrap();
        assert!(first.error.is_none() && first.rows_written > 0, "{first:?}");
        let (f1, runs1, r1) = count(&state).await;
        assert_eq!((runs1, f1), (1, r1), "one forecast row per reading");
        let again = crate::ingest::scheduler::ingest_payload(&state, &src, raw.clone(), None).await.unwrap();
        assert_eq!(again.rows_written, 0, "the same run is stored once");
        let mut next = raw;
        next.source_url = next.source_url.replace(&format!("#issued={CURRENT_RUN_S}"), &format!("#issued={}", CURRENT_RUN_S + 86_400));
        crate::ingest::scheduler::ingest_payload(&state, &src, next, None).await.unwrap();
        let (f2, runs2, r2) = count(&state).await;
        assert_eq!((f2, runs2, r2), (2 * f1, 2, r1), "a second run is kept beside the first; readings hold one value per hour");
        let (unit, src_unit): (String, String) =
            state.obs.read(|c| c.query_row("select unit, source_unit from marine_forecasts where param = 'current_ms' limit 1", [], |r| Ok((r.get(0)?, r.get(1)?)))).await.unwrap();
        assert_eq!((unit.as_str(), src_unit.as_str()), ("m/s", "km/h"));
    }
}
