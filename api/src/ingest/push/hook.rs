//! Signed webhook receiver `POST /v1/ingest/hook/:source` (PLAN.md C10, T5).
//!
//! Headers: `X-Timestamp` (unix seconds) and `X-Signature` =
//! `hex(HMAC_SHA256(INGEST_HOOK_SECRET, "<ts>.<body>"))`. Responses:
//! - 503 when `INGEST_HOOK_SECRET` is not configured;
//! - 401 for a missing/invalid signature or a timestamp more than 300 s from now;
//! - 404 for a source id that does not accept hooks;
//! - 413 for bodies over 2 MB;
//! - 422 when the body does not normalize (the payload is still archived and recorded);
//! - 202 with the ingest outcome on success.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::ingest::scheduler::{ingest_payload, RunStatus};
use crate::ingest::source::{FetchCtx, Mode, RawPayload, Source, SourceInfo};
use crate::model::Row;
use crate::state::AppState;

pub const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_SKEW_SECS: i64 = 300;

pub fn routes() -> Router<AppState> {
    Router::new().route("/v1/ingest/hook/{source}", post(receive)).layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
}

/// Sources that accept signed hook payloads. Upserted into `sources` at boot by the scheduler;
/// they have no fetch loop.
pub fn sources() -> Vec<Arc<dyn Source>> {
    vec![Arc::new(HookSource::web())]
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
                homepage: "/v1/ingest/hook/web",
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
    (status, Json(serde_json::json!({ "error": message.into() }))).into_response()
}

/// Verify `X-Timestamp` / `X-Signature` for `body` at `now` (unix seconds).
pub fn verify(secret: &str, headers: &HeaderMap, body: &[u8], now: i64) -> Result<(), &'static str> {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(str::trim);
    let ts_raw = header("x-timestamp").ok_or("missing X-Timestamp")?;
    let ts: i64 = ts_raw.parse().map_err(|_| "invalid X-Timestamp")?;
    if (now - ts).abs() > MAX_SKEW_SECS {
        return Err("stale X-Timestamp");
    }
    let sig_hex = header("x-signature").ok_or("missing X-Signature")?;
    let sig = hex::decode(sig_hex.strip_prefix("sha256=").unwrap_or(sig_hex)).map_err(|_| "invalid X-Signature")?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| "invalid secret")?;
    mac.update(ts_raw.as_bytes());
    mac.update(b".");
    mac.update(body);
    // `verify_slice` compares in constant time.
    mac.verify_slice(&sig).map_err(|_| "bad signature")
}

async fn receive(State(state): State<AppState>, Path(source_id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(secret) = state.config.ingest_hook_secret.as_deref() else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "ingest hook disabled: INGEST_HOOK_SECRET is not set");
    };
    let now = chrono::Utc::now();
    if let Err(reason) = verify(secret, &headers, &body, now.timestamp()) {
        return error(StatusCode::UNAUTHORIZED, reason);
    }
    // Only after authentication, so unauthenticated callers cannot probe source ids.
    let Some(source) = sources().into_iter().find(|s| s.info().id == source_id) else {
        return error(StatusCode::NOT_FOUND, format!("unknown hook source {source_id}"));
    };
    let content_type = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_string();
    let raw = RawPayload {
        source_url: format!("hook:/v1/ingest/hook/{source_id}"),
        content_type,
        bytes: body.to_vec(),
        http_status: None,
        fetched_at: now.timestamp_millis(),
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
    use crate::app::test_support::{test_app, test_state};
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
            taxon: TaxonRef { scientific_name: "Salvator merianae".into(), common_name: "Tegu".into() },
            lat: 25.9,
            lon: -80.4,
            accuracy_m: Some(5.0),
            observed_at: 1_790_000_000_000,
            quality: Quality::Curated,
            photo_url: None,
        })])
        .unwrap()
    }

    fn request(source: &str, ts: Option<i64>, sig: Option<String>, body: Vec<u8>) -> Request<Body> {
        let mut req = Request::post(format!("/v1/ingest/hook/{source}")).header("content-type", "application/json");
        if let Some(ts) = ts {
            req = req.header("x-timestamp", ts.to_string());
        }
        if let Some(sig) = sig {
            req = req.header("x-signature", sig);
        }
        req.body(Body::from(body)).unwrap()
    }

    async fn json(res: Response) -> serde_json::Value {
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
    }

    fn now() -> i64 {
        chrono::Utc::now().timestamp()
    }

    #[tokio::test]
    async fn hook_valid_signature_202_and_ingests() {
        let (app, state) = test_app();
        let b = body();
        let ts = now();
        let res = app.clone().oneshot(request("web", Some(ts), Some(sign(SECRET, ts, &b)), b.clone())).await.unwrap();
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

        // Replaying the same signed body within the window is idempotent.
        let res = app.oneshot(request("web", Some(ts), Some(sign(SECRET, ts, &b)), b)).await.unwrap();
        assert_eq!(res.status(), StatusCode::ACCEPTED);
        assert_eq!(json(res).await["rowsWritten"], 0);
    }

    #[tokio::test]
    async fn hook_bad_signature_401() {
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
        // Signature over a different body.
        let res = app.clone().oneshot(request("web", Some(ts), Some(sign(SECRET, ts, b"[]")), b.clone())).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        // Missing timestamp.
        let res = app.oneshot(request("web", None, Some(sign(SECRET, ts, &b)), b)).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        let n: i64 = state.obs.read(|c| c.query_row("select count(*) from raw_objects", [], |r| r.get(0))).await.unwrap();
        assert_eq!(n, 0, "nothing archived for rejected requests");
    }

    #[tokio::test]
    async fn hook_timestamp_older_than_300s_401() {
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
    async fn hook_missing_secret_config_503() {
        let mut state = test_state();
        let mut config = (*state.config).clone();
        config.ingest_hook_secret = None;
        state.config = Arc::new(config);
        let app = crate::app::app(state);
        let b = body();
        let ts = now();
        let res = app.oneshot(request("web", Some(ts), Some(sign(SECRET, ts, &b)), b)).await.unwrap();
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn hook_unknown_source_404_after_auth() {
        let (app, _) = test_app();
        let b = body();
        let ts = now();
        let res = app.clone().oneshot(request("inat", Some(ts), Some(sign(SECRET, ts, &b)), b.clone())).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        let res = app.oneshot(request("inat", Some(ts), Some(sign("wrong", ts, &b)), b)).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn hook_invalid_rows_422_and_recorded() {
        let (app, state) = test_app();
        let b = br#"[{"Sighting": {"ext_id": "x"}}]"#.to_vec();
        let ts = now();
        let res = app.oneshot(request("web", Some(ts), Some(sign(SECRET, ts, &b)), b)).await.unwrap();
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
    async fn hook_body_over_2mb_413() {
        let (app, _) = test_app();
        let b = vec![b' '; MAX_BODY_BYTES + 1];
        let ts = now();
        let res = app.oneshot(request("web", Some(ts), Some(sign(SECRET, ts, &b)), b)).await.unwrap();
        assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }
}
