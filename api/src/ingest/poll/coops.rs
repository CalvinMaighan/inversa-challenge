//! NOAA CO-OPS Data API (T8, PRD §2): 6-minute water level (MLLW, metric) and water
//! temperature for the region's tide stations, polled every 6 min over the last hour.
//!
//! Stations: every CO-OPS water-level station inside the region per the metadata API
//! (`mdapi/prod/webapi/stations.json?type=waterlevels`), checked against `datagetter` on
//! 2026-09-30. Naples `8725110` returns no data; `8725114` (Naples Bay, North) replaces it.
//! Water temperature is requested only where the station lists a sensor.

use std::time::Duration;

use anyhow::Context;
use async_trait::async_trait;
use futures_util::stream::{self, StreamExt};
use serde_json::Value;

use crate::ingest::governor;
use crate::ingest::poll::physical::{self, parse_num, reading};
use crate::ingest::source::{FetchCtx, Mode, RawPayload, Source, SourceInfo};
use crate::model::{Origin, Param, Row, StationKind, StationRef};

pub const DATA_URL: &str = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";

pub struct TideStation {
    pub id: &'static str,
    pub name: &'static str,
    pub lat: f64,
    pub lon: f64,
    pub water_temp: bool,
}

/// Verified 2026-09-30.
pub const STATIONS: &[TideStation] = &[
    TideStation { id: "8722670", name: "Lake Worth Pier, Atlantic Ocean", lat: 26.612778, lon: -80.034164, water_temp: true },
    TideStation { id: "8722956", name: "South Port Everglades", lat: 26.081667, lon: -80.11667, water_temp: true },
    TideStation { id: "8723214", name: "Virginia Key", lat: 25.7314, lon: -80.1618, water_temp: true },
    TideStation { id: "8723970", name: "Vaca Key, Florida Bay", lat: 24.711, lon: -81.1065, water_temp: true },
    TideStation { id: "8724580", name: "Key West", lat: 24.5557, lon: -81.8079, water_temp: true },
    TideStation { id: "8725114", name: "Naples Bay, North", lat: 26.1367, lon: -81.7883, water_temp: false },
    TideStation { id: "8725520", name: "Fort Myers", lat: 26.647778, lon: -81.87111, water_temp: true },
];

const PRODUCTS: [(&str, Param); 2] = [("water_level", Param::StageM), ("water_temperature", Param::WaterC)];

pub fn request_url(station: &str, product: &str) -> String {
    let datum = if product == "water_level" { "&datum=MLLW" } else { "" };
    format!(
        "{DATA_URL}?product={product}&application=inversa-challenge&station={station}&range=1{datum}&time_zone=gmt&units=metric&format=json"
    )
}

pub struct Coops;

impl Coops {
    pub fn new() -> Self {
        Coops
    }
}

impl Default for Coops {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Source for Coops {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: "coops",
            name: "NOAA CO-OPS water level",
            homepage: "https://api.tidesandcurrents.noaa.gov/api/prod/",
            mode: Mode::Poll,
            cadence: Duration::from_secs(6 * 60),
            max_latency: Duration::from_secs(60 * 60),
        }
    }

    async fn fetch(&self, ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
        let http = &ctx.state.http;
        let urls: Vec<String> = STATIONS
            .iter()
            .flat_map(|s| PRODUCTS.iter().filter(|(p, _)| *p == "water_level" || s.water_temp).map(|(p, _)| request_url(s.id, p)))
            .collect();
        let total = urls.len();
        let results: Vec<anyhow::Result<RawPayload>> = stream::iter(urls)
            .map(|url| async move {
                let res = http.get(&url).send().await.with_context(|| format!("coops {url}"))?;
                let res = governor::check_response(res)?;
                let status = res.status().as_u16();
                let content_type = physical::content_type(&res, "application/json");
                let bytes = res.bytes().await.context("coops body")?.to_vec();
                Ok(physical::payload(&url, &content_type, bytes, status, None))
            })
            .buffer_unordered(4)
            .collect()
            .await;
        let mut payloads = Vec::new();
        let mut errors = Vec::new();
        for r in results {
            match r {
                Ok(p) => payloads.push(p),
                Err(e) => {
                    tracing::warn!(source = "coops", "fetch failed: {e:#}");
                    errors.push(e);
                }
            }
        }
        if errors.len() == total {
            if let Some(e) = errors.into_iter().next() {
                return Err(e.context(format!("coops: all {total} requests failed")));
            }
        }
        payloads.sort_by(|a, b| a.source_url.cmp(&b.source_url));
        Ok(payloads)
    }

    fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
        let query = raw.source_url.split_once('?').map(|(_, q)| q).unwrap_or_default();
        let get = |k: &str| query.split('&').find_map(|kv| kv.strip_prefix(k).and_then(|v| v.strip_prefix('=')));
        let station = get("station").context("coops: station in url")?;
        let product = get("product").context("coops: product in url")?;
        normalize_product(station, product, &raw.bytes)
    }
}

pub fn normalize_product(station_id: &str, product: &str, bytes: &[u8]) -> anyhow::Result<Vec<Row>> {
    let param = PRODUCTS.iter().find(|(p, _)| *p == product).map(|(_, p)| *p).with_context(|| format!("coops: product {product}"))?;
    let doc: Value = serde_json::from_slice(bytes).context("coops json")?;
    // "No data was found" arrives as HTTP 200 with an error object: nothing to write.
    if let Some(msg) = doc["error"]["message"].as_str() {
        tracing::debug!(source = "coops", station = station_id, product, "no data: {msg}");
        return Ok(Vec::new());
    }
    let meta = &doc["metadata"];
    let known = STATIONS.iter().find(|s| s.id == station_id);
    let lat = known.map(|s| s.lat).or_else(|| meta["lat"].as_str().and_then(parse_num)).context("coops: station lat")?;
    let lon = known.map(|s| s.lon).or_else(|| meta["lon"].as_str().and_then(parse_num)).context("coops: station lon")?;
    let name = known.map(|s| s.name.to_string()).or_else(|| meta["name"].as_str().map(String::from)).unwrap_or_else(|| station_id.to_string());
    let station = StationRef { ext_id: station_id.to_string(), name, lat, lon, kind: StationKind::Tide };
    let data = doc["data"].as_array().context("coops: no data array")?;
    let mut rows = Vec::with_capacity(data.len());
    for d in data {
        let Some(at) = d["t"].as_str().and_then(|t| physical::parse_utc_ms(t, "%Y-%m-%d %H:%M")) else { continue };
        let value = d["v"].as_str().and_then(parse_num);
        rows.push(reading(&station, param, value, at, Origin::Measured));
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::poll::physical::testing::{assert_idempotent, fixture, python_region, recorded, FakeFetch};
    use crate::model::{Flag, ReadingRow};

    const RECORDED_AT: i64 = 1_790_800_400_000;

    fn normalized(station: &str, product: &str) -> Vec<ReadingRow> {
        let raw = recorded(&request_url(station, product), "application/json", fixture(&format!("coops/{station}.{product}.json")), 200, RECORDED_AT);
        Coops::new()
            .normalize(&raw)
            .unwrap()
            .into_iter()
            .map(|r| match r {
                Row::Reading(r) => r,
                other => panic!("{other:?}"),
            })
            .collect()
    }

    #[test]
    fn coops_stations_in_region() {
        assert_eq!(STATIONS.len(), 7);
        let region = python_region();
        assert!(STATIONS.iter().all(|s| region.contains(s.lat, s.lon)));
        assert!(!STATIONS.iter().any(|s| s.id == "8725110"), "Naples 8725110 has no data");
    }

    #[test]
    fn coops_fixture_water_level_is_stage_m_for_tide() {
        let rows = normalized("8723214", "water_level");
        assert_eq!(rows.len(), 10, "one hour of 6-minute data");
        assert!(rows.iter().all(|r| r.param == Param::StageM && r.station.kind == StationKind::Tide && r.flag == Flag::Ok));
        assert_eq!(rows[0].observed_at, physical::parse_utc_ms("2026-09-30 19:36", "%Y-%m-%d %H:%M").unwrap());
        assert_eq!(rows[0].value, Some(0.668));
        assert_eq!(rows[0].station.name, "Virginia Key");
    }

    #[test]
    fn coops_fixture_water_temperature_and_no_data() {
        let rows = normalized("8723214", "water_temperature");
        assert!(!rows.is_empty());
        assert!(rows.iter().all(|r| r.param == Param::WaterC));
        assert_eq!(rows[0].value, Some(28.8));
        assert!(normalized("8725114", "water_temperature").is_empty(), "error object means no rows");
    }

    #[test]
    fn coops_blank_value_is_missing() {
        let body = br#"{"metadata":{"id":"8723214","name":"Virginia Key","lat":"25.7314","lon":"-80.1618"},
            "data":[{"t":"2026-09-30 19:36","v":"","s":"","f":"0,0,0,0","q":"p"}]}"#;
        let rows = normalize_product("8723214", "water_level", body).unwrap();
        let Row::Reading(r) = &rows[0] else { panic!() };
        assert_eq!((r.value, r.flag), (None, Flag::Missing));
    }

    #[tokio::test]
    async fn coops_idempotent() {
        let payloads = [("8723214", "water_level"), ("8723214", "water_temperature"), ("8724580", "water_level"), ("8725114", "water_temperature")]
            .iter()
            .map(|(s, p)| recorded(&request_url(s, p), "application/json", fixture(&format!("coops/{s}.{p}.json")), 200, RECORDED_AT))
            .collect();
        let (state, _) = assert_idempotent(FakeFetch { inner: Coops::new(), payloads }).await;
        let tides: i64 =
            state.obs.read(|c| c.query_row("select count(*) from stations where kind = 'tide'", [], |r| r.get(0))).await.unwrap();
        assert_eq!(tides, 2);
    }
}
