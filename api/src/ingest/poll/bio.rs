//! Biological source registry (T9).

use std::sync::Arc;

use crate::ingest::source::Source;
use crate::state::Config;

pub fn sources(_config: &Config) -> Vec<Arc<dyn Source>> {
    vec![]
}
