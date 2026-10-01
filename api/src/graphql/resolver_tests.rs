//! One test per query resolver against a seeded memory DB (`resolver_*`), plus `applyOps`
//! validation and the `ops` subscription end to end over a real socket (`subscription_ops*`).

use std::time::Duration;

use axum::http::StatusCode;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use rusqlite::params;
use serde_json::{json, Value};

use super::tests::post;
use crate::app::test_support::test_state;
use crate::hotspot::score::testkit::{insert_readings, insert_sighting, insert_station, ms, seed_sources, DAY, HOUR};
use crate::hotspot::Grid;
use crate::state::AppState;

async fn seeded() -> AppState {
    let state = test_state();
    seed_sources(&state.obs).await;
    state
}

async fn gql(state: &AppState, query: &str, variables: Value) -> Value {
    let (status, body) = post(crate::app::app(state.clone()), json!({"query": query, "variables": variables})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
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

const REGION: &str = "{west: -83.2, south: 24.3, east: -79.8, north: 27.5}";

#[tokio::test]
async fn resolver_feeds() {
    let state = seeded().await;
    let now = chrono::Utc::now().timestamp_millis();
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
    insert_sighting(&state.obs, "inat", 3, 25.6, -80.8, t + 2 * HOUR, "needs_id", None).await; // iguana
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
    assert_eq!(rows[0]["taxon"]["commonName"], "Green iguana");
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
    let body = gql(&state, q, vars(json!(["1", "3"]), json!(["RESEARCH", "NEEDS_ID"]))).await;
    assert_eq!(body["data"]["sightings"].as_array().unwrap().len(), 2);
    let body = gql(&state, q, vars(json!(["otter"]), Value::Null)).await;
    assert!(error_message(&body).contains("unknown taxon"), "{body}");

    // Validation: bbox outside the region, inverted window, window over 31 days.
    let body = gql(
        &state,
        "{ sightings(bbox: {west: -90, south: 24.3, east: -80, north: 27}, from: \"2026-09-01T00:00:00Z\", to: \"2026-09-02T00:00:00Z\") { id } }",
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
        &format!("{{ sightings(bbox: {REGION}, from: \"{}\", to: \"{}\") {{ extId }} }}", iso(t), iso(t + DAY)),
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
    let g = Grid::REGION;
    let (lon, lat) = g.center(g.index(120, 100));
    insert_sighting(&state.obs, "inat", 4, lat, lon, t - HOUR, "research", None).await;
    let body = gql(
        &state,
        &format!("{{ hotspots(species: \"lionfish\", at: \"{}\", bbox: {REGION}, top: 5) {{ species at cells {{ cell lat lon score }} }} }}", iso(t)),
        json!({}),
    )
    .await;
    let grid = &body["data"]["hotspots"];
    assert_eq!(grid["species"], "lionfish", "{body}");
    let cells = grid["cells"].as_array().unwrap();
    assert_eq!(cells.len(), 5);
    assert_eq!(cells[0]["cell"], "120:100");
    assert_eq!(cells[0]["score"], 1.0);
    assert!((cells[0]["lat"].as_f64().unwrap() - lat).abs() < 1e-9);

    let body = gql(&state, &format!("{{ hotspots(species: \"otter\", at: \"{}\", bbox: {REGION}) {{ species }} }}", iso(t)), json!({})).await;
    assert!(error_message(&body).contains("unknown species"), "{body}");
    let body = gql(&state, &format!("{{ hotspots(species: \"4\", at: \"{}\", bbox: {REGION}, top: 0) {{ species }} }}", iso(t)), json!({})).await;
    assert!(error_message(&body).contains("top"), "{body}");
}

#[tokio::test]
async fn resolver_explain_cell() {
    let state = seeded().await;
    let t = ms(2025, 6, 1, 12);
    let g = Grid::REGION;
    let (lon, lat) = g.center(g.index(120, 100));
    insert_sighting(&state.obs, "inat", 4, lat, lon, t - HOUR, "research", None).await;
    let body = gql(
        &state,
        &format!("{{ explainCell(cell: \"120:100\", species: \"lionfish\", at: \"{}\") {{ cell species at score terms {{ name value rationale }} }} }}", iso(t)),
        json!({}),
    )
    .await;
    let ex = &body["data"]["explainCell"];
    assert_eq!(ex["score"], 1.0, "{body}");
    assert_eq!(ex["at"], iso(t));
    let terms = ex["terms"].as_array().unwrap();
    assert!(terms.iter().any(|x| x["name"] == "access.lionfish_sea_state" && x["rationale"].as_str().unwrap().starts_with("no data")), "{body}");
    let body = gql(&state, &format!("{{ explainCell(cell: \"999:1\", species: \"lionfish\", at: \"{}\") {{ score }} }}", iso(t)), json!({})).await;
    assert!(error_message(&body).contains("bad cell id"), "{body}");
}

#[tokio::test]
async fn resolver_backtest() {
    let state = seeded().await;
    let g = Grid::REGION;
    let today = crate::hotspot::backtest::floor_day(chrono::Utc::now().timestamp_millis());
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
        crate::app::app(state.clone()),
        axum::http::Request::post("/v1/graphql")
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
    let window = "from: \"2026-09-01T00:00:00Z\", to: \"2026-09-02T00:00:00Z\"";
    let fanned: Vec<String> = (0..20).map(|i| format!("s{i}: sightings(bbox: {REGION}, {window}) {{ id }}")).collect();
    let body = gql(&state, &format!("{{ {} }}", fanned.join(" ")), json!({})).await;
    assert!(body["data"].is_null(), "{body}");
    assert!(error_message(&body).contains("complex"), "{body}");

    // A handful of heavy fields is fine.
    let few: Vec<String> = (0..3).map(|i| format!("s{i}: sightings(bbox: {REGION}, {window}) {{ id lat lon }}")).collect();
    let body = gql(&state, &format!("{{ {} feeds {{ source }} }}", few.join(" ")), json!({})).await;
    assert!(body["errors"].is_null(), "{body}");

    // The alert-band document the HUD sends for a 30-day window at 3 h spacing.
    let bands: Vec<String> = (0..241)
        .map(|i| format!("a{i}: alerts(bbox: {REGION}, at: \"{}\") {{ id event severity headline onset expires }}", iso(ms(2026, 9, 1, 0) + i * 3 * HOUR)))
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
    let app = crate::app::app(state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await });

    let mut req = format!("ws://{addr}/v1/graphql").into_client_request().unwrap();
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
                .post(format!("http://{addr}/v1/graphql"))
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
        .post(format!("http://{addr}/v1/graphql"))
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
