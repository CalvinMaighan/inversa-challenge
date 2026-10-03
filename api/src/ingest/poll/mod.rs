pub mod bio;
pub mod coops;
pub mod crw;
pub mod eddmaps;
pub mod gbif;
pub mod iem;
pub mod inat;
pub mod nas;
pub mod ndbc;
pub mod nwps;
pub mod nws;
pub mod nws_forecast;
pub mod openmeteo;
pub mod physical;
pub mod usgs;

use std::sync::Arc;

use crate::app::config::App;
use crate::ingest::source::Source;
use crate::state::Config;

/// Every polled source the app's `feeds[]` lists.
pub fn all(config: &Config, app: &Arc<App>) -> Vec<Arc<dyn Source>> {
    let mut out = physical::sources(config, app);
    out.extend(bio::sources(config, app));
    if app.cfg.has_feed(crw::SOURCE_ID) {
        out.push(Arc::new(crw::Crw::new(app.clone())));
    }
    out
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use crate::app::test_support::{router_for, test_state_for};
    use crate::ingest::scheduler::{plan, start};

    const LIONFISH_FEEDS: [&str; 8] = ["coops", "crw", "gbif", "goes19-sst", "inat", "nas", "ndbc", "openmeteo-marine"];

    /// G5: Lionfish Watch runs only its own feeds, and `/health` lists exactly those (seven, with CO-OPS tide
    /// stations for the Florida Keys): no NWS/NWWS, no Open-Meteo forecast, no GOES LST/cloud/fire.
    #[tokio::test]
    async fn lionfish_feed_set() {
        let state = test_state_for("lionfish");
        let p = plan(&state);
        let mut known = p.known_ids();
        known.sort_unstable();
        assert_eq!(known, LIONFISH_FEEDS);
        assert_eq!(p.runnable_ids(), ["ndbc", "coops", "openmeteo-marine", "inat", "nas", "gbif", "crw"], "goes19-sst waits for its SQS secrets");
        assert_eq!(crate::ingest::push::goes_sqs::products(&state.app), ["ABI-L2-SSTF"]);

        start(state.clone(), Default::default()).await.unwrap();
        let res = router_for(&state).oneshot(Request::get("/health").body(Body::empty()).unwrap()).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
        let app = &body["apps"][0];
        assert_eq!(app["id"], "lionfish");
        let mut feeds: Vec<&str> = app["feeds"].as_array().unwrap().iter().map(|f| f["source"].as_str().unwrap()).collect();
        feeds.sort_unstable();
        assert_eq!(feeds, LIONFISH_FEEDS, "{app}");
        for gone in ["nws", "nwws", "openmeteo", "goes19", "usgs"] {
            assert!(!feeds.contains(&gone), "{gone}");
        }

        // The python app keeps every adapter it had (shared code, its own params).
        let python = test_state_for("python");
        assert_eq!(plan(&python).known_ids(), ["nws", "usgs", "ndbc", "coops", "openmeteo", "inat", "nas", "gbif", "eddmaps", "goes19", "nwws"]);
    }

    /// R14/G4 (K1): no adapter runs for nobody. Every source id an adapter registers (runnable,
    /// or disabled with its reason) is listed by at least one app's `feeds[]`, every feed of every
    /// app has an adapter, and the registry equals the schema's source list.
    #[tokio::test]
    async fn sources_all_used() {
        use std::collections::BTreeSet;
        let mut registered = BTreeSet::new();
        for id in crate::app::config::APP_IDS {
            let state = test_state_for(id);
            let known = plan(&state).known_ids();
            for f in &state.app.cfg.feeds {
                assert!(known.contains(&f.source.as_str()), "{id}: feed {} has no adapter", f.source);
            }
            for k in &known {
                assert!(state.app.cfg.has_feed(k), "{id}: {k} registered but not in its feeds");
            }
            registered.extend(known);
        }
        let listed: BTreeSet<&str> = crate::app::config::SOURCES.iter().map(|(id, _)| *id).collect();
        // The AIS adapter is dormant: ships were removed from the maps, so no app lists the feed.
        registered.insert("aisstream");
        assert_eq!(registered, listed, "every known source id is used by an app");
        assert!(crate::app::config::PENDING_SOURCES.is_empty(), "no feed waits for an adapter");
        assert!(!listed.contains("web"), "the web hook source serves no app");
    }
}
