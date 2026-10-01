//! Iowa Environmental Mesonet HML river forecast archive (leaf C4; docs/ingest-modes.md C7).
//! NWPS keeps no forecast history; IEM (Iowa State University, not NOAA) archives every NWS
//! HML forecast product. `hml.py?station={lid}&sts=...&ets=...&kind=forecasts&fmt=csv` returns
//! one CSV row per forecast point: `station, issued[UTC], primaryname, primaryunits,
//! secondaryname, secondaryunits, forecast_valid[UTC], primary_value, secondary_value`.
//!
//! Every distinct `issued[UTC]` becomes one `Row::ForecastSnapshot` with `product = hml`,
//! `source = iem-archive` and its true `issued_at`, so an as-of view before our first live
//! capture replays what the NWS had published (`forecast::query::asof` gates archive rows by
//! `issued_at` only). The payload hash is the sha256 of that issuance's CSV lines, so a re-pull
//! of the same window is a `Duplicate` and a corrected issuance a revision.
//!
//! Schedule: `params.days` (default 30) of history on the first fetch (the replay window), then
//! daily: each fetch asks from a day before the last committed fetch (the cursor) to now, so a
//! late-archived product is still picked up. One request per site, 500 ms apart; IEM publishes
//! no limit and asks to be cached, which the cursor does. Categories come from the NWPS
//! thresholds stored by `poll::nwps`, so the NWPS poll runs first in `backfill`.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::app::config::App;
use crate::forecast::store::NewSnapshot;
use crate::forecast::{clean_value, Point, Source as ForecastSource};
use crate::ingest::governor;
use crate::ingest::poll::physical::{self, parse_num, parse_utc_ms};
use crate::ingest::source::{FetchCtx, Mode, RawPayload, Source, SourceInfo};
use crate::model::Row;

pub const SOURCE_ID: &str = "iem";
pub const API: &str = "https://mesonet.agron.iastate.edu/cgi-bin/request/hml.py";
pub const DEFAULT_DAYS: i64 = 30;
pub const DAY_MS: i64 = 86_400_000;
const POLITE_GAP: Duration = Duration::from_millis(500);

/// `2026-09-24T00:00Z`, the minute precision hml.py takes.
pub fn iso_minute(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms).map(|t| t.format("%Y-%m-%dT%H:%MZ").to_string()).unwrap_or_default()
}

pub fn url(lid: &str, from_ms: i64, to_ms: i64) -> String {
    format!("{API}?station={lid}&sts={}&ets={}&kind=forecasts&fmt=csv", iso_minute(from_ms), iso_minute(to_ms))
}

/// The lid of an hml.py URL.
pub fn lid_from_url(url: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|kv| kv.strip_prefix("station=")).map(|s| s.trim().to_ascii_uppercase()).filter(|s| !s.is_empty())
}

/// The window to request given the last committed fetch time: `[cursor - 1 day, now]`, or the
/// last `days` days on the first fetch.
pub fn window(cursor_ms: Option<i64>, now_ms: i64, days: i64) -> (i64, i64) {
    let from = match cursor_ms {
        Some(c) => (c - DAY_MS).min(now_ms),
        None => now_ms - days.max(1) * DAY_MS,
    };
    (from, now_ms)
}

pub struct Iem {
    sites: Vec<String>,
    days: i64,
}

impl Iem {
    pub fn new(app: Arc<App>) -> Self {
        let params = app.cfg.feed(SOURCE_ID).map(|f| f.params.clone()).unwrap_or_default();
        let days = params.get("days").and_then(Value::as_i64).filter(|d| (1..=365).contains(d)).unwrap_or(DEFAULT_DAYS);
        Iem { sites: app.cfg.locations.iter().filter_map(|l| l.nwps.clone()).collect(), days }
    }

    /// `backfill --days N`.
    pub fn with_days(mut self, days: i64) -> Self {
        self.days = days.clamp(1, 365);
        self
    }

    #[cfg(test)]
    pub fn sites(&self) -> &[String] {
        &self.sites
    }

    #[cfg(test)]
    pub fn days(&self) -> i64 {
        self.days
    }
}

#[async_trait]
impl Source for Iem {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: SOURCE_ID,
            name: "IEM HML river forecast archive (Iowa State)",
            homepage: "https://mesonet.agron.iastate.edu/request/hml.php",
            mode: Mode::Poll,
            cadence: Duration::from_secs(24 * 3600),
            max_latency: Duration::from_secs(3 * 24 * 3600),
        }
    }

    async fn fetch(&self, ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
        let http = &ctx.state.http;
        let now = physical::now_ms();
        let cursor = ctx.cursor.as_deref().and_then(physical::parse_rfc3339_ms);
        let (from, to) = window(cursor, now, self.days);
        let mut out = Vec::with_capacity(self.sites.len());
        for (i, lid) in self.sites.iter().enumerate() {
            if i > 0 {
                tokio::time::sleep(POLITE_GAP).await;
            }
            let u = url(lid, from, to);
            let res = http.get(&u).send().await.context("iem request")?;
            let res = governor::check_response(res)?;
            let status = res.status().as_u16();
            let content_type = physical::content_type(&res, "text/csv");
            let bytes = res.bytes().await.context("iem body")?.to_vec();
            let mut raw = physical::payload(&u, &content_type, bytes, status, None);
            raw.fetched_at = now;
            out.push(raw);
        }
        if let Some(last) = out.last_mut() {
            last.next_cursor = DateTime::<Utc>::from_timestamp_millis(now).map(|t| t.to_rfc3339());
        }
        Ok(out)
    }

    fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
        let lid = lid_from_url(&raw.source_url).context("iem: no station in the url")?;
        normalize_csv(&lid, &raw.bytes, raw.fetched_at)
    }
}

/// Pure: an hml.py forecasts CSV to one snapshot per issuance. Rows for another station (or
/// without a valid time) are ignored; stage is `primary` (ft), flow `secondary` (kcfs, or cfs
/// converted); empty and sentinel values are missing.
pub fn normalize_csv(lid: &str, bytes: &[u8], fetched_at: i64) -> anyhow::Result<Vec<Row>> {
    let text = std::str::from_utf8(bytes).context("iem: csv is not utf-8")?;
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    let header = lines.next().context("iem: empty csv")?;
    let cols: Vec<&str> = header.split(',').map(str::trim).collect();
    let col = |name: &str| cols.iter().position(|c| *c == name).with_context(|| format!("iem: column {name} missing from {header:?}"));
    let (c_station, c_issued, c_valid, c_primary, c_secondary) =
        (col("station")?, col("issued[UTC]")?, col("forecast_valid[UTC]")?, col("primary_value")?, col("secondary_value")?);
    let (c_punits, c_sunits) = (col("primaryunits").ok(), col("secondaryunits").ok());
    // issued text → (issued_at, [(line, valid_at, stage, flow)])
    let mut issuances: BTreeMap<String, (i64, Vec<(String, Point)>)> = BTreeMap::new();
    for line in lines {
        let f: Vec<&str> = line.split(',').map(str::trim).collect();
        if f.get(c_station).is_none_or(|s| !s.eq_ignore_ascii_case(lid)) {
            continue;
        }
        let (Some(issued), Some(valid)) = (f.get(c_issued), f.get(c_valid)) else { continue };
        let (Some(issued_at), Some(valid_at)) = (parse_utc_ms(issued, "%Y-%m-%d %H:%M"), parse_utc_ms(valid, "%Y-%m-%d %H:%M")) else { continue };
        let num = |i: usize| f.get(i).and_then(|s| parse_num(s));
        let stage_ft = clean_value(num(c_primary)).filter(|_| c_punits.is_none_or(|i| f.get(i).is_none_or(|u| u.eq_ignore_ascii_case("ft"))));
        let flow_kcfs = clean_value(num(c_secondary)).map(|v| if c_sunits.and_then(|i| f.get(i)).is_some_and(|u| u.eq_ignore_ascii_case("cfs")) { v / 1000.0 } else { v });
        issuances.entry(issued.to_string()).or_insert_with(|| (issued_at, Vec::new())).1.push((line.to_string(), Point { valid_at, stage_ft, flow_kcfs }));
    }
    let mut rows = Vec::with_capacity(issuances.len());
    for (_, (issued_at, mut pts)) in issuances {
        pts.sort_by_key(|(_, p)| p.valid_at);
        let mut h = Sha256::new();
        for (line, _) in &pts {
            h.update(line.as_bytes());
            h.update(b"\n");
        }
        rows.push(Row::ForecastSnapshot(NewSnapshot {
            site: lid.to_ascii_uppercase(),
            product: "hml".into(),
            issued_at,
            ingested_at: fetched_at,
            source: ForecastSource::IemArchive,
            payload_hash: hex::encode(h.finalize()),
            points: pts.into_iter().map(|(_, p)| p).collect(),
        }));
    }
    Ok(rows)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::app::test_support::test_state_for;
    use crate::forecast::{query, Category};
    use crate::ingest::poll::physical::testing::{fixture, recorded};
    use crate::ingest::scheduler::{ingest_payload, RunStatus};
    use crate::state::AppState;

    pub const LIDS: [&str; 8] = ["SMML1", "KRZL1", "BLRL1", "MCGL1", "BTRL1", "AEXL1", "MLUL1", "BXAL1"];
    /// 2026-10-01T07:01:03Z, when the fixtures were recorded.
    pub const RECORDED_AT: i64 = 1_790_838_063_000;

    fn carp() -> Arc<App> {
        Arc::new(App::builtin("carp").unwrap())
    }

    pub fn payload(lid: &str) -> RawPayload {
        let manifest: Value = serde_json::from_slice(&fixture("iem/manifest.json")).unwrap();
        let f = manifest["files"].as_array().unwrap().iter().find(|f| f["file"] == format!("{lid}.csv")).unwrap();
        recorded(f["url"].as_str().unwrap(), "text/csv", fixture(&format!("iem/{lid}.csv")), 200, RECORDED_AT)
    }

    pub async fn ingest_all(state: &AppState) -> Vec<crate::ingest::scheduler::IngestOutcome> {
        let iem = Iem::new(state.app.clone());
        let mut out = Vec::new();
        for lid in LIDS {
            out.push(ingest_payload(state, &iem, payload(lid), None).await.unwrap());
        }
        out
    }

    #[test]
    fn iem_url_window_and_config() {
        let iem = Iem::new(carp());
        assert_eq!(iem.sites(), LIDS);
        assert_eq!(iem.days(), 30, "params.days");
        assert_eq!(Iem::new(carp()).with_days(7).days(), 7);
        let now = 1_790_838_063_000;
        assert_eq!(url("KRZL1", now - 7 * DAY_MS, now), "https://mesonet.agron.iastate.edu/cgi-bin/request/hml.py?station=KRZL1&sts=2026-09-24T07:01Z&ets=2026-10-01T07:01Z&kind=forecasts&fmt=csv");
        assert_eq!(lid_from_url(&url("krzl1", 0, 0)).as_deref(), Some("KRZL1"));
        assert_eq!(lid_from_url(API), None);
        assert_eq!(window(None, now, 30), (now - 30 * DAY_MS, now), "first fetch: the replay window");
        assert_eq!(window(Some(now - 3 * DAY_MS), now, 30), (now - 4 * DAY_MS, now), "then from a day before the last fetch");
        assert_eq!(iem.info().cadence, Duration::from_secs(24 * 3600));
        let manifest: Value = serde_json::from_slice(&fixture("iem/manifest.json")).unwrap();
        assert!(manifest["files"][0]["url"].as_str().unwrap().starts_with(&format!("{API}?station=SMML1&sts=")));
    }

    /// Seven issuances per site in the recorded week, each with its true issuance time and
    /// 6-hourly points; sentinels and foreign rows are ignored; the hash is per issuance.
    #[test]
    fn iem_fixture_one_snapshot_per_issuance() {
        let iem = Iem::new(carp());
        let rows = iem.normalize(&payload("KRZL1")).unwrap();
        assert_eq!(rows.len(), 7);
        let snaps: Vec<&NewSnapshot> = rows.iter().map(|r| if let Row::ForecastSnapshot(s) = r { s } else { panic!("{r:?}") }).collect();
        let issued: Vec<String> = snaps.iter().map(|s| query::iso(s.issued_at)).collect();
        assert_eq!(issued[0], "2026-09-24T14:30:00Z");
        assert_eq!(issued[6], "2026-09-30T15:32:00Z", "the issuance NWPS served live on 1 Oct");
        assert!(issued.windows(2).all(|w| w[0] < w[1]));
        let s = snaps[0];
        assert_eq!((s.site.as_str(), s.product.as_str(), s.source, s.ingested_at), ("KRZL1", "hml", ForecastSource::IemArchive, RECORDED_AT));
        assert_eq!(s.points[0], Point { valid_at: parse_utc_ms("2026-09-24 18:00", "%Y-%m-%d %H:%M").unwrap(), stage_ft: Some(3.0), flow_kcfs: Some(120.0) });
        assert_eq!(s.points.len(), 56);
        assert!(s.points.windows(2).all(|w| w[1].valid_at - w[0].valid_at == 6 * 3_600_000), "6-hourly");
        for lid in LIDS {
            assert_eq!(iem.normalize(&payload(lid)).unwrap().len(), 7, "{lid}");
        }
        let csv = "station,issued[UTC],primaryname,primaryunits,secondaryname,secondaryunits,forecast_valid[UTC],primary_value,secondary_value\n\
                   KRZL1,2026-09-24 14:30,Stage,ft,Flow,cfs,2026-09-24 18:00,3.0,120000\n\
                   KRZL1,2026-09-24 14:30,Stage,ft,Flow,cfs,2026-09-25 00:00,-9999,\n\
                   SMML1,2026-09-24 14:30,Stage,ft,Flow,kcfs,2026-09-24 18:00,7.0,100\n\
                   KRZL1,bad,Stage,ft,Flow,kcfs,2026-09-24 18:00,7.0,100\n";
        let rows = normalize_csv("KRZL1", csv.as_bytes(), RECORDED_AT).unwrap();
        let [Row::ForecastSnapshot(s)] = rows.as_slice() else { panic!("{rows:?}") };
        assert_eq!(s.points.len(), 2);
        assert_eq!(s.points[0].flow_kcfs, Some(120.0), "cfs converted to kcfs");
        assert_eq!((s.points[1].stage_ft, s.points[1].flow_kcfs), (None, None), "-9999 and empty are missing");
        assert!(normalize_csv("KRZL1", b"", RECORDED_AT).is_err());
        assert!(normalize_csv("KRZL1", b"a,b\n1,2\n", RECORDED_AT).is_err(), "unknown columns");
    }

    /// Through the pipeline after the NWPS thresholds: 56 archive snapshots with categories,
    /// coverage starts at the oldest issuance; re-running is idempotent; a changed issuance is a
    /// revision next to the first.
    #[tokio::test]
    async fn iem_ingest_idempotent_backfill_with_categories() {
        let state = test_state_for("carp");
        crate::ingest::poll::nwps::tests::ingest_all(&state).await;
        let first = ingest_all(&state).await;
        assert!(first.iter().all(|o| o.status == RunStatus::Ok && o.rows_in == 7 && o.rows_written == 7), "{first:?}");
        let (n, by_source): (i64, String) = state
            .obs
            .read(|c| c.query_row("select count(*), group_concat(distinct source) from forecast_snapshots", [], |r| Ok((r.get(0)?, r.get(1)?))))
            .await
            .unwrap();
        assert_eq!(n, 56 + 8);
        let mut by_source: Vec<&str> = by_source.split(',').collect();
        by_source.sort_unstable();
        assert_eq!(by_source, ["iem-archive", "nwps-live"]);
        let (cov, h, asof) = state
            .obs
            .read(|c| Ok((query::coverage(c, "MCGL1")?, query::history(c, "MCGL1", i64::MAX, 20)?, query::asof(c, "MCGL1", RECORDED_AT - 3 * DAY_MS)?)))
            .await
            .unwrap();
        assert_eq!(cov.snapshots, 8);
        assert_eq!(query::iso(cov.replay_coverage_start.unwrap()), "2026-09-24T14:30:00Z", "replay starts at the oldest archived issuance");
        assert_eq!(cov.live_coverage_start, Some(RECORDED_AT));
        assert_eq!(h.len(), 8);
        let archived = asof.expect("an archive issuance is knowable three days before we captured anything");
        assert_eq!(archived.source, ForecastSource::IemArchive);
        assert!(archived.issued_at <= RECORDED_AT - 3 * DAY_MS);
        assert!(archived.points.iter().any(|p| p.category.is_some()), "categorised against the NWPS thresholds stored first");
        assert!(archived.points.iter().all(|p| p.category != Some(Category::Major)));

        let again = ingest_all(&state).await;
        assert!(again.iter().all(|o| o.rows_written == 0), "re-running the backfill adds nothing: {again:?}");

        // A corrected issuance in the archive: a revision, the first kept.
        let text = String::from_utf8(fixture("iem/KRZL1.csv")).unwrap().replacen("2026-09-24 18:00,3.0,120.0", "2026-09-24 18:00,3.1,120.0", 1);
        let raw = recorded(&payload("KRZL1").source_url, "text/csv", text.into_bytes(), 200, RECORDED_AT + DAY_MS);
        let out = ingest_payload(&state, &Iem::new(state.app.clone()), raw, None).await.unwrap();
        assert_eq!(out.rows_written, 1, "{out:?}");
        let revs: Vec<i64> = state
            .obs
            .read(|c| c.prepare("select revision from forecast_snapshots where site = 'KRZL1' and product = 'hml' and issued_at = ?1 order by revision")?.query_map([parse_utc_ms("2026-09-24 14:30", "%Y-%m-%d %H:%M").unwrap()], |r| r.get(0))?.collect())
            .await
            .unwrap();
        assert_eq!(revs, [0, 1]);
    }
}
