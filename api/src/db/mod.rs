//! SQLite access (PLAN.md C12). The public surface below is the contract: `open`, `memory`,
//! `write`, `read`. T4 replaces the internals with a dedicated writer thread plus a read pool;
//! callers never change.

mod pool;
mod writer;

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, Transaction};

const OBSERVATIONS: &[(&str, &str)] = &[("0001_init", include_str!("../../migrations/observations/0001_init.sql"))];
const TEAM: &[(&str, &str)] = &[("0001_init", include_str!("../../migrations/team/0001_init.sql"))];

pub fn migrations(name: &str) -> &'static [(&'static str, &'static str)] {
    match name {
        "observations" => OBSERVATIONS,
        "team" => TEAM,
        other => panic!("unknown database {other}"),
    }
}

/// Pragmas every connection gets.
pub fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "pragma journal_mode = wal;
         pragma synchronous = normal;
         pragma busy_timeout = 5000;
         pragma foreign_keys = on;",
    )
}

/// Apply pending migrations, tracked in `schema_migration`.
pub fn migrate(conn: &mut Connection, name: &str) -> rusqlite::Result<()> {
    conn.execute_batch("create table if not exists schema_migration (id text primary key, applied_at integer not null)")?;
    for (id, sql) in migrations(name) {
        let done: bool =
            conn.query_row("select exists(select 1 from schema_migration where id = ?1)", [id], |r| r.get(0))?;
        if done {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute(
            "insert into schema_migration (id, applied_at) values (?1, ?2)",
            rusqlite::params![id, chrono::Utc::now().timestamp_millis()],
        )?;
        tx.commit()?;
    }
    Ok(())
}

/// Handle to one database. Cheap to clone.
#[derive(Clone)]
pub struct Db {
    inner: Arc<Mutex<Connection>>,
    pub name: &'static str,
}

fn static_name(name: &str) -> &'static str {
    match name {
        "observations" => "observations",
        "team" => "team",
        other => panic!("unknown database {other}"),
    }
}

impl Db {
    pub fn open(dir: &Path, name: &str) -> anyhow::Result<Self> {
        let mut conn = Connection::open(dir.join(format!("{name}.db")))?;
        configure(&conn)?;
        migrate(&mut conn, name)?;
        Ok(Db { inner: Arc::new(Mutex::new(conn)), name: static_name(name) })
    }

    pub fn memory(name: &str) -> Self {
        let mut conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch("pragma foreign_keys = on;").expect("pragma");
        migrate(&mut conn, name).expect("migrate");
        Db { inner: Arc::new(Mutex::new(conn)), name: static_name(name) }
    }

    /// Run `f` in one write transaction. Commits on Ok, rolls back on Err.
    pub async fn write<F, R>(&self, f: F) -> anyhow::Result<R>
    where
        F: FnOnce(&Transaction) -> rusqlite::Result<R> + Send + 'static,
        R: Send + 'static,
    {
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = inner.lock().expect("db lock");
            let tx = conn.transaction()?;
            let out = f(&tx)?;
            tx.commit()?;
            Ok(out)
        })
        .await?
    }

    /// Run `f` against a read connection.
    pub async fn read<F, R>(&self, f: F) -> anyhow::Result<R>
    where
        F: FnOnce(&Connection) -> rusqlite::Result<R> + Send + 'static,
        R: Send + 'static,
    {
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || {
            let conn = inner.lock().expect("db lock");
            Ok(f(&conn)?)
        })
        .await?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn migrations_apply_and_seed_taxa() {
        let db = Db::memory("observations");
        let n: i64 = db.read(|c| c.query_row("select count(*) from taxa where focus = 1", [], |r| r.get(0))).await.unwrap();
        assert_eq!(n, 4);
        let team = Db::memory("team");
        let n: i64 = team.read(|c| c.query_row("select count(*) from ops", [], |r| r.get(0))).await.unwrap();
        assert_eq!(n, 0);
    }
}
