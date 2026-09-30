//! Dedicated writer thread (PRD §6 "SQLite in Axum").
//!
//! One OS thread owns the only write connection. Callers send boxed closures over an mpsc channel
//! and await the result on a oneshot, so async tasks never block on the SQLite write lock.
//!
//! Commands that are already queued when the thread wakes run inside one `BEGIN IMMEDIATE`
//! transaction (one fsync for the whole group). Each command runs inside its own savepoint:
//! a closure that errors or panics rolls back only its own statements, and the rest of the
//! batch still commits. A command's reply is sent only after the enclosing commit, so `Ok`
//! always means durable.

use std::collections::VecDeque;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc;

use anyhow::anyhow;
use rusqlite::{Connection, Transaction, TransactionBehavior};
use tokio::sync::oneshot;

/// Upper bound on commands grouped into one transaction. Keeps the latency of the first command
/// in a burst bounded while still amortising the commit.
const MAX_BATCH: usize = 256;

/// A type-erased write command.
trait Job: Send {
    /// Run the closure against the open transaction. Returns whether it succeeded.
    fn run(&mut self, tx: &Transaction) -> bool;
    /// Send the reply. `batch_error` is set when the enclosing transaction did not commit.
    fn finish(self: Box<Self>, batch_error: Option<&str>);
}

struct Task<F, R> {
    f: Option<F>,
    out: Option<anyhow::Result<R>>,
    reply: oneshot::Sender<anyhow::Result<R>>,
}

impl<F, R> Job for Task<F, R>
where
    F: FnOnce(&Transaction) -> rusqlite::Result<R> + Send,
    R: Send,
{
    fn run(&mut self, tx: &Transaction) -> bool {
        let Some(f) = self.f.take() else { return false };
        let out = match catch_unwind(AssertUnwindSafe(|| f(tx))) {
            Ok(result) => result.map_err(anyhow::Error::from),
            Err(panic) => Err(anyhow!("write closure panicked: {}", panic_message(panic.as_ref()))),
        };
        let ok = out.is_ok();
        self.out = Some(out);
        ok
    }

    fn finish(self: Box<Self>, batch_error: Option<&str>) {
        let out = match (self.out, batch_error) {
            (Some(Err(e)), _) => Err(e),
            (Some(Ok(v)), None) => Ok(v),
            (_, Some(err)) => Err(anyhow!("write not committed: {err}")),
            (None, None) => Err(anyhow!("write command never ran")),
        };
        // The caller may have stopped waiting (its future was dropped); nothing to do then.
        let _ = self.reply.send(out);
    }
}

fn panic_message(panic: &(dyn std::any::Any + Send)) -> &str {
    panic
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| panic.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("non-string panic payload")
}

/// Handle to the writer thread. Cheap to clone; the thread exits when the last handle drops.
#[derive(Clone)]
pub struct Writer {
    tx: mpsc::Sender<Box<dyn Job>>,
}

impl Writer {
    /// Move `conn` (already configured and migrated) onto a new thread named `db-writer-<name>`.
    pub fn spawn(conn: Connection, name: &str) -> std::io::Result<Self> {
        let (tx, rx) = mpsc::channel::<Box<dyn Job>>();
        std::thread::Builder::new()
            .name(format!("db-writer-{name}"))
            .spawn(move || run(conn, rx))?;
        Ok(Writer { tx })
    }

    pub async fn write<F, R>(&self, f: F) -> anyhow::Result<R>
    where
        F: FnOnce(&Transaction) -> rusqlite::Result<R> + Send + 'static,
        R: Send + 'static,
    {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Box::new(Task { f: Some(f), out: None, reply }))
            .map_err(|_| anyhow!("database writer thread has stopped"))?;
        rx.await.map_err(|_| anyhow!("database writer dropped the command without replying"))?
    }
}

fn run(mut conn: Connection, rx: mpsc::Receiver<Box<dyn Job>>) {
    while let Ok(first) = rx.recv() {
        let mut batch = VecDeque::from([first]);
        while batch.len() < MAX_BATCH {
            match rx.try_recv() {
                Ok(job) => batch.push_back(job),
                Err(_) => break,
            }
        }
        run_batch(&mut conn, batch);
    }
}

/// Run `queue` in as few transactions as possible. Normally that is one. If SQLite itself aborts
/// the transaction (it does so on SQLITE_FULL, SQLITE_IOERR, SQLITE_NOMEM), the commands staged so
/// far are reported as not committed and the remaining ones continue in a fresh transaction.
fn run_batch(conn: &mut Connection, mut queue: VecDeque<Box<dyn Job>>) {
    while !queue.is_empty() {
        let tx = match conn.transaction_with_behavior(TransactionBehavior::Immediate) {
            Ok(tx) => tx,
            Err(e) => {
                let msg = format!("begin failed: {e}");
                for job in queue.drain(..) {
                    job.finish(Some(&msg));
                }
                return;
            }
        };
        let mut staged: Vec<Box<dyn Job>> = Vec::with_capacity(queue.len());
        let mut aborted: Option<String> = None;

        while let Some(mut job) = queue.pop_front() {
            if let Err(e) = tx.execute_batch("savepoint cmd") {
                let msg = format!("savepoint failed: {e}");
                job.finish(Some(&msg));
                aborted = Some(msg);
                break;
            }
            if job.run(&tx) {
                if let Err(e) = tx.execute_batch("release cmd") {
                    aborted = Some(format!("release failed: {e}"));
                    staged.push(job);
                    break;
                }
                staged.push(job);
                continue;
            }
            // The command failed: its own error goes back to its caller either way.
            if tx.is_autocommit() {
                // SQLite already rolled back the whole transaction, taking earlier commands with it.
                job.finish(None);
                aborted = Some("an earlier command in the same batch aborted the transaction".into());
                break;
            }
            let undo = tx.execute_batch("rollback to cmd; release cmd");
            job.finish(None);
            if let Err(e) = undo {
                aborted = Some(format!("rollback to savepoint failed: {e}"));
                break;
            }
        }

        let outcome = match aborted {
            // Dropping `tx` rolls back whatever is still open.
            Some(msg) => Err(msg),
            None => tx.commit().map_err(|e| format!("commit failed: {e}")),
        };
        for job in staged {
            job.finish(outcome.as_ref().err().map(String::as_str));
        }
    }
}
