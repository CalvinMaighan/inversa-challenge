//! Signed ingest hook `POST /v1/{app}/ingest/hook/{source}` (PLAN.md C10, T5; app prefix C-A2;
//! delivery step of docs/ingest-modes.md "Emitter design").
//!
//! The body is the raw provider payload, exactly as fetched; the hook runs the named adapter's
//! pure `normalize` over it. `{source}` is the app's `web` hook source (a JSON array of
//! `model::Row`) or any poll adapter the app runs (`nwps` takes a stageflow body, `inat` an
//! observations page, ...). Headers:
//!
//! - `X-Timestamp`: unix seconds; more than [`MAX_SKEW_SECS`] from now is rejected (the replay
//!   window: a captured request cannot be replayed after it);
//! - `X-Signature`: `hex(HMAC_SHA256(INGEST_HOOK_SECRET, "<ts>.<raw body bytes>"))`, compared in
//!   constant time;
//! - `X-Idempotency-Key` (optional): `sha256(body)` hex. The server computes the same key from
//!   the bytes; a header that disagrees is a 400. Inside the replay window a repeated delivery
//!   (emitter retry, SQS redelivery) is answered from the key;
//! - `X-Source-Url` (optional): the provider URL the body came from (adapters such as `nwps`
//!   read the site from it); `X-Fetched-At` (optional): unix ms of the fetch.
//!
//! Responses:
//! - 503 when `INGEST_HOOK_SECRET` is not configured;
//! - 401 for a missing/invalid signature or a timestamp outside the replay window;
//! - 404 for a source the app does not run (only after authentication);
//! - 400 for an `X-Idempotency-Key` that is not the body's sha256;
//! - 413 for bodies over [`MAX_BODY_BYTES`];
//! - 200 `{"status":"duplicate","duplicate":true,...}` when this body was already delivered for
//!   this source (its raw object has a fetch run) or is being delivered right now: nothing is
//!   written;
//! - 422 when the body does not normalize (the payload is still archived and recorded);
//! - 202 with the ingest outcome on success.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use hmac::{Hmac, Mac};
use rusqlite::{params, OptionalExtension};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::app::config::App;
use crate::app::AppRegistry;
use crate::ingest::scheduler::{ingest_payload, RunStatus};
use crate::ingest::source::{FetchCtx, Mode, RawPayload, Source, SourceInfo};
use crate::model::Row;
use crate::state::AppState;

pub const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_SKEW_SECS: i64 = 300;

pub fn routes() -> Router<AppRegistry> {
    Router::new().route("/ingest/hook/{source}", post(receive)).layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
}

/// Hook-only sources for `app` (its `feeds[]` must list `web`). Upserted into `sources` at boot
/// by the scheduler; they have no fetch loop.
pub fn sources(app: &App) -> Vec<Arc<dyn Source>> {
    if app.cfg.has_feed("web") {
        vec![Arc::new(HookSource::web())]
    } else {
        Vec::new()
    }
}

/// The adapter that normalizes a delivery for `source_id`: the hook-only `web` source or one of
/// the app's poll adapters. Push adapters (GOES, NWWS) need credentials to exist at all and
/// deliver in-process, so they are not offered here.
fn delivery_source(state: &AppState, source_id: &str) -> Option<Arc<dyn Source>> {
    sources(&state.app)
        .into_iter()
        .chain(crate::ingest::poll::all(&state.config, &state.app))
        .find(|s| s.info().id == source_id)
}

/// Generic push source fed only through the hook. The body is a JSON array of `model::Row` in
/// its serde form, e.g. `[{"Sighting": {...}}, {"Reading": {...}}]`.
pub struct HookSource {
    info: SourceInfo,
}

impl HookSource {
    pub fn web() -> Self {
        HookSource {
            info: SourceInfo {
                id: "web",
                name: "Signed web hook",
                homepage: "/v1/<app>/ingest/hook/web",
                mode: Mode::Push,
                cadence: Duration::from_secs(60 * 60),
                max_latency: Duration::from_secs(24 * 60 * 60),
            },
        }
    }
}

#[async_trait]
impl Source for HookSource {
    fn info(&self) -> SourceInfo {
        self.info.clone()
    }

    fn min_interval(&self) -> Duration {
        Duration::ZERO
    }

    /// Hook sources are pushed to; there is nothing to fetch.
    async fn fetch(&self, _ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
        Ok(Vec::new())
    }

    fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
        let rows: Vec<Row> = serde_json::from_slice(&raw.bytes)?;
        Ok(rows)
    }
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

fn header<'h>(headers: &'h HeaderMap, name: &str) -> Option<&'h str> {
    headers.get(name).and_then(|v| v.to_str().ok()).map(str::trim)
}

/// Verify `X-Timestamp` / `X-Signature` for `body` at `now` (unix seconds).
pub fn verify(secret: &str, headers: &HeaderMap, body: &[u8], now: i64) -> Result<(), &'static str> {
    let ts_raw = header(headers, "x-timestamp").ok_or("missing X-Timestamp")?;
    let ts: i64 = ts_raw.parse().map_err(|_| "invalid X-Timestamp")?;
    if (now - ts).abs() > MAX_SKEW_SECS {
        return Err("stale X-Timestamp");
    }
    let sig_hex = header(headers, "x-signature").ok_or("missing X-Signature")?;
    let sig = hex::decode(sig_hex.strip_prefix("sha256=").unwrap_or(sig_hex)).map_err(|_| "invalid X-Signature")?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| "invalid secret")?;
    mac.update(ts_raw.as_bytes());
    mac.update(b".");
    mac.update(body);
    // `verify_slice` compares in constant time.
    mac.verify_slice(&sig).map_err(|_| "bad signature")
}

/// A delivery being ingested (`AppState::hook_in_flight`, keyed `<source>/<sha256>`): a concurrent
/// repeat is a duplicate before the first has written its fetch run. The key leaves the set when
/// the delivery ends, however it ends.
struct InFlight {
    set: Arc<Mutex<HashSet<String>>>,
    key: String,
}

impl InFlight {
    fn claim(set: &Arc<Mutex<HashSet<String>>>, key: String) -> Option<InFlight> {
        set.lock().unwrap_or_else(|p| p.into_inner()).insert(key.clone()).then(|| InFlight { set: set.clone(), key })
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.set.lock().unwrap_or_else(|p| p.into_inner()).remove(&self.key);
    }
}

/// The fetch run of an earlier delivery of these bytes for this source, if any. A raw object
/// without a run (the write failed after the archive put) is not a delivery: it is retried.
async fn delivered(state: &AppState, source_id: &str, sha: &str) -> anyhow::Result<Option<i64>> {
    let (source_id, sha) = (source_id.to_string(), sha.to_string());
    state
        .obs
        .read(move |c| {
            c.prepare_cached(
                "select f.id from raw_objects o join fetch_runs f on f.raw_object_id = o.id
                 where o.source_id = ?1 and o.sha256 = ?2 order by f.id limit 1",
            )?
            .query_row(params![source_id, sha], |r| r.get(0))
            .optional()
        })
        .await
}

fn duplicate(key: &str, fetch_run_id: Option<i64>) -> Response {
    let run = fetch_run_id.map(|id| id.to_string());
    (StatusCode::OK, Json(json!({ "status": "duplicate", "duplicate": true, "idempotencyKey": key, "fetchRunId": run }))).into_response()
}

async fn receive(state: AppState, Path((_app, source_id)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(secret) = state.config.ingest_hook_secret.as_deref() else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "ingest hook disabled: INGEST_HOOK_SECRET is not set");
    };
    // The replay window is a transport check, so it reads the process clock, not a pinned app clock.
    let now_ms = crate::state::now_ms();
    if let Err(reason) = verify(secret, &headers, &body, now_ms.div_euclid(1000)) {
        return error(StatusCode::UNAUTHORIZED, reason);
    }
    // Only after authentication, so unauthenticated callers cannot probe source ids.
    let Some(source) = delivery_source(&state, &source_id) else {
        return error(StatusCode::NOT_FOUND, format!("unknown hook source {source_id} for app {}", state.app.id()));
    };
    let key = hex::encode(Sha256::digest(&body));
    if let Some(given) = header(&headers, "x-idempotency-key") {
        if !given.eq_ignore_ascii_case(&key) {
            return error(StatusCode::BAD_REQUEST, "X-Idempotency-Key is not the sha256 of the body");
        }
    }
    let Some(_guard) = InFlight::claim(&state.hook_in_flight, format!("{source_id}/{key}")) else {
        return duplicate(&key, None);
    };
    match delivered(&state, &source_id, &key).await {
        Ok(Some(run)) => return duplicate(&key, Some(run)),
        Ok(None) => {}
        Err(e) => {
            tracing::error!(source = %source_id, "hook idempotency lookup failed: {e:#}");
            return error(StatusCode::INTERNAL_SERVER_ERROR, "ingest failed");
        }
    }
    let content_type = header(&headers, axum::http::header::CONTENT_TYPE.as_str()).unwrap_or("application/json").to_string();
    let raw = RawPayload {
        source_url: header(&headers, "x-source-url")
            .filter(|u| !u.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("hook:/v1/{}/ingest/hook/{source_id}", state.app.id())),
        content_type,
        bytes: body.to_vec(),
        http_status: None,
        fetched_at: header(&headers, "x-fetched-at").and_then(|v| v.parse().ok()).unwrap_or(now_ms),
        next_cursor: None,
        ack: None,
    };
    match ingest_payload(&state, source.as_ref(), raw, None).await {
        Ok(out) if out.status == RunStatus::Error => (StatusCode::UNPROCESSABLE_ENTITY, Json(out)).into_response(),
        Ok(out) => (StatusCode::ACCEPTED, Json(out)).into_response(),
        Err(e) => {
            tracing::error!(source = %source_id, "hook ingest failed: {e:#}");
            error(StatusCode::INTERNAL_SERVER_ERROR, "ingest failed")
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;
    use crate::app::test_support::{router_for, test_app, test_state, test_state_for};
    use crate::model::{Quality, SightingRow, TaxonRef};

    const SECRET: &str = "test-hook-secret";

    fn sign(secret: &str, ts: i64, body: &[u8]) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(format!("{ts}.").as_bytes());
        mac.update(body);
        hex::encode(mac.finalize().into_bytes())
    }

    fn body() -> Vec<u8> {
        serde_json::to_vec(&vec![Row::Sighting(SightingRow {
            ext_id: "web-1".into(),
            taxon: TaxonRef::named("Salvator merianae", "Tegu"),
            lat: 25.9,
            lon: -80.4,
            accuracy_m: Some(5.0),
            observed_at: 1_790_000_000_000,
            submitted_at: None,
            quality: Quality::Curated,
            photo_url: None,
        })])
        .unwrap()
    }

    fn request_to(app: &str, source: &str, ts: Option<i64>, sig: Option<String>, body: Vec<u8>) -> Request<Body> {
        let mut req = Request::post(format!("/v1/{app}/ingest/hook/{source}")).header("content-type", "application/json");
        if let Some(ts) = ts {
            req = req.header("x-timestamp", ts.to_string());
        }
        if let Some(sig) = sig {
            req = req.header("x-signature", sig);
        }
        req.body(Body::from(body)).unwrap()
    }

    fn request(source: &str, ts: Option<i64>, sig: Option<String>, body: Vec<u8>) -> Request<Body> {
        request_to("python", source, ts, sig, body)
    }

    fn signed(source: &str, b: &[u8]) -> Request<Body> {
        let ts = now();
        request(source, Some(ts), Some(sign(SECRET, ts, b)), b.to_vec())
    }

    async fn json(res: Response) -> serde_json::Value {
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
    }

    fn now() -> i64 {
        crate::state::now_ms() / 1000
    }

    async fn count(state: &AppState, sql: &'static str) -> i64 {
        state.obs.read(move |c| c.query_row(sql, [], |r| r.get(0))).await.unwrap()
    }

    /// A first delivery is ingested (202); the same bytes again, with a fresh signature inside the
    /// replay window, are a no-op answered 200 `duplicate` with the first run's id.
    #[tokio::test]
    async fn ingest_hook_valid_signature_202_then_duplicate_200() {
        let (app, state) = test_app();
        let b = body();
        let res = app.clone().oneshot(signed("web", &b)).await.unwrap();
        assert_eq!(res.status(), StatusCode::ACCEPTED);
        let out = json(res).await;
        assert_eq!(out["status"], "ok");
        assert_eq!(out["rowsWritten"], 1);
        let (taxon, quality): (i64, String) = state
            .obs
            .read(|c| {
                c.query_row("select taxon_id, quality from sightings where source_id = 'web' and ext_id = 'web-1'", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
            })
            .await
            .unwrap();
        assert_eq!((taxon, quality.as_str()), (2, "curated"));

        let res = app.clone().oneshot(signed("web", &b)).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let dup = json(res).await;
        assert_eq!((dup["status"].as_str(), dup["duplicate"].as_bool()), (Some("duplicate"), Some(true)), "{dup}");
        assert_eq!(dup["idempotencyKey"], hex::encode(Sha256::digest(&b)));
        assert_eq!(dup["fetchRunId"], out["fetchRunId"].to_string());
        assert_eq!(count(&state, "select count(*) from fetch_runs where source_id = 'web'").await, 1, "the repeat wrote no run");
        assert_eq!(count(&state, "select count(*) from raw_objects where source_id = 'web'").await, 1);
        // A different body is a new delivery.
        let mut other: serde_json::Value = serde_json::from_slice(&b).unwrap();
        other[0]["Sighting"]["ext_id"] = "web-2".into();
        let res = app.oneshot(signed("web", &serde_json::to_vec(&other).unwrap())).await.unwrap();
        assert_eq!(res.status(), StatusCode::ACCEPTED);
    }

    /// The optional `X-Idempotency-Key` must be the body's sha256.
    #[tokio::test]
    async fn ingest_hook_idempotency_key_must_match_body() {
        let (app, state) = test_app();
        let b = body();
        let ts = now();
        let req = |key: String| {
            Request::post("/v1/python/ingest/hook/web")
                .header("x-timestamp", ts.to_string())
                .header("x-signature", sign(SECRET, ts, &b))
                .header("x-idempotency-key", key)
                .body(Body::from(b.clone()))
                .unwrap()
        };
        let res = app.clone().oneshot(req("00".repeat(32))).await.unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert_eq!(count(&state, "select count(*) from raw_objects").await, 0);
        let res = app.oneshot(req(hex::encode(Sha256::digest(&b)).to_uppercase())).await.unwrap();
        assert_eq!(res.status(), StatusCode::ACCEPTED, "hex case does not matter");
    }

    /// Two identical deliveries at once: one is ingested, the other is a duplicate.
    #[tokio::test]
    async fn ingest_hook_concurrent_duplicates_ingest_once() {
        let (app, state) = test_app();
        let b = body();
        let (a, c) = tokio::join!(app.clone().oneshot(signed("web", &b)), app.clone().oneshot(signed("web", &b)));
        let mut codes = [a.unwrap().status(), c.unwrap().status()];
        codes.sort();
        assert_eq!(codes, [StatusCode::OK, StatusCode::ACCEPTED]);
        assert_eq!(count(&state, "select count(*) from fetch_runs where source_id = 'web'").await, 1);
    }

    /// The raw provider body goes through the named adapter: an NWPS stageflow document for
    /// SMML1, delivered with its source URL, lands in the forecast store; the repeat is a no-op.
    #[tokio::test]
    async fn ingest_hook_raw_provider_body_runs_the_adapter() {
        let state = test_state_for("carp");
        let router = router_for(&state);
        let b = crate::ingest::poll::physical::testing::fixture("nwps/SMML1.stageflow.json");
        let deliver = |b: Vec<u8>| {
            let ts = now();
            Request::post("/v1/carp/ingest/hook/nwps")
                .header("content-type", "application/json")
                .header("x-timestamp", ts.to_string())
                .header("x-signature", sign(SECRET, ts, &b))
                .header("x-source-url", crate::ingest::poll::nwps::stageflow_url("SMML1"))
                .header("x-fetched-at", "1790838063000")
                .body(Body::from(b))
                .unwrap()
        };
        let res = router.clone().oneshot(deliver(b.clone())).await.unwrap();
        assert_eq!(res.status(), StatusCode::ACCEPTED);
        let out = json(res).await;
        assert!(out["rowsWritten"].as_i64().unwrap() >= 2, "{out}");
        let obs = count(&state, "select count(*) from forecast_observations where site = 'SMML1'").await;
        assert!(obs > 0);
        assert_eq!(count(&state, "select count(*) from forecast_snapshots where site = 'SMML1'").await, 1);
        let url: String = state.obs.read(|c| c.query_row("select source_url from raw_objects where source_id = 'nwps'", [], |r| r.get(0))).await.unwrap();
        assert_eq!(url, crate::ingest::poll::nwps::stageflow_url("SMML1"));
        let fetched: i64 = state.obs.read(|c| c.query_row("select fetched_at from fetch_runs where source_id = 'nwps'", [], |r| r.get(0))).await.unwrap();
        assert_eq!(fetched, 1_790_838_063_000, "X-Fetched-At is the fetch time");
        let res = router.oneshot(deliver(b)).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(count(&state, "select count(*) from forecast_observations where site = 'SMML1'").await, obs);
        assert_eq!(count(&state, "select count(*) from fetch_runs where source_id = 'nwps'").await, 1);
    }

    #[tokio::test]
    async fn ingest_hook_bad_signature_401() {
        let (app, state) = test_app();
        let b = body();
        let ts = now();
        let cases = [
            Some(sign("wrong-secret", ts, &b)),
            Some(sign(SECRET, ts + 1, &b)),
            Some("zz-not-hex".to_string()),
            Some(String::new()),
            None,
        ];
        for sig in cases {
            let res = app.clone().oneshot(request("web", Some(ts), sig.clone(), b.clone())).await.unwrap();
            assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "{sig:?}");
        }
        // Signature over a different body (the HMAC covers the raw bytes).
        let res = app.clone().oneshot(request("web", Some(ts), Some(sign(SECRET, ts, b"[]")), b.clone())).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        let mut spaced = b.clone();
        spaced.push(b' ');
        let res = app.clone().oneshot(request("web", Some(ts), Some(sign(SECRET, ts, &b)), spaced)).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "one trailing byte breaks the signature");
        // Missing timestamp.
        let res = app.oneshot(request("web", None, Some(sign(SECRET, ts, &b)), b)).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(count(&state, "select count(*) from raw_objects").await, 0, "nothing archived for rejected requests");
    }

    /// The replay window: a signed request is accepted for 300 s either side of its timestamp.
    #[tokio::test]
    async fn ingest_hook_replay_window_300s() {
        let (app, _) = test_app();
        let b = body();
        let old = now() - 301;
        let res = app.clone().oneshot(request("web", Some(old), Some(sign(SECRET, old, &b)), b.clone())).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(json(res).await["error"], "stale X-Timestamp");
        let future = now() + 301;
        let res = app.clone().oneshot(request("web", Some(future), Some(sign(SECRET, future, &b)), b.clone())).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        // Inside the window is fine.
        let recent = now() - 250;
        let res = app.oneshot(request("web", Some(recent), Some(sign(SECRET, recent, &b)), b)).await.unwrap();
        assert_eq!(res.status(), StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn ingest_hook_missing_secret_config_503() {
        let mut state = test_state();
        let mut config = (*state.config).clone();
        config.ingest_hook_secret = None;
        state.config = Arc::new(config);
        let app = router_for(&state);
        let res = app.oneshot(signed("web", &body())).await.unwrap();
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn ingest_hook_unknown_app_or_source_404() {
        let (app, _) = test_app();
        let b = body();
        let ts = now();
        // `crw` is a lionfish source; python does not run it.
        let res = app.clone().oneshot(request("crw", Some(ts), Some(sign(SECRET, ts, &b)), b.clone())).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        let res = app.clone().oneshot(request("crw", Some(ts), Some(sign("wrong", ts, &b)), b.clone())).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "404 only after authentication");
        let res = app.clone().oneshot(request_to("otter", "web", Some(ts), Some(sign(SECRET, ts, &b)), b.clone())).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        assert_eq!(json(res).await["error"], "unknown_app");
        // An app whose config lists no `web` feed has no hook-only source.
        let mut v: serde_json::Value = serde_json::from_str(crate::app::config::builtin_json("python").unwrap()).unwrap();
        v["feeds"].as_array_mut().unwrap().retain(|f| f["source"] != "web");
        let cfg = crate::app::config::AppConfig::parse("nohook.json", &v.to_string()).unwrap();
        let state = crate::state::AppState::memory(crate::state::Config::for_tests(), crate::app::config::App::new(cfg).unwrap());
        assert!(sources(&state.app).is_empty());
        let res = router_for(&state).oneshot(request("web", Some(ts), Some(sign(SECRET, ts, &b)), b)).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn ingest_hook_invalid_rows_422_and_recorded() {
        let (app, state) = test_app();
        let b = br#"[{"Sighting": {"ext_id": "x"}}]"#.to_vec();
        let res = app.oneshot(signed("web", &b)).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(json(res).await["status"], "error");
        let status: String = state
            .obs
            .read(|c| c.query_row("select status from fetch_runs where source_id = 'web'", [], |r| r.get(0)))
            .await
            .unwrap();
        assert_eq!(status, "error");
    }

    #[tokio::test]
    async fn ingest_hook_body_over_2mb_413() {
        let (app, _) = test_app();
        let b = vec![b' '; MAX_BODY_BYTES + 1];
        let res = app.oneshot(signed("web", &b)).await.unwrap();
        assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }
}
