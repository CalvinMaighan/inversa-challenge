//! USGS Water Services instantaneous values (T8, PRD §2), every 15 min, over the Everglades
//! box `-81.5,25.0,-80.2,26.5`.
//!
//! Parameter codes (NWIS parameter code dictionary):
//! - `00065` gage height, ft: `stage_m`, converted to metres;
//! - `62615` lake/reservoir water surface elevation above NAVD 1988, ft, and
//!   `62614` the same above NGVD 1929: `stage_m` only at sites without a gage height, NAVD 88
//!   preferred, so one site never reports two stages for one instant;
//! - `00010` water temperature, °C: `water_c`.
//!
//! Requests: the IV service's `bBox` search is slow (13-48 s measured on 2026-09-30) and often
//! answers 503, while the same data by `sites=` list returns in 2-8 s. So the site list is
//! discovered from the site service with the same box and parameters (0.4 s, 143 sites on
//! 2026-09-30), cached for a day, and the IV query names those sites, 100 per request. If
//! discovery fails with no cached list, the plain `bBox` IV query is used.
//!
//! The first poll takes the last 3 h of values for every series. Later polls pass
//! `modifiedSince` (the time since the last committed poll, plus slack), so only series that
//! changed come back. Values older than 30 days (dead sensors that are still "active") are skipped;
//! `-999999` and unparseable values are kept as missing.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::Context;
use async_trait::async_trait;
use serde_json::Value;

use crate::ingest::governor;
use crate::ingest::poll::physical::{self, parse_num, parse_rfc3339_ms, reading, FEET_TO_M};
use crate::ingest::source::{FetchCtx, Mode, RawPayload, Source, SourceInfo};
use crate::model::{Origin, Param, Row, StationKind, StationRef};

pub const IV_URL: &str = "https://waterservices.usgs.gov/nwis/iv/?format=json";
pub const BBOX: &str = "-81.5,25.0,-80.2,26.5";
pub const PARAMETERS: &str = "00065,62614,62615,00010";
pub const SITE_URL: &str = "https://waterservices.usgs.gov/nwis/site/?format=rdb&bBox=-81.5,25.0,-80.2,26.5&parameterCd=00065,62614,62615,00010&siteStatus=active&hasDataTypeCd=iv";

const STALE_AFTER_MS: i64 = 30 * 24 * 3600 * 1000;
/// Default history window per poll, minutes.
const PERIOD_MIN: i64 = 180;
/// Longest catch-up window after downtime, minutes (7 days).
const PERIOD_MAX: i64 = 7 * 24 * 60;
/// Tries per request for a bare 5xx (no Retry-After), 3 s then 6 s ... apart.
const TRANSIENT_ATTEMPTS: u32 = 5;
const SITES_PER_REQUEST: usize = 100;
const SITES_TTL: Duration = Duration::from_secs(24 * 3600);

pub struct Usgs {
    sites: Mutex<Option<(Vec<String>, Instant)>>,
}

impl Usgs {
    pub fn new() -> Self {
        Usgs { sites: Mutex::new(None) }
    }
}

impl Default for Usgs {
    fn default() -> Self {
        Self::new()
    }
}

/// `&period=...[&modifiedSince=...]` given the last committed poll time (unix ms), if any.
pub fn time_params(last_poll_ms: Option<i64>, now_ms: i64) -> String {
    match last_poll_ms.map(|t| (now_ms - t).max(0) / 60_000) {
        // Recent cursor: only series modified since, with enough history to cover the gap.
        Some(gap) if gap <= 24 * 60 => {
            let period = (gap + 60).clamp(PERIOD_MIN, PERIOD_MAX);
            format!("&period=PT{period}M&modifiedSince=PT{}M", gap + 15)
        }
        Some(gap) => format!("&period=PT{}M", (gap + 60).clamp(PERIOD_MIN, PERIOD_MAX)),
        None => format!("&period=PT{PERIOD_MIN}M"),
    }
}

/// IV request URLs: by site list when known (chunked), else by box.
pub fn request_urls(sites: Option<&[String]>, last_poll_ms: Option<i64>, now_ms: i64) -> Vec<String> {
    let time = time_params(last_poll_ms, now_ms);
    match sites {
        Some(sites) if !sites.is_empty() => sites
            .chunks(SITES_PER_REQUEST)
            .map(|chunk| format!("{IV_URL}&sites={}&parameterCd={PARAMETERS}&siteStatus=active{time}", chunk.join(",")))
            .collect(),
        _ => vec![format!("{IV_URL}&bBox={BBOX}&parameterCd={PARAMETERS}&siteStatus=active{time}")],
    }
}

/// Site numbers from the site service's RDB (tab-separated, `#` comments, a header line and
/// a column-format line).
pub fn parse_site_rdb(text: &str) -> Vec<String> {
    let mut lines = text.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty());
    let Some(header) = lines.next() else { return Vec::new() };
    let Some(col) = header.split('\t').position(|c| c == "site_no") else { return Vec::new() };
    let _format = lines.next();
    let mut sites: Vec<String> = lines
        .filter_map(|l| l.split('\t').nth(col))
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        .map(String::from)
        .collect();
    sites.sort_unstable();
    sites.dedup();
    sites
}

/// GET with retries for bare 5xx answers; anything else goes straight to the governor.
async fn get_with_retry(http: &reqwest::Client, url: &str) -> anyhow::Result<reqwest::Response> {
    let mut attempt = 1;
    loop {
        let res = http.get(url).send().await.context("usgs request")?;
        match governor::check_response(res) {
            Ok(res) => return Ok(res),
            Err(e) if e.status >= 500 && e.retry_after.is_none() && attempt < TRANSIENT_ATTEMPTS => {
                tracing::debug!(source = "usgs", attempt, "transient HTTP {}, retrying", e.status);
                tokio::time::sleep(Duration::from_secs(3 * attempt as u64)).await;
                attempt += 1;
            }
            Err(e) => return Err(e.into()),
        }
    }
}

impl Usgs {
    /// Cached site list, refreshed daily; a failed refresh keeps the stale list.
    async fn sites(&self, http: &reqwest::Client) -> Option<Vec<String>> {
        let cached = self.sites.lock().expect("sites").clone();
        if let Some((sites, at)) = &cached {
            if at.elapsed() < SITES_TTL {
                return Some(sites.clone());
            }
        }
        let fresh = async {
            let res = get_with_retry(http, SITE_URL).await?;
            let text = res.text().await.context("usgs site body")?;
            let sites = parse_site_rdb(&text);
            anyhow::ensure!(!sites.is_empty(), "usgs site service returned no sites");
            Ok::<_, anyhow::Error>(sites)
        }
        .await;
        match fresh {
            Ok(sites) => {
                *self.sites.lock().expect("sites") = Some((sites.clone(), Instant::now()));
                Some(sites)
            }
            Err(e) => {
                tracing::warn!(source = "usgs", "site discovery failed: {e:#}");
                cached.map(|(sites, _)| sites)
            }
        }
    }
}

#[async_trait]
impl Source for Usgs {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: "usgs",
            name: "USGS Water Services (instantaneous values)",
            homepage: "https://waterservices.usgs.gov/docs/instantaneous-values/",
            mode: Mode::Poll,
            cadence: Duration::from_secs(15 * 60),
            // Gages transmit hourly over GOES DCS; 3 h without a new value is lagging.
            max_latency: Duration::from_secs(3 * 3600),
        }
    }

    async fn fetch(&self, ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
        let http = &ctx.state.http;
        let now = physical::now_ms();
        let last = ctx.cursor.as_deref().and_then(physical::parse_rfc3339_ms);
        let sites = self.sites(http).await;
        let urls = request_urls(sites.as_deref(), last, now);
        let mut out = Vec::with_capacity(urls.len());
        for url in &urls {
            let res = get_with_retry(http, url).await?;
            let status = res.status().as_u16();
            let content_type = physical::content_type(&res, "application/json");
            let bytes = res.bytes().await.context("usgs iv body")?.to_vec();
            let mut raw = physical::payload(url, &content_type, bytes, status, None);
            raw.fetched_at = now;
            out.push(raw);
        }
        // The cursor advances only with the last payload, once every chunk is committed.
        if let Some(last) = out.last_mut() {
            last.next_cursor = chrono::DateTime::from_timestamp_millis(now).map(|t| t.to_rfc3339());
        }
        Ok(out)
    }

    fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
        normalize_iv(&raw.bytes, raw.fetched_at)
    }
}

fn param_of(code: &str) -> Option<Param> {
    match code {
        "00065" | "62614" | "62615" => Some(Param::StageM),
        "00010" => Some(Param::WaterC),
        _ => None,
    }
}

/// Stage codes in preference order.
const STAGE_CODES: [&str; 3] = ["00065", "62615", "62614"];

pub fn normalize_iv(bytes: &[u8], fetched_at: i64) -> anyhow::Result<Vec<Row>> {
    let doc: Value = serde_json::from_slice(bytes).context("usgs iv json")?;
    let series = doc["value"]["timeSeries"].as_array().context("usgs iv: no value.timeSeries")?;

    // Per site, the stage code to use: the most preferred one present.
    let mut stage_code: HashMap<&str, &str> = HashMap::new();
    for ts in series {
        let (Some(site), Some(code)) = (ts["sourceInfo"]["siteCode"][0]["value"].as_str(), ts["variable"]["variableCode"][0]["value"].as_str())
        else {
            continue;
        };
        if let Some(rank) = STAGE_CODES.iter().position(|c| *c == code) {
            let better = stage_code.get(site).is_none_or(|cur| rank < STAGE_CODES.iter().position(|c| c == cur).unwrap_or(usize::MAX));
            if better {
                stage_code.insert(site, STAGE_CODES[rank]);
            }
        }
    }

    let mut rows = Vec::new();
    let mut seen: HashSet<(String, &'static str, i64)> = HashSet::new();
    for ts in series {
        let info = &ts["sourceInfo"];
        let var = &ts["variable"];
        let (Some(site), Some(code)) = (info["siteCode"][0]["value"].as_str(), var["variableCode"][0]["value"].as_str()) else {
            continue;
        };
        let Some(param) = param_of(code) else { continue };
        if param == Param::StageM && stage_code.get(site) != Some(&code) {
            continue;
        }
        let geo = &info["geoLocation"]["geogLocation"];
        let (Some(lat), Some(lon)) = (geo["latitude"].as_f64(), geo["longitude"].as_f64()) else { continue };
        let name = info["siteName"].as_str().unwrap_or(site).trim().to_string();
        let no_data = var["noDataValue"].as_f64();
        let unit = var["unit"]["unitCode"].as_str().unwrap_or_default().to_ascii_lowercase();
        let convert = |v: f64| -> f64 {
            match (param, unit.as_str()) {
                (Param::StageM, "ft") => v * FEET_TO_M,
                (Param::WaterC, "deg f") => (v - 32.0) * 5.0 / 9.0,
                _ => v,
            }
        };
        let blocks = ts["values"].as_array().map(Vec::as_slice).unwrap_or_default();
        for (i, block) in blocks.iter().enumerate() {
            // Several sensors (methods) at one site: the first is the site's station, the rest
            // get their own station so their values never overwrite each other.
            let station = if i == 0 {
                StationRef { ext_id: site.to_string(), name: name.clone(), lat, lon, kind: StationKind::Gage }
            } else {
                let method = &block["method"][0];
                let method_id = method["methodID"].as_i64().map(|m| m.to_string()).unwrap_or_else(|| i.to_string());
                let desc = method["methodDescription"].as_str().map(str::trim).filter(|d| !d.is_empty());
                StationRef {
                    ext_id: format!("{site}:{method_id}"),
                    name: match desc {
                        Some(d) => format!("{name} ({d})"),
                        None => format!("{name} (sensor {method_id})"),
                    },
                    lat,
                    lon,
                    kind: StationKind::Gage,
                }
            };
            for v in block["value"].as_array().map(Vec::as_slice).unwrap_or_default() {
                let Some(at) = v["dateTime"].as_str().and_then(parse_rfc3339_ms) else { continue };
                if at < fetched_at - STALE_AFTER_MS {
                    continue;
                }
                if !seen.insert((station.ext_id.clone(), param.as_str(), at)) {
                    continue;
                }
                let value = v["value"].as_str().and_then(parse_num).filter(|x| Some(*x) != no_data && *x > -999_000.0).map(convert);
                rows.push(reading(&station, param, value, at, Origin::Measured));
            }
        }
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::poll::physical::testing::{assert_idempotent, fixture, recorded, FakeFetch};
    use crate::model::{Flag, ReadingRow};

    const FIXTURE: &str = "usgs/iv.json";
    /// 2026-09-30T20:33:05Z, the fixture's requestDT.
    const RECORDED_AT: i64 = 1_790_800_385_000;

    fn readings() -> Vec<ReadingRow> {
        normalize_iv(&fixture(FIXTURE), RECORDED_AT)
            .unwrap()
            .into_iter()
            .map(|r| match r {
                Row::Reading(r) => r,
                other => panic!("{other:?}"),
            })
            .collect()
    }

    fn find<'a>(rows: &'a [ReadingRow], ext: &str, param: Param) -> Vec<&'a ReadingRow> {
        rows.iter().filter(|r| r.station.ext_id == ext && r.param == param).collect()
    }

    #[test]
    fn usgs_fixture_converts_units_and_kinds() {
        let rows = readings();
        assert!(rows.iter().all(|r| r.station.kind == StationKind::Gage && r.origin == Origin::Measured));
        // Hillsboro Canal at S-6: 10.65 ft.
        let s6 = find(&rows, "02281200", Param::StageM);
        assert_eq!(s6.len(), 1);
        assert!((s6[0].value.unwrap() - 10.65 * 0.3048).abs() < 1e-9);
        assert_eq!(s6[0].observed_at, parse_rfc3339_ms("2026-09-30T16:00:00.000-04:00").unwrap());
        assert_eq!(s6[0].station.lat, 26.47285);
        // Black Creek canal: stage and water temperature on one station.
        assert_eq!(find(&rows, "0229070825", Param::WaterC)[0].value, Some(27.8));
        assert_eq!(find(&rows, "0229070825", Param::StageM).len(), 1);
    }

    #[test]
    fn usgs_fixture_lake_elevation_prefers_navd88() {
        let rows = readings();
        // Lake Trafford reports 62614 (NGVD29, 19.34 ft) and 62615 (NAVD88, 17.98 ft); one stage.
        let lake = find(&rows, "02291200", Param::StageM);
        assert_eq!(lake.len(), 1);
        assert!((lake[0].value.unwrap() - 17.98 * 0.3048).abs() < 1e-9);
    }

    #[test]
    fn usgs_fixture_multi_sensor_sites_get_distinct_stations() {
        let rows = readings();
        // S-12-B has two gage-height sensors (downstream/upstream).
        let mut ids: Vec<&str> = rows.iter().filter(|r| r.station.ext_id.starts_with("02289019")).map(|r| r.station.ext_id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 2, "{ids:?}");
        assert!(ids.contains(&"02289019"));
        let keys: HashSet<(String, &str, i64)> = rows.iter().map(|r| (r.station.ext_id.clone(), r.param.as_str(), r.observed_at)).collect();
        assert_eq!(keys.len(), rows.len(), "no primary-key collisions");
    }

    #[test]
    fn usgs_fixture_missing_and_stale() {
        let rows = readings();
        // G-3913 reported -999999 in 2024: stale, skipped.
        assert!(find(&rows, "254155080243502", Param::WaterC).is_empty());
        // North River water temp last reported 2024-09-09: stale, skipped; its stage is current.
        assert!(find(&rows, "022908205", Param::WaterC).is_empty());
        assert_eq!(find(&rows, "022908205", Param::StageM).len(), 1);
        // A fresh -999999 is kept as missing.
        let mut doc: Value = serde_json::from_slice(&fixture(FIXTURE)).unwrap();
        doc["value"]["timeSeries"][0]["values"][0]["value"][0]["value"] = Value::from("-999999");
        let rows = normalize_iv(doc.to_string().as_bytes(), RECORDED_AT).unwrap();
        let Row::Reading(r) = &rows[0] else { panic!() };
        assert_eq!((r.value, r.flag), (None, Flag::Missing));
    }

    #[test]
    fn usgs_request_urls_use_modified_since() {
        let now = 1_790_800_000_000;
        assert_eq!(time_params(None, now), "&period=PT180M");
        assert_eq!(time_params(Some(now - 15 * 60_000), now), "&period=PT180M&modifiedSince=PT30M");
        assert_eq!(time_params(Some(now - 10 * 3_600_000), now), "&period=PT660M&modifiedSince=PT615M");
        assert_eq!(time_params(Some(now - 30 * 24 * 3_600_000), now), "&period=PT10080M");

        let by_box = request_urls(None, None, now);
        assert_eq!(
            by_box,
            ["https://waterservices.usgs.gov/nwis/iv/?format=json&bBox=-81.5,25.0,-80.2,26.5&parameterCd=00065,62614,62615,00010&siteStatus=active&period=PT180M"]
        );
        let sites: Vec<String> = (0..143).map(|i| format!("{:08}", 2_290_000 + i)).collect();
        let by_site = request_urls(Some(&sites), Some(now - 15 * 60_000), now);
        assert_eq!(by_site.len(), 2, "100 sites per request");
        assert!(by_site[0].contains("&sites=02290000,02290001,") && by_site[1].contains(",02290142&parameterCd="));
        assert!(by_site.iter().all(|u| u.ends_with("&modifiedSince=PT30M")));
    }

    #[test]
    fn usgs_site_rdb_fixture() {
        let sites = parse_site_rdb(&crate::ingest::poll::physical::testing::fixture_str("usgs/site.rdb"));
        assert_eq!(sites.len(), 143);
        assert!(sites.contains(&"02290769".to_string()) && sites.contains(&"251003080435500".to_string()));
        assert!(parse_site_rdb("# nothing\n").is_empty());
    }

    #[tokio::test]
    async fn usgs_idempotent() {
        let url = request_urls(None, None, RECORDED_AT).remove(0);
        let raw = recorded(&url, "application/json", fixture(FIXTURE), 200, RECORDED_AT);
        let (_, first) = assert_idempotent(FakeFetch { inner: Usgs::new(), payloads: vec![raw] }).await;
        assert!(first[0].rows_written > 20, "{:?}", first[0]);
    }
}
