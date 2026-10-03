//! Asian carp sightings for the carp map: silver, bighead, grass and black carp in the Mississippi River Basin,
//! merged from iNaturalist, GBIF (without its copy of iNaturalist's own records) and the USGS Nonindigenous
//! Aquatic Species database.
//!
//! The rows live in the carp app's `observations.db` (`carp_sightings`). A background task refreshes them from the
//! three public APIs every half hour (and `backfill --app carp` fills them once), so a visit reads SQLite through
//! `GET /v1/carp/sightings` and never waits on an upstream. The answer is built once, gzipped, and kept in memory
//! until the next refresh writes new rows.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::Context;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Serialize;
use serde_json::Value;

use crate::app::AppRegistry;
use crate::state::AppState;

/// The Mississippi River Basin's main corridor (Gulf to Minnesota, with the Missouri, Ohio and Illinois).
const WEST: f64 = -97.0;
const SOUTH: f64 = 28.9;
const EAST: f64 = -82.0;
const NORTH: f64 = 47.0;
/// The states NAS is asked for (it has no bbox).
const NAS_STATES: &str = "LA,MS,AR,TN,KY,MO,IL,IN,IA,WI,MN";
/// Days of sightings kept and served: the timeline's longest period (two years) and a day.
const KEEP_DAYS: i64 = 731;
const REFRESH: Duration = Duration::from_secs(30 * 60);
const INAT_DATASET: &str = "50c9509d-22c7-4a22-a47d-8c48425ef4a7";
const INAT_PAGE: usize = 200;
const GBIF_PAGE: usize = 300;
const NAS_PAGE: usize = 500;
/// Pages per source and per refresh: far more than the basin has had in two years, a stop against a runaway loop.
const MAX_PAGES: usize = 15;
const PAUSE: Duration = Duration::from_millis(1100);

struct Species {
    name: &'static str,
    sci: &'static str,
    inat: u32,
    gbif: u32,
    nas_genus: &'static str,
}

const SPECIES: [Species; 4] = [
    Species { name: "Silver carp", sci: "Hypophthalmichthys molitrix", inat: 128274, gbif: 2362473, nas_genus: "Hypophthalmichthys" },
    Species { name: "Bighead carp", sci: "Hypophthalmichthys nobilis", inat: 130886, gbif: 2362486, nas_genus: "Hypophthalmichthys" },
    Species { name: "Grass carp", sci: "Ctenopharyngodon idella", inat: 128500, gbif: 2362030, nas_genus: "Ctenopharyngodon" },
    Species { name: "Black carp", sci: "Mylopharyngodon piceus", inat: 128426, gbif: 2362110, nas_genus: "Mylopharyngodon" },
];

/// One sighting as the map reads it (`client/carp/sighting-type.ts`).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sighting {
    pub id: String,
    pub source: &'static str,
    pub species: &'static str,
    pub scientific_name: &'static str,
    pub lat: f64,
    pub lon: f64,
    pub date: Option<String>,
    pub url: String,
    pub photo: Option<String>,
}

fn by_sci(sci: &str) -> Option<&'static Species> {
    let sci = sci.to_lowercase();
    SPECIES.iter().find(|s| sci.starts_with(&s.sci.to_lowercase()))
}

fn day(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default().format("%Y-%m-%d").to_string()
}

async fn get_json(state: &AppState, url: &str) -> anyhow::Result<Value> {
    let res = state.http.get(url).header("accept", "application/json").timeout(Duration::from_secs(30)).send().await?;
    anyhow::ensure!(res.status().is_success(), "{}: HTTP {}", res.url().host_str().unwrap_or("upstream"), res.status());
    Ok(res.json().await?)
}

// ---- parsing (one page of each source) -------------------------------------------------------------------

pub fn parse_inat(body: &Value) -> Vec<Sighting> {
    let mut out = Vec::new();
    for o in body["results"].as_array().into_iter().flatten() {
        let Some(sp) = o["taxon"]["name"].as_str().and_then(by_sci) else { continue };
        let Some((lat, lon)) = o["location"].as_str().and_then(|l| l.split_once(',')).and_then(|(a, b)| Some((a.trim().parse::<f64>().ok()?, b.trim().parse::<f64>().ok()?))) else { continue };
        let (Some(id), Some(url)) = (o["id"].as_i64(), o["uri"].as_str()) else { continue };
        let photo = o["photos"][0]["url"].as_str().map(|u| u.replace("square", "medium"));
        out.push(Sighting { id: format!("inat:{id}"), source: "inat", species: sp.name, scientific_name: sp.sci, lat, lon, date: o["observed_on"].as_str().map(str::to_string), url: url.to_string(), photo });
    }
    out
}

pub fn parse_gbif(body: &Value) -> Vec<Sighting> {
    let mut out = Vec::new();
    for o in body["results"].as_array().into_iter().flatten() {
        // GBIF mirrors iNaturalist's research-grade records; those come from iNaturalist directly.
        if o["datasetKey"].as_str() == Some(INAT_DATASET) {
            continue;
        }
        let Some(sp) = o["species"].as_str().and_then(by_sci) else { continue };
        let (Some(lat), Some(lon), Some(key)) = (o["decimalLatitude"].as_f64(), o["decimalLongitude"].as_f64(), o["key"].as_i64()) else { continue };
        let date = o["eventDate"].as_str().map(|d| d.chars().take(10).collect::<String>());
        out.push(Sighting { id: format!("gbif:{key}"), source: "gbif", species: sp.name, scientific_name: sp.sci, lat, lon, date, url: format!("https://www.gbif.org/occurrence/{key}"), photo: None });
    }
    out
}

pub fn parse_nas(body: &Value) -> Vec<Sighting> {
    let mut out = Vec::new();
    for o in body["results"].as_array().into_iter().flatten() {
        let name = format!("{} {}", o["genus"].as_str().unwrap_or(""), o["species"].as_str().unwrap_or(""));
        let Some(sp) = by_sci(&name) else { continue };
        let (Some(lat), Some(lon), Some(key)) = (o["decimalLatitude"].as_f64(), o["decimalLongitude"].as_f64(), o["key"].as_i64()) else { continue };
        let date = o["year"].as_i64().map(|y| {
            let mut d = y.to_string();
            for part in [&o["month"], &o["day"]] {
                match part.as_i64() {
                    Some(v) => d.push_str(&format!("-{v:02}")),
                    None => break,
                }
            }
            d
        });
        out.push(Sighting { id: format!("nas:{key}"), source: "nas", species: sp.name, scientific_name: sp.sci, lat, lon, date, url: format!("https://nas.er.usgs.gov/queries/SpecimenViewer.aspx?SpecimenID={key}"), photo: None });
    }
    out
}

// ---- fetching (paged) ------------------------------------------------------------------------------------

async fn fetch_inat(state: &AppState, from: &str) -> anyhow::Result<Vec<Sighting>> {
    let taxa = SPECIES.iter().map(|s| s.inat.to_string()).collect::<Vec<_>>().join(",");
    let mut out = Vec::new();
    for page in 1..=MAX_PAGES {
        let url = format!(
            "https://api.inaturalist.org/v1/observations?taxon_id={taxa}&swlat={SOUTH}&swlng={WEST}&nelat={NORTH}&nelng={EAST}&d1={from}&per_page={INAT_PAGE}&page={page}&order_by=observed_on&order=desc&geoprivacy=open&quality_grade=research,needs_id"
        );
        let body = get_json(state, &url).await?;
        let n = body["results"].as_array().map_or(0, Vec::len);
        out.extend(parse_inat(&body));
        if n < INAT_PAGE {
            break;
        }
        tokio::time::sleep(PAUSE).await;
    }
    Ok(out)
}

async fn fetch_gbif(state: &AppState, from_year: i32, to_year: i32) -> anyhow::Result<Vec<Sighting>> {
    let keys = SPECIES.iter().map(|s| format!("taxonKey={}", s.gbif)).collect::<Vec<_>>().join("&");
    let mut out = Vec::new();
    for page in 0..MAX_PAGES {
        let url = format!(
            "https://api.gbif.org/v1/occurrence/search?{keys}&hasCoordinate=true&decimalLatitude={SOUTH},{NORTH}&decimalLongitude={WEST},{EAST}&year={from_year},{to_year}&limit={GBIF_PAGE}&offset={}",
            page * GBIF_PAGE
        );
        let body = get_json(state, &url).await?;
        out.extend(parse_gbif(&body));
        if body["endOfRecords"].as_bool().unwrap_or(true) {
            break;
        }
        tokio::time::sleep(PAUSE).await;
    }
    Ok(out)
}

async fn fetch_nas(state: &AppState, from_year: i32, to_year: i32) -> anyhow::Result<Vec<Sighting>> {
    let mut genera: Vec<&str> = SPECIES.iter().map(|s| s.nas_genus).collect();
    genera.dedup();
    let pages = futures_util::future::join_all(genera.into_iter().map(|genus| async move {
        let mut out = Vec::new();
        for page in 0..MAX_PAGES {
            let url = format!(
                "https://nas.er.usgs.gov/api/v2/occurrence/search?state={NAS_STATES}&genus={genus}&year={from_year},{to_year}&limit={NAS_PAGE}&offset={}",
                page * NAS_PAGE
            );
            let body = get_json(state, &url).await?;
            let n = body["results"].as_array().map_or(0, Vec::len);
            out.extend(parse_nas(&body));
            if n < NAS_PAGE {
                break;
            }
            tokio::time::sleep(PAUSE).await;
        }
        anyhow::Ok(out)
    }))
    .await;
    let mut out = Vec::new();
    for p in pages {
        out.extend(p?);
    }
    Ok(out)
}

/// Fetch the last two years from the three APIs (each on its own, so one being down loses only its rows) and
/// upsert them. Returns how many rows the sources gave; an error only when every source failed.
pub async fn refresh(state: &AppState) -> anyhow::Result<usize> {
    let now = state.now_ms();
    let from = day(now - KEEP_DAYS * 86_400_000);
    let to_year: i32 = day(now)[..4].parse().context("year")?;
    let from_year: i32 = from[..4].parse().context("year")?;
    let (a, b, c) = tokio::join!(fetch_inat(state, &from), fetch_gbif(state, from_year, to_year), fetch_nas(state, from_year, to_year));
    let mut rows: HashMap<String, Sighting> = HashMap::new();
    let mut failed = Vec::new();
    for (name, result) in [("inat", a), ("gbif", b), ("nas", c)] {
        match result {
            Ok(list) => rows.extend(list.into_iter().map(|s| (s.id.clone(), s))),
            Err(e) => {
                tracing::warn!("carp sightings: {name} unavailable: {e:#}");
                failed.push(name);
            }
        }
    }
    anyhow::ensure!(failed.len() < 3, "carp sightings: every source failed ({})", failed.join(", "));
    let n = rows.len();
    store(state, rows.into_values().collect(), now).await?;
    Ok(n)
}

async fn store(state: &AppState, rows: Vec<Sighting>, now: i64) -> anyhow::Result<()> {
    state
        .obs
        .write(move |tx| {
            let mut st = tx.prepare(
                "insert into carp_sightings (id, source, species, scientific_name, lat, lon, date, url, photo, fetched_at)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 on conflict (id) do update set species = excluded.species, scientific_name = excluded.scientific_name, lat = excluded.lat,
                   lon = excluded.lon, date = excluded.date, url = excluded.url, photo = excluded.photo, fetched_at = excluded.fetched_at",
            )?;
            for s in &rows {
                st.execute(rusqlite::params![s.id, s.source, s.species, s.scientific_name, s.lat, s.lon, s.date, s.url, s.photo, now])?;
            }
            Ok(())
        })
        .await?;
    *cache().lock().expect("carp cache") = None;
    Ok(())
}

/// Refresh now and then every half hour, in the carp app only.
pub fn spawn(state: AppState) {
    if state.app.id() != "carp" || !state.config.sources_enabled {
        return;
    }
    tokio::spawn(async move {
        loop {
            let started = std::time::Instant::now();
            match refresh(&state).await {
                Ok(n) => tracing::info!("carp sightings refreshed: {n} records in {:?}", started.elapsed()),
                Err(e) => tracing::warn!("carp sightings refresh failed: {e:#}"),
            }
            tokio::time::sleep(REFRESH).await;
        }
    });
}

// ---- the route -------------------------------------------------------------------------------------------

type Cache = Mutex<Option<Arc<Vec<u8>>>>;

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

pub fn routes() -> Router<AppRegistry> {
    Router::new().route("/sightings", get(sightings))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Answer {
    fetched_at: String,
    sightings: Vec<Sighting>,
    sources: HashMap<String, i64>,
}

async fn load(state: &AppState) -> anyhow::Result<Vec<u8>> {
    let from = day(state.now_ms() - KEEP_DAYS * 86_400_000);
    let (rows, fetched) = state
        .obs
        .read(move |c| {
            let mut st = c.prepare(
                "select id, source, species, scientific_name, lat, lon, date, url, photo from carp_sightings
                 where date is not null and date >= ?1 order by date desc, id",
            )?;
            let rows = st
                .query_map([from], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, f64>(4)?, r.get::<_, f64>(5)?, r.get::<_, Option<String>>(6)?, r.get::<_, String>(7)?, r.get::<_, Option<String>>(8)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let fetched: Option<i64> = c.query_row("select max(fetched_at) from carp_sightings", [], |r| r.get(0))?;
            Ok((rows, fetched))
        })
        .await?;
    let mut sources: HashMap<String, i64> = HashMap::new();
    let mut sightings = Vec::with_capacity(rows.len());
    for (id, source, species, sci, lat, lon, date, url, photo) in rows {
        let source = ["inat", "gbif", "nas"].into_iter().find(|s| *s == source);
        let (Some(source), Some(sp)) = (source, SPECIES.iter().find(|s| s.name == species && s.sci == sci)) else { continue };
        *sources.entry(source.to_string()).or_default() += 1;
        sightings.push(Sighting { id, source, species: sp.name, scientific_name: sp.sci, lat, lon, date, url, photo });
    }
    let fetched_at = chrono::DateTime::from_timestamp_millis(fetched.unwrap_or(0)).unwrap_or_default().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let json = serde_json::to_vec(&Answer { fetched_at, sightings, sources })?;
    tokio::task::spawn_blocking(move || crate::frames::gzip(&json)).await.map_err(Into::into)
}

async fn sightings(state: AppState) -> Response {
    if state.app.id() != "carp" {
        return crate::app::json_error(StatusCode::NOT_FOUND, "no_sightings", serde_json::json!({ "app": state.app.id(), "message": "only the carp app serves this list" }));
    }
    let cached = cache().lock().expect("carp cache").clone();
    let body = match cached {
        Some(b) => b,
        None => match load(&state).await {
            Ok(b) => {
                let b = Arc::new(b);
                *cache().lock().expect("carp cache") = Some(b.clone());
                b
            }
            Err(e) => {
                tracing::warn!("carp sightings read failed: {e:#}");
                return (StatusCode::INTERNAL_SERVER_ERROR, "sightings unavailable").into_response();
            }
        },
    };
    (
        [(header::CONTENT_TYPE, "application/json"), (header::CONTENT_ENCODING, "gzip"), (header::CACHE_CONTROL, "public, max-age=120")],
        body.as_ref().clone(),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use serde_json::json;
    use std::io::Read;
    use tower::ServiceExt;

    use super::*;
    use crate::app::test_support::{router_for, test_state_for};

    #[test]
    fn inat_page_keeps_carp_with_a_point() {
        let body = json!({ "results": [
            { "id": 1, "observed_on": "2026-05-01", "location": "38.5,-90.2", "uri": "https://www.inaturalist.org/observations/1", "taxon": { "name": "Hypophthalmichthys molitrix" }, "photos": [{ "url": "https://x/square.jpg" }] },
            { "id": 2, "observed_on": "2026-05-02", "location": "38.5,-90.2", "uri": "u", "taxon": { "name": "Esox lucius" } },
            { "id": 3, "uri": "u", "taxon": { "name": "Mylopharyngodon piceus" } }
        ] });
        let rows = parse_inat(&body);
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].id.as_str(), rows[0].species, rows[0].photo.as_deref()), ("inat:1", "Silver carp", Some("https://x/medium.jpg")));
    }

    #[test]
    fn gbif_page_drops_inaturalist_copies() {
        let body = json!({ "results": [
            { "key": 7, "datasetKey": INAT_DATASET, "species": "Ctenopharyngodon idella", "eventDate": "2026-04-01T10:00:00", "decimalLatitude": 30.0, "decimalLongitude": -91.0 },
            { "key": 8, "datasetKey": "other", "species": "Ctenopharyngodon idella", "eventDate": "2026-04-01T10:00:00", "decimalLatitude": 30.0, "decimalLongitude": -91.0 }
        ] });
        let rows = parse_gbif(&body);
        assert_eq!(rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["gbif:8"]);
        assert_eq!(rows[0].date.as_deref(), Some("2026-04-01"));
    }

    #[test]
    fn nas_dates_are_padded_and_partial_dates_stop_at_the_known_part() {
        let body = json!({ "results": [
            { "key": 1, "genus": "Mylopharyngodon", "species": "piceus", "decimalLatitude": 36.0, "decimalLongitude": -89.0, "year": 2025, "month": 3, "day": 9 },
            { "key": 2, "genus": "Mylopharyngodon", "species": "piceus", "decimalLatitude": 36.0, "decimalLongitude": -89.0, "year": 2025, "month": null, "day": 9 }
        ] });
        let dates: Vec<_> = parse_nas(&body).into_iter().map(|r| r.date.unwrap()).collect();
        assert_eq!(dates, ["2025-03-09", "2025"]);
    }

    /// Rows written by a refresh come back from the route, newest first, with the per-source counts.
    #[tokio::test]
    async fn route_serves_stored_rows() {
        let state = test_state_for("carp");
        let now = state.now_ms();
        let recent = day(now - 5 * 86_400_000);
        let old = day(now - 900 * 86_400_000);
        let rows = vec![
            Sighting { id: "inat:1".into(), source: "inat", species: "Silver carp", scientific_name: "Hypophthalmichthys molitrix", lat: 38.0, lon: -90.0, date: Some(recent.clone()), url: "u".into(), photo: None },
            Sighting { id: "nas:2".into(), source: "nas", species: "Black carp", scientific_name: "Mylopharyngodon piceus", lat: 36.0, lon: -89.0, date: Some(old), url: "u".into(), photo: None },
        ];
        store(&state, rows, now).await.unwrap();
        let res = router_for(&state).oneshot(Request::get("/v1/carp/sightings").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let mut json = String::new();
        flate2::read::GzDecoder::new(&bytes[..]).read_to_string(&mut json).unwrap();
        let body: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(body["sightings"].as_array().unwrap().len(), 1, "{body}");
        assert_eq!(body["sightings"][0]["scientificName"], "Hypophthalmichthys molitrix");
        assert_eq!(body["sightings"][0]["date"], recent);
        assert_eq!(body["sources"], json!({ "inat": 1 }));

        let other = test_state_for("python");
        let res = router_for(&other).oneshot(Request::get("/v1/python/sightings").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }
}
