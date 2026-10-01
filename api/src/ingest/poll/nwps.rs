//! NOAA National Water Prediction Service river forecasts (leaf C4; docs/ingest-modes.md C2,
//! docs/evidence/carp-data-proof.md). Two endpoints per site (`locations[].nwps`, the NWPS lid):
//!
//! - `gauges/{lid}`: metadata with the flood categories (`flood.categories.*.stage`, NWPS feet;
//!   `-9999` = not defined) → `Row::Thresholds`. Fetched at most every [`META_TTL`].
//! - `gauges/{lid}/stageflow`: observed hourly stage/flow (30 days) and the current forecast
//!   (6-hourly, 5 to 15 days) → `Row::ForecastObservations` (`source = nwps-live`) and one
//!   `Row::ForecastSnapshot` (`product = stageflow`, `issued_at = forecast.issuedTime`).
//!
//! Schedule: the poll loop runs every [`FAST`] (15 min), and the fetch makes requests every time
//! inside the issuance window 12:00-18:00Z (issuances landed 13:17-15:56Z on 7 of 7 days) and
//! once an hour outside it; the other wake-ups return no payload (an `empty` run). A site's
//! stageflow is only emitted when its `forecast.issuedTime` or `observed.issuedTime` changed
//! since the last committed poll (the cursor, a JSON map per lid); the snapshot's payload hash
//! covers the forecast points only, so an unchanged issuance re-polled for new observations is a
//! `Duplicate`, never a revision.
//!
//! Units: stage `ft`, flow `kcfs` (converted when the feed says `cfs`); `-999`/`-9999` values
//! are missing. Times are `Z` in the feed; `timeZone=CST6CDT` is display information only.
//! The lid is not in the stageflow body, so it is read from the request URL. NWPS has no
//! history (the IEM archive, `poll::iem`, backfills issuances) and no published rate limit:
//! requests of one poll are 300 ms apart.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Context;
use async_trait::async_trait;
use chrono::Timelike;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::app::config::App;
use crate::forecast::store::NewSnapshot;
use crate::forecast::{clean_value, Observation, Point, Source as ForecastSource, Thresholds};
use crate::ingest::governor;
use crate::ingest::poll::physical::{self, parse_rfc3339_ms};
use crate::ingest::source::{FetchCtx, Mode, RawPayload, Source, SourceInfo};
use crate::model::{ForecastObservationsRow, Row, ThresholdsRow};

pub const SOURCE_ID: &str = "nwps";
pub const API: &str = "https://api.water.noaa.gov/nwps/v1/gauges";
/// Poll loop interval; inside the issuance window every wake-up fetches.
pub const FAST: Duration = Duration::from_secs(15 * 60);
/// Outside the window: one fetch an hour (observed values are hourly).
pub const SLOW: Duration = Duration::from_secs(60 * 60);
/// Gauge metadata (thresholds) is re-read this often.
pub const META_TTL: Duration = Duration::from_secs(6 * 3600);
/// Default issuance window, hours UTC `[from, to)`; the feed's `params.fastWindowUtc`.
pub const DEFAULT_WINDOW: (u32, u32) = (12, 18);
const POLITE_GAP: Duration = Duration::from_millis(300);

pub fn gauge_url(lid: &str) -> String {
    format!("{API}/{lid}")
}

pub fn stageflow_url(lid: &str) -> String {
    format!("{API}/{lid}/stageflow")
}

/// The lid of a `gauges/{lid}` or `gauges/{lid}/stageflow` URL.
pub fn lid_from_url(url: &str) -> Option<String> {
    let rest = url.split("/gauges/").nth(1)?;
    let lid = rest.split(['/', '?']).next()?.trim();
    (!lid.is_empty() && lid.chars().all(|c| c.is_ascii_alphanumeric())).then(|| lid.to_ascii_uppercase())
}

pub fn in_fast_window(hour_utc: u32, (from, to): (u32, u32)) -> bool {
    hour_utc >= from && hour_utc < to
}

/// What was last committed per site: the two issuance times that gate a new payload.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SiteCursor {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forecast: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed: Option<String>,
}

pub type Cursor = BTreeMap<String, SiteCursor>;

pub fn parse_cursor(s: Option<&str>) -> Cursor {
    s.and_then(|c| serde_json::from_str(c).ok()).unwrap_or_default()
}

/// The issuance times in a stageflow body: (`forecast.issuedTime`, `observed.issuedTime`).
pub fn issuances(doc: &Value) -> SiteCursor {
    SiteCursor {
        forecast: doc["forecast"]["issuedTime"].as_str().map(String::from),
        observed: doc["observed"]["issuedTime"].as_str().map(String::from),
    }
}

pub struct Nwps {
    sites: Vec<String>,
    window: (u32, u32),
    meta_at: Mutex<HashMap<String, Instant>>,
    last_fetch: Mutex<Option<Instant>>,
}

impl Nwps {
    pub fn new(app: Arc<App>) -> Self {
        let params = app.cfg.feed(SOURCE_ID).map(|f| f.params.clone()).unwrap_or_default();
        let window = params
            .get("fastWindowUtc")
            .and_then(Value::as_array)
            .and_then(|a| Some((a.first()?.as_u64()? as u32, a.get(1)?.as_u64()? as u32)))
            .filter(|(f, t)| f < t && *t <= 24)
            .unwrap_or(DEFAULT_WINDOW);
        let sites = app.cfg.locations.iter().filter_map(|l| l.nwps.clone()).collect();
        Nwps { sites, window, meta_at: Mutex::new(HashMap::new()), last_fetch: Mutex::new(None) }
    }

    #[cfg(test)]
    pub fn sites(&self) -> &[String] {
        &self.sites
    }

    /// Does this wake-up fetch? Always in the window; otherwise once per [`SLOW`].
    pub fn due(&self, hour_utc: u32, now: Instant) -> bool {
        if in_fast_window(hour_utc, self.window) {
            return true;
        }
        self.last_fetch.lock().expect("last_fetch").is_none_or(|t| now.duration_since(t) >= SLOW)
    }

    fn meta_due(&self, lid: &str, now: Instant) -> bool {
        self.meta_at.lock().expect("meta_at").get(lid).is_none_or(|t| now.duration_since(*t) >= META_TTL)
    }
}

async fn get(http: &reqwest::Client, url: &str) -> anyhow::Result<RawPayload> {
    let res = http.get(url).header(reqwest::header::ACCEPT, "application/json").send().await.context("nwps request")?;
    let res = governor::check_response(res)?;
    let status = res.status().as_u16();
    let content_type = physical::content_type(&res, "application/json");
    let bytes = res.bytes().await.context("nwps body")?.to_vec();
    Ok(physical::payload(url, &content_type, bytes, status, None))
}

#[async_trait]
impl Source for Nwps {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: SOURCE_ID,
            name: "NOAA National Water Prediction Service",
            homepage: "https://water.noaa.gov/about/api",
            mode: Mode::Poll,
            // Observed values are hourly and appear ~55 min after their valid time; the
            // freshness bands of the data proof are green <= 2 h, amber <= 6 h, red older.
            cadence: Duration::from_secs(2 * 3600),
            max_latency: Duration::from_secs(6 * 3600),
        }
    }

    fn min_interval(&self) -> Duration {
        FAST
    }

    async fn fetch(&self, ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
        let now = Instant::now();
        if !self.due(chrono::Utc::now().hour(), now) {
            return Ok(Vec::new());
        }
        let http = &ctx.state.http;
        let mut cursor = parse_cursor(ctx.cursor.as_deref());
        let mut out = Vec::new();
        let mut first = true;
        for lid in &self.sites {
            if self.meta_due(lid, now) {
                if !first {
                    tokio::time::sleep(POLITE_GAP).await;
                }
                first = false;
                out.push(get(http, &gauge_url(lid)).await?);
                self.meta_at.lock().expect("meta_at").insert(lid.clone(), now);
            }
            if !first {
                tokio::time::sleep(POLITE_GAP).await;
            }
            first = false;
            let raw = get(http, &stageflow_url(lid)).await?;
            let doc: Value = serde_json::from_slice(&raw.bytes).with_context(|| format!("nwps {lid}: stageflow json"))?;
            let seen = issuances(&doc);
            if cursor.get(lid) == Some(&seen) {
                tracing::debug!(source = SOURCE_ID, lid, "issuance unchanged, not stored again");
                continue;
            }
            cursor.insert(lid.clone(), seen);
            out.push(raw);
        }
        *self.last_fetch.lock().expect("last_fetch") = Some(now);
        // The cursor moves with the last payload, once every site's rows are committed.
        if let Some(last) = out.last_mut() {
            last.next_cursor = Some(serde_json::to_string(&cursor).expect("cursor json"));
        }
        Ok(out)
    }

    fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
        let doc: Value = serde_json::from_slice(&raw.bytes).context("nwps json")?;
        let lid = doc["lid"].as_str().map(|s| s.to_ascii_uppercase()).or_else(|| lid_from_url(&raw.source_url)).context("nwps: no lid in body or url")?;
        if doc.get("flood").is_some() {
            return Ok(vec![Row::Thresholds(ThresholdsRow { site: lid, thresholds: thresholds(&doc) })]);
        }
        anyhow::ensure!(doc.get("observed").is_some() || doc.get("forecast").is_some(), "nwps: neither gauge nor stageflow body");
        normalize_stageflow(&lid, &doc, raw.fetched_at)
    }
}

/// Flood category thresholds of a gauge body; absent or `-9999` categories are not defined.
pub fn thresholds(gauge: &Value) -> Thresholds {
    let cat = |name: &str| gauge["flood"]["categories"][name]["stage"].as_f64().unwrap_or(-9999.0);
    Thresholds::from_feed(cat("action"), cat("minor"), cat("moderate"), cat("major"))
}

/// Flow in kcfs from a feed value in `units` (`kcfs` or `cfs`).
fn flow_kcfs(v: Option<f64>, units: &str) -> Option<f64> {
    clean_value(v).map(|f| if units.eq_ignore_ascii_case("cfs") { f / 1000.0 } else { f })
}

/// Pure: a stageflow body to its observation and forecast rows.
pub fn normalize_stageflow(lid: &str, doc: &Value, fetched_at: i64) -> anyhow::Result<Vec<Row>> {
    let mut rows = Vec::new();
    let series = |section: &Value| -> Vec<(i64, Option<f64>, Option<f64>)> {
        let units = section["secondaryUnits"].as_str().unwrap_or("kcfs");
        section["data"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter_map(|d| {
                let t = d["validTime"].as_str().and_then(parse_rfc3339_ms)?;
                Some((t, clean_value(d["primary"].as_f64()), flow_kcfs(d["secondary"].as_f64(), units)))
            })
            .collect()
    };
    let observed: Vec<Observation> =
        series(&doc["observed"]).into_iter().map(|(t, s, f)| Observation { observed_at: t, stage_ft: s, flow_kcfs: f }).collect();
    if !observed.is_empty() {
        rows.push(Row::ForecastObservations(ForecastObservationsRow { site: lid.to_string(), source: ForecastSource::NwpsLive, observations: observed }));
    }
    let forecast = &doc["forecast"];
    if let Some(issued_at) = forecast["issuedTime"].as_str().and_then(parse_rfc3339_ms) {
        let points: Vec<Point> = series(forecast).into_iter().map(|(t, s, f)| Point { valid_at: t, stage_ft: s, flow_kcfs: f }).collect();
        if !points.is_empty() {
            // The hash covers the issuance's points only: observations change hourly, the
            // forecast does not, and a re-poll must be a duplicate, not a revision.
            let mut h = Sha256::new();
            h.update(forecast["issuedTime"].as_str().unwrap_or_default().as_bytes());
            h.update(serde_json::to_string(&forecast["data"]).expect("json").as_bytes());
            rows.push(Row::ForecastSnapshot(NewSnapshot {
                site: lid.to_string(),
                product: "stageflow".into(),
                issued_at,
                ingested_at: fetched_at,
                source: ForecastSource::NwpsLive,
                payload_hash: hex::encode(h.finalize()),
                points,
            }));
        }
    }
    Ok(rows)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::app::test_support::test_state_for;
    use crate::forecast::{query, store, Category};
    use crate::ingest::poll::physical::testing::{fixture, recorded};
    use crate::ingest::scheduler::{ingest_payload, RunStatus};
    use crate::state::AppState;

    pub const LIDS: [&str; 8] = ["SMML1", "KRZL1", "BLRL1", "MCGL1", "BTRL1", "AEXL1", "MLUL1", "BXAL1"];
    /// 2026-10-01T07:01:03Z, when the fixtures were recorded.
    pub const RECORDED_AT: i64 = 1_790_838_063_000;

    fn carp() -> Arc<App> {
        Arc::new(App::builtin("carp").unwrap())
    }

    pub fn gauge(lid: &str) -> RawPayload {
        recorded(&gauge_url(lid), "application/json", fixture(&format!("nwps/{lid}.json")), 200, RECORDED_AT)
    }

    pub fn stageflow(lid: &str) -> RawPayload {
        recorded(&stageflow_url(lid), "application/json", fixture(&format!("nwps/{lid}.stageflow.json")), 200, RECORDED_AT)
    }

    /// Gauge then stageflow for every site, through the pipeline.
    pub async fn ingest_all(state: &AppState) -> Vec<crate::ingest::scheduler::IngestOutcome> {
        let nwps = Nwps::new(state.app.clone());
        let mut out = Vec::new();
        for lid in LIDS {
            out.push(ingest_payload(state, &nwps, gauge(lid), None).await.unwrap());
            out.push(ingest_payload(state, &nwps, stageflow(lid), None).await.unwrap());
        }
        out
    }

    #[test]
    fn nwps_urls_window_and_cursor() {
        let nwps = Nwps::new(carp());
        assert_eq!(nwps.sites(), LIDS);
        assert_eq!(nwps.window, (12, 18), "params.fastWindowUtc");
        assert_eq!(gauge_url("BTRL1"), "https://api.water.noaa.gov/nwps/v1/gauges/BTRL1");
        assert_eq!(stageflow_url("BTRL1"), "https://api.water.noaa.gov/nwps/v1/gauges/BTRL1/stageflow");
        assert_eq!(lid_from_url(&stageflow_url("btrl1")).as_deref(), Some("BTRL1"));
        assert_eq!(lid_from_url("https://api.water.noaa.gov/nwps/v1/gauges/KRZL1?x=1").as_deref(), Some("KRZL1"));
        assert_eq!(lid_from_url("https://api.water.noaa.gov/nwps/v1/products"), None);
        // 15 min loop; every wake-up in 12:00-18:00Z fetches, outside it one per hour.
        assert_eq!(nwps.min_interval(), FAST);
        assert!(in_fast_window(12, (12, 18)) && in_fast_window(17, (12, 18)));
        assert!(!in_fast_window(18, (12, 18)) && !in_fast_window(3, (12, 18)));
        let t0 = Instant::now();
        assert!(nwps.due(3, t0), "never fetched: due");
        *nwps.last_fetch.lock().unwrap() = Some(t0);
        assert!(!nwps.due(3, t0 + Duration::from_secs(30 * 60)));
        assert!(nwps.due(3, t0 + SLOW));
        assert!(nwps.due(13, t0 + Duration::from_secs(60)), "in the window every wake-up fetches");
        assert!(nwps.meta_due("BTRL1", t0));
        nwps.meta_at.lock().unwrap().insert("BTRL1".into(), t0);
        assert!(!nwps.meta_due("BTRL1", t0 + Duration::from_secs(3600)) && nwps.meta_due("BTRL1", t0 + META_TTL));

        // The cursor is a map of the two issuance times per lid; a changed one re-emits.
        let doc: Value = serde_json::from_slice(&fixture("nwps/KRZL1.stageflow.json")).unwrap();
        let seen = issuances(&doc);
        assert_eq!(seen, SiteCursor { forecast: Some("2026-09-30T15:32:00Z".into()), observed: Some("2026-10-01T06:00:00Z".into()) });
        let mut cursor = Cursor::new();
        cursor.insert("KRZL1".into(), seen.clone());
        let json = serde_json::to_string(&cursor).unwrap();
        assert_eq!(parse_cursor(Some(&json)), cursor);
        assert_eq!(parse_cursor(None), Cursor::new());
        assert_eq!(parse_cursor(Some("garbage")), Cursor::new());
        let mut newer = seen.clone();
        newer.observed = Some("2026-10-01T07:00:00Z".into());
        assert_ne!(cursor.get("KRZL1"), Some(&newer), "new observations re-emit the site");
    }

    /// Flood categories come from the gauge body in NWPS feet; `-9999` (flow thresholds at 7 of
    /// 8 sites, and any absent category) is not defined, never a number.
    #[test]
    fn nwps_fixture_thresholds_minus_9999_is_missing() {
        let nwps = Nwps::new(carp());
        let rows = nwps.normalize(&gauge("KRZL1")).unwrap();
        let [Row::Thresholds(t)] = rows.as_slice() else { panic!("{rows:?}") };
        assert_eq!(t.site, "KRZL1");
        assert_eq!(t.thresholds, Thresholds { action_ft: Some(28.0), minor_ft: Some(29.0), moderate_ft: Some(40.0), major_ft: Some(43.0) });
        let rows = nwps.normalize(&gauge("MLUL1")).unwrap();
        let [Row::Thresholds(t)] = rows.as_slice() else { panic!("{rows:?}") };
        assert_eq!(t.thresholds, Thresholds { action_ft: Some(35.5), minor_ft: Some(40.0), moderate_ft: Some(43.0), major_ft: Some(45.0) });
        let expect = [("SMML1", 35.0), ("BLRL1", 17.0), ("MCGL1", 4.0), ("BTRL1", 30.0), ("AEXL1", 28.0), ("BXAL1", 16.0)];
        for (lid, action) in expect {
            let rows = nwps.normalize(&gauge(lid)).unwrap();
            let [Row::Thresholds(t)] = rows.as_slice() else { panic!("{rows:?}") };
            assert_eq!(t.thresholds.action_ft, Some(action), "{lid}");
        }
        let mut doc: Value = serde_json::from_slice(&fixture("nwps/KRZL1.json")).unwrap();
        doc["flood"]["categories"]["action"]["stage"] = Value::from(-9999.0);
        doc["flood"]["categories"]["major"] = Value::Null;
        let t = thresholds(&doc);
        assert_eq!(t, Thresholds { action_ft: None, minor_ft: Some(29.0), moderate_ft: Some(40.0), major_ft: None });
        assert_eq!(t.category(Some(28.5)), Some(Category::None), "below minor, action undefined");
        assert!(thresholds(&serde_json::json!({"lid": "X"})).is_empty());
    }

    /// Stageflow: observed hourly rows (`-999` flow is missing) and one forecast snapshot keyed
    /// on `issuedTime`, with the horizon the data proof measured; the hash ignores observations.
    #[test]
    fn nwps_fixture_stageflow_observations_and_forecast() {
        let nwps = Nwps::new(carp());
        let rows = nwps.normalize(&stageflow("KRZL1")).unwrap();
        assert_eq!(rows.len(), 2, "{rows:?}");
        let Row::ForecastObservations(obs) = &rows[0] else { panic!("{:?}", rows[0]) };
        assert_eq!((obs.site.as_str(), obs.source), ("KRZL1", ForecastSource::NwpsLive));
        assert_eq!(obs.observations.len(), 96, "fixture keeps the last 96 observed rows");
        let last = obs.observations.last().unwrap();
        assert_eq!(last.observed_at, parse_rfc3339_ms("2026-10-01T06:00:00Z").unwrap());
        assert_eq!(last.stage_ft, Some(4.05));
        assert_eq!(last.flow_kcfs, None, "observed flow is -999 at Krotz Springs: missing, not a number");
        let Row::ForecastSnapshot(snap) = &rows[1] else { panic!("{:?}", rows[1]) };
        assert_eq!((snap.site.as_str(), snap.product.as_str(), snap.source), ("KRZL1", "stageflow", ForecastSource::NwpsLive));
        assert_eq!(snap.issued_at, parse_rfc3339_ms("2026-09-30T15:32:00Z").unwrap());
        assert_eq!(snap.ingested_at, RECORDED_AT);
        assert_eq!(snap.points.len(), 56);
        assert_eq!(snap.points[0].valid_at, parse_rfc3339_ms("2026-09-30T18:00:00Z").unwrap());
        assert_eq!(snap.points.last().unwrap().valid_at, parse_rfc3339_ms("2026-10-14T12:00:00Z").unwrap());
        assert!(snap.points.iter().all(|p| p.flow_kcfs.is_none()), "KRZL1 forecast flow is -9999: missing");
        let peak = snap.points.iter().filter_map(|p| p.stage_ft).fold(f64::MIN, f64::max);
        assert_eq!(peak, 9.0);

        // Monroe: observed flow in kcfs (8.11), forecast flow present.
        let rows = nwps.normalize(&stageflow("MLUL1")).unwrap();
        let Row::ForecastObservations(obs) = &rows[0] else { panic!() };
        assert_eq!(obs.observations.last().unwrap().flow_kcfs, Some(8.11));
        let Row::ForecastSnapshot(snap) = &rows[1] else { panic!() };
        assert_eq!(snap.points.len(), 20);
        assert!(snap.points.iter().all(|p| p.flow_kcfs.is_some()));

        // Same forecast, new observations: same payload hash (a duplicate, not a revision).
        let mut doc: Value = serde_json::from_slice(&fixture("nwps/KRZL1.stageflow.json")).unwrap();
        let before = normalize_stageflow("KRZL1", &doc, RECORDED_AT).unwrap();
        doc["observed"]["issuedTime"] = Value::from("2026-10-01T07:00:00Z");
        doc["observed"]["data"][0]["primary"] = Value::from(9.9);
        let after = normalize_stageflow("KRZL1", &doc, RECORDED_AT + 3_600_000).unwrap();
        let hash = |rows: &[Row]| match &rows[1] {
            Row::ForecastSnapshot(s) => s.payload_hash.clone(),
            other => panic!("{other:?}"),
        };
        assert_eq!(hash(&before), hash(&after));
        doc["forecast"]["data"][0]["primary"] = Value::from(9.9);
        assert_ne!(hash(&before), hash(&normalize_stageflow("KRZL1", &doc, RECORDED_AT).unwrap()));
        // Flow in cfs is converted to kcfs; a body with no forecast gives observations only.
        doc["observed"]["secondaryUnits"] = Value::from("cfs");
        let n = doc["observed"]["data"].as_array().unwrap().len();
        doc["observed"]["data"][n - 1]["secondary"] = Value::from(128.0);
        doc["forecast"] = Value::Null;
        let rows = normalize_stageflow("KRZL1", &doc, RECORDED_AT).unwrap();
        assert_eq!(rows.len(), 1);
        let Row::ForecastObservations(obs) = &rows[0] else { panic!() };
        assert_eq!(obs.observations.last().unwrap().flow_kcfs, Some(0.128));
    }

    /// Through the pipeline into the carp app: thresholds, observations and one snapshot per
    /// site, categorised against the NWPS thresholds (MCGL1 peaks at its 4 ft action stage); a
    /// second ingest writes nothing; a new `issuedTime` is a new version next to the old one.
    #[tokio::test]
    async fn nwps_ingest_idempotent_and_versions_on_issued_time() {
        let state = test_state_for("carp");
        let first = ingest_all(&state).await;
        assert!(first.iter().all(|o| o.status == RunStatus::Ok && o.rows_skipped == 0 && o.error.is_none()), "{first:?}");
        let (snapshots, points, obs, thresholds): (i64, i64, i64, i64) = state
            .obs
            .read(|c| {
                c.query_row(
                    "select (select count(*) from forecast_snapshots), (select count(*) from forecast_points),
                            (select count(*) from forecast_observations), (select count(*) from forecast_thresholds)",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
            })
            .await
            .unwrap();
        assert_eq!((snapshots, thresholds), (8, 8));
        assert_eq!(points, 56 * 4 + 59 + 20 + 20 + 40, "the data proof's point counts");
        assert_eq!(obs, 8 * 96);
        let (mcgl1, cov) = state.obs.read(|c| Ok((query::asof(c, "MCGL1", i64::MAX)?.unwrap(), query::coverage(c, "MCGL1")?))).await.unwrap();
        assert_eq!(mcgl1.peak().map(|p| (p.stage_ft, p.category)), Some((Some(4.0), Some(Category::Action))), "at or above the 4 ft action stage");
        assert_eq!(mcgl1.source, ForecastSource::NwpsLive);
        assert_eq!(cov.live_coverage_start, Some(RECORDED_AT));
        let t = state.obs.read(|c| store::thresholds_asof(c, "KRZL1", i64::MAX)).await.unwrap().unwrap();
        assert_eq!(t.action_ft, Some(28.0));
        // Live rows are knowable from their ingest (wall clock) time, so ask as of now.
        let now = physical::now_ms();
        let status = state.obs.read(move |c| query::status_at(c, "KRZL1", now, 1.0)).await.unwrap();
        assert_eq!(status.observation.map(|o| o.stage_ft), Some(Some(4.05)));
        assert_eq!(status.category, Some(Category::None));

        let again = ingest_all(&state).await;
        assert!(again.iter().all(|o| o.rows_written == 0), "{again:?}");

        // A new issuance for KRZL1: a second snapshot, the first kept; the feed state knows the source.
        let mut doc: Value = serde_json::from_slice(&fixture("nwps/KRZL1.stageflow.json")).unwrap();
        doc["forecast"]["issuedTime"] = Value::from("2026-10-01T15:30:00Z");
        let raw = recorded(&stageflow_url("KRZL1"), "application/json", doc.to_string().into_bytes(), 200, RECORDED_AT + 9 * 3_600_000);
        let out = ingest_payload(&state, &Nwps::new(state.app.clone()), raw, None).await.unwrap();
        assert_eq!(out.rows_written, 1, "{out:?}");
        let h = state.obs.read(|c| query::history(c, "KRZL1", i64::MAX, 10)).await.unwrap();
        assert_eq!(h.iter().map(|s| query::iso(s.issued_at)).collect::<Vec<_>>(), ["2026-10-01T15:30:00Z", "2026-09-30T15:32:00Z"]);
        let feeds = crate::feed_state::compute(&state.obs, RECORDED_AT + 3_600_000).await.unwrap();
        let f = feeds.iter().find(|f| f.source == "nwps").expect("nwps registered by its first payload");
        assert_eq!(f.mode, "poll");
        assert_eq!(f.newest_observed_at, Some(parse_rfc3339_ms("2026-10-01T06:15:00Z").unwrap()), "newest NWPS observation across sites");

        // A site that is not in carp.json is skipped and counted.
        let raw = recorded(&stageflow_url("VLSL1"), "application/json", fixture("nwps/KRZL1.stageflow.json"), 200, RECORDED_AT);
        let out = ingest_payload(&state, &Nwps::new(state.app.clone()), raw, None).await.unwrap();
        assert_eq!((out.rows_in, out.rows_skipped, out.status), (2, 2, RunStatus::Partial));
    }
}
