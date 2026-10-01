//! Subscription resolvers, fed by the realtime Hub.

use async_graphql::{Context, Result, Subscription, ID};
use futures_util::future;
use futures_util::stream::{self, Stream, StreamExt};

use super::query::{ops_after, OPS_PAGE};
use super::types::{FeedState, FrameRange, Op, Time};
use super::app_state;
use crate::feed_state;
use crate::realtime::{Event, OnLag};

pub struct SubscriptionRoot;

#[Subscription(name = "Subscription")]
impl SubscriptionRoot {
    /// The current state of every feed, then each change as the scheduler publishes it.
    async fn feeds(&self, ctx: &Context<'_>) -> Result<impl Stream<Item = FeedState>> {
        let state = app_state(ctx);
        // Subscribe before taking the snapshot so no change falls between the two.
        let live = state.hub.filtered(OnLag::Skip, |event| match event {
            Event::FeedState(s) => Some(FeedState::from(s)),
            _ => None,
        });
        let snapshot = feed_state::compute(&state.obs, state.now_ms()).await?;
        Ok(stream::iter(snapshot.into_iter().map(FeedState::from)).chain(live))
    }

    /// Frame ranges the builder rebuilt; clients refetch `frames` for that window.
    async fn frames_updated(&self, ctx: &Context<'_>) -> impl Stream<Item = FrameRange> {
        app_state(ctx).hub.filtered(OnLag::Skip, |event| match event {
            Event::FramesUpdated { from, to } => Some(FrameRange { from: Time(from), to: Time(to) }),
            _ => None,
        })
    }

    /// Every op of one board with `seq > afterSeq`: first the persisted backlog, then new ops as
    /// they are persisted, in seq order without gaps or repeats. The stream ends if the subscriber
    /// falls too far behind the Hub; the client resubscribes with its last seen seq.
    async fn ops(&self, ctx: &Context<'_>, board_id: ID, after_seq: i64) -> Result<impl Stream<Item = Op>> {
        let state = app_state(ctx);
        let board = board_id.0;
        // Subscribe before reading the backlog so an op persisted in between is not lost.
        let live = state.hub.filtered(OnLag::End, {
            let board = board.clone();
            move |event| match event {
                Event::Op { board_id, seq, op } if board_id == board => {
                    let parsed = Op::from_event(&board_id, seq, &op);
                    if parsed.is_none() {
                        tracing::warn!(board_id, seq, %op, "hub op event is not a C5 op; not forwarded");
                    }
                    parsed
                }
                _ => None,
            }
        });
        let mut backlog = Vec::new();
        let mut last = after_seq;
        loop {
            let page = ops_after(&state.team, board.clone(), last).await?;
            let full = page.len() as i64 == OPS_PAGE;
            if let Some(op) = page.last() {
                last = op.seq;
            }
            backlog.extend(page);
            if !full {
                break;
            }
        }
        Ok(stream::iter(backlog).chain(live.filter(move |op| future::ready(op.seq > last))))
    }
}
