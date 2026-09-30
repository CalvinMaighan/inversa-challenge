//! Dedupe and revisions for sightings (T9). Runs inside the write transaction.

use rusqlite::Transaction;

pub fn post_write(_tx: &Transaction, _source_id: &str, _from_ms: i64, _to_ms: i64) -> rusqlite::Result<()> {
    Ok(())
}
