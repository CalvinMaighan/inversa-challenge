//! Disk and R2 archive implementations (T5).

use std::sync::Arc;

use crate::archive::{Archive, MemArchive};
use crate::state::Config;

pub fn from_config(_config: &Config) -> anyhow::Result<Arc<dyn Archive>> {
    Ok(Arc::new(MemArchive::default()))
}
