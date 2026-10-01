//! `evidence(id)` (PLAN.md C14): everything behind one cited record.
//!
//! Ids are `<kind>:<key>`:
//!
//! | kind | key | record |
//! |---|---|---|
//! | `sighting` | `sightings.id` | the row, its taxon and its revisions |
//! | `reading` | `<station>:<param>:<observed_at ms>:<origin>`; `<station>` is `stations.id` or a station's ext id (USGS site number, NWPS lid); also `<source>:<ext id>:<param>:<ms>:<origin>` | the row and its station; for an NWPS lid with no station row, the NWPS observation of the forecast store (stage on the flood-category datum, flow) |
//! | `alert` | `alerts.id` or the NWS alert id (`urn:oid:…`, `vtec:…`) | the row, `areaGeojson` parsed, and its per-site versions (`firstSeen`, `lastSeen`, `endedAt`) |
//! | `fetch` | `fetch_runs.id` | the run |
//! | `forecast` | `<lid>:<issued ms>` (river issuance), or `nws:<office>/<x>,<y>:<updateTime ms>` (gridpoint) | the snapshot with its points, the thresholds known then, provenance and revisions |
//! | `review` | `<lid or location id>:<asOf ms>` | the site review at that time with every check (conditions apps) |
//! | `source` | `<feed id>` | the feed's facts: licence, credit/DOI, cadence, latency, rate limit, mode, homepage, last fetch |
//! | `mission`, `note` | the entity id on the app's team board | its fields (deleted ones included, flagged) |
//! | `message` | the message id | body, author node, recipient, thread, HLC |
//! | `hotspot` | `<species>:<cell id>:<frame ms>` (cell id `<col>:<row>`, or `<region>:<col>:<row>` in a multi-region app) | the explain terms |
//! | `backtest` | `<species>:<days>` | the backtest summary with `perDay` |
//!
//! Every id the engines cite resolves here: review reasons (`reading:<lid>:stage_m:…`,
//! `reading:<usgs site>:discharge_cfs:…`, `forecast:<lid>:<ms>`, `alert:<nws id>`, `fetch:<id>`),
//! hotspot components (`sighting:<id>`, `reading:<station id>:dhw:…`) and the forecast store.
//! A well-formed id with no record is `NOT_FOUND`; an unknown kind or malformed key is `BAD_ID`.
//!
//! Row-backed kinds also carry the raw payload from the Archive (gunzipped; parsed as JSON when
//! it is JSON, otherwise `{text}` cut at [`RAW_TEXT_CAP`]; GOES NetCDF as metadata only), the
//! archive key, source URL, fetch time, ingest lag, the source's feed state, and links:
//!
//! - `duplicate_of` / `duplicates`: the `canonical_id` dedupe links (T9), both directions;
//! - `conflict`: a duplicate that names a different taxon; for readings, the partners that break
//!   the T8 rules (satellite vs buoy SST > 1.5 °C within 5 km and 1 h; LST − air outside
//!   [-5, +15] °C in one 0.01° cell within 1 h);
//! - `fetch`: the fetch run that delivered the raw payload; `produced`: rows from a fetch.
//!
//! Sighting revisions (iNat ID flips) have no id of their own, so they are listed in
//! `record.revisions`.

use std::fmt;
use std::io::Read;

use async_graphql::{ErrorExtensions, ID};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::app::config::{App, Taxon};
use crate::graphql::types::{Evidence, EvidenceLink, FeedState};
use crate::hotspot;
use crate::source_pages::source_page_url;
use crate::state::AppState;

/// Longest text payload returned inline.
pub const RAW_TEXT_CAP: usize = 256 * 1024;
/// Largest payload inflated; bigger ones are returned as truncated text.
pub const RAW_INFLATE_CAP: usize = 32 * 1024 * 1024;
/// Most links of one relation.
pub const MAX_LINKS: i64 = 50;

/// T8 conflict rules (`ingest::quality_phys`), repeated here to find the partner readings.
pub const PAIR_WINDOW_MS: i64 = 3_600_000;
pub const SST_MAX_KM: f64 = 5.0;
pub const SST_MAX_DIFF_C: f64 = 1.5;
pub const SKIN_OFFSET_C: (f64, f64) = (-5.0, 15.0);

#[derive(Debug)]
pub enum EvidenceError {
    BadId(String),
    NotFound(String),
    Internal(anyhow::Error),
}

impl fmt::Display for EvidenceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EvidenceError::BadId(m) | EvidenceError::NotFound(m) => f.write_str(m),
            EvidenceError::Internal(e) => write!(f, "evidence lookup failed: {e:#}"),
        }
    }
}

impl From<anyhow::Error> for EvidenceError {
    fn from(e: anyhow::Error) -> Self {
        EvidenceError::Internal(e)
    }
}

impl ErrorExtensions for EvidenceError {
    fn extend(&self) -> async_graphql::Error {
        let code = match self {
            EvidenceError::BadId(_) => "BAD_ID",
            EvidenceError::NotFound(_) => "NOT_FOUND",
            EvidenceError::Internal(_) => "INTERNAL",
        };
        async_graphql::Error::new(self.to_string()).extend_with(|_, e| e.set("code", code))
    }
}

type Res<T> = Result<T, EvidenceError>;

fn not_found(id: &str) -> EvidenceError {
    EvidenceError::NotFound(format!("not found: no evidence with id {id:?}"))
}

fn bad_id(id: &str, expected: &str) -> EvidenceError {
    EvidenceError::BadId(format!("bad evidence id {id:?}: expected {expected}"))
}

/// Unix ms as an RFC 3339 string (the GraphQL `Time` format).
fn iso(ms: i64) -> Value {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| Value::String(t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)))
        .unwrap_or(Value::Null)
}

fn iso_opt(ms: Option<i64>) -> Value {
    ms.map(iso).unwrap_or(Value::Null)
}

fn link(id: String, relation: &str, source: &str) -> EvidenceLink {
    EvidenceLink { id: ID(id), relation: relation.into(), source: source.into() }
}

/// One `raw_objects` row.
#[derive(Debug, Clone)]
struct RawRef {
    key: String,
    source_url: String,
    fetched_at: i64,
    bytes: i64,
    sha256: String,
}

fn raw_ref(c: &Connection, raw_id: Option<i64>) -> rusqlite::Result<Option<RawRef>> {
    let Some(raw_id) = raw_id else { return Ok(None) };
    c.prepare_cached("select r2_key, source_url, fetched_at, bytes, sha256 from raw_objects where id = ?1")?
        .query_row([raw_id], |r| {
            Ok(RawRef { key: r.get(0)?, source_url: r.get(1)?, fetched_at: r.get(2)?, bytes: r.get(3)?, sha256: r.get(4)? })
        })
        .optional()
}

/// The fetch run that delivered raw object `raw_id`.
fn fetch_link(c: &Connection, source: &str, raw_id: Option<i64>) -> rusqlite::Result<Option<EvidenceLink>> {
    let Some(raw_id) = raw_id else { return Ok(None) };
    let run: Option<i64> = c
        .prepare_cached("select id from fetch_runs where source_id = ?1 and raw_object_id = ?2 order by id limit 1")?
        .query_row(params![source, raw_id], |r| r.get(0))
        .optional()?;
    Ok(run.map(|id| link(format!("fetch:{id}"), "fetch", source)))
}

/// What a row-backed kind hands to [`assemble`].
struct Found {
    record: Value,
    source: Option<String>,
    raw: Option<RawRef>,
    /// Observation to ingestion, ms.
    ingest_lag_ms: Option<i64>,
    links: Vec<EvidenceLink>,
    /// Publisher web page (`source_pages`), for rows a publisher has a page for.
    page_url: Option<String>,
    /// API URL of the record when no archived payload names one (`Evidence.sourceUrl`).
    api_url: Option<String>,
}

pub async fn evidence(state: &AppState, id: &str) -> Res<Evidence> {
    let (kind, key) = id.split_once(':').ok_or_else(|| bad_id(id, "<kind>:<key>"))?;
    let found = match kind {
        "sighting" => sighting(state, id, key).await?,
        "reading" => reading(state, id, key).await?,
        "alert" => alert(state, id, key).await?,
        "fetch" => fetch(state, id, key).await?,
        "hotspot" => hotspot_found(state, id, key).await?,
        "backtest" => backtest_found(state, id, key).await?,
        "forecast" => forecast_found(state, id, key).await?,
        "review" => review_found(state, id, key).await?,
        "source" => source_found(state, id, key).await?,
        "mission" | "note" => team_entity(state, id, kind, key).await?,
        "message" => team_message(state, id, key).await?,
        _ => {
            return Err(bad_id(
                id,
                "kind sighting, reading, alert, fetch, forecast, review, source, mission, note, message, hotspot or backtest",
            ));
        }
    };
    assemble(state, id, kind, found).await
}

async fn assemble(state: &AppState, id: &str, kind: &str, found: Found) -> Res<Evidence> {
    let Found { record, source, raw, ingest_lag_ms, links, page_url, api_url } = found;
    let feed = match &source {
        Some(source) => crate::feed_state::compute(&state.obs, state.now_ms())
            .await?
            .into_iter()
            .find(|s| &s.source == source)
            .map(FeedState::from),
        None => None,
    };
    let raw_payload = match &raw {
        Some(r) => Some(raw_payload(state, r).await),
        None => None,
    };
    Ok(Evidence {
        id: ID(id.to_string()),
        kind: kind.to_string(),
        record,
        raw: raw_payload,
        raw_key: raw.as_ref().map(|r| r.key.clone()),
        source_url: raw.as_ref().map(|r| r.source_url.clone()).or(api_url),
        source_page_url: page_url,
        fetched_at: raw.as_ref().map(|r| crate::graphql::types::Time(r.fetched_at)),
        ingest_lag_seconds: ingest_lag_ms.map(|ms| ms.max(0) / 1000),
        feed,
        links,
    })
}

// ---------------------------------------------------------------------------------------------
// Raw payloads
// ---------------------------------------------------------------------------------------------

fn is_netcdf_key(key: &str) -> bool {
    key.ends_with(".nc.gz") || key.ends_with(".nc")
}

/// NetCDF files are multi-MB binary grids: describe them instead of inlining them. GOES file
/// names carry product, satellite and scan start (`OR_ABI-L2-LSTC-M6_G19_s2026…_e…_c….nc`).
fn netcdf_meta(raw: &RawRef) -> Value {
    let file_name = raw.source_url.rsplit('/').next().unwrap_or_default().to_string();
    let parts: Vec<&str> = file_name.trim_end_matches(".nc").split('_').collect();
    let (product, satellite, scan_start) = match parts.as_slice() {
        ["OR", product, satellite, start, ..] => {
            (Some(*product), Some(*satellite), start.strip_prefix('s').filter(|s| !s.is_empty()))
        }
        _ => (None, None, None),
    };
    json!({
        "format": "netcdf4",
        "fileName": file_name,
        "product": product,
        "satellite": satellite,
        "scanStart": scan_start,
        "bytes": raw.bytes,
        "sha256": raw.sha256,
        "note": "binary NetCDF is not inlined; read rawKey from the archive for the file",
    })
}

async fn raw_payload(state: &AppState, raw: &RawRef) -> Value {
    if is_netcdf_key(&raw.key) {
        return netcdf_meta(raw);
    }
    let bytes = match state.archive.get(&raw.key).await {
        Ok(bytes) => bytes,
        Err(e) => return json!({"error": format!("{e:#}")}),
    };
    let raw = raw.clone();
    tokio::task::spawn_blocking(move || decode_raw(&bytes, &raw))
        .await
        .unwrap_or_else(|e| json!({"error": format!("decode task failed: {e}")}))
}

const HDF5_MAGIC: &[u8] = b"\x89HDF\r\n\x1a\n";

fn decode_raw(bytes: &[u8], raw: &RawRef) -> Value {
    let (body, complete) = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut out = Vec::new();
        let decoder = flate2::read::MultiGzDecoder::new(bytes);
        if let Err(e) = decoder.take(RAW_INFLATE_CAP as u64 + 1).read_to_end(&mut out) {
            return json!({"error": format!("gunzip: {e}")});
        }
        let complete = out.len() <= RAW_INFLATE_CAP;
        (out, complete)
    } else {
        (bytes.to_vec(), true)
    };
    if body.starts_with(HDF5_MAGIC) || body.starts_with(b"CDF\x01") || body.starts_with(b"CDF\x02") {
        return netcdf_meta(raw);
    }
    if complete {
        if let Ok(v) = serde_json::from_slice::<Value>(&body) {
            return v;
        }
    }
    let cut = body.len().min(RAW_TEXT_CAP);
    json!({
        "text": String::from_utf8_lossy(&body[..cut]),
        "truncated": cut < body.len() || !complete,
        "bytes": body.len(),
    })
}

// ---------------------------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------------------------

async fn sighting(state: &AppState, id: &str, key: &str) -> Res<Found> {
    let sid: i64 = key.parse().map_err(|_| bad_id(id, "sighting:<integer id>"))?;
    let found = state
        .obs
        .read(move |c| {
            let row = c
                .prepare_cached(
                    "select s.id, s.source_id, s.ext_id, s.taxon_id, t.scientific_name, t.common_name, s.lat, s.lon,
                            s.accuracy_m, s.observed_at, s.quality, s.photo_url, s.raw_object_id, s.canonical_id,
                            s.conflict, s.ingested_at, t.inat_taxon_id, t.focus, s.submitted_at
                     from sightings s join taxa t on t.id = s.taxon_id where s.id = ?1",
                )?
                .query_row([sid], |r| {
                    let taxon_id: i64 = r.get(3)?;
                    let inat_id: Option<i64> = r.get(16)?;
                    Ok((
                        json!({
                            "id": r.get::<_, i64>(0)?.to_string(),
                            "source": r.get::<_, String>(1)?,
                            "extId": r.get::<_, String>(2)?,
                            // The taxon rides in the record so the card needs no second request.
                            "taxon": {"id": taxon_id.to_string(), "scientificName": r.get::<_, String>(4)?,
                                      "commonName": r.get::<_, String>(5)?, "focus": r.get::<_, bool>(17)?,
                                      "inatTaxonId": inat_id.map(|n| n.to_string()),
                                      "pageUrl": inat_id.map(crate::graphql::types::inat_page_url)},
                            "lat": r.get::<_, f64>(6)?,
                            "lon": r.get::<_, f64>(7)?,
                            "accuracyM": r.get::<_, Option<f64>>(8)?,
                            "observedAt": iso(r.get(9)?),
                            // When the record reached its source (iNat upload); can lag years (L4).
                            "submittedAt": iso_opt(r.get(18)?),
                            "quality": r.get::<_, String>(10)?,
                            "photoUrl": r.get::<_, Option<String>>(11)?,
                            // Same-origin copy for pages under COEP (`media.rs`).
                            "mediaUrl": r.get::<_, Option<String>>(11)?.map(|_| format!("/v1/media/{sid}")),
                            "canonicalId": r.get::<_, Option<i64>>(13)?.map(|v| v.to_string()),
                            "conflict": r.get::<_, bool>(14)?,
                            "ingestedAt": iso(r.get(15)?),
                        }),
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, i64>(9)?,
                        r.get::<_, Option<i64>>(12)?,
                        r.get::<_, Option<i64>>(13)?,
                        r.get::<_, i64>(15)?,
                    ))
                })
                .optional()?;
            let Some((mut record, source, taxon, observed_at, raw_id, canonical, ingested_at)) = row else {
                return Ok(None);
            };

            let revisions: Vec<Value> = c
                .prepare_cached(
                    "select changed_at, field, old, new from sighting_revisions where sighting_id = ?1
                     order by changed_at, rowid",
                )?
                .query_map([sid], |r| {
                    Ok(json!({"changedAt": iso(r.get(0)?), "field": r.get::<_, String>(1)?,
                              "old": r.get::<_, Option<String>>(2)?, "new": r.get::<_, Option<String>>(3)?}))
                })?
                .collect::<rusqlite::Result<_>>()?;
            record["revisions"] = Value::Array(revisions);

            let mut links = Vec::new();
            let related = |links: &mut Vec<EvidenceLink>, rel: &str, other: i64, other_source: String, other_taxon: i64| {
                links.push(link(format!("sighting:{other}"), rel, &other_source));
                if other_taxon != taxon {
                    links.push(link(format!("sighting:{other}"), "conflict", &other_source));
                }
            };
            if let Some(canonical) = canonical {
                let other: Option<(String, i64)> = c
                    .prepare_cached("select source_id, taxon_id from sightings where id = ?1")?
                    .query_row([canonical], |r| Ok((r.get(0)?, r.get(1)?)))
                    .optional()?;
                if let Some((other_source, other_taxon)) = other {
                    related(&mut links, "duplicate_of", canonical, other_source, other_taxon);
                }
            }
            let dups: Vec<(i64, String, i64)> = c
                .prepare_cached(
                    "select id, source_id, taxon_id from sightings where canonical_id = ?1 order by id limit ?2",
                )?
                .query_map(params![sid, MAX_LINKS], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<rusqlite::Result<_>>()?;
            for (other, other_source, other_taxon) in dups {
                related(&mut links, "duplicates", other, other_source, other_taxon);
            }
            links.extend(fetch_link(c, &source, raw_id)?);
            Ok(Some(Found {
                page_url: record["extId"].as_str().and_then(|ext| source_page_url(&source, ext)),
                record,
                raw: raw_ref(c, raw_id)?,
                source: Some(source),
                ingest_lag_ms: Some(ingested_at - observed_at),
                links,
                api_url: None,
            }))
        })
        .await?;
    found.ok_or_else(|| not_found(id))
}

/// The four reading kinds the T8 conflict rules pair up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PhysKind {
    SatSst,
    BuoySst,
    SatLst,
    StationAir,
}

impl PhysKind {
    fn of(param: &str, origin: &str) -> Option<PhysKind> {
        match (param, origin) {
            ("sst_c", "satellite") => Some(PhysKind::SatSst),
            ("sst_c", "measured") => Some(PhysKind::BuoySst),
            ("lst_c", "satellite") => Some(PhysKind::SatLst),
            ("air_c", "measured") => Some(PhysKind::StationAir),
            _ => None,
        }
    }

    fn partner(self) -> (&'static str, &'static str) {
        match self {
            PhysKind::SatSst => ("sst_c", "measured"),
            PhysKind::BuoySst => ("sst_c", "satellite"),
            PhysKind::SatLst => ("air_c", "measured"),
            PhysKind::StationAir => ("lst_c", "satellite"),
        }
    }

    /// Whether this reading (`mine`) and a partner reading (`theirs`) disagree.
    fn disagrees(self, mine: f64, theirs: f64) -> bool {
        match self {
            PhysKind::SatSst | PhysKind::BuoySst => (mine - theirs).abs() > SST_MAX_DIFF_C,
            PhysKind::SatLst => !(SKIN_OFFSET_C.0..=SKIN_OFFSET_C.1).contains(&(mine - theirs)),
            PhysKind::StationAir => !(SKIN_OFFSET_C.0..=SKIN_OFFSET_C.1).contains(&(theirs - mine)),
        }
    }
}

/// `(region, col, row)` of the scoring cell (C14) containing a point; `None` outside every region.
fn cell_of(app: &App, lat: f64, lon: f64) -> Option<(u8, u32, u32)> {
    crate::ingest::quality_phys::cell_of(app, lat, lon)
}

fn distance_km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let a = ((p2 - p1) / 2.0).sin().powi(2) + p1.cos() * p2.cos() * ((lon2 - lon1).to_radians() / 2.0).sin().powi(2);
    6371.0088 * 2.0 * a.sqrt().asin()
}

struct ReadingAt {
    lat: f64,
    lon: f64,
    at: i64,
    value: f64,
}

/// Readings that break a T8 rule together with `me`.
fn reading_conflicts(c: &Connection, app: &App, kind: PhysKind, me: &ReadingAt) -> rusqlite::Result<Vec<EvidenceLink>> {
    let (param, origin) = kind.partner();
    let sst = matches!(kind, PhysKind::SatSst | PhysKind::BuoySst);
    // Coarse box first (index on stations(lat, lon)), exact test after.
    let (dlat, dlon) = if sst { (0.05, 0.06) } else { (0.011, 0.011) };
    let mut st = c.prepare_cached(
        "select r.station_id, r.observed_at, r.value, s.lat, s.lon, s.source_id
         from stations s join readings r on r.station_id = s.id
         where s.lat between ?1 and ?2 and s.lon between ?3 and ?4
           and r.param = ?5 and r.origin = ?6 and r.flag = 'ok' and r.value is not null
           and r.observed_at between ?7 and ?8
         order by r.observed_at, r.station_id",
    )?;
    let rows = st.query_map(
        params![
            me.lat - dlat,
            me.lat + dlat,
            me.lon - dlon,
            me.lon + dlon,
            param,
            origin,
            me.at - PAIR_WINDOW_MS,
            me.at + PAIR_WINDOW_MS
        ],
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, f64>(2)?,
                r.get::<_, f64>(3)?,
                r.get::<_, f64>(4)?,
                r.get::<_, String>(5)?,
            ))
        },
    )?;
    let mut out = Vec::new();
    for row in rows {
        let (station, at, value, lat, lon, source) = row?;
        let near = if sst {
            distance_km(me.lat, me.lon, lat, lon) <= SST_MAX_KM
        } else {
            matches!((cell_of(app, me.lat, me.lon), cell_of(app, lat, lon)), (Some(a), Some(b)) if a == b)
        };
        if near && kind.disagrees(me.value, value) {
            out.push(link(format!("reading:{station}:{param}:{at}:{origin}"), "conflict", &source));
            if out.len() as i64 == MAX_LINKS {
                break;
            }
        }
    }
    Ok(out)
}

async fn reading(state: &AppState, id: &str, key: &str) -> Res<Found> {
    const SHAPE: &str = "reading:<station id or ext id>:<param>:<observed_at ms>:<origin> or reading:<source>:<ext id>:<param>:<observed_at ms>:<origin>";
    let parts: Vec<&str> = key.split(':').collect();
    if parts.len() < 4 || parts.iter().any(|p| p.is_empty()) {
        return Err(bad_id(id, SHAPE));
    }
    let n = parts.len();
    let at: i64 = parts[n - 2].parse().map_err(|_| bad_id(id, SHAPE))?;
    let (param, origin) = (parts[n - 3].to_string(), parts[n - 1].to_string());
    let head: Vec<String> = parts[..n - 3].iter().map(|s| s.to_string()).collect();
    let app = state.app.clone();
    let found = state
        .obs
        .read(move |c| match resolve_station(c, &head, &param, at, &origin)? {
            Some(station) => reading_row(c, &app, station, &param, at, &origin),
            None => nwps_observation(c, &head.join(":"), &param, at, &origin),
        })
        .await?;
    found.ok_or_else(|| not_found(id))
}

/// The `stations.id` a reading key names: a numeric `stations.id`, `<source>:<ext id>`, or an ext
/// id alone (exact, or a USGS `<site>:<method>` station of that site), whichever has the reading.
fn resolve_station(c: &Connection, head: &[String], param: &str, at: i64, origin: &str) -> rusqlite::Result<Option<i64>> {
    if let [one] = head {
        if let Ok(sid) = one.parse::<i64>() {
            let hit = c
                .prepare_cached("select 1 from readings where station_id = ?1 and param = ?2 and observed_at = ?3 and origin = ?4")?
                .query_row(params![sid, param, at, origin], |_| Ok(()))
                .optional()?;
            if hit.is_some() {
                return Ok(Some(sid));
            }
        }
    }
    let by_ext = |source: Option<&str>, ext: &str| -> rusqlite::Result<Option<i64>> {
        c.prepare_cached(
            "select s.id from stations s join readings r on r.station_id = s.id
             where (s.ext_id = ?1 or substr(s.ext_id, 1, length(?1) + 1) = ?1 || ':') and (?2 is null or s.source_id = ?2)
               and r.param = ?3 and r.observed_at = ?4 and r.origin = ?5
             order by s.ext_id = ?1 desc, s.id limit 1",
        )?
        .query_row(params![ext, source, param, at, origin], |r| r.get(0))
        .optional()
    };
    if head.len() >= 2 {
        if let Some(sid) = by_ext(Some(&head[0]), &head[1..].join(":"))? {
            return Ok(Some(sid));
        }
    }
    by_ext(None, &head.join(":"))
}

fn reading_row(c: &Connection, app: &App, station: i64, param: &str, at: i64, origin: &str) -> rusqlite::Result<Option<Found>> {
    let row = c
        .prepare_cached(
            "select r.value, r.flag, r.raw_object_id, r.conflict, s.source_id, s.ext_id, s.name, s.lat, s.lon, s.kind
             from readings r join stations s on s.id = r.station_id
             where r.station_id = ?1 and r.param = ?2 and r.observed_at = ?3 and r.origin = ?4",
        )?
        .query_row(params![station, param, at, origin], |r| {
            Ok((
                r.get::<_, Option<f64>>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, bool>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, f64>(7)?,
                r.get::<_, f64>(8)?,
                r.get::<_, String>(9)?,
            ))
        })
        .optional()?;
    let Some((value, flag, raw_id, conflict, source, ext_id, name, lat, lon, kind)) = row else {
        return Ok(None);
    };
    let mut record = json!({
        "station": {"id": station.to_string(), "source": source, "extId": ext_id, "name": name,
                    "lat": lat, "lon": lon, "kind": kind},
        "param": param,
        "value": value,
        "flag": flag,
        "observedAt": iso(at),
        "origin": origin,
        "conflict": conflict,
    });
    // Licences that require attribution (NOAA CRW) travel with the record.
    if let Some((credit, doi)) = crate::source_pages::credit(&source) {
        record["credit"] = json!(credit);
        record["doi"] = json!(doi);
    }
    let mut links = Vec::new();
    if let (Some(k), Some(v), "ok") = (PhysKind::of(param, origin), value, flag.as_str()) {
        links.extend(reading_conflicts(c, app, k, &ReadingAt { lat, lon, at, value: v })?);
    }
    links.extend(fetch_link(c, &source, raw_id)?);
    let raw = raw_ref(c, raw_id)?;
    Ok(Some(Found {
        record,
        ingest_lag_ms: raw.as_ref().map(|r| r.fetched_at - at),
        page_url: source_page_url(&source, &ext_id),
        raw,
        source: Some(source),
        links,
        api_url: None,
    }))
}

/// The feed (`sources.id`) that writes a forecast-store `source` value.
fn feed_of_store_source(source: crate::forecast::Source) -> &'static str {
    match source {
        crate::forecast::Source::NwpsLive => crate::ingest::poll::nwps::SOURCE_ID,
        crate::forecast::Source::IemArchive => crate::ingest::poll::iem::SOURCE_ID,
        crate::forecast::Source::NwsGridpoint => crate::ingest::poll::nws_forecast::SOURCE_ID,
    }
}

/// The newest archived payload of `feed` fetched at or before `at` whose URL contains `needle`.
fn raw_near(c: &Connection, feed: &str, needle: &str, at: i64) -> rusqlite::Result<Option<i64>> {
    c.prepare_cached(
        "select id from raw_objects where source_id = ?1 and fetched_at <= ?3 and instr(source_url, ?2) > 0
         order by fetched_at desc, id desc limit 1",
    )?
    .query_row(params![feed, needle, at], |r| r.get(0))
    .optional()
}

/// An NWPS observation of the forecast store (`forecast_observations`), cited by the review
/// engine as `reading:<lid>:stage_m:<ms>:measured`: stage in NWPS feet (the flood-category
/// datum), flow in kcfs. Only measured stage/flow params name one.
fn nwps_observation(c: &Connection, site: &str, param: &str, at: i64, origin: &str) -> rusqlite::Result<Option<Found>> {
    if origin != "measured" || !matches!(param, "stage_m" | "stage_ft" | "flow_kcfs" | "discharge_cfs") {
        return Ok(None);
    }
    let lid = site.to_ascii_uppercase();
    let row: Option<(Option<f64>, Option<f64>, String, i64)> = c
        .prepare_cached("select stage_ft, flow_kcfs, source, ingested_at from forecast_observations where site = ?1 and observed_at = ?2")?
        .query_row(params![lid, at], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .optional()?;
    let Some((stage_ft, flow_kcfs, store_source, ingested_at)) = row else { return Ok(None) };
    let store = crate::forecast::Source::from_db(&store_source).unwrap_or(crate::forecast::Source::NwpsLive);
    let feed = feed_of_store_source(store);
    let api_url = crate::ingest::poll::nwps::stageflow_url(&lid);
    let raw_id = match store {
        crate::forecast::Source::NwpsLive => raw_near(c, feed, &format!("/{lid}/stageflow"), ingested_at)?,
        _ => raw_near(c, feed, &lid, ingested_at)?,
    };
    let thresholds = crate::forecast::store::thresholds_asof(c, &lid, ingested_at)?;
    let record = json!({
        "site": lid,
        "station": {"extId": lid, "source": feed, "kind": "nwps_gauge"},
        "param": param,
        "origin": origin,
        "observedAt": iso(at),
        "ingestedAt": iso(ingested_at),
        "provenance": store.db(),
        "stageFt": stage_ft,
        "stageM": stage_ft.map(|ft| ft * crate::ingest::poll::physical::FEET_TO_M),
        "flowKcfs": flow_kcfs,
        "flowCfs": flow_kcfs.map(|k| k * 1000.0),
        "datum": "NWPS stage datum, the one the NWPS flood categories use (USGS stage can differ)",
        "category": thresholds.and_then(|t| t.category(stage_ft)).map(crate::forecast::Category::db),
        "lowWater": thresholds.and_then(|t| t.low_water(stage_ft)),
    });
    let raw = raw_ref(c, raw_id)?;
    Ok(Some(Found {
        record,
        links: fetch_link(c, feed, raw_id)?.into_iter().collect(),
        raw,
        source: Some(feed.to_string()),
        ingest_lag_ms: Some(ingested_at - at),
        page_url: source_page_url(crate::ingest::poll::nwps::SOURCE_ID, &lid),
        api_url: Some(api_url),
    }))
}

/// One `alert_snapshots` row: site, event, severity, headline, onset, expires, first seen,
/// last seen, ended.
type AlertVersion = (String, String, String, Option<String>, Option<i64>, Option<i64>, i64, i64, Option<i64>);

async fn alert(state: &AppState, id: &str, key: &str) -> Res<Found> {
    if key.is_empty() {
        return Err(bad_id(id, "alert:<alerts.id or NWS alert id>"));
    }
    let key = key.to_string();
    let feed = crate::ingest::poll::nws::feed_id(&state.app);
    let found = state
        .obs
        .read(move |c| {
            let aid: Option<i64> = match key.parse::<i64>() {
                Ok(n) => Some(n),
                Err(_) => c.prepare_cached("select id from alerts where ext_id = ?1 order by id desc limit 1")?.query_row([&key], |r| r.get(0)).optional()?,
            };
            let row = match aid {
                Some(aid) => c
                    .prepare_cached(
                        "select source_id, ext_id, event, severity, headline, area_geojson, onset, expires, raw_object_id
                         from alerts where id = ?1",
                    )?
                    .query_row([aid], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, Option<String>>(4)?,
                            r.get::<_, Option<String>>(5)?,
                            r.get::<_, Option<i64>>(6)?,
                            r.get::<_, Option<i64>>(7)?,
                            r.get::<_, Option<i64>>(8)?,
                        ))
                    })
                    .optional()?,
                None => None,
            };
            let ext = row.as_ref().map_or(key.clone(), |r| r.1.clone());
            // Per-site versions from the forecast store (conditions apps): first/last seen, end.
            let versions: Vec<AlertVersion> = c
                .prepare_cached(
                    "select site, event, severity, headline, onset, expires, first_seen, last_seen, ended_at
                     from alert_snapshots where ext_id = ?1 order by first_seen, site, id",
                )?
                .query_map([&ext], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?)))?
                .collect::<rusqlite::Result<_>>()?;
            if row.is_none() && versions.is_empty() {
                return Ok(None);
            }
            let first_seen = versions.iter().map(|v| v.6).min();
            let last_seen = versions.iter().map(|v| v.7).max();
            let ended_at = (!versions.is_empty() && versions.iter().all(|v| v.8.is_some())).then(|| versions.iter().filter_map(|v| v.8).max()).flatten();
            let sites: Vec<Value> = versions
                .iter()
                .map(|(site, event, severity, headline, onset, expires, first, last, ended)| {
                    json!({"site": site, "event": event, "severity": severity, "headline": headline, "onset": iso_opt(*onset),
                           "expires": iso_opt(*expires), "firstSeen": iso(*first), "lastSeen": iso(*last), "endedAt": iso_opt(*ended)})
                })
                .collect();
            let (source, event, severity, headline, area, onset, expires, raw_id) = match row {
                Some((source, _, event, severity, headline, area, onset, expires, raw_id)) => (source, event, severity, headline, area, onset, expires, raw_id),
                None => {
                    let v = &versions[0];
                    (feed.to_string(), v.1.clone(), v.2.clone(), v.3.clone(), None, v.4, v.5, None)
                }
            };
            let record = json!({
                "id": aid.map(|a| a.to_string()),
                "source": source,
                "extId": ext,
                "event": event,
                "severity": severity,
                "headline": headline,
                "areaGeojson": area.and_then(|a| serde_json::from_str::<Value>(&a).ok()),
                "onset": iso_opt(onset),
                "expires": iso_opt(expires),
                "firstSeen": iso_opt(first_seen),
                "lastSeen": iso_opt(last_seen),
                "endedAt": iso_opt(ended_at),
                "sites": sites,
            });
            let links: Vec<EvidenceLink> = fetch_link(c, &source, raw_id)?.into_iter().collect();
            let raw = raw_ref(c, raw_id)?;
            let api_url = ext.starts_with("urn:oid:").then(|| format!("https://api.weather.gov/alerts/{ext}"));
            Ok(Some(Found {
                ingest_lag_ms: raw.as_ref().zip(onset).map(|(r, onset)| r.fetched_at - onset).or(first_seen.zip(onset).map(|(f, o)| f - o)),
                page_url: source_page_url(&source, &ext),
                record,
                raw,
                source: Some(source),
                links,
                api_url,
            }))
        })
        .await?;
    found.ok_or_else(|| not_found(id))
}

async fn fetch(state: &AppState, id: &str, key: &str) -> Res<Found> {
    let fid: i64 = key.parse().map_err(|_| bad_id(id, "fetch:<integer id>"))?;
    let found = state
        .obs
        .read(move |c| {
            let row = c
                .prepare_cached(
                    "select source_id, fetched_at, received_at, status, http_status, rows_in, raw_object_id, error
                     from fetch_runs where id = ?1",
                )?
                .query_row([fid], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, Option<i64>>(4)?,
                        r.get::<_, i64>(5)?,
                        r.get::<_, Option<i64>>(6)?,
                        r.get::<_, Option<String>>(7)?,
                    ))
                })
                .optional()?;
            let Some((source, fetched_at, received_at, status, http_status, rows_in, raw_id, error)) = row else {
                return Ok(None);
            };
            let record = json!({
                "id": fid.to_string(),
                "source": source,
                "fetchedAt": iso(fetched_at),
                "receivedAt": iso(received_at),
                "status": status,
                "httpStatus": http_status,
                "rowsIn": rows_in,
                "error": error,
            });
            let mut links = Vec::new();
            if let Some(raw_id) = raw_id {
                for (table, kind) in [("sightings", "sighting"), ("alerts", "alert")] {
                    let ids: Vec<i64> = c
                        .prepare_cached(&format!("select id from {table} where raw_object_id = ?1 order by id limit ?2"))?
                        .query_map(params![raw_id, MAX_LINKS], |r| r.get(0))?
                        .collect::<rusqlite::Result<_>>()?;
                    links.extend(ids.into_iter().map(|i| link(format!("{kind}:{i}"), "produced", &source)));
                }
            }
            Ok(Some(Found {
                record,
                raw: raw_ref(c, raw_id)?,
                source: Some(source),
                ingest_lag_ms: Some(received_at - fetched_at),
                links,
                page_url: None,
                api_url: None,
            }))
        })
        .await?;
    found.ok_or_else(|| not_found(id))
}

fn parse_species<'a>(app: &'a App, id: &str, s: &str, shape: &str) -> Res<&'a Taxon> {
    app.taxon(s).ok_or_else(|| bad_id(id, shape))
}

async fn hotspot_found(state: &AppState, id: &str, key: &str) -> Res<Found> {
    let app = &state.app;
    let shape = format!("hotspot:<species>:{}:<frame ms>", app.cell_shape());
    if !app.is_species() {
        return Err(bad_id(id, &format!("{shape} (app {} has no hotspot grid)", app.id())));
    }
    let parts: Vec<&str> = key.split(':').collect();
    // species, then the cell id (2 or 3 parts), then the frame time.
    let (species, cell_parts, at) = match parts.as_slice() {
        [species, col, row, at] => (*species, vec![*col, *row], *at),
        [species, region, col, row, at] => (*species, vec![*region, *col, *row], *at),
        _ => return Err(bad_id(id, &shape)),
    };
    let sp = parse_species(app, id, species, &shape)?;
    let cell = cell_parts.join(":");
    let (region, idx) = app.parse_cell(&cell).ok_or_else(|| bad_id(id, &shape))?;
    let at: i64 = at.parse().map_err(|_| bad_id(id, &shape))?;
    let (lon, lat) = region.grid.center(idx);
    if hotspot::lionfish::enabled(app) {
        let weights = hotspot::lionfish::Weights::from_app(app);
        let basis = crate::ingest::quality_bio::DateBasis::Submitted;
        let ex = hotspot::lionfish::explain(&state.obs, app, &cell, sp, at, weights, basis).await?;
        let out = crate::graphql::types::HotspotExplain::from_lionfish(ID(sp.id().into()), crate::graphql::types::Time(at), ex);
        let components = out.components.as_ref().expect("component app");
        let component = |c: &crate::graphql::types::HotspotComponent| {
            json!({
                "id": c.id.as_str(), "value": c.value, "state": format!("{:?}", c.state).to_lowercase(), "weight": c.weight,
                "rationale": c.rationale, "inputs": c.inputs,
                "evidence": c.evidence.iter().map(|e| json!({
                    "id": e.id.as_str(), "kind": e.kind, "observedAt": iso_opt(e.observed_at.map(|t| t.0)),
                    "submittedAt": iso_opt(e.submitted_at.map(|t| t.0)), "ingestedAt": iso_opt(e.ingested_at.map(|t| t.0)),
                    "weight": e.weight, "detail": e.detail, "url": e.url,
                })).collect::<Vec<_>>(),
            })
        };
        let record = json!({
            "cell": cell,
            "region": region.id(),
            "species": sp.id(),
            "at": iso(at),
            "lat": lat,
            "lon": lon,
            "rankScore": out.rank_score,
            "thin": out.thin,
            "weights": out.weights.map(|w| json!({"recentReports": w.recent_reports, "idQuality": w.id_quality, "heatStress": w.heat_stress})),
            "basis": format!("{:?}", out.basis.expect("component app")).to_lowercase(),
            "components": {
                "recentReports": component(&components.recent_reports),
                "idQuality": component(&components.id_quality),
                "heatStress": component(&components.heat_stress),
                "completeness": component(&components.completeness),
            },
            "heat": out.heat.map(|h| json!({"dhw": h.dhw, "baa": h.baa, "sst": h.sst, "anomaly": h.anomaly, "observedAt": iso(h.observed_at.0), "ingestedAt": iso(h.ingested_at.0), "station": h.station.as_str(), "credit": h.credit})),
            "fieldWindow": out.field_window.map(|f| json!({"state": format!("{:?}", f.state).to_lowercase(), "issuedAt": iso_opt(f.issued_at.map(|t| t.0)), "waveMaxM": f.wave_max_m, "waveMinM": f.wave_min_m, "calmHours": f.calm_hours, "horizonHours": f.horizon_hours, "currentMaxMs": f.current_max_ms, "station": f.station.as_str()})),
            "caveats": out.caveats,
            "credit": out.credit,
        });
        return Ok(Found { record, source: None, raw: None, ingest_lag_ms: None, links: Vec::new(), page_url: None, api_url: None });
    }
    let ex = hotspot::score::explain(&state.obs, app, &cell, sp, at).await?;
    let record = json!({
        "cell": cell,
        "region": region.id(),
        "species": sp.id(),
        "at": iso(at),
        "lat": lat,
        "lon": lon,
        "score": ex.score,
        "terms": ex.terms.iter().map(|t| json!({"name": t.name, "value": t.value, "rationale": t.rationale})).collect::<Vec<_>>(),
    });
    Ok(Found { record, source: None, raw: None, ingest_lag_ms: None, links: Vec::new(), page_url: None, api_url: None })
}

async fn backtest_found(state: &AppState, id: &str, key: &str) -> Res<Found> {
    const SHAPE: &str = "backtest:<species>:<days 1-366>";
    let app = &state.app;
    if !app.is_species() {
        return Err(bad_id(id, &format!("{SHAPE} (app {} has no hotspot grid)", app.id())));
    }
    let (species, days) = key.split_once(':').ok_or_else(|| bad_id(id, SHAPE))?;
    let sp = parse_species(app, id, species, SHAPE)?;
    let days: u32 = days.parse().ok().filter(|d| (1..=366).contains(d)).ok_or_else(|| bad_id(id, SHAPE))?;
    let b = hotspot::backtest::backtest_until(&state.obs, app, sp, days, state.now_ms()).await?;
    let record = json!({
        "species": sp.id(),
        "days": b.days,
        "hitRate": b.hit_rate,
        "baseline": b.baseline,
        "perDay": b.per_day.iter().map(|d| json!({"day": iso(d.day), "sightings": d.sightings, "hits": d.hits})).collect::<Vec<_>>(),
    });
    Ok(Found { record, source: None, raw: None, ingest_lag_ms: None, links: Vec::new(), page_url: None, api_url: None })
}

/// The forecast-store site and product a `forecast:` key names: `<lid>` (river issuance; any
/// product but `gridpoint` first), or `nws:<office>/<x>,<y>` (the gridpoint run of the location on
/// that grid).
fn forecast_site(app: &App, site: &str) -> Option<(String, Option<&'static str>)> {
    match site.strip_prefix("nws:") {
        Some(grid) => {
            let (office, xy) = grid.split_once('/')?;
            let (x, y) = xy.split_once(',')?;
            let (x, y): (u32, u32) = (x.parse().ok()?, y.parse().ok()?);
            let loc = app.cfg.locations.iter().find(|l| {
                l.nws_grid.as_ref().is_some_and(|g| g.office.eq_ignore_ascii_case(office) && g.x == x && g.y == y) && l.nwps.is_some()
            })?;
            Some((loc.nwps.clone()?.to_ascii_uppercase(), Some("gridpoint")))
        }
        None => Some((site.to_ascii_uppercase(), None)),
    }
}

async fn forecast_found(state: &AppState, id: &str, key: &str) -> Res<Found> {
    const SHAPE: &str = "forecast:<lid>:<issued ms> or forecast:nws:<office>/<x>,<y>:<updateTime ms>";
    let (site, at) = key.rsplit_once(':').ok_or_else(|| bad_id(id, SHAPE))?;
    let issued: i64 = at.parse().map_err(|_| bad_id(id, SHAPE))?;
    if site.is_empty() {
        return Err(bad_id(id, SHAPE));
    }
    let Some((lid, product)) = forecast_site(&state.app, site) else {
        return Err(not_found(id));
    };
    let grid = state.app.cfg.locations.iter().find(|l| l.nwps.as_deref().is_some_and(|n| n.eq_ignore_ascii_case(&lid))).and_then(|l| l.nws_grid.clone());
    let location = state.app.cfg.locations.iter().find(|l| l.nwps.as_deref().is_some_and(|n| n.eq_ignore_ascii_case(&lid))).map(|l| json!({"id": l.id, "name": l.name}));
    let found = state
        .obs
        .read(move |c| {
            // The newest revision of the issuance; a river product before a gridpoint run, and the
            // live capture before an archive copy of the same issuance.
            let snap_id: Option<i64> = c
                .prepare_cached(
                    "select id from forecast_snapshots where site = ?1 and issued_at = ?2 and (?3 is null or product = ?3)
                     order by product = 'gridpoint', source != 'nwps-live', revision desc, id desc limit 1",
                )?
                .query_row(params![lid, issued, product], |r| r.get(0))
                .optional()?;
            let Some(snap_id) = snap_id else { return Ok(None) };
            let Some(s) = crate::forecast::query::by_id(c, snap_id)? else { return Ok(None) };
            let revisions: i64 = c
                .prepare_cached("select count(*) from forecast_snapshots where site = ?1 and product = ?2 and issued_at = ?3")?
                .query_row(params![s.site, s.product, s.issued_at], |r| r.get(0))?;
            // The thresholds an as-of view at the issuance would use: archive rows were public at
            // issue, live rows once captured.
            let known_at = if s.source.backfilled() { s.issued_at } else { s.ingested_at };
            let thresholds = crate::forecast::store::thresholds_asof(c, &s.site, known_at)?;
            let newest = crate::forecast::store::newest_thresholds(c, &s.site)?;
            let neighbour = |sql: &str| -> rusqlite::Result<Option<i64>> {
                c.prepare_cached(sql)?.query_row(params![s.site, s.product, s.issued_at], |r| r.get::<_, Option<i64>>(0))
            };
            let previous = neighbour("select max(issued_at) from forecast_snapshots where site = ?1 and product = ?2 and issued_at < ?3")?;
            let next = neighbour("select min(issued_at) from forecast_snapshots where site = ?1 and product = ?2 and issued_at > ?3")?;
            let feed = feed_of_store_source(s.source);
            let (needle, api_url) = match (s.source, &grid) {
                (crate::forecast::Source::NwsGridpoint, Some(g)) => {
                    let path = format!("{}/{},{}", g.office, g.x, g.y);
                    (path.clone(), format!("{}/{path}/forecast", crate::ingest::poll::nws_forecast::API))
                }
                (crate::forecast::Source::NwpsLive, _) => (format!("/{}/stageflow", s.site), crate::ingest::poll::nwps::stageflow_url(&s.site)),
                _ => (s.site.clone(), crate::review::forecast_link(&s)),
            };
            let raw_id = raw_near(c, feed, &needle, s.ingested_at)?;
            let peak = s.peak().copied();
            let th_json = |t: crate::forecast::Thresholds| json!({"actionFt": t.action_ft, "minorFt": t.minor_ft, "moderateFt": t.moderate_ft, "majorFt": t.major_ft, "lowFt": t.low_ft});
            let th = thresholds.map(th_json);
            let record = json!({
                "site": s.site,
                "location": location,
                "product": s.product,
                "issuedAt": iso(s.issued_at),
                "ingestedAt": iso(s.ingested_at),
                "provenance": s.source.db(),
                "revision": s.revision,
                "revisions": revisions,
                "payloadHash": s.payload_hash,
                "validFrom": iso_opt(s.valid_from),
                "validTo": iso_opt(s.valid_to),
                "horizonEnd": iso_opt(s.horizon_end),
                "thresholds": th,
                "thresholdsKnownAt": iso(known_at),
                // The newest thresholds, for a snapshot captured before any were known.
                "thresholdsNow": newest.map(th_json),
                "peak": peak.map(|p| json!({"at": iso(p.valid_at), "stageFt": p.stage_ft,
                    "category": thresholds.and_then(|t| t.category(p.stage_ft)).map(crate::forecast::Category::db)})),
                "points": s.points.iter().map(|p| json!({"validAt": iso(p.valid_at), "stageFt": p.stage_ft, "flowKcfs": p.flow_kcfs,
                    "category": thresholds.and_then(|t| t.category(p.stage_ft)).map(crate::forecast::Category::db)})).collect::<Vec<_>>(),
            });
            let mut links: Vec<EvidenceLink> = fetch_link(c, feed, raw_id)?.into_iter().collect();
            let other = |at: i64| match product {
                Some(_) => grid.as_ref().map_or(format!("forecast:{}:{at}", s.site), |g| format!("forecast:nws:{}/{},{}:{at}", g.office, g.x, g.y)),
                None => format!("forecast:{}:{at}", s.site),
            };
            links.extend(previous.map(|at| link(other(at), "previous", feed)));
            links.extend(next.map(|at| link(other(at), "next", feed)));
            let raw = raw_ref(c, raw_id)?;
            Ok(Some(Found {
                record,
                raw,
                source: Some(feed.to_string()),
                ingest_lag_ms: Some(s.ingested_at - s.issued_at),
                links,
                page_url: source_page_url(crate::ingest::poll::nwps::SOURCE_ID, &s.site),
                api_url: Some(api_url),
            }))
        })
        .await?;
    found.ok_or_else(|| not_found(id))
}

async fn review_found(state: &AppState, id: &str, key: &str) -> Res<Found> {
    const SHAPE: &str = "review:<lid or location id>:<asOf ms>";
    let app = &state.app;
    if app.is_species() {
        return Err(bad_id(id, &format!("{SHAPE} (app {} has no review board)", app.id())));
    }
    let (site, at) = key.rsplit_once(':').ok_or_else(|| bad_id(id, SHAPE))?;
    let at: i64 = at.parse().map_err(|_| bad_id(id, SHAPE))?;
    let sites = crate::review::SiteRef::all(&app.cfg);
    let site = sites.into_iter().find(|s| s.lid.eq_ignore_ascii_case(site) || s.location == site).ok_or_else(|| not_found(id))?;
    let cfg = app.cfg.review.clone().unwrap_or_default();
    let lid = site.lid.clone();
    let review = state.obs.read(move |c| crate::review::site_review(c, &site, at, &cfg)).await?;
    let mut links = Vec::new();
    for r in &review.checks {
        for e in &r.evidence_ids {
            if !links.iter().any(|l: &EvidenceLink| l.id.as_str() == e) {
                links.push(link(e.clone(), "cites", &r.source));
            }
        }
    }
    Ok(Found {
        record: crate::review::to_json(&review),
        source: None,
        raw: None,
        ingest_lag_ms: None,
        links,
        page_url: source_page_url(crate::ingest::poll::nwps::SOURCE_ID, &lid),
        api_url: None,
    })
}

async fn source_found(state: &AppState, id: &str, key: &str) -> Res<Found> {
    if key.is_empty() {
        return Err(bad_id(id, "source:<feed id>"));
    }
    let views = crate::source_pages::source_views(state).await?;
    let v = views.into_iter().find(|v| v.feed == key).ok_or_else(|| not_found(id))?;
    let links = v.last_fetch_run_id.map(|run| link(format!("fetch:{run}"), "fetch", &v.feed)).into_iter().collect();
    let page = Some(v.page_url.clone()).filter(|u| u.starts_with("https://"));
    let api = Some(v.api_url.clone()).filter(|u| u.starts_with("https://"));
    Ok(Found {
        record: crate::source_pages::source_view_json(&v),
        source: Some(v.feed),
        raw: None,
        ingest_lag_ms: None,
        links,
        page_url: page,
        api_url: api,
    })
}

/// A mission or note on the app's team board (any board of the app's team database): its
/// last-writer-wins fields, deleted ones included and flagged.
async fn team_entity(state: &AppState, id: &str, kind: &str, key: &str) -> Res<Found> {
    if key.is_empty() {
        return Err(bad_id(id, &format!("{kind}:<id>")));
    }
    let (kind, key) = (kind.to_string(), key.to_string());
    let found = state
        .team
        .read(move |c| {
            let rows: Vec<(String, String, Option<String>, String)> = c
                .prepare_cached("select board_id, field, value, hlc from fields where entity = ?1 and entity_id = ?2 order by board_id, field")?
                .query_map(params![kind, key], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect::<rusqlite::Result<_>>()?;
            let Some(board) = rows.first().map(|r| r.0.clone()) else { return Ok(None) };
            let mut fields = serde_json::Map::new();
            let mut updated = String::new();
            for (b, field, value, hlc) in rows.into_iter().filter(|r| r.0 == board) {
                debug_assert_eq!(b, board);
                fields.insert(field, value.as_deref().and_then(|v| serde_json::from_str(v).ok()).unwrap_or(Value::Null));
                if crate::crdt::compare_hlc(&hlc, &updated).is_gt() {
                    updated = hlc;
                }
            }
            let deleted = crate::crdt::is_deleted(&fields);
            fields.remove("_deleted");
            let removals: Option<i64> = c
                .prepare_cached("select sum(total) from removal_counts where board_id = ?1 and entity_id = ?2")?
                .query_row(params![board, key], |r| r.get(0))?;
            Ok(Some(json!({"id": key, "kind": kind, "board": board, "fields": fields, "deleted": deleted, "updatedHlc": updated, "removals": removals})))
        })
        .await?;
    let record = found.ok_or_else(|| not_found(id))?;
    Ok(Found { record, source: None, raw: None, ingest_lag_ms: None, links: Vec::new(), page_url: None, api_url: None })
}

/// A committed message on the app's team board.
async fn team_message(state: &AppState, id: &str, key: &str) -> Res<Found> {
    if key.is_empty() {
        return Err(bad_id(id, "message:<id>"));
    }
    let key = key.to_string();
    let found = state
        .team
        .read(move |c| {
            c.prepare_cached("select board_id, body, hlc, node_id, to_node, thread from messages where id = ?1")?
                .query_row([&key], |r| {
                    Ok(json!({"id": key, "board": r.get::<_, String>(0)?, "body": r.get::<_, String>(1)?, "hlc": r.get::<_, String>(2)?,
                              "from": r.get::<_, String>(3)?, "to": r.get::<_, Option<String>>(4)?, "thread": r.get::<_, Option<String>>(5)?}))
                })
                .optional()
        })
        .await?;
    let record = found.ok_or_else(|| not_found(id))?;
    Ok(Found { record, source: None, raw: None, ingest_lag_ms: None, links: Vec::new(), page_url: None, api_url: None })
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;
    use crate::app::test_support::test_state;
    use crate::hotspot::score::testkit::{insert_readings, insert_station, seed_sources};

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(bytes).unwrap();
        enc.finish().unwrap()
    }

    const OBSERVED: i64 = 1_790_000_000_000;

    /// A raw object archived under `key`, and its fetch run. Returns (raw_object_id, fetch_run_id).
    async fn archive_raw(state: &AppState, source: &'static str, key: &'static str, body: &[u8], fetched_at: i64) -> (i64, i64) {
        state.archive.put(key, gzip(body), "application/gzip").await.unwrap();
        let len = body.len() as i64;
        state
            .obs
            .write(move |tx| {
                tx.execute(
                    "insert into raw_objects (r2_key, source_id, source_url, fetched_at, bytes, sha256)
                     values (?1, ?2, 'https://api.example.test/' || ?2, ?3, ?4, 'abc123')",
                    params![key, source, fetched_at, len],
                )?;
                let raw = tx.last_insert_rowid();
                tx.execute(
                    "insert into fetch_runs (source_id, fetched_at, received_at, status, rows_in, raw_object_id)
                     values (?1, ?2, ?2 + 250, 'ok', 1, ?3)",
                    params![source, fetched_at, raw],
                )?;
                Ok((raw, tx.last_insert_rowid()))
            })
            .await
            .unwrap()
    }

    async fn insert_sighting(
        state: &AppState,
        source: &'static str,
        ext: &'static str,
        taxon: i64,
        raw: Option<i64>,
        canonical: Option<i64>,
    ) -> i64 {
        state
            .obs
            .write(move |tx| {
                tx.execute(
                    "insert into sightings (source_id, ext_id, taxon_id, lat, lon, observed_at, quality, photo_url,
                                            raw_object_id, canonical_id, conflict, ingested_at)
                     values (?1, ?2, ?3, 25.4, -80.6, ?4, 'research', null, ?5, ?6, 0, ?4 + 90000)",
                    params![source, ext, taxon, OBSERVED, raw, canonical],
                )?;
                Ok(tx.last_insert_rowid())
            })
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn evidence_sighting_with_gbif_duplicate_and_revision() {
        let state = test_state();
        seed_sources(&state.obs).await;
        let inat_payload = br#"{"total_results":1,"results":[{"id":398628449,"taxon":{"name":"Python molurus"}}]}"#;
        let (raw, run) = archive_raw(&state, "inat", "raw/inat/2026/09/21/a.json.gz", inat_payload, OBSERVED + 60_000).await;
        let inat = insert_sighting(&state, "inat", "398628449", 1, Some(raw), None).await;
        let gbif = insert_sighting(&state, "gbif", "50c9509d:398628449:4411", 1, None, Some(inat)).await;
        state
            .obs
            .write(move |tx| {
                tx.execute(
                    "insert into sighting_revisions (sighting_id, changed_at, field, old, new)
                     values (?1, ?2, 'taxon', 'Python bivittatus', 'Python molurus')",
                    params![inat, OBSERVED + 3_600_000],
                )?;
                tx.execute("update sightings set conflict = 1 where id = ?1", [inat])
            })
            .await
            .unwrap();

        let ev = evidence(&state, &format!("sighting:{inat}")).await.unwrap();
        assert_eq!(ev.kind, "sighting");
        assert_eq!(ev.record["extId"], "398628449");
        assert_eq!(ev.record["conflict"], true);
        assert_eq!(
            ev.record["revisions"],
            json!([{"changedAt": iso(OBSERVED + 3_600_000), "field": "taxon", "old": "Python bivittatus", "new": "Python molurus"}])
        );
        // Raw payload came back from the archive, gunzipped and parsed.
        assert_eq!(ev.raw.as_ref().unwrap()["results"][0]["id"], 398628449);
        assert_eq!(ev.raw_key.as_deref(), Some("raw/inat/2026/09/21/a.json.gz"));
        assert_eq!(ev.source_url.as_deref(), Some("https://api.example.test/inat"));
        assert_eq!(ev.fetched_at.map(|t| t.0), Some(OBSERVED + 60_000));
        assert_eq!(ev.ingest_lag_seconds, Some(90));
        let feed = ev.feed.as_ref().expect("feed state of inat");
        assert_eq!(feed.source, "inat");
        assert_eq!(feed.last_fetch_run_id.as_ref().map(|i| i.as_str()), Some(run.to_string().as_str()));
        let links: Vec<(String, String, String)> =
            ev.links.iter().map(|l| (l.id.to_string(), l.relation.clone(), l.source.clone())).collect();
        assert_eq!(
            links,
            vec![
                (format!("sighting:{gbif}"), "duplicates".into(), "gbif".into()),
                (format!("fetch:{run}"), "fetch".into(), "inat".into()),
            ]
        );

        // The GBIF copy points back at its canonical; it has no raw object of its own.
        let ev = evidence(&state, &format!("sighting:{gbif}")).await.unwrap();
        assert_eq!(ev.links.len(), 1);
        assert_eq!((ev.links[0].id.as_str(), ev.links[0].relation.as_str()), (format!("sighting:{inat}").as_str(), "duplicate_of"));
        assert!(ev.raw.is_none() && ev.raw_key.is_none());

        // A duplicate naming another taxon is also a conflict.
        state.obs.write(|tx| tx.execute("insert into taxa (id, scientific_name, common_name) values (7, 'Python molurus', 'Indian python')", [])).await.unwrap();
        let other = insert_sighting(&state, "nas", "nas-1", 7, None, Some(inat)).await;
        let ev = evidence(&state, &format!("sighting:{inat}")).await.unwrap();
        let rels: Vec<(String, &str)> = ev.links.iter().map(|l| (l.id.to_string(), l.relation.as_str())).collect();
        assert!(rels.contains(&(format!("sighting:{other}"), "duplicates")), "{rels:?}");
        assert!(rels.contains(&(format!("sighting:{other}"), "conflict")), "{rels:?}");
        assert!(!rels.contains(&(format!("sighting:{gbif}"), "conflict")), "{rels:?}");
    }

    #[tokio::test]
    async fn evidence_source_page_url_per_kind() {
        let state = test_state();
        seed_sources(&state.obs).await;
        let page = |ev: &Evidence| ev.source_page_url.clone();
        state
            .obs
            .write(|tx| {
                tx.execute(
                    "insert into sources (id, name, homepage, mode, cadence_s, max_latency_s)
                     values ('openmeteo', 'openmeteo', 'https://open-meteo.com', 'poll', 3600, 7200)",
                    [],
                )
            })
            .await
            .unwrap();

        let (raw, run) = archive_raw(&state, "inat", "raw/inat/2026/09/30/p.json.gz", b"{}", OBSERVED).await;
        let inat = insert_sighting(&state, "inat", "398269828", 1, Some(raw), None).await;
        let gbif = insert_sighting(&state, "gbif", "50c9509d-22c7-4a22-a47d-8c48425ef4a7:398269828:6550750302", 1, None, Some(inat)).await;
        let nas = insert_sighting(&state, "nas", "1936189", 1, None, None).await;
        let ev = evidence(&state, &format!("sighting:{inat}")).await.unwrap();
        assert_eq!(page(&ev).as_deref(), Some("https://www.inaturalist.org/observations/398269828"));
        // The API URL stays in sourceUrl.
        assert_eq!(ev.source_url.as_deref(), Some("https://api.example.test/inat"));
        let ev = evidence(&state, &format!("sighting:{gbif}")).await.unwrap();
        assert_eq!(page(&ev).as_deref(), Some("https://www.gbif.org/occurrence/6550750302"));
        let ev = evidence(&state, &format!("sighting:{nas}")).await.unwrap();
        assert_eq!(page(&ev).as_deref(), Some("https://nas.er.usgs.gov/queries/SpecimenViewer.aspx?SpecimenID=1936189"));

        let t = OBSERVED;
        let buoy = insert_station(&state.obs, "ndbc", "KYWF1", 24.55, -81.81, "buoy").await;
        let gage = insert_station(&state.obs, "usgs", "02290930:31179", 25.25, -80.80, "gage").await;
        let grid = insert_station(&state.obs, "openmeteo", "24.925,-80.575", 24.925, -80.575, "grid").await;
        let cell = insert_station(&state.obs, "goes19", "g5:77", 25.0, -80.6, "goes_cell").await;
        insert_readings(&state.obs, vec![(buoy, "air_c", Some(27.0), t), (gage, "stage_m", Some(0.4), t), (grid, "wind_ms", Some(5.0), t)]).await;
        insert_readings(&state.obs, vec![(cell, "sst_c", Some(29.0), t)]).await;
        let reading = |station: i64, param: &str| format!("reading:{station}:{param}:{t}:measured");
        let ev = evidence(&state, &reading(buoy, "air_c")).await.unwrap();
        assert_eq!(page(&ev).as_deref(), Some("https://www.ndbc.noaa.gov/station_page.php?station=kywf1"));
        let ev = evidence(&state, &reading(gage, "stage_m")).await.unwrap();
        assert_eq!(page(&ev).as_deref(), Some("https://waterdata.usgs.gov/monitoring-location/USGS-02290930/"));
        // Modelled grid points and GOES cells have no page.
        assert_eq!(page(&evidence(&state, &reading(grid, "wind_ms")).await.unwrap()), None);
        assert_eq!(page(&evidence(&state, &reading(cell, "sst_c")).await.unwrap()), None);

        let alerts = state
            .obs
            .write(|tx| {
                let mut ids = Vec::new();
                for ext in ["vtec:KKEY.SC.Y.0019.2026:GMZ052,GMZ053", "urn:oid:2.49.0.1.840.0.f0378ab3.001.1", "nwws:11723.44102:0"] {
                    tx.execute(
                        "insert into alerts (source_id, ext_id, event, severity) values ('nws', ?1, 'Small Craft Advisory', 'Minor')",
                        [ext],
                    )?;
                    ids.push(tx.last_insert_rowid());
                }
                Ok(ids)
            })
            .await
            .unwrap();
        let ev = evidence(&state, &format!("alert:{}", alerts[0])).await.unwrap();
        assert_eq!(
            page(&ev).as_deref(),
            Some("https://mesonet.agron.iastate.edu/vtec/?wfo=KKEY&phenomena=SC&significance=Y&eventid=0019&year=2026")
        );
        let ev = evidence(&state, &format!("alert:{}", alerts[1])).await.unwrap();
        assert_eq!(page(&ev).as_deref(), Some("https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.f0378ab3.001.1"));
        assert_eq!(page(&evidence(&state, &format!("alert:{}", alerts[2])).await.unwrap()), None);

        // Kinds with no publisher row: fetch runs, hotspots, backtests.
        assert_eq!(page(&evidence(&state, &format!("fetch:{run}")).await.unwrap()), None);
        assert_eq!(page(&evidence(&state, &format!("hotspot:python:100:100:{t}")).await.unwrap()), None);
        assert_eq!(page(&evidence(&state, "backtest:python:2").await.unwrap()), None);
    }

    #[tokio::test]
    async fn evidence_unknown_and_malformed_ids() {
        let state = test_state();
        for id in ["sighting:999", "alert:5", "fetch:1", "reading:1:sst_c:0:measured"] {
            let err = evidence(&state, id).await.unwrap_err();
            assert!(matches!(err, EvidenceError::NotFound(_)), "{id}: {err}");
            assert!(err.to_string().starts_with("not found"), "{err}");
        }
        for id in ["sighting", "sighting:abc", "nope:1", "reading:1:sst_c", "hotspot:python:999:0:0", "backtest:otter:30", "backtest:python:0"] {
            let err = evidence(&state, id).await.unwrap_err();
            assert!(matches!(err, EvidenceError::BadId(_)), "{id}: {err}");
        }
        let gql = EvidenceError::NotFound("not found: x".into()).extend();
        assert_eq!(gql.extensions.unwrap().get("code"), Some(&async_graphql::Value::from("NOT_FOUND")));
    }

    #[tokio::test]
    async fn evidence_reading_links_t8_conflicts() {
        let state = test_state();
        seed_sources(&state.obs).await;
        // A buoy, a GOES SST pixel 2 km away, another 20 km away, and one pixel that agrees.
        let buoy = insert_station(&state.obs, "ndbc", "VAKF1", 25.00, -80.50, "buoy").await;
        let near = insert_station(&state.obs, "goes19", "g5:1", 25.018, -80.50, "goes_cell").await;
        let far = insert_station(&state.obs, "goes19", "g5:2", 25.18, -80.50, "goes_cell").await;
        let agree = insert_station(&state.obs, "goes19", "g5:3", 25.00, -80.49, "goes_cell").await;
        let t = OBSERVED;
        insert_readings(&state.obs, vec![(buoy, "sst_c", Some(28.0), t)]).await;
        state
            .obs
            .write(move |tx| {
                let mut st = tx.prepare(
                    "insert into readings (station_id, param, value, flag, observed_at, origin) values (?1, 'sst_c', ?2, 'ok', ?3, 'satellite')",
                )?;
                st.execute(params![near, 30.1, t + 600_000])?;
                st.execute(params![far, 31.0, t])?;
                st.execute(params![agree, 28.4, t])?;
                st.execute(params![near, 31.0, t + 2 * 3_600_000])?; // outside the 1 h window
                Ok(())
            })
            .await
            .unwrap();
        let ev = evidence(&state, &format!("reading:{buoy}:sst_c:{t}:measured")).await.unwrap();
        assert_eq!(ev.kind, "reading");
        assert_eq!(ev.record["station"]["kind"], "buoy");
        assert_eq!(ev.record["value"], 28.0);
        let links: Vec<(String, String, String)> =
            ev.links.iter().map(|l| (l.id.to_string(), l.relation.clone(), l.source.clone())).collect();
        assert_eq!(
            links,
            vec![(format!("reading:{near}:sst_c:{}:satellite", t + 600_000), "conflict".into(), "goes19".into())]
        );
        assert_eq!(ev.feed.as_ref().unwrap().source, "ndbc");

        // LST vs air in one 0.01° cell: 22 °C of skin over air is outside [-5, 15].
        let met = insert_station(&state.obs, "nws", "KMIA", 25.795, -80.29, "grid").await;
        let pix = insert_station(&state.obs, "goes19", "g5:9", 25.791, -80.284, "goes_cell").await;
        insert_readings(&state.obs, vec![(met, "air_c", Some(18.0), t)]).await;
        state
            .obs
            .write(move |tx| {
                tx.execute(
                    "insert into readings (station_id, param, value, flag, observed_at, origin) values (?1, 'lst_c', 40.0, 'ok', ?2, 'satellite')",
                    params![pix, t],
                )
            })
            .await
            .unwrap();
        let ev = evidence(&state, &format!("reading:{pix}:lst_c:{t}:satellite")).await.unwrap();
        assert_eq!(ev.links.len(), 1);
        assert_eq!(ev.links[0].id.as_str(), format!("reading:{met}:air_c:{t}:measured"));
    }

    #[tokio::test]
    async fn evidence_alert_and_fetch_and_text_payloads() {
        let state = test_state();
        seed_sources(&state.obs).await;
        let big = "x".repeat(RAW_TEXT_CAP + 10);
        let (raw, run) = archive_raw(&state, "nws", "raw/nws/2026/09/21/b.xml.gz", big.as_bytes(), OBSERVED).await;
        let alert = state
            .obs
            .write(move |tx| {
                tx.execute(
                    "insert into alerts (source_id, ext_id, event, severity, headline, area_geojson, onset, expires, raw_object_id)
                     values ('nws', 'urn:1', 'Flood Warning', 'Severe', 'Flooding', '{\"type\":\"Point\",\"coordinates\":[-80.5,25.5]}', ?1, ?2, ?3)",
                    params![OBSERVED - 120_000, OBSERVED + 3_600_000, raw],
                )?;
                Ok(tx.last_insert_rowid())
            })
            .await
            .unwrap();
        let ev = evidence(&state, &format!("alert:{alert}")).await.unwrap();
        assert_eq!(ev.record["event"], "Flood Warning");
        assert_eq!(ev.record["areaGeojson"]["type"], "Point");
        assert_eq!(ev.ingest_lag_seconds, Some(120));
        let raw_json = ev.raw.unwrap();
        assert_eq!(raw_json["truncated"], true);
        assert_eq!(raw_json["bytes"], RAW_TEXT_CAP + 10);
        assert_eq!(raw_json["text"].as_str().unwrap().len(), RAW_TEXT_CAP);

        let ev = evidence(&state, &format!("fetch:{run}")).await.unwrap();
        assert_eq!(ev.kind, "fetch");
        assert_eq!(ev.record["status"], "ok");
        assert_eq!(ev.ingest_lag_seconds, Some(0));
        assert_eq!(ev.links.len(), 1);
        assert_eq!((ev.links[0].id.as_str(), ev.links[0].relation.as_str()), (format!("alert:{alert}").as_str(), "produced"));
    }

    #[tokio::test]
    async fn evidence_backtest_summary_with_per_day() {
        use crate::hotspot::score::testkit::{insert_sighting, DAY, HOUR};
        let state = test_state();
        seed_sources(&state.obs).await;
        let g = state.app.regions[0].grid;
        let today = hotspot::backtest::floor_day(crate::state::now_ms());
        let (lon, lat) = g.center(g.index(100, 100));
        insert_sighting(&state.obs, "inat", 1, lat, lon, today - 3 * DAY + 5 * HOUR, "research", None).await;
        insert_sighting(&state.obs, "inat", 1, lat, lon, today - DAY + 9 * HOUR, "research", None).await;
        let ev = evidence(&state, "backtest:python:2").await.unwrap();
        assert_eq!(ev.kind, "backtest");
        assert_eq!(
            ev.record,
            json!({"species": "python", "days": 2, "hitRate": 1.0, "baseline": 0.1, "perDay": [
                {"day": iso(today - 2 * DAY), "sightings": 0, "hits": 0},
                {"day": iso(today - DAY), "sightings": 1, "hits": 1},
            ]})
        );
        assert!(ev.raw.is_none() && ev.feed.is_none() && ev.links.is_empty());
        // Species by taxon id too.
        assert_eq!(evidence(&state, "backtest:1:2").await.unwrap().record["species"], "python");
    }

    #[tokio::test]
    async fn evidence_feed_cites_last_fetch_run() {
        let state = test_state();
        seed_sources(&state.obs).await;
        let (_, first) = archive_raw(&state, "ndbc", "raw/ndbc/2026/09/21/a.txt.gz", b"#YY MM DD", OBSERVED).await;
        let buoy = insert_station(&state.obs, "ndbc", "VAKF1", 24.63, -81.11, "buoy").await;
        insert_readings(&state.obs, vec![(buoy, "wave_m", Some(0.8), OBSERVED)]).await;
        let (_, latest) = archive_raw(&state, "ndbc", "raw/ndbc/2026/09/21/b.txt.gz", b"#YY MM DD", OBSERVED + 600_000).await;
        assert!(latest > first);
        let ev = evidence(&state, &format!("reading:{buoy}:wave_m:{OBSERVED}:measured")).await.unwrap();
        let feed = ev.feed.expect("ndbc feed state");
        assert_eq!(feed.last_fetch_run_id.map(|id| id.0), Some(latest.to_string()));
        // The cited run resolves as evidence itself.
        let run = evidence(&state, &format!("fetch:{latest}")).await.unwrap();
        assert_eq!(run.record["source"], "ndbc");
        assert_eq!(run.raw.unwrap()["text"], "#YY MM DD");
    }

    #[test]
    fn evidence_netcdf_is_metadata_only() {
        let raw = RawRef {
            key: "raw/goes19/2026/09/26/x.nc.gz".into(),
            source_url: "https://noaa-goes19.s3.amazonaws.com/ABI-L2-LSTC/2026/269/18/OR_ABI-L2-LSTC-M6_G19_s20262691801167_e20262691803541_c20262691805379.nc".into(),
            fetched_at: 0,
            bytes: 2_962_526,
            sha256: "ff".into(),
        };
        let meta = netcdf_meta(&raw);
        assert_eq!(meta["product"], "ABI-L2-LSTC-M6");
        assert_eq!(meta["satellite"], "G19");
        assert_eq!(meta["scanStart"], "20262691801167");
        assert_eq!(meta["bytes"], 2_962_526);
        // Sniffed too, whatever the key says.
        let mut body = HDF5_MAGIC.to_vec();
        body.extend_from_slice(&[0; 64]);
        assert_eq!(decode_raw(&gzip(&body), &raw)["format"], "netcdf4");
        assert_eq!(decode_raw(b"{\"a\":1}", &raw), json!({"a": 1}));
        assert_eq!(decode_raw(b"plain", &raw), json!({"text": "plain", "truncated": false, "bytes": 5}));
    }

    // ---- E1 G1: every cited id resolves ------------------------------------------------------

    use crate::app::test_support::test_state_for;
    use crate::backfill::FIXTURE_NOW;
    use crate::state::Clock;

    /// The carp fixtures (USGS, NWPS, NWS alerts and gridpoint, IEM archive) through the real
    /// pipeline on a clock pinned at [`FIXTURE_NOW`].
    async fn carp_fixtures() -> AppState {
        let state = test_state_for("carp").with_clock(Clock::Fixed(FIXTURE_NOW));
        let root = crate::backfill::fixtures_root();
        for source in crate::backfill::fixture_sources(&state) {
            crate::backfill::ingest_fixtures(&state, source.as_ref(), &root).await.unwrap();
        }
        state
    }

    async fn resolves(state: &AppState, id: &str) -> Evidence {
        evidence(state, id).await.unwrap_or_else(|e| panic!("{id} does not resolve: {e}"))
    }

    /// Every evidence id the review engine cites for the eight carp sites (at the fixture time and
    /// a day later, when inputs are stale and checks cite other records) resolves, and so does the
    /// `review:` id of each review and every id its links name.
    #[tokio::test]
    async fn evidence_kind_review_engine_ids_all_resolve() {
        let state = carp_fixtures().await;
        let sites = crate::review::SiteRef::all(&state.app.cfg);
        let cfg = state.app.cfg.review.clone().unwrap_or_default();
        let mut kinds = std::collections::BTreeMap::<String, usize>::new();
        for at in [FIXTURE_NOW, FIXTURE_NOW - 6 * 3_600_000, FIXTURE_NOW + 86_400_000] {
            let (s, c) = (sites.clone(), cfg.clone());
            let board = state.obs.read(move |conn| crate::review::board(conn, &s, at, &c)).await.unwrap();
            for review in &board.sites {
                for id in review.checks.iter().flat_map(|r| r.evidence_ids.iter()) {
                    let ev = resolves(&state, id).await;
                    *kinds.entry(ev.kind.clone()).or_default() += 1;
                }
                let rid = format!("review:{}:{at}", review.site.lid);
                let ev = resolves(&state, &rid).await;
                assert_eq!(ev.record["status"], review.status.id(), "{rid}");
                assert_eq!(ev.record["checks"].as_array().unwrap().len(), review.checks.len());
                for l in &ev.links {
                    resolves(&state, l.id.as_str()).await;
                }
            }
        }
        println!("EVIDENCE-REVIEW-IDS {kinds:?}");
        for kind in ["reading", "forecast", "fetch"] {
            assert!(kinds.get(kind).is_some_and(|n| *n > 0), "no {kind} id was cited: {kinds:?}");
        }
    }

    /// Every id a Lionfish Watch hotspot cites (component inputs and explain evidence) resolves.
    #[tokio::test]
    async fn evidence_kind_hotspot_engine_ids_all_resolve() {
        use crate::hotspot::lionfish::{explain, hotspots, Weights};
        let state = test_state_for("lionfish").with_clock(Clock::Fixed(FIXTURE_NOW));
        let root = crate::backfill::fixtures_root();
        for source in crate::backfill::fixture_sources(&state) {
            crate::backfill::ingest_fixtures(&state, source.as_ref(), &root).await.unwrap();
        }
        let app = &state.app;
        let basis = crate::ingest::quality_bio::DateBasis::Submitted;
        let mut n = 0;
        for r in &app.regions {
            let cells = hotspots(&state.obs, app, &app.taxa[0], FIXTURE_NOW, app.hull().into(), 3, Some(r.id()), Weights::from_app(app), basis).await.unwrap();
            for c in cells {
                let ex = explain(&state.obs, app, &c.cell, &app.taxa[0], FIXTURE_NOW, Weights::from_app(app), basis).await.unwrap();
                let comps = [&ex.cell.components.recent_reports, &ex.cell.components.id_quality, &ex.cell.components.heat_stress, &ex.cell.components.completeness];
                for comp in comps {
                    // Inputs mix ids with plain notes ("reports: 22 independent in 90 d"): ids only.
                    let is_id = |s: &&String| s.split_once(':').is_some_and(|(k, rest)| matches!(k, "sighting" | "reading") && !rest.starts_with(' '));
                    for id in comp.inputs.iter().filter(is_id).chain(comp.evidence.iter().map(|e| &e.id)) {
                        resolves(&state, id).await;
                        n += 1;
                    }
                }
                resolves(&state, &format!("hotspot:{}:{}:{FIXTURE_NOW}", app.taxa[0].id(), c.cell)).await;
            }
        }
        println!("EVIDENCE-HOTSPOT-IDS {n}");
        assert!(n > 0);
    }

    /// `forecast:<lid>:<issued ms>`: the snapshot with its points, the thresholds known at that time,
    /// provenance, revisions, the API URL, the raw payload and the neighbouring issuances. Gridpoint
    /// runs resolve as `forecast:nws:<office>/<x>,<y>:<updateTime ms>`.
    #[tokio::test]
    async fn evidence_kind_forecast_snapshot() {
        let state = carp_fixtures().await;
        let (issued, iem_issued, grid_issued): (i64, i64, i64) = state
            .obs
            .read(|c| {
                c.query_row(
                    "select (select issued_at from forecast_snapshots where site = 'SMML1' and source = 'nwps-live'),
                            (select max(issued_at) from forecast_snapshots where site = 'SMML1' and source = 'iem-archive'
                               and issued_at not in (select issued_at from forecast_snapshots where site = 'SMML1' and source = 'nwps-live')),
                            (select issued_at from forecast_snapshots where site = 'SMML1' and source = 'nws-gridpoint')",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
            })
            .await
            .unwrap();
        let ev = resolves(&state, &format!("forecast:SMML1:{issued}")).await;
        assert_eq!(ev.kind, "forecast");
        let r = &ev.record;
        assert_eq!((r["site"].as_str(), r["product"].as_str(), r["provenance"].as_str()), (Some("SMML1"), Some("stageflow"), Some("nwps-live")), "{r}");
        assert_eq!(r["issuedAt"], iso(issued));
        assert!(r["points"].as_array().unwrap().len() > 10);
        // Gauge metadata landed with the replay (12:00Z), after this snapshot's capture time
        // (07:01Z): none were known then, the newest are given beside.
        assert_eq!(r["thresholds"], Value::Null, "{r}");
        assert_eq!(r["thresholdsKnownAt"], r["ingestedAt"]);
        assert_eq!(r["thresholdsNow"]["actionFt"], 35.0, "{r}");
        assert_eq!(r["location"]["id"], "atchafalaya-simmesport");
        assert_eq!(ev.source_url.as_deref(), Some(crate::ingest::poll::nwps::stageflow_url("SMML1").as_str()));
        assert!(ev.raw.as_ref().is_some_and(|raw| raw.get("forecast").is_some()), "the stageflow body");
        assert!(ev.links.iter().any(|l| l.relation == "fetch"), "{:?}", ev.links);
        assert_eq!(ev.feed.as_ref().map(|f| f.source.as_str()), Some("nwps"));
        assert_eq!(ev.source_page_url.as_deref(), Some("https://water.noaa.gov/gauges/SMML1"));
        // Lower-case lids resolve too.
        resolves(&state, &format!("forecast:smml1:{issued}")).await;
        // The IEM archive issuance: provenance and its neighbours.
        let ev = resolves(&state, &format!("forecast:SMML1:{iem_issued}")).await;
        assert_eq!(ev.record["provenance"], "iem-archive");
        assert!(ev.links.iter().any(|l| l.relation == "previous"), "{:?}", ev.links);
        for l in ev.links.iter().filter(|l| l.relation != "fetch") {
            resolves(&state, l.id.as_str()).await;
        }
        // Gridpoint run by grid.
        let ev = resolves(&state, &format!("forecast:nws:LCH/113,129:{grid_issued}")).await;
        assert_eq!((ev.record["product"].as_str(), ev.record["provenance"].as_str()), (Some("gridpoint"), Some("nws-gridpoint")));
        assert_eq!(ev.source_url.as_deref(), Some("https://api.weather.gov/gridpoints/LCH/113,129/forecast"));
        // Unknown issuance and grid: NOT_FOUND; malformed: BAD_ID.
        for id in [format!("forecast:SMML1:{}", issued + 1), "forecast:XXXX1:1".into(), "forecast:nws:LCH/1,1:1".into()] {
            assert!(matches!(evidence(&state, &id).await, Err(EvidenceError::NotFound(_))), "{id}");
        }
        for id in ["forecast:SMML1:abc", "forecast:123", "forecast::5"] {
            assert!(matches!(evidence(&state, id).await, Err(EvidenceError::BadId(_))), "{id}");
        }
    }

    /// `reading:` by NWPS lid (forecast-store observation) and by USGS site number (ext id), plus
    /// the `<source>:<ext id>` form.
    #[tokio::test]
    async fn evidence_kind_reading_by_ext_id_and_nwps_lid() {
        let state = carp_fixtures().await;
        let (obs_at, stage): (i64, f64) = state
            .obs
            .read(|c| c.query_row("select max(observed_at), (select stage_ft from forecast_observations where site = 'SMML1' order by observed_at desc limit 1) from forecast_observations where site = 'SMML1'", [], |r| Ok((r.get(0)?, r.get(1)?))))
            .await
            .unwrap();
        let ev = resolves(&state, &crate::review::reading_id("SMML1", obs_at)).await;
        assert_eq!((ev.record["site"].as_str(), ev.record["stageFt"].as_f64()), (Some("SMML1"), Some(stage)));
        assert_eq!(ev.record["provenance"], "nwps-live");
        assert_eq!(ev.feed.as_ref().map(|f| f.source.as_str()), Some("nwps"));
        assert!(ev.raw.is_some() && ev.source_url.is_some(), "the stageflow payload that delivered it");
        let (station, ext, param, at): (i64, String, String, i64) = state
            .obs
            .read(|c| {
                c.query_row(
                    "select s.id, s.ext_id, r.param, r.observed_at from readings r join stations s on s.id = r.station_id where s.source_id = 'usgs' order by r.observed_at desc limit 1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
            })
            .await
            .unwrap();
        let site = ext.split(':').next().unwrap().to_string();
        for id in [format!("reading:{station}:{param}:{at}:measured"), format!("reading:{site}:{param}:{at}:measured"), format!("reading:usgs:{ext}:{param}:{at}:measured")] {
            let ev = resolves(&state, &id).await;
            assert_eq!(ev.record["station"]["id"], station.to_string(), "{id}");
            assert!(ev.source_page_url.as_deref().is_some_and(|u| u.contains(&site)), "{id}");
        }
        for id in [format!("reading:SMML1:stage_m:{}:measured", obs_at + 1), format!("reading:SMML1:sst_c:{obs_at}:measured"), "reading:usgs:00000000:stage_m:1:measured".into()] {
            assert!(matches!(evidence(&state, &id).await, Err(EvidenceError::NotFound(_))), "{id}");
        }
    }

    /// `alert:<NWS id>`: the row and its per-site versions with first/last seen and the end.
    #[tokio::test]
    async fn evidence_kind_alert_by_nws_id_with_versions() {
        use crate::forecast::store::{record_alerts, AlertSeen};
        let state = test_state_for("carp");
        let t = 1_790_000_000_000;
        let seen = move |id: &str| AlertSeen {
            ext_id: id.into(),
            event: "Flood Warning".into(),
            severity: "Severe".into(),
            headline: Some("h".into()),
            onset: Some(t),
            expires: None,
            source: crate::forecast::Source::NwsGridpoint,
            payload_hash: "p1".into(),
        };
        let ext = "urn:oid:2.49.0.1.840.0.abc.001.1";
        state
            .obs
            .write(move |tx| {
                record_alerts(tx, "SMML1", t, &[seen(ext)])?;
                record_alerts(tx, "KRZL1", t + 60_000, &[seen(ext)])?;
                record_alerts(tx, "SMML1", t + 3_600_000, &[seen(ext)])?;
                record_alerts(tx, "SMML1", t + 7_200_000, &[])?;
                Ok(())
            })
            .await
            .unwrap();
        let ev = resolves(&state, &format!("alert:{ext}")).await;
        let r = &ev.record;
        assert_eq!((r["extId"].as_str(), r["event"].as_str()), (Some(ext), Some("Flood Warning")));
        assert_eq!((r["firstSeen"].clone(), r["lastSeen"].clone(), r["endedAt"].clone()), (json!(iso(t)), json!(iso(t + 3_600_000)), Value::Null), "KRZL1 is still open: {r}");
        let sites: Vec<&str> = r["sites"].as_array().unwrap().iter().map(|s| s["site"].as_str().unwrap()).collect();
        assert_eq!(sites, ["SMML1", "KRZL1"]);
        assert_eq!(r["sites"][0]["endedAt"], iso(t + 7_200_000));
        assert_eq!(ev.source_url.as_deref(), Some(format!("https://api.weather.gov/alerts/{ext}").as_str()));
        assert_eq!(ev.source_page_url.as_deref(), Some(format!("https://api.weather.gov/alerts/{ext}").as_str()));
        assert!(matches!(evidence(&state, "alert:urn:oid:nope").await, Err(EvidenceError::NotFound(_))));
    }

    /// `source:<feed>`: licence, credit/DOI, cadence, latency, rate limit, mode, homepage.
    #[tokio::test]
    async fn evidence_kind_source_facts() {
        let state = test_state_for("lionfish");
        let ev = resolves(&state, "source:crw").await;
        let r = &ev.record;
        assert_eq!((r["mode"].as_str(), r["nudge"].as_bool()), (Some("webhook"), Some(true)));
        assert_eq!(r["doi"], crate::source_pages::CRW_DOI);
        assert!(r["attribution"].as_str().unwrap().contains("NOAA Coral Reef Watch"));
        assert!(r["licence"].as_str().unwrap().contains("without restriction"));
        let info = crate::ingest::source::Source::info(&crate::ingest::poll::crw::Crw::new(state.app.clone()));
        assert_eq!(r["cadenceSeconds"], info.cadence.as_secs());
        assert!(r["rateLimit"].as_str().is_some() && r["expectedLatency"].as_str().is_some());
        assert_eq!(ev.source_url.as_deref(), Some("https://pae-paha.pacioos.hawaii.edu/erddap/griddap/dhw_5km.json"));
        assert!(ev.source_page_url.as_deref().is_some_and(|u| u.starts_with("https://")));
        assert!(matches!(evidence(&state, "source:nwps").await, Err(EvidenceError::NotFound(_))), "lionfish has no nwps");
        assert!(matches!(evidence(&state, "source:").await, Err(EvidenceError::BadId(_))));
    }

    /// `mission:`, `note:` and `message:` from the app's team board; a deleted note still
    /// resolves, flagged.
    #[tokio::test]
    async fn evidence_kind_team_board_records() {
        let state = test_state_for("carp");
        let op = |id: &str, hlc: &str, entity: &str, entity_id: &str, field: &str, value: Value| crate::crdt::OpIn {
            id: id.into(),
            hlc: hlc.into(),
            board_id: None,
            entity: entity.into(),
            entity_id: entity_id.into(),
            field: field.into(),
            value,
            node_id: "n1".into(),
        };
        let ops = vec![
            op("o1", "1000:0:n1", "mission", "m1", "title", json!("Gauge check at Simmesport")),
            op("o2", "1000:1:n1", "mission", "m1", "site", json!("SMML1")),
            op("o3", "1000:2:n1", "note", "n1", "text", json!("boat ramp closed")),
            op("o4", "1000:3:n1", "note", "n1", "_deleted", json!(true)),
            op("o5", "1000:4:n1", "message", "msg1", "body", json!("heading out")),
        ];
        state.team.write(move |tx| crate::crdt::apply_ops(tx, "carp:main", &ops, 1)).await.unwrap();
        let ev = resolves(&state, "mission:m1").await;
        assert_eq!(ev.record["fields"], json!({"title": "Gauge check at Simmesport", "site": "SMML1"}));
        assert_eq!((ev.record["board"].as_str(), ev.record["deleted"].as_bool(), ev.record["updatedHlc"].as_str()), (Some("carp:main"), Some(false), Some("1000:1:n1")));
        let ev = resolves(&state, "note:n1").await;
        assert_eq!((ev.record["deleted"].as_bool(), ev.record["fields"]["text"].as_str()), (Some(true), Some("boat ramp closed")));
        let ev = resolves(&state, "message:msg1").await;
        assert_eq!((ev.record["body"].as_str(), ev.record["from"].as_str()), (Some("heading out"), Some("n1")));
        for id in ["mission:nope", "note:m1", "message:nope"] {
            assert!(matches!(evidence(&state, id).await, Err(EvidenceError::NotFound(_))), "{id}");
        }
    }

    /// Unknown records of every new kind are a typed NOT_FOUND (GraphQL `extensions.code`);
    /// unknown kinds and malformed keys are BAD_ID.
    #[tokio::test]
    async fn evidence_kind_unknown_ids_are_typed_not_found() {
        let carp = test_state_for("carp");
        for id in ["forecast:SMML1:1", "review:XXXX1:0", "source:nope", "mission:x", "note:x", "message:x", "alert:urn:oid:x", "reading:SMML1:stage_m:1:measured"] {
            let err = evidence(&carp, id).await.unwrap_err();
            assert!(matches!(err, EvidenceError::NotFound(_)), "{id}: {err}");
            assert_eq!(err.extend().extensions.unwrap().get("code"), Some(&async_graphql::Value::from("NOT_FOUND")), "{id}");
        }
        for id in ["review:SMML1:x", "forecast:", "nope:1", "reading:SMML1:stage_m"] {
            assert!(matches!(evidence(&carp, id).await, Err(EvidenceError::BadId(_))), "{id}");
        }
        // A review on a species app is a bad id, not a missing one.
        assert!(matches!(evidence(&test_state_for("python"), "review:SMML1:0").await, Err(EvidenceError::BadId(_))));
        // `review:<lid>:<ms>` resolves even with nothing stored: the review says cannot_assess.
        let ev = resolves(&carp, "review:atchafalaya-simmesport:1790856000000").await;
        assert_eq!((ev.record["site"].as_str(), ev.record["status"].as_str()), (Some("SMML1"), Some("cannot_assess")));
    }
}
