//! NOAA NDBC realtime2 standard meteorological files (T8, PRD §2), every 10 min.
//!
//! Stations: every station in `activestations.xml` inside the region whose
//! `data/realtime2/<ID>.txt` answered with current data on 2026-09-30 (52 of 54; `RKQF1` and
//! `FWYF1` return 404, and `MLRF1` is no longer listed). Buoys and C-MAN stations report sea
//! surface temperature (`sst_c`, the in-situ reference for GOES SST); the Everglades National
//! Park, NERRS and NOS pier stations sit in estuaries, rivers and harbours, so their water
//! temperature is `water_c`.
//!
//! Each file holds 45 days of observations, newest first (~600 KB). A ranged GET for the first
//! 8 KB covers the latest ~8-80 hours, and `If-Modified-Since` turns an unchanged file into a
//! 304, so most polls move a few hundred bytes. The partial last line of a ranged body is
//! dropped. `MM` values are kept as missing readings.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use anyhow::Context;
use async_trait::async_trait;
use futures_util::stream::{self, StreamExt};
use reqwest::header::{ACCEPT_ENCODING, IF_MODIFIED_SINCE, LAST_MODIFIED, RANGE};
use reqwest::StatusCode;

use crate::ingest::governor;
use crate::ingest::poll::physical::{self, parse_num, reading};
use crate::ingest::source::{FetchCtx, Mode, RawPayload, Source, SourceInfo};
use crate::model::{Origin, Param, Row, StationKind, StationRef};

pub const BASE_URL: &str = "https://www.ndbc.noaa.gov/data/realtime2/";
const RANGE_BYTES: usize = 8192;
const CONCURRENCY: usize = 4;
/// Observations older than this (relative to the fetch) are not re-read. The ranged body covers
/// less anyway; this bounds the work if a server ever ignores the Range header.
const MAX_AGE_MS: i64 = 4 * 24 * 3600 * 1000;

/// One NDBC station: id, name, lat, lon, and the parameter its WTMP maps to.
pub struct NdbcStation {
    pub id: &'static str,
    pub name: &'static str,
    pub lat: f64,
    pub lon: f64,
    pub water: Param,
}

const fn st(id: &'static str, name: &'static str, lat: f64, lon: f64, water: Param) -> NdbcStation {
    NdbcStation { id, name, lat, lon, water }
}

use Param::{SstC as SEA, WaterC as EST};

/// Verified against activestations.xml and realtime2 on 2026-09-30.
pub const STATIONS: &[NdbcStation] = &[
    // Moored buoys.
    st("41122", "Hollywood Beach, FL (265)", 26.001, -80.096, SEA),
    st("42013", "C10 - WFS Central Buoy, 25m Isobath", 27.173, -82.924, SEA),
    st("42023", "C13 - WFS South Buoy, 50m Isobath", 26.01, -83.086, SEA),
    st("42095", "Satan Shoal, FL (244)", 24.407, -81.968, SEA),
    // C-MAN.
    st("LONF1", "Long Key, FL", 24.844, -80.864, SEA),
    st("SANF1", "Sand Key, FL", 24.456, -81.877, SEA),
    st("SMKF1", "Sombrero Key, FL", 24.628, -81.109, SEA),
    st("VENF1", "Venice, FL", 27.072, -82.453, SEA),
    // NOS/CO-OPS piers and harbours.
    st("FMRF1", "8725520 - Fort Myers, FL", 26.647, -81.871, EST),
    st("KYWF1", "8724580 - Key West, FL", 24.556, -81.808, EST),
    st("LKWF1", "8722670 - Lake Worth Pier, FL", 26.613, -80.034, EST),
    st("PEGF1", "8722956 - Port Everglades, FL", 26.086, -80.116, EST),
    st("VAKF1", "8723214 - Virginia Key, FL", 25.731, -80.162, EST),
    st("VCAF1", "8723970 - Vaca Key, FL", 24.711, -81.107, EST),
    // NERRS.
    st("RKXF1", "Upper Henderson Creek, Rookery Bay Reserve, FL", 26.05, -81.701, EST),
    // Everglades National Park (Florida Bay and the southwest coast).
    st("BDVF1", "Broad River, FL", 25.478, -80.989, EST),
    st("BKYF1", "Buoy Key, FL", 25.119, -80.834, EST),
    st("BNKF1", "Butternut Key, FL", 25.087, -80.519, EST),
    st("BOBF1", "Bob Allen, FL", 25.027, -80.681, EST),
    st("BSKF1", "Big Sable Creek, FL", 25.266, -81.162, EST),
    st("BWSF1", "Blackwater Sound, FL", 25.178, -80.438, EST),
    st("CANF1", "Cane Patch, FL", 25.422, -80.942, EST),
    st("CNBF1", "Cannon Bay, FL", 25.702, -81.186, EST),
    st("CWAF1", "Clear Water Pass, FL", 25.297, -81.013, EST),
    st("DKKF1", "Duck Key, FL", 25.18, -80.49, EST),
    st("GBIF1", "Gunboat Island, FL", 25.378, -81.029, EST),
    st("GBTF1", "Garfield Bight, FL", 25.167, -80.801, EST),
    st("HCEF1", "Highway Creek, FL", 25.254, -80.444, EST),
    st("HREF1", "Harney River, FL", 25.424, -81.06, EST),
    st("JBYF1", "Joe Bay, FL", 25.224, -80.541, EST),
    st("JKYF1", "Johnson Key, FL", 25.053, -80.904, EST),
    st("LBSF1", "Little Blackwater, FL", 25.214, -80.432, EST),
    st("LMDF1", "Little Madeira, FL", 25.176, -80.633, EST),
    st("LMRF1", "Lostmans River, FL", 25.556, -81.169, EST),
    st("LRIF1", "Lane River, FL", 25.284, -80.894, EST),
    st("LRKF1", "Little Rabbit Key, FL", 24.982, -80.826, EST),
    st("LSNF1", "Long Sound, FL", 25.235, -80.457, EST),
    st("MDKF1", "Middle Key, FL", 25.289, -80.396, EST),
    st("MNBF1", "Manatee Bay, FL", 25.239, -80.422, EST),
    st("MUKF1", "Murray Key, FL", 25.106, -80.942, EST),
    st("NRRF1", "North River, FL", 25.338, -80.911, EST),
    st("PKYF1", "Peterson Key, FL", 24.918, -80.747, EST),
    st("SREF1", "Shark River, FL", 25.352, -81.1, EST),
    st("TBYF1", "Terrapin Bay, FL", 25.155, -80.722, EST),
    st("TCVF1", "Trout Cove, FL", 25.213, -80.533, EST),
    st("THRF1", "Thursday Point, FL", 25.203, -80.372, EST),
    st("TPEF1", "Tarpon Bay East, FL", 25.41, -80.964, EST),
    st("TRRF1", "Taylor River, FL", 25.217, -80.65, EST),
    st("WIWF1", "Willy Willy, FL", 25.587, -81.044, EST),
    st("WPLF1", "Watson Place, FL", 25.71, -81.249, EST),
    st("WRBF1", "Whipray Basin, FL", 25.072, -80.735, EST),
    st("WWEF1", "Whitewater Bay-East, FL", 25.232, -80.938, EST),
];

pub fn station(id: &str) -> Option<&'static NdbcStation> {
    STATIONS.iter().find(|s| s.id.eq_ignore_ascii_case(id))
}

pub fn station_url(id: &str) -> String {
    format!("{BASE_URL}{id}.txt")
}

pub struct Ndbc {
    /// Last-Modified per station, for conditional ranged GETs.
    last_modified: Mutex<HashMap<&'static str, String>>,
}

impl Ndbc {
    pub fn new() -> Self {
        Ndbc { last_modified: Mutex::new(HashMap::new()) }
    }
}

impl Default for Ndbc {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Source for Ndbc {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: "ndbc",
            name: "NOAA NDBC realtime2",
            homepage: "https://www.ndbc.noaa.gov/",
            mode: Mode::Poll,
            cadence: Duration::from_secs(10 * 60),
            // ENP stations report hourly and post with ~1 h delay.
            max_latency: Duration::from_secs(3 * 3600),
        }
    }

    async fn fetch(&self, ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
        let http = &ctx.state.http;
        let results: Vec<(&'static str, anyhow::Result<Option<(RawPayload, Option<String>)>>)> = stream::iter(0..STATIONS.len())
            .map(|i| async move {
                let id = STATIONS[i].id;
                let since = self.last_modified.lock().expect("last_modified").get(id).cloned();
                (id, fetch_station(http, id, since).await)
            })
            .buffer_unordered(CONCURRENCY)
            .collect()
            .await;
        let mut payloads = Vec::new();
        let mut first_err = None;
        let mut failures = 0usize;
        for (id, result) in results {
            match result {
                Ok(Some((raw, modified))) => {
                    if let Some(m) = modified {
                        self.last_modified.lock().expect("last_modified").insert(id, m);
                    }
                    payloads.push(raw);
                }
                Ok(None) => {}
                Err(e) => {
                    failures += 1;
                    tracing::warn!(source = "ndbc", station = id, "fetch failed: {e:#}");
                    first_err.get_or_insert(e);
                }
            }
        }
        // Every station failing is an upstream outage: surface it so the governor backs off.
        if failures == STATIONS.len() {
            if let Some(e) = first_err {
                return Err(e.context(format!("ndbc: all {failures} stations failed")));
            }
        }
        payloads.sort_by(|a, b| a.source_url.cmp(&b.source_url));
        Ok(payloads)
    }

    fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
        let id = raw
            .source_url
            .rsplit('/')
            .next()
            .and_then(|f| f.strip_suffix(".txt"))
            .context("ndbc: station id from url")?;
        let st = station(id).with_context(|| format!("ndbc: unknown station {id}"))?;
        normalize_txt(st, &raw.bytes, raw.fetched_at)
    }
}

/// Ranged conditional GET. `Ok(None)` when unchanged (304) or the file is gone (404).
async fn fetch_station(
    http: &reqwest::Client,
    id: &str,
    since: Option<String>,
) -> anyhow::Result<Option<(RawPayload, Option<String>)>> {
    let url = station_url(id);
    // Identity encoding: the server ignores Range on a gzip-negotiated response and would send
    // the whole 45-day file.
    let mut req = http
        .get(&url)
        .header(RANGE, format!("bytes=0-{}", RANGE_BYTES - 1))
        .header(ACCEPT_ENCODING, "identity");
    if let Some(since) = &since {
        req = req.header(IF_MODIFIED_SINCE, since);
    }
    let res = req.send().await.with_context(|| format!("ndbc {id}"))?;
    match res.status() {
        StatusCode::NOT_MODIFIED => return Ok(None),
        StatusCode::NOT_FOUND => {
            tracing::warn!(source = "ndbc", station = id, "realtime2 file missing (station offline)");
            return Ok(None);
        }
        _ => {}
    }
    let res = governor::check_response(res)?;
    let status = res.status().as_u16();
    let modified = res.headers().get(LAST_MODIFIED).and_then(|v| v.to_str().ok()).map(String::from);
    let bytes = res.bytes().await.with_context(|| format!("ndbc {id} body"))?.to_vec();
    Ok(Some((physical::payload(&url, "text/plain", bytes, status, None), modified)))
}

/// Parse one realtime2 standard meteorological file (or its first bytes).
pub fn normalize_txt(st: &NdbcStation, bytes: &[u8], fetched_at: i64) -> anyhow::Result<Vec<Row>> {
    let text = String::from_utf8_lossy(bytes);
    // A ranged body usually ends mid-line; only newline-terminated lines are complete.
    let complete = match text.rfind('\n') {
        Some(i) => &text[..=i],
        None => "",
    };
    let mut lines = complete.lines();
    let header = lines.next().context("ndbc: empty file")?;
    let cols: Vec<&str> = header.trim_start_matches('#').split_whitespace().collect();
    anyhow::ensure!(cols.first() == Some(&"YY") && cols.len() >= 5, "ndbc: unexpected header {header:?}");
    let col = |name: &str| cols.iter().position(|c| *c == name);
    let (wspd, wvht, atmp, wtmp) = (col("WSPD"), col("WVHT"), col("ATMP"), col("WTMP"));
    anyhow::ensure!(
        wspd.is_some() && wvht.is_some() && atmp.is_some() && wtmp.is_some(),
        "ndbc: missing WSPD/WVHT/ATMP/WTMP in {header:?}"
    );

    let station = StationRef { ext_id: st.id.to_string(), name: st.name.to_string(), lat: st.lat, lon: st.lon, kind: StationKind::Buoy };
    let mut rows = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in lines {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() != cols.len() {
            continue;
        }
        let Some(at) = physical::parse_utc_ms(&f[..5].join(" "), "%Y %m %d %H %M") else { continue };
        if at < fetched_at - MAX_AGE_MS || !seen.insert(at) {
            continue;
        }
        let value = |i: Option<usize>| i.and_then(|i| f.get(i)).filter(|v| **v != "MM").and_then(|v| parse_num(v));
        rows.push(reading(&station, st.water, value(wtmp), at, Origin::Measured));
        rows.push(reading(&station, Param::AirC, value(atmp), at, Origin::Measured));
        rows.push(reading(&station, Param::WindMs, value(wspd), at, Origin::Measured));
        rows.push(reading(&station, Param::WaveM, value(wvht), at, Origin::Measured));
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::poll::physical::testing::{assert_idempotent, fixture, python_region, recorded, FakeFetch};
    use crate::model::{Flag, ReadingRow};

    const RECORDED_AT: i64 = 1_790_800_191_000;

    fn rows(id: &str) -> Vec<ReadingRow> {
        normalize_txt(station(id).unwrap(), &fixture(&format!("ndbc/{id}.txt")), RECORDED_AT)
            .unwrap()
            .into_iter()
            .map(|r| match r {
                Row::Reading(r) => r,
                other => panic!("{other:?}"),
            })
            .collect()
    }

    fn at(s: &str) -> i64 {
        physical::parse_utc_ms(s, "%Y-%m-%d %H:%M").unwrap()
    }

    #[test]
    fn ndbc_stations_are_in_region_and_unique() {
        assert_eq!(STATIONS.len(), 52);
        let mut ids: Vec<&str> = STATIONS.iter().map(|s| s.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 52);
        let region = python_region();
        assert!(STATIONS.iter().all(|s| region.contains(s.lat, s.lon)));
        for dead in ["FWYF1", "MLRF1", "RKQF1"] {
            assert!(station(dead).is_none(), "{dead} is offline");
        }
    }

    #[test]
    fn ndbc_fixture_cman_parses_first_line_and_missing() {
        let rows = rows("SMKF1");
        // First line: 2026 09 30 20 00  60  7.7  9.3  MM ... ATMP 26.9  WTMP MM
        let first: Vec<&ReadingRow> = rows.iter().filter(|r| r.observed_at == at("2026-09-30 20:00")).collect();
        assert_eq!(first.len(), 4);
        let get = |p: Param| first.iter().find(|r| r.param == p).unwrap();
        assert_eq!(get(Param::WindMs).value, Some(7.7));
        assert_eq!(get(Param::AirC).value, Some(26.9));
        assert_eq!((get(Param::SstC).value, get(Param::SstC).flag), (None, Flag::Missing), "WTMP MM kept as missing");
        assert_eq!((get(Param::WaveM).value, get(Param::WaveM).flag), (None, Flag::Missing));
        assert!(rows.iter().all(|r| r.station.kind == StationKind::Buoy && r.origin == Origin::Measured));
        assert_eq!(rows.len() % 4, 0);
    }

    #[test]
    fn ndbc_fixture_buoy_reports_sst_and_waves() {
        let rows = rows("41122");
        let first: Vec<&ReadingRow> = rows.iter().filter(|r| r.observed_at == at("2026-09-30 20:00")).collect();
        let get = |p: Param| first.iter().find(|r| r.param == p).unwrap().value;
        assert_eq!(get(Param::SstC), Some(29.7));
        assert_eq!(get(Param::WaveM), Some(1.1));
        assert_eq!(get(Param::AirC), Some(27.6));
        assert_eq!(get(Param::WindMs), None);
        // The ranged body ends mid-line ("2026 09 29 01"); that partial line is dropped.
        let last = rows.iter().map(|r| r.observed_at).min().unwrap();
        assert_eq!(last, at("2026-09-29 01:30"));
    }

    #[test]
    fn ndbc_fixture_enp_station_is_water_c() {
        let rows = rows("BDVF1");
        assert!(rows.iter().all(|r| r.param != Param::SstC));
        let w = rows.iter().find(|r| r.param == Param::WaterC && r.observed_at == at("2026-09-30 19:00")).unwrap();
        assert_eq!(w.value, Some(28.2));
    }

    #[test]
    fn ndbc_rejects_non_realtime2_body() {
        assert!(normalize_txt(station("SMKF1").unwrap(), b"<html>404 Not Found</html>\n", RECORDED_AT).is_err());
        // A full 45-day file (server ignored Range) is read back only MAX_AGE_MS.
        let later = RECORDED_AT + 5 * 24 * 3600 * 1000;
        assert!(normalize_txt(station("SMKF1").unwrap(), &fixture("ndbc/SMKF1.txt"), later).unwrap().is_empty());
    }

    #[tokio::test]
    async fn ndbc_idempotent() {
        let payloads = ["SMKF1", "41122", "BDVF1", "KYWF1"]
            .iter()
            .map(|id| recorded(&station_url(id), "text/plain", fixture(&format!("ndbc/{id}.txt")), 206, RECORDED_AT))
            .collect();
        let (state, first) = assert_idempotent(FakeFetch { inner: Ndbc::new(), payloads }).await;
        assert_eq!(first.len(), 4);
        let stations: i64 =
            state.obs.read(|c| c.query_row("select count(*) from stations where kind = 'buoy'", [], |r| r.get(0))).await.unwrap();
        assert_eq!(stations, 4);
    }
}
