//! Mutation resolvers. `applyOps` is a stub until T10 (and T12's CRDT merge) land: it accepts
//! the batch, persists nothing, and reports zero applied.

use async_graphql::{Object, Result, ID};

use super::types::{ApplyResult, OpInput};

pub struct MutationRoot;

#[Object(name = "Mutation")]
impl MutationRoot {
    async fn apply_ops(&self, board_id: ID, ops: Vec<OpInput>) -> Result<ApplyResult> {
        let _ = (board_id, ops);
        Ok(ApplyResult { applied: 0, duplicates: 0, last_seq: 0 })
    }
}
