//! Same-origin media proxy /v1/media/:id (T10).

use axum::Router;

use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
}
