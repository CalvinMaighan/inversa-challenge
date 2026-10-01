//! GBIF occurrence search poller (T9, PRD §2): polled daily; deep history, including a mirror
//! of iNaturalist research-grade observations.
//!
//! Query: the bbox as `decimalLatitude`/`decimalLongitude` ranges plus the four taxonKeys
//! (backbone `species/match`, 2026-09-30): Python bivittatus 4820533, Salvator merianae 5227370,
//! Iguana iguana 2459658, and the genus Pterois 2334432 (covers P. volitans 2334438 and
//! P. miles 2334433). Paged by `offset`/`limit` (300 max; GBIF stops at offset 100,000).
//!
//! - **Daily poll:** `modified=<from>,*`, where `from` is the last successful poll day minus
//!   [`MODIFIED_LAG`], since records reach the index days after their `modified` stamp. The
//!   cursor is the poll day, persisted with the last page.
//! - **Backfill baseline:** `eventDate=<from>,<to>` over the baseline years.
//!
//! **ext_id encoding.** `sightings` has no column for GBIF's `datasetKey` and `catalogNumber`,
//! and migrations are fixed, so `ext_id` is `<datasetKey>:<catalogNumber>:<gbifKey>`
//! (catalogNumber empty when absent). The GBIF key keeps it unique and linkable back to
//! gbif.org. The prefix is the lookup `quality_bio` uses: for the iNat research-grade dataset,
//! `catalogNumber` is the iNat observation id, so the iNat link is a prefix match on the
//! unique `(source_id, ext_id)` index.
//!
//! Quality: the iNat dataset is research grade by construction; every other GBIF dataset is a
//! published institutional or program dataset and maps to `curated`.
//!
//! `eventDate` for iNat records is local time with no offset (`2026-01-11T01:50` for iNat's
//! `2026-01-11T01:50:00-05:00`), so naive times are read as US Eastern. Ranges are kept only
//! when they fall on one day; month- or year-precision dates are skipped.

use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;

use super::bio::{self, Focus, Pacer, Pager};
use crate::ingest::source::{FetchCtx, Mode, RawPayload, Source, SourceInfo};
use crate::model::{Quality, Row, SightingRow, TaxonRef};

pub const ID: &str = "gbif";
pub const API: &str = "https://api.gbif.org/v1/occurrence/search";
/// GBIF dataset key of "iNaturalist Research-grade Observations".
pub const INAT_DATASET_KEY: &str = "50c9509d-22c7-4a22-a47d-8c48425ef4a7";
pub const PYTHON_KEY: i64 = 4820533;
pub const TEGU_KEY: i64 = 5227370;
pub const IGUANA_KEY: i64 = 2459658;
pub const PTEROIS_GENUS_KEY: i64 = 2334432;
pub const TAXON_KEYS: [i64; 4] = [PYTHON_KEY, TEGU_KEY, IGUANA_KEY, PTEROIS_GENUS_KEY];
pub const REQUEST_INTERVAL: Duration = Duration::from_secs(1);
pub const CADENCE: Duration = Duration::from_secs(24 * 3600);
pub const PAGE_LIMIT: usize = 300;
/// Deepest usable offset. GBIF documents 100,000, but measured on 2026-09-30 every search page
/// from offset ~10,000 on stalls mid-body (the 5-year baseline has 14,512 records; offset 9,800
/// answers in 7 s, 10,100 never finishes). `EventDate` walks are split by year to stay under it.
pub const MAX_OFFSET: usize = 10_000;
pub const MODIFIED_LAG: chrono::Duration = chrono::Duration::days(30);

pub struct Gbif {
    pacer: Pacer,
}

impl Gbif {
    pub fn new() -> Self {
        Gbif { pacer: Pacer::new(REQUEST_INTERVAL) }
    }

    pub fn pacer(&self) -> &Pacer {
        &self.pacer
    }
}

#[async_trait]
impl Source for Gbif {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: ID,
            name: "GBIF",
            homepage: "https://www.gbif.org",
            mode: Mode::Poll,
            cadence: CADENCE,
            max_latency: Duration::from_secs(21 * 24 * 3600),
        }
    }

    async fn fetch(&self, ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
        let today = chrono::Utc::now().date_naive();
        let last = ctx.cursor.as_deref().and_then(|c| chrono::NaiveDate::parse_from_str(c, "%Y-%m-%d").ok());
        let from = last.unwrap_or(today) - MODIFIED_LAG;
        let mut pager = GbifPager::new(Filter::Modified { from }, Some(today.format("%Y-%m-%d").to_string()));
        bio::collect_pages(ctx.state, &self.pacer, &mut pager, None).await
    }

    fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
        normalize(&raw.bytes)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Filter {
    /// Records modified since `from` (daily poll).
    Modified { from: chrono::NaiveDate },
    /// Records observed in `[from, to]` (baseline backfill).
    EventDate { from: chrono::NaiveDate, to: chrono::NaiveDate },
}

pub struct GbifPager {
    /// Windows still to walk; the first is current. An `EventDate` range is one window per
    /// calendar year so each stays under [`MAX_OFFSET`].
    windows: std::collections::VecDeque<Filter>,
    offset: usize,
    limit: usize,
    /// Cursor to hand out with the final page only, so a failed walk does not advance it.
    final_cursor: Option<String>,
}

impl GbifPager {
    pub fn new(filter: Filter, final_cursor: Option<String>) -> Self {
        GbifPager { windows: split_by_year(filter).into(), offset: 0, limit: PAGE_LIMIT, final_cursor }
    }

    /// The current window is exhausted: move to the next one from offset 0.
    fn next_window(&mut self) {
        self.windows.pop_front();
        self.offset = 0;
    }
}

/// `EventDate { from, to }` as one window per calendar year (clipped to the range); other
/// filters unchanged.
pub fn split_by_year(filter: Filter) -> Vec<Filter> {
    use chrono::{Datelike, NaiveDate};
    match filter {
        Filter::EventDate { from, to } if from.year() < to.year() => (from.year()..=to.year())
            .map(|y| Filter::EventDate {
                from: from.max(NaiveDate::from_ymd_opt(y, 1, 1).expect("jan 1")),
                to: to.min(NaiveDate::from_ymd_opt(y, 12, 31).expect("dec 31")),
            })
            .collect(),
        other => vec![other],
    }
}

pub fn search_url(filter: Filter, offset: usize, limit: usize) -> String {
    let keys: String = TAXON_KEYS.iter().map(|k| format!("&taxonKey={k}")).collect();
    let filter = match filter {
        Filter::Modified { from } => format!("modified={},*", from.format("%Y-%m-%d")),
        Filter::EventDate { from, to } => format!("eventDate={},{}", from.format("%Y-%m-%d"), to.format("%Y-%m-%d")),
    };
    format!(
        "{API}?decimalLatitude={},{}&decimalLongitude={},{}{keys}&occurrenceStatus=PRESENT&hasCoordinate=true&hasGeospatialIssue=false&{filter}&limit={limit}&offset={offset}",
        bio::SOUTH,
        bio::NORTH,
        bio::WEST,
        bio::EAST
    )
}

#[derive(Deserialize)]
struct PageHead {
    #[serde(rename = "endOfRecords", default)]
    end_of_records: bool,
    #[serde(default)]
    results: Vec<serde_json::Value>,
}

impl Pager for GbifPager {
    fn next_url(&self) -> Option<String> {
        self.windows.front().map(|&w| search_url(w, self.offset, self.limit))
    }

    fn advance(&mut self, body: &[u8]) -> anyhow::Result<()> {
        let page: PageHead = serde_json::from_slice(body)?;
        self.offset += self.limit;
        if page.end_of_records || page.results.len() < self.limit {
            self.next_window();
        } else if self.offset + self.limit > MAX_OFFSET {
            tracing::warn!(source = ID, "GBIF paging limit reached at offset {}; narrow the window", self.offset);
            self.next_window();
        }
        Ok(())
    }

    fn cursor(&self) -> Option<String> {
        if self.windows.is_empty() {
            self.final_cursor.clone()
        } else {
            None
        }
    }
}

#[derive(Deserialize)]
struct Page {
    #[serde(default)]
    results: Vec<Occurrence>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Occurrence {
    key: i64,
    dataset_key: Option<String>,
    catalog_number: Option<String>,
    decimal_latitude: Option<f64>,
    decimal_longitude: Option<f64>,
    coordinate_uncertainty_in_meters: Option<f64>,
    event_date: Option<String>,
    occurrence_status: Option<String>,
    species_key: Option<i64>,
    genus_key: Option<i64>,
    species: Option<String>,
    scientific_name: Option<String>,
    vernacular_name: Option<String>,
    media: Option<Vec<Media>>,
}

#[derive(Deserialize)]
struct Media {
    #[serde(rename = "type")]
    kind: Option<String>,
    identifier: Option<String>,
}

/// `<datasetKey>:<catalogNumber>:<gbifKey>` (see the module docs).
pub fn ext_id(dataset_key: &str, catalog_number: &str, key: i64) -> String {
    format!("{dataset_key}:{catalog_number}:{key}")
}

/// The prefix every GBIF mirror of iNat observation `inat_id` starts with.
pub fn inat_mirror_prefix(inat_id: &str) -> String {
    format!("{INAT_DATASET_KEY}:{inat_id}:")
}

/// The iNat observation id a GBIF `ext_id` mirrors, if it is from the iNat dataset.
pub fn mirrored_inat_id(ext_id: &str) -> Option<&str> {
    let rest = ext_id.strip_prefix(INAT_DATASET_KEY)?.strip_prefix(':')?;
    let (catalog, _key) = rest.rsplit_once(':')?;
    (!catalog.is_empty()).then_some(catalog)
}

fn taxon(o: &Occurrence) -> Option<TaxonRef> {
    let focus = match (o.species_key, o.genus_key) {
        (Some(PYTHON_KEY), _) => Some(Focus::Python),
        (Some(TEGU_KEY), _) => Some(Focus::Tegu),
        (Some(IGUANA_KEY), _) => Some(Focus::Iguana),
        (_, Some(PTEROIS_GENUS_KEY)) => Some(Focus::Lionfish),
        _ => None,
    };
    if let Some(f) = focus {
        return Some(f.taxon());
    }
    let name = o.species.as_deref().or(o.scientific_name.as_deref()).map(str::trim).filter(|n| !n.is_empty())?;
    Some(TaxonRef::named(name, o.vernacular_name.clone().unwrap_or_default()))
}

/// `eventDate` to unix ms: a single instant or day, or a range that stays within one day.
fn event_ms(s: &str) -> Option<i64> {
    match s.split_once('/') {
        None => bio::parse_time_ms(s),
        Some((a, b)) => {
            let day = |x: &str| x.get(..10).map(str::to_string);
            (day(a)? == day(b)?).then(|| bio::parse_time_ms(a)).flatten()
        }
    }
}

/// Pure: one search page to rows.
pub fn normalize(bytes: &[u8]) -> anyhow::Result<Vec<Row>> {
    let page: Page = serde_json::from_slice(bytes)?;
    let mut rows = Vec::with_capacity(page.results.len());
    for o in &page.results {
        if o.occurrence_status.as_deref().is_some_and(|s| !s.eq_ignore_ascii_case("PRESENT")) {
            continue;
        }
        let (Some(lat), Some(lon)) = (o.decimal_latitude, o.decimal_longitude) else { continue };
        let Some(observed_at) = o.event_date.as_deref().and_then(event_ms) else { continue };
        let Some(taxon) = taxon(o) else { continue };
        let dataset = o.dataset_key.as_deref().unwrap_or("");
        let catalog = o.catalog_number.as_deref().unwrap_or("").trim();
        let quality = if dataset == INAT_DATASET_KEY { Quality::Research } else { Quality::Curated };
        let photo_url = o
            .media
            .iter()
            .flatten()
            .find(|m| m.kind.as_deref() == Some("StillImage"))
            .and_then(|m| m.identifier.clone());
        rows.push(Row::Sighting(SightingRow {
            ext_id: ext_id(dataset, catalog, o.key),
            taxon,
            lat,
            lon,
            accuracy_m: o.coordinate_uncertainty_in_meters,
            observed_at,
            quality,
            photo_url,
        }));
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::poll::inat::tests::fixture;

    fn sightings(bytes: &[u8]) -> Vec<SightingRow> {
        normalize(bytes)
            .unwrap()
            .into_iter()
            .map(|r| match r {
                Row::Sighting(s) => s,
                other => panic!("unexpected {other:?}"),
            })
            .collect()
    }

    #[test]
    fn gbif_normalize_fixture() {
        let s = sightings(&fixture("gbif/modified-p1.json"));
        assert_eq!(s.len(), 20);
        let mirror = s.iter().find(|s| s.ext_id.ends_with(":6130701656")).unwrap();
        assert_eq!(mirror.ext_id, "50c9509d-22c7-4a22-a47d-8c48425ef4a7:335508189:6130701656");
        assert_eq!(mirrored_inat_id(&mirror.ext_id), Some("335508189"));
        assert_eq!(mirror.taxon.scientific_name, "Pterois volitans/miles");
        assert_eq!(mirror.quality, Quality::Research);
        assert_eq!(mirror.accuracy_m, Some(2.0));
        // Same instant iNat reports for observation 335508189.
        assert_eq!(mirror.observed_at, bio::parse_time_ms("2026-01-11T01:50:00-05:00").unwrap());
        assert_eq!(
            mirror.photo_url.as_deref(),
            Some("https://inaturalist-open-data.s3.amazonaws.com/photos/609511322/original.jpg")
        );
        // Date-only eventDate lands at Eastern noon.
        let day = s.iter().find(|s| s.ext_id.ends_with(":6251984586")).unwrap();
        assert_eq!(day.observed_at, bio::parse_time_ms("2026-05-02T12:00:00-04:00").unwrap());
        assert_eq!(day.taxon.scientific_name, "Iguana iguana");
    }

    #[test]
    fn gbif_ext_id_helpers() {
        assert_eq!(mirrored_inat_id("50c9509d-22c7-4a22-a47d-8c48425ef4a7::42"), None);
        assert_eq!(mirrored_inat_id("d6cc311c-c5ab-4f23-9a20-10514f9eb9c4:123:42"), None);
        assert_eq!(inat_mirror_prefix("7"), "50c9509d-22c7-4a22-a47d-8c48425ef4a7:7:");
        assert_eq!(event_ms("2020-01-01/2020-01-01"), bio::parse_time_ms("2020-01-01"));
        assert_eq!(event_ms("2020-01-01/2020-12-31"), None);
    }

    #[test]
    fn gbif_normalize_skips_absent_and_imprecise() {
        let page = serde_json::json!({ "results": [
            { "key": 1, "datasetKey": "x", "decimalLatitude": 25.0, "decimalLongitude": -80.5, "eventDate": "2024-03-01",
              "occurrenceStatus": "ABSENT", "speciesKey": PYTHON_KEY },
            { "key": 2, "datasetKey": "x", "decimalLatitude": 25.0, "decimalLongitude": -80.5, "eventDate": "2024-03",
              "speciesKey": PYTHON_KEY },
            { "key": 3, "datasetKey": "x", "catalogNumber": "UF 1", "decimalLatitude": 25.0, "decimalLongitude": -80.5,
              "eventDate": "2024-03-01T10:00:00Z", "speciesKey": 2334433, "genusKey": PTEROIS_GENUS_KEY }
        ]});
        let s = sightings(&serde_json::to_vec(&page).unwrap());
        assert_eq!(s.len(), 1);
        assert_eq!((s[0].ext_id.as_str(), s[0].quality), ("x:UF 1:3", Quality::Curated));
        assert_eq!(s[0].taxon.scientific_name, "Pterois volitans/miles", "P. miles maps to the lionfish taxon");
    }

    #[test]
    fn gbif_pager_pages_and_hands_cursor_on_last_page() {
        let from = chrono::NaiveDate::from_ymd_opt(2026, 8, 31).unwrap();
        let mut p = GbifPager::new(Filter::Modified { from }, Some("2026-09-30".into()));
        let url = p.next_url().unwrap();
        assert_eq!(
            url,
            "https://api.gbif.org/v1/occurrence/search?decimalLatitude=24.3,27.5&decimalLongitude=-83.2,-79.8\
             &taxonKey=4820533&taxonKey=5227370&taxonKey=2459658&taxonKey=2334432&occurrenceStatus=PRESENT\
             &hasCoordinate=true&hasGeospatialIssue=false&modified=2026-08-31,*&limit=300&offset=0"
        );
        let full = serde_json::to_vec(&serde_json::json!({ "endOfRecords": false, "results": vec![serde_json::json!({}); 300] })).unwrap();
        p.advance(&full).unwrap();
        assert_eq!(p.cursor(), None);
        assert!(p.next_url().unwrap().ends_with("&offset=300"));
        p.advance(br#"{"endOfRecords":true,"results":[{}]}"#).unwrap();
        assert_eq!(p.next_url(), None);
        assert_eq!(p.cursor().as_deref(), Some("2026-09-30"));

        let to = chrono::NaiveDate::from_ymd_opt(2026, 9, 30).unwrap();
        let base = GbifPager::new(Filter::EventDate { from, to }, None);
        assert!(base.next_url().unwrap().contains("&eventDate=2026-08-31,2026-09-30&"));
    }

    #[test]
    fn gbif_pager_walks_a_baseline_year_by_year() {
        let d = |y, m, day| chrono::NaiveDate::from_ymd_opt(y, m, day).unwrap();
        let mut p = GbifPager::new(Filter::EventDate { from: d(2024, 9, 30), to: d(2026, 9, 30) }, Some("done".into()));
        let full = serde_json::to_vec(&serde_json::json!({ "endOfRecords": false, "results": vec![serde_json::json!({}); 300] })).unwrap();
        let last = br#"{"endOfRecords":true,"results":[{}]}"#;
        let mut seen = Vec::new();
        // Two pages per year: a full one, then the last.
        while let Some(url) = p.next_url() {
            let window = url.split("eventDate=").nth(1).unwrap().split('&').next().unwrap().to_string();
            let offset = url.rsplit("offset=").next().unwrap().to_string();
            seen.push(format!("{window}@{offset}"));
            assert_eq!(p.cursor(), None, "cursor only after the last window");
            p.advance(if offset == "0" { &full[..] } else { &last[..] }).unwrap();
        }
        assert_eq!(
            seen,
            [
                "2024-09-30,2024-12-31@0",
                "2024-09-30,2024-12-31@300",
                "2025-01-01,2025-12-31@0",
                "2025-01-01,2025-12-31@300",
                "2026-01-01,2026-09-30@0",
                "2026-01-01,2026-09-30@300",
            ]
        );
        assert_eq!(p.cursor().as_deref(), Some("done"));

        // A window that reaches the offset limit moves on instead of requesting a stalling page.
        let mut p = GbifPager::new(Filter::EventDate { from: d(2025, 1, 1), to: d(2026, 1, 31) }, None);
        let mut pages = 0;
        while p.next_url().is_some_and(|u| u.contains("2025-01-01,2025-12-31")) {
            p.advance(&full).unwrap();
            pages += 1;
        }
        assert_eq!(pages, MAX_OFFSET / PAGE_LIMIT);
        assert!(p.next_url().unwrap().contains("eventDate=2026-01-01,2026-01-31&limit=300&offset=0"));
    }
}
