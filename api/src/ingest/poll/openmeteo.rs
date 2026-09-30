//! Open-Meteo forecast and marine models (T8, PRD §2), hourly, on a 0.25° grid over the region:
//! cell centres from 24.425°N / 83.075°W, 13 rows x 14 columns = 182 points, one request per API
//! with comma-separated coordinates.
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

use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::Context;
use async_trait::async_trait;
use serde_json::Value;

use crate::ingest::governor;
use crate::ingest::poll::physical::{self, reading, REGION};
use crate::ingest::source::{FetchCtx, Mode, RawPayload, Source, SourceInfo};
use crate::model::{Origin, Param, Row, StationKind, StationRef};

pub const FORECAST_URL: &str = "https://api.open-meteo.com/v1/forecast";
pub const MARINE_URL: &str = "https://marine-api.open-meteo.com/v1/marine";
pub const STEP_DEG: f64 = 0.25;
const MASK_TTL: Duration = Duration::from_secs(24 * 3600);

const FORECAST_VARS: [(&str, Param); 3] =
    [("temperature_2m", Param::AirC), ("precipitation", Param::RainMm), ("wind_speed_10m", Param::WindMs)];
const MARINE_VARS: [(&str, Param); 2] = [("wave_height", Param::WaveM), ("sea_surface_temperature", Param::SstC)];

/// Grid cell centres over the region, south-west first, row-major.
pub fn grid() -> Vec<(f64, f64)> {
    // Every cell centre inside the box (the last row/column may be a partial cell).
    let centres = |from: f64, to: f64| -> Vec<f64> {
        (0..).map(|i| round3(from + STEP_DEG * (i as f64 + 0.5))).take_while(|v| *v <= to).collect()
    };
    let lats = centres(REGION.south, REGION.north);
    let lons = centres(REGION.west, REGION.east);
    lats.iter().flat_map(|lat| lons.iter().map(move |lon| (*lat, *lon))).collect()
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
    sea: Mutex<Option<SeaMask>>,
}

impl OpenMeteo {
    pub fn new() -> Self {
        OpenMeteo { sea: Mutex::new(None) }
    }
}

impl Default for OpenMeteo {
    fn default() -> Self {
        Self::new()
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
        let all = grid();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::poll::physical::testing::{assert_idempotent, fixture, fixture_str, recorded, FakeFetch};
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
        let g = grid();
        assert_eq!(g.len(), 13 * 14);
        assert_eq!(g[0], (24.425, -83.075));
        assert_eq!(*g.last().unwrap(), (27.425, -79.825));
        assert!(g.iter().all(|(lat, lon)| REGION.contains(*lat, *lon)));
        let url = forecast_url(&g);
        assert_eq!(points_from_url(&url).unwrap(), g);
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
        let (_, first) = assert_idempotent(FakeFetch { inner: OpenMeteo::new(), payloads: vec![raw("forecast"), raw("marine")] }).await;
        assert_eq!(first.len(), 2);
    }
}
