mod app;
mod archive;
mod backfill;
mod crdt;
mod db;
#[cfg(test)]
mod e2e_tests;
mod evidence;
mod feed_state;
mod forecast;
mod frames;
mod graphql;
mod hotspot;
mod ingest;
mod media;
mod model;
mod overlay;
mod realtime;
mod review;
mod source_pages;
mod state;
mod vessels;

use tokio::net::TcpListener;

use crate::app::AppRegistry;
use crate::state::Config;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let config = Config::from_env();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("backfill") {
        // The backfill opens only the app it writes (`--app`, default carp), never the others.
        let parsed = backfill::parse_args(&args[1..]).unwrap_or_else(|e| panic!("backfill: {e:#}"));
        let app_id = parsed.app.clone().unwrap_or_else(|| app::config::DEFAULT_APP.to_string());
        let registry = AppRegistry::open(config, std::slice::from_ref(&app_id)).unwrap_or_else(|e| panic!("open {app_id}: {e:#}"));
        let state = registry.get(&app_id).expect("just opened").clone();
        backfill::run(state, &args[1..]).await.unwrap_or_else(|e| panic!("backfill: {e:#}"));
        return;
    }

    let ids = app::selected_ids().unwrap_or_else(|e| panic!("INVERSA_APPS: {e:#}"));
    let bind = config.bind.clone();
    let data_dir = config.data_dir.clone();
    let registry = AppRegistry::open(config, &ids).unwrap_or_else(|e| panic!("open apps: {e:#}"));
    for state in registry.iter() {
        ingest::scheduler::spawn(state.clone());
        frames::spawn_builder(state.clone());
        feed_state::spawn_publisher(state.obs.clone(), state.hub.clone(), std::time::Duration::from_secs(15));
    }

    let listener = TcpListener::bind(&bind).await.unwrap_or_else(|e| panic!("bind {bind}: {e}"));
    tracing::info!("inversa-api on {bind} ({}) apps {}", data_dir.display(), registry.ids().join(","));
    axum::serve(listener, app::app(registry).into_make_service_with_connect_info::<std::net::SocketAddr>())
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
        })
        .await
        .expect("serve");
}
