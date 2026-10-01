//! `evidence(id)` (PLAN.md C14): everything behind one cited record.
//!
//! Ids are `<kind>:<key>`:
//!
//! | kind | key | record |
//! |---|---|---|
//! | `sighting` | `sightings.id` | the row, its taxon and its revisions |
//! | `reading` | `<station_id>:<param>:<observed_at ms>:<origin>` | the row and its station |
//! | `alert` | `alerts.id` | the row, `areaGeojson` parsed |
//! | `fetch` | `fetch_runs.id` | the run |
//! | `hotspot` | `<species>:<cell id>:<frame ms>` (cell id `<col>:<row>`, or `<region>:<col>:<row>` in a multi-region app) | the explain terms |
//! | `backtest` | `<species>:<days>` | the backtest summary with `perDay` |
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
        _ => {
            return Err(bad_id(id, "kind sighting, reading, alert, fetch, hotspot or backtest"));
        }
    };
    assemble(state, id, kind, found).await
}

async fn assemble(state: &AppState, id: &str, kind: &str, found: Found) -> Res<Evidence> {
    let Found { record, source, raw, ingest_lag_ms, links, page_url } = found;
    let feed = match &source {
        Some(source) => crate::feed_state::compute(&state.obs, chrono::Utc::now().timestamp_millis())
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
        source_url: raw.as_ref().map(|r| r.source_url.clone()),
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
                            s.conflict, s.ingested_at, t.inat_taxon_id, t.iconic_group, t.summary_plain, t.photo_url, t.focus,
                            t.ancestor_ids, s.submitted_at
                     from sightings s join taxa t on t.id = s.taxon_id where s.id = ?1",
                )?
                .query_row([sid], |r| {
                    let taxon_id: i64 = r.get(3)?;
                    let inat_id: Option<i64> = r.get(16)?;
                    let ancestry: Option<Vec<i64>> = r.get::<_, Option<String>>(21)?.and_then(|t| serde_json::from_str(&t).ok());
                    Ok((
                        json!({
                            "id": r.get::<_, i64>(0)?.to_string(),
                            "source": r.get::<_, String>(1)?,
                            "extId": r.get::<_, String>(2)?,
                            // Taxon info (T44) rides in the record so the card needs no second request.
                            "taxon": {"id": taxon_id.to_string(), "scientificName": r.get::<_, String>(4)?,
                                      "commonName": r.get::<_, String>(5)?, "focus": r.get::<_, bool>(20)?,
                                      "inatTaxonId": inat_id.map(|n| n.to_string()),
                                      "iconicGroup": r.get::<_, Option<String>>(17)?,
                                      "summary": r.get::<_, Option<String>>(18)?,
                                      "photoUrl": r.get::<_, Option<String>>(19)?.map(|_| format!("/v1/media/taxon/{taxon_id}")),
                                      "pageUrl": inat_id.map(crate::taxon_info::page_url),
                                      "ancestorIds": ancestry},
                            "lat": r.get::<_, f64>(6)?,
                            "lon": r.get::<_, f64>(7)?,
                            "accuracyM": r.get::<_, Option<f64>>(8)?,
                            "observedAt": iso(r.get(9)?),
                            // When the record reached its source (iNat upload); can lag years (L4).
                            "submittedAt": iso_opt(r.get(22)?),
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
    const SHAPE: &str = "reading:<station_id>:<param>:<observed_at ms>:<origin>";
    let parts: Vec<&str> = key.split(':').collect();
    let [station, param, at, origin] = parts.as_slice() else { return Err(bad_id(id, SHAPE)) };
    let station: i64 = station.parse().map_err(|_| bad_id(id, SHAPE))?;
    let at: i64 = at.parse().map_err(|_| bad_id(id, SHAPE))?;
    let (param, origin) = (param.to_string(), origin.to_string());
    let app = state.app.clone();
    let found = state
        .obs
        .read(move |c| {
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
            if let (Some(k), Some(v), "ok") = (PhysKind::of(&param, &origin), value, flag.as_str()) {
                links.extend(reading_conflicts(c, &app, k, &ReadingAt { lat, lon, at, value: v })?);
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
            }))
        })
        .await?;
    found.ok_or_else(|| not_found(id))
}

async fn alert(state: &AppState, id: &str, key: &str) -> Res<Found> {
    let aid: i64 = key.parse().map_err(|_| bad_id(id, "alert:<integer id>"))?;
    let found = state
        .obs
        .read(move |c| {
            let row = c
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
                .optional()?;
            let Some((source, ext_id, event, severity, headline, area, onset, expires, raw_id)) = row else {
                return Ok(None);
            };
            let record = json!({
                "id": aid.to_string(),
                "source": source,
                "extId": ext_id,
                "event": event,
                "severity": severity,
                "headline": headline,
                "areaGeojson": area.and_then(|a| serde_json::from_str::<Value>(&a).ok()),
                "onset": iso_opt(onset),
                "expires": iso_opt(expires),
            });
            let links: Vec<EvidenceLink> = fetch_link(c, &source, raw_id)?.into_iter().collect();
            let raw = raw_ref(c, raw_id)?;
            Ok(Some(Found {
                record,
                ingest_lag_ms: raw.as_ref().zip(onset).map(|(r, onset)| r.fetched_at - onset),
                page_url: source_page_url(&source, &ext_id),
                raw,
                source: Some(source),
                links,
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
    let ex = hotspot::score::explain(&state.obs, app, &cell, sp, at).await?;
    let (lon, lat) = region.grid.center(idx);
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
    Ok(Found { record, source: None, raw: None, ingest_lag_ms: None, links: Vec::new(), page_url: None })
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
    let b = hotspot::backtest::backtest(&state.obs, app, sp, days).await?;
    let record = json!({
        "species": sp.id(),
        "days": b.days,
        "hitRate": b.hit_rate,
        "baseline": b.baseline,
        "perDay": b.per_day.iter().map(|d| json!({"day": iso(d.day), "sightings": d.sightings, "hits": d.hits})).collect::<Vec<_>>(),
    });
    Ok(Found { record, source: None, raw: None, ingest_lag_ms: None, links: Vec::new(), page_url: None })
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
        let inat_payload = br#"{"total_results":1,"results":[{"id":398479651,"taxon":{"name":"Ctenosaura similis"}}]}"#;
        let (raw, run) = archive_raw(&state, "inat", "raw/inat/2026/09/21/a.json.gz", inat_payload, OBSERVED + 60_000).await;
        let inat = insert_sighting(&state, "inat", "398479651", 3, Some(raw), None).await;
        let gbif = insert_sighting(&state, "gbif", "50c9509d:398479651:4411", 3, None, Some(inat)).await;
        state
            .obs
            .write(move |tx| {
                tx.execute(
                    "insert into sighting_revisions (sighting_id, changed_at, field, old, new)
                     values (?1, ?2, 'taxon', 'Iguana iguana', 'Ctenosaura similis')",
                    params![inat, OBSERVED + 3_600_000],
                )?;
                tx.execute("update sightings set conflict = 1 where id = ?1", [inat])
            })
            .await
            .unwrap();

        let ev = evidence(&state, &format!("sighting:{inat}")).await.unwrap();
        assert_eq!(ev.kind, "sighting");
        assert_eq!(ev.record["extId"], "398479651");
        assert_eq!(ev.record["conflict"], true);
        assert_eq!(
            ev.record["revisions"],
            json!([{"changedAt": iso(OBSERVED + 3_600_000), "field": "taxon", "old": "Iguana iguana", "new": "Ctenosaura similis"}])
        );
        // Raw payload came back from the archive, gunzipped and parsed.
        assert_eq!(ev.raw.as_ref().unwrap()["results"][0]["id"], 398479651);
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
        let tegu = insert_sighting(&state, "nas", "nas-1", 2, None, Some(inat)).await;
        let ev = evidence(&state, &format!("sighting:{inat}")).await.unwrap();
        let rels: Vec<(String, &str)> = ev.links.iter().map(|l| (l.id.to_string(), l.relation.as_str())).collect();
        assert!(rels.contains(&(format!("sighting:{tegu}"), "duplicates")), "{rels:?}");
        assert!(rels.contains(&(format!("sighting:{tegu}"), "conflict")), "{rels:?}");
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
        let inat = insert_sighting(&state, "inat", "335508189", 4, Some(raw), None).await;
        let gbif = insert_sighting(&state, "gbif", "50c9509d-22c7-4a22-a47d-8c48425ef4a7:335508189:6130701656", 4, None, Some(inat)).await;
        let nas = insert_sighting(&state, "nas", "1936189", 1, None, None).await;
        let ev = evidence(&state, &format!("sighting:{inat}")).await.unwrap();
        assert_eq!(page(&ev).as_deref(), Some("https://www.inaturalist.org/observations/335508189"));
        // The API URL stays in sourceUrl.
        assert_eq!(ev.source_url.as_deref(), Some("https://api.example.test/inat"));
        let ev = evidence(&state, &format!("sighting:{gbif}")).await.unwrap();
        assert_eq!(page(&ev).as_deref(), Some("https://www.gbif.org/occurrence/6130701656"));
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
        let today = hotspot::backtest::floor_day(chrono::Utc::now().timestamp_millis());
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
}
