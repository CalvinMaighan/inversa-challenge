//! One test per query resolver against a seeded memory DB (`resolver_*`), plus `applyOps`
//! validation and the `ops` subscription end to end over a real socket (`subscription_ops*`).

use std::time::Duration;

use axum::http::StatusCode;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use rusqlite::params;
use serde_json::{json, Value};

use crate::app::test_support::{router_for, test_state};
use crate::hotspot::score::testkit::{insert_readings, insert_sighting, insert_station, ms, seed_sources, DAY, HOUR};
use crate::hotspot::Grid;
use crate::state::AppState;

async fn seeded() -> AppState {
    let state = test_state();
    seed_sources(&state.obs).await;
    state
}

/// POST to `state`'s own app endpoint (`/v1/<app>/graphql`).
async fn gql(state: &AppState, query: &str, variables: Value) -> Value {
    use axum::body::Body;
    use axum::http::{header, Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let res = router_for(state)
        .oneshot(
            Request::post(format!("/v1/{}/graphql", state.app.id()))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({"query": query, "variables": variables}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("non-JSON body ({e}): {bytes:?}"));
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

/// The python app's whole region as a GraphQL `BBox` literal.
fn region(state: &AppState) -> String {
    let b = state.app.hull();
    format!("{{west: {}, south: {}, east: {}, north: {}}}", b.west, b.south, b.east, b.north)
}

fn python_grid(state: &AppState) -> Grid {
    state.app.regions[0].grid
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn error_code(body: &Value) -> &str {
    body["errors"][0]["extensions"]["code"].as_str().unwrap_or_default()
}

fn error_message(body: &Value) -> &str {
    body["errors"][0]["message"].as_str().unwrap_or_default()
}

#[tokio::test]
async fn resolver_feeds() {
    let state = seeded().await;
    let now = crate::state::now_ms();
    let run = state
        .obs
        .write(move |tx| {
            tx.execute(
                "insert into fetch_runs (source_id, fetched_at, received_at, status) values ('inat', ?1, ?1, 'ok')",
                [now - 60_000],
            )?;
            Ok(tx.last_insert_rowid())
        })
        .await
        .unwrap();
    let body = gql(&state, "{ feeds { source mode state lastFetchAt lastFetchRunId } }", json!({})).await;
    let feeds = body["data"]["feeds"].as_array().unwrap();
    assert_eq!(feeds.len(), 8, "every seeded source: {body}");
    let inat = feeds.iter().find(|f| f["source"] == "inat").unwrap();
    assert_eq!(inat["lastFetchRunId"], run.to_string());
    assert_eq!(inat["lastFetchAt"], iso(now - 60_000));
    let goes = feeds.iter().find(|f| f["source"] == "goes19").unwrap();
    assert_eq!((goes["mode"].as_str(), goes["state"].as_str(), &goes["lastFetchRunId"]), (Some("PUSH"), Some("DOWN"), &Value::Null));
}

#[tokio::test]
async fn resolver_sightings() {
    let state = seeded().await;
    let t = ms(2026, 9, 1, 12);
    let a = insert_sighting(&state.obs, "inat", 1, 25.5, -80.9, t, "research", None).await;
    let b = insert_sighting(&state.obs, "gbif", 1, 25.5, -80.9, t + HOUR, "casual", Some(a)).await;
    // A python an ID flip moved to P. molurus (another taxon; stored because the python was).
    let molurus: i64 = state
        .obs
        .write(|tx| {
            tx.execute("insert into taxa (scientific_name, common_name, focus) values ('Python molurus', 'Indian python', 0)", [])?;
            Ok(tx.last_insert_rowid())
        })
        .await
        .unwrap();
    insert_sighting(&state.obs, "inat", molurus, 25.6, -80.8, t + 2 * HOUR, "needs_id", None).await;
    insert_sighting(&state.obs, "inat", 1, 26.9, -82.9, t, "research", None).await; // outside the bbox
    insert_sighting(&state.obs, "inat", 1, 25.5, -80.9, t - 3 * DAY, "research", None).await; // before the window
    let photo = "https://static.inaturalist.org/photos/1/medium.jpg";
    state.obs.write(move |tx| tx.execute("update sightings set photo_url = ?1, conflict = 1 where id = ?2", params![photo, a])).await.unwrap();

    let q = "query($from: Time!, $to: Time!, $taxa: [ID!], $quality: [Quality!]) {
        sightings(bbox: {west: -81.2, south: 25.2, east: -80.5, north: 25.8}, from: $from, to: $to, taxa: $taxa, quality: $quality) {
          id source extId taxon { id scientificName commonName focus } lat lon accuracyM observedAt quality photoUrl canonicalId conflict } }";
    let vars = |taxa: Value, quality: Value| json!({"from": iso(t - DAY), "to": iso(t + DAY), "taxa": taxa, "quality": quality});

    let body = gql(&state, q, vars(Value::Null, Value::Null)).await;
    let rows = body["data"]["sightings"].as_array().unwrap();
    assert_eq!(rows.len(), 3, "{body}");
    // Newest first.
    assert_eq!(rows[0]["taxon"]["commonName"], "Indian python");
    assert_eq!(rows[1]["id"], b.to_string());
    assert_eq!(rows[1]["canonicalId"], a.to_string());
    assert_eq!(rows[1]["quality"], "CASUAL");
    assert_eq!(rows[2]["photoUrl"], photo);
    assert_eq!(rows[2]["conflict"], true);
    assert_eq!(rows[2]["taxon"], json!({"id": "1", "scientificName": "Python bivittatus", "commonName": "Burmese python", "focus": true}));
    assert_eq!(rows[2]["observedAt"], iso(t));

    // Filters: taxa by name or id, quality.
    let body = gql(&state, q, vars(json!(["python"]), Value::Null)).await;
    assert_eq!(body["data"]["sightings"].as_array().unwrap().len(), 2);
    let body = gql(&state, q, vars(json!(["1", molurus.to_string()]), json!(["RESEARCH", "NEEDS_ID"]))).await;
    assert_eq!(body["data"]["sightings"].as_array().unwrap().len(), 2);
    let body = gql(&state, q, vars(json!(["otter"]), Value::Null)).await;
    assert!(error_message(&body).contains("unknown taxon"), "{body}");

    // Validation: bbox outside the region, inverted window, window over 31 days.
    let body = gql(
        &state,
        "{ sightings(bbox: {west: -90, south: 25, east: -80, north: 27}, from: \"2026-09-01T00:00:00Z\", to: \"2026-09-02T00:00:00Z\") { id } }",
        json!({}),
    )
    .await;
    assert!(error_message(&body).contains("inside the region"), "{body}");
    let body = gql(&state, q, json!({"from": iso(t), "to": iso(t - 1)})).await;
    assert!(error_message(&body).contains("after"), "{body}");
    let body = gql(&state, q, json!({"from": iso(t), "to": iso(t + 32 * DAY)})).await;
    assert!(error_message(&body).contains("31-day"), "{body}");
}

#[tokio::test]
async fn resolver_sightings_truncates_with_a_note() {
    let state = seeded().await;
    let t = ms(2026, 9, 1, 0);
    let n = super::query::MAX_SIGHTINGS as i64 + 7;
    state
        .obs
        .write(move |tx| {
            let mut st = tx.prepare(
                "insert into sightings (source_id, ext_id, taxon_id, lat, lon, observed_at, quality, ingested_at)
                 values ('inat', ?1, 1, 25.5, -80.9, ?2, 'research', ?2)",
            )?;
            for i in 0..n {
                st.execute(params![i.to_string(), t + i * 1000])?;
            }
            Ok(())
        })
        .await
        .unwrap();
    let body = gql(
        &state,
        &format!("{{ sightings(bbox: {}, from: \"{}\", to: \"{}\") {{ extId }} }}", region(&state), iso(t), iso(t + DAY)),
        json!({}),
    )
    .await;
    let rows = body["data"]["sightings"].as_array().unwrap();
    assert_eq!(rows.len(), super::query::MAX_SIGHTINGS);
    assert_eq!(rows[0]["extId"], (n - 1).to_string(), "newest kept");
    assert_eq!(error_code(&body), "TRUNCATED");
    assert_eq!(body["errors"][0]["path"], json!(["sightings"]));
}

#[tokio::test]
async fn resolver_readings() {
    let state = seeded().await;
    let t = ms(2026, 9, 1, 12);
    let buoy = insert_station(&state.obs, "ndbc", "VAKF1", 24.63, -81.11, "buoy").await;
    let gage = insert_station(&state.obs, "usgs", "0228", 25.7, -80.6, "gage").await;
    let far = insert_station(&state.obs, "usgs", "far", 27.4, -83.1, "gage").await;
    insert_readings(
        &state.obs,
        vec![(buoy, "sst_c", Some(29.5), t), (buoy, "wave_m", None, t + HOUR), (gage, "stage_m", Some(1.2), t), (far, "stage_m", Some(0.4), t)],
    )
    .await;
    let q = "query($params: [Param!]) { readings(bbox: {west: -82, south: 24.5, east: -80, north: 26}, from: \"2026-09-01T00:00:00Z\",
             to: \"2026-09-02T00:00:00Z\", params: $params) { station { id source name lat lon kind } param value flag observedAt origin } }";
    let body = gql(&state, q, json!({"params": null})).await;
    let rows = body["data"]["readings"].as_array().unwrap();
    assert_eq!(rows.len(), 3, "{body}");
    assert_eq!(rows[0]["param"], "WAVE_M");
    assert_eq!(rows[0]["value"], Value::Null);
    assert_eq!(rows[0]["flag"], "MISSING");
    assert_eq!(rows[0]["origin"], "MEASURED");
    assert_eq!(rows[0]["station"], json!({"id": buoy.to_string(), "source": "ndbc", "name": "VAKF1", "lat": 24.63, "lon": -81.11, "kind": "buoy"}));
    let body = gql(&state, q, json!({"params": ["STAGE_M"]})).await;
    let rows = body["data"]["readings"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0]["value"].as_f64(), rows[0]["station"]["kind"].as_str()), (Some(1.2), Some("gage")));
}

#[tokio::test]
async fn resolver_alerts() {
    let state = seeded().await;
    let t = ms(2026, 9, 1, 12);
    state
        .obs
        .write(move |tx| {
            let mut st = tx.prepare(
                "insert into alerts (source_id, ext_id, event, severity, headline, area_geojson, onset, expires)
                 values ('nws', ?1, ?2, 'Moderate', ?1, ?3, ?4, ?5)",
            )?;
            let inside = r#"{"type":"Polygon","coordinates":[[[-80.9,25.4],[-80.7,25.4],[-80.7,25.6],[-80.9,25.4]]]}"#;
            let outside = r#"{"type":"Polygon","coordinates":[[[-83.0,27.0],[-82.8,27.0],[-82.8,27.2],[-83.0,27.0]]]}"#;
            st.execute(params!["in", "Flood Warning", inside, t - HOUR, t + HOUR])?;
            st.execute(params!["out", "Rip Current Statement", outside, t - HOUR, t + HOUR])?;
            st.execute(params!["zone", "Heat Advisory", Option::<String>::None, t - HOUR, Option::<i64>::None])?;
            st.execute(params!["expired", "Flood Watch", inside, t - 3 * HOUR, t - 2 * HOUR])?;
            st.execute(params!["future", "Freeze Warning", inside, t + 2 * HOUR, t + 5 * HOUR])?;
            Ok(())
        })
        .await
        .unwrap();
    let body = gql(
        &state,
        &format!(
            "{{ alerts(bbox: {{west: -81.2, south: 25.2, east: -80.5, north: 25.8}}, at: \"{}\") {{ id event severity headline areaGeojson onset expires }} }}",
            iso(t)
        ),
        json!({}),
    )
    .await;
    let events: Vec<&str> = body["data"]["alerts"].as_array().unwrap().iter().map(|a| a["event"].as_str().unwrap()).collect();
    assert_eq!(events.len(), 2, "{body}");
    assert!(events.contains(&"Flood Warning") && events.contains(&"Heat Advisory"), "{events:?}");
    let flood = body["data"]["alerts"].as_array().unwrap().iter().find(|a| a["event"] == "Flood Warning").unwrap();
    assert_eq!(flood["areaGeojson"]["type"], "Polygon");
    assert_eq!(flood["expires"], iso(t + HOUR));
}

#[tokio::test]
async fn resolver_frames() {
    let state = seeded().await;
    let t = ms(2026, 9, 1, 12);
    insert_sighting(&state.obs, "inat", 1, 25.5, -80.9, t - HOUR, "research", None).await;
    let body = gql(
        &state,
        &format!("{{ frames(from: \"{}\", to: \"{}\", stepMinutes: 60) {{ from to stepMinutes frameCount data }} }}", iso(t), iso(t + 3 * HOUR)),
        json!({}),
    )
    .await;
    let chunk = &body["data"]["frames"];
    assert_eq!(chunk["frameCount"], 4, "{body}");
    assert_eq!(chunk["stepMinutes"], 60);
    let bytes = base64::engine::general_purpose::STANDARD.decode(chunk["data"].as_str().unwrap()).unwrap();
    assert!(bytes.starts_with(b"EVF"), "EVF magic");
    assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 4, "header frame count");

    // 25 frames: refused, pointing at the REST endpoint.
    let body = gql(
        &state,
        &format!("{{ frames(from: \"{}\", to: \"{}\", stepMinutes: 60) {{ frameCount }} }}", iso(t), iso(t + 24 * HOUR)),
        json!({}),
    )
    .await;
    assert_eq!(error_code(&body), "TOO_MANY_FRAMES");
    assert!(error_message(&body).contains("GET /v1/frames"), "{body}");
    let body = gql(&state, &format!("{{ frames(from: \"{}\", to: \"{}\", stepMinutes: 0) {{ frameCount }} }}", iso(t), iso(t)), json!({})).await;
    assert!(error_message(&body).contains("stepMinutes"), "{body}");
}

#[tokio::test]
async fn resolver_hotspots() {
    let state = seeded().await;
    let t = ms(2025, 6, 1, 12);
    let g = python_grid(&state);
    let (lon, lat) = g.center(g.index(120, 100));
    insert_sighting(&state.obs, "inat", 1, lat, lon, t - HOUR, "research", None).await;
    let region = region(&state);
    let body = gql(
        &state,
        &format!("{{ hotspots(species: \"python\", at: \"{}\", bbox: {region}, top: 5) {{ species at cells {{ cell lat lon score }} }} }}", iso(t)),
        json!({}),
    )
    .await;
    let grid = &body["data"]["hotspots"];
    assert_eq!(grid["species"], "python", "{body}");
    let cells = grid["cells"].as_array().unwrap();
    assert_eq!(cells.len(), 5);
    assert_eq!(cells[0]["cell"], "120:100");
    assert_eq!(cells[0]["score"], 1.0);
    assert!((cells[0]["lat"].as_f64().unwrap() - lat).abs() < 1e-9);

    let body = gql(&state, &format!("{{ hotspots(species: \"otter\", at: \"{}\", bbox: {region}) {{ species }} }}", iso(t)), json!({})).await;
    assert!(error_message(&body).contains("unknown species"), "{body}");
    let body = gql(&state, &format!("{{ hotspots(species: \"1\", at: \"{}\", bbox: {region}, top: 0) {{ species }} }}", iso(t)), json!({})).await;
    assert!(error_message(&body).contains("top"), "{body}");

    // A conditions app has no hotspot surface at all.
    let carp = crate::app::test_support::test_state_for("carp");
    let carp_region = self::region(&carp);
    for q in [
        format!("{{ hotspots(species: \"carp\", at: \"{}\", bbox: {carp_region}) {{ species }} }}", iso(t)),
        format!("{{ frames(from: \"{}\", to: \"{}\", stepMinutes: 60) {{ frameCount }} }}", iso(t), iso(t)),
        "{ backtest(species: \"carp\", days: 2) { days } }".to_string(),
    ] {
        let body = gql(&carp, &q, json!({})).await;
        assert!(error_message(&body).contains("no hotspot grid"), "{q}: {body}");
    }
    // Readings and alerts still answer for it (its region is Louisiana).
    let body = gql(&carp, &format!("{{ alerts(bbox: {carp_region}, at: \"{}\") {{ id }} }}", iso(t)), json!({})).await;
    assert_eq!(body["data"]["alerts"], json!([]), "{body}");
}

/// Lionfish Watch: cells carry the region id, `explainCell` wants it, and a bbox spanning two
/// regions ranks across both.
#[tokio::test]
async fn resolver_hotspots_multi_region() {
    let state = crate::app::test_support::test_state_for("lionfish");
    seed_sources(&state.obs).await;
    let t = ms(2025, 6, 1, 12);
    let (fl, mx) = (state.app.region("fl-keys").unwrap(), state.app.region("mx-caribbean").unwrap());
    let (lon_a, lat_a) = fl.grid.center(fl.grid.index(10, 10));
    let (lon_b, lat_b) = mx.grid.center(mx.grid.index(20, 30));
    insert_sighting(&state.obs, "inat", 4, lat_a, lon_a, t - HOUR, "research", None).await;
    insert_sighting(&state.obs, "inat", 4, lat_b, lon_b, t - 5 * DAY, "research", None).await;
    let region = region(&state);
    let body = gql(
        &state,
        &format!("{{ hotspots(species: \"lionfish\", at: \"{}\", bbox: {region}, top: 3) {{ species cells {{ cell score }} }} }}", iso(t)),
        json!({}),
    )
    .await;
    let cells = body["data"]["hotspots"]["cells"].as_array().unwrap();
    assert_eq!(cells[0]["cell"], "fl-keys:10:10", "{body}");
    assert!(cells.iter().any(|c| c["cell"] == "mx-caribbean:20:30"), "{body}");
    let body = gql(&state, &format!("{{ explainCell(cell: \"mx-caribbean:20:30\", species: \"lionfish\", at: \"{}\") {{ cell score rankScore regionId components {{ recentReports {{ value }} }} }} }}", iso(t)), json!({})).await;
    let ex = &body["data"]["explainCell"];
    // Component scoring: recentReports 1 (the region's only report), idQuality 0 (no accuracy), heat unknown.
    assert!((ex["rankScore"].as_f64().unwrap() - 1.0 / 3.0).abs() < 1e-6, "{body}");
    assert_eq!((ex["score"].as_f64(), ex["regionId"].as_str()), (ex["rankScore"].as_f64(), Some("mx-caribbean")));
    assert_eq!(ex["components"]["recentReports"]["value"], 1.0);
    let body = gql(&state, &format!("{{ explainCell(cell: \"20:30\", species: \"lionfish\", at: \"{}\") {{ score }} }}", iso(t)), json!({})).await;
    assert!(error_message(&body).contains("<region>:<col>:<row>"), "{body}");
    let body = gql(&state, &format!("{{ hotspots(species: \"python\", at: \"{}\", bbox: {region}) {{ species }} }}", iso(t)), json!({})).await;
    assert!(error_message(&body).contains("unknown species") && error_message(&body).contains("lionfish"), "{body}");
    // Evidence ids carry the region too.
    let body = gql(&state, "query($id: ID!) { evidence(id: $id) { record } }", json!({"id": format!("hotspot:lionfish:mx-caribbean:20:30:{t}")})).await;
    assert_eq!(body["data"]["evidence"]["record"]["region"], "mx-caribbean", "{body}");
    assert_eq!(body["data"]["evidence"]["record"]["cell"], "mx-caribbean:20:30");
}

#[tokio::test]
async fn resolver_explain_cell() {
    let state = seeded().await;
    let t = ms(2025, 6, 1, 12);
    let g = python_grid(&state);
    let (lon, lat) = g.center(g.index(120, 100));
    insert_sighting(&state.obs, "inat", 1, lat, lon, t - HOUR, "research", None).await;
    let body = gql(
        &state,
        &format!("{{ explainCell(cell: \"120:100\", species: \"python\", at: \"{}\") {{ cell species at score terms {{ name value rationale }} }} }}", iso(t)),
        json!({}),
    )
    .await;
    let ex = &body["data"]["explainCell"];
    assert_eq!(ex["score"], 1.0, "{body}");
    assert_eq!(ex["at"], iso(t));
    let terms = ex["terms"].as_array().unwrap();
    assert!(terms.iter().any(|x| x["name"] == "access.python_levee_stage" && x["rationale"].as_str().unwrap().starts_with("no data")), "{body}");
    let body = gql(&state, &format!("{{ explainCell(cell: \"999:1\", species: \"python\", at: \"{}\") {{ score }} }}", iso(t)), json!({})).await;
    assert!(error_message(&body).contains("bad cell id"), "{body}");
}

#[tokio::test]
async fn resolver_backtest() {
    let state = seeded().await;
    let g = python_grid(&state);
    let today = crate::hotspot::backtest::floor_day(crate::state::now_ms());
    let (lon, lat) = g.center(g.index(100, 100));
    // History two days back, then a sighting in the same cell yesterday: a hit.
    insert_sighting(&state.obs, "inat", 1, lat, lon, today - 3 * DAY + 5 * HOUR, "research", None).await;
    insert_sighting(&state.obs, "inat", 1, lat, lon, today - DAY + 9 * HOUR, "research", None).await;
    let body = gql(&state, "{ backtest(species: \"python\", days: 2) { species days hitRate baseline perDay { day sightings hits } } }", json!({})).await;
    let bt = &body["data"]["backtest"];
    assert_eq!(bt["species"], "python", "{body}");
    assert_eq!(bt["days"], 2);
    assert_eq!(bt["baseline"], 0.1);
    assert_eq!(bt["hitRate"], 1.0);
    assert_eq!(bt["perDay"], json!([{"day": iso(today - 2 * DAY), "sightings": 0, "hits": 0}, {"day": iso(today - DAY), "sightings": 1, "hits": 1}]));
    let body = gql(&state, "{ backtest(species: \"python\", days: 0) { days } }", json!({})).await;
    assert!(error_message(&body).contains("days"), "{body}");
}

/// `taxa` by id and by name, `speciesCounts` for the app's species only, and the taxon fields on
/// `sightings` and `evidence`. Python molurus stands for the taxon an ID flip moved a python to.
#[tokio::test]
async fn resolver_taxa_and_species_counts() {
    let state = seeded().await;
    let t = ms(2026, 9, 1, 12);
    let molurus: i64 = state
        .obs
        .write(|tx| {
            tx.execute("insert into taxa (scientific_name, common_name, focus, inat_taxon_id) values ('Python molurus', 'Indian python', 0, 32150)", [])?;
            Ok(tx.last_insert_rowid())
        })
        .await
        .unwrap();

    // Two pythons (one with a GBIF duplicate), one flipped to P. molurus, one outside the window.
    let a1 = insert_sighting(&state.obs, "inat", 1, 25.5, -80.9, t, "research", None).await;
    insert_sighting(&state.obs, "gbif", 1, 25.5, -80.9, t, "research", Some(a1)).await;
    let a2 = insert_sighting(&state.obs, "inat", 1, 25.6, -80.8, t + HOUR, "needs_id", None).await;
    let flipped = insert_sighting(&state.obs, "inat", molurus, 25.6, -80.8, t, "research", None).await;
    insert_sighting(&state.obs, "inat", 1, 25.6, -80.8, t - 3 * DAY, "research", None).await;

    let body = gql(&state, "query($ids: [ID!]) { taxa(ids: $ids) { id scientificName commonName focus inatTaxonId pageUrl } }", json!({"ids": [molurus.to_string(), "python"]})).await;
    let rows = body["data"]["taxa"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "{body}");
    assert_eq!(rows[0], json!({"id": "1", "scientificName": "Python bivittatus", "commonName": "Burmese python", "focus": true, "inatTaxonId": "238252", "pageUrl": "https://www.inaturalist.org/taxa/238252"}), "focus first: {body}");
    assert_eq!(rows[1]["focus"], false);
    assert_eq!(rows[1]["pageUrl"], "https://www.inaturalist.org/taxa/32150");
    // The category and enrichment fields of arbitrary taxa (T44) are gone.
    let body = gql(&state, "{ taxa(ids: [\"python\"]) { iconicGroup } }", json!({})).await;
    assert!(error_message(&body).contains("iconicGroup"), "{body}");

    // By name, case-insensitively, inside either name; `%` is not a wildcard for the caller.
    let body = gql(&state, "{ taxa(q: \"indian PYTHON\") { scientificName } }", json!({})).await;
    assert_eq!(body["data"]["taxa"], json!([{"scientificName": "Python molurus"}]), "{body}");
    let body = gql(&state, "{ taxa(q: \"bivittatus\") { commonName } }", json!({})).await;
    assert_eq!(body["data"]["taxa"][0]["commonName"], "Burmese python");
    let body = gql(&state, "{ taxa(q: \"%\") { id } }", json!({})).await;
    assert_eq!(body["data"]["taxa"].as_array().unwrap().len(), 0, "{body}");
    let body = gql(&state, "{ taxa { id } }", json!({})).await;
    assert!(error_message(&body).contains("ids"), "{body}");

    // Counts: the app's species only, distinct sightings in the window.
    let window = format!("from: \"{}\", to: \"{}\"", iso(t - DAY), iso(t + DAY));
    let region = region(&state);
    let body = gql(&state, &format!("{{ speciesCounts(bbox: {region}, {window}) {{ taxon {{ id commonName }} count latestSightingId }} }}"), json!({})).await;
    assert_eq!(
        body["data"]["speciesCounts"],
        json!([{"taxon": {"id": "1", "commonName": "Burmese python"}, "count": 2, "latestSightingId": a2.to_string()}]),
        "the GBIF duplicate, the flipped record and the old one are not counted: {body}"
    );
    let body = gql(&state, &format!("{{ speciesCounts(bbox: {region}, {window}, groups: [\"Reptilia\"]) {{ count }} }}"), json!({})).await;
    assert!(error_message(&body).contains("groups"), "{body}");
    let body = gql(&state, &format!("{{ speciesCounts(bbox: {region}, {window}, top: 0) {{ count }} }}"), json!({})).await;
    assert!(error_message(&body).contains("`top`"), "{body}");

    // The taxon rides on `sightings` and inside the evidence record.
    let body = gql(&state, &format!("{{ sightings(bbox: {region}, {window}, taxa: [\"{molurus}\"]) {{ id taxon {{ commonName pageUrl }} }} }}"), json!({})).await;
    assert_eq!(body["data"]["sightings"], json!([{"id": flipped.to_string(), "taxon": {"commonName": "Indian python", "pageUrl": "https://www.inaturalist.org/taxa/32150"}}]), "{body}");
    let body = gql(&state, "query($id: ID!) { evidence(id: $id) { record } }", json!({"id": format!("sighting:{a1}")})).await;
    let taxon = &body["data"]["evidence"]["record"]["taxon"];
    assert_eq!(
        *taxon,
        json!({"id": "1", "scientificName": "Python bivittatus", "commonName": "Burmese python", "focus": true, "inatTaxonId": "238252", "pageUrl": "https://www.inaturalist.org/taxa/238252"}),
        "{body}"
    );
}

#[tokio::test]
async fn resolver_evidence() {
    let state = seeded().await;
    let t = ms(2026, 9, 1, 12);
    let a = insert_sighting(&state.obs, "inat", 1, 25.5, -80.9, t, "research", None).await;
    let b = insert_sighting(&state.obs, "gbif", 1, 25.5, -80.9, t, "research", Some(a)).await;
    state
        .obs
        .write(move |tx| tx.execute("update sightings set photo_url = 'https://static.inaturalist.org/photos/9/medium.jpg' where id = ?1", [a]))
        .await
        .unwrap();
    let q = "query($id: ID!) { evidence(id: $id) { id kind record raw rawKey sourceUrl fetchedAt ingestLagSeconds
             feed { source state lastFetchRunId } links { id relation source } } }";
    let body = gql(&state, q, json!({"id": format!("sighting:{a}")})).await;
    let ev = &body["data"]["evidence"];
    assert_eq!(ev["kind"], "sighting", "{body}");
    assert_eq!(ev["record"]["taxon"]["scientificName"], "Python bivittatus");
    assert_eq!(ev["record"]["mediaUrl"], format!("/v1/media/{a}"));
    assert_eq!(ev["links"], json!([{"id": format!("sighting:{b}"), "relation": "duplicates", "source": "gbif"}]));
    assert_eq!(ev["feed"]["source"], "inat");
    assert_eq!(ev["raw"], Value::Null);

    // Hotspot and backtest ids.
    let body = gql(&state, q, json!({"id": format!("hotspot:python:120:100:{t}")})).await;
    assert_eq!(body["data"]["evidence"]["record"]["cell"], "120:100", "{body}");
    assert!(body["data"]["evidence"]["record"]["terms"].as_array().is_some_and(|t| !t.is_empty()));
    let body = gql(&state, q, json!({"id": "backtest:python:3"})).await;
    assert_eq!(body["data"]["evidence"]["kind"], "backtest", "{body}");
    assert_eq!(body["data"]["evidence"]["record"]["perDay"].as_array().unwrap().len(), 3);

    // Clean errors.
    let body = gql(&state, q, json!({"id": "sighting:424242"})).await;
    assert_eq!(error_code(&body), "NOT_FOUND", "{body}");
    assert!(error_message(&body).starts_with("not found"));
    let body = gql(&state, q, json!({"id": "weather:1"})).await;
    assert_eq!(error_code(&body), "BAD_ID", "{body}");
}

fn op(id: &str, hlc: &str, entity: &str, entity_id: &str, field: &str, value: Value) -> Value {
    json!({"id": id, "hlc": hlc, "entity": entity, "entityId": entity_id, "field": field, "value": value, "nodeId": "n1"})
}

const APPLY: &str = "mutation($board: ID!, $ops: [OpInput!]!) { applyOps(boardId: $board, ops: $ops) { applied duplicates lastSeq } }";

#[tokio::test]
async fn resolver_board() {
    let state = test_state();
    let ops = json!([
        op("o1", "1000:0:n1", "mission", "m1", "title", json!("Sweep L-31W")),
        op("o2", "1000:1:n1", "note", "n1", "text", json!("levee gate open")),
        op("o3", "1000:2:n1", "message", "msg1", "body", json!("heading out")),
        op("o4", "1000:3:n1", "removal", "python", "count", json!(2)),
        op("o5", "1000:4:n1", "note", "n2", "text", json!("gone")),
        op("o6", "1000:5:n1", "note", "n2", "_deleted", json!(true)),
    ]);
    let body = gql(&state, APPLY, json!({"board": "b1", "ops": ops})).await;
    assert_eq!(body["data"]["applyOps"], json!({"applied": 6, "duplicates": 0, "lastSeq": 6}), "{body}");
    let body = gql(&state, "{ board(id: \"b1\") { id lastSeq missions { id fields } notes { id fields } messages { id body hlc nodeId } removals } }", json!({})).await;
    assert_eq!(
        body["data"]["board"],
        json!({
            "id": "b1",
            "lastSeq": 6,
            "missions": [{"id": "m1", "fields": {"title": "Sweep L-31W"}}],
            "notes": [{"id": "n1", "fields": {"text": "levee gate open"}}],
            "messages": [{"id": "msg1", "body": "heading out", "hlc": "1000:2:n1", "nodeId": "n1"}],
            "removals": {"python": 2}
        }),
        "{body}"
    );
    let body = gql(&state, "{ board(id: \"empty\") { lastSeq missions { id } notes { id } messages { id } removals } }", json!({})).await;
    assert_eq!(body["data"]["board"], json!({"lastSeq": 0, "missions": [], "notes": [], "messages": [], "removals": {}}));
}

/// G4: a direct message's `to` and `thread` (PLAN.md C-A7) reach GraphQL; a board-wide message has nulls.
#[tokio::test]
async fn message_thread_graphql() {
    let state = test_state();
    let ops = json!([
        op("d1", "2000:0:n1", "message", "dm1", "body", json!({"body": "meet at gate", "to": "n2", "thread": "n1:n2"})),
        op("d2", "2000:1:n1", "message", "all1", "body", json!("heading out")),
    ]);
    let body = gql(&state, APPLY, json!({"board": "b1", "ops": ops})).await;
    assert_eq!(body["data"]["applyOps"]["applied"], json!(2), "{body}");
    let body = gql(&state, "{ board(id: \"b1\") { messages { id body to thread } } }", json!({})).await;
    assert_eq!(
        body["data"]["board"]["messages"],
        json!([
            {"id": "dm1", "body": "meet at gate", "to": "n2", "thread": "n1:n2"},
            {"id": "all1", "body": "heading out", "to": null, "thread": null},
        ]),
        "{body}"
    );
}

#[tokio::test]
async fn resolver_ops_since() {
    let state = test_state();
    let ops = json!([
        op("o1", "1000:0:n1", "note", "n1", "text", json!("a")),
        op("o2", "1001:0:n1", "note", "n1", "text", json!("b")),
        op("o3", "1002:0:n1", "note", "n1", "color", Value::Null),
    ]);
    gql(&state, APPLY, json!({"board": "b1", "ops": ops})).await;
    gql(&state, APPLY, json!({"board": "b2", "ops": [op("x1", "1:0:n1", "note", "z", "text", json!("other board"))]})).await;
    let body = gql(&state, "{ opsSince(boardId: \"b1\", seq: 1) { seq id hlc boardId entity entityId field value nodeId } }", json!({})).await;
    assert_eq!(
        body["data"]["opsSince"],
        json!([
            {"seq": 2, "id": "o2", "hlc": "1001:0:n1", "boardId": "b1", "entity": "note", "entityId": "n1", "field": "text", "value": "b", "nodeId": "n1"},
            {"seq": 3, "id": "o3", "hlc": "1002:0:n1", "boardId": "b1", "entity": "note", "entityId": "n1", "field": "color", "value": null, "nodeId": "n1"}
        ]),
        "{body}"
    );
    let body = gql(&state, "{ opsSince(boardId: \"b1\", seq: 3) { seq } }", json!({})).await;
    assert_eq!(body["data"]["opsSince"], json!([]));
}

#[tokio::test]
async fn resolver_apply_ops_rejects_bad_ops_and_big_bodies() {
    let state = test_state();
    // Idempotent on op id.
    let ops = json!([op("o1", "1000:0:n1", "note", "n1", "text", json!("a"))]);
    gql(&state, APPLY, json!({"board": "b1", "ops": ops})).await;
    let body = gql(&state, APPLY, json!({"board": "b1", "ops": ops})).await;
    assert_eq!(body["data"]["applyOps"], json!({"applied": 0, "duplicates": 1, "lastSeq": 1}));

    for bad in [
        op("o2", "not-an-hlc", "note", "n1", "text", json!("a")),
        op("o3", "1000:0:n1", "planet", "p", "text", json!("a")),
        op("o4", "1000:0:n1", "message", "m", "body", json!(42)),
        op("o5", "1000:0:n1", "removal", "python", "count", json!(-1)),
    ] {
        let body = gql(&state, APPLY, json!({"board": "b1", "ops": [op("ok", "2000:0:n1", "note", "n9", "text", json!("x")), bad]})).await;
        assert_eq!(error_code(&body), "BAD_OP", "{body}");
    }
    // All-or-nothing: the valid op sent alongside the bad ones was not stored.
    let body = gql(&state, "{ opsSince(boardId: \"b1\", seq: 0) { id } }", json!({})).await;
    assert_eq!(body["data"]["opsSince"], json!([{"id": "o1"}]));

    let many: Vec<Value> = (0..super::mutation::MAX_OPS_PER_CALL + 1).map(|i| op(&format!("m{i}"), "1:0:n1", "note", "n", "t", json!(1))).collect();
    let body = gql(&state, APPLY, json!({"board": "b1", "ops": many})).await;
    assert_eq!(error_code(&body), "BAD_OP", "{body}");

    // Over the body cap: 413 before any parsing.
    let huge = "x".repeat(super::MAX_BODY_BYTES);
    let res = tower::ServiceExt::oneshot(
        router_for(&state),
        axum::http::Request::post("/v1/python/graphql")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(json!({"query": APPLY, "variables": {"board": "b1", "ops": [], "pad": huge}}).to_string()))
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

/// Query cost limits (docs/security.md): aliasing cannot fan one document out into many table scans, and
/// runaway nesting is refused, while the HUD's largest real document (241 aliased `alerts` samples) passes.
#[tokio::test]
async fn resolver_limits_query_cost() {
    let state = seeded().await;
    let region = region(&state);
    let window = "from: \"2026-09-01T00:00:00Z\", to: \"2026-09-02T00:00:00Z\"";
    let fanned: Vec<String> = (0..20).map(|i| format!("s{i}: sightings(bbox: {region}, {window}) {{ id }}")).collect();
    let body = gql(&state, &format!("{{ {} }}", fanned.join(" ")), json!({})).await;
    assert!(body["data"].is_null(), "{body}");
    assert!(error_message(&body).contains("complex"), "{body}");

    // A handful of heavy fields is fine.
    let few: Vec<String> = (0..3).map(|i| format!("s{i}: sightings(bbox: {region}, {window}) {{ id lat lon }}")).collect();
    let body = gql(&state, &format!("{{ {} feeds {{ source }} }}", few.join(" ")), json!({})).await;
    assert!(body["errors"].is_null(), "{body}");

    // The alert-band document the HUD sends for a 30-day window at 3 h spacing.
    let bands: Vec<String> = (0..241)
        .map(|i| format!("a{i}: alerts(bbox: {region}, at: \"{}\") {{ id event severity headline onset expires }}", iso(ms(2026, 9, 1, 0) + i * 3 * HOUR)))
        .collect();
    let body = gql(&state, &format!("{{ {} }}", bands.join(" ")), json!({})).await;
    assert!(body["errors"].is_null(), "{body}");

    // Nesting past MAX_DEPTH (introspection types nest through ofType).
    let mut deep = String::from("name");
    for _ in 0..super::MAX_DEPTH {
        deep = format!("ofType {{ {deep} }}");
    }
    let body = gql(&state, &format!("{{ __type(name: \"Sighting\") {{ fields {{ type {{ {deep} }} }} }} }}"), json!({})).await;
    assert!(error_message(&body).contains("nested too deep"), "{body}");
}

/// `ops` over a real socket: graphql-transport-ws subscribe, `applyOps` over HTTP on the same
/// server, then the op arrives as a `next` message.
#[tokio::test]
async fn subscription_ops_receives_applied_ops_over_websocket() {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::Message;

    let state = test_state();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = router_for(&state);
    let server = tokio::spawn(async move { axum::serve(listener, app).await });

    let mut req = format!("ws://{addr}/v1/python/graphql").into_client_request().unwrap();
    req.headers_mut().insert("Sec-WebSocket-Protocol", "graphql-transport-ws".parse().unwrap());
    let (mut ws, res) = tokio_tungstenite::connect_async(req).await.unwrap();
    assert_eq!(res.headers()["sec-websocket-protocol"], "graphql-transport-ws");

    async fn next_json(ws: &mut (impl futures_util::Stream<Item = tokio_tungstenite::tungstenite::Result<Message>> + Unpin)) -> Value {
        loop {
            match tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("message within 5 s").unwrap().unwrap() {
                Message::Text(t) => return serde_json::from_str(t.as_str()).unwrap(),
                Message::Ping(_) | Message::Pong(_) => continue,
                other => panic!("unexpected frame {other:?}"),
            }
        }
    }

    ws.send(Message::text(json!({"type": "connection_init"}).to_string())).await.unwrap();
    assert_eq!(next_json(&mut ws).await["type"], "connection_ack");
    ws.send(Message::text(
        json!({"id": "s1", "type": "subscribe", "payload": {
            "query": "subscription($b: ID!) { ops(boardId: $b, afterSeq: 0) { seq id hlc boardId entity entityId field value nodeId } }",
            "variables": {"b": "field-team"}}})
        .to_string(),
    ))
    .await
    .unwrap();

    let http = reqwest::Client::new();
    let apply = |ops: Value| {
        let http = http.clone();
        async move {
            let res: Value = http
                .post(format!("http://{addr}/v1/python/graphql"))
                .json(&json!({"query": APPLY, "variables": {"board": "field-team", "ops": ops}}))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            res
        }
    };
    let res = apply(json!([op("w1", "5000:0:n1", "mission", "m1", "status", json!("active"))])).await;
    assert_eq!(res["data"]["applyOps"]["applied"], 1, "{res}");
    let msg = next_json(&mut ws).await;
    assert_eq!(
        msg,
        json!({"id": "s1", "type": "next", "payload": {"data": {"ops": {"seq": 1, "id": "w1", "hlc": "5000:0:n1", "boardId": "field-team",
               "entity": "mission", "entityId": "m1", "field": "status", "value": "active", "nodeId": "n1"}}}})
    );

    // Later ops stream in order; a re-sent op is not delivered twice; other boards are filtered.
    apply(json!([op("w1", "5000:0:n1", "mission", "m1", "status", json!("active"))])).await;
    let other: Value = http
        .post(format!("http://{addr}/v1/python/graphql"))
        .json(&json!({"query": APPLY, "variables": {"board": "elsewhere", "ops": [op("e1", "1:0:n1", "note", "x", "t", json!(1))]}}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(other["data"]["applyOps"]["applied"], 1);
    apply(json!([op("w2", "5001:0:n1", "message", "c1", "body", json!("on site")), op("w3", "5002:0:n1", "removal", "python", "n", json!(1))])).await;
    let seqs: Vec<(i64, String)> = [next_json(&mut ws).await, next_json(&mut ws).await]
        .iter()
        .map(|m| (m["payload"]["data"]["ops"]["seq"].as_i64().unwrap(), m["payload"]["data"]["ops"]["id"].as_str().unwrap().to_string()))
        .collect();
    assert_eq!(seqs, vec![(3, "w2".to_string()), (4, "w3".to_string())]);
    server.abort();
}

// ---------------------------------------------------------------------------------------------
// C3 forecast store: `forecasts`, `forecastVerify`, `siteStatusAt` (conditions apps only).
// ---------------------------------------------------------------------------------------------

/// The carp app with one site's forecast history seeded through the store: an archive issuance,
/// two live issuances (captured an hour after issue), hourly observations, thresholds, alerts.
async fn carp_seeded() -> (AppState, i64, i64, i64) {
    use crate::forecast::store::{insert_observations, insert_snapshot, record_alerts, upsert_thresholds, AlertSeen, NewSnapshot};
    use crate::forecast::{Observation, Point, Source, Thresholds};
    let state = crate::app::test_support::test_state_for("carp");
    // A year back so "asOf = now" (the wall clock) is after every seeded ingestion.
    let t0 = ms(2025, 9, 29, 0);
    let archive = t0 + 15 * HOUR; // 09-29 15Z via IEM, ingested days later
    let d0 = archive + DAY; // 09-30 15Z live
    let d1 = d0 + DAY; // 10-01 15Z live
    state
        .obs
        .write(move |tx| {
            let th = Thresholds::from_feed(30.0, 35.0, 38.0, 40.0);
            upsert_thresholds(tx, "BTRL1", t0, &th)?;
            let pts = |start: i64, base: f64| -> Vec<Point> {
                (0..58).map(|i| Point { valid_at: start + i as i64 * 6 * HOUR, stage_ft: Some(base + 0.15 * i as f64), flow_kcfs: Some(245.0) }).collect()
            };
            let snap = |issued: i64, ingested: i64, source: Source, hash: &str, base: f64| NewSnapshot {
                site: "BTRL1".into(),
                product: if source == Source::IemArchive { "hml".into() } else { "stageflow".into() },
                issued_at: issued,
                ingested_at: ingested,
                source,
                payload_hash: hash.into(),
                points: pts(issued + 3 * HOUR, base),
            };
            insert_snapshot(tx, &snap(d0, d0 + HOUR, Source::NwpsLive, "d0", 8.0), &th)?;
            insert_snapshot(tx, &snap(d1, d1 + HOUR, Source::NwpsLive, "d1", 8.5), &th)?;
            // Revision of d1 with a higher crest, captured 3 h after issue.
            let mut rev = snap(d1, d1 + 3 * HOUR, Source::NwpsLive, "d1b", 9.0);
            rev.points[57].stage_ft = Some(31.0);
            insert_snapshot(tx, &rev, &th)?;
            insert_snapshot(tx, &snap(archive, d1 + 5 * DAY, Source::IemArchive, "arch", 7.5), &th)?;
            // Hourly observations from 09-30 00Z for three days, each captured 55 min after.
            for h in 0..72 {
                let at = t0 + DAY + h * HOUR;
                insert_observations(tx, "BTRL1", Source::NwpsLive, at + 55 * 60_000, &[Observation { observed_at: at, stage_ft: Some(8.15 + 0.03 * h as f64), flow_kcfs: Some(245.0) }])?;
            }
            record_alerts(
                tx,
                "BTRL1",
                d1,
                &[AlertSeen {
                    ext_id: "urn:oid:2.49.0.1.840.0.1".into(),
                    event: "Flood Watch".into(),
                    severity: "Moderate".into(),
                    headline: None,
                    onset: Some(d1),
                    expires: Some(d1 + DAY),
                    source: Source::NwsGridpoint,
                    payload_hash: "a".into(),
                }],
            )?;
            record_alerts(tx, "BTRL1", d1 + 6 * HOUR, &[])?;
            // The alert poller ran every 10 min for ten days (its runs are the alert checks).
            tx.execute(
                "insert or ignore into sources (id, name, homepage, mode, cadence_s, max_latency_s) values ('nws-alerts', 'NWS alerts', 'https://api.weather.gov', 'poll', 60, 900)",
                [],
            )?;
            let mut at = t0;
            while at < t0 + 10 * DAY {
                tx.execute("insert into fetch_runs (source_id, fetched_at, received_at, status) values ('nws-alerts', ?1, ?1 + 2000, 'ok')", [at])?;
                at += 10 * 60_000;
            }
            Ok(())
        })
        .await
        .unwrap();
    (state, archive, d0, d1)
}

#[tokio::test]
async fn forecast_graphql_forecasts_asof_and_coverage() {
    let (state, archive, d0, d1) = carp_seeded().await;
    const Q: &str = "query($site: ID!, $asOf: Time, $history: Int) { forecasts(site: $site, asOf: $asOf, history: $history) {
        site asOf snapshotCount replayCoverageStart liveCoverageStart
        snapshot { id site product issuedAt ingestedAt source payloadHash revision validFrom validTo horizonEnd peakStageFt peakAt peakCategory points { validAt stageFt flowKcfs category } }
        history { issuedAt revision source } } }";
    // Between d1's issue and its capture: d0 is what we knew.
    let body = gql(&state, Q, json!({"site": "btrl1", "asOf": iso(d1 + 30 * 60_000), "history": 10})).await;
    let f = &body["data"]["forecasts"];
    assert_eq!(f["site"], "BTRL1", "{body}");
    assert_eq!(f["snapshot"]["issuedAt"], iso(d0));
    assert_eq!(f["snapshot"]["source"], "NWPS_LIVE");
    assert_eq!(f["snapshot"]["product"], "stageflow");
    assert_eq!(f["snapshot"]["revision"], 0);
    assert_eq!(f["snapshot"]["points"].as_array().unwrap().len(), 58);
    assert_eq!(f["snapshot"]["points"][0]["category"], "NONE");
    assert_eq!(f["snapshot"]["validFrom"], iso(d0 + 3 * HOUR));
    assert_eq!(f["snapshot"]["horizonEnd"], iso(d0 + 3 * HOUR + 57 * 6 * HOUR));
    assert_eq!(f["snapshot"]["peakCategory"], "NONE");
    assert_eq!(f["history"], json!([{"issuedAt": iso(d0), "revision": 0, "source": "NWPS_LIVE"}, {"issuedAt": iso(archive), "revision": 0, "source": "IEM_ARCHIVE"}]));
    assert_eq!(f["snapshotCount"], 4);
    assert_eq!(f["replayCoverageStart"], iso(archive));
    assert_eq!(f["liveCoverageStart"], iso(d0 + HOUR));
    // After the revision landed: revision 1 with the 31 ft crest (action stage 30).
    let body = gql(&state, Q, json!({"site": "BTRL1", "asOf": iso(d1 + 3 * HOUR)})).await;
    let f = &body["data"]["forecasts"];
    assert_eq!((f["snapshot"]["issuedAt"].as_str(), f["snapshot"]["revision"].as_i64()), (Some(iso(d1).as_str()), Some(1)));
    assert_eq!(f["snapshot"]["peakStageFt"], 31.0);
    assert_eq!(f["snapshot"]["peakCategory"], "ACTION");
    assert_eq!(f["history"].as_array().unwrap().len(), 1, "default history 1");
    // Before the revision: revision 0 of d1.
    let body = gql(&state, Q, json!({"site": "BTRL1", "asOf": iso(d1 + 2 * HOUR)})).await;
    assert_eq!(body["data"]["forecasts"]["snapshot"]["revision"], 0);
    // Before anything: the archive issuance was public at its issue time; before that, null.
    let body = gql(&state, Q, json!({"site": "BTRL1", "asOf": iso(archive)})).await;
    assert_eq!(body["data"]["forecasts"]["snapshot"]["source"], "IEM_ARCHIVE");
    let body = gql(&state, Q, json!({"site": "BTRL1", "asOf": iso(archive - 1)})).await;
    assert_eq!(body["data"]["forecasts"]["snapshot"], Value::Null);
    assert_eq!(body["data"]["forecasts"]["history"], json!([]));
    // Default asOf = now: the newest.
    let body = gql(&state, Q, json!({"site": "BTRL1"})).await;
    assert_eq!(body["data"]["forecasts"]["snapshot"]["revision"], 1);
    // A configured site with nothing stored: empty view, no error.
    let body = gql(&state, Q, json!({"site": "SMML1"})).await;
    assert_eq!(body["data"]["forecasts"], json!({"site": "SMML1", "asOf": body["data"]["forecasts"]["asOf"], "snapshotCount": 0, "replayCoverageStart": null, "liveCoverageStart": null, "snapshot": null, "history": []}));
    // Validation.
    let body = gql(&state, Q, json!({"site": "XXXX1"})).await;
    assert_eq!(error_code(&body), "UNKNOWN_SITE");
    assert!(error_message(&body).contains("SMML1, KRZL1, BLRL1, MCGL1, BTRL1, AEXL1, MLUL1, BXAL1"), "{body}");
    let body = gql(&state, Q, json!({"site": "BTRL1", "history": 61})).await;
    assert!(error_message(&body).contains("0..=60"), "{body}");
}

#[tokio::test]
async fn forecast_graphql_verify() {
    let (state, _, d0, d1) = carp_seeded().await;
    const Q: &str = "query($site: ID!, $at: Time!) { forecastVerify(site: $site, issuedAt: $at) {
        site issuedAt snapshot { id revision } paired missing biasFt meanAbsErrorFt maxAbsErrorFt
        peakForecastFt peakForecastCategory peakObservedFt peakObservedCategory peakCategoryHit
        points { validAt forecastFt observedAt observedFt errorFt missing forecastCategory observedCategory } } }";
    let body = gql(&state, Q, json!({"site": "BTRL1", "at": iso(d0)})).await;
    let v = &body["data"]["forecastVerify"];
    assert_eq!(v["issuedAt"], iso(d0), "{body}");
    assert_eq!(v["snapshot"]["revision"], 0);
    // Observations cover 09-30 00Z .. 10-02 23Z: points valid 09-30 18Z .. 10-02 18Z pair (9), the rest miss.
    assert_eq!((v["paired"].as_i64(), v["missing"].as_i64()), (Some(9), Some(49)));
    let pts = v["points"].as_array().unwrap();
    assert_eq!(pts.len(), 58);
    assert_eq!(pts[0]["validAt"], iso(d0 + 3 * HOUR));
    assert_eq!(pts[0]["observedAt"], iso(d0 + 3 * HOUR), "exact hour pairs");
    assert_eq!(pts[0]["missing"], false);
    assert!((pts[0]["errorFt"].as_f64().unwrap() - (8.0 - (8.15 + 0.03 * 18.0))).abs() < 1e-9);
    assert_eq!(pts[0]["observedCategory"], "NONE");
    assert_eq!(pts[57]["missing"], true);
    assert_eq!(pts[57]["observedFt"], Value::Null);
    assert_eq!(pts[57]["errorFt"], Value::Null, "missing stays missing");
    assert!(v["biasFt"].as_f64().is_some() && v["meanAbsErrorFt"].as_f64().unwrap() > 0.0);
    assert_eq!(v["peakForecastCategory"], "NONE");
    assert_eq!(v["peakObservedCategory"], "NONE");
    assert_eq!(v["peakCategoryHit"], true);
    // The revised d1 (crest 31 ft, action) verifies against observations that never got there.
    let body = gql(&state, Q, json!({"site": "BTRL1", "at": iso(d1)})).await;
    let v = &body["data"]["forecastVerify"];
    assert_eq!(v["snapshot"]["revision"], 1);
    assert_eq!((v["peakForecastFt"].as_f64(), v["peakForecastCategory"].as_str()), (Some(31.0), Some("ACTION")));
    assert_eq!(v["peakCategoryHit"], false);
    // Unknown issuance.
    let body = gql(&state, Q, json!({"site": "BTRL1", "at": iso(d0 + 1)})).await;
    assert_eq!(error_code(&body), "NOT_FOUND");
}

#[tokio::test]
async fn forecast_graphql_site_status_at() {
    let (state, _, d0, d1) = carp_seeded().await;
    const Q: &str = "query($site: ID!, $asOf: Time!, $c: Float) { siteStatusAt(site: $site, asOf: $asOf, conflictFt: $c) {
        site asOf stageFt category observationFreshness forecastFreshness activeAlerts
        observation { observedAt ingestedAt source stageFt flowKcfs }
        thresholds { actionFt minorFt moderateFt majorFt }
        forecast { issuedAt revision } forecastNow { validAt stageFt category }
        conflicts { kind detail forecastFt observedFt differenceFt } } }";
    // d1 + 4 h (19Z): revision 1 of d1 in force; newest observation 18Z (captured 18:55); no
    // forecast point within 30 min of 19Z (points are 6-hourly from 18Z) -> forecastNow null.
    let body = gql(&state, Q, json!({"site": "BTRL1", "asOf": iso(d1 + 4 * HOUR)})).await;
    let s = &body["data"]["siteStatusAt"];
    assert_eq!(s["site"], "BTRL1", "{body}");
    assert_eq!(s["forecast"], json!({"issuedAt": iso(d1), "revision": 1}));
    assert_eq!(s["observation"]["observedAt"], iso(d1 + 3 * HOUR));
    assert_eq!(s["observation"]["source"], "NWPS_LIVE");
    assert_eq!(s["stageFt"], s["observation"]["stageFt"]);
    assert_eq!(s["category"], "NONE");
    assert_eq!(s["thresholds"], json!({"actionFt": 30.0, "minorFt": 35.0, "moderateFt": 38.0, "majorFt": 40.0}));
    assert_eq!((s["observationFreshness"].as_str(), s["forecastFreshness"].as_str()), (Some("FRESH"), Some("FRESH")));
    assert_eq!(s["forecastNow"], Value::Null);
    assert_eq!(s["conflicts"], json!([]));
    assert_eq!(s["activeAlerts"], 1, "watch seen at d1, ended at d1 + 6 h");
    assert_eq!(gql(&state, Q, json!({"site": "BTRL1", "asOf": iso(d1 + 7 * HOUR)})).await["data"]["siteStatusAt"]["activeAlerts"], 0);
    assert_eq!(gql(&state, Q, json!({"site": "BTRL1", "asOf": iso(d1 - 1)})).await["data"]["siteStatusAt"]["activeAlerts"], 0);
    // d1 + 3 h exactly: forecast point valid d1 + 3 h (9.0 ft) vs the 17Z observation (the 18Z
    // one lands at 18:55): 8.15 + 0.03*41 = 9.38, 0.38 ft off. No conflict at the 1 ft default,
    // a conflict at 0.25 ft.
    let body = gql(&state, Q, json!({"site": "BTRL1", "asOf": iso(d1 + 3 * HOUR)})).await;
    let s = &body["data"]["siteStatusAt"];
    assert_eq!(s["forecastNow"]["validAt"], iso(d1 + 3 * HOUR));
    assert_eq!(s["observation"]["observedAt"], iso(d1 + 2 * HOUR), "the 18Z value arrives at 18:55");
    assert_eq!(s["conflicts"], json!([]));
    let body = gql(&state, Q, json!({"site": "BTRL1", "asOf": iso(d1 + 3 * HOUR), "c": 0.25})).await;
    let c = &body["data"]["siteStatusAt"]["conflicts"][0];
    assert_eq!(c["kind"], "gauge_vs_forecast", "{body}");
    assert_eq!(c["forecastFt"], 9.0);
    assert!((c["differenceFt"].as_f64().unwrap() - (8.15 + 0.03 * 41.0 - 9.0)).abs() < 1e-9);
    assert!(c["detail"].as_str().unwrap().contains("over the 0.25 ft threshold"));
    // Four days on: forecast stale (> 36 h), observation stale (> 6 h), both named; category still from NWPS.
    let body = gql(&state, Q, json!({"site": "BTRL1", "asOf": iso(d1 + 4 * DAY)})).await;
    let s = &body["data"]["siteStatusAt"];
    assert_eq!((s["observationFreshness"].as_str(), s["forecastFreshness"].as_str()), (Some("STALE"), Some("STALE")));
    assert_eq!(s["conflicts"].as_array().unwrap().iter().map(|c| c["kind"].as_str().unwrap()).collect::<Vec<_>>(), ["stale_forecast", "stale_observation"]);
    // Before d0 was captured: the archive forecast (issued 24.5 h earlier: AGING).
    let body = gql(&state, Q, json!({"site": "BTRL1", "asOf": iso(d0 + 30 * 60_000)})).await;
    let s = &body["data"]["siteStatusAt"];
    assert_eq!(s["forecast"]["issuedAt"], iso(d0 - DAY));
    assert_eq!(s["forecastFreshness"], "AGING");
    // Nothing known at a configured site: MISSING bands, nulls, no conflicts.
    let body = gql(&state, Q, json!({"site": "MLUL1", "asOf": iso(d1)})).await;
    let s = &body["data"]["siteStatusAt"];
    assert_eq!((s["observationFreshness"].as_str(), s["forecastFreshness"].as_str()), (Some("MISSING"), Some("MISSING")));
    assert_eq!((s["stageFt"].clone(), s["category"].clone(), s["forecast"].clone(), s["conflicts"].clone()), (Value::Null, Value::Null, Value::Null, json!([])));
    let body = gql(&state, Q, json!({"site": "BTRL1", "asOf": iso(d1), "c": -1.0})).await;
    assert!(error_message(&body).contains("conflictFt"), "{body}");
}

// ---------------------------------------------------------------------------------------------
// C5 needs review: `siteReview`, `reviewHistory`, `reviewBoard` (conditions apps only).
// ---------------------------------------------------------------------------------------------

const REASON_FIELDS: &str = "rule outcome severity value valueText threshold unit source observedAt issuedAt link evidenceIds explanation";

#[tokio::test]
async fn review_graphql_site_review_asof() {
    let (state, _, d0, d1) = carp_seeded().await;
    let q = format!(
        "query($site: ID!, $asOf: Time) {{ siteReview(site: $site, asOf: $asOf) {{
            site location name asOf status summary stageFt observedAt change24hFt categoryNow peakStageFt peakAt categoryPeak
            forecastIssuedAt forecastSource observationFreshness forecastFreshness activeAlerts usgsStageFt usgsObservedAt tidal
            reasons {{ {REASON_FIELDS} }} checks {{ rule outcome }} }} }}"
    );
    // d1 + 4 h: the Flood Watch (seen at d1, gone at d1 + 6 h) is the one reason.
    let body = gql(&state, &q, json!({"site": "BTRL1", "asOf": iso(d1 + 4 * HOUR)})).await;
    let r = &body["data"]["siteReview"];
    assert_eq!((r["site"].as_str(), r["status"].as_str()), (Some("BTRL1"), Some("REVIEW")), "{body}");
    assert_eq!(r["summary"], "Needs review: active_alert.");
    let reasons = r["reasons"].as_array().unwrap();
    assert_eq!(reasons.len(), 1, "{body}");
    assert_eq!(reasons[0]["rule"], "active_alert");
    assert_eq!((reasons[0]["outcome"].as_str(), reasons[0]["severity"].as_str()), (Some("FIRED"), Some("MEDIUM")));
    assert_eq!(reasons[0]["valueText"], "Flood Watch");
    assert_eq!(reasons[0]["source"], "nws");
    assert_eq!(reasons[0]["observedAt"], iso(d1));
    assert_eq!(reasons[0]["evidenceIds"], json!(["alert:urn:oid:2.49.0.1.840.0.1"]));
    assert_eq!(reasons[0]["link"], "https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.1");
    assert_eq!(r["forecastIssuedAt"], iso(d1));
    assert_eq!(r["forecastSource"], "NWPS_LIVE");
    assert_eq!((r["categoryNow"].as_str(), r["categoryPeak"].as_str()), (Some("NONE"), Some("NONE")));
    assert_eq!(r["observedAt"], iso(d1 + 3 * HOUR));
    assert!((r["change24hFt"].as_f64().unwrap() - 0.72).abs() < 1e-9, "{body}");
    assert_eq!((r["observationFreshness"].as_str(), r["forecastFreshness"].as_str()), (Some("FRESH"), Some("FRESH")));
    assert_eq!((r["activeAlerts"].as_i64(), r["tidal"].as_bool(), r["usgsStageFt"].clone()), (Some(1), Some(false), Value::Null));
    let rules: std::collections::BTreeSet<&str> = r["checks"].as_array().unwrap().iter().map(|c| c["rule"].as_str().unwrap()).collect();
    assert_eq!(rules.len(), 7, "every rule checked: {rules:?}");
    // Same site, three hours later: the watch has ended, everything current: OK.
    let body = gql(&state, &q, json!({"site": "btrl1", "asOf": iso(d1 + 7 * HOUR)})).await;
    assert_eq!(body["data"]["siteReview"]["status"], "OK", "{body}");
    assert_eq!(body["data"]["siteReview"]["reasons"], json!([]));
    // Before d0 was captured: the archive forecast is known, but there is no observation 24 h
    // before the newest one, so the 24 h change is unknown: CANNOT_ASSESS, not OK.
    let body = gql(&state, &q, json!({"site": "BTRL1", "asOf": iso(d0 + 30 * 60_000)})).await;
    let r = &body["data"]["siteReview"];
    assert_eq!((r["status"].as_str(), r["forecastSource"].as_str()), (Some("CANNOT_ASSESS"), Some("IEM_ARCHIVE")), "{body}");
    assert_eq!(r["reasons"][0]["rule"], "missing_input");
    assert_eq!(r["reasons"][0]["valueText"], "baseline");
    // By location id; default asOf = now (a year after the seed): everything stale.
    let loc = state.app.cfg.locations.iter().find(|l| l.nwps.as_deref() == Some("BTRL1")).unwrap().id.clone();
    let body = gql(&state, &q, json!({"site": loc})).await;
    let r = &body["data"]["siteReview"];
    assert_eq!((r["site"].as_str(), r["location"].as_str(), r["status"].as_str()), (Some("BTRL1"), Some(loc.as_str()), Some("CANNOT_ASSESS")), "{body}");
    assert_eq!((r["observationFreshness"].as_str(), r["forecastFreshness"].as_str()), (Some("STALE"), Some("STALE")));
    let body = gql(&state, &q, json!({"site": "XXXX1"})).await;
    assert_eq!(error_code(&body), "UNKNOWN_SITE");
}

#[tokio::test]
async fn review_graphql_history_and_board() {
    let (state, _, _, d1) = carp_seeded().await;
    let q = format!(
        "query($site: ID!, $from: Time, $to: Time) {{ reviewHistory(site: $site, from: $from, to: $to) {{
            site from to evaluations initial {{ status }} transitions {{ at from to cleared reasons {{ {REASON_FIELDS} }} }} }} }}"
    );
    let body = gql(&state, &q, json!({"site": "BTRL1", "from": iso(d1 - 2 * HOUR), "to": iso(d1 + 8 * HOUR)})).await;
    let h = &body["data"]["reviewHistory"];
    assert_eq!((h["site"].as_str(), h["initial"]["status"].as_str()), (Some("BTRL1"), Some("OK")), "{body}");
    let t = h["transitions"].as_array().unwrap();
    assert_eq!(t.len(), 2, "{body}");
    assert_eq!((t[0]["at"].as_str(), t[0]["from"].as_str(), t[0]["to"].as_str()), (Some(iso(d1).as_str()), Some("OK"), Some("REVIEW")));
    assert_eq!(t[0]["reasons"][0]["rule"], "active_alert");
    assert_eq!((t[1]["at"].as_str(), t[1]["to"].as_str()), (Some(iso(d1 + 6 * HOUR).as_str()), Some("OK")));
    assert_eq!(t[1]["cleared"], json!(["active_alert"]));
    assert!(h["evaluations"].as_i64().unwrap() > 2);
    // Default window: the 7 days before `to`.
    let body = gql(&state, &q, json!({"site": "BTRL1", "to": iso(d1 + 8 * HOUR)})).await;
    assert_eq!(body["data"]["reviewHistory"]["from"], iso(d1 + 8 * HOUR - 7 * DAY), "{body}");
    // Window validation.
    let body = gql(&state, &q, json!({"site": "BTRL1", "from": iso(d1), "to": iso(d1 - 1)})).await;
    assert!(error_message(&body).contains("`from` must not be after `to`"), "{body}");
    let body = gql(&state, &q, json!({"site": "BTRL1", "from": iso(d1 - 32 * DAY), "to": iso(d1)})).await;
    assert!(error_message(&body).contains("31-day cap"), "{body}");

    const B: &str = "query($asOf: Time) { reviewBoard(asOf: $asOf) { asOf review ok cannotAssess sites { site status reasons { rule } } } }";
    let body = gql(&state, B, json!({"asOf": iso(d1 + 4 * HOUR)})).await;
    let b = &body["data"]["reviewBoard"];
    let n = state.app.cfg.locations.iter().filter(|l| l.nwps.is_some()).count() as i64;
    assert_eq!((b["review"].as_i64(), b["ok"].as_i64(), b["cannotAssess"].as_i64()), (Some(1), Some(0), Some(n - 1)), "{body}");
    let sites = b["sites"].as_array().unwrap();
    assert_eq!(sites.len() as i64, n);
    assert_eq!((sites[0]["site"].as_str(), sites[0]["status"].as_str()), (Some("BTRL1"), Some("REVIEW")), "review ranks first");
    assert!(sites[1..].iter().all(|s| s["status"] == "CANNOT_ASSESS"), "sites with no data are never OK");
    let body = gql(&state, B, json!({"asOf": iso(d1 + 7 * HOUR)})).await;
    assert_eq!((body["data"]["reviewBoard"]["review"].as_i64(), body["data"]["reviewBoard"]["ok"].as_i64()), (Some(0), Some(1)), "{body}");
}

/// Species apps answer every forecast and review query with a typed error and no data.
#[tokio::test]
async fn forecast_graphql_species_apps_get_typed_error() {
    for app in ["python", "lionfish"] {
        let state = crate::app::test_support::test_state_for(app);
        for q in [
            "{ forecasts(site: \"BTRL1\") { site } }",
            "{ forecastVerify(site: \"BTRL1\", issuedAt: \"2026-09-30T15:00:00Z\") { site } }",
            "{ siteStatusAt(site: \"BTRL1\", asOf: \"2026-09-30T15:00:00Z\") { site } }",
            "{ siteReview(site: \"BTRL1\") { site } }",
            "{ reviewHistory(site: \"BTRL1\") { site } }",
            "{ reviewBoard { review } }",
        ] {
            let body = gql(&state, q, json!({})).await;
            assert_eq!(error_code(&body), "NOT_CONDITIONS_APP", "{app}: {body}");
            assert!(error_message(&body).contains(&format!("app {app} has no forecast store (kind species)")), "{body}");
            assert_eq!(body["data"], Value::Null, "{body}");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// L5: Lionfish Watch component scoring over GraphQL (gates/leaf-L5.md G2, G3, G5).
// ---------------------------------------------------------------------------------------------

/// A lionfish state with the physical sources seeded and one report at `fl-keys:100:100`
/// (research grade, 30 m accuracy, observed `t - 10 d`, submitted `t - 1 d`) and a CRW pixel on
/// that cell (DHW 13.65, BAA 1, product `t - 2 d`, ingested `t - 1 d`). Returns the state, the
/// sighting id and the station id.
async fn lionfish_seeded(t: i64) -> (AppState, i64, i64) {
    let state = crate::app::test_support::test_state_for("lionfish");
    seed_sources(&state.obs).await;
    state
        .obs
        .write(|tx| {
            for id in ["crw", "openmeteo-marine"] {
                tx.execute(
                    "insert or ignore into sources (id, name, homepage, mode, cadence_s, max_latency_s) values (?1, ?1, 'https://example.test', 'poll', 3600, 7200)",
                    [id],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
    let fl = state.app.region("fl-keys").unwrap();
    let (lon, lat) = fl.grid.center(fl.grid.index(100, 100));
    let sighting = insert_sighting(&state.obs, "inat", 4, lat, lon, t - 10 * DAY, "research", None).await;
    let photo = "https://static.inaturalist.org/photos/9/medium.jpg";
    state
        .obs
        .write(move |tx| {
            tx.execute(
                "update sightings set accuracy_m = 30, submitted_at = ?2, ingested_at = ?2, photo_url = ?3 where id = ?1",
                params![sighting, t - DAY, photo],
            )
        })
        .await
        .unwrap();
    let station = insert_station(&state.obs, "crw", "24.525,-81.375", lat, lon, "grid").await;
    let product = t - 2 * DAY;
    state
        .obs
        .write(move |tx| {
            tx.execute(
                "insert into raw_objects (r2_key, source_id, source_url, fetched_at, bytes, sha256) values ('crw/x', 'crw', 'https://example.test/crw', ?1, 1, 'x')",
                [t - DAY],
            )?;
            let raw = tx.last_insert_rowid();
            for (p, v) in [("dhw", 13.65), ("baa", 1.0), ("sst", 30.2), ("sst_anomaly", 1.1)] {
                tx.execute(
                    "insert into readings (station_id, param, value, flag, observed_at, origin, raw_object_id) values (?1, ?2, ?3, 'ok', ?4, 'satellite', ?5)",
                    params![station, p, v, product, raw],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
    (state, sighting, station)
}

fn hull_json(state: &AppState) -> Value {
    let b = state.app.hull();
    json!({"west": b.west, "south": b.south, "east": b.east, "north": b.north})
}

/// Every hotspot type's field names: nothing is called risk, probability or percent.
#[test]
fn lionfish_hotspots_graphql_schema_has_no_risk_probability_or_percent_field() {
    use async_graphql::parser::types::{TypeKind, TypeSystemDefinition};
    let sdl = crate::graphql::schema().sdl();
    let doc = async_graphql::parser::parse_schema(&sdl).unwrap();
    let mut checked = 0;
    for def in doc.definitions {
        let TypeSystemDefinition::Type(t) = def else { continue };
        let name = t.node.name.node.to_string();
        if !(name.starts_with("Hotspot") || name == "HeatStress" || name == "FieldWindow" || name == "Backtest") {
            continue;
        }
        let fields: Vec<String> = match &t.node.kind {
            TypeKind::Object(o) => o.fields.iter().map(|f| f.node.name.node.to_string()).collect(),
            TypeKind::InputObject(i) => i.fields.iter().map(|f| f.node.name.node.to_string()).collect(),
            _ => continue,
        };
        for f in fields {
            let lower = f.to_ascii_lowercase();
            assert!(!lower.contains("risk") && !lower.contains("probab") && !lower.contains("percent"), "{name}.{f}");
            checked += 1;
        }
    }
    assert!(checked >= 40, "only {checked} fields checked");
}

#[tokio::test]
async fn lionfish_hotspots_graphql_components_region_and_weights() {
    let t = ms(2026, 9, 30, 12);
    let (state, sighting, station) = lionfish_seeded(t).await;
    const Q: &str = "query($at: Time!, $bbox: BBox!, $region: ID, $weights: HotspotWeightsInput, $basis: HotspotBasis) {
        hotspots(species: \"lionfish\", at: $at, bbox: $bbox, top: 50, region: $region, weights: $weights, basis: $basis) {
          species at basis weights { recentReports idQuality heatStress }
          cells { cell regionId score rankScore thin
            components {
              recentReports { id value state weight inputs }
              idQuality { value state inputs }
              heatStress { value state weight inputs }
              completeness { value state weight inputs } }
            heat { dhw baa sst anomaly observedAt ingestedAt station credit }
            fieldWindow { state } } } }";
    let bbox = hull_json(&state);
    let body = gql(&state, Q, json!({"at": iso(t), "bbox": bbox})).await;
    let grid = &body["data"]["hotspots"];
    assert_eq!(grid["basis"], "SUBMITTED", "{body}");
    assert_eq!(grid["weights"], json!({"recentReports": 1.0, "idQuality": 1.0, "heatStress": 1.0}));
    let cell = &grid["cells"][0];
    assert_eq!(cell["cell"], "fl-keys:100:100");
    assert_eq!(cell["regionId"], "fl-keys");
    assert_eq!(cell["rankScore"], 1.0);
    assert_eq!(cell["score"], 1.0);
    assert_eq!(cell["thin"], true, "one report in 90 d");
    let c = &cell["components"];
    assert_eq!(c["recentReports"]["value"], 1.0);
    assert_eq!(c["recentReports"]["state"], "OK");
    assert_eq!(c["recentReports"]["inputs"], json!([format!("sighting:{sighting}")]));
    assert_eq!(c["idQuality"]["value"], 1.0);
    assert_eq!(c["heatStress"]["value"], 1.0);
    assert_eq!(c["heatStress"]["inputs"][0], format!("reading:{station}:dhw:{}:satellite", t - 2 * DAY));
    assert_eq!(c["completeness"]["weight"], 0.0);
    assert!(c["completeness"]["value"].as_f64().unwrap() < 0.5);
    assert_eq!((cell["heat"]["dhw"].as_f64(), cell["heat"]["baa"].as_f64()), (Some(13.65), Some(1.0)), "both shown");
    assert_eq!(cell["heat"]["observedAt"], iso(t - 2 * DAY));
    assert!(cell["heat"]["credit"].as_str().unwrap().contains("NOAA Coral Reef Watch"));
    assert_eq!(cell["fieldWindow"], Value::Null, "no marine forecast stored");
    // Region filter and per-query weights.
    let body = gql(&state, Q, json!({"at": iso(t), "bbox": bbox, "region": "mx-caribbean"})).await;
    assert_eq!(body["data"]["hotspots"]["cells"], json!([]), "{body}");
    let body = gql(&state, Q, json!({"at": iso(t), "bbox": bbox, "weights": {"recentReports": 0, "idQuality": 0, "heatStress": 2}})).await;
    let grid = &body["data"]["hotspots"];
    assert_eq!(grid["weights"]["heatStress"], 2.0, "{body}");
    for c in grid["cells"].as_array().unwrap() {
        assert_eq!((c["rankScore"].as_f64(), c["components"]["heatStress"]["weight"].as_f64()), (Some(1.0), Some(2.0)), "{c}");
    }
    let body = gql(&state, Q, json!({"at": iso(t), "bbox": bbox, "weights": {"recentReports": 0, "idQuality": 0, "heatStress": 0}})).await;
    assert!(error_message(&body).contains("weights must not all be 0"), "{body}");
    let body = gql(&state, Q, json!({"at": iso(t), "bbox": bbox, "region": "atlantis"})).await;
    assert!(error_message(&body).contains("unknown region") && error_message(&body).contains("fl-keys"), "{body}");
    // Python keeps its product score and rejects the component arguments.
    let python = seeded().await;
    let pr = region(&python);
    let body = gql(&python, &format!("{{ hotspots(species: \"python\", at: \"{}\", bbox: {pr}, region: \"x\") {{ species }} }}", iso(t)), json!({})).await;
    assert!(error_message(&body).contains("component apps only"), "{body}");
    let body = gql(&python, &format!("{{ hotspots(species: \"python\", at: \"{}\", bbox: {pr}) {{ weights {{ heatStress }} cells {{ cell }} }} }}", iso(t)), json!({})).await;
    assert_eq!(body["data"]["hotspots"]["weights"], Value::Null, "{body}");
}

#[tokio::test]
async fn lionfish_explain_graphql_lists_records_dates_and_caveats() {
    let t = ms(2026, 9, 30, 12);
    let (state, sighting, station) = lionfish_seeded(t).await;
    // A GBIF copy of the iNat record: listed as not counted.
    let fl = state.app.region("fl-keys").unwrap();
    let (lon, lat) = fl.grid.center(fl.grid.index(100, 100));
    state
        .obs
        .write(move |tx| {
            tx.execute(
                "insert into sightings (source_id, ext_id, taxon_id, lat, lon, observed_at, quality, canonical_id, ingested_at) values ('gbif', '50c9509d-22c7-4a22-a47d-8c48425ef4a7:1:1', 4, ?1, ?2, ?3, 'research', ?4, ?3)",
                params![lat, lon, t - 10 * DAY, sighting],
            )
        })
        .await
        .unwrap();
    const Q: &str = "query($cell: ID!, $at: Time!) { explainCell(cell: $cell, species: \"lionfish\", at: $at) {
        cell regionId rankScore thin basis credit caveats weights { recentReports }
        components { recentReports { value inputs evidence { id kind observedAt submittedAt ingestedAt weight detail url } }
                     heatStress { value state evidence { id observedAt ingestedAt detail url } }
                     completeness { inputs } }
        heat { dhw baa observedAt ingestedAt station } } }";
    let body = gql(&state, Q, json!({"cell": "fl-keys:100:100", "at": iso(t)})).await;
    let ex = &body["data"]["explainCell"];
    assert_eq!(ex["cell"], "fl-keys:100:100", "{body}");
    assert_eq!(ex["rankScore"], 1.0);
    let reports = ex["components"]["recentReports"]["evidence"].as_array().unwrap();
    assert_eq!(reports.len(), 2, "{body}");
    let mine = reports.iter().find(|e| e["id"] == format!("sighting:{sighting}")).unwrap();
    assert_eq!((mine["observedAt"].as_str(), mine["submittedAt"].as_str()), (Some(iso(t - 10 * DAY).as_str()), Some(iso(t - DAY).as_str())));
    assert_eq!(mine["url"], "https://static.inaturalist.org/photos/9/medium.jpg");
    assert!(mine["weight"].as_f64().unwrap() > 0.8);
    let copy = reports.iter().find(|e| e["id"] != format!("sighting:{sighting}")).unwrap();
    assert_eq!(copy["weight"], Value::Null);
    assert!(copy["detail"].as_str().unwrap().contains("not counted"), "{copy}");
    assert_eq!(ex["components"]["recentReports"]["inputs"], json!([format!("sighting:{sighting}")]), "the copy never double-counts");
    let heat = ex["components"]["heatStress"]["evidence"].as_array().unwrap();
    assert_eq!(heat[0]["id"], format!("reading:{station}:dhw:{}:satellite", t - 2 * DAY));
    assert_eq!((heat[0]["observedAt"].as_str(), heat[0]["ingestedAt"].as_str()), (Some(iso(t - 2 * DAY).as_str()), Some(iso(t - DAY).as_str())));
    assert!(heat[0]["detail"].as_str().unwrap().contains("13.65"));
    assert_eq!(heat[0]["url"], crate::source_pages::CRW_DOI);
    assert_eq!(ex["heat"]["station"], station.to_string());
    assert!(ex["credit"].as_str().unwrap().contains("NOAA Coral Reef Watch"));
    let caveats: Vec<&str> = ex["caveats"].as_array().unwrap().iter().map(|c| c.as_str().unwrap()).collect();
    assert!(
        caveats.iter().any(|c| c.contains("not abundance")) && caveats.iter().any(|c| c.contains("context")) && caveats.iter().any(|c| c.contains("No causal claim")),
        "{caveats:?}"
    );
    assert!(ex["components"]["completeness"]["inputs"].as_array().unwrap().iter().any(|i| i.as_str().unwrap().starts_with("crw: ok")));
    // Evidence ids keep the shape and carry the same components.
    let body = gql(&state, "query($id: ID!) { evidence(id: $id) { id kind record } }", json!({"id": format!("hotspot:lionfish:fl-keys:100:100:{t}")})).await;
    let rec = &body["data"]["evidence"]["record"];
    assert_eq!(rec["cell"], "fl-keys:100:100", "{body}");
    assert_eq!(rec["rankScore"], 1.0);
    assert_eq!(rec["components"]["recentReports"]["inputs"], json!([format!("sighting:{sighting}")]));
    assert_eq!(rec["components"]["heatStress"]["state"], "ok");
    assert_eq!(rec["heat"]["dhw"], 13.65);
    assert_eq!(rec["caveats"].as_array().unwrap().len(), 4);
    let body = gql(&state, Q, json!({"cell": "fl-keys:999:0", "at": iso(t)})).await;
    assert!(error_message(&body).contains("bad cell id"), "{body}");
}

/// The frame at `t` knows only what was submitted by `t` (observed-date basis on request); the
/// CRW product counts from its ingest time; two times give two grids, in `hotspots` and in frames.
#[tokio::test]
async fn lionfish_asof_submitted_basis_and_frames() {
    let t = ms(2026, 9, 30, 12);
    let (state, _, _) = lionfish_seeded(t).await;
    let bbox = hull_json(&state);
    const Q: &str = "query($at: Time!, $bbox: BBox!, $basis: HotspotBasis) {
        hotspots(species: \"lionfish\", at: $at, bbox: $bbox, top: 1, basis: $basis) { basis cells { cell rankScore
          components { recentReports { value state } heatStress { value state } } } } }";
    // t - 5 d: the report (submitted t - 1 d) and the product (ingested t - 1 d) are not known yet.
    let body = gql(&state, Q, json!({"at": iso(t - 5 * DAY), "bbox": bbox})).await;
    assert_eq!(body["data"]["hotspots"]["cells"], json!([]), "{body}");
    // Observed-date basis: the report counts from its observed date, the product still does not.
    let body = gql(&state, Q, json!({"at": iso(t - 5 * DAY), "bbox": bbox, "basis": "OBSERVED"})).await;
    let cell = &body["data"]["hotspots"]["cells"][0];
    assert_eq!(body["data"]["hotspots"]["basis"], "OBSERVED", "{body}");
    assert_eq!(cell["cell"], "fl-keys:100:100");
    assert_eq!(cell["components"]["recentReports"]["value"], 1.0);
    assert_eq!(cell["components"]["heatStress"]["state"], "UNKNOWN");
    assert!((cell["rankScore"].as_f64().unwrap() - 2.0 / 3.0).abs() < 1e-6);
    // t - 36 h: the product day (t - 2 d) is past but its ingest (t - 1 d) is not: still unknown.
    let body = gql(&state, Q, json!({"at": iso(t - 36 * HOUR), "bbox": bbox, "basis": "OBSERVED"})).await;
    assert_eq!(body["data"]["hotspots"]["cells"][0]["components"]["heatStress"]["state"], "UNKNOWN", "{body}");
    // t: everything known; the grid differs from t - 5 d.
    let body = gql(&state, Q, json!({"at": iso(t), "bbox": bbox})).await;
    let cell = &body["data"]["hotspots"]["cells"][0];
    assert_eq!((cell["cell"].as_str(), cell["rankScore"].as_f64()), (Some("fl-keys:100:100"), Some(1.0)), "{body}");

    // Frames carry the ranked grid per region: the fl-keys hotspot byte of cell (100,100) is 0 at
    // t - 5 d and 100 at t, and the mx-caribbean section stays empty.
    let hs = |bytes: &[u8], region_idx: usize, col: u32, row: u32| -> u8 {
        let h = crate::frames::read_header(bytes).unwrap();
        let mut offset = h.len();
        for r in &state.app.regions[..region_idx] {
            offset += r.layout.body_len(1, 0);
        }
        let layout = state.app.regions[region_idx].layout;
        bytes[offset + (row / 2 * layout.hs.cols + col / 2) as usize]
    };
    let mut grids = Vec::new();
    for at in [t - 5 * DAY, t] {
        let body = gql(&state, &format!("{{ frames(from: \"{}\", to: \"{}\", stepMinutes: 60) {{ frameCount data }} }}", iso(at), iso(at)), json!({})).await;
        assert_eq!(body["data"]["frames"]["frameCount"], 1, "{body}");
        let bytes = base64::engine::general_purpose::STANDARD.decode(body["data"]["frames"]["data"].as_str().unwrap()).unwrap();
        grids.push((hs(&bytes, 0, 100, 100), hs(&bytes, 1, 20, 30)));
    }
    assert_eq!(grids, [(0, 0), (100, 0)]);
}

#[tokio::test]
async fn lionfish_backtest_graphql_reports_horizon_and_thin_regions() {
    let state = crate::app::test_support::test_state_for("lionfish");
    seed_sources(&state.obs).await;
    let today = crate::hotspot::backtest::floor_day(crate::state::now_ms());
    let fl = state.app.region("fl-keys").unwrap();
    let (lon, lat) = fl.grid.center(fl.grid.index(100, 100));
    // Four reports at A over the month before the window, then three more at A in the week after
    // the single evaluation day (all hits) and one far away (a miss).
    for d in [40, 35, 30, 25] {
        insert_sighting(&state.obs, "inat", 4, lat, lon, today - d * DAY, "research", None).await;
    }
    for d in [7, 5, 3] {
        insert_sighting(&state.obs, "inat", 4, lat, lon, today - d * DAY + HOUR, "research", None).await;
    }
    let (lon_b, lat_b) = fl.grid.center(fl.grid.index(300, 300));
    insert_sighting(&state.obs, "inat", 4, lat_b, lon_b, today - 6 * DAY, "research", None).await;
    let body = gql(
        &state,
        "{ backtest(species: \"lionfish\", days: 1) { species days horizonDays evaluated hits hitRate baseline insufficientRegions note perDay { day sightings hits } } }",
        json!({}),
    )
    .await;
    let bt = &body["data"]["backtest"];
    assert_eq!(bt["horizonDays"], 7, "{body}");
    assert_eq!((bt["evaluated"].as_i64(), bt["hits"].as_i64()), (Some(4), Some(3)));
    assert_eq!(bt["hitRate"], 0.75);
    assert_eq!(bt["baseline"], 0.1);
    assert_eq!(bt["insufficientRegions"], json!(["mx-caribbean", "belize", "co-caribbean"]));
    assert!(bt["note"].as_str().unwrap().contains("observer effort"), "{body}");
    assert_eq!(bt["perDay"], json!([{"day": iso(today - 8 * DAY), "sightings": 4, "hits": 3}]));
}
