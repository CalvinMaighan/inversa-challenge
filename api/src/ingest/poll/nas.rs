//! USGS Nonindigenous Aquatic Species (NAS) API v2 poller (T9, PRD §2): polled daily; curated
//! records that lag weeks.
//!
//! `occurrence/search?genus=<g>[&state=<s>]&year=<y>&offset=&limit=` for every genus the app's
//! taxa name (`taxa[].nasGenus`). `year` takes a single year, so a walk is genus x year, each
//! paged by `offset`/`limit`. The daily poll re-reads the current and previous year (late
//! records land there); the backfill walks the baseline years. The `state` filter comes from the
//! feed's `params.state` (`FL` for the python app; null for Lionfish Watch, whose regions lie
//! outside the US, since NAS has no bbox parameter); `normalize` keeps only the app's regions.
//!
//! Measured on 2026-09-30: NAS holds Python (9,329 FL records) and Pterois (7,026) but returns
//! nothing for Salvator or Iguana (its lizard list is Varanus only). The two genera are still
//! queried, so records appear if NAS adds them.
//!
//! Records carry a calendar date only (`year`/`month`/`day`); they are placed at Eastern noon.
//! Records without a day are skipped: they cannot be placed on the 15-minute timeline or
//! deduplicated within 24 h.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{Datelike, NaiveDate};
use serde::Deserialize;

use super::bio::{self, Pacer, Pager};
use crate::app::config::App;
use crate::ingest::source::{FetchCtx, Mode, RawPayload, Source, SourceInfo};
use crate::model::{Quality, Row, SightingRow, TaxonRef};

pub const ID: &str = "nas";
pub const API: &str = "https://nas.er.usgs.gov/api/v2/occurrence/search";
pub const REQUEST_INTERVAL: Duration = Duration::from_secs(1);
pub const CADENCE: Duration = Duration::from_secs(24 * 3600);
pub const PAGE_LIMIT: usize = 500;
/// Years the daily poll re-reads, counting back from the current one.
pub const LIVE_YEARS: i32 = 2;

pub struct Nas {
    app: Arc<App>,
    pacer: Arc<Pacer>,
}

impl Nas {
    pub fn new(app: Arc<App>) -> Self {
        Nas { app, pacer: Pacer::shared(ID, REQUEST_INTERVAL) }
    }

    pub fn pacer(&self) -> &Pacer {
        &self.pacer
    }

    pub fn pager(&self, from_year: i32, to_year: i32) -> NasPager {
        NasPager::new(&self.app, from_year, to_year)
    }
}

/// Distinct genera of the app's taxa, in taxa order.
pub fn genera(app: &App) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for g in app.taxa.iter().filter_map(|t| t.cfg.nas_genus.clone()) {
        if !out.contains(&g) {
            out.push(g);
        }
    }
    out
}

/// The `state=` filter of the feed (`params.state`), if any.
pub fn state_filter(app: &App) -> Option<String> {
    app.cfg.feed(ID).and_then(|f| f.params.get("state")).and_then(|v| v.as_str()).map(str::to_string)
}

#[async_trait]
impl Source for Nas {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: ID,
            name: "USGS Nonindigenous Aquatic Species",
            homepage: "https://nas.er.usgs.gov",
            mode: Mode::Poll,
            cadence: CADENCE,
            max_latency: Duration::from_secs(60 * 24 * 3600),
        }
    }

    async fn fetch(&self, ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
        let year = chrono::Utc::now().year();
        let mut pager = self.pager(year - LIVE_YEARS + 1, year);
        bio::collect_pages(ctx.state, &self.pacer, &mut pager, None).await
    }

    fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
        normalize(&raw.bytes, &self.app)
    }
}

/// genus x year x offset.
pub struct NasPager {
    queries: Vec<(String, i32)>,
    state: Option<String>,
    offset: usize,
    limit: usize,
}

impl NasPager {
    pub fn new(app: &App, from_year: i32, to_year: i32) -> Self {
        let queries = genera(app).into_iter().flat_map(|g| (from_year..=to_year).map(move |y| (g.clone(), y))).collect();
        NasPager { queries, state: state_filter(app), offset: 0, limit: PAGE_LIMIT }
    }
}

#[derive(Deserialize)]
struct Page {
    #[serde(default)]
    results: Vec<Record>,
    #[serde(rename = "endOfRecords")]
    end_of_records: Option<serde_json::Value>,
}

impl Pager for NasPager {
    fn next_url(&self) -> Option<String> {
        let (genus, year) = self.queries.first()?;
        let state = self.state.as_deref().map(|s| format!("&state={s}")).unwrap_or_default();
        Some(format!("{API}?genus={genus}{state}&year={year}&offset={}&limit={}", self.offset, self.limit))
    }

    fn advance(&mut self, body: &[u8]) -> anyhow::Result<()> {
        let page: Page = serde_json::from_slice(body)?;
        // endOfRecords arrives as the string "true"/"false".
        let end = match &page.end_of_records {
            Some(serde_json::Value::Bool(b)) => *b,
            Some(serde_json::Value::String(s)) => s == "true",
            _ => false,
        };
        if end || page.results.len() < self.limit {
            if !self.queries.is_empty() {
                self.queries.remove(0);
            }
            self.offset = 0;
        } else {
            self.offset += self.limit;
        }
        Ok(())
    }

    fn cursor(&self) -> Option<String> {
        None
    }
}

#[derive(Deserialize)]
struct Record {
    key: i64,
    genus: Option<String>,
    species: Option<String>,
    #[serde(rename = "scientificName")]
    scientific_name: Option<String>,
    #[serde(rename = "commonName")]
    common_name: Option<String>,
    #[serde(rename = "decimalLatitude")]
    lat: Option<f64>,
    #[serde(rename = "decimalLongitude")]
    lon: Option<f64>,
    year: Option<i32>,
    month: Option<u32>,
    day: Option<u32>,
}

fn taxon(r: &Record, app: &App) -> Option<TaxonRef> {
    let genus = r.genus.as_deref().unwrap_or("").trim();
    let species = r.species.as_deref().unwrap_or("").trim();
    if let Some(f) = bio::taxon_for_nas(app, genus, species) {
        return Some(f.taxon_ref());
    }
    let name = r.scientific_name.as_deref().map(str::trim).filter(|n| !n.is_empty())?;
    Some(TaxonRef::named(name, r.common_name.clone().unwrap_or_default()))
}

/// Pure: one search page to rows, the app's regions only, day-precision dates only.
pub fn normalize(bytes: &[u8], app: &App) -> anyhow::Result<Vec<Row>> {
    let page: Page = serde_json::from_slice(bytes)?;
    let mut rows = Vec::new();
    for r in &page.results {
        let (Some(lat), Some(lon)) = (r.lat, r.lon) else { continue };
        if !bio::in_region(app, lat, lon) {
            continue;
        }
        let (Some(y), Some(m), Some(d)) = (r.year, r.month, r.day) else { continue };
        let Some(date) = NaiveDate::from_ymd_opt(y, m, d) else { continue };
        let Some(taxon) = taxon(r, app) else { continue };
        rows.push(Row::Sighting(SightingRow {
            ext_id: r.key.to_string(),
            taxon,
            lat,
            lon,
            accuracy_m: None,
            observed_at: bio::eastern_noon_ms(date),
            quality: Quality::Curated,
            photo_url: None,
        }));
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::poll::bio::testing::{lionfish, python};
    use crate::ingest::poll::inat::tests::fixture;

    fn sightings(bytes: &[u8]) -> Vec<SightingRow> {
        normalize(bytes, &python())
            .unwrap()
            .into_iter()
            .map(|r| match r {
                Row::Sighting(s) => s,
                other => panic!("unexpected {other:?}"),
            })
            .collect()
    }

    #[test]
    fn nas_normalize_fixtures() {
        let python = sightings(&fixture("nas/python-2026-p1.json"));
        assert_eq!(python.len(), 20, "all 20 recorded python records are in the bbox with full dates");
        assert!(python.iter().all(|s| s.taxon.scientific_name == "Python bivittatus" && s.quality == Quality::Curated));

        let lionfish = sightings(&fixture("nas/pterois-2026-p1.json"));
        assert_eq!(lionfish.len(), 11);
        let s = lionfish.iter().find(|s| s.ext_id == "1936573").unwrap();
        assert_eq!(s.taxon.scientific_name, "Pterois volitans/miles");
        assert_eq!(s.observed_at, bio::parse_time_ms("2026-01-11T12:00:00-05:00").unwrap());
        assert_eq!((s.lat, s.lon, s.accuracy_m), (26.51123, -80.04861, None));

        assert!(sightings(&fixture("nas/salvator-2026-p1.json")).is_empty());
        assert!(sightings(&fixture("nas/iguana-2026-p1.json")).is_empty());
        // Lionfish Watch keeps the Florida Pterois records (its fl-keys region) and nothing of the python page as a focus taxon.
        let lf = super::super::bio::testing::lionfish();
        let rows = normalize(&fixture("nas/pterois-2026-p1.json"), &lf).unwrap();
        assert_eq!(rows.len(), 11);
        let rows = normalize(&fixture("nas/python-2026-p1.json"), &lf).unwrap();
        assert!(rows.iter().all(|r| matches!(r, Row::Sighting(s) if s.taxon.scientific_name == "Python bivittatus" && s.taxon.inat_taxon_id.is_none())));
    }

    #[test]
    fn nas_normalize_drops_out_of_region_and_undated() {
        let page = serde_json::json!({ "count": 3, "endOfRecords": "true", "results": [
            // Real record 1724805 (Apalachicola, outside the bbox).
            { "key": 1724805, "genus": "Pterois", "species": "volitans/miles", "scientificName": "Pterois volitans/miles",
              "decimalLatitude": 29.67368, "decimalLongitude": -84.83114, "year": 2024, "month": 1, "day": 13 },
            { "key": 32088, "genus": "Pterois", "species": "volitans/miles", "scientificName": "Pterois volitans/miles",
              "decimalLatitude": 25.730323, "decimalLongitude": -80.222855, "year": 1992, "month": 8, "day": null },
            { "key": 7, "genus": "Python", "species": "sebae", "scientificName": "Python sebae", "commonName": "African rock python",
              "decimalLatitude": 25.7, "decimalLongitude": -80.4, "year": 2025, "month": 2, "day": 3 }
        ]});
        let s = sightings(&serde_json::to_vec(&page).unwrap());
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].taxon, TaxonRef::named("Python sebae", "African rock python"));
    }

    #[test]
    fn nas_pager_walks_genus_year_offset() {
        let mut p = NasPager::new(&python(), 2025, 2026);
        p.limit = 2;
        assert_eq!(
            p.next_url().unwrap(),
            "https://nas.er.usgs.gov/api/v2/occurrence/search?genus=Python&state=FL&year=2025&offset=0&limit=2"
        );
        let full = br#"{"endOfRecords":"false","results":[{"key":1},{"key":2}]}"#;
        p.advance(full).unwrap();
        assert!(p.next_url().unwrap().ends_with("year=2025&offset=2&limit=2"));
        p.advance(br#"{"endOfRecords":"true","results":[{"key":3}]}"#).unwrap();
        assert!(p.next_url().unwrap().contains("genus=Python&state=FL&year=2026&offset=0"));
        let mut urls = 2;
        while p.next_url().is_some() {
            p.advance(br#"{"endOfRecords":"true","results":[]}"#).unwrap();
            urls += 1;
        }
        assert_eq!(urls, 2 + 7, "4 genera x 2 years, one extra page for Python 2025");
        assert_eq!(p.cursor(), None);
        // Lionfish Watch: one genus, no state filter (NAS has no bbox parameter; normalize filters).
        let p = NasPager::new(&lionfish(), 2026, 2026);
        assert_eq!(
            p.next_url().unwrap(),
            "https://nas.er.usgs.gov/api/v2/occurrence/search?genus=Pterois&year=2026&offset=0&limit=500"
        );
        assert_eq!(genera(&python()), ["Python", "Salvator", "Iguana", "Pterois"]);
    }
}
