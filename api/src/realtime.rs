//! In-process fan-out (PLAN.md C12). T4 owns the implementation; the Event enum is contract.

use futures_util::stream::{self, Stream};
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

/// Buffered events per subscriber before the slowest one starts missing events.
const CAPACITY: usize = 1024;

/// What a filtered stream does when its subscriber fell more than [`CAPACITY`] events behind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnLag {
    /// Keep going from the oldest retained event. Right for "latest state" streams (feed state,
    /// frame ranges), where a newer event supersedes the missed ones.
    Skip,
    /// End the stream. Right for logs (ops), where a gap is corruption: the client reconnects
    /// and resumes from its last seq.
    End,
}

#[derive(Clone)]
pub struct Hub {
    tx: broadcast::Sender<Event>,
}

impl Default for Hub {
    fn default() -> Self {
        let (tx, _) = broadcast::channel(CAPACITY);
        Hub { tx }
    }
}

impl Hub {
    pub fn publish(&self, event: Event) {
        // Err only means nobody is subscribed right now.
        let _ = self.tx.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }

    /// Subscribe now and yield `f(event)` for every event where it returns `Some`.
    ///
    /// The subscription starts when this is called, not when the stream is first polled, so
    /// callers can subscribe first and then read a snapshot without a gap in between.
    pub fn filtered<T, F>(&self, on_lag: OnLag, f: F) -> impl Stream<Item = T> + Send + 'static
    where
        T: Send + 'static,
        F: FnMut(Event) -> Option<T> + Send + 'static,
    {
        stream::unfold((self.subscribe(), f), move |(mut rx, mut f)| async move {
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        if let Some(item) = f(event) {
                            return Some((item, (rx, f)));
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(missed)) => {
                        tracing::warn!(missed, ?on_lag, "hub subscriber lagged");
                        if on_lag == OnLag::End {
                            return None;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use futures_util::StreamExt;

    use super::*;

    fn frames(from: i64) -> Event {
        Event::FramesUpdated { from, to: from + 1 }
    }

    fn frames_from(event: Event) -> Option<i64> {
        match event {
            Event::FramesUpdated { from, .. } => Some(from),
            _ => None,
        }
    }

    #[tokio::test]
    async fn filtered_yields_matching_events_published_after_subscribing() {
        let hub = Hub::default();
        hub.publish(frames(0)); // before subscribing: not seen
        let stream = hub.filtered(OnLag::Skip, frames_from);
        hub.publish(Event::RowsWritten { from: 1, to: 2 });
        hub.publish(frames(10));
        hub.publish(frames(20));
        let got: Vec<i64> = stream.take(2).collect().await;
        assert_eq!(got, [10, 20]);
    }

    #[tokio::test]
    async fn lag_policy_skips_or_ends() {
        let hub = Hub::default();
        let skip = hub.filtered(OnLag::Skip, frames_from);
        let end = hub.filtered(OnLag::End, frames_from);
        for i in 0..(CAPACITY as i64 + 10) {
            hub.publish(frames(i));
        }
        drop(hub);
        let skipped: Vec<i64> = skip.collect().await;
        assert_eq!(skipped.len(), CAPACITY);
        assert_eq!(skipped.first(), Some(&10));
        let ended: Vec<i64> = end.collect().await;
        assert!(ended.is_empty());
    }
}
