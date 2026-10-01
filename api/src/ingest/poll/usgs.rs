//! USGS Water Data, OGC API `continuous` collection (T8, PRD §2; leaf C4), every 15 min.
//! The legacy `waterservices.usgs.gov` IV service goes away in winter 2027 (docs/ingest-modes.md
//! P11), so both apps that list `usgs` query the OGC API; what differs is the config:
//!
//! - carp (`kind=conditions`): ONE batched request per poll naming every `locations[].usgs`
//!   site (`monitoring_location_id=USGS-a,USGS-b,...`) for `params.parameters` (stage `00065`
//!   and discharge `00060`). Station names come from the config.
//! - python (`kind=species`): one request per region `bbox` for its parameters (`00065`,
//!   `62614`, `62615`, `00010`). Names come from the `monitoring-locations` collection, looked
//!   up by id for the sites seen and cached for a day; a replay without the cache names a
//!   station `USGS <number>`.
//!
//! Parameter codes (NWIS parameter code dictionary):
//! - `00065` gage height, ft: `stage_m`, converted to metres;
//! - `62615` lake/reservoir water surface elevation above NAVD 1988, ft, and
//!   `62614` the same above NGVD 1929: `stage_m` only at sites without a gage height, NAVD 88
//!   preferred, so one site never reports two stages for one instant;
//! - `00060` discharge, ft^3/s: `discharge_cfs`, as reported (never converted to kcfs here);
//! - `00010` water temperature, °C: `water_c`.
//!
//! Each poll asks for the last 3 h (more after downtime, up to 7 days: the cursor is the last
//! committed poll time) and follows `next` links (`limit=10000` rows a page). Values older than
//! 30 days are skipped; `-999999` and null are kept as missing. The OGC API sends no validator
//! (`cache-control: no-store`), so every poll is a full fetch. Anonymous use is rate limited per
//! IP; `USGS_API_KEY` (free, api.waterdata.usgs.gov/signup) is sent as `X-Api-Key` when set.
//! 429 and 5xx answers carry `Retry-After` into the governor ([`governor::check_response`]).
//!
//! The legacy IV JSON (`value.timeSeries`) still normalizes ([`normalize_iv`]): the recorded
//! python fixture and the cold-snap scene replay through it.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Context;
use async_trait::async_trait;
use serde_json::Value;

use crate::app::config::{App, BBox};
use crate::ingest::governor;
use crate::ingest::poll::physical::{self, parse_num, parse_rfc3339_ms, reading, FEET_TO_M};
use crate::ingest::source::{FetchCtx, Mode, RawPayload, Source, SourceInfo};
use crate::model::{Origin, Param, Row, StationKind, StationRef};
use crate::state::Config;

pub const SOURCE_ID: &str = "usgs";
pub const OGC: &str = "https://api.waterdata.usgs.gov/ogcapi/v1/collections";
/// Default parameters when the feed's `params.parameters` is absent (the carp gauges).
pub const DEFAULT_PARAMETERS: [&str; 2] = ["00065", "00060"];
pub const PAGE_LIMIT: u32 = 10_000;
/// Pages followed per request before giving up (a 7-day catch-up of 8 sites is 2 pages).
const MAX_PAGES: usize = 20;

const STALE_AFTER_MS: i64 = 30 * 24 * 3600 * 1000;
/// Default history window per poll, minutes.
const PERIOD_MIN: i64 = 180;
/// Longest catch-up window after downtime, minutes (7 days).
const PERIOD_MAX: i64 = 7 * 24 * 60;
/// Tries per request for a bare 5xx (no Retry-After), 3 s then 6 s ... apart.
const TRANSIENT_ATTEMPTS: u32 = 5;
const NAMES_TTL: Duration = Duration::from_secs(24 * 3600);
/// Pause between the requests of one poll (regions, pages).
const POLITE_GAP: Duration = Duration::from_millis(300);

/// What one poll asks for.
#[derive(Debug, Clone, PartialEq)]
pub enum Query {
    /// The configured gauges: `(site number, name, lat, lon)`.
    Sites(Vec<(String, String, f64, f64)>),
    /// Every gauge in the regions.
    Boxes(Vec<BBox>),
}

pub struct Usgs {
    query: Query,
    parameters: Vec<String>,
    api_key: Option<String>,
    /// `backfill --days N`: ask for N days of history instead of the poll window.
    history_days: Option<u32>,
    /// Site number to name, learned from `monitoring-locations` (box mode).
    names: Mutex<Option<(HashMap<String, String>, Instant)>>,
}

impl Usgs {
    pub fn new(config: &Config, app: Arc<App>) -> Self {
        let params = app.cfg.feed(SOURCE_ID).map(|f| f.params.clone()).unwrap_or_default();
        let parameters: Vec<String> = params
            .get("parameters")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .filter(|v: &Vec<String>| !v.is_empty())
            .unwrap_or_else(|| DEFAULT_PARAMETERS.iter().map(|s| s.to_string()).collect());
        let sites: Vec<(String, String, f64, f64)> =
            app.cfg.locations.iter().filter_map(|l| l.usgs.clone().map(|u| (u, l.name.clone(), l.lat, l.lon))).collect();
        let query = if sites.is_empty() { Query::Boxes(physical::region_boxes(&app)) } else { Query::Sites(sites) };
        Usgs { query, parameters, api_key: config.usgs_api_key.clone(), history_days: None, names: Mutex::new(None) }
    }

    /// A one-off history pull of `days` days (`backfill --days N`), paged like a poll.
    pub fn with_history_days(mut self, days: u32) -> Self {
        self.history_days = Some(days.clamp(1, 120));
        self
    }

    #[cfg(test)]
    pub fn for_tests(app: Arc<App>) -> Self {
        Usgs::new(&Config::for_tests(), app)
    }

    #[cfg(test)]
    pub fn query(&self) -> &Query {
        &self.query
    }

    /// `&time=PT...M`: the history window given the last committed poll time (unix ms), if any.
    pub fn time_param(last_poll_ms: Option<i64>, now_ms: i64) -> String {
        let minutes = match last_poll_ms.map(|t| (now_ms - t).max(0) / 60_000) {
            Some(gap) => (gap + 60).clamp(PERIOD_MIN, PERIOD_MAX),
            None => PERIOD_MIN,
        };
        format!("&time=PT{minutes}M")
    }

    /// The first page of every request this poll makes (one per site batch or per region).
    pub fn request_urls(&self, last_poll_ms: Option<i64>, now_ms: i64) -> Vec<String> {
        let time = match self.history_days {
            Some(days) => format!("&time=P{days}D"),
            None => Self::time_param(last_poll_ms, now_ms),
        };
        let codes = self.parameters.join(",");
        match &self.query {
            Query::Sites(sites) => {
                let ids: Vec<String> = sites.iter().map(|(s, ..)| format!("USGS-{s}")).collect();
                vec![format!("{OGC}/continuous/items?f=json&monitoring_location_id={}&parameter_code={codes}{time}&limit={PAGE_LIMIT}", ids.join(","))]
            }
            Query::Boxes(boxes) => boxes
                .iter()
                .map(|b| format!("{OGC}/continuous/items?f=json&bbox={},{},{},{}&parameter_code={codes}{time}&limit={PAGE_LIMIT}", b.west, b.south, b.east, b.north))
                .collect(),
        }
    }

    fn site_name(&self, site: &str) -> Option<String> {
        match &self.query {
            Query::Sites(sites) => sites.iter().find(|(s, ..)| s == site).map(|(_, n, ..)| n.clone()),
            Query::Boxes(_) => self.names.lock().expect("names").as_ref().and_then(|(m, _)| m.get(site).cloned()),
        }
    }

    /// Box mode: learn the names of the sites in `payloads` from `monitoring-locations`, at most
    /// daily. A failed lookup keeps the old names; a missing name falls back to `USGS <number>`.
    async fn learn_names(&self, http: &reqwest::Client, payloads: &[RawPayload]) {
        if matches!(self.query, Query::Sites(_)) {
            return;
        }
        let fresh = self.names.lock().expect("names").as_ref().is_some_and(|(_, at)| at.elapsed() < NAMES_TTL);
        if fresh {
            return;
        }
        let mut sites = BTreeMap::new();
        for raw in payloads {
            if let Ok(doc) = serde_json::from_slice::<Value>(&raw.bytes) {
                for f in doc["features"].as_array().map(Vec::as_slice).unwrap_or_default() {
                    if let Some(id) = f["properties"]["monitoring_location_id"].as_str() {
                        sites.insert(id.to_string(), ());
                    }
                }
            }
        }
        if sites.is_empty() {
            return;
        }
        let mut names = HashMap::new();
        for chunk in sites.keys().cloned().collect::<Vec<_>>().chunks(200) {
            let url = format!("{OGC}/monitoring-locations/items?f=json&id={}&limit={}&skipGeometry=true", chunk.join(","), chunk.len());
            match self.get_with_retry(http, &url).await {
                Ok(res) => match res.bytes().await.ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
                    Some(doc) => {
                        for f in doc["features"].as_array().map(Vec::as_slice).unwrap_or_default() {
                            let p = &f["properties"];
                            if let (Some(n), Some(name)) = (p["monitoring_location_number"].as_str(), p["monitoring_location_name"].as_str()) {
                                names.insert(n.to_string(), name.trim().to_string());
                            }
                        }
                    }
                    None => tracing::warn!(source = SOURCE_ID, "monitoring-locations: unreadable body"),
                },
                Err(e) => {
                    tracing::warn!(source = SOURCE_ID, "monitoring-locations lookup failed: {e:#}");
                    return;
                }
            }
            tokio::time::sleep(POLITE_GAP).await;
        }
        *self.names.lock().expect("names") = Some((names, Instant::now()));
    }

    /// GET with retries for bare 5xx answers; anything else (429 with `Retry-After`, 4xx) goes
    /// straight to the governor.
    async fn get_with_retry(&self, http: &reqwest::Client, url: &str) -> anyhow::Result<reqwest::Response> {
        let mut attempt = 1;
        loop {
            let mut req = http.get(url).header(reqwest::header::ACCEPT, "application/json");
            if let Some(key) = &self.api_key {
                req = req.header("X-Api-Key", key);
            }
            let res = req.send().await.context("usgs request")?;
            match governor::check_response(res) {
                Ok(res) => return Ok(res),
                Err(e) if e.status >= 500 && e.retry_after.is_none() && attempt < TRANSIENT_ATTEMPTS => {
                    tracing::debug!(source = SOURCE_ID, attempt, "transient HTTP {}, retrying", e.status);
                    tokio::time::sleep(Duration::from_secs(3 * attempt as u64)).await;
                    attempt += 1;
                }
                Err(e) => return Err(e.into()),
            }
        }
    }
}

/// The `next` page link of an OGC items page, if any.
pub fn next_link(bytes: &[u8]) -> Option<String> {
    let doc: Value = serde_json::from_slice(bytes).ok()?;
    doc["links"].as_array()?.iter().find(|l| l["rel"].as_str() == Some("next")).and_then(|l| l["href"].as_str()).map(String::from)
}

#[async_trait]
impl Source for Usgs {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: SOURCE_ID,
            name: "USGS Water Data (OGC API, continuous)",
            homepage: "https://api.waterdata.usgs.gov/docs/ogcapi/",
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
        let mut out = Vec::new();
        for (i, first) in self.request_urls(last, now).into_iter().enumerate() {
            let mut url = Some(first);
            let mut pages = 0;
            while let Some(u) = url.take() {
                if i > 0 || pages > 0 {
                    tokio::time::sleep(POLITE_GAP).await;
                }
                let res = self.get_with_retry(http, &u).await?;
                let status = res.status().as_u16();
                let content_type = physical::content_type(&res, "application/json");
                let bytes = res.bytes().await.context("usgs body")?.to_vec();
                pages += 1;
                if pages < MAX_PAGES {
                    url = next_link(&bytes);
                }
                let mut raw = physical::payload(&u, &content_type, bytes, status, None);
                raw.fetched_at = now;
                out.push(raw);
            }
        }
        self.learn_names(http, &out).await;
        // The cursor advances only with the last payload, once every page is committed.
        if let Some(last) = out.last_mut() {
            last.next_cursor = chrono::DateTime::from_timestamp_millis(now).map(|t| t.to_rfc3339());
        }
        Ok(out)
    }

    fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
        let doc: Value = serde_json::from_slice(&raw.bytes).context("usgs json")?;
        if doc["value"]["timeSeries"].is_array() {
            return normalize_iv_doc(&doc, raw.fetched_at);
        }
        normalize_ogc(&doc, raw.fetched_at, &|site| self.site_name(site))
    }
}

fn param_of(code: &str) -> Option<Param> {
    match code {
        "00065" | "62614" | "62615" => Some(Param::StageM),
        "00060" => Some(Param::DischargeCfs),
        "00010" => Some(Param::WaterC),
        _ => None,
    }
}

/// Stage codes in preference order.
const STAGE_CODES: [&str; 3] = ["00065", "62615", "62614"];

fn stage_rank(code: &str) -> usize {
    STAGE_CODES.iter().position(|c| *c == code).unwrap_or(usize::MAX)
}

/// Value conversion to the stored unit (`stage_m` metres, `water_c` °C, `discharge_cfs` cfs).
fn convert(param: Param, unit: &str, v: f64) -> f64 {
    match (param, unit) {
        (Param::StageM, "ft") => v * FEET_TO_M,
        (Param::WaterC, "deg f" | "degf") => (v - 32.0) * 5.0 / 9.0,
        _ => v,
    }
}

/// A USGS value string: null, unparseable, `-999999` (no value) and NaN are missing.
fn feed_value(v: &Value, no_data: Option<f64>) -> Option<f64> {
    let x = match v {
        Value::String(s) => parse_num(s)?,
        Value::Number(n) => n.as_f64()?,
        _ => return None,
    };
    (Some(x) != no_data && x > -999_000.0).then_some(x)
}

/// Pure: an OGC `continuous` items page to readings. `name_of` names a site number (config or
/// the learned names); unknown sites are `USGS <number>`. Per site the most preferred stage code
/// present wins; a second time series of one (site, parameter) is its own station
/// `<site>:<series>` so two sensors never overwrite each other.
pub fn normalize_ogc(doc: &Value, fetched_at: i64, name_of: &dyn Fn(&str) -> Option<String>) -> anyhow::Result<Vec<Row>> {
    let features = doc["features"].as_array().context("usgs ogc: no features")?;
    // (site, code, series) → (lat, lon, unit, [(time, value)])
    type Series = BTreeMap<(String, String, String), (f64, f64, String, Vec<(i64, Option<f64>)>)>;
    let mut series: Series = BTreeMap::new();
    for f in features {
        let p = &f["properties"];
        let (Some(id), Some(code), Some(t)) = (p["monitoring_location_id"].as_str(), p["parameter_code"].as_str(), p["time"].as_str()) else {
            continue;
        };
        let site = id.strip_prefix("USGS-").unwrap_or(id).to_string();
        if param_of(code).is_none() {
            continue;
        }
        let Some(at) = parse_rfc3339_ms(t) else { continue };
        if at < fetched_at - STALE_AFTER_MS {
            continue;
        }
        let ts = p["time_series_id"].as_str().unwrap_or_default().to_string();
        let coords = &f["geometry"]["coordinates"];
        let (lon, lat) = (coords[0].as_f64().unwrap_or(f64::NAN), coords[1].as_f64().unwrap_or(f64::NAN));
        let unit = p["unit_of_measure"].as_str().unwrap_or_default().to_ascii_lowercase();
        let entry = series.entry((site, code.to_string(), ts)).or_insert_with(|| (lat, lon, unit, Vec::new()));
        entry.3.push((at, feed_value(&p["value"], None)));
    }
    // Per site, the stage code to use.
    let mut stage_code: HashMap<&str, &str> = HashMap::new();
    for (site, code, _) in series.keys() {
        if stage_rank(code) < usize::MAX && stage_code.get(site.as_str()).is_none_or(|cur| stage_rank(code) < stage_rank(cur)) {
            stage_code.insert(site, code);
        }
    }
    // Per (site, param) the series ids in order, among the series that are stored (the chosen
    // stage code only): the first is the site's station.
    let mut first_series: HashMap<(&str, Param), &str> = HashMap::new();
    for (site, code, ts) in series.keys() {
        if let Some(param) = param_of(code) {
            if param == Param::StageM && stage_code.get(site.as_str()) != Some(&code.as_str()) {
                continue;
            }
            first_series.entry((site, param)).or_insert(ts);
        }
    }
    let mut rows = Vec::new();
    let mut seen: HashSet<(String, &'static str, i64)> = HashSet::new();
    for ((site, code, ts), (lat, lon, unit, values)) in &series {
        let Some(param) = param_of(code) else { continue };
        if param == Param::StageM && stage_code.get(site.as_str()) != Some(&code.as_str()) {
            continue;
        }
        let name = name_of(site).unwrap_or_else(|| format!("USGS {site}"));
        let (lat, lon) = match (lat.is_finite(), lon.is_finite()) {
            (true, true) => (*lat, *lon),
            _ => continue,
        };
        // ponytail: the first series id (sorted) is the site's own station; a sensor added later
        // keeps its suffix. Good enough until a site actually gains a second gage-height series.
        let primary = first_series.get(&(site.as_str(), param)) == Some(&ts.as_str());
        let station = StationRef {
            ext_id: if primary { site.clone() } else { format!("{site}:{}", &ts[..ts.len().min(8)]) },
            name: if primary { name } else { format!("{name} (series {})", &ts[..ts.len().min(8)]) },
            lat,
            lon,
            kind: StationKind::Gage,
        };
        for (at, value) in values {
            if !seen.insert((station.ext_id.clone(), param.as_str(), *at)) {
                continue;
            }
            rows.push(reading(&station, param, value.map(|v| convert(param, unit, v)), *at, Origin::Measured));
        }
    }
    Ok(rows)
}

/// Legacy IV JSON (`value.timeSeries`) to readings; `normalize` sniffs the shape, this is the
/// tests' entry point.
#[cfg(test)]
pub fn normalize_iv(bytes: &[u8], fetched_at: i64) -> anyhow::Result<Vec<Row>> {
    let doc: Value = serde_json::from_slice(bytes).context("usgs iv json")?;
    normalize_iv_doc(&doc, fetched_at)
}

fn normalize_iv_doc(doc: &Value, fetched_at: i64) -> anyhow::Result<Vec<Row>> {
    let series = doc["value"]["timeSeries"].as_array().context("usgs iv: no value.timeSeries")?;

    // Per site, the stage code to use: the most preferred one present.
    let mut stage_code: HashMap<&str, &str> = HashMap::new();
    for ts in series {
        let (Some(site), Some(code)) = (ts["sourceInfo"]["siteCode"][0]["value"].as_str(), ts["variable"]["variableCode"][0]["value"].as_str())
        else {
            continue;
        };
        if stage_rank(code) < usize::MAX && stage_code.get(site).is_none_or(|cur| stage_rank(code) < stage_rank(cur)) {
            stage_code.insert(site, code);
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
                let value = feed_value(&v["value"], no_data).map(|x| convert(param, &unit, x));
                rows.push(reading(&station, param, value, at, Origin::Measured));
            }
        }
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::poll::physical::testing::{assert_idempotent, fixture, python_app, recorded, FakeFetch};
    use crate::model::{Flag, ReadingRow};

    const FIXTURE: &str = "usgs/iv.json";
    /// 2026-09-30T20:33:05Z, the legacy fixture's requestDT.
    const RECORDED_AT: i64 = 1_790_800_385_000;
    const OGC_FIXTURE: &str = "usgs_ogc/continuous.json";
    /// 2026-10-01T07:01:03Z, when the OGC fixture was recorded.
    const OGC_RECORDED_AT: i64 = 1_790_838_063_000;

    fn carp() -> Arc<App> {
        Arc::new(App::builtin("carp").unwrap())
    }

    fn readings() -> Vec<ReadingRow> {
        only_readings(normalize_iv(&fixture(FIXTURE), RECORDED_AT).unwrap())
    }

    fn only_readings(rows: Vec<Row>) -> Vec<ReadingRow> {
        rows.into_iter()
            .map(|r| match r {
                Row::Reading(r) => r,
                other => panic!("{other:?}"),
            })
            .collect()
    }

    fn ogc_readings() -> Vec<ReadingRow> {
        let usgs = Usgs::for_tests(carp());
        let raw = recorded(&usgs.request_urls(None, OGC_RECORDED_AT)[0], "application/json", fixture(OGC_FIXTURE), 200, OGC_RECORDED_AT);
        only_readings(usgs.normalize(&raw).unwrap())
    }

    fn find<'a>(rows: &'a [ReadingRow], ext: &str, param: Param) -> Vec<&'a ReadingRow> {
        rows.iter().filter(|r| r.station.ext_id == ext && r.param == param).collect()
    }

    // ---- OGC (carp and python config) --------------------------------------------------------

    /// Carp: one batched request naming the eight gauges and both parameters; python: one request
    /// per region box with its four parameters. The time window grows with the gap since the
    /// last poll and caps at 7 days.
    #[test]
    fn usgs_ogc_request_is_one_batched_call_per_poll() {
        let now = 1_790_800_000_000;
        let usgs = Usgs::for_tests(carp());
        let Query::Sites(sites) = usgs.query() else { panic!("carp queries by site") };
        assert_eq!(sites.len(), 8);
        let urls = usgs.request_urls(None, now);
        assert_eq!(urls.len(), 1, "ONE request per poll");
        assert_eq!(
            urls[0],
            format!(
                "{OGC}/continuous/items?f=json&monitoring_location_id=USGS-07381490,USGS-07381500,USGS-07381515,USGS-07381600,USGS-07374000,USGS-07355500,USGS-07367005,USGS-02489500&parameter_code=00065,00060&time=PT180M&limit=10000"
            )
        );
        assert_eq!(Usgs::time_param(Some(now - 15 * 60_000), now), "&time=PT180M");
        assert_eq!(Usgs::time_param(Some(now - 10 * 3_600_000), now), "&time=PT660M");
        assert_eq!(Usgs::time_param(Some(now - 30 * 24 * 3_600_000), now), "&time=PT10080M");
        assert!(Usgs::for_tests(carp()).with_history_days(7).request_urls(None, now)[0].ends_with("&time=P7D&limit=10000"), "backfill --days 7");
        // The recorded fixture is the same query over 12 h.
        let manifest: Value = serde_json::from_slice(&fixture("usgs_ogc/manifest.json")).unwrap();
        let recorded_url = manifest["files"][0]["url"].as_str().unwrap();
        assert_eq!(recorded_url.replace("&time=PT12H", "&time=PT180M"), urls[0]);

        let py = Usgs::for_tests(python_app());
        let Query::Boxes(boxes) = py.query() else { panic!("python queries by box") };
        assert_eq!(boxes.len(), 1);
        let urls = py.request_urls(None, now);
        assert_eq!(urls, [format!("{OGC}/continuous/items?f=json&bbox=-83.2,24.3,-79.8,27.5&parameter_code=00065,62614,62615,00010&time=PT180M&limit=10000")]);
        assert!(py.api_key.is_none(), "no USGS_API_KEY in tests");
        assert_eq!(next_link(br#"{"links":[{"rel":"self","href":"a"},{"rel":"next","href":"b"}]}"#).as_deref(), Some("b"));
        assert_eq!(next_link(br#"{"links":[{"rel":"self","href":"a"}]}"#), None);
    }

    /// The recorded page: 8 gauges, stage for all, discharge for 5; values in the stored units
    /// with the config's names; discharge stays in cfs.
    #[test]
    fn usgs_ogc_fixture_readings_per_site_parameter_unit() {
        let rows = ogc_readings();
        assert!(rows.iter().all(|r| r.station.kind == StationKind::Gage && r.origin == Origin::Measured));
        let sites: std::collections::BTreeSet<&str> = rows.iter().map(|r| r.station.ext_id.as_str()).collect();
        assert_eq!(sites.into_iter().collect::<Vec<_>>(), ["02489500", "07355500", "07367005", "07374000", "07381490", "07381500", "07381515", "07381600"]);
        let with_discharge: std::collections::BTreeSet<&str> =
            rows.iter().filter(|r| r.param == Param::DischargeCfs).map(|r| r.station.ext_id.as_str()).collect();
        assert_eq!(with_discharge.into_iter().collect::<Vec<_>>(), ["02489500", "07367005", "07374000", "07381490", "07381600"]);
        for site in ["07381500", "07381515", "07355500"] {
            assert!(find(&rows, site, Param::DischargeCfs).is_empty(), "{site}: no discharge at this gauge");
            assert!(!find(&rows, site, Param::StageM).is_empty());
        }
        // Simmesport 2026-10-01T06:30Z: 7.93 ft stage, 119000 cfs discharge (the recorded values).
        let t = parse_rfc3339_ms("2026-10-01T06:30:00+00:00").unwrap();
        let s = find(&rows, "07381490", Param::StageM).into_iter().find(|r| r.observed_at == t).unwrap();
        assert!((s.value.unwrap() - 7.93 * FEET_TO_M).abs() < 1e-9);
        assert_eq!(s.station.name, "Atchafalaya River at Simmesport");
        assert_eq!((s.station.lat, s.station.lon), (30.9825, -91.7983333333333));
        let d = find(&rows, "07381490", Param::DischargeCfs).into_iter().find(|r| r.observed_at == t).unwrap();
        assert_eq!((d.value, d.flag), (Some(119000.0), Flag::Ok));
        // 15-minute data: about 48 readings per series in 12 h.
        assert!(find(&rows, "07381600", Param::DischargeCfs).len() >= 40);
        let keys: HashSet<(String, &str, i64)> = rows.iter().map(|r| (r.station.ext_id.clone(), r.param.as_str(), r.observed_at)).collect();
        assert_eq!(keys.len(), rows.len(), "no primary-key collisions");
    }

    /// Sentinels and nulls are missing, never numbers; a python-style payload with 62614/62615
    /// at one site keeps one stage (NAVD 88); a second series of one parameter is its own station;
    /// an unknown site without a learned name is `USGS <number>`.
    #[test]
    fn usgs_ogc_missing_values_stage_preference_and_series() {
        let feature = |site: &str, code: &str, ts: &str, t: &str, value: Value, unit: &str| {
            serde_json::json!({"type":"Feature","geometry":{"type":"Point","coordinates":[-81.0,25.5]},
                "properties":{"monitoring_location_id":format!("USGS-{site}"),"parameter_code":code,"time_series_id":ts,"time":t,"value":value,"unit_of_measure":unit}})
        };
        let t = "2026-10-01T06:00:00+00:00";
        let doc = serde_json::json!({"type":"FeatureCollection","features":[
            feature("1", "00065", "a", t, Value::from("-999999"), "ft"),
            feature("1", "00065", "a", "2026-10-01T06:15:00+00:00", Value::Null, "ft"),
            feature("2", "62614", "b", t, Value::from("19.34"), "ft"),
            feature("2", "62615", "c", t, Value::from("17.98"), "ft"),
            feature("3", "00010", "d", t, Value::from("80.6"), "degF"),
            feature("3", "00060", "e", t, Value::from("12.5"), "ft^3/s"),
            feature("3", "00060", "f", t, Value::from("13.5"), "ft^3/s"),
            feature("4", "00065", "g", "2020-01-01T00:00:00+00:00", Value::from("1"), "ft"),
        ]});
        let rows = only_readings(normalize_ogc(&doc, OGC_RECORDED_AT, &|s| (s == "3").then(|| "Three".to_string())).unwrap());
        let one = find(&rows, "1", Param::StageM);
        assert_eq!(one.len(), 2);
        assert!(one.iter().all(|r| r.value.is_none() && r.flag == Flag::Missing), "{one:?}");
        assert_eq!(one[0].station.name, "USGS 1");
        let two = find(&rows, "2", Param::StageM);
        assert_eq!(two.len(), 1);
        assert!((two[0].value.unwrap() - 17.98 * FEET_TO_M).abs() < 1e-9, "NAVD 88 wins");
        let water = find(&rows, "3", Param::WaterC);
        assert!((water[0].value.unwrap() - 27.0).abs() < 1e-9, "degF converted");
        assert_eq!(water[0].station.name, "Three");
        assert_eq!(find(&rows, "3", Param::DischargeCfs)[0].value, Some(12.5));
        assert_eq!(find(&rows, "3:f", Param::DischargeCfs)[0].value, Some(13.5), "second series is its own station");
        assert!(find(&rows, "4", Param::StageM).is_empty(), "older than 30 days: skipped");
    }

    /// 429 with `Retry-After` is a throttled attempt the governor honours; the adapter never
    /// retries it itself (only bare 5xx).
    #[test]
    fn usgs_ogc_429_retry_after_reaches_the_governor() {
        let err = anyhow::Error::from(governor::HttpStatusError { status: 429, retry_after: Some(Duration::from_secs(30)), url: OGC.into() });
        assert_eq!(governor::classify(&err), governor::Attempt::Throttled { status: 429, retry_after: Some(Duration::from_secs(30)) });
        let gov = governor::Governor::new(Duration::from_secs(900));
        let t0 = Instant::now();
        gov.record(governor::Attempt::Throttled { status: 429, retry_after: Some(Duration::from_secs(30)) }, t0);
        assert!(gov.wait(t0) >= Duration::from_secs(30));
    }

    /// Through the pipeline into the carp app: readings land under `usgs` with the config's
    /// station names; a second ingest writes nothing; a gauge not in carp.json is skipped and counted.
    #[tokio::test]
    async fn usgs_ogc_idempotent_and_scoped_to_carp_sites() {
        use crate::app::test_support::test_state_for;
        use crate::ingest::scheduler::ingest_payload;
        let usgs = Usgs::for_tests(carp());
        let url = usgs.request_urls(None, OGC_RECORDED_AT).remove(0);
        let raw = recorded(&url, "application/json", fixture(OGC_FIXTURE), 200, OGC_RECORDED_AT);
        let state = test_state_for("carp");
        let first = ingest_payload(&state, &usgs, raw.clone(), None).await.unwrap();
        assert_eq!((first.rows_skipped, first.error.clone()), (0, None), "{first:?}");
        assert!(first.rows_written > 500, "{first:?}");
        let again = ingest_payload(&state, &usgs, raw, None).await.unwrap();
        assert_eq!(again.rows_written, 0);
        let (stations, params): (i64, String) = state
            .obs
            .read(|c| {
                c.query_row(
                    "select (select count(*) from stations where source_id = 'usgs'),
                            (select group_concat(distinct param) from readings)",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            })
            .await
            .unwrap();
        assert_eq!(stations, 8);
        let mut params: Vec<&str> = params.split(',').collect();
        params.sort_unstable();
        assert_eq!(params, ["discharge_cfs", "stage_m"]);

        // A gauge inside Louisiana but not in carp.json: skipped, counted.
        let mut doc: Value = serde_json::from_slice(&fixture(OGC_FIXTURE)).unwrap();
        doc["features"][0]["properties"]["monitoring_location_id"] = Value::from("USGS-07380000");
        doc["features"][1]["properties"]["value"] = Value::from("9999");
        let raw = recorded(&url, "application/json", doc.to_string().into_bytes(), 200, OGC_RECORDED_AT);
        let out = ingest_payload(&state, &usgs, raw, None).await.unwrap();
        assert_eq!(out.rows_skipped, 2, "one foreign gauge, one implausible stage: {out:?}");
        assert_eq!(out.status, crate::ingest::scheduler::RunStatus::Partial);
    }

    // ---- legacy IV JSON (python fixture and the cold-snap scene) -----------------------------

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

    /// The python adapter still replays its legacy fixture (sniffed by shape) idempotently.
    #[tokio::test]
    async fn usgs_idempotent() {
        let manifest: Value = serde_json::from_slice(&fixture("usgs/manifest.json")).unwrap();
        let url = manifest["files"][0]["url"].as_str().unwrap();
        let raw = recorded(url, "application/json", fixture(FIXTURE), 200, RECORDED_AT);
        let (_, first) = assert_idempotent(FakeFetch { inner: Usgs::for_tests(python_app()), payloads: vec![raw] }).await;
        assert!(first[0].rows_written > 20, "{:?}", first[0]);
    }
}
