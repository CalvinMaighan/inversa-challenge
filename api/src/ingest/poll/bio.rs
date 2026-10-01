//! Biological source registry (T9) and the helpers the three bio pollers share: region test,
//! focus-taxon refs, request pacing, paged HTTP, and Eastern-time conversion.

use std::sync::Arc;
use std::time::Duration;

use chrono::{Datelike, NaiveDate, NaiveDateTime, NaiveTime, Timelike, Weekday};

use crate::ingest::governor;
use crate::ingest::source::{RawPayload, Source};
use crate::model::TaxonRef;
use crate::state::{AppState, Config};

use super::{gbif, inat, nas};

pub fn sources(_config: &Config) -> Vec<Arc<dyn Source>> {
    vec![Arc::new(inat::Inat::new()), Arc::new(nas::Nas::new()), Arc::new(gbif::Gbif::new())]
}

// ---------------------------------------------------------------------------------------------
// Region and taxa (PLAN.md C15, migration seed)
// ---------------------------------------------------------------------------------------------

pub const WEST: f64 = -83.2;
pub const SOUTH: f64 = 24.3;
pub const EAST: f64 = -79.8;
pub const NORTH: f64 = 27.5;

pub fn in_region(lat: f64, lon: f64) -> bool {
    (SOUTH..=NORTH).contains(&lat) && (WEST..=EAST).contains(&lon)
}

/// Focus taxa, `taxa.id` 1-4. The scientific names match the migration seed exactly, which is
/// how the row writer resolves them to the fixed ids.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    Python,
    Tegu,
    Iguana,
    Lionfish,
}

impl Focus {
    pub fn scientific_name(self) -> &'static str {
        match self {
            Focus::Python => "Python bivittatus",
            Focus::Tegu => "Salvator merianae",
            Focus::Iguana => "Iguana iguana",
            Focus::Lionfish => "Pterois volitans/miles",
        }
    }

    pub fn common_name(self) -> &'static str {
        match self {
            Focus::Python => "Burmese python",
            Focus::Tegu => "Argentine black and white tegu",
            Focus::Iguana => "Green iguana",
            Focus::Lionfish => "Lionfish",
        }
    }

    /// iNat taxon id of the focus taxon (the lionfish row stands for the genus Pterois).
    pub fn inat_taxon_id(self) -> i64 {
        match self {
            Focus::Python => 238252,
            Focus::Tegu => 318758,
            Focus::Iguana => 35342,
            Focus::Lionfish => 47284,
        }
    }

    pub fn iconic_group(self) -> &'static str {
        match self {
            Focus::Lionfish => "Actinopterygii",
            _ => "Reptilia",
        }
    }

    pub fn taxon(self) -> TaxonRef {
        TaxonRef {
            scientific_name: self.scientific_name().into(),
            common_name: self.common_name().into(),
            inat_taxon_id: Some(self.inat_taxon_id()),
            iconic_group: Some(self.iconic_group().into()),
            // The seeded rows carry their ancestry (migration 0005); the adapter need not repeat it.
            ancestor_ids: None,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Request pacing and paged fetches
// ---------------------------------------------------------------------------------------------

/// Minimum gap between two request starts. One per source, shared across fetch calls, so the
/// etiquette holds within a paged fetch and across back-to-back fetches.
#[derive(Debug)]
pub struct Pacer {
    interval: Duration,
    last: tokio::sync::Mutex<Option<tokio::time::Instant>>,
}

impl Pacer {
    pub fn new(interval: Duration) -> Self {
        Pacer { interval, last: tokio::sync::Mutex::new(None) }
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
    let fetched_at = chrono::Utc::now().timestamp_millis();
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
mod tests {
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
        assert!(in_region(25.5, -80.5));
        assert!(!in_region(29.67, -84.83));
        assert_eq!(encode("2026-09-01T00:00:00Z"), "2026-09-01T00%3A00%3A00Z");
        assert_eq!(rfc3339_utc(1_790_000_000_123), "2026-09-21T14:13:20Z");
    }

    #[test]
    fn bio_registry_has_three_sources() {
        let ids: Vec<&str> = sources(&Config::for_tests()).iter().map(|s| s.info().id).collect();
        assert_eq!(ids, ["inat", "nas", "gbif"]);
    }
}
