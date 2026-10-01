//! iNaturalist API v1 poller (T9, PRD §2): every 2 min, at most one request per second.
//!
//! Per region of the app, up to two queries over its bbox, both
//! `order_by=updated_at&order=asc&updated_since=<cursor>`:
//! - **focus**: the app's focus taxa. `taxon_name` matches a single name only (a comma list
//!   returns 0 results), so the query uses `taxon_id` with the config's iNat ids
//!   (`taxa[].inatTaxonId`);
//! - **introduced**: `introduced=true`, the background layer. Listed in the feed's
//!   `params.queries`; the python app runs both, Lionfish Watch the focus query only.
//!
//! The persisted cursor is JSON holding every query's position: the flat `{focus, introduced}`
//! form for a single-region app (unchanged from before the pivot), `{"regions": {<id>: {focus,
//! introduced}}}` otherwise. `updated_since` is inclusive, so the next request starts at the
//! newest `updated_at` seen; when a full page all shares one `updated_at`, the walk pages forward
//! within it instead, so nothing is skipped.
//!
//! Identification changes: each identification carries the observation taxon at the time it
//! was added (`previous_observation_taxon`). Walking them in time order, then ending at the
//! current taxon, gives the observation's taxon history. A change that is not a refinement
//! (the old taxon is not an ancestor of the new one) is an ID flip and becomes a
//! `Row::Revision` on field `taxon`; `quality_bio::post_write` marks such sightings `conflict`.
//! Taxa are compared after the focus mapping, so a swap between a species and its own
//! subspecies, or between Pterois species, is not a flip.
//!
//! Dates: `observed_at` is when the animal was seen (`time_observed_at`, else `observed_on`),
//! `submitted_at` when the record was uploaded (`created_at`). Both are stored; time windows count
//! by `observed_at` (L1: median lag 5 d, p90 2099 d).
//!
//! Per-app feed params (`spec/apps/<app>.json`): `cadenceMinutes` (default 2; Lionfish Watch 10),
//! `backfillDays` (first-fetch lookback and the backfill default; default 30, Lionfish Watch 90),
//! `mirrorCatchUp` (each fetch also asks for the iNat originals of stored GBIF iNat-dataset
//! mirrors that have none, by id, so the GBIF copy links to it as a duplicate).

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::bio::{self, Pacer, Pager};
use crate::app::config::{App, BBox};
use crate::ingest::source::{FetchCtx, Mode, RawPayload, Source, SourceInfo};
use crate::model::{Quality, RevisionRow, Row, SightingRow, TaxonRef};

pub const ID: &str = "inat";
pub const API: &str = "https://api.inaturalist.org/v1/observations";
/// iNat asks API clients to stay at or under one request per second.
pub const REQUEST_INTERVAL: Duration = Duration::from_secs(1);
pub const CADENCE: Duration = Duration::from_secs(120);
pub const PER_PAGE: usize = 200;
/// Requests per live fetch across every query; the rest continues on the next cycle. A full
/// v1 page is ~16 MB (about 80 KB per observation, mostly identification and user objects), and
/// a fetch holds its pages until the scheduler ingests them, so this caps that at ~80 MB while
/// still draining 1,000 observations per 2-minute cycle.
pub const MAX_REQUESTS_PER_FETCH: usize = 5;
/// First live fetch with no cursor looks back this far.
pub const INITIAL_LOOKBACK: Duration = Duration::from_secs(30 * 24 * 3600);

/// Ids per `id=` request (the API's `per_page` maximum).
pub const MAX_IDS_PER_REQUEST: usize = 200;

pub struct Inat {
    app: Arc<App>,
    pacer: Arc<Pacer>,
    /// iNat ids already asked for by the mirror catch-up in this process (a deleted or private
    /// observation never comes back; it is not asked for again until restart).
    asked: Mutex<HashSet<String>>,
}

fn param_u64(app: &App, key: &str) -> Option<u64> {
    app.cfg.feed(ID).and_then(|f| f.params.get(key)).and_then(|v| v.as_u64()).filter(|n| *n > 0)
}

/// Poll cadence of the app's iNat feed (`params.cadenceMinutes`, default [`CADENCE`]).
pub fn cadence(app: &App) -> Duration {
    param_u64(app, "cadenceMinutes").map(|m| Duration::from_secs(m * 60)).unwrap_or(CADENCE)
}

/// First-fetch lookback and backfill default in days (`params.backfillDays`, default 30).
pub fn backfill_days(app: &App) -> u32 {
    param_u64(app, "backfillDays").map(|d| d as u32).unwrap_or((INITIAL_LOOKBACK.as_secs() / 86_400) as u32)
}

/// Does the feed fetch iNat originals of unlinked GBIF mirrors (`params.mirrorCatchUp`)?
pub fn mirror_catch_up(app: &App) -> bool {
    app.cfg.feed(ID).and_then(|f| f.params.get("mirrorCatchUp")).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// The API's own count of focus observations in `bbox` observed on or after `d1` (YYYY-MM-DD):
/// `total_results` of a zero-row page. The backfill quotes it next to the stored count.
pub fn count_url(bbox: &BBox, taxon_ids: &[i64], d1: &str) -> String {
    format!(
        "{API}?swlat={}&swlng={}&nelat={}&nelng={}&taxon_id={}&d1={d1}&per_page=0",
        bbox.south,
        bbox.west,
        bbox.north,
        bbox.east,
        taxon_ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",")
    )
}

/// Observations by id, oldest id first.
pub fn ids_url(ids: &[String]) -> String {
    format!("{API}?id={}&order_by=id&order=asc&per_page={MAX_IDS_PER_REQUEST}", ids.join(","))
}

impl Inat {
    pub fn new(app: Arc<App>) -> Self {
        Inat { app, pacer: Pacer::shared(ID, REQUEST_INTERVAL), asked: Mutex::new(HashSet::new()) }
    }

    /// The next batch of mirror originals to ask for: stored GBIF iNat-dataset rows with no
    /// iNat link, minus ids already asked for. Marks the batch as asked.
    pub async fn mirror_batch(&self, state: &crate::state::AppState) -> anyhow::Result<Vec<String>> {
        let missing = state.obs.read(crate::ingest::quality_bio::unlinked_inat_mirrors).await?;
        let mut asked = self.asked.lock().unwrap_or_else(|p| p.into_inner());
        let batch: Vec<String> = missing.into_iter().filter(|id| !asked.contains(id)).take(MAX_IDS_PER_REQUEST).collect();
        asked.extend(batch.iter().cloned());
        Ok(batch)
    }

    pub fn pacer(&self) -> &Pacer {
        &self.pacer
    }

    /// A pager for this app, resumed from `cursor`.
    pub fn pager(&self, cursor: Option<&str>, default_since_ms: i64) -> InatPager {
        InatPager::resume(&self.app, cursor, default_since_ms)
    }
}

#[async_trait]
impl Source for Inat {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: ID,
            name: "iNaturalist",
            homepage: "https://www.inaturalist.org",
            mode: Mode::Poll,
            cadence: cadence(&self.app),
            max_latency: Duration::from_secs(6 * 3600),
        }
    }

    fn min_interval(&self) -> Duration {
        cadence(&self.app)
    }

    async fn fetch(&self, ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
        let now = crate::state::now_ms();
        let lookback = i64::from(backfill_days(&self.app)) * 86_400_000;
        let mut pager = self.pager(ctx.cursor.as_deref(), now - lookback);
        let mut out = bio::collect_pages(ctx.state, &self.pacer, &mut pager, Some(MAX_REQUESTS_PER_FETCH)).await?;
        if mirror_catch_up(&self.app) {
            let ids = self.mirror_batch(ctx.state).await?;
            if !ids.is_empty() {
                // No cursor: the id page does not move the `updated_since` walk.
                out.push(bio::get_page(ctx.state, &self.pacer, &ids_url(&ids)).await?);
            }
        }
        Ok(out)
    }

    fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
        normalize(&raw.bytes, &self.app)
    }
}

// ---------------------------------------------------------------------------------------------
// Cursor and paging
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Query {
    Focus,
    Introduced,
}

impl Query {
    fn parse(s: &str) -> Option<Query> {
        match s {
            "focus" => Some(Query::Focus),
            "introduced" => Some(Query::Introduced),
            _ => None,
        }
    }
}

/// The queries an app's `inat` feed runs (`params.queries`; both when unset or empty). The
/// focus query needs at least one taxon with an iNat id.
pub fn queries(app: &App) -> Vec<Query> {
    let listed: Vec<Query> = app
        .cfg
        .feed(ID)
        .and_then(|f| f.params.get("queries"))
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|q| q.as_str().and_then(Query::parse)).collect())
        .unwrap_or_default();
    let mut out = if listed.is_empty() { vec![Query::Focus, Query::Introduced] } else { listed };
    if focus_taxon_ids(app).is_empty() {
        out.retain(|q| *q != Query::Focus);
    }
    out
}

/// `taxon_id=` list of the focus query: the config's iNat ids, in taxa order.
pub fn focus_taxon_ids(app: &App) -> Vec<i64> {
    app.taxa.iter().filter_map(|t| t.cfg.inat_taxon_id).collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryCursor {
    /// `updated_since`, RFC 3339 UTC.
    pub since: String,
    /// Page within `since` (only above 1 while a full page shares one `updated_at`).
    #[serde(default = "one")]
    pub page: u32,
}

fn one() -> u32 {
    1
}

/// Both queries' positions for one region.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegionCursor {
    pub focus: QueryCursor,
    pub introduced: QueryCursor,
}

impl RegionCursor {
    fn at(since: &str) -> RegionCursor {
        RegionCursor {
            focus: QueryCursor { since: since.to_string(), page: 1 },
            introduced: QueryCursor { since: since.to_string(), page: 1 },
        }
    }

    fn slot(&self, q: Query) -> &QueryCursor {
        match q {
            Query::Focus => &self.focus,
            Query::Introduced => &self.introduced,
        }
    }

    fn slot_mut(&mut self, q: Query) -> &mut QueryCursor {
        match q {
            Query::Focus => &mut self.focus,
            Query::Introduced => &mut self.introduced,
        }
    }
}

/// One position per region, in the app's region order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cursor {
    pub regions: Vec<(String, RegionCursor)>,
}

/// On the wire: the flat `RegionCursor` for one region, `{"regions": {...}}` for several.
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum CursorWire {
    Many { regions: BTreeMap<String, RegionCursor> },
    One(RegionCursor),
}

impl Cursor {
    pub fn region(&self, i: usize) -> &RegionCursor {
        &self.regions[i].1
    }

    /// Resume from persisted JSON for `app`'s regions; a missing, unreadable or
    /// foreign-region position starts at `default_since_ms`.
    pub fn resume(app: &App, cursor: Option<&str>, default_since_ms: i64) -> Cursor {
        let since = bio::rfc3339_utc(default_since_ms);
        let mut known: BTreeMap<String, RegionCursor> = match cursor.and_then(|c| serde_json::from_str::<CursorWire>(c).ok()) {
            Some(CursorWire::Many { regions }) => regions,
            Some(CursorWire::One(r)) => BTreeMap::from([(app.regions[0].cfg.id.clone(), r)]),
            None => BTreeMap::new(),
        };
        let regions =
            app.regions.iter().map(|r| (r.cfg.id.clone(), known.remove(&r.cfg.id).unwrap_or_else(|| RegionCursor::at(&since)))).collect();
        Cursor { regions }
    }

    pub fn to_json(&self) -> String {
        let wire = match self.regions.as_slice() {
            [(_, one)] => CursorWire::One(one.clone()),
            many => CursorWire::Many { regions: many.iter().cloned().collect() },
        };
        serde_json::to_string(&wire).expect("cursor json")
    }
}

pub struct InatPager {
    pub cursor: Cursor,
    /// (region index, query) pairs still to walk in this run, in order.
    pending: Vec<(usize, Query)>,
    boxes: Vec<(String, BBox)>,
    taxon_ids: Vec<i64>,
    per_page: usize,
}

impl InatPager {
    /// Continue from a persisted cursor; a missing or unreadable one starts at `default_since_ms`.
    pub fn resume(app: &App, cursor: Option<&str>, default_since_ms: i64) -> Self {
        let cursor = Cursor::resume(app, cursor, default_since_ms);
        let qs = queries(app);
        let pending = (0..app.regions.len()).flat_map(|r| qs.iter().map(move |q| (r, *q))).collect();
        InatPager { cursor, pending, boxes: bio::region_boxes(app), taxon_ids: focus_taxon_ids(app), per_page: PER_PAGE }
    }

    fn current(&self) -> Option<(usize, Query, &QueryCursor)> {
        let (r, q) = *self.pending.first()?;
        Some((r, q, self.cursor.region(r).slot(q)))
    }
}

pub fn query_url(q: Query, c: &QueryCursor, per_page: usize, bbox: &BBox, taxon_ids: &[i64]) -> String {
    let filter = match q {
        Query::Focus => format!("taxon_id={}", taxon_ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",")),
        Query::Introduced => "introduced=true".to_string(),
    };
    format!(
        "{API}?swlat={}&swlng={}&nelat={}&nelng={}&{filter}&order_by=updated_at&order=asc&updated_since={}&per_page={per_page}&page={}",
        bbox.south,
        bbox.west,
        bbox.north,
        bbox.east,
        bio::encode(&c.since),
        c.page
    )
}

#[derive(Deserialize)]
struct UpdatedPage {
    #[serde(default)]
    results: Vec<Updated>,
}

#[derive(Deserialize)]
struct Updated {
    updated_at: Option<String>,
}

impl Pager for InatPager {
    fn next_url(&self) -> Option<String> {
        self.current().map(|(r, q, c)| query_url(q, c, self.per_page, &self.boxes[r].1, &self.taxon_ids))
    }

    fn advance(&mut self, body: &[u8]) -> anyhow::Result<()> {
        let Some((r, q, c)) = self.current() else { return Ok(()) };
        let since_ms = bio::parse_time_ms(&c.since).unwrap_or(i64::MIN);
        let page: UpdatedPage = serde_json::from_slice(body)?;
        let newest = page.results.iter().filter_map(|o| o.updated_at.as_deref().and_then(bio::parse_time_ms)).max();
        let full = page.results.len() >= self.per_page;
        let slot = self.cursor.regions[r].1.slot_mut(q);
        match newest {
            Some(t) if t > since_ms => *slot = QueryCursor { since: bio::rfc3339_utc(t), page: 1 },
            // A full page stuck on one timestamp: page forward inside it.
            Some(_) if full => slot.page += 1,
            _ => {}
        }
        if !full {
            slot.page = 1;
            self.pending.remove(0);
        }
        Ok(())
    }

    fn cursor(&self) -> Option<String> {
        Some(self.cursor.to_json())
    }
}

// ---------------------------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct Page {
    #[serde(default)]
    results: Vec<Obs>,
}

#[derive(Deserialize)]
struct Obs {
    id: i64,
    quality_grade: Option<String>,
    time_observed_at: Option<String>,
    observed_on: Option<String>,
    created_at: Option<String>,
    positional_accuracy: Option<f64>,
    public_positional_accuracy: Option<f64>,
    obscured: Option<bool>,
    geojson: Option<GeoJson>,
    location: Option<String>,
    taxon: Option<Taxon>,
    photos: Option<Vec<Photo>>,
    identifications: Option<Vec<Ident>>,
}

#[derive(Deserialize)]
struct GeoJson {
    coordinates: Option<Vec<f64>>,
}

#[derive(Deserialize, Clone)]
struct Taxon {
    id: i64,
    name: String,
    preferred_common_name: Option<String>,
    ancestor_ids: Option<Vec<i64>>,
    /// iNat's coarse group (Reptilia, Aves, Plantae, Insecta, ...), stored as `taxa.iconic_group`.
    iconic_taxon_name: Option<String>,
}

#[derive(Deserialize)]
struct Photo {
    url: Option<String>,
}

#[derive(Deserialize)]
struct Ident {
    created_at: Option<String>,
    previous_observation_taxon: Option<Taxon>,
}

impl Taxon {
    fn lineage(&self) -> Vec<i64> {
        std::iter::once(self.id).chain(self.ancestor_ids.iter().flatten().copied()).collect()
    }

    /// The taxon as stored: focus taxa (and anything below them) collapse to the config's name.
    fn to_ref(&self, app: &App) -> TaxonRef {
        match bio::taxon_for_inat(app, &self.lineage()) {
            Some(f) => f.taxon_ref(),
            None => TaxonRef {
                scientific_name: self.name.clone(),
                common_name: self.preferred_common_name.clone().unwrap_or_default(),
                inat_taxon_id: Some(self.id),
                iconic_group: Some(crate::taxon_info::iconic_group(self.iconic_taxon_name.as_deref()).to_string()),
                ancestor_ids: self.ancestor_ids.clone(),
            },
        }
    }

    fn is_ancestor_of(&self, other: &Taxon) -> bool {
        other.lineage().contains(&self.id)
    }
}

fn quality(grade: Option<&str>) -> Quality {
    match grade {
        Some("research") => Quality::Research,
        Some("needs_id") => Quality::NeedsId,
        _ => Quality::Casual,
    }
}

/// iNat photo URLs come as the `square` size; the same path serves `medium`.
fn medium_photo(url: &str) -> String {
    match url.rsplit_once('/') {
        Some((dir, file)) => match file.split_once('.') {
            Some(("square", ext)) => format!("{dir}/medium.{ext}"),
            _ => url.to_string(),
        },
        None => url.to_string(),
    }
}

fn coords(o: &Obs) -> Option<(f64, f64)> {
    if let Some(c) = o.geojson.as_ref().and_then(|g| g.coordinates.as_ref()) {
        if let [lon, lat] = c[..] {
            return Some((lat, lon));
        }
    }
    let (lat, lon) = o.location.as_deref()?.split_once(',')?;
    Some((lat.trim().parse().ok()?, lon.trim().parse().ok()?))
}

/// ID flips in the observation's taxon history (see the module docs).
fn taxon_revisions(o: &Obs, current: &Taxon, app: &App) -> Vec<RevisionRow> {
    let mut history: Vec<(i64, &Taxon)> = o
        .identifications
        .iter()
        .flatten()
        .filter_map(|i| Some((bio::parse_time_ms(i.created_at.as_deref()?)?, i.previous_observation_taxon.as_ref()?)))
        .collect();
    history.sort_by_key(|(at, _)| *at);
    let mut out = Vec::new();
    for (k, (at, before)) in history.iter().enumerate() {
        let after = history.get(k + 1).map(|(_, t)| *t).unwrap_or(current);
        let (old, new) = (before.to_ref(app), after.to_ref(app));
        if old.scientific_name == new.scientific_name || before.is_ancestor_of(after) {
            continue;
        }
        out.push(RevisionRow {
            sighting_ext_id: o.id.to_string(),
            field: "taxon".into(),
            old: Some(old.scientific_name),
            new: Some(new.scientific_name),
            changed_at: *at,
        });
    }
    out
}

/// Pure: one `/v1/observations` page to rows. Observations without a taxon, a location or a
/// date are skipped; each kept observation yields its sighting, then its taxon revisions.
pub fn normalize(bytes: &[u8], app: &App) -> anyhow::Result<Vec<Row>> {
    let page: Page = serde_json::from_slice(bytes)?;
    let mut rows = Vec::with_capacity(page.results.len());
    for o in &page.results {
        let Some(taxon) = &o.taxon else { continue };
        let Some((lat, lon)) = coords(o) else { continue };
        let observed_at = o
            .time_observed_at
            .as_deref()
            .and_then(bio::parse_time_ms)
            .or_else(|| o.observed_on.as_deref().and_then(bio::parse_time_ms));
        let Some(observed_at) = observed_at else { continue };
        // Obscured observations are shown at a randomized point; the public accuracy covers it.
        let accuracy_m = if o.obscured.unwrap_or(false) {
            o.public_positional_accuracy.or(o.positional_accuracy)
        } else {
            o.positional_accuracy
        };
        let photo_url = o.photos.iter().flatten().find_map(|p| p.url.as_deref()).map(medium_photo);
        rows.push(Row::Sighting(SightingRow {
            ext_id: o.id.to_string(),
            taxon: taxon.to_ref(app),
            lat,
            lon,
            accuracy_m,
            observed_at,
            submitted_at: o.created_at.as_deref().and_then(bio::parse_time_ms),
            quality: quality(o.quality_grade.as_deref()),
            photo_url,
        }));
        rows.extend(taxon_revisions(o, taxon, app).into_iter().map(Row::Revision));
    }
    Ok(rows)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::app::test_support::test_state;
    use crate::ingest::poll::bio::testing::{lionfish, python};
    use crate::ingest::scheduler::ingest_payload;
    use crate::state::AppState;

    pub fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(format!("{}/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))).expect("fixture")
    }

    pub fn payload(url: &str, bytes: Vec<u8>) -> RawPayload {
        RawPayload {
            source_url: url.into(),
            content_type: "application/json".into(),
            bytes,
            http_status: Some(200),
            fetched_at: 1_790_800_000_000,
            next_cursor: None,
            ack: None,
        }
    }

    fn sightings(rows: &[Row]) -> Vec<&SightingRow> {
        rows.iter()
            .filter_map(|r| match r {
                Row::Sighting(s) => Some(s),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn inat_min_interval() {
        // Etiquette: >= 1 s between requests, one fetch per 2 min.
        assert!(REQUEST_INTERVAL >= Duration::from_secs(1));
        let src = Inat::new(python());
        assert!(src.pacer().interval() >= Duration::from_secs(1));
        assert!(src.min_interval() >= Duration::from_secs(1));
        assert_eq!(src.info().cadence, Duration::from_secs(120));
        assert_eq!(src.min_interval(), Duration::from_secs(120));
        // And the pacer really spaces request starts.
        let rt = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        rt.block_on(async {
            let pacer = Pacer::new(REQUEST_INTERVAL);
            let t0 = tokio::time::Instant::now();
            pacer.wait().await;
            let first = t0.elapsed();
            pacer.wait().await;
            let second = t0.elapsed();
            assert!(first < Duration::from_millis(200), "first request is not delayed: {first:?}");
            assert!(second >= REQUEST_INTERVAL, "second request waited only {second:?}");
        });
    }

    #[test]
    fn inat_normalize_focus_fixture() {
        let app = python();
        let rows = normalize(&fixture("inat/focus-p1.json"), &app).unwrap();
        let s = sightings(&rows);
        assert_eq!(s.len(), 12);
        let lionfish = s.iter().find(|s| s.ext_id == "335508189").unwrap();
        assert_eq!(lionfish.taxon.scientific_name, "Pterois volitans/miles");
        assert_eq!(lionfish.quality, Quality::Research);
        assert_eq!(lionfish.accuracy_m, Some(2.0));
        assert_eq!(lionfish.observed_at, bio::parse_time_ms("2026-01-11T06:50:00Z").unwrap());
        assert!((lionfish.lat - 26.5112304039).abs() < 1e-9 && (lionfish.lon + 80.0486087189).abs() < 1e-9);
        assert_eq!(
            lionfish.photo_url.as_deref(),
            Some("https://inaturalist-open-data.s3.amazonaws.com/photos/609511322/medium.jpg")
        );
        // Obscured: the public accuracy (29868 m), not the private 3 m.
        let obscured = s.iter().find(|s| s.ext_id == "339784054").unwrap();
        assert_eq!(obscured.accuracy_m, Some(29868.0));
        // Missing accuracy stays missing.
        assert_eq!(s.iter().find(|s| s.ext_id == "398728771").unwrap().accuracy_m, None);
        let names: std::collections::BTreeSet<&str> = s.iter().map(|s| s.taxon.scientific_name.as_str()).collect();
        assert_eq!(names.into_iter().collect::<Vec<_>>(), ["Iguana iguana", "Pterois volitans/miles", "Python bivittatus"]);
        // Python 50359044-style refinements are not flips; this page has none.
        assert!(rows.iter().all(|r| !matches!(r, Row::Revision(_))));

        // The lionfish app maps only Pterois to a focus taxon; a python stays its own iNat taxon.
        let lf_rows = normalize(&fixture("inat/focus-p1.json"), &crate::ingest::poll::bio::testing::lionfish()).unwrap();
        let lf = sightings(&lf_rows);
        assert_eq!(lf.len(), 12, "normalize keeps every observation; the bbox filter is the query's");
        let python = lf.iter().find(|s| s.taxon.scientific_name == "Python bivittatus").unwrap();
        assert_eq!(python.taxon.inat_taxon_id, Some(238252));
        assert!(python.taxon.ancestor_ids.is_some(), "a non-focus taxon keeps its ancestry");
        assert_eq!(lf.iter().find(|s| s.ext_id == "335508189").unwrap().taxon.ancestor_ids, None, "focus taxon ref");
    }

    #[test]
    fn inat_normalize_introduced_fixture_is_background() {
        let rows = normalize(&fixture("inat/introduced-p1.json"), &python()).unwrap();
        let s = sightings(&rows);
        assert_eq!(s.len(), 10);
        let q: Vec<Quality> = s.iter().map(|s| s.quality).collect();
        assert!(q.contains(&Quality::Research) && q.contains(&Quality::NeedsId));
        let c = s.iter().find(|s| s.ext_id == "404195742").unwrap();
        assert_eq!(c.taxon.scientific_name, "Ctenosaura similis");
        assert_eq!(c.taxon.common_name, "Black Spiny-tailed Iguana");
        let revs: Vec<&RevisionRow> = rows
            .iter()
            .filter_map(|r| match r {
                Row::Revision(r) => Some(r),
                _ => None,
            })
            .collect();
        // Real dispute on 392369238: an ID moved it from Calotropis procera up to the genus
        // before it was refined to C. gigantea. The coarsening is the flip; the refinement is not.
        assert_eq!(revs.len(), 1, "{revs:?}");
        assert_eq!(
            (revs[0].sighting_ext_id.as_str(), revs[0].old.as_deref(), revs[0].new.as_deref()),
            ("392369238", Some("Calotropis procera"), Some("Calotropis"))
        );
        assert_eq!(s.iter().find(|s| s.ext_id == "392369238").unwrap().taxon.scientific_name, "Calotropis gigantea");
    }

    #[test]
    fn inat_normalize_is_pure() {
        let bytes = fixture("inat/focus-p1.json");
        let app = python();
        assert_eq!(normalize(&bytes, &app).unwrap(), normalize(&bytes, &app).unwrap());
    }

    #[test]
    fn inat_revision_from_real_maverick_dispute() {
        // Real observation 402428460: a maverick ID moved it from Salvator merianae up to
        // Tupinambinae before the community settled back on Salvator merianae.
        let rows = normalize(&fixture("inat/idflip-p1.json"), &python()).unwrap();
        let revs: Vec<&RevisionRow> = rows
            .iter()
            .filter_map(|r| match r {
                Row::Revision(r) => Some(r),
                _ => None,
            })
            .collect();
        assert_eq!(revs.len(), 1, "{revs:?}");
        assert_eq!(revs[0].sighting_ext_id, "402428460");
        assert_eq!(revs[0].field, "taxon");
        assert_eq!(revs[0].old.as_deref(), Some("Salvator merianae"));
        assert_eq!(revs[0].new.as_deref(), Some("Tupinambinae"));
        assert!(matches!(&rows[0], Row::Sighting(s) if s.taxon.scientific_name == "Salvator merianae"));
    }

    fn inat_page(obs: Vec<serde_json::Value>) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({ "total_results": obs.len(), "page": 1, "per_page": 200, "results": obs }))
            .unwrap()
    }

    fn obs_from(fixture_name: &str, id: i64) -> serde_json::Value {
        let page: serde_json::Value = serde_json::from_slice(&fixture(fixture_name)).unwrap();
        page["results"].as_array().unwrap().iter().find(|o| o["id"] == id).unwrap().clone()
    }

    async fn conflict_and_taxon(state: &AppState, ext_id: &'static str) -> (i64, String) {
        state
            .obs
            .read(move |c| {
                c.query_row(
                    "select s.conflict, t.scientific_name from sightings s join taxa t on t.id = s.taxon_id
                     where s.source_id = 'inat' and s.ext_id = ?1",
                    [ext_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            })
            .await
            .unwrap()
    }

    /// An identification added after ingest flips a real iguana (398479651) to Ctenosaura
    /// similis. The flip is built from real payload parts: the observation from the focus page
    /// and the Ctenosaura taxon object from the introduced page.
    #[tokio::test]
    async fn inat_id_flip_writes_revision_and_conflict() {
        let state = test_state();
        let src = Inat::new(state.app.clone());
        let first = ingest_payload(&state, &src, payload("fixture:focus", fixture("inat/focus-p1.json")), None).await.unwrap();
        assert_eq!(first.rows_written, 12);
        assert_eq!(conflict_and_taxon(&state, "398479651").await, (0, "Iguana iguana".into()));

        let mut obs = obs_from("inat/focus-p1.json", 398479651);
        let ctenosaura = obs_from("inat/introduced-p1.json", 404195742)["taxon"].clone();
        let iguana = obs["taxon"].clone();
        obs["identifications"].as_array_mut().unwrap().push(serde_json::json!({
            "id": 999000001,
            "created_at": "2026-09-30T12:00:00-04:00",
            "current": true,
            "category": "leading",
            "taxon": ctenosaura,
            "previous_observation_taxon": iguana,
        }));
        obs["taxon"] = ctenosaura;
        obs["updated_at"] = "2026-09-30T12:00:05-04:00".into();
        let flip_bytes = inat_page(vec![obs]);
        let flipped = ingest_payload(&state, &src, payload("fixture:flip", flip_bytes.clone()), None).await.unwrap();
        assert_eq!(flipped.rows_in, 2, "sighting + revision");
        assert_eq!(flipped.rows_written, 2);

        assert_eq!(conflict_and_taxon(&state, "398479651").await, (1, "Ctenosaura similis".into()));
        let revs: Vec<(String, Option<String>, Option<String>, i64)> = state
            .obs
            .read(|c| {
                let mut st = c.prepare(
                    "select r.field, r.old, r.new, r.changed_at from sighting_revisions r
                     join sightings s on s.id = r.sighting_id where s.ext_id = '398479651'",
                )?;
                let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
                rows.collect()
            })
            .await
            .unwrap();
        assert_eq!(
            revs,
            vec![(
                "taxon".to_string(),
                Some("Iguana iguana".to_string()),
                Some("Ctenosaura similis".to_string()),
                bio::parse_time_ms("2026-09-30T12:00:00-04:00").unwrap()
            )]
        );
        // The other sightings on the page are untouched.
        let others: i64 = state
            .obs
            .read(|c| c.query_row("select count(*) from sightings where conflict = 1 and ext_id != '398479651'", [], |r| r.get(0)))
            .await
            .unwrap();
        assert_eq!(others, 0);
        // Re-delivering the flipped payload adds nothing.
        let again = ingest_payload(&state, &src, payload("fixture:flip", flip_bytes), None).await.unwrap();
        assert_eq!(again.rows_written, 0);
        let n: i64 = state.obs.read(|c| c.query_row("select count(*) from sighting_revisions", [], |r| r.get(0))).await.unwrap();
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn inat_revision_real_fixture_marks_conflict_and_is_idempotent() {
        let state = test_state();
        let src = Inat::new(state.app.clone());
        let a = ingest_payload(&state, &src, payload("fixture:idflip", fixture("inat/idflip-p1.json")), None).await.unwrap();
        assert_eq!((a.rows_in, a.rows_written, a.rows_skipped), (2, 2, 0));
        assert_eq!(conflict_and_taxon(&state, "402428460").await, (1, "Salvator merianae".into()));
        let b = ingest_payload(&state, &src, payload("fixture:idflip", fixture("inat/idflip-p1.json")), None).await.unwrap();
        assert_eq!(b.rows_written, 0);
        let n: i64 = state.obs.read(|c| c.query_row("select count(*) from sighting_revisions", [], |r| r.get(0))).await.unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn inat_pager_walks_both_queries_and_pages_through_ties() {
        let app = python();
        let mut p = InatPager::resume(&app, None, bio::parse_time_ms("2026-09-01T00:00:00Z").unwrap());
        p.per_page = 2;
        let url = p.next_url().unwrap();
        assert!(url.contains("taxon_id=238252,318758,35342,47284"), "{url}");
        assert!(url.contains("order_by=updated_at&order=asc&updated_since=2026-09-01T00%3A00%3A00Z"), "{url}");
        let b = app.regions[0].bbox();
        assert!(url.contains(&format!("swlat={}&swlng={}&nelat={}&nelng={}", b.south, b.west, b.north, b.east)), "{url}");

        let page = |ts: &[&str]| {
            let results: Vec<_> = ts.iter().map(|t| serde_json::json!({ "updated_at": t })).collect();
            serde_json::to_vec(&serde_json::json!({ "results": results })).unwrap()
        };
        // Full page, newer timestamps: move `since` forward.
        p.advance(&page(&["2026-09-02T00:00:00-04:00", "2026-09-03T00:00:00-04:00"])).unwrap();
        assert_eq!(p.cursor.region(0).focus, QueryCursor { since: "2026-09-03T04:00:00Z".into(), page: 1 });
        // Full page stuck on `since`: page forward.
        p.advance(&page(&["2026-09-03T04:00:00Z", "2026-09-03T00:00:00-04:00"])).unwrap();
        assert_eq!(p.cursor.region(0).focus.page, 2);
        assert!(p.next_url().unwrap().ends_with("&page=2"));
        // Short page: done with focus, onto introduced.
        p.advance(&page(&["2026-09-04T00:00:00Z"])).unwrap();
        assert_eq!(p.cursor.region(0).focus, QueryCursor { since: "2026-09-04T00:00:00Z".into(), page: 1 });
        assert!(p.next_url().unwrap().contains("introduced=true"));
        p.advance(&page(&[])).unwrap();
        assert_eq!(p.next_url(), None);
        assert_eq!(p.cursor.region(0).introduced.since, "2026-09-01T00:00:00Z");

        // The cursor round-trips, in the flat pre-pivot form for a single-region app.
        let json = p.cursor().unwrap();
        assert!(json.starts_with("{\"focus\":"), "{json}");
        let resumed = InatPager::resume(&app, Some(&json), 0);
        assert_eq!(resumed.cursor, p.cursor);
    }

    /// Four regions × the focus query only (Lionfish Watch lists no introduced query), each
    /// region with its own bbox and cursor, persisted under the region ids.
    #[test]
    fn inat_pager_walks_every_region_of_a_multi_region_app() {
        let app = lionfish();
        assert_eq!(queries(&app), [Query::Focus]);
        let mut p = InatPager::resume(&app, None, bio::parse_time_ms("2026-09-01T00:00:00Z").unwrap());
        let mut urls = Vec::new();
        while let Some(url) = p.next_url() {
            urls.push(url);
            p.advance(br#"{"results":[{"updated_at":"2026-09-05T00:00:00Z"}]}"#).unwrap();
        }
        assert_eq!(urls.len(), 4);
        for (url, r) in urls.iter().zip(&app.regions) {
            let b = r.bbox();
            assert!(url.contains(&format!("swlat={}&swlng={}&nelat={}&nelng={}", b.south, b.west, b.north, b.east)), "{url}");
            assert!(url.contains("taxon_id=47284&"), "{url}");
            assert!(!url.contains("introduced"), "{url}");
        }
        let json = p.cursor().unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["regions"]["belize"]["focus"]["since"], "2026-09-05T00:00:00Z", "{json}");
        let resumed = InatPager::resume(&app, Some(&json), 0);
        assert_eq!(resumed.cursor, p.cursor);
        // A flat (single-region) cursor resumes region 0 and starts the others fresh.
        let legacy = r#"{"focus":{"since":"2026-08-01T00:00:00Z","page":1},"introduced":{"since":"2026-08-01T00:00:00Z","page":1}}"#;
        let resumed = InatPager::resume(&app, Some(legacy), 0);
        assert_eq!(resumed.cursor.region(0).focus.since, "2026-08-01T00:00:00Z");
        assert_eq!(resumed.cursor.region(1).focus.since, "1970-01-01T00:00:00Z");
    }

    // ---- Lionfish Watch (L4, gates/leaf-L4.md G1) ----

    const AREAS: [&str; 4] = ["fl-keys", "mx-caribbean", "belize", "co-caribbean"];

    /// Ingest the recorded lionfish iNat pages (and optionally the mirror originals) into a
    /// Lionfish Watch state, through the real pipeline.
    pub async fn lionfish_inat_state(with_mirrors: bool) -> AppState {
        let state = crate::app::test_support::test_state_for("lionfish");
        let src = Inat::new(state.app.clone());
        for area in AREAS {
            let out = ingest_payload(&state, &src, payload("fixture:lionfish", fixture(&format!("inat/lionfish-{area}.json"))), None).await.unwrap();
            assert!(out.error.is_none(), "{area}: {out:?}");
        }
        if with_mirrors {
            ingest_payload(&state, &src, payload("fixture:mirrors", fixture("inat/lionfish-mirrors.json")), None).await.unwrap();
        }
        state
    }

    fn ms(s: &str) -> i64 {
        bio::parse_time_ms(s).unwrap()
    }

    /// Lionfish taxon only, no `introduced=true`, one pager per area box, 10 min cadence and a
    /// 90-day first lookback; the python app keeps its 2 min cadence and both queries.
    #[test]
    fn lionfish_inat_query_is_taxon_only_per_area_every_10_min() {
        let app = lionfish();
        assert_eq!(queries(&app), [Query::Focus], "no introduced=true query (L1)");
        assert_eq!(focus_taxon_ids(&app), [47284], "genus Pterois");
        let mut p = InatPager::resume(&app, None, ms("2026-07-03T00:00:00Z"));
        let mut boxes = Vec::new();
        while let Some(url) = p.next_url() {
            assert!(url.contains("&taxon_id=47284&") && !url.contains("introduced"), "{url}");
            assert!(url.contains("updated_since=2026-07-03T00%3A00%3A00Z"), "{url}");
            boxes.push(url.split("swlat=").nth(1).unwrap().split("&taxon_id").next().unwrap().to_string());
            p.advance(br#"{"results":[]}"#).unwrap();
        }
        let want: Vec<String> =
            app.regions.iter().map(|r| format!("{}&swlng={}&nelat={}&nelng={}", r.bbox().south, r.bbox().west, r.bbox().north, r.bbox().east)).collect();
        assert_eq!(boxes, want, "one pager per area, south/west/north/east in that order");

        let src = Inat::new(app.clone());
        assert_eq!(src.info().cadence, Duration::from_secs(600));
        assert_eq!(src.min_interval(), Duration::from_secs(600));
        assert_eq!(backfill_days(&app), 90);
        assert!(mirror_catch_up(&app));
        let py = python();
        assert_eq!((cadence(&py), backfill_days(&py), mirror_catch_up(&py)), (Duration::from_secs(120), 30, false));
        assert_eq!(queries(&py), [Query::Focus, Query::Introduced]);
        // The live-count URL the backfill quotes next to its own count.
        let b = app.regions[0].bbox();
        assert_eq!(
            count_url(&b, &[47284], "2026-07-03"),
            "https://api.inaturalist.org/v1/observations?swlat=24.3&swlng=-83.2&nelat=27.5&nelng=-79.8&taxon_id=47284&d1=2026-07-03&per_page=0"
        );
    }

    /// Observed and submitted dates are both stored; a five-year-old photo uploaded last month
    /// counts in a submitted window but not in an observed one.
    #[tokio::test]
    async fn lionfish_inat_stores_observed_and_submitted_dates() {
        let state = lionfish_inat_state(false).await;
        let row: (i64, Option<i64>) = state
            .obs
            .read(|c| c.query_row("select observed_at, submitted_at from sightings where source_id = 'inat' and ext_id = '388490885'", [], |r| Ok((r.get(0)?, r.get(1)?))))
            .await
            .unwrap();
        // Belize, observed 2025-07-03, uploaded 2026-08-05.
        assert_eq!(chrono::DateTime::from_timestamp_millis(row.0).unwrap().format("%Y-%m-%d").to_string(), "2025-07-03");
        assert_eq!(chrono::DateTime::from_timestamp_millis(row.1.unwrap()).unwrap().format("%Y-%m-%d").to_string(), "2026-08-05");
        let missing: i64 = state.obs.read(|c| c.query_row("select count(*) from sightings where submitted_at is null", [], |r| r.get(0))).await.unwrap();
        assert_eq!(missing, 0, "every iNat record carries created_at");

        use crate::ingest::quality_bio::{area_summary, DateBasis};
        let app = state.app.clone();
        let (from, to) = (ms("2026-07-03T00:00:00Z"), ms("2026-10-01T06:58:36Z"));
        let (obs, sub) = state
            .obs
            .read(move |c| Ok((area_summary(c, &app, from, to, DateBasis::Observed)?, area_summary(c, &app, from, to, DateBasis::Submitted)?)))
            .await
            .unwrap();
        let inat = |rows: &[crate::ingest::quality_bio::AreaSource]| -> Vec<(String, i64)> {
            rows.iter().filter(|r| r.source == "inat").map(|r| (r.code.clone(), r.in_window)).collect()
        };
        let pairs = |v: [(&str, i64); 4]| v.iter().map(|(c, n)| (c.to_string(), *n)).collect::<Vec<_>>();
        // The live iNat API on 2026-10-01 (d1=2026-07-03): observed 22/24/1/4, created 32/36/2/6.
        assert_eq!(inat(&obs), pairs([("fl", 22), ("mx", 24), ("bz", 1), ("co", 4)]));
        assert_eq!(inat(&sub), pairs([("fl", 32), ("mx", 36), ("bz", 2), ("co", 6)]));
        assert_eq!(DateBasis::default(), DateBasis::Observed, "windows default to the observed date");
    }

    /// GBIF iNat-dataset copies whose original is not stored are asked for by id, once.
    #[tokio::test]
    async fn lionfish_inat_mirror_catch_up_asks_by_id_once() {
        let state = lionfish_inat_state(false).await;
        let gbif = super::super::gbif::Gbif::new(state.app.clone());
        for area in AREAS {
            ingest_payload(&state, &gbif, payload("fixture:gbif", fixture(&format!("gbif/lionfish-{area}.json"))), None).await.unwrap();
        }
        let src = Inat::new(state.app.clone());
        let batch = src.mirror_batch(&state).await.unwrap();
        assert_eq!(batch.len(), 87, "GBIF copies of iNat records older than the 90-day pages");
        assert!(src.mirror_batch(&state).await.unwrap().is_empty(), "asked once per process");
        let url = ids_url(&batch);
        assert!(url.starts_with("https://api.inaturalist.org/v1/observations?id=") && url.ends_with("&order_by=id&order=asc&per_page=200"));
        // The recorded answer to exactly that request links every copy.
        let manifest: serde_json::Value = serde_json::from_slice(&fixture("inat/manifest.lionfish.json")).unwrap();
        let mut sorted = batch.clone();
        sorted.sort_by_key(|id| id.parse::<i64>().unwrap());
        assert_eq!(manifest["files"][4]["url"], ids_url(&sorted));
        ingest_payload(&state, &src, payload(&url, fixture("inat/lionfish-mirrors.json")), None).await.unwrap();
        let left = state.obs.read(crate::ingest::quality_bio::unlinked_inat_mirrors).await.unwrap();
        assert!(left.is_empty(), "{left:?}");
    }
}
