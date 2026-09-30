//! GraphQL at /v1/graphql (PLAN.md C2). T4 wires the schema; T10 implements resolvers.

mod mutation;
mod query;
mod subscription;

use axum::Router;

use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
}
