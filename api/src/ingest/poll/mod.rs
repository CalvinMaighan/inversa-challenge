pub mod bio;
pub mod coops;
pub mod gbif;
pub mod inat;
pub mod nas;
pub mod ndbc;
pub mod nws;
pub mod openmeteo;
pub mod physical;
pub mod usgs;

use std::sync::Arc;

use crate::ingest::source::Source;
use crate::state::Config;

/// Every polled source.
pub fn all(config: &Config) -> Vec<Arc<dyn Source>> {
    let mut out = physical::sources(config);
    out.extend(bio::sources(config));
    out
}
