//! Mutation resolvers. `applyOps` hands the batch to T12's CRDT (`crdt::apply_and_publish`),
//! which validates, persists idempotently on op id, and publishes each new op on the Hub for the
//! `ops` subscription.

use async_graphql::{Context, ErrorExtensions, Object, Result, ID};

use super::app_state;
use super::types::{ApplyResult, OpInput};
use crate::crdt;

/// Most ops accepted in one `applyOps` call. The HTTP body cap (`MAX_BODY_BYTES` in `mod.rs`)
/// bounds the bytes; this bounds the work per transaction.
pub const MAX_OPS_PER_CALL: usize = 1000;

pub struct MutationRoot;

fn bad_op(message: String) -> async_graphql::Error {
    async_graphql::Error::new(message).extend_with(|_, e| e.set("code", "BAD_OP"))
}

/// The validation reason behind an `apply_and_publish` error, if it is one.
fn invalid_reason(e: &anyhow::Error) -> Option<String> {
    e.downcast_ref::<crdt::CrdtError>()
        .map(ToString::to_string)
        .or_else(|| e.downcast_ref::<rusqlite::Error>().and_then(crdt::invalid_reason))
}

#[Object(name = "Mutation")]
impl MutationRoot {
    /// Apply a batch of C5 ops to one board. All-or-nothing: one invalid op rejects the batch
    /// with `extensions.code = BAD_OP`. Re-sent ops count as duplicates.
    async fn apply_ops(&self, ctx: &Context<'_>, board_id: ID, ops: Vec<OpInput>) -> Result<ApplyResult> {
        if board_id.is_empty() || board_id.len() > 256 {
            return Err(bad_op("boardId must be 1..=256 bytes".into()));
        }
        if ops.len() > MAX_OPS_PER_CALL {
            return Err(bad_op(format!("{} ops in one call; the limit is {MAX_OPS_PER_CALL}", ops.len())));
        }
        let ops: Vec<crdt::OpIn> = ops
            .into_iter()
            .map(|o| crdt::OpIn {
                id: o.id.0,
                hlc: o.hlc,
                board_id: Some(board_id.0.clone()),
                entity: o.entity,
                entity_id: o.entity_id.0,
                field: o.field,
                value: o.value.unwrap_or(serde_json::Value::Null),
                node_id: o.node_id,
            })
            .collect();
        match crdt::apply_and_publish(app_state(ctx), &board_id, ops).await {
            Ok(r) => Ok(ApplyResult { applied: r.applied as i32, duplicates: r.duplicates as i32, last_seq: r.last_seq }),
            Err(e) => match invalid_reason(&e) {
                Some(reason) => Err(bad_op(reason)),
                None => Err(format!("applyOps failed: {e:#}").into()),
            },
        }
    }
}
