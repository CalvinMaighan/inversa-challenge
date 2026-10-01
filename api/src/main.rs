mod app;
mod archive;
mod backfill;
mod crdt;
mod db;
#[cfg(test)]
mod e2e_tests;
mod evidence;
mod feed_state;
mod frames;
mod graphql;
mod hotspot;
mod ingest;
mod media;
mod model;
mod realtime;
mod source_pages;
mod state;

use tokio::net::TcpListener;

use crate::state::{AppState, Config};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let config = Config::from_env();
    let state = AppState::open(config).unwrap_or_else(|e| panic!("open state: {e:#}"));

    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("backfill") {
        backfill::run(state, &args[1..]).await.unwrap_or_else(|e| panic!("backfill: {e:#}"));
        return;
    }

    ingest::scheduler::spawn(state.clone());
    frames::spawn_builder(state.clone());
    feed_state::spawn_publisher(state.obs.clone(), state.hub.clone(), std::time::Duration::from_secs(15));

    let bind = state.config.bind.clone();
    let listener = TcpListener::bind(&bind).await.unwrap_or_else(|e| panic!("bind {bind}: {e}"));
    tracing::info!("inversa-api on {bind} ({})", state.config.data_dir.display());
    axum::serve(listener, app::app(state).into_make_service_with_connect_info::<std::net::SocketAddr>())
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
        })
        .await
        .expect("serve");
}
