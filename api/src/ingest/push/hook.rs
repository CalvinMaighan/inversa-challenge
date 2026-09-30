//! Signed webhook receiver /v1/ingest/hook/:source (PLAN.md C10, T5).

use axum::Router;

use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
}
