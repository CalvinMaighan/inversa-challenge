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
