//! GOES-19 NODD push via SNS to SQS (T7).

use std::sync::Arc;

use crate::ingest::source::Source;
use crate::state::Config;

pub fn sources(_config: &Config) -> Vec<Arc<dyn Source>> {
    vec![]
}
