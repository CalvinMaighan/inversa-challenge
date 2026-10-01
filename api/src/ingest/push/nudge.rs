//! Provider nudge receiver `/v1/{app}/ingest/nudge/{source}/{token}` (L3; docs/ingest-modes.md).
//!
//! Some providers can call a URL when a dataset changes but cannot sign the call: ERDDAP
//! subscriptions with a URL action (`crw`). A nudge carries no data; it wakes the source's poll
//! loop so the fetch runs now instead of at the next backstop poll. The token in the path
//! (`INGEST_NUDGE_TOKEN`) is the whole authentication. ERDDAP calls its action URL with GET, so
//! GET and POST are both accepted. Responses:
//! - 404 `unknown_app` for an app that is not running (the `AppState` extractor);
//! - 503 when `INGEST_NUDGE_TOKEN` is not set;
//! - 401 for a wrong token;
//! - 404 for a source this app does not run in `webhook` mode;
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

/// Sources of `state.app` that take nudges (`Mode::Webhook`).
pub fn nudgeable(state: &AppState, source: &str) -> bool {
    crate::ingest::poll::all(&state.config, &state.app).iter().any(|s| {
        let info = s.info();
        info.id == source && info.mode == Mode::Webhook
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
