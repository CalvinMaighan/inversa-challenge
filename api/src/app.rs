use axum::routing::get;
use axum::Router;

use crate::state::AppState;

/// Route table. Each module owns its own `routes()`; this file only merges them.
pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .merge(crate::graphql::routes())
        .merge(crate::ingest::push::hook::routes())
        .merge(crate::frames::routes())
        .merge(crate::media::routes())
        .with_state(state)
}

#[cfg(test)]
pub mod test_support {
    use super::*;
    use crate::state::Config;

    /// In-memory state for oneshot tests: memory DBs, memory archive, no network sources.
    pub fn test_state() -> AppState {
        AppState::memory(Config::for_tests())
    }

    pub fn test_app() -> (Router, AppState) {
        let state = test_state();
        (app(state.clone()), state)
    }
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[tokio::test]
    async fn health_is_ok() {
        let (app, _) = super::test_support::test_app();
        let res = app.oneshot(Request::get("/health").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = res.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"ok");
    }
}
