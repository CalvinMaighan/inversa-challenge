pub mod bio;
pub mod coops;
pub mod crw;
pub mod gbif;
pub mod inat;
pub mod nas;
pub mod ndbc;
pub mod nws;
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

    const LIONFISH_FEEDS: [&str; 7] = ["crw", "gbif", "goes19-sst", "inat", "nas", "ndbc", "openmeteo-marine"];

    /// G5: Lionfish Watch runs only its own feeds, and `/health` lists exactly those seven: no
    /// NWS/NWWS, no CO-OPS water level, no Open-Meteo forecast, no GOES LST/cloud/fire.
    #[tokio::test]
    async fn lionfish_feed_set() {
        let state = test_state_for("lionfish");
        let p = plan(&state);
        let mut known = p.known_ids();
        known.sort_unstable();
        assert_eq!(known, LIONFISH_FEEDS);
        assert_eq!(p.runnable_ids(), ["ndbc", "openmeteo-marine", "inat", "nas", "gbif", "crw"], "goes19-sst waits for its SQS secrets");
        assert_eq!(crate::ingest::push::goes_sqs::products(&state.app), ["ABI-L2-SSTF"]);

        start(state.clone(), Default::default()).await.unwrap();
        let res = router_for(&state).oneshot(Request::get("/health").body(Body::empty()).unwrap()).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
        let app = &body["apps"][0];
        assert_eq!(app["id"], "lionfish");
        let mut feeds: Vec<&str> = app["feeds"].as_array().unwrap().iter().map(|f| f["source"].as_str().unwrap()).collect();
        feeds.sort_unstable();
        assert_eq!(feeds, LIONFISH_FEEDS, "{app}");
        for gone in ["nws", "nwws", "coops", "openmeteo", "goes19", "usgs", "web"] {
            assert!(!feeds.contains(&gone), "{gone}");
        }

        // The python app keeps every adapter it had (shared code, its own params).
        let python = test_state_for("python");
        assert_eq!(plan(&python).known_ids(), ["nws", "usgs", "ndbc", "coops", "openmeteo", "inat", "nas", "gbif", "goes19", "nwws", "web"]);
    }
}
