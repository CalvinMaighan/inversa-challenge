pub mod goes_grid;
pub mod goes_sqs;
pub mod hook;
pub mod nwws;

use std::sync::Arc;

use crate::ingest::source::{Source, SourceInfo};
use crate::state::Config;

/// Every push source enabled by config.
pub fn all(config: &Config) -> Vec<Arc<dyn Source>> {
    let mut out = goes_sqs::sources(config);
    out.extend(nwws::sources(config));
    out
}

/// Push sources that config leaves off (missing secrets), with the reason. They are still
/// registered, so `feeds` lists them as down with the reason as the note instead of omitting them.
pub fn disabled(config: &Config) -> Vec<(SourceInfo, String)> {
    let mut out = Vec::new();
    if let Err(reason) = goes_sqs::configure(config) {
        out.push((goes_sqs::info(), reason));
    }
    if let Some(reason) = nwws::disabled_reason(config) {
        out.push((nwws::info(), reason));
    }
    out
}
