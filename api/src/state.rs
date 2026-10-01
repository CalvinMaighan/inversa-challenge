use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::app::config::App;
use crate::app::AppArchive;
use crate::archive::{Archive, MemArchive};
use crate::db::Db;
use crate::ingest::push::nudge::Nudges;
use crate::realtime::Hub;

/// Process configuration, read once from the environment (PLAN.md C13). Secrets stay optional so
/// the API boots in dev without them; each feature reports itself as disabled when its secret is missing.
#[derive(Debug, Clone)]
pub struct Config {
    pub bind: String,
    /// Root data dir; each app lives in `<data_dir>/<app>/`.
    pub data_dir: PathBuf,
    /// Contact string sent in User-Agent (NWS requires one).
    pub user_agent: String,
    pub ingest_hook_secret: Option<String>,
    /// `INGEST_NUDGE_TOKEN`: the path token provider nudges (ERDDAP subscriptions) must carry.
    /// Providers cannot sign, so the token is the whole authentication; unset disables nudges.
    pub ingest_nudge_token: Option<String>,
    pub r2: Option<R2Config>,
    /// `GOES_SQS_URL`: the queue every app listing `goes19` consumes unless it has its own.
    pub goes_sqs_url: Option<String>,
    /// `GOES_SQS_URL_<APP>` (app id upper-cased): that app's own queue. Two apps on one queue are
    /// competing consumers (each sees a share of the objects), so give each its own SNS
    /// subscription and queue.
    pub goes_sqs_urls: Vec<(String, String)>,
    pub aws_access_key_id: Option<String>,
    pub aws_secret_access_key: Option<String>,
    pub nwws_user: Option<String>,
    pub nwws_pass: Option<String>,
    /// `USGS_API_KEY`: a free key for api.waterdata.usgs.gov raises the anonymous per-IP rate
    /// limit; sent as `X-Api-Key` by the `usgs` poller when set.
    pub usgs_api_key: Option<String>,
    /// When false, the scheduler starts no network sources (tests, offline dev).
    pub sources_enabled: bool,
}

#[derive(Debug, Clone)]
pub struct R2Config {
    pub account_id: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub bucket_raw: String,
}

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

impl Config {
    pub fn from_env() -> Self {
        let r2 = match (env("R2_ACCOUNT_ID"), env("R2_ACCESS_KEY_ID"), env("R2_SECRET_ACCESS_KEY"), env("R2_BUCKET_RAW")) {
            (Some(account_id), Some(access_key_id), Some(secret_access_key), Some(bucket_raw)) => {
                Some(R2Config { account_id, access_key_id, secret_access_key, bucket_raw })
            }
            _ => None,
        };
        Config {
            bind: env("INVERSA_BIND").unwrap_or_else(|| "127.0.0.1:4041".into()),
            data_dir: env("INVERSA_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("./data")),
            user_agent: env("INVERSA_USER_AGENT")
                .unwrap_or_else(|| "inversa-challenge (calvinmaighan@gmail.com)".into()),
            ingest_hook_secret: env("INGEST_HOOK_SECRET"),
            ingest_nudge_token: env("INGEST_NUDGE_TOKEN"),
            r2,
            goes_sqs_url: env("GOES_SQS_URL"),
            goes_sqs_urls: crate::app::config::APP_IDS
                .iter()
                .filter_map(|id| env(&format!("GOES_SQS_URL_{}", id.to_ascii_uppercase())).map(|url| (id.to_string(), url)))
                .collect(),
            aws_access_key_id: env("AWS_ACCESS_KEY_ID"),
            aws_secret_access_key: env("AWS_SECRET_ACCESS_KEY"),
            nwws_user: env("NWWS_USER"),
            nwws_pass: env("NWWS_PASS"),
            usgs_api_key: env("USGS_API_KEY"),
            sources_enabled: env("INVERSA_SOURCES").as_deref() != Some("off"),
        }
    }

    /// The GOES queue `app` consumes: its own `GOES_SQS_URL_<APP>`, else the shared `GOES_SQS_URL`.
    pub fn goes_sqs_url_for(&self, app: &str) -> Option<&str> {
        self.goes_sqs_urls.iter().find(|(id, _)| id == app).map(|(_, url)| url.as_str()).or(self.goes_sqs_url.as_deref())
    }

    #[cfg(test)]
    pub fn for_tests() -> Self {
        Config {
            bind: "127.0.0.1:0".into(),
            data_dir: std::env::temp_dir(),
            user_agent: "inversa-tests".into(),
            ingest_hook_secret: Some("test-hook-secret".into()),
            ingest_nudge_token: Some("test-nudge-token".into()),
            r2: None,
            goes_sqs_url: None,
            goes_sqs_urls: Vec::new(),
            aws_access_key_id: None,
            aws_secret_access_key: None,
            nwws_user: None,
            nwws_pass: None,
            usgs_api_key: None,
            sources_enabled: false,
        }
    }
}

/// One app's state (PLAN.md C-A1): its config, databases, Hub and archive view. Nothing in it
/// is shared with another app except the read-only process `Config` and the HTTP client.
#[derive(Clone)]
pub struct AppState {
    /// The app's resolved config: regions, taxa (with their `taxa.id`), feeds, copy.
    pub app: Arc<App>,
    /// observations.db: written only by ingest.
    pub obs: Db,
    /// team.db: written only by applyOps.
    pub team: Db,
    pub hub: Hub,
    pub archive: Arc<dyn Archive>,
    pub http: reqwest::Client,
    pub config: Arc<Config>,
    /// Wake-ups for `webhook` sources (`ingest::push::nudge`).
    pub nudges: Arc<Nudges>,
}

pub fn http_client(config: &Config) -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(config.user_agent.clone())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .gzip(true)
        .build()
        .expect("http client")
}

impl AppState {
    /// Open `<data_dir>/<app>/{observations,team}.db`, sync the taxa table with the config and
    /// learn the taxon ids, all before any task can touch the databases.
    pub fn open(config: Arc<Config>, http: reqwest::Client, archive: Arc<dyn Archive>, mut app: App) -> anyhow::Result<Self> {
        let dir = config.data_dir.join(app.id());
        std::fs::create_dir_all(&dir)?;
        let obs = Db::open_with(&dir, "observations", |conn| app.resolve_taxa(conn))?;
        let team = Db::open(&dir, "team")?;
        let archive: Arc<dyn Archive> = Arc::new(AppArchive::new(archive, app.id()));
        Ok(AppState { app: Arc::new(app), obs, team, hub: Hub::default(), archive, http, config, nudges: Arc::default() })
    }

    pub fn memory(config: Config, mut app: App) -> Self {
        let obs = Db::memory_with("observations", |conn| app.resolve_taxa(conn));
        let archive: Arc<dyn Archive> = Arc::new(AppArchive::new(Arc::new(MemArchive::default()), app.id()));
        AppState {
            app: Arc::new(app),
            obs,
            team: Db::memory("team"),
            hub: Hub::default(),
            archive,
            http: http_client(&config),
            config: Arc::new(config),
            nudges: Arc::default(),
        }
    }
}
