//! End to end on fixtures (node-data N3). `backfill --fixtures` runs exactly as the CLI does
//! (every source with recorded payloads: physical pollers, GOES, NWWS, bio pollers; then the
//! 30-day frame rebuild) into a memory state. Every read surface is then queried through the real
//! router: GraphQL `feeds`, `sightings`, `readings`, `alerts`, `frames`, `hotspots`, `evidence`,
//! and REST `GET /v1/frames`.
//!
//! Query windows are taken from the ingested data, not the wall clock, so the test does not rot
//! as the fixtures age.

use std::collections::HashMap;
use std::io::Read as _;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use base64::Engine;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::app::test_support::test_state;
use crate::backfill::{fixture_sources, measure};
use crate::frames::{self, Layout, ENV_MISSING, HEADER_BYTES};
use crate::state::AppState;

const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;

fn region() -> Value {
    json!({"west": -83.2, "south": 24.3, "east": -79.8, "north": 27.5})
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// POST a GraphQL request through the router; returns `data`, failing on any error.
async fn gql(state: &AppState, query: &str, variables: Value) -> Value {
    let res = crate::app::app(state.clone())
        .oneshot(
            Request::post("/v1/graphql")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"query": query, "variables": variables}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert!(body.get("errors").is_none(), "{query}: {body}");
    body["data"].clone()
}

async fn int(state: &AppState, sql: &'static str) -> i64 {
    state
        .obs
        .read(move |c| c.query_row(sql, [], |r| r.get(0)))
        .await
        .unwrap()
}

/// Number of env cells in `body` (one EVF2 frame body) with an LST value.
fn lst_cells(body: &[u8]) -> usize {
    let layout = Layout::REGION;
    let lst = &body[layout.lst_offset()..layout.sst_offset()];
    lst.chunks_exact(2)
        .filter(|b| i16::from_le_bytes([b[0], b[1]]) != ENV_MISSING)
        .count()
}

/// Split an EVF2 chunk into its frame bodies, checking every length on the way.
fn bodies(chunk: &[u8]) -> Vec<&[u8]> {
    let h = frames::read_header(chunk).unwrap();
    let layout = Layout::REGION;
    let mut out = Vec::new();
    let mut at = HEADER_BYTES;
    for _ in 0..h.frame_count {
        let n_off = at + layout.sightings_offset();
        let n = u32::from_le_bytes(chunk[n_off..n_off + 4].try_into().unwrap()) as usize;
        let len = layout.body_len(n);
        out.push(&chunk[at..at + len]);
        at += len;
    }
    assert_eq!(at, chunk.len(), "chunk is exactly its frames");
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn e2e_fixture_pipeline() {
    let state = test_state();

    // 1. The CLI path: `inversa-api backfill --fixtures`.
    crate::backfill::run(state.clone(), &["--fixtures".to_string()])
        .await
        .unwrap();

    let sources: Vec<&'static str> = fixture_sources(&state.config)
        .iter()
        .map(|s| s.info().id)
        .collect();
    assert_eq!(
        sources,
        [
            "nws",
            "usgs",
            "ndbc",
            "coops",
            "openmeteo",
            "goes19",
            "nwws",
            "inat",
            "nas",
            "gbif"
        ]
    );
    for id in &sources {
        let m = measure(&state, id).await.unwrap();
        assert!(
            m.sightings + m.readings + m.alerts > 0,
            "{id} ingested nothing: {m:?}"
        );
    }
    let goes = measure(&state, "goes19").await.unwrap();
    assert!(
        goes.stations > 1000 && goes.readings > 1000,
        "GOES cells: {goes:?}"
    );
    // The rebuild stored the hourly frames of the last 30 days.
    assert!(int(&state, "select count(*) from frames").await >= 720);

    // 2. feeds: every fixture source listed, and `lastFetchRunId` is the newest fetch run.
    let data = gql(
        &state,
        "{ feeds { source mode state lastFetchAt lastFetchRunId note } }",
        json!({}),
    )
    .await;
    let feeds: HashMap<String, Value> = data["feeds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| (f["source"].as_str().unwrap().to_string(), f.clone()))
        .collect();
    let newest_runs: HashMap<String, i64> = state
        .obs
        .read(|c| {
            c.prepare(
                "select source_id, id from fetch_runs f where id = (select id from fetch_runs g where g.source_id = f.source_id
                 order by fetched_at desc, id desc limit 1)",
            )?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect()
        })
        .await
        .unwrap();
    for id in &sources {
        let feed = feeds
            .get(*id)
            .unwrap_or_else(|| panic!("{id} missing from feeds"));
        let run = feed["lastFetchRunId"]
            .as_str()
            .unwrap_or_else(|| panic!("{id}: no lastFetchRunId: {feed}"));
        assert_eq!(run, newest_runs[*id].to_string(), "{id}");
        let ev = gql(
            &state,
            "query($id: ID!) { evidence(id: $id) { id kind record } }",
            json!({"id": format!("fetch:{run}")}),
        )
        .await;
        assert_eq!(ev["evidence"]["kind"], "fetch", "{id}");
        assert_eq!(ev["evidence"]["record"]["source"].as_str(), Some(*id));
    }

    // 3. sightings in the region over the 31 days up to the newest one.
    let newest = int(&state, "select max(observed_at) from sightings").await;
    let data = gql(
        &state,
        "query($b: BBox!, $f: Time!, $t: Time!) { sightings(bbox: $b, from: $f, to: $t) { id source lat lon taxon { id } observedAt } }",
        json!({"b": region(), "f": iso(newest - 31 * DAY + 1), "t": iso(newest)}),
    )
    .await;
    let sightings = data["sightings"].as_array().unwrap();
    assert!(
        !sightings.is_empty(),
        "sightings in the last 31 days of fixture data"
    );
    for s in sightings {
        let (lat, lon) = (s["lat"].as_f64().unwrap(), s["lon"].as_f64().unwrap());
        assert!(
            (24.3..=27.5).contains(&lat) && (-83.2..=-79.8).contains(&lon),
            "{s}"
        );
    }

    // 4. evidence on a sighting: record, archived raw payload, and the same feed envelope.
    let sighting = &sightings[0];
    let data = gql(
        &state,
        "query($id: ID!) { evidence(id: $id) { id kind record rawKey sourceUrl fetchedAt feed { source lastFetchRunId } } }",
        json!({"id": format!("sighting:{}", sighting["id"].as_str().unwrap())}),
    )
    .await;
    let ev = &data["evidence"];
    assert_eq!(ev["kind"], "sighting");
    assert!(
        ev["rawKey"]
            .as_str()
            .unwrap()
            .starts_with(&format!("raw/{}/", sighting["source"].as_str().unwrap())),
        "{ev}"
    );
    assert!(
        ev["sourceUrl"].as_str().unwrap().starts_with("https://"),
        "{ev}"
    );
    assert_eq!(
        ev["feed"]["lastFetchRunId"],
        feeds[sighting["source"].as_str().unwrap()]["lastFetchRunId"]
    );

    // 5. readings around the GOES scan, and evidence on one GOES reading.
    let (station, param, at, origin): (i64, String, i64, String) = state
        .obs
        .read(|c| {
            c.query_row(
                "select r.station_id, r.param, r.observed_at, r.origin from readings r join stations s on s.id = r.station_id
                 where s.source_id = 'goes19' and r.param = 'lst_c' and r.value is not null order by r.station_id limit 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
        })
        .await
        .unwrap();
    let data = gql(
        &state,
        "query($b: BBox!, $f: Time!, $t: Time!) { readings(bbox: $b, from: $f, to: $t, params: [LST_C]) { station { source } value flag origin } }",
        json!({"b": region(), "f": iso(at - HOUR), "t": iso(at + HOUR)}),
    )
    .await;
    let readings = data["readings"].as_array().unwrap();
    assert!(readings.iter().any(|r| r["station"]["source"] == "goes19"
        && r["origin"] == "SATELLITE"
        && r["value"].is_number()));
    let reading_id = format!("reading:{station}:{param}:{at}:{origin}");
    let data = gql(
        &state,
        "query($id: ID!) { evidence(id: $id) { id kind record rawKey feed { source lastFetchRunId } } }",
        json!({"id": reading_id}),
    )
    .await;
    let ev = &data["evidence"];
    assert_eq!(
        (ev["id"].as_str(), ev["kind"].as_str()),
        (Some(reading_id.as_str()), Some("reading"))
    );
    assert!(
        ev["rawKey"].as_str().unwrap().starts_with("raw/goes19/"),
        "{ev}"
    );
    assert_eq!(ev["feed"]["source"], "goes19");
    assert_eq!(
        ev["feed"]["lastFetchRunId"],
        feeds["goes19"]["lastFetchRunId"]
    );

    // 6. alerts active at the onset of a stored alert.
    let onset = int(&state, "select min(onset) from alerts where onset is not null and (expires is null or expires > onset)").await;
    let data = gql(
        &state,
        "query($b: BBox!, $at: Time!) { alerts(bbox: $b, at: $at) { id event severity } }",
        json!({"b": region(), "at": iso(onset)}),
    )
    .await;
    assert!(
        !data["alerts"].as_array().unwrap().is_empty(),
        "alerts at {}",
        iso(onset)
    );

    // 7. frames: 24 hourly frames ending at the first frame after the GOES scan, which carries
    //    its LST cells (a frame reads conditions observed at or before its time).
    let to = frames::align(at, HOUR) + HOUR;
    let from = to - 23 * HOUR;
    let data = gql(
        &state,
        "query($f: Time!, $t: Time!) { frames(from: $f, to: $t, stepMinutes: 60) { frameCount stepMinutes data } }",
        json!({"f": iso(from), "t": iso(to)}),
    )
    .await;
    assert_eq!(data["frames"]["frameCount"], 24);
    let chunk = base64::engine::general_purpose::STANDARD
        .decode(data["frames"]["data"].as_str().unwrap())
        .unwrap();
    let h = frames::read_header(&chunk).unwrap();
    assert_eq!((h.frame_count, h.frame0, h.step_min), (24, from, 60));
    let gql_bodies = bodies(&chunk);
    assert!(
        lst_cells(gql_bodies[23]) > 100,
        "GOES LST reaches the frame at {}",
        iso(to)
    );

    // 8. REST bulk frames: same window, gzip EVF2, identical bytes to the GraphQL chunk.
    let res = crate::app::app(state.clone())
        .oneshot(
            Request::get(format!("/v1/frames?from={from}&to={to}&step=60"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()[header::CONTENT_TYPE], frames::CONTENT_TYPE);
    assert_eq!(res.headers()[header::CONTENT_ENCODING], "gzip");
    let gz = res.into_body().collect().await.unwrap().to_bytes();
    let mut rest = Vec::new();
    flate2::read::GzDecoder::new(&gz[..])
        .read_to_end(&mut rest)
        .unwrap();
    assert_eq!(rest, chunk, "REST and GraphQL serve the same frames");

    // 9. hotspots for iguana at its newest sighting.
    let iguana_at = int(
        &state,
        "select max(observed_at) from sightings where taxon_id = 3",
    )
    .await;
    let data = gql(
        &state,
        "query($at: Time!, $b: BBox!) { hotspots(species: \"iguana\", at: $at, bbox: $b, top: 20) { species cells { cell score } } }",
        json!({"at": iso(iguana_at), "b": region()}),
    )
    .await;
    let cells = data["hotspots"]["cells"].as_array().unwrap();
    assert!(!cells.is_empty(), "iguana hotspots at {}", iso(iguana_at));
    assert!(cells.iter().all(|c| c["score"].as_f64().unwrap() > 0.0));
}
