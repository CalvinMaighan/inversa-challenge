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
    /// `AISSTREAM_API_KEY`: AISStream.io vessel positions (GE4); server only, never logged.
    pub aisstream_api_key: Option<crate::ingest::push::ais::ApiKey>,
    /// `AISSTREAM_URL`: a loopback mock for e2e; anything but the AISStream endpoint or loopback is refused.
    pub aisstream_url: Option<String>,
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
            aisstream_api_key: env("AISSTREAM_API_KEY").map(crate::ingest::push::ais::ApiKey::new),
            aisstream_url: env("AISSTREAM_URL"),
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
            aisstream_api_key: None,
            aisstream_url: None,
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
    /// Wake-ups for nudge-capable sources (`ingest::push::nudge`).
    pub nudges: Arc<Nudges>,
    /// What "now" is for this app's read side (resolvers, evidence, feed state). See [`Clock`].
    pub clock: Clock,
    /// Hook deliveries being ingested now, `<source>/<sha256>` (`ingest::push::hook`).
    pub hook_in_flight: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
}

// ---------------------------------------------------------------------------------------------
// Clock (gates/leaf-E1.md G5)
// ---------------------------------------------------------------------------------------------
//
// Every "now" that is compared with stored data goes through one of two calls, never through
// `chrono::Utc::now()` directly:
//
// - [`now_ms`]: the process clock. In production it is the wall clock. In test builds it is the
//   wall clock shifted by `INVERSA_FAKE_NOW` (an RFC 3339 time, read once): the process starts at
//   that instant and time then runs normally. This is the FAKETIME-style override that proves the
//   suite does not depend on the date it runs on:
//   `INVERSA_FAKE_NOW=2027-01-01T00:00:00Z cargo test --manifest-path api/Cargo.toml`.
//   Ingest (`fetch_runs.received_at`, `fetched_at`), hook replay windows, CRDT receive times,
//   feed-state publishing and the test helpers all read it, so the shift moves every side at once.
// - [`AppState::now_ms`]: the app's [`Clock`]. `Clock::System` is [`now_ms`]; `Clock::Fixed(t)`
//   pins the read side of one app to `t` (`AppState::with_clock`). Tests that score fixtures pass
//   the fixture time explicitly (`backfill::ingest_fixtures_at` returns the manifest's
//   `recorded_at`), and tests whose expected values are derived from "today" pin the state clock,
//   so a run near midnight or in another year computes the same answer. `clock_pinned_*` tests
//   set the clock to 2027-01-01 and check both mechanisms.
//
// Rate governors, timeouts and the scheduler's sleeps use `std::time::Instant`, which neither
// mechanism touches: they measure elapsed time, not dates.

/// An app's notion of now.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Clock {
    /// The process clock ([`now_ms`]).
    #[default]
    System,
    /// Pinned to a unix ms instant (tests that score fixtures or derive "today").
    #[cfg_attr(not(test), allow(dead_code))]
    Fixed(i64),
}

impl Clock {
    pub fn now_ms(self) -> i64 {
        match self {
            Clock::System => now_ms(),
            Clock::Fixed(t) => t,
        }
    }
}

/// The process clock, unix ms. See the section comment above.
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis() + fake_offset_ms()
}

/// Offset that makes the process start at `INVERSA_FAKE_NOW` (test builds only; 0 otherwise).
#[cfg(test)]
fn fake_offset_ms() -> i64 {
    static OFFSET: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
    *OFFSET.get_or_init(|| {
        let real = chrono::Utc::now().timestamp_millis();
        std::env::var("INVERSA_FAKE_NOW").ok().and_then(|v| fake_offset(&v, real)).unwrap_or(0)
    })
}

#[cfg(not(test))]
fn fake_offset_ms() -> i64 {
    0
}

/// `fake - real` for an RFC 3339 `fake`; `None` when it does not parse.
#[cfg(test)]
pub fn fake_offset(fake: &str, real_ms: i64) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(fake.trim()).ok().map(|t| t.timestamp_millis() - real_ms)
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
        Ok(AppState { app: Arc::new(app), obs, team, hub: Hub::default(), archive, http, config, nudges: Arc::default(), clock: Clock::System, hook_in_flight: Arc::default() })
    }

    /// Now on this app's clock (unix ms).
    pub fn now_ms(&self) -> i64 {
        self.clock.now_ms()
    }

    /// The same app with its read-side clock set to `clock`.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn with_clock(mut self, clock: Clock) -> Self {
        self.clock = clock;
        self
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
            clock: Clock::System,
            hook_in_flight: Arc::default(),
        }
    }
}

/// G5: the clock mechanism. Each test sets an app clock to 2027-01-01 and checks that answers
/// asked at the fixture time do not move, while everything that means "now" follows the clock.
#[cfg(test)]
mod clock_tests {
    use axum::body::Body;
    use axum::http::{header, Request};
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use tower::ServiceExt;

    use super::*;
    use crate::app::test_support::{router_for, test_state_for};
    use crate::backfill::FIXTURE_NOW;

    /// 2027-01-01T00:00:00Z.
    const Y2027: i64 = 1_798_761_600_000;

    fn iso(ms: i64) -> String {
        chrono::DateTime::from_timestamp_millis(ms).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    async fn gql(state: &AppState, query: &str) -> Value {
        let res = router_for(state)
            .oneshot(
                Request::post(format!("/v1/{}/graphql", state.app.id()))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({ "query": query }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap()
    }

    #[test]
    fn clock_pinned_fake_now_offset_and_fixed_clock() {
        assert_eq!(fake_offset("2027-01-01T00:00:00Z", 1_000), Some(Y2027 - 1_000));
        assert_eq!(fake_offset(" 2027-01-01T01:00:00+01:00 ", 0), Some(Y2027));
        assert_eq!(fake_offset("next tuesday", 0), None);
        assert_eq!(Clock::Fixed(Y2027).now_ms(), Y2027);
        let real = chrono::Utc::now().timestamp_millis();
        // Unset (or set) once per process: the process clock is the wall clock plus that offset.
        let expected = std::env::var("INVERSA_FAKE_NOW").ok().and_then(|v| fake_offset(&v, real)).unwrap_or(0);
        assert!((Clock::System.now_ms() - (real + expected)).abs() < 60_000);
        assert_eq!(test_state_for("python").with_clock(Clock::Fixed(Y2027)).now_ms(), Y2027);
    }

    /// `lionfish_top_cells_on_fixtures` on an app whose clock reads 2027-01-01: the ranking at the
    /// fixture time is unchanged; the feed state, which asks "now", sees a silent feed.
    #[tokio::test]
    async fn clock_pinned_lionfish_top_cells_on_2027_01_01() {
        use crate::hotspot::lionfish::tests::{assert_lionfish_top_cells, ingest_lionfish_fixtures};
        let pinned = test_state_for("lionfish").with_clock(Clock::Fixed(FIXTURE_NOW));
        ingest_lionfish_fixtures(&pinned).await;
        let then = assert_lionfish_top_cells(&pinned, FIXTURE_NOW).await;
        let later = pinned.clone().with_clock(Clock::Fixed(Y2027));
        assert_eq!(assert_lionfish_top_cells(&later, FIXTURE_NOW).await, then);
        let crw = |s: AppState| async move {
            crate::feed_state::compute(&s.obs, s.now_ms()).await.unwrap().into_iter().find(|f| f.source == "crw").unwrap()
        };
        let in_2027 = crw(later.clone()).await;
        assert_eq!(in_2027.state, crate::feed_state::Health::Down, "{in_2027:?}");
        assert!(in_2027.lag_seconds.unwrap() > 90 * 86_400, "{in_2027:?}");
        // The CRW staleness scale is measured from the product time, whatever the date.
        assert!(crw(pinned).await.lag_seconds.unwrap() < 3 * 86_400);
    }

    /// The carp review board through GraphQL at the fixture time is the same on a 2027 clock; a
    /// review without `asOf` is taken at the app clock.
    #[tokio::test]
    async fn clock_pinned_carp_review_on_2027_01_01() {
        let pinned = test_state_for("carp").with_clock(Clock::Fixed(FIXTURE_NOW));
        let root = crate::backfill::fixtures_root();
        for source in crate::backfill::fixture_sources(&pinned) {
            crate::backfill::ingest_fixtures(&pinned, source.as_ref(), &root).await.unwrap();
        }
        let later = pinned.clone().with_clock(Clock::Fixed(Y2027));
        let q = format!("{{ reviewBoard(asOf: \"{}\") {{ asOf review ok cannotAssess sites {{ site status summary checks {{ rule outcome evidenceIds }} }} }} }}", iso(FIXTURE_NOW));
        let then = gql(&pinned, &q).await;
        assert!(then["data"]["reviewBoard"]["sites"].as_array().is_some_and(|s| s.len() == 8), "{then}");
        assert_eq!(gql(&later, &q).await, then);
        let default = gql(&later, "{ siteReview(site: \"SMML1\") { asOf status } }").await;
        assert_eq!(default["data"]["siteReview"]["asOf"], iso(Y2027), "{default}");
        assert_eq!(default["data"]["siteReview"]["status"], "CANNOT_ASSESS", "every input is three months old in 2027");
    }

    /// The backtest's "today" is the app clock's: pinned to 2027-01-01 05:00Z, the last two full
    /// days are 2026-12-30 and 2026-12-31 whatever the wall clock says.
    #[tokio::test]
    async fn clock_pinned_backtest_today_from_app_clock() {
        use crate::hotspot::score::testkit::{insert_sighting, seed_sources, DAY, HOUR};
        let state = test_state_for("python").with_clock(Clock::Fixed(Y2027 + 5 * HOUR));
        seed_sources(&state.obs).await;
        let g = state.app.regions[0].grid;
        let (lon, lat) = g.center(g.index(100, 100));
        insert_sighting(&state.obs, "inat", 1, lat, lon, Y2027 - 3 * DAY + 5 * HOUR, "research", None).await;
        insert_sighting(&state.obs, "inat", 1, lat, lon, Y2027 - DAY + 9 * HOUR, "research", None).await;
        let ev = crate::evidence::evidence(&state, "backtest:python:2").await.unwrap();
        assert_eq!(
            ev.record["perDay"],
            json!([{"day": iso(Y2027 - 2 * DAY), "sightings": 0, "hits": 0}, {"day": iso(Y2027 - DAY), "sightings": 1, "hits": 1}])
        );
        let body = gql(&state, "{ backtest(species: \"python\", days: 2) { hitRate perDay { day } } }").await;
        assert_eq!(body["data"]["backtest"]["hitRate"], 1.0, "{body}");
        assert_eq!(body["data"]["backtest"]["perDay"][1]["day"], iso(Y2027 - DAY));
    }
}
