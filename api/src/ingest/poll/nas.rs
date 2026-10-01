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
//!
//! **Global mode** (`params.global`, Lionfish Watch, L1): NAS is not US-only (Mexico, Belize and
//! Colombia records exist; Colombia's newest is 2016) and has no bbox parameter, so the poll asks
//! for the whole genus with no `state` and no `year`, `params.pageLimit` rows a page,
//! `params.parallelPages` pages at once (one 4000-row page takes ~25 s server side; four in
//! parallel took 17 s for all 12,418 Pterois records on 2026-10-01), then sequentially while the
//! last page came back full. Request starts stay 1 s apart (the shared pacer). `normalize` keeps
//! the app's areas. Cadence: `params.cadenceDays` (default daily; Lionfish Watch weekly).
//! Staleness per area comes from the stored rows (`quality_bio::area_summary`).

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

fn param<'a>(app: &'a App, key: &str) -> Option<&'a serde_json::Value> {
    app.cfg.feed(ID).and_then(|f| f.params.get(key))
}

/// Global mode: whole genus, no state and no year (see the module docs).
pub fn global(app: &App) -> bool {
    param(app, "global").and_then(|v| v.as_bool()).unwrap_or(false)
}

/// `(rows per page, pages in parallel)` of global mode.
pub fn global_paging(app: &App) -> (usize, usize) {
    let n = |k: &str, d: usize| param(app, k).and_then(|v| v.as_u64()).filter(|n| *n > 0).map(|n| n as usize).unwrap_or(d);
    (n("pageLimit", 4000), n("parallelPages", 4))
}

/// Poll cadence (`params.cadenceDays`, default [`CADENCE`]).
pub fn cadence(app: &App) -> Duration {
    param(app, "cadenceDays").and_then(|v| v.as_u64()).filter(|n| *n > 0).map(|d| Duration::from_secs(d * 86_400)).unwrap_or(CADENCE)
}

pub fn global_url(base: &str, genus: &str, offset: usize, limit: usize) -> String {
    format!("{base}?genus={genus}&offset={offset}&limit={limit}")
}

/// Every record of every genus of the app, global mode: the first `parallel` pages of a genus at
/// once, then page by page while the last one was full. Any failed page fails the walk.
pub async fn fetch_global(state: &crate::state::AppState, pacer: &Pacer, app: &App) -> anyhow::Result<Vec<RawPayload>> {
    fetch_global_from(state, pacer, app, API).await
}

/// [`fetch_global`] against another search endpoint (tests).
pub async fn fetch_global_from(state: &crate::state::AppState, pacer: &Pacer, app: &App, base: &str) -> anyhow::Result<Vec<RawPayload>> {
    let (limit, parallel) = global_paging(app);
    let mut out = Vec::new();
    for genus in genera(app) {
        let first: Vec<String> = (0..parallel).map(|i| global_url(base, &genus, i * limit, limit)).collect();
        let pages = futures_util::future::try_join_all(first.iter().map(|u| bio::get_page(state, pacer, u))).await?;
        let mut offset = parallel * limit;
        let mut last_full = pages.last().map(|p| page_len(&p.bytes) >= limit).unwrap_or(false);
        out.extend(pages);
        while last_full {
            let page = bio::get_page(state, pacer, &global_url(base, &genus, offset, limit)).await?;
            last_full = page_len(&page.bytes) >= limit;
            offset += limit;
            out.push(page);
        }
    }
    Ok(out)
}

/// Rows in one page body (0 when it does not parse; `normalize` reports the error).
fn page_len(bytes: &[u8]) -> usize {
    serde_json::from_slice::<Page>(bytes).map(|p| p.results.len()).unwrap_or(0)
}

#[async_trait]
impl Source for Nas {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: ID,
            name: "USGS Nonindigenous Aquatic Species",
            homepage: "https://nas.er.usgs.gov",
            mode: Mode::Poll,
            cadence: cadence(&self.app),
            max_latency: Duration::from_secs(60 * 24 * 3600),
        }
    }

    fn min_interval(&self) -> Duration {
        cadence(&self.app)
    }

    async fn fetch(&self, ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
        if global(&self.app) {
            return fetch_global(ctx.state, &self.pacer, &self.app).await;
        }
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
            submitted_at: None,
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

    // ---- Lionfish Watch (L4, gates/leaf-L4.md G3) ----

    /// Global `genus=Pterois`, no `state` and no `year`, 4000-row pages four at a time, weekly;
    /// the python app keeps `state=FL`, the year walk and its daily poll.
    #[test]
    fn lionfish_nas_global_query_weekly_python_unchanged() {
        let lf = lionfish();
        assert!(global(&lf) && state_filter(&lf).is_none());
        assert_eq!(global_paging(&lf), (4000, 4));
        assert_eq!(global_url(API, "Pterois", 8000, 4000), "https://nas.er.usgs.gov/api/v2/occurrence/search?genus=Pterois&offset=8000&limit=4000");
        assert_eq!(cadence(&lf), Duration::from_secs(7 * 86_400));
        assert_eq!(Nas::new(lf.clone()).info().cadence, Duration::from_secs(7 * 86_400));
        assert_eq!(Nas::new(lf).min_interval(), Duration::from_secs(7 * 86_400));
        let py = python();
        assert!(!global(&py));
        assert_eq!((state_filter(&py).as_deref(), cadence(&py)), (Some("FL"), CADENCE));
    }

    /// The first pages go out together (the 1 s pacer only spaces their starts), then the walk
    /// continues page by page while the last page was full.
    #[tokio::test]
    async fn lionfish_nas_pages_in_parallel_then_until_short() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        // 7 records, 2 a page, 3 pages at once: offsets 0, 2, 4 together, then 6 (one record).
        let mut v: serde_json::Value = serde_json::from_str(crate::app::config::builtin_json("lionfish").unwrap()).unwrap();
        let nas = v["feeds"].as_array_mut().unwrap().iter_mut().find(|f| f["source"] == "nas").unwrap();
        nas["params"]["pageLimit"] = 2.into();
        nas["params"]["parallelPages"] = 3.into();
        let app = crate::app::config::App::new(crate::app::config::AppConfig::parse("t.json", &v.to_string()).unwrap()).unwrap();
        let inflight = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let (i2, p2, s2) = (inflight.clone(), peak.clone(), seen.clone());
        let handler = move |axum::extract::RawQuery(q): axum::extract::RawQuery| {
            let (inflight, peak, seen) = (i2.clone(), p2.clone(), s2.clone());
            async move {
                let q = q.unwrap_or_default();
                seen.lock().unwrap().push(q.clone());
                let now = inflight.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(300)).await;
                inflight.fetch_sub(1, Ordering::SeqCst);
                let offset: usize = q.split('&').find_map(|kv| kv.strip_prefix("offset=")).unwrap().parse().unwrap();
                let results: Vec<serde_json::Value> = (offset..(offset + 2).min(7)).map(|k| serde_json::json!({ "key": k })).collect();
                axum::Json(serde_json::json!({ "results": results }))
            }
        };
        let router = axum::Router::new().route("/search", axum::routing::get(handler));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let state = crate::app::test_support::test_state_for("lionfish");
        let pacer = Pacer::new(Duration::from_millis(20));
        let pages = fetch_global_from(&state, &pacer, &app, &format!("http://{addr}/search")).await.unwrap();
        assert_eq!(pages.iter().map(|p| page_len(&p.bytes)).collect::<Vec<_>>(), [2, 2, 2, 1]);
        let mut qs = seen.lock().unwrap().clone();
        qs.sort();
        assert_eq!(qs, ["genus=Pterois&offset=0&limit=2", "genus=Pterois&offset=2&limit=2", "genus=Pterois&offset=4&limit=2", "genus=Pterois&offset=6&limit=2"]);
        assert_eq!(peak.load(Ordering::SeqCst), 3, "the first three pages were in flight together");
    }

    /// The recorded global pull, ingested into Lionfish Watch: records in Mexico, Belize and
    /// Colombia are stored next to Florida's, records outside every area are not, and each area
    /// shows how old its newest NAS record is (Colombia: 2016).
    #[tokio::test]
    async fn lionfish_nas_stores_records_outside_florida_with_staleness() {
        use crate::ingest::quality_bio::{area_summary, DateBasis};
        let state = crate::app::test_support::test_state_for("lionfish");
        let src = Nas::new(state.app.clone());
        let raw = crate::ingest::poll::inat::tests::payload(&global_url(API, "Pterois", 0, 4000), fixture("nas/pterois-global.json"));
        let out = crate::ingest::scheduler::ingest_payload(&state, &src, raw, None).await.unwrap();
        assert_eq!((out.rows_in, out.rows_written), (459, 459), "464 recorded, the 5 outside every area dropped");
        let app = state.app.clone();
        let rows = state.obs.read(move |c| area_summary(c, &app, 0, i64::MAX, DateBasis::Observed)).await.unwrap();
        let nas: Vec<(String, i64, String)> = rows
            .iter()
            .filter(|r| r.source == ID)
            .map(|r| {
                let newest = chrono::DateTime::from_timestamp_millis(r.newest_observed_at.unwrap()).unwrap().format("%Y-%m-%d").to_string();
                (r.code.clone(), r.total, newest)
            })
            .collect();
        // Full pull on 2026-10-01: fl 3691 (60 newest kept here), mx 319, bz 33, co 47.
        assert_eq!(
            nas,
            [
                ("fl".to_string(), 60, "2026-05-14".to_string()),
                ("mx".to_string(), 319, "2026-02-13".to_string()),
                ("bz".to_string(), 33, "2026-02-24".to_string()),
                ("co".to_string(), 47, "2016-02-23".to_string()),
            ]
        );
        let south: i64 = state
            .obs
            .read(|c| c.query_row("select count(*) from sightings where source_id = 'nas' and lat < 22", [], |r| r.get(0)))
            .await
            .unwrap();
        assert_eq!(south, 319 + 33 + 47, "every Mexico, Belize and Colombia record is stored");
    }
}
