//! Multi-app process (PLAN.md C-A1, C-A2): one `AppState` per app id held in an
//! `AppRegistry`, routes under `/v1/{app}/...`, a global `/health`.
//!
//! Each app has its own data dir `<INVERSA_DATA_DIR>/<app>/{observations,team}.db`, its own
//! archive prefix, `Hub`, scheduler, frame builder and feed-state publisher; nothing mutable is
//! shared between apps. Handlers take [`AppState`] as an extractor: it reads the `{app}` path
//! segment and answers 404 `{"error":"unknown_app","apps":[...]}` for an id that is not running.

pub mod config;

use std::sync::Arc;

use axum::extract::{FromRequestParts, Path};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;

use crate::app::config::{App, AppConfig, ConfigError, APP_IDS, DEFAULT_APP};
use crate::archive::Archive;
use crate::state::{AppState, Config};

/// Every running app, by id. Cheap to clone (one `Arc`).
#[derive(Clone)]
pub struct AppRegistry {
    apps: Arc<Vec<AppState>>,
}

impl AppRegistry {
    /// Open every app in `ids` (config order) under `config.data_dir`, sharing the HTTP client
    /// and the archive backend. `ids` defaults to all three (`INVERSA_APPS` narrows it).
    pub fn open(config: Config, ids: &[String]) -> anyhow::Result<AppRegistry> {
        anyhow::ensure!(!ids.is_empty(), "no apps selected; INVERSA_APPS must name at least one of {}", APP_IDS.join(", "));
        std::fs::create_dir_all(&config.data_dir)?;
        let archive = crate::ingest::archive::from_config(&config)?;
        let http = crate::state::http_client(&config);
        let config = Arc::new(config);
        let mut apps = Vec::with_capacity(ids.len());
        for id in ids {
            let app = App::builtin(id)?;
            let state = AppState::open(config.clone(), http.clone(), archive.clone(), app)?;
            tracing::info!(app = %id, "opened {}", state.config.data_dir.join(id).display());
            apps.push(state);
        }
        let registry = AppRegistry::from_states(apps);
        debug_assert!(!registry.is_empty());
        Ok(registry)
    }

    pub fn from_states(apps: Vec<AppState>) -> AppRegistry {
        let mut seen = std::collections::HashSet::new();
        for s in &apps {
            assert!(seen.insert(s.app.id().to_string()), "app {} opened twice", s.app.id());
        }
        AppRegistry { apps: Arc::new(apps) }
    }

    pub fn get(&self, id: &str) -> Option<&AppState> {
        self.apps.iter().find(|s| s.app.id() == id)
    }

    pub fn ids(&self) -> Vec<&str> {
        self.apps.iter().map(|s| s.app.id()).collect()
    }

    pub fn iter(&self) -> impl Iterator<Item = &AppState> {
        self.apps.iter()
    }

    pub fn len(&self) -> usize {
        self.apps.len()
    }

    pub fn is_empty(&self) -> bool {
        self.apps.is_empty()
    }
}

/// App ids to run: `INVERSA_APPS` (comma-separated) or all three.
pub fn selected_ids() -> anyhow::Result<Vec<String>> {
    let Some(raw) = std::env::var("INVERSA_APPS").ok().filter(|v| !v.trim().is_empty()) else {
        return Ok(APP_IDS.iter().map(|s| s.to_string()).collect());
    };
    let mut out = Vec::new();
    for id in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        anyhow::ensure!(APP_IDS.contains(&id), "{}", ConfigError::UnknownApp(id.to_string()));
        if !out.iter().any(|x| x == id) {
            out.push(id.to_string());
        }
    }
    Ok(out)
}

/// A JSON error body `{"error": code, ...extra}`.
pub fn json_error(status: StatusCode, code: &str, extra: serde_json::Value) -> Response {
    let mut body = serde_json::json!({ "error": code });
    if let (Some(b), Some(e)) = (body.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            b.insert(k.clone(), v.clone());
        }
    }
    (status, Json(body)).into_response()
}

#[derive(Deserialize)]
struct AppPath {
    app: String,
}

/// `AppState` as an extractor: the app named by the `{app}` path segment. Unknown ids are
/// 404 `unknown_app` with the running ids, so a client can recover.
impl FromRequestParts<AppRegistry> for AppState {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, registry: &AppRegistry) -> Result<Self, Self::Rejection> {
        let Path(AppPath { app }) = Path::<AppPath>::from_request_parts(parts, registry)
            .await
            .map_err(|e| json_error(StatusCode::NOT_FOUND, "unknown_app", serde_json::json!({ "apps": registry.ids(), "detail": e.body_text() })))?;
        registry.get(&app).cloned().ok_or_else(|| {
            json_error(StatusCode::NOT_FOUND, "unknown_app", serde_json::json!({ "app": app, "apps": registry.ids() }))
        })
    }
}

/// Route table (C-A2). Each module owns its own `routes()` under the app prefix; this file
/// only merges them.
pub fn app(registry: AppRegistry) -> Router {
    let per_app = Router::new()
        .merge(crate::graphql::routes())
        .merge(crate::ingest::push::hook::routes())
        .merge(crate::ingest::push::nudge::routes())
        .merge(crate::frames::routes())
        .merge(crate::carp_fish::routes())
        .merge(crate::media::routes())
        .merge(crate::overlay::routes());
    Router::new().route("/health", get(health)).nest("/v1/{app}", per_app).with_state(registry)
}

/// The file behind a database's `main` schema, or `None` for an in-memory database.
async fn db_file(db: &crate::db::Db) -> anyhow::Result<Option<std::path::PathBuf>> {
    let file: String = db.read(|c| c.query_row("select file from pragma_database_list where name = 'main'", [], |r| r.get(0))).await?;
    Ok((!file.is_empty()).then(|| std::path::PathBuf::from(file)))
}

/// Both of an app's databases answer a query and, when file-backed, still exist on disk. A file
/// deleted under a running process keeps answering from the unlinked inode while every write
/// is lost at the next restart and Litestream stops replicating it, so it counts as a failure.
async fn check_dbs(state: &AppState) -> anyhow::Result<()> {
    for (name, db) in [("observations.db", &state.obs), ("team.db", &state.team)] {
        let path = db_file(db).await.map_err(|e| anyhow::anyhow!("{}/{name} does not answer: {e:#}", state.app.id()))?;
        if let Some(path) = path {
            anyhow::ensure!(path.exists(), "{}/{name} is missing on disk; restart inversa-api to restore it from the replica", state.app.id());
        }
    }
    Ok(())
}

/// `GET /health`: every running app with its config summary and per-app feed health (C3
/// envelopes, as `feeds` returns them). An app whose databases fail [`check_dbs`] or whose
/// feed state cannot be computed has `feeds: {error}` and makes the answer 503 `degraded`;
/// the other apps are reported as usual.
async fn health(axum::extract::State(registry): axum::extract::State<AppRegistry>) -> Response {
    let mut apps = Vec::with_capacity(registry.len());
    let mut status = "ok";
    for state in registry.iter() {
        let computed = match check_dbs(state).await {
            Ok(()) => crate::feed_state::compute(&state.obs, state.now_ms()).await,
            Err(e) => Err(e),
        };
        let feeds = match computed {
            Ok(f) => serde_json::to_value(f).unwrap_or_default(),
            Err(e) => {
                status = "degraded";
                serde_json::json!({ "error": format!("{e:#}") })
            }
        };
        let cfg: &AppConfig = &state.app.cfg;
        apps.push(serde_json::json!({
            "id": cfg.id,
            "name": cfg.name,
            "kind": cfg.kind,
            "provisional": cfg.provisional,
            "regions": cfg.regions.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            "taxa": cfg.taxa.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            "feeds": feeds,
        }));
    }
    (
        if status == "ok" { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE },
        Json(serde_json::json!({ "status": status, "defaultApp": DEFAULT_APP, "apps": apps })),
    )
        .into_response()
}

/// Per-app archive view: every key the app writes is stored under `<app>/`, so two apps that
/// archive the same source never overwrite each other's objects while keys inside the app keep
/// their documented `raw/<source>/...` and `media/<id>` form.
pub struct AppArchive {
    inner: Arc<dyn Archive>,
    prefix: String,
}

impl AppArchive {
    pub fn new(inner: Arc<dyn Archive>, app_id: &str) -> AppArchive {
        AppArchive { inner, prefix: format!("{app_id}/") }
    }

    fn key(&self, key: &str) -> String {
        format!("{}{key}", self.prefix)
    }
}

#[async_trait::async_trait]
impl Archive for AppArchive {
    async fn put(&self, key: &str, bytes: Vec<u8>, content_type: &str) -> anyhow::Result<()> {
        self.inner.put(&self.key(key), bytes, content_type).await
    }

    async fn get(&self, key: &str) -> anyhow::Result<Vec<u8>> {
        self.inner.get(&self.key(key)).await
    }
}

#[cfg(test)]
pub mod test_support {
    use super::*;

    /// In-memory state of one app for oneshot tests: memory DBs, memory archive, no network sources.
    pub fn test_state_for(id: &str) -> AppState {
        AppState::memory(Config::for_tests(), App::builtin(id).unwrap())
    }

    /// The python app (the pre-pivot single-tenant behaviour every older test asserts).
    pub fn test_state() -> AppState {
        test_state_for("python")
    }

    /// All three apps, each in memory.
    pub fn test_registry() -> AppRegistry {
        AppRegistry::from_states(APP_IDS.iter().map(|id| test_state_for(id)).collect())
    }

    /// A router serving every app, plus the python state.
    pub fn test_app() -> (Router, AppState) {
        let registry = test_registry();
        let python = registry.get("python").unwrap().clone();
        (app(registry), python)
    }

    /// A router serving only `state`'s app.
    pub fn router_for(state: &AppState) -> Router {
        app(AppRegistry::from_states(vec![state.clone()]))
    }
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use tower::ServiceExt;

    use super::test_support::*;
    use super::*;
    use crate::hotspot::score::testkit::{insert_sighting, ms, seed_sources, HOUR};

    async fn get_json(app: &Router, uri: &str) -> (StatusCode, Value) {
        let res = app.clone().oneshot(Request::get(uri).body(Body::empty()).unwrap()).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn post_gql(app: &Router, path: &str, query: &str) -> (StatusCode, Value) {
        let res = app
            .clone()
            .oneshot(
                Request::post(path)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({ "query": query }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// C-A2: `/health` lists every app with feed health; unknown apps are 404 JSON; the old
    /// unprefixed routes are gone.
    #[tokio::test]
    async fn app_routes_health_prefixes_and_unknown_app() {
        let (app, python) = test_app();
        seed_sources(&python.obs).await;
        let (status, body) = get_json(&app, "/health").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["status"], "ok");
        assert_eq!(body["defaultApp"], "carp");
        let ids: Vec<&str> = body["apps"].as_array().unwrap().iter().map(|a| a["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["carp", "lionfish", "python"]);
        let py = &body["apps"][2];
        assert_eq!(py["kind"], "species");
        assert_eq!(py["regions"], json!(["everglades"]));
        assert_eq!(py["taxa"], json!(["python"]));
        let feeds = py["feeds"].as_array().unwrap();
        assert_eq!(feeds.len(), 8, "the seeded sources: {py}");
        assert!(feeds.iter().all(|f| f["source"].is_string() && f["state"].is_string() && f["mode"].is_string()), "{py}");
        assert_eq!(body["apps"][0]["kind"], "conditions");
        assert_eq!(body["apps"][0]["feeds"], json!([]), "carp has nothing registered in a test state");

        for uri in ["/v1/otter/graphql", "/v1/otter/frames?from=0&to=0", "/v1/otter/media/1", "/v1/otter/ingest/hook/web"] {
            let res = app.clone().oneshot(Request::post(uri).body(Body::empty()).unwrap()).await.unwrap();
            let res = if res.status() == StatusCode::METHOD_NOT_ALLOWED {
                app.clone().oneshot(Request::get(uri).body(Body::empty()).unwrap()).await.unwrap()
            } else {
                res
            };
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "{uri}");
            let body: Value = serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
            assert_eq!(body["error"], "unknown_app", "{uri}: {body}");
            assert_eq!(body["apps"], json!(["carp", "lionfish", "python"]), "{uri}");
        }
        for uri in ["/v1/graphql", "/v1/frames?from=0&to=0", "/v1/media/1", "/v1/ingest/hook/web", "/v1/python"] {
            let res = app.clone().oneshot(Request::get(uri).body(Body::empty()).unwrap()).await.unwrap();
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "old route {uri}");
        }
        // Every prefixed surface answers for a known app.
        let (status, body) = post_gql(&app, "/v1/python/graphql", "{ feeds { source } }").await;
        assert_eq!((status, body["data"]["feeds"].as_array().map(Vec::len)), (StatusCode::OK, Some(8)), "{body}");
        let (status, body) = post_gql(&app, "/v1/lionfish/graphql", "{ feeds { source } }").await;
        assert_eq!((status, body["data"]["feeds"].as_array().map(Vec::len)), (StatusCode::OK, Some(0)), "{body}");
        let res = app.clone().oneshot(Request::get("/v1/carp/frames?from=0&to=0").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        let body: Value = serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(body["error"], "no_frames", "{body}");
        let res = app.clone().oneshot(Request::get("/v1/python/media/photo.jpg").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST, "media route is mounted under the app");
    }

    /// C-A1: a sighting written in app A is invisible to app B through GraphQL, frames and the Hub.
    #[tokio::test]
    async fn app_isolation_between_python_and_lionfish() {
        let registry = test_registry();
        let app = super::app(registry.clone());
        let python = registry.get("python").unwrap();
        let lionfish = registry.get("lionfish").unwrap();
        seed_sources(&python.obs).await;
        seed_sources(&lionfish.obs).await;
        let mut lionfish_events = lionfish.hub.subscribe();
        let t = ms(2026, 6, 1, 12);
        // A python sighting in the Everglades box (which overlaps lionfish's Keys region), written in python.
        let g = python.app.regions[0].grid;
        let (lon, lat) = g.center(g.index(100, 100));
        let id = insert_sighting(&python.obs, "inat", 1, lat, lon, t, "research", None).await;
        python.hub.publish(crate::realtime::Event::RowsWritten { from: t, to: t });

        let window = format!("from: \"{}\", to: \"{}\"", iso(t - HOUR), iso(t + HOUR));
        let bbox = format!("{{west: {}, south: {}, east: {}, north: {}}}", lon - 0.01, lat - 0.01, lon + 0.01, lat + 0.01);
        let q = format!("{{ sightings(bbox: {bbox}, {window}) {{ id taxon {{ id }} }} }}");
        let (_, body) = post_gql(&app, "/v1/python/graphql", &q).await;
        assert_eq!(body["data"]["sightings"][0]["id"], id.to_string(), "{body}");
        let (_, body) = post_gql(&app, "/v1/lionfish/graphql", &q).await;
        assert_eq!(body["data"]["sightings"], json!([]), "{body}");
        let (_, body) = post_gql(&app, "/v1/lionfish/graphql", &format!("{{ speciesCounts(bbox: {bbox}, {window}) {{ count }} }}")).await;
        assert_eq!(body["data"]["speciesCounts"], json!([]), "{body}");
        let (_, body) = post_gql(&app, "/v1/lionfish/graphql", &format!("{{ evidence(id: \"sighting:{id}\") {{ id }} }}")).await;
        assert!(body["errors"][0]["message"].as_str().unwrap().starts_with("not found"), "{body}");

        // Frames: python's frame carries the record, lionfish's (fl-keys region, same cell) does not.
        let py_bytes = crate::frames::chunk(&python.obs, &python.app, t, t, 60).await.unwrap();
        let lf_bytes = crate::frames::chunk(&lionfish.obs, &lionfish.app, t, t, 60).await.unwrap();
        let py_layout = python.app.regions[0].layout;
        let n = u32::from_le_bytes(py_bytes[crate::frames::HEADER_BYTES + py_layout.sightings_offset(1)..][..4].try_into().unwrap());
        assert_eq!(n, 1);
        let lf_header = crate::frames::read_header(&lf_bytes).unwrap();
        let fl = lionfish.app.region("fl-keys").unwrap().layout;
        let n = u32::from_le_bytes(lf_bytes[lf_header.len() + fl.sightings_offset(1)..][..4].try_into().unwrap());
        assert_eq!(n, 0, "lionfish's Keys region saw no row");
        let stored_lf: i64 = lionfish.obs.read(|c| c.query_row("select count(*) from sightings", [], |r| r.get(0))).await.unwrap();
        assert_eq!(stored_lf, 0);

        // Hub: python's RowsWritten never reached lionfish's subscribers.
        assert!(matches!(lionfish_events.try_recv(), Err(tokio::sync::broadcast::error::TryRecvError::Empty)));
        // Team boards are per app too.
        python.team.write(|tx| tx.execute("insert into ops (seq, id, board_id, hlc, entity, entity_id, field, value, node_id, received_at) values (1, 'o1', 'python:main', '1:0:n', 'note', 'e', 'text', '\"x\"', 'n', 0)", [])).await.unwrap();
        let (_, body) = post_gql(&app, "/v1/python/graphql", "{ opsSince(boardId: \"python:main\", seq: 0) { id } }").await;
        assert_eq!(body["data"]["opsSince"], json!([{"id": "o1"}]));
        let (_, body) = post_gql(&app, "/v1/lionfish/graphql", "{ opsSince(boardId: \"python:main\", seq: 0) { id } }").await;
        assert_eq!(body["data"]["opsSince"], json!([]));
        // Archives are prefixed per app: the same key in two apps holds two objects.
        python.archive.put("media/1", b"py".to_vec(), "text/plain").await.unwrap();
        lionfish.archive.put("media/1", b"lf".to_vec(), "text/plain").await.unwrap();
        assert_eq!(python.archive.get("media/1").await.unwrap(), b"py");
        assert_eq!(lionfish.archive.get("media/1").await.unwrap(), b"lf");
    }

    /// C-A1: file-backed apps open under `<dir>/<app>/{observations,team}.db` with the taxa synced.
    #[tokio::test]
    async fn app_isolation_registry_opens_one_dir_per_app() {
        let dir = std::env::temp_dir().join(format!("inversa-registry-{}", uuid::Uuid::now_v7()));
        let mut config = Config::for_tests();
        config.data_dir = dir.clone();
        let ids: Vec<String> = ["lionfish", "python"].iter().map(|s| s.to_string()).collect();
        let registry = AppRegistry::open(config, &ids).unwrap();
        assert_eq!(registry.ids(), ["lionfish", "python"]);
        for id in ["lionfish", "python"] {
            for db in ["observations.db", "team.db"] {
                assert!(dir.join(id).join(db).is_file(), "{id}/{db}");
            }
        }
        assert!(!dir.join("carp").exists(), "carp was not selected");
        let lf = registry.get("lionfish").unwrap();
        let focus: Vec<String> = lf
            .obs
            .read(|c| c.prepare("select scientific_name from taxa where focus = 1")?.query_map([], |r| r.get(0))?.collect())
            .await
            .unwrap();
        assert_eq!(focus, ["Pterois volitans/miles"]);
        assert_eq!(lf.app.taxa[0].taxon_id, 4);
        let py = registry.get("python").unwrap();
        assert_eq!(py.app.taxa.iter().map(|t| t.taxon_id).collect::<Vec<_>>(), [1]);
        assert!(registry.get("carp").is_none());
        drop(registry);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// R19: a database file deleted under the running API makes that app's `/health` entry an
    /// error (503 `degraded`); the other apps keep reporting their feeds.
    #[tokio::test]
    async fn health_reports_a_missing_db_file_per_app() {
        let dir = std::env::temp_dir().join(format!("inversa-health-{}", uuid::Uuid::now_v7()));
        let mut config = Config::for_tests();
        config.data_dir = dir.clone();
        let ids: Vec<String> = APP_IDS.iter().map(|s| s.to_string()).collect();
        let registry = AppRegistry::open(config, &ids).unwrap();
        let router = super::app(registry.clone());
        let (status, body) = get_json(&router, "/health").await;
        assert_eq!((status, &body["status"]), (StatusCode::OK, &json!("ok")), "{body}");

        std::fs::remove_file(dir.join("lionfish/observations.db")).unwrap();
        let (status, body) = get_json(&router, "/health").await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["status"], "degraded");
        let err = body["apps"][1]["feeds"]["error"].as_str().unwrap();
        assert!(err.starts_with("lionfish/observations.db is missing on disk"), "{err}");
        assert!(body["apps"][0]["feeds"].is_array() && body["apps"][2]["feeds"].is_array(), "{body}");

        std::fs::remove_file(dir.join("python/team.db")).unwrap();
        let (_, body) = get_json(&router, "/health").await;
        assert!(body["apps"][2]["feeds"]["error"].as_str().unwrap().starts_with("python/team.db is missing on disk"), "{body}");
        drop((router, registry));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn app_routes_selected_ids_env() {
        assert_eq!(selected_ids().unwrap(), ["carp", "lionfish", "python"]);
    }

    fn iso(ms: i64) -> String {
        chrono::DateTime::from_timestamp_millis(ms).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }
}
