//! NOAA Coral Reef Watch reef heat stress (L3; docs/evidence/data-proof.md, docs/ingest-modes.md).
//!
//! Product: CRW CoralTemp v3.1 daily global 5 km (`dhw_5km` on the PacIOOS ERDDAP; NOAA
//! CoastWatch's `NOAA_DHW` redirects there). One griddap JSON request per region of the app with
//! `CRW_SST`, `CRW_SSTANOMALY`, `CRW_DHW`, `CRW_BAA` and `CRW_DHW_mask`, written as readings
//! `sst` (°C), `sst_anomaly` (°C), `dhw` (°C-weeks) and `baa` (0-4), `origin = satellite`, station
//! kind `grid`, `ext_id` = "lat,lon" of the CRW cell centre (3 decimals).
//!
//! ERDDAP details the adapter relies on (`info/dhw_5km/index.csv`, probed 2026-10-01):
//! - axes `[time][latitude][longitude]`; latitude runs north to south, so each request names the
//!   north edge first and strides south; longitude is -180..180 like every app bbox.
//! - cell centres sit at `-89.975 + 0.05 k` (lat) and `-179.975 + 0.05 k` (lon). The app's
//!   environment grid (`5 × cellDeg`, 0.05° for Lionfish Watch, edges on 0.1°) has the same
//!   centres, so the stride is `envCellDeg / 0.05` = 1 and every CRW cell is one env cell.
//! - the time stamp of product day D is `D T12:00:00Z`; that instant is `observed_at`, so the
//!   product date is its UTC date and no local time zone enters.
//! - land, missing and ice pixels share the fill value (null in JSON; `-327.68`, BAA `251` in the
//!   binary forms); `CRW_DHW_mask` tells them apart: 0 water, 1 land, 2 missing, 4 ice.
//!
//! Quality: land cells are skipped (not a reef cell). Masked or invalid values on water cells are
//! `flag = missing` with a null value, never 0. DHW (accumulated) and BAA (current, also needs a
//! HotSpot ≥ 1 °C) are two readings and are never reconciled: Looe Key had DHW 13.65 with BAA 1.
//! Product lag over 3 days is the feed's `stale` state (`max_latency`).
//!
//! Mode: `webhook`. An ERDDAP subscription calls `/v1/lionfish/ingest/nudge/crw/<token>` when the
//! dataset changes; the scheduler also polls every [`BACKSTOP`]. Each fetch first asks for
//! `time[(last)]` (a ~200 byte answer) and stops with an `empty` run when that product day is
//! already stored (the cursor). Otherwise it requests the days after the cursor, at most
//! [`DEFAULT_DAYS`], region by region, one second apart. No rate limit is published; this is a
//! handful of requests per product day.
//!
//! Licence: free to use without restriction; credit NOAA Coral Reef Watch and cite the DOI
//! (`source_pages::CRW_CREDIT`).

use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use async_trait::async_trait;
use serde_json::Value;

use crate::app::config::{App, BBox};
use crate::ingest::governor;
use crate::ingest::poll::physical::{self, reading};
use crate::ingest::source::{FetchCtx, Mode, RawPayload, Source, SourceInfo};
use crate::model::{Origin, Param, Row, StationKind, StationRef};

pub const SOURCE_ID: &str = "crw";
/// The griddap JSON endpoint; the feed's `params.erddap` overrides it.
pub const ERDDAP_JSON: &str = "https://pae-paha.pacioos.hawaii.edu/erddap/griddap/dhw_5km.json";
/// CRW grid spacing and the first cell centre on each axis.
pub const CELL_DEG: f64 = 0.05;
const LAT0: f64 = -89.975;
const LON0: f64 = -179.975;
/// Poll interval when no nudge arrives.
pub const BACKSTOP: Duration = Duration::from_secs(3 * 3600);
/// Product days requested on the first fetch (and the most any fetch asks for); `params.days`.
pub const DEFAULT_DAYS: i64 = 7;
pub const DAY_MS: i64 = 86_400_000;
/// Pause between region requests.
const POLITE_GAP: Duration = Duration::from_secs(1);

/// ERDDAP variable, reading param, valid range (the variable's `valid_min`/`valid_max`).
pub const VARS: [(&str, Param, f64, f64); 4] = [
    ("CRW_SST", Param::Sst, -2.0, 50.0),
    ("CRW_SSTANOMALY", Param::SstAnomaly, -15.0, 15.0),
    ("CRW_DHW", Param::Dhw, 0.0, 100.0),
    ("CRW_BAA", Param::Baa, 0.0, 4.0),
];
pub const MASK_VAR: &str = "CRW_DHW_mask";
const MASK_WATER: u64 = 0;
const MASK_LAND: u64 = 1;

/// One region's request box on the CRW grid: first and last cell centres and the stride.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Subset {
    pub north: f64,
    pub south: f64,
    pub west: f64,
    pub east: f64,
    pub stride: u32,
}

#[cfg(test)]
impl Subset {
    pub fn rows(&self) -> u32 {
        Self::steps(self.south, self.north, self.stride)
    }

    pub fn cols(&self) -> u32 {
        Self::steps(self.west, self.east, self.stride)
    }

    fn steps(lo: f64, hi: f64, stride: u32) -> u32 {
        ((hi - lo) / (CELL_DEG * stride as f64)).round() as u32 + 1
    }
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// First and last cell centre (stride apart, anchored at `lo`) of the CRW cells wholly inside
/// `[lo, hi]` on an axis whose first centre is `origin`.
fn axis(lo: f64, hi: f64, origin: f64, stride: u32) -> Option<(f64, f64)> {
    let half = CELL_DEG / 2.0;
    let k0 = ((lo + half - origin) / CELL_DEG - 1e-6).ceil() as i64;
    let k1 = ((hi - half - origin) / CELL_DEG + 1e-6).floor() as i64;
    if k1 < k0 {
        return None;
    }
    let s = stride as i64;
    let last = k0 + (k1 - k0) / s * s;
    Some((round3(origin + k0 as f64 * CELL_DEG), round3(origin + last as f64 * CELL_DEG)))
}

/// The request box for a region bbox at the app's environment cell size.
pub fn subset(bbox: BBox, env_cell_deg: f64) -> Option<Subset> {
    let stride = ((env_cell_deg / CELL_DEG).round() as u32).max(1);
    let (south, north) = axis(bbox.south, bbox.north, LAT0, stride)?;
    let (west, east) = axis(bbox.west, bbox.east, LON0, stride)?;
    Some(Subset { north, south, west, east, stride })
}

/// `2026-09-29T12:00:00Z` for unix ms.
pub fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map(|t| t.format("%Y-%m-%dT%H:%M:%SZ").to_string()).unwrap_or_default()
}

/// The griddap query for one box over the product days `[from_ms, to_ms]`. Brackets are
/// percent-encoded: ERDDAP's Tomcat rejects them raw.
pub fn region_url(base: &str, box_: &Subset, from_ms: i64, to_ms: i64) -> String {
    let s = box_.stride;
    let sel = format!(
        "%5B({}):1:({})%5D%5B({:.3}):{s}:({:.3})%5D%5B({:.3}):{s}:({:.3})%5D",
        iso(from_ms),
        iso(to_ms),
        box_.north,
        box_.south,
        box_.west,
        box_.east
    );
    let vars: Vec<String> = VARS.iter().map(|(v, ..)| v.to_string()).chain([MASK_VAR.to_string()]).map(|v| format!("{v}{sel}")).collect();
    format!("{base}?{}", vars.join(","))
}

pub fn last_time_url(base: &str) -> String {
    format!("{base}?time%5B(last)%5D")
}

/// `table.columnNames` and `table.rows` of a griddap JSON answer.
fn table(bytes: &[u8]) -> anyhow::Result<(Vec<String>, Vec<Value>)> {
    let doc: Value = serde_json::from_slice(bytes).context("crw: griddap json")?;
    let names = doc["table"]["columnNames"]
        .as_array()
        .context("crw: no table.columnNames")?
        .iter()
        .map(|v| v.as_str().unwrap_or_default().to_string())
        .collect();
    let rows = doc["table"]["rows"].as_array().context("crw: no table.rows")?.clone();
    Ok((names, rows))
}

/// Newest product time (unix ms) from a `time[(last)]` answer.
pub fn parse_last_time(bytes: &[u8]) -> anyhow::Result<i64> {
    let (names, rows) = table(bytes)?;
    anyhow::ensure!(names.first().map(String::as_str) == Some("time"), "crw: expected a time column, got {names:?}");
    let t = rows.first().and_then(|r| r[0].as_str()).context("crw: no time row")?;
    physical::parse_rfc3339_ms(t).with_context(|| format!("crw: time {t:?}"))
}

/// Product days to request: from the day after `cursor` (or `days - 1` days before `newest`)
/// up to `newest`, never more than `days`. `None` when `newest` is already stored.
pub fn window(newest: i64, cursor: Option<i64>, days: i64) -> Option<(i64, i64)> {
    let earliest = newest - (days.max(1) - 1) * DAY_MS;
    match cursor {
        Some(c) if c >= newest => None,
        Some(c) => Some(((c + DAY_MS).max(earliest), newest)),
        None => Some((earliest, newest)),
    }
}

/// A value of `param` that is the product's, or `None` (null, fill, NaN, out of range).
fn valid(v: &Value, lo: f64, hi: f64) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite() && (lo..=hi).contains(x))
}

/// Pure: griddap rows to readings. Land cells (mask 1) produce nothing; a water cell's masked
/// or invalid value is a `missing` reading.
pub fn normalize_payload(bytes: &[u8]) -> anyhow::Result<Vec<Row>> {
    let (names, rows) = table(bytes)?;
    let col = |name: &str| names.iter().position(|n| n == name).with_context(|| format!("crw: column {name} missing from {names:?}"));
    let (t_i, lat_i, lon_i, mask_i) = (col("time")?, col("latitude")?, col("longitude")?, col(MASK_VAR)?);
    let vars: Vec<(usize, Param, f64, f64)> =
        VARS.iter().map(|(name, p, lo, hi)| Ok((col(name)?, *p, *lo, *hi))).collect::<anyhow::Result<_>>()?;

    let mut out = Vec::with_capacity(rows.len() * vars.len());
    for row in &rows {
        let t = row[t_i].as_str().and_then(physical::parse_rfc3339_ms).with_context(|| format!("crw: time in {row}"))?;
        let (lat, lon) = match (row[lat_i].as_f64(), row[lon_i].as_f64()) {
            (Some(lat), Some(lon)) => (round3(lat), round3(lon)),
            _ => anyhow::bail!("crw: coordinates in {row}"),
        };
        let mask = row[mask_i].as_u64();
        if mask == Some(MASK_LAND) {
            continue;
        }
        let station = StationRef {
            ext_id: format!("{lat:.3},{lon:.3}"),
            name: format!("CRW 5 km cell {lat:.3},{lon:.3}"),
            lat,
            lon,
            kind: StationKind::Grid,
        };
        for (i, param, lo, hi) in &vars {
            // Only a water pixel carries a product value; missing (2), ice (4) or no mask is a gap.
            let value = (mask == Some(MASK_WATER)).then(|| valid(&row[*i], *lo, *hi)).flatten();
            out.push(reading(&station, *param, value, t, Origin::Satellite));
        }
    }
    Ok(out)
}

pub struct Crw {
    app: Arc<App>,
    base: String,
    days: i64,
}

impl Crw {
    pub fn new(app: Arc<App>) -> Self {
        let params = app.cfg.feed(SOURCE_ID).map(|f| f.params.clone()).unwrap_or_default();
        let base = params.get("erddap").and_then(Value::as_str).unwrap_or(ERDDAP_JSON).to_string();
        let days = params.get("days").and_then(Value::as_i64).filter(|d| (1..=31).contains(d)).unwrap_or(DEFAULT_DAYS);
        Crw { app, base, days }
    }

    /// The product days one fetch asks for (the backfill asks for more than the live poller's `params.days`).
    pub fn with_days(mut self, days: i64) -> Self {
        self.days = days.max(1);
        self
    }

    /// One request box per region, in config order.
    pub fn subsets(&self) -> Vec<(String, Subset)> {
        self.app
            .regions
            .iter()
            .filter_map(|r| subset(r.cfg.bbox, r.layout.env.cell_deg).map(|s| (r.id().to_string(), s)))
            .collect()
    }
}

async fn get(http: &reqwest::Client, url: &str) -> anyhow::Result<RawPayload> {
    let res = http.get(url).send().await.context("crw request")?;
    let res = governor::check_response(res)?;
    let status = res.status().as_u16();
    let content_type = physical::content_type(&res, "application/json");
    let bytes = res.bytes().await.context("crw body")?.to_vec();
    Ok(physical::payload(url, &content_type, bytes, status, None))
}

#[async_trait]
impl Source for Crw {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: SOURCE_ID,
            name: "NOAA Coral Reef Watch",
            homepage: "https://coralreefwatch.noaa.gov/product/5km/",
            mode: Mode::Webhook,
            // Expected age of the newest product: day D (12:00Z) lands about D+1 18:50Z and is
            // replaced a day later, so it is up to ~55 h old in normal operation. Older is lagging.
            cadence: Duration::from_secs(60 * 3600),
            // Product lag over 3 days: stale.
            max_latency: Duration::from_secs(72 * 3600),
        }
    }

    fn min_interval(&self) -> Duration {
        BACKSTOP
    }

    async fn fetch(&self, ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
        let http = &ctx.state.http;
        let last = get(http, &last_time_url(&self.base)).await?;
        let newest = parse_last_time(&last.bytes)?;
        let cursor = ctx.cursor.as_deref().and_then(physical::parse_rfc3339_ms);
        let Some((from, to)) = window(newest, cursor, self.days) else {
            return Ok(Vec::new());
        };
        let subsets = self.subsets();
        let mut out = Vec::with_capacity(subsets.len());
        for (i, (_, s)) in subsets.iter().enumerate() {
            if i > 0 {
                tokio::time::sleep(POLITE_GAP).await;
            }
            out.push(get(http, &region_url(&self.base, s, from, to)).await?);
        }
        // The cursor moves only with the last region, after every region's rows commit.
        if let Some(last) = out.last_mut() {
            last.next_cursor = Some(iso(newest));
        }
        Ok(out)
    }

    fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
        normalize_payload(&raw.bytes)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;
    use crate::app::test_support::{router_for, test_registry, test_state_for};
    use crate::feed_state::{self, Health};
    use crate::ingest::poll::physical::testing::{fixture, fixture_str, recorded, table_counts};
    use crate::ingest::scheduler::{ingest_payload, RunStatus};
    use crate::model::{Flag, ReadingRow};
    use crate::state::AppState;

    pub const REGIONS: [&str; 4] = ["fl-keys", "mx-caribbean", "belize", "co-caribbean"];
    /// 2026-09-29T12:00:00Z, the newest product day in the fixtures.
    const PRODUCT: i64 = 1_790_683_200_000;
    /// When the fixtures were fetched (2026-10-01T06:30Z).
    const FETCHED: i64 = 1_790_836_200_000;

    fn lionfish() -> Arc<App> {
        Arc::new(App::builtin("lionfish").unwrap())
    }

    fn raw(region: &str) -> RawPayload {
        recorded(fixture_str(&format!("crw/{region}.url")).trim(), "application/json", fixture(&format!("crw/{region}.json")), 200, FETCHED)
    }

    fn readings(bytes: &[u8]) -> Vec<ReadingRow> {
        normalize_payload(bytes)
            .unwrap()
            .into_iter()
            .map(|r| match r {
                Row::Reading(r) => r,
                other => panic!("{other:?}"),
            })
            .collect()
    }

    fn at<'a>(rows: &'a [ReadingRow], ext: &str, p: Param, t: i64) -> &'a ReadingRow {
        rows.iter().find(|r| r.station.ext_id == ext && r.param == p && r.observed_at == t).unwrap_or_else(|| panic!("{ext} {p:?} {t}"))
    }

    async fn ingest_all(state: &AppState) -> Vec<crate::ingest::scheduler::IngestOutcome> {
        let crw = Crw::new(state.app.clone());
        let mut out = Vec::new();
        for region in REGIONS {
            out.push(ingest_payload(state, &crw, raw(region), None).await.unwrap());
        }
        out
    }

    // ---- G1: fetch shape, fixtures, rows ---------------------------------------------------

    /// Each lionfish region's box is the CRW cells wholly inside its bbox, stride 1, and every
    /// requested centre is the centre of an env cell of that region (the 5 km app grid).
    #[test]
    fn crw_subset_matches_app_env_grid() {
        let app = lionfish();
        let crw = Crw::new(app.clone());
        let boxes = crw.subsets();
        assert_eq!(boxes.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), REGIONS);
        for (region, (id, s)) in app.regions.iter().zip(&boxes) {
            assert_eq!(region.id(), id);
            let env = region.layout.env;
            assert!((env.cell_deg - CELL_DEG).abs() < 1e-9, "lionfish env grid is 0.05 deg");
            assert_eq!(s.stride, 1);
            assert_eq!((s.cols(), s.rows()), (env.cols, env.rows), "{id}: one CRW cell per env cell");
            let (lon0, lat0) = env.center(0);
            assert_eq!((s.west, s.south), (round3(lon0), round3(lat0)), "{id}: south-west centres agree");
            let (lon1, lat1) = env.center(env.cells() - 1);
            assert_eq!((s.east, s.north), (round3(lon1), round3(lat1)), "{id}: north-east centres agree");
        }
        // Florida Keys: -83.2..-79.8 x 24.3..27.5 is 68 x 64 cells.
        assert_eq!(boxes[0].1, Subset { north: 27.475, south: 24.325, west: -83.175, east: -79.825, stride: 1 });
        // A coarser app grid strides: 0.1 deg env cells take every other CRW cell, from the south-west.
        let s = subset(BBox { west: -81.0, south: 24.0, east: -80.0, north: 25.0 }, 0.1).unwrap();
        assert_eq!(s, Subset { north: 24.925, south: 24.025, west: -80.975, east: -80.075, stride: 2 });
        assert_eq!((s.rows(), s.cols()), (10, 10));
        assert_eq!(subset(BBox { west: -81.0, south: 24.0, east: -80.99, north: 25.0 }, 0.05), None, "narrower than a cell");
    }

    #[test]
    fn crw_urls_encode_brackets_and_name_north_first() {
        let crw = Crw::new(lionfish());
        let (_, fl) = crw.subsets()[0];
        let url = region_url(ERDDAP_JSON, &fl, PRODUCT - DAY_MS, PRODUCT);
        let sel = "%5B(2026-09-28T12:00:00Z):1:(2026-09-29T12:00:00Z)%5D%5B(27.475):1:(24.325)%5D%5B(-83.175):1:(-79.825)%5D";
        assert_eq!(
            url,
            format!("{ERDDAP_JSON}?CRW_SST{sel},CRW_SSTANOMALY{sel},CRW_DHW{sel},CRW_BAA{sel},CRW_DHW_mask{sel}")
        );
        assert!(!url.contains('[') && !url.contains(']'));
        assert_eq!(last_time_url(ERDDAP_JSON), format!("{ERDDAP_JSON}?time%5B(last)%5D"));
        assert_eq!(crw.base, ERDDAP_JSON, "the feed's params.erddap");
        assert_eq!(crw.days, DEFAULT_DAYS);
        // The recorded fixtures use the same query on a smaller box.
        for region in REGIONS {
            let u = fixture_str(&format!("crw/{region}.url"));
            assert!(u.starts_with(&format!("{ERDDAP_JSON}?CRW_SST%5B(2026-09-28T12:00:00Z):1:(2026-09-29T12:00:00Z)%5D")), "{u}");
            assert!(u.trim().ends_with("%5D") && u.contains(",CRW_DHW_mask%5B"), "{u}");
        }
    }

    #[test]
    fn crw_window_from_cursor_and_last_time() {
        assert_eq!(parse_last_time(&fixture("crw/last.json")).unwrap(), PRODUCT);
        assert_eq!(iso(PRODUCT), "2026-09-29T12:00:00Z");
        // First fetch: the last 7 product days.
        assert_eq!(window(PRODUCT, None, 7), Some((PRODUCT - 6 * DAY_MS, PRODUCT)));
        // Caught up: nothing to fetch (the backstop poll records an empty run).
        assert_eq!(window(PRODUCT, Some(PRODUCT), 7), None);
        assert_eq!(window(PRODUCT, Some(PRODUCT + DAY_MS), 7), None);
        // One new day.
        assert_eq!(window(PRODUCT, Some(PRODUCT - DAY_MS), 7), Some((PRODUCT, PRODUCT)));
        // A long outage is capped at `days`.
        assert_eq!(window(PRODUCT, Some(PRODUCT - 40 * DAY_MS), 7), Some((PRODUCT - 6 * DAY_MS, PRODUCT)));
        assert!(parse_last_time(br#"{"table":{"columnNames":["x"],"rows":[["y"]]}}"#).is_err());
    }

    /// Four regions: every water cell gives four readings per product day, stamped 12:00Z, inside
    /// its own region; the evidence reef cells carry the values in docs/evidence/data-proof.md.
    #[test]
    fn crw_fixture_four_regions() {
        let app = lionfish();
        // (region, cells, land cells) per fixture box; two product days each.
        let expect = [("fl-keys", 64, 2), ("mx-caribbean", 104, 27), ("belize", 96, 7), ("co-caribbean", 24, 0)];
        let mut total = 0;
        for (region, cells, land) in expect {
            let rows = readings(&fixture(&format!("crw/{region}.json")));
            assert_eq!(rows.len(), (cells - land) * 2 * 4, "{region}");
            total += rows.len();
            assert!(rows.iter().all(|r| r.origin == Origin::Satellite && r.station.kind == StationKind::Grid));
            assert!(rows.iter().all(|r| app.region_of(r.station.lat, r.station.lon).map(|g| g.id()) == Some(region)), "{region}");
            let days: std::collections::BTreeSet<i64> = rows.iter().map(|r| r.observed_at).collect();
            assert_eq!(days.into_iter().collect::<Vec<_>>(), [PRODUCT - DAY_MS, PRODUCT], "{region}: product dates at 12:00Z");
            for p in [Param::Sst, Param::SstAnomaly, Param::Dhw, Param::Baa] {
                assert_eq!(rows.iter().filter(|r| r.param == p).count(), (cells - land) * 2, "{region} {p:?}");
            }
        }
        assert_eq!(total, 2016);
        let check = |region: &str, ext: &str, sst: f64, anom: f64, dhw: f64, baa: f64| {
            let rows = readings(&fixture(&format!("crw/{region}.json")));
            assert_eq!(at(&rows, ext, Param::Sst, PRODUCT).value, Some(sst), "{region} sst");
            assert_eq!(at(&rows, ext, Param::SstAnomaly, PRODUCT).value, Some(anom), "{region} anomaly");
            assert_eq!(at(&rows, ext, Param::Dhw, PRODUCT).value.map(|v| (v * 100.0).round() / 100.0), Some(dhw), "{region} dhw");
            assert_eq!(at(&rows, ext, Param::Baa, PRODUCT).value, Some(baa), "{region} baa");
        };
        check("fl-keys", "24.525,-81.375", 30.04, 1.52, 13.65, 1.0);
        check("mx-caribbean", "18.575,-87.325", 29.88, 1.24, 7.85, 3.0);
        check("belize", "16.775,-87.825", 29.85, 1.18, 5.28, 3.0);
        check("co-caribbean", "12.525,-81.625", 29.48, 1.12, 0.93, 2.0);
    }

    /// Through the pipeline: readings land under source `crw`, linked to the raw object whose
    /// `fetched_at` is the ingest time; a second ingest writes nothing.
    #[tokio::test]
    async fn crw_ingest_writes_readings_idempotently() {
        let state = test_state_for("lionfish");
        let first = ingest_all(&state).await;
        assert!(first.iter().all(|o| o.status == RunStatus::Ok && o.rows_skipped == 0), "{first:?}");
        assert_eq!(first.iter().map(|o| o.rows_written).sum::<usize>(), 2016 + 252, "readings plus their new stations");
        let stations: i64 =
            state.obs.read(|c| c.query_row("select count(*) from stations where source_id = 'crw'", [], |r| r.get(0))).await.unwrap();
        assert_eq!(stations, 62 + 77 + 89 + 24, "one station per water cell");
        let (n, sources, fetched, params, from, to): (i64, String, i64, String, i64, i64) = state
            .obs
            .read(|c| {
                c.query_row(
                    "select count(*), group_concat(distinct s.source_id), min(o.fetched_at), group_concat(distinct r.param),
                            min(r.observed_at), max(r.observed_at)
                     from readings r join stations s on s.id = r.station_id join raw_objects o on o.id = r.raw_object_id",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
                )
            })
            .await
            .unwrap();
        assert_eq!((n, sources.as_str(), fetched), (2016, "crw", FETCHED));
        let mut params: Vec<&str> = params.split(',').collect();
        params.sort_unstable();
        assert_eq!(params, ["baa", "dhw", "sst", "sst_anomaly"]);
        assert_eq!((from, to), (PRODUCT - DAY_MS, PRODUCT));

        let before = table_counts(&state).await;
        let again = ingest_all(&state).await;
        assert!(again.iter().all(|o| o.rows_written == 0 && o.window.is_none()), "{again:?}");
        assert_eq!(table_counts(&state).await, before);
        // The registered source runs in webhook mode.
        let mode: String =
            state.obs.read(|c| c.query_row("select mode from sources where id = 'crw'", [], |r| r.get(0))).await.unwrap();
        assert_eq!(mode, "webhook");
    }

    /// The cursor only moves with the last region's payload, so a fetch that fails part way
    /// re-requests every region.
    #[test]
    fn crw_cursor_rides_on_the_last_payload() {
        let mut payloads: Vec<RawPayload> = REGIONS.iter().map(|r| raw(r)).collect();
        if let Some(last) = payloads.last_mut() {
            last.next_cursor = Some(iso(PRODUCT));
        }
        assert!(payloads[..3].iter().all(|p| p.next_cursor.is_none()));
        assert_eq!(payloads[3].next_cursor.as_deref().and_then(physical::parse_rfc3339_ms), Some(PRODUCT));
    }

    // ---- G2: quality ---------------------------------------------------------------------

    fn synthetic(rows: &str) -> Vec<u8> {
        format!(
            r#"{{"table":{{"columnNames":["time","latitude","longitude","CRW_SST","CRW_SSTANOMALY","CRW_DHW","CRW_BAA","CRW_DHW_mask"],
            "columnTypes":["String","float","float","double","double","double","ubyte","ubyte"],
            "columnUnits":["UTC","degrees_north","degrees_east","Celsius","Celsius","Celsius weeks","1","1"],
            "rows":[{rows}]}}}}"#
        )
        .into_bytes()
    }

    /// Masked (2) and ice (4) pixels, fill values and out-of-range numbers are `missing` with a
    /// null value: never 0, never dropped.
    #[test]
    fn crw_quality_masked_cells_are_missing_not_zero() {
        let rows = readings(&synthetic(
            r#"["2026-09-29T12:00:00Z", 24.525, -81.375, null, null, null, null, 2],
               ["2026-09-29T12:00:00Z", 24.575, -81.375, null, null, null, null, 4],
               ["2026-09-29T12:00:00Z", 24.625, -81.375, -327.68, -327.68, -327.68, 251, 0],
               ["2026-09-29T12:00:00Z", 24.675, -81.375, "NaN", 99.0, -1.0, 7, 0],
               ["2026-09-29T12:00:00Z", 24.725, -81.375, 30.1, 0.0, 0.0, 0, 0]"#,
        ));
        assert_eq!(rows.len(), 5 * 4);
        let (gaps, good): (Vec<&ReadingRow>, Vec<&ReadingRow>) = rows.iter().partition(|r| r.station.ext_id != "24.725,-81.375");
        assert!(gaps.iter().all(|r| r.value.is_none() && r.flag == Flag::Missing), "{gaps:?}");
        // A real zero (no anomaly, no DHW, no stress) stays a value.
        assert!(good.iter().all(|r| r.flag == Flag::Ok), "{good:?}");
        assert_eq!(at(&rows, "24.725,-81.375", Param::Dhw, PRODUCT).value, Some(0.0));
        assert_eq!(at(&rows, "24.725,-81.375", Param::Baa, PRODUCT).value, Some(0.0));
        // Missing readings are stored as null with flag `missing`, the convention the frame
        // builder turns into ENV_FLAGGED (and a heat layer must hatch).
        let missing = at(&rows, "24.525,-81.375", Param::Sst, PRODUCT);
        assert_eq!((missing.value, missing.flag.as_str()), (None, "missing"));
        // A payload without the mask cannot tell land from a gap: refuse it.
        let no_mask = br#"{"table":{"columnNames":["time","latitude","longitude","CRW_SST","CRW_SSTANOMALY","CRW_DHW","CRW_BAA"],"rows":[]}}"#;
        assert!(normalize_payload(no_mask).unwrap_err().to_string().contains("CRW_DHW_mask"));
    }

    /// Land cells (mask 1) are not reef cells: no station, no readings.
    #[test]
    fn crw_quality_land_cells_skipped() {
        let rows = readings(&synthetic(r#"["2026-09-29T12:00:00Z", 25.475, -80.925, null, null, null, null, 1]"#));
        assert!(rows.is_empty());
        // Fixture: Lower Keys land at 24.675,-81.375 and 24.625,-81.375 is absent, water around it is not.
        let fl = readings(&fixture("crw/fl-keys.json"));
        assert!(!fl.iter().any(|r| r.station.ext_id == "24.675,-81.375" || r.station.ext_id == "24.625,-81.375"));
        assert!(fl.iter().any(|r| r.station.ext_id == "24.725,-81.375"));
        // Mexican Caribbean box: 27 of 104 cells are Quintana Roo mainland.
        let mx = readings(&fixture("crw/mx-caribbean.json"));
        let cells: std::collections::BTreeSet<&str> = mx.iter().map(|r| r.station.ext_id.as_str()).collect();
        assert_eq!(cells.len(), 104 - 27);
    }

    /// Florida: DHW 13.65 (accumulated, Alert-level stress) with BAA 1 (Watch, current HotSpot
    /// below 1 °C). Both are stored as written; nothing derives one from the other.
    #[tokio::test]
    async fn crw_quality_dhw_and_baa_disagreement_preserved() {
        let state = test_state_for("lionfish");
        ingest_all(&state).await;
        let (dhw, baa): (f64, f64) = state
            .obs
            .read(|c| {
                c.query_row(
                    "select max(case when r.param = 'dhw' then r.value end), max(case when r.param = 'baa' then r.value end)
                     from readings r join stations s on s.id = r.station_id
                     where s.source_id = 'crw' and s.ext_id = '24.525,-81.375' and r.observed_at = ?1",
                    [PRODUCT],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            })
            .await
            .unwrap();
        assert_eq!(((dhw * 100.0).round() / 100.0, baa), (13.65, 1.0));
        // DHW >= 8 would be Alert Level 2 if BAA followed DHW alone; it does not.
        assert!(dhw >= 8.0 && baa < 4.0);
        // Evidence for the DHW reading carries the licence credit, DOI and the cell's ERDDAP page.
        let station: i64 = state
            .obs
            .read(|c| c.query_row("select id from stations where source_id = 'crw' and ext_id = '24.525,-81.375'", [], |r| r.get(0)))
            .await
            .unwrap();
        let ev = crate::evidence::evidence(&state, &format!("reading:{station}:dhw:{PRODUCT}:satellite")).await.unwrap();
        assert_eq!(ev.record["value"].as_f64().map(|v| (v * 100.0).round() / 100.0), Some(13.65));
        assert_eq!(ev.record["doi"], crate::source_pages::CRW_DOI);
        assert!(ev.record["credit"].as_str().unwrap().contains("NOAA Coral Reef Watch"));
        assert!(ev.source_page_url.unwrap().contains("dhw_5km.htmlTable?CRW_SST"));
        assert_eq!(ev.feed.map(|f| f.source), Some("crw".to_string()));
    }

    /// Product lag: about 1.7 days is nominal, over 2.5 days lagging, over 3 days stale.
    #[tokio::test]
    async fn crw_quality_stale_after_three_days() {
        let state = test_state_for("lionfish");
        ingest_all(&state).await;
        let crw_at = |now: i64| {
            let state = state.clone();
            async move { feed_state::compute(&state.obs, now).await.unwrap().into_iter().find(|f| f.source == "crw").unwrap() }
        };
        let hours = |h: i64| PRODUCT + h * 3_600_000;
        assert_eq!(crw_at(hours(41)).await.state, Health::Nominal, "the probe's 41.5 h");
        assert_eq!(crw_at(hours(55)).await.state, Health::Nominal, "the oldest a normal product gets");
        assert_eq!(crw_at(hours(66)).await.state, Health::Lagging);
        let stale = crw_at(hours(73)).await;
        assert_eq!(stale.state, Health::Stale, "{stale:?}");
        assert!(stale.note.as_deref().unwrap().contains("max latency is 3d"), "{stale:?}");
        assert_eq!(stale.mode, "webhook");
    }

    // ---- G3: nudge -----------------------------------------------------------------------

    async fn call(router: &axum::Router, method: &str, uri: &str) -> (StatusCode, Value) {
        let res = router.clone().oneshot(Request::builder().method(method).uri(uri).body(Body::empty()).unwrap()).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    #[tokio::test]
    async fn crw_nudge_auth_and_routing() {
        let registry = test_registry();
        let router = crate::app::app(registry.clone());
        // Unknown app: 404 before anything else.
        let (s, b) = call(&router, "POST", "/v1/otter/ingest/nudge/crw/test-nudge-token").await;
        assert_eq!((s, b["error"].as_str()), (StatusCode::NOT_FOUND, Some("unknown_app")), "{b}");
        // Bad token: 401, whatever the source.
        for uri in ["/v1/lionfish/ingest/nudge/crw/wrong", "/v1/lionfish/ingest/nudge/crw/test-nudge-toke", "/v1/lionfish/ingest/nudge/nope/x"] {
            let (s, b) = call(&router, "POST", uri).await;
            assert_eq!(s, StatusCode::UNAUTHORIZED, "{uri}: {b}");
        }
        // Good token, but the app has no webhook source by that id: 404.
        for uri in ["/v1/python/ingest/nudge/crw/test-nudge-token", "/v1/carp/ingest/nudge/crw/test-nudge-token", "/v1/lionfish/ingest/nudge/inat/test-nudge-token"] {
            let (s, b) = call(&router, "POST", uri).await;
            assert_eq!(s, StatusCode::NOT_FOUND, "{uri}: {b}");
        }
        // Accepted, then a duplicate within 60 s (GET too: ERDDAP calls its action URL with GET).
        let (s, b) = call(&router, "POST", "/v1/lionfish/ingest/nudge/crw/test-nudge-token").await;
        assert_eq!((s, b["status"].as_str()), (StatusCode::ACCEPTED, Some("accepted")), "{b}");
        let (s, b) = call(&router, "GET", "/v1/lionfish/ingest/nudge/crw/test-nudge-token").await;
        assert_eq!((s, b["status"].as_str()), (StatusCode::OK, Some("duplicate")), "{b}");
        // Token unset: the route is off.
        let mut config = crate::state::Config::for_tests();
        config.ingest_nudge_token = None;
        let off = AppState::memory(config, App::builtin("lionfish").unwrap());
        let (s, _) = call(&router_for(&off), "POST", "/v1/lionfish/ingest/nudge/crw/test-nudge-token").await;
        assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn crw_nudge_dedupes_within_60s() {
        let nudges = crate::ingest::push::nudge::Nudges::default();
        let t0 = std::time::Instant::now();
        use crate::ingest::push::nudge::Nudged::*;
        assert_eq!(nudges.nudge("crw", t0), Accepted);
        assert_eq!(nudges.nudge("crw", t0 + Duration::from_secs(59)), Duplicate);
        assert_eq!(nudges.nudge("other", t0 + Duration::from_secs(59)), Accepted, "per source");
        assert_eq!(nudges.nudge("crw", t0 + Duration::from_secs(60)), Accepted);
        assert_eq!(nudges.nudge("crw", t0 + Duration::from_secs(61)), Duplicate, "measured from the last accepted nudge");
    }

    /// A webhook-mode source that counts fetches and stores nothing.
    struct Counting {
        fetches: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl Source for Counting {
        fn info(&self) -> SourceInfo {
            SourceInfo { id: SOURCE_ID, mode: Mode::Webhook, ..Crw::new(lionfish()).info() }
        }
        fn min_interval(&self) -> Duration {
            BACKSTOP
        }
        async fn fetch(&self, _ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
            self.fetches.fetch_add(1, Ordering::SeqCst);
            Ok(Vec::new())
        }
        fn normalize(&self, _raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
            Ok(Vec::new())
        }
    }

    /// The scheduler's loop sleeps for the 3 h backstop; a nudge runs the fetch now, a repeat
    /// within 60 s does not run another.
    #[tokio::test]
    async fn crw_nudge_triggers_an_immediate_fetch() {
        let state = test_state_for("lionfish");
        let router = router_for(&state);
        let fetches = Arc::new(AtomicUsize::new(0));
        let source: Arc<dyn Source> = Arc::new(Counting { fetches: fetches.clone() });
        let handles = crate::ingest::scheduler::spawn_sources(&state, vec![source], Default::default());
        let wait_for = |n: usize| {
            let fetches = fetches.clone();
            async move {
                for _ in 0..200 {
                    if fetches.load(Ordering::SeqCst) >= n {
                        return true;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                false
            }
        };
        assert!(wait_for(1).await, "boot fetch");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(fetches.load(Ordering::SeqCst), 1, "then asleep until the backstop");
        let (s, _) = call(&router, "POST", "/v1/lionfish/ingest/nudge/crw/test-nudge-token").await;
        assert_eq!(s, StatusCode::ACCEPTED);
        assert!(wait_for(2).await, "nudge woke the loop");
        let (s, _) = call(&router, "POST", "/v1/lionfish/ingest/nudge/crw/test-nudge-token").await;
        assert_eq!(s, StatusCode::OK, "duplicate");
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(fetches.load(Ordering::SeqCst), 2, "a duplicate nudge fetches nothing");
        // The empty runs are recorded under the webhook source.
        let (runs, mode): (i64, String) = state
            .obs
            .read(|c| {
                c.query_row(
                    "select (select count(*) from fetch_runs where source_id = 'crw' and status = 'empty'), mode from sources where id = 'crw'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            })
            .await
            .unwrap();
        assert_eq!((runs, mode.as_str()), (2, "webhook"));
        for h in handles {
            h.abort();
        }
    }

    // ---- G5: feed state ------------------------------------------------------------------

    /// `/health`: `crw` is a lionfish feed in mode `webhook` with its backstop note; carp and
    /// python do not list it.
    #[tokio::test]
    async fn crw_health_webhook_for_lionfish_only() {
        let registry = test_registry();
        for state in registry.iter() {
            crate::ingest::scheduler::start(state.clone(), Default::default()).await.unwrap();
        }
        let router = crate::app::app(registry.clone());
        let (s, body) = call(&router, "GET", "/health").await;
        assert_eq!(s, StatusCode::OK, "{body}");
        for app in body["apps"].as_array().unwrap() {
            let crw: Vec<&Value> = app["feeds"].as_array().unwrap().iter().filter(|f| f["source"] == "crw").collect();
            if app["id"] == "lionfish" {
                assert_eq!(crw.len(), 1, "{app}");
                assert_eq!(crw[0]["mode"], "webhook", "{app}");
                assert!(crw[0]["note"].as_str().unwrap().contains("webhook nudge on dataset change; poll backstop"), "{app}");
            } else {
                assert!(crw.is_empty(), "{app}");
            }
        }
        // GraphQL keeps its two-mode enum: the webhook source reads as POLL there.
        let res = router
            .clone()
            .oneshot(
                Request::post("/v1/lionfish/graphql")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(serde_json::json!({ "query": "{ feeds { source mode } }" }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let data: Value = serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
        let crw = data["data"]["feeds"].as_array().unwrap().iter().find(|f| f["source"] == "crw").cloned();
        // GraphQL `FeedMode` has `WEBHOOK` since E1, so the true mode reaches the chips.
        assert_eq!(crw.map(|f| f["mode"].clone()), Some(Value::from("WEBHOOK")), "{data}");
    }

    /// Migration 0006 widened the two CHECK constraints in place and nothing else.
    #[tokio::test]
    async fn crw_migration_widens_constraints() {
        let state = test_state_for("lionfish");
        let res: Vec<String> = state
            .obs
            .write(|tx| {
                let mut out = Vec::new();
                tx.execute("insert into sources (id, name, homepage, mode, cadence_s, max_latency_s) values ('t1', 't', 't', 'webhook', 1, 1)", [])?;
                out.push(tx.execute("insert into sources (id, name, homepage, mode, cadence_s, max_latency_s) values ('t2', 't', 't', 'bogus', 1, 1)", []).map_err(|e| e.to_string()).err().unwrap_or_default());
                tx.execute("insert into stations (source_id, ext_id, name, lat, lon, kind) values ('t1', 'x', 'x', 0, 0, 'grid')", [])?;
                for p in ["sst", "sst_anomaly", "dhw", "baa", "sst_c"] {
                    tx.execute("insert into readings (station_id, param, value, observed_at, origin) values (1, ?1, 1, 1, 'satellite')", [p])?;
                }
                out.push(tx.execute("insert into readings (station_id, param, value, observed_at, origin) values (1, 'heat', 1, 1, 'satellite')", []).map_err(|e| e.to_string()).err().unwrap_or_default());
                out.push(tx.query_row("pragma integrity_check", [], |r| r.get(0))?);
                Ok(out)
            })
            .await
            .unwrap();
        assert!(res[0].contains("CHECK constraint failed"), "{res:?}");
        assert!(res[1].contains("CHECK constraint failed"), "{res:?}");
        assert_eq!(res[2], "ok");
    }

    // ---- G4: live ------------------------------------------------------------------------

    /// Live smoke: the real endpoint, one product day, every region; the evidence reef cell of
    /// each region has all four values and the product date is within 4 days of now.
    /// `cargo test --manifest-path api/Cargo.toml crw_live -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "network: PacIOOS ERDDAP"]
    async fn crw_live_fetch_four_regions() {
        let mut config = crate::state::Config::for_tests();
        config.user_agent = crate::state::Config::from_env().user_agent;
        let state = AppState::memory(config, App::builtin("lionfish").unwrap());
        let crw = Crw::new(state.app.clone()).with_days(1);
        let started = std::time::Instant::now();
        let payloads = crw.fetch(&FetchCtx { state: &state, cursor: None }).await.unwrap();
        assert_eq!(payloads.len(), 4);
        let bytes: usize = payloads.iter().map(|p| p.bytes.len()).sum();
        let points = state.app.cfg.feed(SOURCE_ID).unwrap().params["points"].clone();
        let mut newest = 0;
        let mut regions = 0;
        for (raw, region) in payloads.iter().zip(REGIONS) {
            let rows = readings(&raw.bytes);
            let ok = rows.iter().filter(|r| r.flag == Flag::Ok).count();
            let [lat, lon] = [points[region][0].as_f64().unwrap(), points[region][1].as_f64().unwrap()];
            let ext = format!("{lat:.3},{lon:.3}");
            let reef: Vec<&ReadingRow> = rows.iter().filter(|r| r.station.ext_id == ext).collect();
            let values: Vec<String> = reef.iter().map(|r| format!("{}={:?}", r.param.as_str(), r.value)).collect();
            println!("{region}: {} readings ({ok} ok), reef cell {ext}: {}", rows.len(), values.join(" "));
            if reef.len() == 4 && reef.iter().all(|r| r.value.is_some()) {
                regions += 1;
            }
            newest = newest.max(rows.iter().map(|r| r.observed_at).max().unwrap_or(0));
            let out = ingest_payload(&state, &crw, raw.clone(), None).await.unwrap();
            assert_eq!(out.status, RunStatus::Ok, "{out:?}");
        }
        let age_h = (physical::now_ms() - newest) as f64 / 3.6e6;
        println!("bytes={bytes} elapsed={:.1}s product age {age_h:.1} h", started.elapsed().as_secs_f64());
        println!("CRW-LIVE regions={regions} newest={}", &iso(newest)[..10]);
        assert_eq!(regions, 4);
        assert!(age_h < 96.0, "product {age_h:.1} h old");
    }
}
