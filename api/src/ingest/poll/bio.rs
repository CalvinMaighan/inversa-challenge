//! Biological source registry (T9) and the helpers the three bio pollers share: region and
//! taxon scope from the app config, request pacing, paged HTTP, and Eastern-time conversion.

use std::sync::Arc;
use std::time::Duration;

use chrono::{Datelike, NaiveDate, NaiveDateTime, NaiveTime, Timelike, Weekday};

use crate::app::config::{App, BBox, Taxon};
use crate::ingest::governor;
use crate::ingest::source::{RawPayload, Source};
use crate::state::{AppState, Config};

use super::{gbif, inat, nas};

/// The bio pollers the app's `feeds[]` lists, in ingest order (iNat before NAS and GBIF, which
/// link to it as duplicates).
pub fn sources(_config: &Config, app: &Arc<App>) -> Vec<Arc<dyn Source>> {
    let mut out: Vec<Arc<dyn Source>> = Vec::new();
    if app.cfg.has_feed(inat::ID) {
        out.push(Arc::new(inat::Inat::new(app.clone())));
    }
    if app.cfg.has_feed(nas::ID) {
        out.push(Arc::new(nas::Nas::new(app.clone())));
    }
    if app.cfg.has_feed(gbif::ID) {
        out.push(Arc::new(gbif::Gbif::new(app.clone())));
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Scope: regions and taxa (PLAN.md C-A4)
// ---------------------------------------------------------------------------------------------

/// Is the point inside one of the app's regions?
pub fn in_region(app: &App, lat: f64, lon: f64) -> bool {
    app.region_of(lat, lon).is_some()
}

/// `(region id, bbox)` of every region, in config order: the per-region query loop of the
/// paged pollers.
pub fn region_boxes(app: &App) -> Vec<(String, BBox)> {
    app.regions.iter().map(|r| (r.cfg.id.clone(), r.cfg.bbox)).collect()
}

/// The focus taxon an iNat lineage (taxon id first, then ancestors) collapses to.
pub fn taxon_for_inat<'a>(app: &'a App, lineage: &[i64]) -> Option<&'a Taxon> {
    app.taxa.iter().find(|t| t.matches_inat(lineage.iter().copied()))
}

pub fn taxon_for_gbif(app: &App, species_key: Option<i64>, genus_key: Option<i64>) -> Option<&Taxon> {
    app.taxa.iter().find(|t| t.matches_gbif(species_key, genus_key))
}

pub fn taxon_for_nas<'a>(app: &'a App, genus: &str, species: &str) -> Option<&'a Taxon> {
    app.taxa.iter().find(|t| t.matches_nas(genus, species))
}

// ---------------------------------------------------------------------------------------------
// Request pacing and paged fetches
// ---------------------------------------------------------------------------------------------

/// Minimum gap between two request starts. One per upstream, shared by every app's adapter for
/// that upstream (`Pacer::shared`) and across fetch calls, so the etiquette holds within a paged
/// fetch, across back-to-back fetches, and across the three apps polling the same API.
#[derive(Debug)]
pub struct Pacer {
    interval: Duration,
    last: tokio::sync::Mutex<Option<tokio::time::Instant>>,
}

impl Pacer {
    pub fn new(interval: Duration) -> Self {
        Pacer { interval, last: tokio::sync::Mutex::new(None) }
    }

    /// The process-wide pacer of `source_id`, created on first use. Two apps that both poll iNat
    /// share one, so the process never exceeds the upstream's rate.
    pub fn shared(source_id: &str, interval: Duration) -> Arc<Pacer> {
        static PACERS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Arc<Pacer>>>> = std::sync::OnceLock::new();
        let mut map = PACERS.get_or_init(Default::default).lock().unwrap_or_else(|p| p.into_inner());
        map.entry(source_id.to_string()).or_insert_with(|| Arc::new(Pacer::new(interval))).clone()
    }

    pub fn interval(&self) -> Duration {
        self.interval
    }

    /// Wait until `interval` has passed since the previous call returned, then claim the slot.
    pub async fn wait(&self) {
        let mut last = self.last.lock().await;
        if let Some(at) = *last {
            tokio::time::sleep_until(at + self.interval).await;
        }
        *last = Some(tokio::time::Instant::now());
    }
}

/// A resumable walk over a paged API. `next_url` is `None` once the walk is complete.
pub trait Pager: Send {
    fn next_url(&self) -> Option<String>;
    /// Consume one fetched page and move to the next request.
    fn advance(&mut self, body: &[u8]) -> anyhow::Result<()>;
    /// Cursor to persist once the page just consumed is committed.
    fn cursor(&self) -> Option<String>;
}

/// GET one page, paced. Non-2xx responses become `governor::HttpStatusError` so 429/5xx and
/// `Retry-After` reach the governor.
pub async fn get_page(state: &AppState, pacer: &Pacer, url: &str) -> anyhow::Result<RawPayload> {
    pacer.wait().await;
    let fetched_at = crate::state::now_ms();
    let res = state.http.get(url).header("accept", "application/json").send().await?;
    let res = governor::check_response(res)?;
    let status = res.status().as_u16();
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or(v).trim().to_string())
        .unwrap_or_else(|| "application/json".into());
    let bytes = res.bytes().await?.to_vec();
    Ok(RawPayload {
        source_url: url.to_string(),
        content_type,
        bytes,
        http_status: Some(status),
        fetched_at,
        next_cursor: None,
        ack: None,
    })
}

/// Walk `pager` for at most `max_requests` pages (all of them when `None`), returning the pages
/// with their cursors. Any request error fails the whole fetch: nothing is committed, the cursor
/// stays put, and the scheduler hands the error to the governor.
pub async fn collect_pages(
    state: &AppState,
    pacer: &Pacer,
    pager: &mut dyn Pager,
    max_requests: Option<usize>,
) -> anyhow::Result<Vec<RawPayload>> {
    let mut out = Vec::new();
    while let Some(url) = pager.next_url() {
        if max_requests.is_some_and(|max| out.len() >= max) {
            break;
        }
        let mut raw = get_page(state, pacer, &url).await?;
        pager.advance(&raw.bytes)?;
        raw.next_cursor = pager.cursor();
        out.push(raw);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------------------------

/// UTC offset in hours of US Eastern time for a local wall-clock time: -4 during daylight time
/// (second Sunday of March 02:00 to first Sunday of November 02:00, the rule since 2007), else -5.
/// Every point of the bbox is in the Eastern zone.
pub fn eastern_offset_hours(local: NaiveDateTime) -> i64 {
    let year = local.year();
    let start = NaiveDate::from_weekday_of_month_opt(year, 3, Weekday::Sun, 2);
    let end = NaiveDate::from_weekday_of_month_opt(year, 11, Weekday::Sun, 1);
    let (Some(start), Some(end)) = (start, end) else { return -5 };
    let two = NaiveTime::from_hms_opt(2, 0, 0).expect("02:00");
    if local >= start.and_time(two) && local < end.and_time(two) {
        -4
    } else {
        -5
    }
}

/// Eastern wall-clock time to unix ms.
pub fn eastern_to_ms(local: NaiveDateTime) -> i64 {
    (local - chrono::Duration::hours(eastern_offset_hours(local))).and_utc().timestamp_millis()
}

/// A calendar date with no time: placed at local noon, so it is at most 12 h from any moment of
/// that day.
pub fn eastern_noon_ms(date: NaiveDate) -> i64 {
    eastern_to_ms(date.and_hms_opt(12, 0, 0).expect("noon"))
}

/// RFC 3339 with an offset, a naive Eastern date-time, or a bare date (Eastern noon).
pub fn parse_time_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(t.timestamp_millis());
    }
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"] {
        if let Ok(t) = NaiveDateTime::parse_from_str(s, fmt) {
            return Some(eastern_to_ms(t));
        }
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().map(eastern_noon_ms)
}

/// RFC 3339 UTC with whole seconds, for query parameters.
pub fn rfc3339_utc(ms: i64) -> String {
    let t = chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default();
    t.with_nanosecond(0).unwrap_or(t).format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// Percent-encode a query value (RFC 3986 unreserved set kept).
pub fn encode(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    for b in v.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
pub(crate) mod testing {
    use std::sync::Arc;

    use crate::app::config::App;

    /// The python app as the bio adapters see it (taxa resolved to the seeded ids).
    pub fn python() -> Arc<App> {
        Arc::new(crate::hotspot::score::testkit::python_app())
    }

    pub fn lionfish() -> Arc<App> {
        let mut app = App::builtin("lionfish").unwrap();
        app.taxa[0].taxon_id = 4;
        Arc::new(app)
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{lionfish, python};
    use super::*;

    fn local(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S").unwrap()
    }

    #[test]
    fn bio_eastern_offset_follows_us_dst() {
        assert_eq!(eastern_offset_hours(local("2026-01-11T01:50:00")), -5);
        assert_eq!(eastern_offset_hours(local("2026-03-08T01:59:59")), -5);
        assert_eq!(eastern_offset_hours(local("2026-03-08T02:00:00")), -4);
        assert_eq!(eastern_offset_hours(local("2026-07-04T12:00:00")), -4);
        assert_eq!(eastern_offset_hours(local("2026-11-01T01:59:59")), -4);
        assert_eq!(eastern_offset_hours(local("2026-11-01T02:00:00")), -5);
    }

    #[test]
    fn bio_parse_time_forms_agree() {
        // The same instant as iNat reports it and as GBIF re-publishes it (naive local).
        let inat = parse_time_ms("2026-01-11T01:50:00-05:00").unwrap();
        assert_eq!(parse_time_ms("2026-01-11T01:50").unwrap(), inat);
        assert_eq!(parse_time_ms("2026-09-08T12:23:20").unwrap(), parse_time_ms("2026-09-08T12:23:20-04:00").unwrap());
        assert_eq!(parse_time_ms("2026-05-02").unwrap(), parse_time_ms("2026-05-02T12:00:00-04:00").unwrap());
        assert_eq!(parse_time_ms("2026-05"), None);
        assert_eq!(parse_time_ms(""), None);
    }

    #[test]
    fn bio_region_and_encoding() {
        let app = python();
        assert!(in_region(&app, 25.5, -80.5));
        assert!(!in_region(&app, 29.67, -84.83));
        let lf = lionfish();
        assert!(in_region(&lf, 20.5, -87.0), "Cozumel is in the Mexican Caribbean region");
        assert!(!in_region(&lf, 29.67, -84.83));
        assert_eq!(region_boxes(&lf).len(), 4);
        assert_eq!(encode("2026-09-01T00:00:00Z"), "2026-09-01T00%3A00%3A00Z");
        assert_eq!(rfc3339_utc(1_790_000_000_123), "2026-09-21T14:13:20Z");
    }

    #[test]
    fn bio_pacers_are_shared_per_upstream_across_apps() {
        let a = Pacer::shared("bio-test-shared", Duration::from_millis(5));
        let b = Pacer::shared("bio-test-shared", Duration::from_millis(50));
        assert!(Arc::ptr_eq(&a, &b), "second caller gets the same pacer, first interval wins");
        assert_eq!(b.interval(), Duration::from_millis(5));
        assert!(!Arc::ptr_eq(&a, &Pacer::shared("bio-test-other", Duration::from_millis(5))));
    }

    #[test]
    fn bio_registry_has_three_sources() {
        let ids: Vec<&str> = sources(&Config::for_tests(), &python()).iter().map(|s| s.info().id).collect();
        assert_eq!(ids, ["inat", "nas", "gbif"]);
        let ids: Vec<&str> = sources(&Config::for_tests(), &lionfish()).iter().map(|s| s.info().id).collect();
        assert_eq!(ids, ["inat", "nas", "gbif"]);
        let carp = Arc::new(App::builtin("carp").unwrap());
        assert!(sources(&Config::for_tests(), &carp).is_empty(), "carp lists no bio feed");
    }
}
