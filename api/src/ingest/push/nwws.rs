//! NWWS-OI XMPP push, enabled when NWWS_USER is set (T8).

use std::sync::Arc;

use crate::ingest::source::Source;
use crate::state::Config;

pub fn sources(_config: &Config) -> Vec<Arc<dyn Source>> {
    vec![]
}
