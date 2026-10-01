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

use crate::app::test_support::{router_for, test_state};
use crate::backfill::{fixture_sources, measure};
use crate::frames::{self, Layout, ENV_FLAGGED, ENV_MISSING, HEADER_BYTES};
use crate::state::AppState;

const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;
/// The python app's four taxa.
const TAXA: usize = 4;

/// The python app's region (its one region), as a GraphQL `BBox` variable.
fn region(state: &AppState) -> Value {
    let b = state.app.hull();
    json!({"west": b.west, "south": b.south, "east": b.east, "north": b.north})
}

fn layout(state: &AppState) -> Layout {
    state.app.regions[0].layout
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// POST a GraphQL request through the router; returns `data`, failing on any error.
async fn gql(state: &AppState, query: &str, variables: Value) -> Value {
    let res = router_for(state)
        .oneshot(
            Request::post("/v1/python/graphql")
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
fn lst_cells(layout: &Layout, body: &[u8]) -> usize {
    let lst = &body[layout.lst_offset(TAXA)..layout.sst_offset(TAXA)];
    lst.chunks_exact(2)
        .filter(|b| !matches!(i16::from_le_bytes([b[0], b[1]]), ENV_MISSING | ENV_FLAGGED))
        .count()
}

/// Split an EVF2 chunk into its frame bodies, checking every length on the way.
fn bodies<'a>(layout: &Layout, chunk: &'a [u8]) -> Vec<&'a [u8]> {
    let h = frames::read_header(chunk).unwrap();
    assert_eq!(h.region_count, 1);
    let mut out = Vec::new();
    let mut at = HEADER_BYTES;
    for _ in 0..h.frame_count {
        let n_off = at + layout.sightings_offset(TAXA);
        let n = u32::from_le_bytes(chunk[n_off..n_off + 4].try_into().unwrap()) as usize;
        let len = layout.body_len(TAXA, n);
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

    let sources: Vec<&'static str> = fixture_sources(&state)
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
        json!({"b": region(&state), "f": iso(newest - 31 * DAY + 1), "t": iso(newest)}),
    )
    .await;
    let sightings = data["sightings"].as_array().unwrap();
    assert!(
        !sightings.is_empty(),
        "sightings in the last 31 days of fixture data"
    );
    let hull = state.app.hull();
    for s in sightings {
        let (lat, lon) = (s["lat"].as_f64().unwrap(), s["lon"].as_f64().unwrap());
        assert!(hull.contains(lat, lon), "{s}");
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
        json!({"b": region(&state), "f": iso(at - HOUR), "t": iso(at + HOUR)}),
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
        json!({"b": region(&state), "at": iso(onset)}),
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
    let gql_bodies = bodies(&layout(&state), &chunk);
    assert!(
        lst_cells(&layout(&state), gql_bodies[23]) > 100,
        "GOES LST reaches the frame at {}",
        iso(to)
    );

    // 8. REST bulk frames: same window, gzip EVF2, identical bytes to the GraphQL chunk.
    let res = router_for(&state)
        .oneshot(
            Request::get(format!("/v1/python/frames?from={from}&to={to}&step=60"))
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
        json!({"at": iso(iguana_at), "b": region(&state)}),
    )
    .await;
    let cells = data["hotspots"]["cells"].as_array().unwrap();
    assert!(!cells.is_empty(), "iguana hotspots at {}", iso(iguana_at));
    assert!(cells.iter().all(|c| c["score"].as_f64().unwrap() > 0.0));
}

// ---------------------------------------------------------------------------------------------
// T27: the five data-quality cases of PRD §7, end to end
// ---------------------------------------------------------------------------------------------

/// POST rows (model::Row serde form) through the signed hook route, as a pushing producer does.
async fn hook(state: &AppState, rows: &Value) -> (StatusCode, Value) {
    use hmac::{Hmac, Mac};
    let body = rows.to_string().into_bytes();
    let secret = state.config.ingest_hook_secret.clone().expect("tests configure a hook secret");
    let ts = chrono::Utc::now().timestamp();
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(format!("{ts}.").as_bytes());
    mac.update(&body);
    let res = router_for(state)
        .oneshot(
            Request::post("/v1/python/ingest/hook/web")
                .header(header::CONTENT_TYPE, "application/json")
                .header("x-timestamp", ts.to_string())
                .header("x-signature", hex::encode(mac.finalize().into_bytes()))
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// `feeds`, keyed by source.
async fn feeds_by_source(state: &AppState) -> HashMap<String, Value> {
    gql(state, "{ feeds { source state lagSeconds note lastFetchRunId } }", json!({})).await["feeds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| (f["source"].as_str().unwrap().to_string(), f.clone()))
        .collect()
}

async fn evidence(state: &AppState, id: &str) -> Value {
    gql(
        state,
        "query($id: ID!) { evidence(id: $id) { id kind record ingestLagSeconds feed { source state } links { id relation source } } }",
        json!({ "id": id }),
    )
    .await["evidence"]
        .clone()
}

/// Does a GraphQL row carry `id` (ids are strings on the wire)?
fn is_id(row: &Value, id: i64) -> bool {
    row["id"].as_str().and_then(|s| s.parse::<i64>().ok()) == Some(id)
}

fn has_link(ev: &Value, id: &str, relation: &str) -> bool {
    ev["links"].as_array().unwrap().iter().any(|l| l["id"] == id && l["relation"] == relation)
}

/// A 0.02° box around a point.
fn around(lat: f64, lon: f64) -> Value {
    json!({"west": lon - 0.01, "south": lat - 0.01, "east": lon + 0.01, "north": lat + 0.01})
}

/// What `sightings` returns for a 0.02° box and ±1 h around a point.
async fn sightings_near(state: &AppState, lat: f64, lon: f64, at: i64) -> Vec<Value> {
    gql(
        state,
        "query($b: BBox!, $f: Time!, $t: Time!) { sightings(bbox: $b, from: $f, to: $t) { id source canonicalId conflict observedAt ingestedAt } }",
        json!({"b": around(lat, lon), "f": iso(at - HOUR), "t": iso(at + HOUR)}),
    )
    .await["sightings"]
        .as_array()
        .unwrap()
        .clone()
}

/// PRD §7 data quality: each case seeded through the real ingest pipeline and read back through
/// GraphQL, the way the drawer, the feed chips and the agent read it.
///
/// - **stale:** a pushed observation older than the feed's max latency;
/// - **missing:** GOES cloud and bad-DQF pixels (kept as flagged rows and never filled in the
///   frames), and a poller whose fetch fails because its upstream is unreachable;
/// - **duplicate:** a GBIF record mirroring an iNaturalist one, linked by `canonical_id`;
/// - **conflicting:** an iNaturalist ID flip (revision row, conflict flag), and a satellite SST
///   pixel 2 km from a buoy reading 2.4 °C warmer;
/// - **late:** NAS and GBIF records stored long after they were observed.
///
/// `backfill --fixtures` carries the GOES, iNat, NAS, GBIF and NDBC payloads; the signed hook
/// carries the pushed rows; the scheduler runs the real NDBC poller for the failed fetch.
#[tokio::test(flavor = "multi_thread")]
async fn e2e_quality_cases() {
    let state = test_state();
    crate::backfill::run(state.clone(), &["--fixtures".to_string()]).await.unwrap();
    let now = chrono::Utc::now().timestamp_millis();

    // --- stale: `web` (max latency 24 h) receives an observation made 3 days ago ---------------
    let rows = json!([{"Sighting": {
        "ext_id": "t27-stale-1",
        "taxon": {"scientific_name": "Python bivittatus", "common_name": "Burmese python"},
        "lat": 25.76, "lon": -80.77, "accuracy_m": 10.0, "observed_at": now - 3 * DAY, "quality": "curated", "photo_url": null
    }}]);
    let (status, out) = hook(&state, &rows).await;
    assert_eq!((status, out["rowsWritten"].as_i64()), (StatusCode::ACCEPTED, Some(1)), "{out}");
    let feeds = feeds_by_source(&state).await;
    let web = &feeds["web"];
    assert_eq!(web["state"], "STALE", "{web}");
    assert!(web["lagSeconds"].as_i64().unwrap() >= 3 * 86_400 - 5, "{web}");
    assert!(web["note"].as_str().unwrap().contains("max latency is 1d"), "{web}");

    // --- missing (1): GOES cloud and bad-DQF pixels ---------------------------------------------
    let scan_at = int(
        &state,
        "select max(r.observed_at) from readings r join stations s on s.id = r.station_id
         where s.source_id = 'goes19' and r.param = 'lst_c'",
    )
    .await;
    let data = gql(
        &state,
        "query($b: BBox!, $f: Time!, $t: Time!) { readings(bbox: $b, from: $f, to: $t, params: [LST_C]) { station { name source } value flag } }",
        json!({"b": region(&state), "f": iso(scan_at), "t": iso(scan_at)}),
    )
    .await;
    let lst = data["readings"].as_array().unwrap();
    let count = |flag: &str| lst.iter().filter(|r| r["flag"] == flag).count();
    let (ok, cloud, bad) = (count("OK"), count("CLOUD"), count("BAD_DQF"));
    assert!(ok > 100 && cloud > 100 && bad > 0, "ok={ok} cloud={cloud} bad_dqf={bad}");
    for r in lst {
        assert_eq!(r["station"]["source"], "goes19");
        assert_eq!(r["value"].is_null(), r["flag"] != "OK", "a flagged pixel has no value, an ok one has one: {r}");
    }
    // The frame after the scan carries the OK pixels and nothing else: a cloudy or bad-DQF cell
    // stays missing (the globe hatches it), never filled from a neighbour.
    let frame_at = frames::align(scan_at, HOUR) + HOUR;
    let data = gql(
        &state,
        "query($f: Time!, $t: Time!) { frames(from: $f, to: $t, stepMinutes: 60) { frameCount data } }",
        json!({"f": iso(frame_at), "t": iso(frame_at)}),
    )
    .await;
    let chunk = base64::engine::general_purpose::STANDARD
        .decode(data["frames"]["data"].as_str().unwrap())
        .unwrap();
    let layout = layout(&state);
    let body = bodies(&layout, &chunk)[0];
    let lst_at = |name: &str| {
        let (c, r) = name.trim_start_matches("GOES cell g5:").split_once(':').unwrap();
        let at = layout.lst_offset(TAXA) + layout.env.index(c.parse().unwrap(), r.parse().unwrap()) * 2;
        i16::from_le_bytes([body[at], body[at + 1]])
    };
    for r in lst {
        let v = lst_at(r["station"]["name"].as_str().unwrap());
        match r["value"].as_f64() {
            // Frames carry f32 values quantized to centi-°C, so allow one step of rounding.
            Some(c) => assert!((v as f64 - c * 100.0).abs() <= 1.0, "frame {v} for {r}"),
            None => assert_eq!(v, ENV_FLAGGED, "{} pixel in the frame: {r}", r["flag"]),
        }
    }
    let values = &body[layout.lst_offset(TAXA)..layout.sst_offset(TAXA)];
    let (mut valid, mut flagged) = (0, 0);
    for b in values.chunks_exact(2) {
        match i16::from_le_bytes([b[0], b[1]]) {
            ENV_MISSING => {}
            ENV_FLAGGED => flagged += 1,
            _ => valid += 1,
        }
    }
    assert_eq!((valid, flagged), (ok, cloud + bad), "frame LST cells: the OK pixels, and the flagged ones as gaps");

    // --- missing (2): the NDBC poller cannot reach its upstream ----------------------------------
    let dead_port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let mut offline = state.clone();
    offline.http = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{dead_port}")).unwrap())
        .build()
        .unwrap();
    let ndbc: Vec<_> = crate::ingest::poll::physical::sources(&state.config, &state.app)
        .into_iter()
        .filter(|s| s.info().id == "ndbc")
        .collect();
    assert_eq!(ndbc.len(), 1);
    let tasks =
        crate::ingest::scheduler::spawn_sources(&offline, ndbc, crate::ingest::scheduler::Supervision::default());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    let failed_run = loop {
        let run: Option<i64> = state
            .obs
            .read(move |c| {
                c.query_row(
                    "select max(id) from fetch_runs where source_id = 'ndbc' and status = 'error' and fetched_at >= ?1",
                    [now],
                    |r| r.get(0),
                )
            })
            .await
            .unwrap();
        if let Some(run) = run {
            break run;
        }
        assert!(std::time::Instant::now() < deadline, "the NDBC poller recorded no failed fetch");
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    };
    for t in tasks {
        t.abort();
    }
    let feeds = feeds_by_source(&state).await;
    let ndbc = &feeds["ndbc"];
    assert_eq!(ndbc["lastFetchRunId"], failed_run.to_string(), "{ndbc}");
    let note = ndbc["note"].as_str().unwrap();
    assert!(note.contains("last fetch failed: ndbc: all ") && note.contains("stations failed"), "{ndbc}");
    let ev = evidence(&state, &format!("fetch:{failed_run}")).await;
    assert_eq!((ev["kind"].as_str(), ev["record"]["status"].as_str()), (Some("fetch"), Some("error")), "{ev}");
    assert_eq!(ev["record"]["rowsIn"], 0, "{ev}");
    // What it fetched before stays, gaps included (NDBC "MM" is stored as `missing`, not dropped).
    assert!(
        int(
            &state,
            "select count(*) from readings r join stations s on s.id = r.station_id
             where s.source_id = 'ndbc' and r.flag = 'missing' and r.value is null"
        )
        .await
            > 0
    );

    // --- duplicate: a GBIF record mirroring an iNaturalist one ----------------------------------
    let (gbif, inat, lat, lon, at): (i64, i64, f64, f64, i64) = state
        .obs
        .read(|c| {
            c.query_row(
                "select g.id, i.id, g.lat, g.lon, g.observed_at from sightings g join sightings i on i.id = g.canonical_id
                 where g.source_id = 'gbif' and i.source_id = 'inat' order by g.id limit 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
        })
        .await
        .unwrap();
    let near = sightings_near(&state, lat, lon, at).await;
    let row = |id: i64| {
        near.iter()
            .find(|s| is_id(s, id))
            .unwrap_or_else(|| panic!("sighting {id} in {near:?}"))
            .clone()
    };
    assert_eq!(row(gbif)["canonicalId"], inat.to_string());
    assert!(row(inat)["canonicalId"].is_null());
    let ev = evidence(&state, &format!("sighting:{gbif}")).await;
    assert!(has_link(&ev, &format!("sighting:{inat}"), "duplicate_of"), "{ev}");
    let ev = evidence(&state, &format!("sighting:{inat}")).await;
    assert!(has_link(&ev, &format!("sighting:{gbif}"), "duplicates"), "{ev}");

    // --- conflicting (1): an iNaturalist ID flip -------------------------------------------------
    let (flip, lat, lon, at): (i64, f64, f64, i64) = state
        .obs
        .read(|c| {
            c.query_row(
                "select id, lat, lon, observed_at from sightings s where source_id = 'inat' and conflict = 1 and taxon_id between 1 and 4
                   and exists(select 1 from sighting_revisions r where r.sighting_id = s.id and r.field = 'taxon')
                 order by id limit 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
        })
        .await
        .unwrap();
    let near = sightings_near(&state, lat, lon, at).await;
    let row = near.iter().find(|s| is_id(s, flip)).unwrap();
    assert_eq!(row["conflict"], true, "{row}");
    let ev = evidence(&state, &format!("sighting:{flip}")).await;
    assert_eq!(ev["record"]["conflict"], true, "{ev}");
    let revisions = ev["record"]["revisions"].as_array().unwrap();
    assert!(
        revisions
            .iter()
            .any(|r| r["field"] == "taxon" && r["old"].is_string() && r["new"].is_string() && r["old"] != r["new"]),
        "{revisions:?}"
    );

    // --- conflicting (2): satellite SST 2 km from a buoy, 2.4 °C warmer --------------------------
    let (buoy_station, buoy_at, buoy_c, blat, blon): (i64, i64, f64, f64, f64) = state
        .obs
        .read(|c| {
            c.query_row(
                "select r.station_id, r.observed_at, r.value, s.lat, s.lon from readings r join stations s on s.id = r.station_id
                 where s.source_id = 'ndbc' and r.param = 'sst_c' and r.origin = 'measured' and r.flag = 'ok' and r.value is not null
                 order by r.observed_at desc limit 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
        })
        .await
        .unwrap();
    let pixel_at = buoy_at + 10 * 60_000;
    let rows = json!([{"Reading": {
        "station": {"ext_id": "t27-sst-pixel", "name": "SST pixel 2 km north of the buoy", "lat": blat + 0.018, "lon": blon, "kind": "goes_cell"},
        "param": "sst_c", "value": buoy_c + 2.4, "flag": "ok", "observed_at": pixel_at, "origin": "satellite"
    }}]);
    let (status, out) = hook(&state, &rows).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{out}");
    let pixel_station: i64 = state
        .obs
        .read(|c| c.query_row("select id from stations where source_id = 'web' and ext_id = 't27-sst-pixel'", [], |r| r.get(0)))
        .await
        .unwrap();
    let buoy_id = format!("reading:{buoy_station}:sst_c:{buoy_at}:measured");
    let pixel_id = format!("reading:{pixel_station}:sst_c:{pixel_at}:satellite");
    let ev = evidence(&state, &buoy_id).await;
    assert_eq!(ev["record"]["conflict"], true, "{ev}");
    assert!(has_link(&ev, &pixel_id, "conflict"), "{ev}");
    let ev = evidence(&state, &pixel_id).await;
    assert_eq!(ev["record"]["conflict"], true, "{ev}");
    assert!(has_link(&ev, &buoy_id, "conflict"), "{ev}");
    let data = gql(
        &state,
        "query($b: BBox!, $f: Time!, $t: Time!) { readings(bbox: $b, from: $f, to: $t, params: [SST_C]) { station { source } value origin flag } }",
        json!({"b": around(blat + 0.009, blon), "f": iso(buoy_at), "t": iso(pixel_at)}),
    )
    .await;
    let origins: Vec<(&str, &str)> = data["readings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["station"]["source"].as_str().unwrap(), r["origin"].as_str().unwrap()))
        .collect();
    assert!(origins.contains(&("ndbc", "MEASURED")) && origins.contains(&("web", "SATELLITE")), "{origins:?}");

    // --- late: NAS and GBIF records stored long after they were observed -------------------------
    for source in ["nas", "gbif"] {
        let (id, lat, lon, at, lag_ms): (i64, f64, f64, i64, i64) = state
            .obs
            .read(move |c| {
                c.query_row(
                    "select id, lat, lon, observed_at, ingested_at - observed_at from sightings where source_id = ?1
                     order by observed_at desc limit 1",
                    [source],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
            })
            .await
            .unwrap();
        assert!(lag_ms > crate::hotspot::score::LATE_MS, "{source}: its newest record arrived after {lag_ms} ms");
        let near = sightings_near(&state, lat, lon, at).await;
        let row = near.iter().find(|s| is_id(s, id)).unwrap();
        let ms = |k: &str| {
            chrono::DateTime::parse_from_rfc3339(row[k].as_str().unwrap())
                .unwrap()
                .timestamp_millis()
        };
        assert_eq!(ms("ingestedAt") - ms("observedAt"), lag_ms, "{row}");
        let ev = evidence(&state, &format!("sighting:{id}")).await;
        assert_eq!(ev["ingestLagSeconds"].as_i64(), Some(lag_ms / 1000), "{source}: {ev}");
        assert_eq!(ev["feed"]["source"], source);
    }
}
