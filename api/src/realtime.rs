//! In-process fan-out (PLAN.md C12). T4 owns the implementation; the Event enum is contract.

use serde::Serialize;
use tokio::sync::broadcast;

use crate::feed_state::FeedState;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    FeedState(FeedState),
    /// Frames between these unix ms were rebuilt.
    FramesUpdated { from: i64, to: i64 },
    /// A team op was persisted with this seq (payload is the op JSON).
    Op { board_id: String, seq: i64, op: serde_json::Value },
    /// Internal: rows landed for this observed_at window; the frame builder listens.
    RowsWritten { from: i64, to: i64 },
}

#[derive(Clone)]
pub struct Hub {
    tx: broadcast::Sender<Event>,
}

impl Default for Hub {
    fn default() -> Self {
        let (tx, _) = broadcast::channel(1024);
        Hub { tx }
    }
}

impl Hub {
    pub fn publish(&self, event: Event) {
        let _ = self.tx.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }
}
