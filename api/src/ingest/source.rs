//! Source adapter contract (PLAN.md C12). One implementation per feed. `fetch` does I/O,
//! `normalize` is pure so it can be tested against recorded fixtures.

use std::time::Duration;

use async_trait::async_trait;

use crate::model::Row;
use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Push,
    Poll,
    /// Polled as a backstop and woken early by an unsigned provider nudge
    /// (`POST /v1/{app}/ingest/nudge/{source}/{token}`, `ingest::push::nudge`).
    Webhook,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Push => "push",
            Mode::Poll => "poll",
            Mode::Webhook => "webhook",
        }
    }
}

/// Static description, upserted into `sources` at boot.
#[derive(Debug, Clone)]
pub struct SourceInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub homepage: &'static str,
    pub mode: Mode,
    pub cadence: Duration,
    pub max_latency: Duration,
}

/// One fetched payload, exactly as received. Archived before normalization.
#[derive(Debug, Clone)]
pub struct RawPayload {
    pub source_url: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
    pub http_status: Option<u16>,
    pub fetched_at: i64,
    /// Opaque cursor to persist after this payload is committed (e.g. iNat `updated_since`).
    pub next_cursor: Option<String>,
    /// Push sources acknowledge after commit (e.g. SQS receipt handle).
    pub ack: Option<String>,
}

/// What a fetch sees: shared state plus this source's last committed cursor.
pub struct FetchCtx<'a> {
    pub state: &'a AppState,
    pub cursor: Option<String>,
}

#[async_trait]
pub trait Source: Send + Sync {
    fn info(&self) -> SourceInfo;

    /// Minimum delay between fetches. Push sources that long-poll return `Duration::ZERO`.
    fn min_interval(&self) -> Duration {
        self.info().cadence
    }

    /// Fetch zero or more payloads. An empty vec means nothing new.
    async fn fetch(&self, ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>>;

    /// Pure: raw bytes to rows. Must be idempotent (same payload, same rows).
    fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>>;

    /// Called after the payload's rows commit. Push sources delete/ack here.
    async fn ack(&self, _ctx: &FetchCtx<'_>, _raw: &RawPayload) -> anyhow::Result<()> {
        Ok(())
    }
}
