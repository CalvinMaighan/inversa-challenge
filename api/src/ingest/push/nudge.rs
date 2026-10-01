//! Provider nudge receiver `/v1/{app}/ingest/nudge/{source}/{token}` (L3, E1; docs/ingest-modes.md).
//!
//! Some providers can call a URL when something changes but cannot sign the call: ERDDAP
//! subscriptions with a URL action (`crw`), IEMBot webhooks on NWS products (`nws-alerts`,
//! `nwps`, `nws-forecast`, `iem`). A nudge carries no data; it wakes the source's scheduler task
//! so the fetch runs now instead of at the next poll. The adapter's own change gate still applies
//! (NWPS `issuedTime`, gridpoint `updateTime`, CRW `time[(last)]`), so a nudge with nothing new
//! costs one request and records an `empty` run. The token in the path (`INGEST_NUDGE_TOKEN`) is
//! the whole authentication. ERDDAP calls its action URL with GET, so GET and POST are both
//! accepted. The request body, if any, is ignored. Responses:
//! - 404 `unknown_app` for an app that is not running (the `AppState` extractor);
//! - 503 when `INGEST_NUDGE_TOKEN` is not set;
//! - 401 for a wrong token;
//! - 404 for a source this app does not run or that takes no nudges ([`NUDGE_SOURCES`] or a
//!   `webhook`-mode adapter);
//! - 202 `{"status":"accepted"}`: the loop is woken (a nudge during a fetch runs one more fetch
//!   right after it, which the source's own change gate turns into an `empty` run);
//! - 200 `{"status":"duplicate"}`: a repeat within [`DEDUPE`] of the last accepted nudge for the
//!   same source; nothing is woken, so a retrying or double-subscribed provider costs one fetch.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::Path;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use tokio::sync::Notify;

use crate::app::AppRegistry;
use crate::ingest::source::Mode;
use crate::state::AppState;

/// Nudges for one source closer together than this are one nudge.
pub const DEDUPE: Duration = Duration::from_secs(60);

/// Poll sources a provider can nudge (docs/ingest-modes.md "Nudges"): ERDDAP on CRW change, and
/// IEMBot on NWS products for the alert poller and the river and weather forecast pollers. Their
/// mode stays what the ledger says (`crw` reports `webhook`, the rest `poll`); this list only
/// opens the route and lets the scheduler task be woken.
pub const NUDGE_SOURCES: [&str; 5] = ["crw", "nws-alerts", "nws-forecast", "nwps", "iem"];

/// Whether a source with this id and mode takes nudges.
pub fn capable(id: &str, mode: Mode) -> bool {
    mode == Mode::Webhook || NUDGE_SOURCES.contains(&id)
}

pub fn routes() -> Router<AppRegistry> {
    Router::new().route("/ingest/nudge/{source}/{token}", get(receive).post(receive))
}

/// Outcome of [`Nudges::nudge`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Nudged {
    Accepted,
    Duplicate,
}

#[derive(Default)]
struct Slot {
    notify: Arc<Notify>,
    last: Option<Instant>,
}

/// One app's nudge slots, by source id. Held in `AppState`, so apps never share one.
#[derive(Default)]
pub struct Nudges {
    slots: Mutex<HashMap<String, Slot>>,
}

impl Nudges {
    /// The `Notify` a source's poll loop waits on.
    pub fn waker(&self, source: &str) -> Arc<Notify> {
        let mut slots = self.slots.lock().unwrap_or_else(|p| p.into_inner());
        slots.entry(source.to_string()).or_default().notify.clone()
    }

    /// Wake `source` unless it was woken less than [`DEDUPE`] before `now`. `notify_one` keeps a
    /// permit when the loop is not waiting yet (mid-fetch, or not started), so no nudge is lost.
    pub fn nudge(&self, source: &str, now: Instant) -> Nudged {
        let mut slots = self.slots.lock().unwrap_or_else(|p| p.into_inner());
        let slot = slots.entry(source.to_string()).or_default();
        if slot.last.is_some_and(|t| now.saturating_duration_since(t) < DEDUPE) {
            return Nudged::Duplicate;
        }
        slot.last = Some(now);
        slot.notify.notify_one();
        Nudged::Accepted
    }
}

/// Constant-time comparison, so response timing does not leak the token prefix.
fn token_matches(expected: &str, given: &str) -> bool {
    let (a, b) = (expected.as_bytes(), given.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Whether `source` is a poll source of `state.app` that takes nudges ([`capable`]).
pub fn nudgeable(state: &AppState, source: &str) -> bool {
    crate::ingest::poll::all(&state.config, &state.app).iter().any(|s| {
        let info = s.info();
        info.id == source && capable(info.id, info.mode)
    })
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

async fn receive(state: AppState, Path((_app, source, token)): Path<(String, String, String)>) -> Response {
    let Some(expected) = state.config.ingest_nudge_token.as_deref() else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "ingest nudge disabled: INGEST_NUDGE_TOKEN is not set");
    };
    if !token_matches(expected, &token) {
        return error(StatusCode::UNAUTHORIZED, "bad nudge token");
    }
    // Only after authentication, so unauthenticated callers cannot probe source ids.
    if !nudgeable(&state, &source) {
        return error(StatusCode::NOT_FOUND, format!("source {source} takes no nudges in app {}", state.app.id()));
    }
    match state.nudges.nudge(&source, Instant::now()) {
        Nudged::Accepted => {
            tracing::info!(app = state.app.id(), source = %source, "nudge: waking the poll loop");
            (StatusCode::ACCEPTED, Json(json!({ "status": "accepted", "source": source }))).into_response()
        }
        Nudged::Duplicate => (StatusCode::OK, Json(json!({ "status": "duplicate", "source": source }))).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use serde_json::Value;
    use tower::ServiceExt;

    use super::*;
    use crate::app::test_support::{router_for, test_registry, test_state_for};
    use crate::ingest::source::{FetchCtx, RawPayload, Source, SourceInfo};
    use crate::model::Row;

    async fn call(router: &axum::Router, method: &str, uri: &str) -> (StatusCode, Value) {
        let res = router.clone().oneshot(Request::builder().method(method).uri(uri).body(Body::empty()).unwrap()).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// Every nudge-capable feed has the route in the app that runs it: carp `nws-alerts`,
    /// `nws-forecast`, `nwps`, `iem`; lionfish `crw`. Each is accepted once and is a duplicate
    /// within 60 s; bad token 401; unknown app or a source that takes no nudges 404.
    #[tokio::test]
    async fn ingest_nudge_route_for_every_capable_feed() {
        let registry = test_registry();
        let router = crate::app::app(registry.clone());
        let capable = [("carp", "nws-alerts"), ("carp", "nws-forecast"), ("carp", "nwps"), ("carp", "iem"), ("lionfish", "crw")];
        let mut seen: Vec<&str> = capable.iter().map(|(_, s)| *s).collect();
        seen.sort_unstable();
        let mut listed = NUDGE_SOURCES.to_vec();
        listed.sort_unstable();
        assert_eq!(seen, listed, "the test covers the whole list");
        for (app, source) in capable {
            assert!(nudgeable(registry.get(app).unwrap(), source), "{app}/{source}");
            for method in ["POST", "GET"] {
                let uri = format!("/v1/{app}/ingest/nudge/{source}/test-nudge-token");
                let (s, b) = call(&router, method, &uri).await;
                let want = if method == "POST" { (StatusCode::ACCEPTED, "accepted") } else { (StatusCode::OK, "duplicate") };
                assert_eq!((s, b["status"].as_str().unwrap_or_default()), want, "{method} {uri}: {b}");
                assert_eq!(b["source"], source);
            }
            let (s, _) = call(&router, "POST", &format!("/v1/{app}/ingest/nudge/{source}/wrong-token")).await;
            assert_eq!(s, StatusCode::UNAUTHORIZED);
        }
        for uri in [
            "/v1/otter/ingest/nudge/nwps/test-nudge-token",
            "/v1/carp/ingest/nudge/usgs/test-nudge-token",
            "/v1/carp/ingest/nudge/crw/test-nudge-token",
            "/v1/python/ingest/nudge/nws/test-nudge-token",
            "/v1/lionfish/ingest/nudge/nwps/test-nudge-token",
            "/v1/carp/ingest/nudge/nope/test-nudge-token",
        ] {
            let (s, b) = call(&router, "POST", uri).await;
            assert_eq!(s, StatusCode::NOT_FOUND, "{uri}: {b}");
        }
        let (_, b) = call(&router, "POST", "/v1/otter/ingest/nudge/nwps/test-nudge-token").await;
        assert_eq!(b["error"], "unknown_app");
    }

    /// Nudges are per app: the same source id in two apps keeps two dedupe slots.
    #[test]
    fn ingest_nudge_dedupe_is_per_app_and_source() {
        let (carp, other) = (Nudges::default(), Nudges::default());
        let t0 = Instant::now();
        assert_eq!(carp.nudge("nwps", t0), Nudged::Accepted);
        assert_eq!(carp.nudge("nwps", t0 + Duration::from_secs(30)), Nudged::Duplicate);
        assert_eq!(carp.nudge("iem", t0 + Duration::from_secs(30)), Nudged::Accepted);
        assert_eq!(other.nudge("nwps", t0 + Duration::from_secs(30)), Nudged::Accepted);
        assert_eq!(carp.nudge("nwps", t0 + DEDUPE), Nudged::Accepted);
    }

    /// A poll-mode source that counts fetches (the id makes it nudge-capable).
    struct Counting {
        id: &'static str,
        fetches: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl Source for Counting {
        fn info(&self) -> SourceInfo {
            SourceInfo { id: self.id, name: "counting", homepage: "", mode: Mode::Poll, cadence: Duration::from_secs(3600), max_latency: Duration::from_secs(7200) }
        }
        async fn fetch(&self, _ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
            self.fetches.fetch_add(1, Ordering::SeqCst);
            Ok(Vec::new())
        }
        fn normalize(&self, _raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
            Ok(Vec::new())
        }
    }

    /// The scheduler task of a poll-mode nudge source (carp `nwps`, hourly here) sleeps until its
    /// next poll; a nudge runs the fetch now, and a repeat within 60 s runs nothing.
    #[tokio::test]
    async fn ingest_nudge_wakes_the_poll_task() {
        let state = test_state_for("carp");
        let router = router_for(&state);
        let fetches = Arc::new(AtomicUsize::new(0));
        let source: Arc<dyn Source> = Arc::new(Counting { id: "nwps", fetches: fetches.clone() });
        let handles = crate::ingest::scheduler::spawn_sources(&state, vec![source], Default::default());
        let wait_for = |n: usize| {
            let fetches = fetches.clone();
            async move {
                for _ in 0..300 {
                    if fetches.load(Ordering::SeqCst) >= n {
                        return true;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                false
            }
        };
        assert!(wait_for(1).await, "boot fetch");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(fetches.load(Ordering::SeqCst), 1, "asleep until the next poll");
        let (s, _) = call(&router, "GET", "/v1/carp/ingest/nudge/nwps/test-nudge-token").await;
        assert_eq!(s, StatusCode::ACCEPTED);
        assert!(wait_for(2).await, "the nudge woke the task");
        let (s, _) = call(&router, "POST", "/v1/carp/ingest/nudge/nwps/test-nudge-token").await;
        assert_eq!(s, StatusCode::OK);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(fetches.load(Ordering::SeqCst), 2, "the duplicate fetched nothing");
        for h in handles {
            h.abort();
        }
    }
}
