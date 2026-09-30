//! Feed-state envelope (PLAN.md C3). T4 computes it from fetch_runs and sources.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Health {
    Nominal,
    Lagging,
    Stale,
    Down,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedState {
    pub source: String,
    /// "push" or "poll".
    pub mode: String,
    pub state: Health,
    pub newest_observed_at: Option<i64>,
    pub last_fetch_at: Option<i64>,
    pub lag_seconds: Option<i64>,
    pub note: Option<String>,
}
