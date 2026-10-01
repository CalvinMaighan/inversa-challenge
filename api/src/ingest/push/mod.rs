pub mod goes_grid;
pub mod goes_sqs;
pub mod hook;
pub mod nudge;
pub mod nwws;

use std::sync::Arc;

use crate::app::config::App;
use crate::ingest::source::{Source, SourceInfo};
use crate::state::Config;

/// Every push source the app's `feeds[]` lists and config enables.
pub fn all(config: &Config, app: &Arc<App>) -> Vec<Arc<dyn Source>> {
    let mut out = Vec::new();
    if app.cfg.has_feed(goes_sqs::SOURCE_ID) {
        out.extend(goes_sqs::sources(config, app));
    }
    if app.cfg.has_feed("nwws") {
        out.extend(nwws::sources(config));
    }
    out
}

/// Push sources the app lists but config leaves off (missing secrets), with the reason. They are
/// still registered, so `feeds` lists them as down with the reason as the note instead of omitting them.
pub fn disabled(config: &Config, app: &Arc<App>) -> Vec<(SourceInfo, String)> {
    let mut out = Vec::new();
    if app.cfg.has_feed(goes_sqs::SOURCE_ID) {
        if let Err(reason) = goes_sqs::configure(config, app) {
            out.push((goes_sqs::info(), reason));
        }
    }
    if app.cfg.has_feed("nwws") {
        if let Some(reason) = nwws::disabled_reason(config) {
            out.push((nwws::info(), reason));
        }
    }
    out
}
