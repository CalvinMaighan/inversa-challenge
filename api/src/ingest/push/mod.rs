pub mod goes_grid;
pub mod goes_sqs;
pub mod hook;
pub mod nwws;

use std::sync::Arc;

use crate::ingest::source::Source;
use crate::state::Config;

/// Every push source enabled by config.
pub fn all(config: &Config) -> Vec<Arc<dyn Source>> {
    let mut out = goes_sqs::sources(config);
    out.extend(nwws::sources(config));
    out
}
