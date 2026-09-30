//! Team ops CRDT (PLAN.md C5, T12).
//!
//! The `ops` table is the source of truth; `fields`, `messages` and `removal_counts` are
//! materialized from it inside the same transaction. Rules, shared with the TS side through
//! `spec/crdt/*.json`:
//!
//! - HLC `"<wallMs>:<counter>:<nodeId>"` orders by wallMs, then counter, then nodeId as a string.
//! - Mission and note: last-writer-wins by HLC per `(entity, entityId, field)`. `_deleted` is a
//!   register like any other, so a later `_deleted=false` undeletes. Writes after a delete are
//!   stored but the entity reads as deleted while `_deleted` is true.
//! - Message: defined by its lowest-HLC op (its creation); any later op for the same id is ignored.
//! - Removal: grow-only counter, `value` is the node's running total; the merged total is the
//!   per-node max summed over nodes.
//! - Apply is idempotent on op `id`.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::realtime::Event;
use crate::state::AppState;

/// Largest serialized `value` accepted, in bytes.
pub const MAX_VALUE_BYTES: usize = 16 * 1024;
const MAX_ID_BYTES: usize = 256;
/// Largest removal total: JS `Number.MAX_SAFE_INTEGER`, so both sides accept the same values.
const MAX_COUNTER: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Entity {
    Mission,
    Note,
    Message,
    Removal,
}

impl Entity {
    pub fn parse(s: &str) -> Option<Entity> {
        match s {
            "mission" => Some(Entity::Mission),
            "note" => Some(Entity::Note),
            "message" => Some(Entity::Message),
            "removal" => Some(Entity::Removal),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Entity::Mission => "mission",
            Entity::Note => "note",
            Entity::Message => "message",
            Entity::Removal => "removal",
        }
    }
}

/// Hybrid logical clock. Derived `Ord` compares wallMs, then counter, then nodeId.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Hlc {
    pub wall_ms: u64,
    pub counter: u64,
    pub node_id: String,
}

impl Hlc {
    /// Parse `"<wallMs>:<counter>:<nodeId>"`. Numbers are plain decimal digits; nodeId may
    /// itself contain `:` and must be non-empty.
    pub fn parse(s: &str) -> Option<Hlc> {
        let mut parts = s.splitn(3, ':');
        let wall = parts.next()?;
        let counter = parts.next()?;
        let node_id = parts.next()?;
        if node_id.is_empty() {
            return None;
        }
        Some(Hlc { wall_ms: parse_digits(wall)?, counter: parse_digits(counter)?, node_id: node_id.to_string() })
    }
}

/// Plain decimal digits, at most 15 so the TS side (IEEE doubles) parses the same set.
fn parse_digits(s: &str) -> Option<u64> {
    if s.is_empty() || s.len() > 15 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// Compare two HLC strings. Unparseable strings sort first (they never reach storage).
pub fn compare_hlc(a: &str, b: &str) -> Ordering {
    Hlc::parse(a).cmp(&Hlc::parse(b))
}

/// Incoming op (GraphQL `OpInput` plus an optional `boardId` for the C5 wire shape).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpIn {
    pub id: String,
    pub hlc: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board_id: Option<String>,
    pub entity: String,
    pub entity_id: String,
    pub field: String,
    #[serde(default)]
    pub value: Value,
    pub node_id: String,
}

/// A persisted op with its board-global sequence number (GraphQL `Op`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredOp {
    pub seq: i64,
    pub id: String,
    pub hlc: String,
    pub board_id: String,
    pub entity: String,
    pub entity_id: String,
    pub field: String,
    pub value: Value,
    pub node_id: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ApplyResult {
    pub applied: usize,
    pub duplicates: usize,
    /// Highest seq on the board after this batch (0 for an empty board).
    pub last_seq: i64,
    /// Newly inserted ops, in seq order, ready for `Event::Op`.
    pub persisted: Vec<(i64, Value)>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityView {
    pub id: String,
    pub fields: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageView {
    pub id: String,
    pub body: String,
    pub hlc: String,
    pub node_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardView {
    pub last_seq: i64,
    pub missions: Vec<EntityView>,
    pub notes: Vec<EntityView>,
    pub messages: Vec<MessageView>,
    pub removals: BTreeMap<String, i64>,
}

#[derive(Debug, thiserror::Error)]
pub enum CrdtError {
    #[error("invalid op {id}: {reason}")]
    InvalidOp { id: String, reason: String },
}

impl From<CrdtError> for rusqlite::Error {
    fn from(e: CrdtError) -> Self {
        rusqlite::Error::ToSqlConversionFailure(Box::new(e))
    }
}

/// The validation reason behind a `rusqlite::Error` produced by `apply_ops`, if any.
pub fn invalid_reason(e: &rusqlite::Error) -> Option<String> {
    match e {
        rusqlite::Error::ToSqlConversionFailure(inner) => inner.downcast_ref::<CrdtError>().map(ToString::to_string),
        _ => None,
    }
}

struct ValidOp<'a> {
    op: &'a OpIn,
    entity: Entity,
    hlc: Hlc,
    value_json: String,
}

impl ValidOp<'_> {
    /// Order of a stored HLC string relative to this op's (already parsed) HLC. Unparseable
    /// stored strings sort first, as in [`compare_hlc`].
    fn cmp_stored(&self, stored: &str) -> Ordering {
        Hlc::parse(stored).as_ref().cmp(&Some(&self.hlc))
    }
}

fn validate_one<'a>(board_id: &str, op: &'a OpIn) -> Result<ValidOp<'a>, CrdtError> {
    let invalid = |reason: String| CrdtError::InvalidOp { id: op.id.clone(), reason };
    if op.id.is_empty() || op.id.len() > MAX_ID_BYTES {
        return Err(invalid("id must be 1..=256 bytes".into()));
    }
    if let Some(b) = &op.board_id {
        if b != board_id {
            return Err(invalid(format!("boardId {b:?} does not match board {board_id:?}")));
        }
    }
    let entity = Entity::parse(&op.entity).ok_or_else(|| invalid(format!("unknown entity {:?}", op.entity)))?;
    if op.entity_id.is_empty() || op.entity_id.len() > MAX_ID_BYTES {
        return Err(invalid("entityId must be 1..=256 bytes".into()));
    }
    if op.field.is_empty() {
        return Err(invalid("field must be non-empty".into()));
    }
    let hlc = Hlc::parse(&op.hlc).ok_or_else(|| invalid(format!("bad hlc {:?}", op.hlc)))?;
    if op.node_id.is_empty() {
        return Err(invalid("nodeId must be non-empty".into()));
    }
    let value_json = serde_json::to_string(&op.value).map_err(|e| invalid(format!("unserializable value: {e}")))?;
    if value_json.len() > MAX_VALUE_BYTES {
        return Err(invalid(format!("value is {} bytes, max {MAX_VALUE_BYTES}", value_json.len())));
    }
    match entity {
        Entity::Mission | Entity::Note => {
            if op.field == "_deleted" && !op.value.is_boolean() {
                return Err(invalid("_deleted must be a boolean".into()));
            }
        }
        Entity::Message => {
            if op.field != "body" {
                return Err(invalid("message field must be \"body\"".into()));
            }
            if !op.value.is_string() {
                return Err(invalid("message body must be a string".into()));
            }
        }
        Entity::Removal => match op.value.as_i64() {
            Some(n) if (0..=MAX_COUNTER).contains(&n) => {}
            _ => return Err(invalid("removal value must be a non-negative integer".into())),
        },
    }
    Ok(ValidOp { op, entity, hlc, value_json })
}

/// Validate a batch without touching the database. Every op must pass or the batch is rejected.
pub fn validate(board_id: &str, ops: &[OpIn]) -> Result<(), CrdtError> {
    ops.iter().try_for_each(|op| validate_one(board_id, op).map(drop))
}

/// Insert ops into `ops` (idempotent on `id`) and materialize them. Rejects the whole batch on
/// any invalid op; the caller's transaction then rolls back.
pub fn apply_ops(tx: &Transaction, board_id: &str, ops: &[OpIn], now_ms: i64) -> rusqlite::Result<ApplyResult> {
    let valid = ops.iter().map(|op| validate_one(board_id, op)).collect::<Result<Vec<_>, _>>()?;
    let mut result = ApplyResult::default();
    for v in &valid {
        let op = v.op;
        // An existence check rather than `insert or ignore`: an ignored insert still burns an
        // autoincrement seq, and replayed batches would leave gaps.
        let seen: bool = tx.query_row("select exists(select 1 from ops where id = ?1)", [&op.id], |r| r.get(0))?;
        if seen {
            result.duplicates += 1;
            continue;
        }
        tx.execute(
            "insert into ops (id, board_id, hlc, entity, entity_id, field, value, node_id, received_at)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![op.id, board_id, op.hlc, v.entity.as_str(), op.entity_id, op.field, v.value_json, op.node_id, now_ms],
        )?;
        let seq = tx.last_insert_rowid();
        materialize(tx, board_id, v)?;
        let stored = StoredOp {
            seq,
            id: op.id.clone(),
            hlc: op.hlc.clone(),
            board_id: board_id.to_string(),
            entity: v.entity.as_str().to_string(),
            entity_id: op.entity_id.clone(),
            field: op.field.clone(),
            value: op.value.clone(),
            node_id: op.node_id.clone(),
        };
        result.persisted.push((seq, serde_json::to_value(stored).expect("StoredOp serializes")));
        result.applied += 1;
    }
    result.last_seq = last_seq(tx, board_id)?;
    Ok(result)
}

fn materialize(tx: &Transaction, board_id: &str, v: &ValidOp<'_>) -> rusqlite::Result<()> {
    let op = v.op;
    match v.entity {
        Entity::Mission | Entity::Note => {
            let existing: Option<String> = tx
                .query_row(
                    "select hlc from fields where board_id = ?1 and entity = ?2 and entity_id = ?3 and field = ?4",
                    params![board_id, v.entity.as_str(), op.entity_id, op.field],
                    |r| r.get(0),
                )
                .optional()?;
            if existing.as_deref().is_some_and(|cur| v.cmp_stored(cur) != Ordering::Less) {
                return Ok(());
            }
            tx.execute(
                "insert into fields (board_id, entity, entity_id, field, value, hlc) values (?1, ?2, ?3, ?4, ?5, ?6)
                 on conflict (board_id, entity, entity_id, field) do update set value = excluded.value, hlc = excluded.hlc",
                params![board_id, v.entity.as_str(), op.entity_id, op.field, v.value_json, op.hlc],
            )?;
        }
        Entity::Message => {
            let existing: Option<String> = tx
                .query_row("select hlc from messages where id = ?1 and board_id = ?2", params![op.entity_id, board_id], |r| r.get(0))
                .optional()?;
            if existing.as_deref().is_some_and(|cur| v.cmp_stored(cur) != Ordering::Greater) {
                return Ok(());
            }
            let body = op.value.as_str().unwrap_or_default();
            tx.execute(
                "insert into messages (id, board_id, body, hlc, node_id) values (?1, ?2, ?3, ?4, ?5)
                 on conflict (id) do update set body = excluded.body, hlc = excluded.hlc, node_id = excluded.node_id
                 where messages.board_id = excluded.board_id",
                params![op.entity_id, board_id, body, op.hlc, op.node_id],
            )?;
        }
        Entity::Removal => {
            let total = op.value.as_i64().unwrap_or_default();
            tx.execute(
                "insert into removal_counts (board_id, entity_id, node_id, total) values (?1, ?2, ?3, ?4)
                 on conflict (board_id, entity_id, node_id) do update set total = max(removal_counts.total, excluded.total)",
                params![board_id, op.entity_id, op.node_id, total],
            )?;
        }
    }
    Ok(())
}

fn last_seq(conn: &Connection, board_id: &str) -> rusqlite::Result<i64> {
    conn.query_row("select coalesce(max(seq), 0) from ops where board_id = ?1", [board_id], |r| r.get(0))
}

/// Validate, persist on `state.team`, then publish one `Event::Op` per newly stored op.
pub async fn apply_and_publish(state: &AppState, board_id: &str, ops: Vec<OpIn>) -> anyhow::Result<ApplyResult> {
    validate(board_id, &ops)?;
    let board = board_id.to_string();
    let now_ms = chrono::Utc::now().timestamp_millis();
    let result = state.team.write(move |tx| apply_ops(tx, &board, &ops, now_ms)).await?;
    for (seq, op) in &result.persisted {
        state.hub.publish(Event::Op { board_id: board_id.to_string(), seq: *seq, op: op.clone() });
    }
    Ok(result)
}

/// Ops on `board_id` with `seq > since`, oldest first, at most `limit`.
pub fn ops_since(conn: &Connection, board_id: &str, since: i64, limit: usize) -> rusqlite::Result<Vec<StoredOp>> {
    let mut stmt = conn.prepare(
        "select seq, id, hlc, board_id, entity, entity_id, field, value, node_id
         from ops where board_id = ?1 and seq > ?2 order by seq limit ?3",
    )?;
    let rows = stmt.query_map(params![board_id, since, limit as i64], |r| {
        let value: Option<String> = r.get(7)?;
        Ok(StoredOp {
            seq: r.get(0)?,
            id: r.get(1)?,
            hlc: r.get(2)?,
            board_id: r.get(3)?,
            entity: r.get(4)?,
            entity_id: r.get(5)?,
            field: r.get(6)?,
            value: parse_value(value.as_deref()),
            node_id: r.get(8)?,
        })
    })?;
    rows.collect()
}

fn parse_value(json: Option<&str>) -> Value {
    json.and_then(|s| serde_json::from_str(s).ok()).unwrap_or(Value::Null)
}

/// Materialized board: live (non-deleted) missions and notes, messages by HLC, removal totals.
pub fn board(conn: &Connection, board_id: &str) -> rusqlite::Result<BoardView> {
    let mut stmt = conn.prepare(
        "select entity, entity_id, field, value from fields where board_id = ?1 order by entity, entity_id, field",
    )?;
    let mut entities: BTreeMap<(String, String), serde_json::Map<String, Value>> = BTreeMap::new();
    for row in stmt.query_map([board_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?))
    })? {
        let (entity, entity_id, field, value) = row?;
        entities.entry((entity, entity_id)).or_default().insert(field, parse_value(value.as_deref()));
    }
    let mut view = BoardView { last_seq: last_seq(conn, board_id)?, ..Default::default() };
    for ((entity, id), mut fields) in entities {
        if is_deleted(&fields) {
            continue;
        }
        fields.remove("_deleted");
        let item = EntityView { id, fields: Value::Object(fields) };
        match entity.as_str() {
            "mission" => view.missions.push(item),
            "note" => view.notes.push(item),
            _ => {}
        }
    }

    let mut stmt = conn.prepare("select id, body, hlc, node_id from messages where board_id = ?1")?;
    view.messages = stmt
        .query_map([board_id], |r| Ok(MessageView { id: r.get(0)?, body: r.get(1)?, hlc: r.get(2)?, node_id: r.get(3)? }))?
        .collect::<Result<Vec<_>, _>>()?;
    view.messages.sort_by(|a, b| compare_hlc(&a.hlc, &b.hlc).then_with(|| a.id.cmp(&b.id)));

    let mut stmt = conn.prepare("select entity_id, sum(total) from removal_counts where board_id = ?1 group by entity_id")?;
    view.removals = stmt.query_map([board_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
    Ok(view)
}

/// Entity reads as deleted while its `_deleted` register is `true`.
pub fn is_deleted(fields: &serde_json::Map<String, Value>) -> bool {
    fields.get("_deleted").and_then(Value::as_bool) == Some(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Config;
    use std::path::PathBuf;

    #[derive(Deserialize)]
    struct Vector {
        name: String,
        #[serde(default)]
        board: Option<String>,
        ops: Vec<OpIn>,
        expected: Value,
    }

    fn vectors() -> Vec<Vector> {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../spec/crdt");
        let mut paths: Vec<_> = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("read {}: {e}", dir.display()))
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .collect();
        paths.sort();
        paths.iter().map(|p| serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap_or_else(|e| panic!("{}: {e}", p.display()))).collect()
    }

    fn team_conn() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&mut conn, "team").unwrap();
        conn
    }

    /// Apply ops grouped by board, in delivery order within each board.
    fn apply_grouped(conn: &mut Connection, ops: &[OpIn]) {
        let mut boards: Vec<String> = Vec::new();
        for op in ops {
            let b = op.board_id.clone().unwrap_or_else(|| "b1".into());
            if !boards.contains(&b) {
                boards.push(b);
            }
        }
        let tx = conn.transaction().unwrap();
        for b in &boards {
            let mine: Vec<OpIn> = ops
                .iter()
                .filter(|o| o.board_id.as_deref().unwrap_or("b1") == b)
                .cloned()
                .collect();
            apply_ops(&tx, b, &mine, 0).unwrap();
        }
        tx.commit().unwrap();
    }

    fn target_board(v: &Vector) -> String {
        v.board.clone().or_else(|| v.ops.first().and_then(|o| o.board_id.clone())).unwrap_or_else(|| "b1".into())
    }

    /// Project a BoardView onto the vector `expected` shape.
    fn projection(view: &BoardView) -> Value {
        let map = |xs: &[EntityView]| Value::Object(xs.iter().map(|e| (e.id.clone(), e.fields.clone())).collect());
        serde_json::json!({
            "missions": map(&view.missions),
            "notes": map(&view.notes),
            "messages": view.messages.iter().map(|m| serde_json::json!({"id": m.id, "body": m.body, "hlc": m.hlc})).collect::<Vec<_>>(),
            "removals": view.removals,
        })
    }

    /// Full materialized state, order-independent, across all boards. Used for convergence.
    fn canonical(conn: &Connection) -> Value {
        let mut fields = conn.prepare("select board_id, entity, entity_id, field, value, hlc from fields order by 1,2,3,4").unwrap();
        let fields: Vec<Vec<String>> = fields
            .query_map([], |r| Ok((0..6).map(|i| r.get::<_, Option<String>>(i).unwrap().unwrap_or_default()).collect()))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let mut msgs = conn.prepare("select id, board_id, body, hlc, node_id from messages order by 1").unwrap();
        let msgs: Vec<Vec<String>> = msgs
            .query_map([], |r| Ok((0..5).map(|i| r.get::<_, String>(i).unwrap()).collect()))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let mut counts = conn.prepare("select board_id, entity_id, node_id, total from removal_counts order by 1,2,3").unwrap();
        let counts: Vec<(String, String, String, i64)> = counts
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let ids: i64 = conn.query_row("select count(distinct id) from ops", [], |r| r.get(0)).unwrap();
        serde_json::json!({"fields": fields, "messages": msgs, "counts": counts, "ops": ids})
    }

    fn reset(conn: &Connection) {
        conn.execute_batch("delete from ops; delete from fields; delete from messages; delete from removal_counts;").unwrap();
    }

    struct XorShift(u64);
    impl XorShift {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }
        fn shuffle<T>(&mut self, xs: &mut [T]) {
            for i in (1..xs.len()).rev() {
                let j = (self.next() % (i as u64 + 1)) as usize;
                xs.swap(i, j);
            }
        }
    }

    #[test]
    fn crdt_vectors() {
        let vectors = vectors();
        let total = vectors.len();
        let mut passed = 0;
        let mut failures = Vec::new();
        for v in &vectors {
            let mut conn = team_conn();
            apply_grouped(&mut conn, &v.ops);
            let got = projection(&board(&conn, &target_board(v)).unwrap());
            if got == v.expected {
                passed += 1;
            } else {
                failures.push(format!("{}\n  expected {}\n  got      {}", v.name, v.expected, got));
            }
        }
        println!("CRDT vectors passed: {passed}/{total}");
        assert!(failures.is_empty(), "failed vectors:\n{}", failures.join("\n"));
        assert!(total >= 12, "need at least 12 vectors, found {total}");
    }

    #[test]
    fn crdt_permutations() {
        let mut rng = XorShift(0x9e37_79b9_7f4a_7c15);
        let mut conn = team_conn();
        let mut runs = 0;
        for v in vectors() {
            reset(&conn);
            apply_grouped(&mut conn, &v.ops);
            let baseline = canonical(&conn);
            assert_eq!(projection(&board(&conn, &target_board(&v)).unwrap()), v.expected, "{}", v.name);
            let mut ops = v.ops.clone();
            for round in 0..200 {
                rng.shuffle(&mut ops);
                reset(&conn);
                apply_grouped(&mut conn, &ops);
                assert_eq!(canonical(&conn), baseline, "{} diverged on permutation {round}", v.name);
                runs += 1;
            }
        }
        println!("CRDT permutations converged: {runs}");
    }

    fn sample_ops(n: usize) -> Vec<OpIn> {
        (0..n)
            .map(|i| OpIn {
                id: format!("op-{i}"),
                hlc: format!("1700000000{i:03}:0:a"),
                board_id: Some("b1".into()),
                entity: if i % 3 == 0 { "mission" } else if i % 3 == 1 { "message" } else { "removal" }.into(),
                entity_id: format!("e{i}"),
                field: if i % 3 == 1 { "body" } else { "count" }.into(),
                value: if i % 3 == 2 { Value::from(i as i64) } else { Value::from(format!("v{i}")) },
                node_id: "a".into(),
            })
            .collect()
    }

    #[test]
    fn apply_ops_idempotent() {
        let mut conn = team_conn();
        let ops = sample_ops(9);
        let tx = conn.transaction().unwrap();
        let first = apply_ops(&tx, "b1", &ops, 1).unwrap();
        assert_eq!((first.applied, first.duplicates, first.last_seq, first.persisted.len()), (9, 0, 9, 9));
        assert_eq!(first.persisted[0].1["seq"], 1);
        assert_eq!(first.persisted[0].1["boardId"], "b1");
        let second = apply_ops(&tx, "b1", &ops, 2).unwrap();
        assert_eq!((second.applied, second.duplicates, second.last_seq, second.persisted.len()), (0, 9, 9, 0));
        // A mixed batch: one new, the rest replayed.
        let mut mixed = ops.clone();
        mixed.push(OpIn { id: "op-new".into(), ..ops[0].clone() });
        let third = apply_ops(&tx, "b1", &mixed, 3).unwrap();
        assert_eq!((third.applied, third.duplicates, third.last_seq), (1, 9, 10));
        tx.commit().unwrap();
        let n: i64 = conn.query_row("select count(*) from ops", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 10);
        let since = ops_since(&conn, "b1", 8, 100).unwrap();
        assert_eq!(since.iter().map(|o| o.seq).collect::<Vec<_>>(), vec![9, 10]);
        assert_eq!(since[0].value, Value::from(8));
        assert_eq!(ops_since(&conn, "b1", 0, 2).unwrap().len(), 2);
        assert!(ops_since(&conn, "other", 0, 100).unwrap().is_empty());
        let view = board(&conn, "b1").unwrap();
        assert_eq!(view.last_seq, 10);
        assert_eq!(view.missions.len(), 3);
        assert_eq!(view.messages.len(), 3);
        assert_eq!(view.removals.len(), 3);
    }

    #[test]
    fn crdt_rejects_invalid_ops() {
        let mut conn = team_conn();
        let good = sample_ops(1).remove(0);
        let big = "x".repeat(MAX_VALUE_BYTES);
        let cases: Vec<(&str, OpIn)> = vec![
            ("entity", OpIn { entity: "task".into(), ..good.clone() }),
            ("field", OpIn { field: "".into(), ..good.clone() }),
            ("value size", OpIn { value: Value::from(big), ..good.clone() }),
            ("hlc", OpIn { hlc: "1700:x:a".into(), ..good.clone() }),
            ("hlc node", OpIn { hlc: "1700:0:".into(), ..good.clone() }),
            ("board", OpIn { board_id: Some("b2".into()), ..good.clone() }),
            ("message field", OpIn { entity: "message".into(), field: "title".into(), ..good.clone() }),
            ("message body", OpIn { entity: "message".into(), field: "body".into(), value: Value::from(1), ..good.clone() }),
            ("removal value", OpIn { entity: "removal".into(), value: Value::from(-1), ..good.clone() }),
            ("removal float", OpIn { entity: "removal".into(), value: Value::from(1.5), ..good.clone() }),
            ("removal huge", OpIn { entity: "removal".into(), value: Value::from(MAX_COUNTER + 1), ..good.clone() }),
            ("hlc 16 digits", OpIn { hlc: "1700000000000000:0:a".into(), ..good.clone() }),
            ("_deleted", OpIn { field: "_deleted".into(), value: Value::from("yes"), ..good.clone() }),
            ("id", OpIn { id: "".into(), ..good.clone() }),
        ];
        for (label, bad) in cases {
            let tx = conn.transaction().unwrap();
            let err = apply_ops(&tx, "b1", &[good.clone(), bad], 0).expect_err(label);
            assert!(invalid_reason(&err).is_some(), "{label}: {err}");
            let n: i64 = tx.query_row("select count(*) from ops", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 0, "{label}: batch must not be partially stored");
            tx.rollback().unwrap();
        }
        assert!(validate("b1", &[good]).is_ok());
    }

    #[test]
    fn hlc_order() {
        assert_eq!(compare_hlc("100:0:a", "99:9:z"), Ordering::Greater);
        assert_eq!(compare_hlc("100:1:a", "100:2:a"), Ordering::Less);
        assert_eq!(compare_hlc("100:1:b", "100:1:a"), Ordering::Greater);
        assert_eq!(compare_hlc("100:1:node-9", "100:1:node-10"), Ordering::Greater);
        assert_eq!(compare_hlc("1000:0:a", "999:0:a"), Ordering::Greater);
        let h = Hlc::parse("1700000000000:7:node:with:colons").unwrap();
        assert_eq!((h.wall_ms, h.counter, h.node_id.as_str()), (1_700_000_000_000, 7, "node:with:colons"));
        assert!(Hlc::parse("+1:0:a").is_none());
        assert!(Hlc::parse("1:0").is_none());
        assert!(Hlc::parse("").is_none());
    }

    #[tokio::test]
    async fn apply_and_publish_emits_op_events() {
        let state = AppState::memory(Config::for_tests());
        let mut rx = state.hub.subscribe();
        let ops = sample_ops(3);
        let result = apply_and_publish(&state, "b1", ops.clone()).await.unwrap();
        assert_eq!(result.applied, 3);
        for expected_seq in 1..=3 {
            match rx.try_recv().unwrap() {
                Event::Op { board_id, seq, op } => {
                    assert_eq!(board_id, "b1");
                    assert_eq!(seq, expected_seq);
                    assert_eq!(op["id"], format!("op-{}", expected_seq - 1));
                }
                other => panic!("unexpected {other:?}"),
            }
        }
        assert!(rx.try_recv().is_err());
        let again = apply_and_publish(&state, "b1", ops).await.unwrap();
        assert_eq!((again.applied, again.duplicates), (0, 3));
        assert!(rx.try_recv().is_err(), "duplicates publish nothing");
        let bad = vec![OpIn { entity: "nope".into(), ..sample_ops(1).remove(0) }];
        assert!(apply_and_publish(&state, "b1", bad).await.is_err());
        let view = state.team.read(|c| board(c, "b1")).await.unwrap();
        assert_eq!(view.last_seq, 3);
    }
}
