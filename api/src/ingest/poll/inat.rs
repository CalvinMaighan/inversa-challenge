//! iNaturalist API v1 poller (T9, PRD §2): every 2 min, at most one request per second.
//!
//! Two queries over the bbox, both `order_by=updated_at&order=asc&updated_since=<cursor>`:
//! - **focus**: the four focus taxa. `taxon_name` matches a single name only (a comma list
//!   returns 0 results), so the query uses `taxon_id` with the four iNat ids: Python bivittatus
//!   238252, Salvator merianae 318758, Iguana iguana 35342, genus Pterois 47284;
//! - **introduced**: `introduced=true`, the background layer.
//!
//! The persisted cursor is JSON holding both queries' positions. `updated_since` is inclusive, so
//! the next request starts at the newest `updated_at` seen; when a full page all shares one
//! `updated_at`, the walk pages forward within it instead, so nothing is skipped.
//!
//! Identification changes: each identification carries the observation taxon at the time it
//! was added (`previous_observation_taxon`). Walking them in time order, then ending at the
//! current taxon, gives the observation's taxon history. A change that is not a refinement
//! (the old taxon is not an ancestor of the new one) is an ID flip and becomes a
//! `Row::Revision` on field `taxon`; `quality_bio::post_write` marks such sightings `conflict`.
//! Taxa are compared after the focus mapping, so a swap between a species and its own
//! subspecies, or between Pterois species, is not a flip.

use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::bio::{self, Focus, Pacer, Pager};
use crate::ingest::source::{FetchCtx, Mode, RawPayload, Source, SourceInfo};
use crate::model::{Quality, RevisionRow, Row, SightingRow, TaxonRef};

pub const ID: &str = "inat";
pub const API: &str = "https://api.inaturalist.org/v1/observations";
/// iNat asks API clients to stay at or under one request per second.
pub const REQUEST_INTERVAL: Duration = Duration::from_secs(1);
pub const CADENCE: Duration = Duration::from_secs(120);
pub const PER_PAGE: usize = 200;
/// Requests per live fetch across both queries; the rest continues on the next cycle. A full
/// v1 page is ~16 MB (about 80 KB per observation, mostly identification and user objects), and
/// a fetch holds its pages until the scheduler ingests them, so this caps that at ~80 MB while
/// still draining 1,000 observations per 2-minute cycle.
pub const MAX_REQUESTS_PER_FETCH: usize = 5;
/// First live fetch with no cursor looks back this far.
pub const INITIAL_LOOKBACK: Duration = Duration::from_secs(30 * 24 * 3600);

/// iNat taxon ids of the focus taxa (`taxon_id` query and the ancestry mapping).
const PYTHON: i64 = 238252;
const TEGU: i64 = 318758;
const IGUANA: i64 = 35342;
const PTEROIS: i64 = 47284;
const PTEROIS_VOLITANS: i64 = 47280;
const PTEROIS_MILES: i64 = 123459;

pub struct Inat {
    pacer: Pacer,
}

impl Inat {
    pub fn new() -> Self {
        Inat { pacer: Pacer::new(REQUEST_INTERVAL) }
    }

    pub fn pacer(&self) -> &Pacer {
        &self.pacer
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
            cadence: CADENCE,
            max_latency: Duration::from_secs(6 * 3600),
        }
    }

    fn min_interval(&self) -> Duration {
        CADENCE
    }

    async fn fetch(&self, ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut pager = InatPager::resume(ctx.cursor.as_deref(), now - INITIAL_LOOKBACK.as_millis() as i64);
        bio::collect_pages(ctx.state, &self.pacer, &mut pager, Some(MAX_REQUESTS_PER_FETCH)).await
    }

    fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
        normalize(&raw.bytes)
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cursor {
    pub focus: QueryCursor,
    pub introduced: QueryCursor,
}

pub struct InatPager {
    pub cursor: Cursor,
    /// Queries still to walk in this run, in order.
    pending: Vec<Query>,
    per_page: usize,
}

impl InatPager {
    /// Continue from a persisted cursor; a missing or unreadable one starts at `default_since_ms`.
    pub fn resume(cursor: Option<&str>, default_since_ms: i64) -> Self {
        let cursor = cursor.and_then(|c| serde_json::from_str::<Cursor>(c).ok()).unwrap_or_else(|| {
            let since = bio::rfc3339_utc(default_since_ms);
            Cursor {
                focus: QueryCursor { since: since.clone(), page: 1 },
                introduced: QueryCursor { since, page: 1 },
            }
        });
        InatPager { cursor, pending: vec![Query::Focus, Query::Introduced], per_page: PER_PAGE }
    }

    fn current(&self) -> Option<(Query, &QueryCursor)> {
        let q = *self.pending.first()?;
        Some((q, self.slot(q)))
    }

    fn slot(&self, q: Query) -> &QueryCursor {
        match q {
            Query::Focus => &self.cursor.focus,
            Query::Introduced => &self.cursor.introduced,
        }
    }

    fn slot_mut(&mut self, q: Query) -> &mut QueryCursor {
        match q {
            Query::Focus => &mut self.cursor.focus,
            Query::Introduced => &mut self.cursor.introduced,
        }
    }
}

pub fn query_url(q: Query, c: &QueryCursor, per_page: usize) -> String {
    let filter = match q {
        Query::Focus => format!("taxon_id={PYTHON},{TEGU},{IGUANA},{PTEROIS}"),
        Query::Introduced => "introduced=true".to_string(),
    };
    format!(
        "{API}?swlat={}&swlng={}&nelat={}&nelng={}&{filter}&order_by=updated_at&order=asc&updated_since={}&per_page={per_page}&page={}",
        bio::SOUTH,
        bio::WEST,
        bio::NORTH,
        bio::EAST,
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
        self.current().map(|(q, c)| query_url(q, c, self.per_page))
    }

    fn advance(&mut self, body: &[u8]) -> anyhow::Result<()> {
        let Some((q, c)) = self.current() else { return Ok(()) };
        let since_ms = bio::parse_time_ms(&c.since).unwrap_or(i64::MIN);
        let page: UpdatedPage = serde_json::from_slice(body)?;
        let newest = page.results.iter().filter_map(|o| o.updated_at.as_deref().and_then(bio::parse_time_ms)).max();
        let full = page.results.len() >= self.per_page;
        let slot = self.slot_mut(q);
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
        serde_json::to_string(&self.cursor).ok()
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
    fn lineage(&self) -> impl Iterator<Item = i64> + '_ {
        std::iter::once(self.id).chain(self.ancestor_ids.iter().flatten().copied())
    }

    fn focus(&self) -> Option<Focus> {
        self.lineage().find_map(|id| match id {
            PYTHON => Some(Focus::Python),
            TEGU => Some(Focus::Tegu),
            IGUANA => Some(Focus::Iguana),
            PTEROIS | PTEROIS_VOLITANS | PTEROIS_MILES => Some(Focus::Lionfish),
            _ => None,
        })
    }

    /// The taxon as stored: focus taxa (and anything below them) collapse to the seeded name.
    fn to_ref(&self) -> TaxonRef {
        match self.focus() {
            Some(f) => f.taxon(),
            None => TaxonRef {
                scientific_name: self.name.clone(),
                common_name: self.preferred_common_name.clone().unwrap_or_default(),
            },
        }
    }

    fn is_ancestor_of(&self, other: &Taxon) -> bool {
        other.lineage().any(|id| id == self.id)
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
fn taxon_revisions(o: &Obs, current: &Taxon) -> Vec<RevisionRow> {
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
        let (old, new) = (before.to_ref(), after.to_ref());
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
pub fn normalize(bytes: &[u8]) -> anyhow::Result<Vec<Row>> {
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
            taxon: taxon.to_ref(),
            lat,
            lon,
            accuracy_m,
            observed_at,
            quality: quality(o.quality_grade.as_deref()),
            photo_url,
        }));
        rows.extend(taxon_revisions(o, taxon).into_iter().map(Row::Revision));
    }
    Ok(rows)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::app::test_support::test_state;
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
        let src = Inat::new();
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
        let rows = normalize(&fixture("inat/focus-p1.json")).unwrap();
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
    }

    #[test]
    fn inat_normalize_introduced_fixture_is_background() {
        let rows = normalize(&fixture("inat/introduced-p1.json")).unwrap();
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
        assert_eq!(normalize(&bytes).unwrap(), normalize(&bytes).unwrap());
    }

    #[test]
    fn inat_revision_from_real_maverick_dispute() {
        // Real observation 402428460: a maverick ID moved it from Salvator merianae up to
        // Tupinambinae before the community settled back on Salvator merianae.
        let rows = normalize(&fixture("inat/idflip-p1.json")).unwrap();
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
        let src = Inat::new();
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
        let src = Inat::new();
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
        let mut p = InatPager::resume(None, bio::parse_time_ms("2026-09-01T00:00:00Z").unwrap());
        p.per_page = 2;
        let url = p.next_url().unwrap();
        assert!(url.contains("taxon_id=238252,318758,35342,47284"), "{url}");
        assert!(url.contains("order_by=updated_at&order=asc&updated_since=2026-09-01T00%3A00%3A00Z"), "{url}");
        assert!(url.contains("swlat=24.3&swlng=-83.2&nelat=27.5&nelng=-79.8"), "{url}");

        let page = |ts: &[&str]| {
            let results: Vec<_> = ts.iter().map(|t| serde_json::json!({ "updated_at": t })).collect();
            serde_json::to_vec(&serde_json::json!({ "results": results })).unwrap()
        };
        // Full page, newer timestamps: move `since` forward.
        p.advance(&page(&["2026-09-02T00:00:00-04:00", "2026-09-03T00:00:00-04:00"])).unwrap();
        assert_eq!(p.cursor.focus, QueryCursor { since: "2026-09-03T04:00:00Z".into(), page: 1 });
        // Full page stuck on `since`: page forward.
        p.advance(&page(&["2026-09-03T04:00:00Z", "2026-09-03T00:00:00-04:00"])).unwrap();
        assert_eq!(p.cursor.focus.page, 2);
        assert!(p.next_url().unwrap().ends_with("&page=2"));
        // Short page: done with focus, onto introduced.
        p.advance(&page(&["2026-09-04T00:00:00Z"])).unwrap();
        assert_eq!(p.cursor.focus, QueryCursor { since: "2026-09-04T00:00:00Z".into(), page: 1 });
        assert!(p.next_url().unwrap().contains("introduced=true"));
        p.advance(&page(&[])).unwrap();
        assert_eq!(p.next_url(), None);
        assert_eq!(p.cursor.introduced.since, "2026-09-01T00:00:00Z");

        // The cursor round-trips.
        let resumed = InatPager::resume(p.cursor().as_deref(), 0);
        assert_eq!(resumed.cursor, p.cursor);
    }
}
