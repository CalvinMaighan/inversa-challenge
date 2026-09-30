//! Read connection pool (PRD §6 "SQLite in Axum").
//!
//! N connections, each marked `query_only`. A tokio semaphore hands out one permit per
//! connection, so waiting for a free connection is async; the query itself runs on the blocking
//! pool through `spawn_blocking`.

use std::sync::{Arc, Mutex, PoisonError};

use rusqlite::Connection;
use tokio::sync::Semaphore;

/// Pool size: available parallelism, clamped to 2..=8.
pub fn default_size() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 8)
}

/// Pragmas for a read connection. WAL mode is a property of the file and is already set by the
/// writer; `query_only` turns any accidental write into an error instead of a lock fight.
pub fn configure_reader(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "pragma busy_timeout = 5000;
         pragma foreign_keys = on;
         pragma query_only = on;",
    )
}

struct Inner {
    idle: Mutex<Vec<Connection>>,
}

#[derive(Clone)]
pub struct Pool {
    inner: Arc<Inner>,
    permits: Arc<Semaphore>,
}

impl Pool {
    /// Open `size` connections with `open`.
    pub fn open(size: usize, open: impl Fn() -> rusqlite::Result<Connection>) -> rusqlite::Result<Self> {
        let conns = (0..size).map(|_| open()).collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Pool { permits: Arc::new(Semaphore::new(conns.len())), inner: Arc::new(Inner { idle: Mutex::new(conns) }) })
    }

    pub async fn read<F, R>(&self, f: F) -> anyhow::Result<R>
    where
        F: FnOnce(&Connection) -> rusqlite::Result<R> + Send + 'static,
        R: Send + 'static,
    {
        let permit = self.permits.clone().acquire_owned().await?;
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || {
            let lease = Lease::take(&inner);
            let out = f(lease.conn());
            // Return the connection before releasing the permit, so a woken waiter always finds one.
            drop(lease);
            drop(permit);
            Ok(out?)
        })
        .await?
    }
}

/// A connection checked out of the pool. Goes back on drop, including while unwinding from a
/// panic inside the read closure.
struct Lease<'a> {
    inner: &'a Inner,
    conn: Option<Connection>,
}

impl<'a> Lease<'a> {
    fn take(inner: &'a Inner) -> Self {
        let conn = inner.idle.lock().unwrap_or_else(PoisonError::into_inner).pop();
        // Each semaphore permit corresponds to exactly one idle connection.
        Lease { inner, conn: Some(conn.expect("read permit held but no idle connection")) }
    }

    fn conn(&self) -> &Connection {
        self.conn.as_ref().expect("lease holds a connection until drop")
    }
}

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        let Some(conn) = self.conn.take() else { return };
        // A closure that opened a transaction and never finished it would pin an old WAL snapshot
        // (and block checkpoints) for as long as the connection lives. End it here.
        if !conn.is_autocommit() {
            let _ = conn.execute_batch("rollback");
        }
        self.inner.idle.lock().unwrap_or_else(PoisonError::into_inner).push(conn);
    }
}
