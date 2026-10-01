//! SQLite access (PLAN.md C12). The public surface is the contract: `open`, `memory`, `write`,
//! `read`, `migrations`, `configure`, `migrate`; the database name passed to `open`/`memory`
//! selects the migration set. Internally: one writer thread
//! (`writer.rs`) plus a pool of read connections (`pool.rs`).

mod pool;
mod writer;

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{Connection, OpenFlags, Transaction};

const OBSERVATIONS: &[(&str, &str)] = &[
    ("0001_init", include_str!("../../migrations/observations/0001_init.sql")),
    ("0002_source_indexes", include_str!("../../migrations/observations/0002_source_indexes.sql")),
    ("0003_source_disabled", include_str!("../../migrations/observations/0003_source_disabled.sql")),
    ("0004_taxon_info", include_str!("../../migrations/observations/0004_taxon_info.sql")),
    ("0005_taxon_ancestry", include_str!("../../migrations/observations/0005_taxon_ancestry.sql")),
];
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
         pragma busy_timeout = 30000;
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
///
/// Writes go to a dedicated writer thread (`writer.rs`); reads go to a pool of read connections
/// (`pool.rs`). File databases use WAL, so readers never wait for the writer.
#[derive(Clone)]
pub struct Db {
    writer: writer::Writer,
    readers: pool::Pool,
}

fn static_name(name: &str) -> &'static str {
    match name {
        "observations" => "observations",
        "team" => "team",
        other => panic!("unknown database {other}"),
    }
}

/// Flags for every connection: no SQLite-level mutex (a connection is only ever used by one
/// thread at a time), URI filenames so `memory` can name a memdb database.
fn open_flags() -> OpenFlags {
    OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_CREATE
        | OpenFlags::SQLITE_OPEN_URI
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
}

impl Db {
    pub fn open(dir: &Path, name: &str) -> anyhow::Result<Self> {
        let name = static_name(name);
        let path = dir.join(format!("{name}.db"));
        let mut conn = Connection::open_with_flags(&path, open_flags())?;
        configure(&conn)?;
        migrate(&mut conn, name)?;
        Self::start(conn, name, || Connection::open_with_flags(&path, open_flags()))
    }

    /// A private in-memory database, shared by its writer and readers.
    ///
    /// Uses SQLite's `memdb` VFS with a `/`-prefixed name, which every connection in the process
    /// can open. A `cache=shared` URI would also share it, but shared-cache mode reports table-lock
    /// conflicts as SQLITE_LOCKED without consulting `busy_timeout`, so reads during a write would
    /// fail. memdb has no WAL: a commit briefly waits for in-flight reads, which `busy_timeout`
    /// covers. Each call gets a fresh database, freed when the last clone drops.
    pub fn memory(name: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let name = static_name(name);
        let uri = format!(
            "file:/inversa-{name}-{}-{}?vfs=memdb",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let mut conn = Connection::open_with_flags(&uri, open_flags()).expect("open memory db");
        conn.execute_batch("pragma busy_timeout = 5000; pragma foreign_keys = on;").expect("memory db pragmas");
        migrate(&mut conn, name).expect("migrate memory db");
        Self::start(conn, name, || Connection::open_with_flags(&uri, open_flags())).expect("start memory db")
    }

    /// Open the read pool (after migrations, so readers see the schema), then hand the write
    /// connection to its thread.
    fn start(
        conn: Connection,
        name: &'static str,
        open_reader: impl Fn() -> rusqlite::Result<Connection>,
    ) -> anyhow::Result<Self> {
        let readers = pool::Pool::open(pool::default_size(), || {
            let reader = open_reader()?;
            pool::configure_reader(&reader)?;
            Ok(reader)
        })?;
        let writer = writer::Writer::spawn(conn, name)?;
        Ok(Db { writer, readers })
    }

    /// Run `f` in a write transaction on the writer thread. Commits on Ok, rolls back on Err.
    ///
    /// Commands queued together share one transaction, but each runs in its own savepoint, so an
    /// Err (or panic) from `f` undoes only `f`'s statements. `Ok` is returned after the commit.
    pub async fn write<F, R>(&self, f: F) -> anyhow::Result<R>
    where
        F: FnOnce(&Transaction) -> rusqlite::Result<R> + Send + 'static,
        R: Send + 'static,
    {
        self.writer.write(f).await
    }

    /// Run `f` against a pooled read connection on the blocking thread pool.
    pub async fn read<F, R>(&self, f: F) -> anyhow::Result<R>
    where
        F: FnOnce(&Connection) -> rusqlite::Result<R> + Send + 'static,
        R: Send + 'static,
    {
        self.readers.read(f).await
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use std::time::Duration;

    use rusqlite::params;

    use super::*;

    /// A fresh directory under the system temp dir, removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "inversa-{tag}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    async fn insert_message(db: &Db, id: String) -> anyhow::Result<usize> {
        db.write(move |tx| {
            tx.execute(
                "insert into messages (id, board_id, body, hlc, node_id) values (?1, 'b', 'hi', ?1, 'n')",
                params![id],
            )
        })
        .await
    }

    async fn message_ids(db: &Db) -> HashSet<String> {
        db.read(|c| {
            let mut stmt = c.prepare("select id from messages")?;
            let ids = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<HashSet<String>>>()?;
            Ok(ids)
        })
        .await
        .unwrap()
    }

    /// 8 writer tasks and 8 reader tasks against one database. Every call must succeed (no
    /// SQLITE_BUSY / SQLITE_LOCKED), readers must only ever see the row count grow, and every
    /// written row must be there at the end.
    async fn hammer(db: Db) {
        const WRITERS: usize = 8;
        const READERS: usize = 8;
        const ROWS: usize = 60;

        let done = Arc::new(AtomicBool::new(false));
        let readers: Vec<_> = (0..READERS)
            .map(|_| {
                let (db, done) = (db.clone(), done.clone());
                tokio::spawn(async move {
                    let (mut last, mut reads) = (0i64, 0u32);
                    loop {
                        let finished = done.load(Ordering::SeqCst);
                        let n: i64 = db
                            .read(|c| c.query_row("select count(*) from messages", [], |r| r.get(0)))
                            .await
                            .unwrap_or_else(|e| panic!("read failed: {e:#}"));
                        assert!(n >= last, "row count went backwards: {last} -> {n}");
                        last = n;
                        reads += 1;
                        if finished {
                            return reads;
                        }
                        tokio::task::yield_now().await;
                    }
                })
            })
            .collect();
        let writers: Vec<_> = (0..WRITERS)
            .map(|w| {
                let db = db.clone();
                tokio::spawn(async move {
                    for i in 0..ROWS {
                        insert_message(&db, format!("{w}-{i}")).await.unwrap_or_else(|e| panic!("write failed: {e:#}"));
                    }
                })
            })
            .collect();
        for w in writers {
            w.await.unwrap();
        }
        done.store(true, Ordering::SeqCst);
        for r in readers {
            assert!(r.await.unwrap() > 0);
        }
        let expected: HashSet<String> = (0..WRITERS).flat_map(|w| (0..ROWS).map(move |i| format!("{w}-{i}"))).collect();
        assert_eq!(message_ids(&db).await, expected);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    async fn concurrent() {
        hammer(Db::memory("team")).await;
        let dir = TempDir::new("db-concurrent");
        hammer(Db::open(&dir.0, "team").unwrap()).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn failing_write_rolls_back_only_itself() {
        let db = Db::memory("team");

        // Park the writer thread so the next commands queue up and run as one batch.
        let (parked_tx, parked_rx) = tokio::sync::oneshot::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let gate = {
            let db = db.clone();
            tokio::spawn(async move {
                db.write(move |_| {
                    parked_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(())
                })
                .await
            })
        };
        parked_rx.await.unwrap();

        let ok_a = tokio::spawn({
            let db = db.clone();
            async move { insert_message(&db, "a".into()).await }
        });
        let bad = tokio::spawn({
            let db = db.clone();
            async move {
                db.write(|tx| {
                    tx.execute("insert into messages (id, board_id, body, hlc, node_id) values ('b', 'b', 'x', 'h', 'n')", [])?;
                    tx.execute("insert into no_such_table values (1)", [])
                })
                .await
            }
        });
        let panics = tokio::spawn({
            let db = db.clone();
            async move {
                db.write(|tx| -> rusqlite::Result<()> {
                    tx.execute("insert into messages (id, board_id, body, hlc, node_id) values ('c', 'b', 'x', 'h', 'n')", [])?;
                    panic!("boom");
                })
                .await
            }
        });
        let ok_d = tokio::spawn({
            let db = db.clone();
            async move { insert_message(&db, "d".into()).await }
        });
        // Give the four tasks time to enqueue behind the parked command.
        tokio::time::sleep(Duration::from_millis(100)).await;
        release_tx.send(()).unwrap();

        gate.await.unwrap().unwrap();
        assert_eq!(ok_a.await.unwrap().unwrap(), 1);
        let err = bad.await.unwrap().unwrap_err();
        assert!(format!("{err:#}").contains("no_such_table"), "{err:#}");
        let err = panics.await.unwrap().unwrap_err();
        assert!(format!("{err:#}").contains("panicked: boom"), "{err:#}");
        assert_eq!(ok_d.await.unwrap().unwrap(), 1);

        assert_eq!(message_ids(&db).await, HashSet::from(["a".to_string(), "d".to_string()]));
        // The writer thread survived the panic.
        insert_message(&db, "e".into()).await.unwrap();
        assert!(message_ids(&db).await.contains("e"));
    }

    #[tokio::test]
    async fn write_err_rolls_back_and_errors_keep_their_type() {
        let db = Db::memory("team");
        insert_message(&db, "x".into()).await.unwrap();
        let err = insert_message(&db, "x".into()).await.unwrap_err();
        let sqlite = err.downcast_ref::<rusqlite::Error>().expect("rusqlite error preserved");
        assert_eq!(sqlite.sqlite_error_code(), Some(rusqlite::ErrorCode::ConstraintViolation));
        assert_eq!(message_ids(&db).await.len(), 1);
    }

    #[tokio::test]
    async fn readers_are_query_only() {
        let db = Db::memory("team");
        let err = db.read(|c| c.execute("delete from messages", [])).await.unwrap_err();
        assert!(format!("{err:#}").contains("readonly"), "{err:#}");
    }

    #[tokio::test]
    async fn reopening_a_file_db_keeps_data_and_skips_applied_migrations() {
        let dir = TempDir::new("db-reopen");
        {
            let db = Db::open(&dir.0, "team").unwrap();
            insert_message(&db, "kept".into()).await.unwrap();
        }
        let db = Db::open(&dir.0, "team").unwrap();
        assert!(message_ids(&db).await.contains("kept"));
        let applied: i64 =
            db.read(|c| c.query_row("select count(*) from schema_migration", [], |r| r.get(0))).await.unwrap();
        assert_eq!(applied, migrations("team").len() as i64);
        let mode: String = db.read(|c| c.query_row("pragma journal_mode", [], |r| r.get(0))).await.unwrap();
        assert_eq!(mode, "wal");
    }

    #[tokio::test]
    async fn memory_dbs_are_isolated() {
        let a = Db::memory("team");
        let b = Db::memory("team");
        insert_message(&a, "only-a".into()).await.unwrap();
        assert!(message_ids(&b).await.is_empty());
    }

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
