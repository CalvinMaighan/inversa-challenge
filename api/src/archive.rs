//! Raw payload archive contract (PLAN.md C12). Implementations for disk and R2 live in
//! `ingest::archive`; the in-memory one lives here so every test can use it.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;

#[async_trait]
pub trait Archive: Send + Sync {
    /// Store bytes under `key`. Idempotent: writing the same key twice is not an error.
    async fn put(&self, key: &str, bytes: Vec<u8>, content_type: &str) -> anyhow::Result<()>;
    async fn get(&self, key: &str) -> anyhow::Result<Vec<u8>>;
}

#[derive(Default)]
pub struct MemArchive {
    objects: Mutex<HashMap<String, Vec<u8>>>,
}

#[async_trait]
impl Archive for MemArchive {
    async fn put(&self, key: &str, bytes: Vec<u8>, _content_type: &str) -> anyhow::Result<()> {
        self.objects.lock().expect("archive lock").insert(key.to_string(), bytes);
        Ok(())
    }

    async fn get(&self, key: &str) -> anyhow::Result<Vec<u8>> {
        self.objects
            .lock()
            .expect("archive lock")
            .get(key)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("archive: no object {key}"))
    }
}
