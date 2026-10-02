//! Supervised per-source tasks and the ingest pipeline (T5, PRD §6), one scheduler per app
//! (PLAN.md C-A1): only the sources an app's `feeds[]` lists are registered and started for it.
//!
//! Every payload, polled or pushed, goes through [`ingest_payload`]:
//! gzip + archive, `raw_objects`, `normalize`, one write transaction (row upserts, `fetch_runs`,
//! quality post-write hooks), then `ack`, cursor, and `RowsWritten` on the Hub.

use std::collections::HashMap;
use std::io::Write as _;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Context;
use futures_util::FutureExt;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::task::JoinHandle;

use crate::app::config::App;
use crate::forecast::store::{self as forecast_store, Inserted, NewSnapshot};
use crate::ingest::archive::raw_key;
use crate::ingest::governor::{self, Attempt, Governor};
use crate::ingest::source::{FetchCtx, RawPayload, Source, SourceInfo};
use crate::model::{AlertRow, ForecastObservationsRow, ForecastRow, Param, ReadingRow, RevisionRow, Row, SightingRow, SiteAlertsRow, StationRef, TaxonRef, ThresholdsRow};
use crate::realtime::Event;
use crate::state::AppState;

/// Content type archived objects are stored with (payloads are gzipped before `put`).
pub const ARCHIVE_CONTENT_TYPE: &str = "application/gzip";

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------

/// Restart policy for a source task.
#[derive(Debug, Clone, Copy)]
pub struct Supervision {
    /// Delay before the first restart.
    pub initial: Duration,
    /// Restart delay doubles up to this.
    pub max: Duration,
    /// A task that ran at least this long before failing restarts from `initial` again.
    pub healthy_after: Duration,
}

impl Default for Supervision {
    fn default() -> Self {
        Supervision { initial: Duration::from_secs(1), max: Duration::from_secs(300), healthy_after: Duration::from_secs(60) }
    }
}

/// Upsert every source the app lists into `sources` (with the reason for each one that will not
/// run), then (when `config.sources_enabled`) start one supervised task per push/poll source.
/// Returns immediately; the work runs on the runtime.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let app = state.app.id().to_string();
        match start(state, Supervision::default()).await {
            Ok(handles) => tracing::info!(app, "scheduler: {} source tasks running", handles.len()),
            Err(e) => tracing::error!(app, "scheduler: start failed: {e:#}"),
        }
    });
}

/// What the scheduler would register and run for an app, before anything is spawned.
pub struct Plan {
    /// Sources with a fetch loop (push and poll), in start order.
    pub runnable: Vec<Arc<dyn Source>>,
    /// Every source the app lists, with the reason it is not running (`None` = it runs).
    pub known: Vec<(SourceInfo, Option<String>)>,
}

#[cfg(test)]
impl Plan {
    pub fn runnable_ids(&self) -> Vec<&'static str> {
        self.runnable.iter().map(|s| s.info().id).collect()
    }

    pub fn known_ids(&self) -> Vec<&'static str> {
        self.known.iter().map(|(i, _)| i.id).collect()
    }
}

/// Intern a config string as `&'static str` (`SourceInfo` fields are static): each distinct
/// value is leaked once per process, however often the scheduler plans.
fn intern(s: &str) -> &'static str {
    static POOL: std::sync::OnceLock<std::sync::Mutex<HashMap<String, &'static str>>> = std::sync::OnceLock::new();
    let mut pool = POOL.get_or_init(Default::default).lock().unwrap_or_else(|p| p.into_inner());
    pool.entry(s.to_string()).or_insert_with(|| Box::leak(s.to_string().into_boxed_str()))
}

/// Static description of a feed the config lists but no adapter serves yet (`nwps`).
fn pending_info(feed: &crate::app::config::FeedCfg) -> SourceInfo {
    let leak = |s: Option<&str>, fallback: &'static str| -> &'static str { s.map(intern).unwrap_or(fallback) };
    SourceInfo {
        id: leak(Some(&feed.source), ""),
        name: leak(feed.name.as_deref(), "pending adapter"),
        homepage: leak(feed.homepage.as_deref(), ""),
        mode: match feed.mode {
            crate::app::config::Mode::Push => crate::ingest::source::Mode::Push,
            crate::app::config::Mode::Poll => crate::ingest::source::Mode::Poll,
        },
        cadence: Duration::from_secs(24 * 3600),
        max_latency: Duration::from_secs(48 * 3600),
    }
}

/// The sources of `state.app`: runnable ones from the push and poll registries, disabled push
/// sources (missing secrets) and feeds whose adapter is
/// still pending, each with its reason.
pub fn plan(state: &AppState) -> Plan {
    let app = &state.app;
    let mut runnable = crate::ingest::push::all(&state.config, app);
    runnable.extend(crate::ingest::poll::all(&state.config, app));

    // (info, why it is not running).
    let fetch_reason = (!state.config.sources_enabled).then(|| "INVERSA_SOURCES=off".to_string());
    let mut known: Vec<(SourceInfo, Option<String>)> =
        runnable.iter().map(|s| (s.info(), fetch_reason.clone())).collect();
    known.extend(crate::ingest::push::disabled(&state.config, app).into_iter().map(|(info, reason)| (info, Some(reason))));
    for feed in app.cfg.feeds.iter().filter(|f| crate::app::config::PENDING_SOURCES.contains(&f.source.as_str())) {
        known.push((pending_info(feed), Some(format!("adapter for {} not implemented yet", feed.source))));
    }
    Plan { runnable, known }
}

/// The body of [`spawn`], returning the task handles so tests can observe and stop them.
pub async fn start(state: AppState, supervision: Supervision) -> anyhow::Result<Vec<JoinHandle<()>>> {
    let Plan { runnable, known } = plan(&state);
    for (info, reason) in &known {
        if let Some(reason) = reason {
            tracing::info!(app = state.app.id(), source = info.id, "scheduler: source disabled: {reason}");
        }
    }
    upsert_sources(&state, known.iter().map(|(info, _)| info.clone()).collect()).await?;
    set_disabled(&state, known.into_iter().map(|(info, reason)| (info.id, reason)).collect()).await?;

    if !state.config.sources_enabled {
        tracing::info!(app = state.app.id(), "scheduler: sources disabled (INVERSA_SOURCES=off)");
        return Ok(Vec::new());
    }
    Ok(spawn_sources(&state, runnable, supervision))
}

/// Record, per source, why it is not running (`None` clears a reason from an earlier boot).
pub async fn set_disabled(state: &AppState, reasons: Vec<(&'static str, Option<String>)>) -> anyhow::Result<()> {
    state
        .obs
        .write(move |tx| {
            let mut st = tx.prepare_cached(
                "update sources set disabled_reason = ?2 where id = ?1 and disabled_reason is not ?2",
            )?;
            for (id, reason) in &reasons {
                st.execute(params![id, reason])?;
            }
            Ok(())
        })
        .await
}

/// One supervised task per source.
pub fn spawn_sources(state: &AppState, sources: Vec<Arc<dyn Source>>, supervision: Supervision) -> Vec<JoinHandle<()>> {
    sources.into_iter().map(|source| tokio::spawn(supervise(state.clone(), source, supervision))).collect()
}

pub async fn upsert_sources(state: &AppState, infos: Vec<SourceInfo>) -> anyhow::Result<()> {
    state
        .obs
        .write(move |tx| {
            for info in &infos {
                upsert_source(tx, info)?;
            }
            Ok(())
        })
        .await
}

fn upsert_source(tx: &Transaction, info: &SourceInfo) -> rusqlite::Result<()> {
    tx.prepare_cached(
        "insert into sources (id, name, homepage, mode, cadence_s, max_latency_s) values (?1, ?2, ?3, ?4, ?5, ?6)
         on conflict(id) do update set name = excluded.name, homepage = excluded.homepage, mode = excluded.mode,
           cadence_s = excluded.cadence_s, max_latency_s = excluded.max_latency_s
         where sources.name is not excluded.name or sources.homepage is not excluded.homepage
           or sources.mode is not excluded.mode or sources.cadence_s is not excluded.cadence_s
           or sources.max_latency_s is not excluded.max_latency_s",
    )?
    .execute(params![
        info.id,
        info.name,
        info.homepage,
        info.mode.as_str(),
        info.cadence.as_secs() as i64,
        info.max_latency.as_secs() as i64
    ])?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Supervision
// ---------------------------------------------------------------------------------------------

/// Run a source forever. A panic or error restarts it after a doubling delay; other sources are
/// separate tasks and never notice.
async fn supervise(state: AppState, source: Arc<dyn Source>, sup: Supervision) {
    let id = source.info().id;
    let mut delay = sup.initial;
    loop {
        let started = Instant::now();
        let run = AssertUnwindSafe(run_source(state.clone(), source.clone())).catch_unwind().await;
        match run {
            Ok(Ok(())) => {
                tracing::info!(source = id, "source task finished");
                return;
            }
            Ok(Err(e)) => tracing::warn!(source = id, "source task failed: {e:#}"),
            Err(panic) => {
                let msg = panic
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "non-string panic".into());
                tracing::error!(source = id, "source task panicked: {msg}");
            }
        }
        if started.elapsed() >= sup.healthy_after {
            delay = sup.initial;
        }
        tracing::info!(source = id, "restarting in {}ms", delay.as_millis());
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(sup.max);
    }
}

/// Fetch loop for one source, paced by its governor. Fetch failures are recorded and throttled
/// here; pipeline failures (archive, database) end the task so the supervisor restarts it.
async fn run_source(state: AppState, source: Arc<dyn Source>) -> anyhow::Result<()> {
    let info = source.info();
    let gov: Arc<Governor> = governor::for_source(info.id, source.min_interval());
    // A nudge-capable source (`push::nudge::capable`) sleeps until its next poll or a provider
    // nudge, whichever is first.
    let nudge = crate::ingest::push::nudge::capable(info.id, info.mode).then(|| state.nudges.waker(info.id));
    let mut cursor = load_cursor(&state, info.id).await?;
    // The governor is shared by every app polling the same upstream (one backoff per host), and
    // keeps the interval of the first app to register. A poller also keeps its own app's cadence
    // (Lionfish Watch polls iNat every 10 min while the python app polls every 2).
    let own_floor = (info.mode == crate::ingest::source::Mode::Poll).then(|| source.min_interval());
    let mut last_start: Option<Instant> = None;
    loop {
        let now = Instant::now();
        let own = match (own_floor, last_start) {
            (Some(floor), Some(at)) => (at + floor).saturating_duration_since(now),
            _ => Duration::ZERO,
        };
        let wait = gov.wait(now).max(own);
        if !wait.is_zero() {
            match &nudge {
                // A nudge never cuts a 429/5xx backoff short: the provider asked us to slow down.
                Some(n) if !gov.snapshot(Instant::now()).backing_off() => {
                    tokio::select! {
                        _ = tokio::time::sleep(wait) => {}
                        _ = n.notified() => tracing::info!(source = info.id, "nudged: fetching before the backstop poll"),
                    }
                }
                _ => tokio::time::sleep(wait).await,
            }
        }
        let fetched_at = state.now_ms();
        last_start = Some(Instant::now());
        let result = source.fetch(&FetchCtx { state: &state, cursor: cursor.clone() }).await;
        match result {
            Ok(payloads) => {
                gov.record(Attempt::Success, Instant::now());
                if payloads.is_empty() {
                    record_run(&state, &info, fetched_at, RunStatus::Empty, None, None).await?;
                }
                for raw in payloads {
                    let out = ingest_payload(&state, source.as_ref(), raw, cursor.clone()).await?;
                    if out.cursor.is_some() {
                        cursor = out.cursor;
                    }
                }
            }
            Err(e) => {
                let attempt = governor::classify(&e);
                gov.record(attempt, Instant::now());
                let status = match attempt {
                    Attempt::Throttled { status, .. } => Some(status),
                    Attempt::Failed { status } => status,
                    Attempt::Success => None,
                };
                let mut message = format!("{e:#}");
                if let Some(note) = gov.snapshot(Instant::now()).note() {
                    message.push_str(&format!(" [{note}]"));
                }
                tracing::warn!(source = info.id, "fetch failed: {message}");
                record_run(&state, &info, fetched_at, RunStatus::Error, status, Some(message)).await?;
            }
        }
    }
}

async fn load_cursor(state: &AppState, source_id: &'static str) -> anyhow::Result<Option<String>> {
    state
        .obs
        .read(move |c| {
            c.query_row("select cursor from cursors where source_id = ?1", [source_id], |r| r.get(0)).optional()
        })
        .await
}

/// A fetch run with no payload (nothing new, or the fetch failed).
async fn record_run(
    state: &AppState,
    info: &SourceInfo,
    fetched_at: i64,
    status: RunStatus,
    http_status: Option<u16>,
    error: Option<String>,
) -> anyhow::Result<i64> {
    let (info, received_at) = (info.clone(), state.now_ms());
    state
        .obs
        .write(move |tx| {
            upsert_source(tx, &info)?;
            insert_fetch_run(tx, info.id, (fetched_at, received_at), status, http_status, 0, None, error.as_deref())
        })
        .await
}

// ---------------------------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Ok,
    Empty,
    Error,
    Partial,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RunStatus::Ok => "ok",
            RunStatus::Empty => "empty",
            RunStatus::Error => "error",
            RunStatus::Partial => "partial",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestOutcome {
    pub status: RunStatus,
    pub fetch_run_id: i64,
    pub raw_object_id: i64,
    pub r2_key: String,
    /// Rows `normalize` produced.
    pub rows_in: usize,
    /// Rows inserted or changed. Zero when the same payload is ingested again.
    pub rows_written: usize,
    /// Rows rejected (invalid coordinates, revision for an unknown sighting, ...).
    pub rows_skipped: usize,
    /// observed_at range (unix ms) of the sightings and readings that changed.
    pub window: Option<(i64, i64)>,
    /// Cursor persisted for the source, if the payload carried one.
    pub cursor: Option<String>,
    pub error: Option<String>,
}

/// Archive, normalize and write one payload. `cursor` is the source's current committed cursor,
/// passed to `ack`. Returns `Err` only for infrastructure failures (archive, database); a payload
/// that fails to normalize is recorded as a `status=error` fetch run and returned as `Ok`.
pub async fn ingest_payload(
    state: &AppState,
    source: &dyn Source,
    raw: RawPayload,
    cursor: Option<String>,
) -> anyhow::Result<IngestOutcome> {
    let info = source.info();
    let source_id = info.id;

    // 1. gzip + hash off the async threads (GOES payloads are tens of MB).
    let (raw, sha256, gz) = tokio::task::spawn_blocking(move || -> anyhow::Result<(RawPayload, String, Vec<u8>)> {
        let sha = hex::encode(Sha256::digest(&raw.bytes));
        let mut enc =
            flate2::write::GzEncoder::new(Vec::with_capacity(raw.bytes.len() / 4 + 64), flate2::Compression::default());
        enc.write_all(&raw.bytes)?;
        let gz = enc.finish()?;
        Ok((raw, sha, gz))
    })
    .await??;

    // 2. raw_objects. An identical payload already archived for this source is reused, so a
    //    re-run adds no object; otherwise put first, then record the key.
    let (raw_object_id, r2_key) = {
        let info = info.clone();
        let sha = sha256.clone();
        let existing = state
            .obs
            .write(move |tx| {
                upsert_source(tx, &info)?;
                tx.query_row(
                    "select id, r2_key from raw_objects where source_id = ?1 and sha256 = ?2 order by id desc limit 1",
                    params![info.id, sha],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
                )
                .optional()
            })
            .await?;
        match existing {
            Some(found) => found,
            None => {
                let key = raw_key(source_id, raw.fetched_at, &raw.content_type);
                state.archive.put(&key, gz, ARCHIVE_CONTENT_TYPE).await.with_context(|| format!("archive {key}"))?;
                let (k, url, at, len) = (key.clone(), raw.source_url.clone(), raw.fetched_at, raw.bytes.len() as i64);
                let id = state
                    .obs
                    .write(move |tx| {
                        tx.execute(
                            "insert into raw_objects (r2_key, source_id, source_url, fetched_at, bytes, sha256)
                             values (?1, ?2, ?3, ?4, ?5, ?6)",
                            params![k, source_id, url, at, len, sha256],
                        )?;
                        Ok(tx.last_insert_rowid())
                    })
                    .await?;
                (id, key)
            }
        }
    };

    let mut outcome = IngestOutcome {
        status: RunStatus::Ok,
        fetch_run_id: 0,
        raw_object_id,
        r2_key,
        rows_in: 0,
        rows_written: 0,
        rows_skipped: 0,
        window: None,
        cursor: None,
        error: None,
    };

    // 3. normalize (pure).
    let rows = match source.normalize(&raw) {
        Ok(rows) => rows,
        Err(e) => {
            let msg = format!("normalize: {e:#}");
            tracing::warn!(source = source_id, key = %outcome.r2_key, "{msg}");
            let (at, http, received) = (raw.fetched_at, raw.http_status, state.now_ms());
            let err = msg.clone();
            outcome.fetch_run_id = state
                .obs
                .write(move |tx| {
                    insert_fetch_run(tx, source_id, (at, received), RunStatus::Error, http, 0, Some(raw_object_id), Some(&err))
                })
                .await?;
            outcome.status = RunStatus::Error;
            outcome.error = Some(msg);
            return Ok(outcome);
        }
    };
    outcome.rows_in = rows.len();

    // 4-7. One transaction: rows, fetch run, quality hooks, commit.
    let (fetched_at, http_status) = (raw.fetched_at, raw.http_status);
    let app = state.app.clone();
    // Ingest time on the app's clock (`state::Clock`), so a pinned replay stamps rows with it.
    let received_at = state.now_ms();
    let written = state
        .obs
        .write(move |tx| {
            let mut w = RowWriter::new(tx, &app, source_id, raw_object_id, received_at);
            for row in &rows {
                w.write(row)?;
            }
            let (rows_written, rows_skipped, window) = (w.written, w.skipped, w.window);
            let status = if rows.is_empty() {
                RunStatus::Empty
            } else if rows_skipped > 0 {
                RunStatus::Partial
            } else {
                RunStatus::Ok
            };
            let note = (rows_skipped > 0).then(|| format!("{rows_skipped} of {} rows skipped", rows.len()));
            let run_id = insert_fetch_run(
                tx,
                source_id,
                (fetched_at, received_at),
                status,
                http_status,
                rows.len() as i64,
                Some(raw_object_id),
                note.as_deref(),
            )?;
            if let Some((from, to)) = window {
                crate::ingest::quality_phys::post_write(tx, &app, source_id, from, to)?;
                crate::ingest::quality_bio::post_write(tx, source_id, from, to)?;
            }
            Ok((run_id, status, rows_written, rows_skipped, window))
        })
        .await?;
    (outcome.fetch_run_id, outcome.status, outcome.rows_written, outcome.rows_skipped, outcome.window) = written;

    // 8. ack only after the commit.
    let ack = source.ack(&FetchCtx { state, cursor }, &raw).await;

    // 9. cursor.
    if let Some(next) = raw.next_cursor.clone() {
        let (c, at) = (next.clone(), state.now_ms());
        state
            .obs
            .write(move |tx| {
                tx.execute(
                    "insert into cursors (source_id, cursor, updated_at) values (?1, ?2, ?3)
                     on conflict(source_id) do update set cursor = excluded.cursor, updated_at = excluded.updated_at",
                    params![source_id, c, at],
                )
            })
            .await?;
        outcome.cursor = Some(next);
    }

    // 10. tell the frame builder.
    if let Some((from, to)) = outcome.window {
        state.hub.publish(Event::RowsWritten { from, to });
    }

    ack.with_context(|| format!("{source_id}: ack after commit (rows are committed; redelivery is idempotent)"))?;
    Ok(outcome)
}

#[allow(clippy::too_many_arguments)]
fn insert_fetch_run(
    tx: &Transaction,
    source_id: &str,
    (fetched_at, received_at): (i64, i64),
    status: RunStatus,
    http_status: Option<u16>,
    rows_in: i64,
    raw_object_id: Option<i64>,
    error: Option<&str>,
) -> rusqlite::Result<i64> {
    tx.prepare_cached(
        "insert into fetch_runs (source_id, fetched_at, received_at, status, http_status, rows_in, raw_object_id, error)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?
    .execute(params![source_id, fetched_at, received_at, status.as_str(), http_status, rows_in, raw_object_id, error])?;
    Ok(tx.last_insert_rowid())
}


fn valid_coord(lat: f64, lon: f64) -> bool {
    lat.is_finite() && lon.is_finite() && (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon)
}

/// Plausible range of a river value, so a feed glitch (a sentinel that slipped through, a
/// transposed unit) is skipped and counted instead of stored. Stage in feet may run slightly
/// negative (tidal and datum offsets, Morgan City); discharge may be negative in a tidal reach.
/// Wide on purpose: the record Mississippi crest at Baton Rouge is 47.3 ft, the record flow 1.5 M cfs.
pub fn plausible_stage_ft(v: f64) -> bool {
    v.is_finite() && (-50.0..=200.0).contains(&v)
}

pub fn plausible_flow_kcfs(v: f64) -> bool {
    v.is_finite() && (-500.0..=5000.0).contains(&v)
}

/// The same bounds for a stored reading: `stage_m` in metres, `discharge_cfs` in cfs; every
/// other parameter passes (their adapters apply the product's own valid range).
pub fn plausible_reading(param: Param, value: Option<f64>) -> bool {
    match (param, value) {
        (Param::StageM, Some(v)) => plausible_stage_ft(v / crate::ingest::poll::physical::FEET_TO_M),
        (Param::DischargeCfs, Some(v)) => plausible_flow_kcfs(v / 1000.0),
        _ => true,
    }
}

/// Upserts rows inside one transaction, resolving taxon and station refs with per-transaction
/// caches. Every upsert only touches the row when a value differs, so `written` counts real
/// changes and an identical payload writes nothing. Sightings and stations outside every region
/// of the app are skipped (counted in `skipped`), so an adapter that still queries another area
/// never leaks rows into this app's database (PLAN.md P4 scope guard).
struct RowWriter<'t, 'c> {
    tx: &'t Transaction<'c>,
    app: &'t App,
    source_id: &'static str,
    raw_object_id: i64,
    now: i64,
    taxa: HashMap<String, i64>,
    /// ext_id to (id, the ref last written), so repeated refs skip the upsert unless they differ.
    stations: HashMap<String, (i64, StationRef)>,
    written: usize,
    skipped: usize,
    window: Option<(i64, i64)>,
}

impl<'t, 'c> RowWriter<'t, 'c> {
    fn new(tx: &'t Transaction<'c>, app: &'t App, source_id: &'static str, raw_object_id: i64, now: i64) -> Self {
        RowWriter {
            tx,
            app,
            source_id,
            raw_object_id,
            now,
            taxa: HashMap::new(),
            stations: HashMap::new(),
            written: 0,
            skipped: 0,
            window: None,
        }
    }

    fn widen(&mut self, at: i64) {
        self.window = Some(match self.window {
            Some((from, to)) => (from.min(at), to.max(at)),
            None => (at, at),
        });
    }

    fn write(&mut self, row: &Row) -> rusqlite::Result<()> {
        let changed = match row {
            Row::Sighting(s) => self.sighting(s)?,
            Row::Reading(r) => self.reading(r)?,
            Row::Alert(a) => self.alert(a)?,
            Row::Station(s) => self.station(s)?.map(|(_, changed)| changed),
            Row::Revision(r) => self.revision(r)?,
            Row::Forecast(f) => self.forecast(f)?,
            Row::ForecastSnapshot(s) => self.forecast_snapshot(s)?,
            Row::ForecastObservations(o) => self.forecast_observations(o)?,
            Row::Thresholds(t) => self.thresholds(t)?,
            Row::SiteAlerts(a) => self.site_alerts(a)?,
            // Scope guard: a position outside the app's regions is skipped.
            Row::VesselPosition(p) => match self.app.region_of(p.lat, p.lon) {
                Some(_) => Some(crate::vessels::write_position(self.tx, p, self.raw_object_id)?),
                None => None,
            },
            Row::VesselStatic(s) => Some(crate::vessels::write_static(self.tx, s, self.raw_object_id)?),
        };
        match changed {
            None => self.skipped += 1,
            Some(true) => self.written += 1,
            Some(false) => {}
        }
        Ok(())
    }

    /// A forecast-store row names a site by NWPS lid; only the app's configured locations are
    /// written (scope guard, PLAN.md P4), the rest are skipped and counted.
    fn site_ok(&self, site: &str) -> bool {
        !site.is_empty() && self.app.cfg.locations.iter().any(|l| l.nwps.as_deref() == Some(site))
    }

    /// A reading of a conditions app must come from a configured gauge (`locations[].usgs`, or a river
    /// station the usgs feed lists under `extraSites`; the ext_id may carry a `:sensor` suffix). Species
    /// apps keep every station in their regions.
    fn gauge_ok(&self, station: &StationRef) -> bool {
        if self.app.is_species() || !matches!(station.kind, crate::model::StationKind::Gage) {
            return true;
        }
        let site = station.ext_id.split(':').next().unwrap_or_default();
        self.app.cfg.locations.iter().any(|l| l.usgs.as_deref() == Some(site))
            || self
                .app
                .cfg
                .feed(crate::ingest::poll::usgs::SOURCE_ID)
                .and_then(|f| f.params.get("extraSites"))
                .and_then(|v| v.as_array())
                .is_some_and(|extra| extra.iter().any(|e| e["id"].as_str() == Some(site)))
    }

    fn forecast_snapshot(&mut self, s: &NewSnapshot) -> rusqlite::Result<Option<bool>> {
        if !self.site_ok(&s.site) || s.payload_hash.is_empty() {
            return Ok(None);
        }
        let mut snap = s.clone();
        snap.points.retain(|p| p.stage_ft.is_none_or(plausible_stage_ft) && p.flow_kcfs.is_none_or(plausible_flow_kcfs));
        self.skipped += s.points.len() - snap.points.len();
        let thresholds = forecast_store::newest_thresholds(self.tx, &snap.site)?.unwrap_or_default();
        let inserted = forecast_store::insert_snapshot(self.tx, &snap, &thresholds)?;
        if !matches!(inserted, Inserted::Duplicate { .. }) {
            self.widen(snap.issued_at);
        }
        Ok(Some(!matches!(inserted, Inserted::Duplicate { .. })))
    }

    fn forecast_observations(&mut self, o: &ForecastObservationsRow) -> rusqlite::Result<Option<bool>> {
        if !self.site_ok(&o.site) {
            return Ok(None);
        }
        let keep: Vec<_> = o
            .observations
            .iter()
            .copied()
            .filter(|v| v.stage_ft.is_none_or(plausible_stage_ft) && v.flow_kcfs.is_none_or(plausible_flow_kcfs))
            .collect();
        self.skipped += o.observations.len() - keep.len();
        let n = forecast_store::insert_observations(self.tx, &o.site, o.source, self.now, &keep)?;
        if n > 0 {
            if let Some(t) = keep.iter().map(|v| v.observed_at).max() {
                self.widen(t);
            }
        }
        Ok(Some(n > 0))
    }

    fn thresholds(&mut self, t: &ThresholdsRow) -> rusqlite::Result<Option<bool>> {
        if !self.site_ok(&t.site) {
            return Ok(None);
        }
        Ok(Some(forecast_store::upsert_thresholds(self.tx, &t.site, self.now, &t.thresholds)?))
    }

    fn site_alerts(&mut self, a: &SiteAlertsRow) -> rusqlite::Result<Option<bool>> {
        if !self.site_ok(&a.site) {
            return Ok(None);
        }
        let r = forecast_store::record_alerts(self.tx, &a.site, a.seen_at, &a.alerts)?;
        Ok(Some(r.new > 0 || r.ended > 0))
    }

    fn taxon(&mut self, t: &TaxonRef) -> rusqlite::Result<Option<i64>> {
        let name = t.scientific_name.trim();
        if name.is_empty() {
            return Ok(None);
        }
        if let Some(id) = self.taxa.get(name) {
            return Ok(Some(*id));
        }
        // The iNat id comes from the iNat adapter only; a GBIF or NAS ref never clears it, and the
        // first adapter to know it fills it in on an existing row.
        self.tx
            .prepare_cached(
                "insert into taxa (scientific_name, common_name, focus, inat_taxon_id) values (?1, ?2, 0, ?3)
                 on conflict(scientific_name) do update set
                   inat_taxon_id = coalesce(taxa.inat_taxon_id, excluded.inat_taxon_id),
                   common_name = case when taxa.common_name = '' then excluded.common_name else taxa.common_name end
                 where taxa.inat_taxon_id is null and excluded.inat_taxon_id is not null
                    or taxa.common_name = '' and excluded.common_name <> ''",
            )?
            .execute(params![name, t.common_name.trim(), t.inat_taxon_id])?;
        let id: i64 =
            self.tx.prepare_cached("select id from taxa where scientific_name = ?1")?.query_row([name], |r| r.get(0))?;
        self.taxa.insert(name.to_string(), id);
        Ok(Some(id))
    }

    /// Returns `(station id, changed)`, or `None` when the ref is invalid or outside the app.
    fn station(&mut self, s: &StationRef) -> rusqlite::Result<Option<(i64, bool)>> {
        if s.ext_id.is_empty() || !valid_coord(s.lat, s.lon) || self.app.region_of(s.lat, s.lon).is_none() {
            return Ok(None);
        }
        if let Some((id, _)) = self.stations.get(&s.ext_id).filter(|(_, seen)| seen == s) {
            return Ok(Some((*id, false)));
        }
        let n = self
            .tx
            .prepare_cached(
                "insert into stations (source_id, ext_id, name, lat, lon, kind) values (?1, ?2, ?3, ?4, ?5, ?6)
                 on conflict(source_id, ext_id) do update set name = excluded.name, lat = excluded.lat,
                   lon = excluded.lon, kind = excluded.kind
                 where stations.name is not excluded.name or stations.lat is not excluded.lat
                   or stations.lon is not excluded.lon or stations.kind is not excluded.kind",
            )?
            .execute(params![self.source_id, s.ext_id, s.name, s.lat, s.lon, s.kind.as_str()])?;
        let id: i64 = self
            .tx
            .prepare_cached("select id from stations where source_id = ?1 and ext_id = ?2")?
            .query_row(params![self.source_id, s.ext_id], |r| r.get(0))?;
        self.stations.insert(s.ext_id.clone(), (id, s.clone()));
        Ok(Some((id, n > 0)))
    }

    fn sighting(&mut self, s: &SightingRow) -> rusqlite::Result<Option<bool>> {
        if s.ext_id.is_empty() || !valid_coord(s.lat, s.lon) || self.app.region_of(s.lat, s.lon).is_none() {
            return Ok(None);
        }
        // R14: an app stores its own species only. Another taxon is written only over a sighting
        // already stored, so an ID flip away from the species is kept (and flagged), never lost.
        let name = s.taxon.scientific_name.trim();
        if !self.app.taxa.iter().any(|t| t.cfg.scientific_name == name) {
            let stored: bool = self
                .tx
                .prepare_cached("select exists(select 1 from sightings where source_id = ?1 and ext_id = ?2)")?
                .query_row(params![self.source_id, s.ext_id], |r| r.get(0))?;
            if !stored {
                return Ok(None);
            }
        }
        let Some(taxon_id) = self.taxon(&s.taxon)? else { return Ok(None) };
        let n = self
            .tx
            .prepare_cached(
                // `submitted_at` is set once known and never cleared by a source that lacks it.
                "insert into sightings (source_id, ext_id, taxon_id, lat, lon, accuracy_m, observed_at, quality,
                   photo_url, raw_object_id, ingested_at, submitted_at)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 on conflict(source_id, ext_id) do update set taxon_id = excluded.taxon_id, lat = excluded.lat,
                   lon = excluded.lon, accuracy_m = excluded.accuracy_m, observed_at = excluded.observed_at,
                   quality = excluded.quality, photo_url = excluded.photo_url,
                   raw_object_id = excluded.raw_object_id, ingested_at = excluded.ingested_at,
                   submitted_at = coalesce(excluded.submitted_at, sightings.submitted_at)
                 where sightings.taxon_id is not excluded.taxon_id or sightings.lat is not excluded.lat
                   or sightings.lon is not excluded.lon or sightings.accuracy_m is not excluded.accuracy_m
                   or sightings.observed_at is not excluded.observed_at or sightings.quality is not excluded.quality
                   or sightings.photo_url is not excluded.photo_url
                   or (excluded.submitted_at is not null and sightings.submitted_at is not excluded.submitted_at)",
            )?
            .execute(params![
                self.source_id,
                s.ext_id,
                taxon_id,
                s.lat,
                s.lon,
                s.accuracy_m.filter(|a| a.is_finite()),
                s.observed_at,
                s.quality.as_str(),
                s.photo_url,
                self.raw_object_id,
                self.now,
                s.submitted_at
            ])?;
        if n > 0 {
            self.widen(s.observed_at);
        }
        Ok(Some(n > 0))
    }

    /// A forecast value with its run (`marine_forecasts`). One run's value at a valid time is
    /// written once; a later run is a new row, so every issued forecast stays replayable.
    fn forecast(&mut self, f: &ForecastRow) -> rusqlite::Result<Option<bool>> {
        let Some((station_id, station_changed)) = self.station(&f.station)? else { return Ok(None) };
        if station_changed {
            self.written += 1;
        }
        let n = self
            .tx
            .prepare_cached(
                "insert into marine_forecasts (station_id, param, issued_at, valid_at, value, unit, source_unit, model, raw_object_id)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 on conflict(station_id, param, issued_at, valid_at) do update set value = excluded.value,
                   unit = excluded.unit, source_unit = excluded.source_unit, model = excluded.model,
                   raw_object_id = excluded.raw_object_id
                 where marine_forecasts.value is not excluded.value or marine_forecasts.unit is not excluded.unit
                   or marine_forecasts.source_unit is not excluded.source_unit or marine_forecasts.model is not excluded.model",
            )?
            .execute(params![
                station_id,
                f.param.as_str(),
                f.issued_at,
                f.valid_at,
                f.value.filter(|v| v.is_finite()),
                f.unit,
                f.source_unit,
                f.model,
                self.raw_object_id
            ])?;
        Ok(Some(n > 0))
    }

    fn reading(&mut self, r: &ReadingRow) -> rusqlite::Result<Option<bool>> {
        if !self.gauge_ok(&r.station) || !plausible_reading(r.param, r.value) {
            return Ok(None);
        }
        let Some((station_id, station_changed)) = self.station(&r.station)? else { return Ok(None) };
        if station_changed {
            self.written += 1;
        }
        let n = self
            .tx
            .prepare_cached(
                // Precedence on the (station, param, observed_at, origin) key: a null never replaces a
                // value; between nulls cloud beats bad_dqf beats missing; between values the newer wins.
                "insert into readings (station_id, param, value, flag, observed_at, origin, raw_object_id)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 on conflict(station_id, param, observed_at, origin) do update set value = excluded.value,
                   flag = excluded.flag, raw_object_id = excluded.raw_object_id
                 where (excluded.value is not null
                        and (readings.value is not excluded.value or readings.flag is not excluded.flag))
                    or (excluded.value is null and readings.value is null
                        and (case excluded.flag when 'cloud' then 3 when 'bad_dqf' then 2 when 'missing' then 1 else 0 end)
                          > (case readings.flag when 'cloud' then 3 when 'bad_dqf' then 2 when 'missing' then 1 else 0 end))",
            )?
            .execute(params![
                station_id,
                r.param.as_str(),
                r.value.filter(|v| v.is_finite()),
                r.flag.as_str(),
                r.observed_at,
                r.origin.as_str(),
                self.raw_object_id
            ])?;
        if n > 0 {
            self.widen(r.observed_at);
        }
        Ok(Some(n > 0))
    }

    fn alert(&mut self, a: &AlertRow) -> rusqlite::Result<Option<bool>> {
        if a.ext_id.is_empty() {
            return Ok(None);
        }
        let area = a.area_geojson.as_ref().map(|v| v.to_string());
        let n = self
            .tx
            .prepare_cached(
                "insert into alerts (source_id, ext_id, event, severity, headline, area_geojson, onset, expires, raw_object_id)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 on conflict(ext_id) do update set event = excluded.event, severity = excluded.severity,
                   headline = excluded.headline, area_geojson = excluded.area_geojson, onset = excluded.onset,
                   expires = excluded.expires, raw_object_id = excluded.raw_object_id
                 where alerts.event is not excluded.event or alerts.severity is not excluded.severity
                   or alerts.headline is not excluded.headline or alerts.area_geojson is not excluded.area_geojson
                   or alerts.onset is not excluded.onset or alerts.expires is not excluded.expires",
            )?
            .execute(params![
                self.source_id,
                a.ext_id,
                a.event,
                a.severity,
                a.headline,
                area,
                a.onset,
                a.expires,
                self.raw_object_id
            ])?;
        Ok(Some(n > 0))
    }

    fn revision(&mut self, r: &RevisionRow) -> rusqlite::Result<Option<bool>> {
        let sighting_id: Option<i64> = self
            .tx
            .prepare_cached("select id from sightings where source_id = ?1 and ext_id = ?2")?
            .query_row(params![self.source_id, r.sighting_ext_id], |row| row.get(0))
            .optional()?;
        let Some(sighting_id) = sighting_id else { return Ok(None) };
        let n = self
            .tx
            .prepare_cached(
                "insert into sighting_revisions (sighting_id, changed_at, field, old, new)
                 select ?1, ?2, ?3, ?4, ?5
                 where not exists (select 1 from sighting_revisions
                   where sighting_id = ?1 and changed_at = ?2 and field = ?3 and old is ?4 and new is ?5)",
            )?
            .execute(params![sighting_id, r.changed_at, r.field, r.old, r.new])?;
        Ok(Some(n > 0))
    }
}

/// A test source whose body is a JSON array of `model::Row`, for pipeline tests that need rows
/// no real adapter emits.
#[cfg(test)]
pub mod testing {
    use std::time::Duration;

    use async_trait::async_trait;

    use crate::ingest::source::{FetchCtx, Mode, RawPayload, Source, SourceInfo};
    use crate::model::Row;

    pub struct RowsSource(pub &'static str);

    #[async_trait]
    impl Source for RowsSource {
        fn info(&self) -> SourceInfo {
            SourceInfo {
                id: self.0,
                name: "Test rows",
                homepage: "https://example.test",
                mode: Mode::Push,
                cadence: Duration::from_secs(60),
                max_latency: Duration::from_secs(600),
            }
        }
        async fn fetch(&self, _ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
            Ok(vec![])
        }
        fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
            Ok(serde_json::from_slice(&raw.bytes)?)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read as _;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::*;
    use crate::app::test_support::test_state;
    use crate::archive::Archive;
    use crate::ingest::governor::HttpStatusError;
    use crate::ingest::source::Mode;
    use crate::model::*;

    /// Test source: `normalize` parses a JSON array of rows; `ack` records how many sightings
    /// were visible in the database at ack time, proving it ran after the commit.
    struct FakeSource {
        id: &'static str,
        acks: Mutex<Vec<(Option<String>, i64)>>,
    }

    impl FakeSource {
        fn new(id: &'static str) -> Self {
            FakeSource { id, acks: Mutex::new(Vec::new()) }
        }
    }

    #[async_trait]
    impl Source for FakeSource {
        fn info(&self) -> SourceInfo {
            SourceInfo {
                id: self.id,
                name: "Fake",
                homepage: "https://example.test",
                mode: Mode::Push,
                cadence: Duration::from_secs(60),
                max_latency: Duration::from_secs(600),
            }
        }
        async fn fetch(&self, _ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
            Ok(vec![])
        }
        fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
            Ok(serde_json::from_slice(&raw.bytes)?)
        }
        async fn ack(&self, ctx: &FetchCtx<'_>, raw: &RawPayload) -> anyhow::Result<()> {
            let n: i64 = ctx.state.obs.read(|c| c.query_row("select count(*) from sightings", [], |r| r.get(0))).await?;
            self.acks.lock().unwrap().push((raw.ack.clone(), n));
            Ok(())
        }
    }

    fn station() -> StationRef {
        StationRef { ext_id: "VAKF1".into(), name: "Virginia Key".into(), lat: 25.73, lon: -80.16, kind: StationKind::Buoy }
    }

    fn rows() -> Vec<Row> {
        vec![
            Row::Sighting(SightingRow {
                ext_id: "obs-1".into(),
                taxon: TaxonRef::named("Python bivittatus", "Burmese python"),
                lat: 25.4,
                lon: -80.6,
                accuracy_m: Some(12.0),
                observed_at: 1_790_000_000_000,
                submitted_at: None,
                quality: Quality::Research,
                photo_url: Some("https://example.test/p.jpg".into()),
            }),
            Row::Sighting(SightingRow {
                ext_id: "obs-2".into(),
                taxon: TaxonRef {
                    scientific_name: "Python bivittatus".into(),
                    common_name: "Burmese python".into(),
                    inat_taxon_id: Some(238252),
                },
                lat: 25.7,
                lon: -80.3,
                accuracy_m: None,
                observed_at: 1_790_000_600_000,
                submitted_at: Some(1_790_100_000_000),
                quality: Quality::NeedsId,
                photo_url: None,
            }),
            Row::Station(station()),
            Row::Reading(ReadingRow {
                station: station(),
                param: Param::WaterC,
                value: Some(29.5),
                flag: Flag::Ok,
                observed_at: 1_789_999_000_000,
                origin: Origin::Measured,
            }),
            Row::Reading(ReadingRow {
                station: station(),
                param: Param::AirC,
                value: None,
                flag: Flag::Missing,
                observed_at: 1_789_999_000_000,
                origin: Origin::Measured,
            }),
            Row::Alert(AlertRow {
                ext_id: "urn:oid:2.49.0.1.840.0.abc".into(),
                event: "Heat Advisory".into(),
                severity: "Moderate".into(),
                headline: Some("Heat Advisory until 7 PM".into()),
                area_geojson: Some(serde_json::json!({"type": "Point", "coordinates": [-80.2, 25.8]})),
                onset: Some(1_790_000_000_000),
                expires: Some(1_790_030_000_000),
            }),
            Row::Revision(RevisionRow {
                sighting_ext_id: "obs-1".into(),
                field: "quality".into(),
                old: Some("needs_id".into()),
                new: Some("research".into()),
                changed_at: 1_790_000_100_000,
            }),
        ]
    }

    fn payload(rows: &[Row], cursor: Option<&str>) -> RawPayload {
        RawPayload {
            source_url: "https://example.test/feed".into(),
            content_type: "application/json".into(),
            bytes: serde_json::to_vec(rows).unwrap(),
            http_status: Some(200),
            fetched_at: 1_790_000_700_000,
            next_cursor: cursor.map(String::from),
            ack: Some("receipt-1".into()),
        }
    }

    async fn count(state: &AppState, table: &'static str) -> i64 {
        state.obs.read(move |c| c.query_row(&format!("select count(*) from {table}"), [], |r| r.get(0))).await.unwrap()
    }

    async fn counts(state: &AppState) -> Vec<i64> {
        let mut out = Vec::new();
        for t in ["sightings", "taxa", "stations", "readings", "alerts", "sighting_revisions"] {
            out.push(count(state, t).await);
        }
        out
    }

    #[tokio::test]
    async fn pipeline_writes_archives_acks_and_is_idempotent() {
        let state = test_state();
        let mut events = state.hub.subscribe();
        let src = FakeSource::new("fake");
        let rows = rows();
        let raw = payload(&rows, Some("cursor-1"));

        let out = ingest_payload(&state, &src, raw.clone(), None).await.unwrap();
        assert_eq!(out.status, RunStatus::Ok, "{out:?}");
        assert_eq!(out.rows_in, 7);
        assert_eq!(out.rows_skipped, 0);
        // 2 sightings + station + 2 readings + alert + revision.
        assert_eq!(out.rows_written, 7);
        assert_eq!(out.window, Some((1_789_999_000_000, 1_790_000_600_000)));
        assert_eq!(out.cursor.as_deref(), Some("cursor-1"));
        // sightings, taxa (the app's one species), stations, readings, alerts, revisions
        assert_eq!(counts(&state).await, vec![2, 1, 1, 2, 1, 1]);

        // Both refs resolve to the seeded focus row, with or without an iNat id.
        let taxa: Vec<(i64, i64)> = state
            .obs
            .read(|c| {
                let mut st = c.prepare("select s.taxon_id, t.focus from sightings s join taxa t on t.id = s.taxon_id order by s.ext_id")?;
                let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await
            .unwrap();
        assert_eq!(taxa, [(1, 1), (1, 1)]);

        // fetch_run recorded against the raw object.
        let run: (String, i64, Option<i64>, Option<i64>) = state
            .obs
            .read(move |c| {
                c.query_row(
                    "select status, rows_in, raw_object_id, http_status from fetch_runs where id = ?1",
                    [out.fetch_run_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
            })
            .await
            .unwrap();
        assert_eq!(run, ("ok".to_string(), 7, Some(out.raw_object_id), Some(200)));

        // Raw object archived gzip under raw/{source}/{yyyy}/{mm}/{dd}/ (fetched_at 2026-09-21).
        let (key, bytes_len, sha): (String, i64, String) = state
            .obs
            .read(|c| c.query_row("select r2_key, bytes, sha256 from raw_objects", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))))
            .await
            .unwrap();
        assert_eq!(key, out.r2_key);
        assert!(key.starts_with("raw/fake/2026/09/21/") && key.ends_with(".json.gz"), "{key}");
        let stored = state.archive.get(&key).await.unwrap();
        assert_eq!(&stored[..2], &[0x1f, 0x8b], "gzip magic");
        let mut plain = Vec::new();
        flate2::read::GzDecoder::new(&stored[..]).read_to_end(&mut plain).unwrap();
        assert_eq!(plain, raw.bytes);
        assert_eq!(bytes_len, raw.bytes.len() as i64);
        assert_eq!(sha, hex::encode(Sha256::digest(&raw.bytes)));

        // Ack ran once, after commit (both sightings visible), with the payload's receipt.
        assert_eq!(*src.acks.lock().unwrap(), vec![(Some("receipt-1".to_string()), 2)]);
        let cursor: String = state
            .obs
            .read(|c| c.query_row("select cursor from cursors where source_id = 'fake'", [], |r| r.get(0)))
            .await
            .unwrap();
        assert_eq!(cursor, "cursor-1");
        match events.try_recv().unwrap() {
            Event::RowsWritten { from, to } => assert_eq!((from, to), (1_789_999_000_000, 1_790_000_600_000)),
            other => panic!("unexpected event {other:?}"),
        }

        // Re-run of the same payload: 0 rows, no new raw object, no RowsWritten.
        let again = ingest_payload(&state, &src, raw.clone(), Some("cursor-1".into())).await.unwrap();
        assert_eq!(again.rows_written, 0, "{again:?}");
        assert_eq!(again.window, None);
        assert_eq!(again.raw_object_id, out.raw_object_id);
        assert_eq!(counts(&state).await, vec![2, 1, 1, 2, 1, 1]);
        assert_eq!(count(&state, "raw_objects").await, 1);
        assert_eq!(count(&state, "fetch_runs").await, 2);
        assert!(events.try_recv().is_err());
        assert_eq!(src.acks.lock().unwrap().len(), 2);

        // A changed value is an update, not a new row, and widens the window to that reading.
        let mut changed = rows.clone();
        if let Row::Reading(r) = &mut changed[3] {
            r.value = Some(30.1);
        }
        let third = ingest_payload(&state, &src, payload(&changed, None), None).await.unwrap();
        assert_eq!(third.rows_written, 1);
        assert_eq!(third.window, Some((1_789_999_000_000, 1_789_999_000_000)));
        assert_eq!(count(&state, "readings").await, 2);
        assert_eq!(count(&state, "raw_objects").await, 2);
        let v: f64 = state
            .obs
            .read(|c| c.query_row("select value from readings where param = 'water_c'", [], |r| r.get(0)))
            .await
            .unwrap();
        assert_eq!(v, 30.1);
    }

    #[tokio::test]
    async fn pipeline_empty_payload_records_empty() {
        let state = test_state();
        let src = FakeSource::new("fake-empty");
        let out = ingest_payload(&state, &src, payload(&[], None), None).await.unwrap();
        assert_eq!(out.status, RunStatus::Empty);
        assert_eq!((out.rows_in, out.rows_written), (0, 0));
        let status: String = state
            .obs
            .read(|c| c.query_row("select status from fetch_runs where source_id = 'fake-empty'", [], |r| r.get(0)))
            .await
            .unwrap();
        assert_eq!(status, "empty");
    }

    #[tokio::test]
    async fn pipeline_normalize_error_records_error_and_skips_ack() {
        let state = test_state();
        let src = FakeSource::new("fake-bad");
        let mut raw = payload(&[], Some("never"));
        raw.bytes = b"{not json".to_vec();
        let out = ingest_payload(&state, &src, raw, None).await.unwrap();
        assert_eq!(out.status, RunStatus::Error);
        let (status, error, raw_id): (String, String, Option<i64>) = state
            .obs
            .read(|c| {
                c.query_row("select status, error, raw_object_id from fetch_runs where source_id = 'fake-bad'", [], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })
            })
            .await
            .unwrap();
        assert_eq!(status, "error");
        assert!(error.starts_with("normalize:"), "{error}");
        assert_eq!(raw_id, Some(out.raw_object_id), "bad payload is still archived for replay");
        assert!(src.acks.lock().unwrap().is_empty());
        assert_eq!(count(&state, "cursors").await, 0);
    }

    #[tokio::test]
    async fn pipeline_skips_invalid_rows_as_partial() {
        let state = test_state();
        let src = FakeSource::new("fake-partial");
        let mut rows = rows();
        if let Row::Sighting(s) = &mut rows[1] {
            s.lat = 123.0;
        }
        rows.push(Row::Revision(RevisionRow {
            sighting_ext_id: "unknown".into(),
            field: "quality".into(),
            old: None,
            new: None,
            changed_at: 0,
        }));
        // Outside every region of the app (P4): a Kansas gauge and a Louisiana python.
        rows.push(Row::Station(StationRef { ext_id: "KS1".into(), name: "Kansas".into(), lat: 39.0, lon: -98.0, kind: StationKind::Gage }));
        rows.push(Row::Sighting(SightingRow {
            ext_id: "obs-la".into(),
            taxon: TaxonRef::named("Python bivittatus", "Burmese python"),
            lat: 30.4,
            lon: -91.2,
            accuracy_m: None,
            observed_at: 1_790_000_000_000,
            submitted_at: None,
            quality: Quality::Research,
            photo_url: None,
        }));
        let out = ingest_payload(&state, &src, payload(&rows, None), None).await.unwrap();
        assert_eq!(out.status, RunStatus::Partial);
        assert_eq!(out.rows_skipped, 4);
        assert_eq!(count(&state, "sightings").await, 1);
        assert_eq!(count(&state, "stations").await, 1);
        let error: String = state
            .obs
            .read(|c| c.query_row("select error from fetch_runs where status = 'partial'", [], |r| r.get(0)))
            .await
            .unwrap();
        assert_eq!(error, "4 of 10 rows skipped");
    }

    #[tokio::test]
    async fn pipeline_station_ref_changes_within_payload_are_written() {
        let state = test_state();
        let src = FakeSource::new("fake-station");
        let mut moved = station();
        moved.name = "Virginia Key (relocated)".into();
        moved.lat = 25.74;
        let out = ingest_payload(&state, &src, payload(&[Row::Station(station()), Row::Station(moved)], None), None)
            .await
            .unwrap();
        assert_eq!(out.rows_written, 2);
        let (name, lat): (String, f64) = state
            .obs
            .read(|c| c.query_row("select name, lat from stations where ext_id = 'VAKF1'", [], |r| Ok((r.get(0)?, r.get(1)?))))
            .await
            .unwrap();
        assert_eq!((name.as_str(), lat), ("Virginia Key (relocated)", 25.74));
    }

    // ---------------------------------------------------------------------------------------
    // Supervision
    // ---------------------------------------------------------------------------------------

    struct FailingArchive;

    #[async_trait]
    impl Archive for FailingArchive {
        async fn put(&self, key: &str, _bytes: Vec<u8>, _ct: &str) -> anyhow::Result<()> {
            anyhow::bail!("archive offline: {key}")
        }
        async fn get(&self, key: &str) -> anyhow::Result<Vec<u8>> {
            anyhow::bail!("archive offline: {key}")
        }
    }

    enum Behaviour {
        Panic,
        /// Returns a payload; the archive fails, so the pipeline errors.
        PipelineError,
        Healthy,
        Http503,
    }

    struct ScriptedSource {
        id: &'static str,
        behaviour: Behaviour,
        interval: Duration,
        calls: AtomicUsize,
        at: Mutex<Vec<Instant>>,
    }

    impl ScriptedSource {
        fn new(id: &'static str, behaviour: Behaviour, interval: Duration) -> Arc<Self> {
            Arc::new(ScriptedSource { id, behaviour, interval, calls: AtomicUsize::new(0), at: Mutex::new(Vec::new()) })
        }
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl Source for ScriptedSource {
        fn info(&self) -> SourceInfo {
            SourceInfo {
                id: self.id,
                name: "Scripted",
                homepage: "https://example.test",
                mode: Mode::Poll,
                cadence: self.interval,
                max_latency: Duration::from_secs(60),
            }
        }
        async fn fetch(&self, _ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.at.lock().unwrap().push(Instant::now());
            match self.behaviour {
                Behaviour::Panic => panic!("scripted panic in {}", self.id),
                Behaviour::PipelineError => Ok(vec![payload(&[], None)]),
                Behaviour::Healthy => Ok(vec![]),
                Behaviour::Http503 => Err(HttpStatusError {
                    status: 503,
                    retry_after: Some(Duration::from_secs(3600)),
                    url: "https://example.test/down".into(),
                }
                .into()),
            }
        }
        fn normalize(&self, _raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
            Ok(vec![])
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn supervisor_restarts_failing_sources_with_backoff_and_isolates_them() {
        let mut state = test_state();
        state.archive = Arc::new(FailingArchive);
        let ms = Duration::from_millis;
        let panicker = ScriptedSource::new("sup-panic", Behaviour::Panic, ms(1));
        let erroring = ScriptedSource::new("sup-error", Behaviour::PipelineError, ms(1));
        let healthy = ScriptedSource::new("sup-healthy", Behaviour::Healthy, ms(10));
        let sup = Supervision { initial: ms(40), max: ms(160), healthy_after: Duration::from_secs(60) };
        let handles = spawn_sources(
            &state,
            vec![panicker.clone() as Arc<dyn Source>, erroring.clone(), healthy.clone()],
            sup,
        );

        tokio::time::sleep(ms(500)).await;
        let healthy_mid = healthy.calls();
        tokio::time::sleep(ms(500)).await;

        // Failing sources were restarted repeatedly...
        assert!(panicker.calls() >= 4, "panicker ran {} times", panicker.calls());
        assert!(erroring.calls() >= 4, "erroring ran {} times", erroring.calls());
        // ...with a doubling delay, capped.
        for src in [&panicker, &erroring] {
            let at = src.at.lock().unwrap().clone();
            let gaps: Vec<Duration> = at.windows(2).map(|w| w[1] - w[0]).collect();
            assert!(gaps[0] >= ms(40) && gaps[1] >= ms(80) && gaps[2] >= ms(160), "{}: {gaps:?}", src.id);
            assert!(gaps.iter().all(|g| *g < ms(400)), "{}: capped at 160ms, got {gaps:?}", src.id);
            assert!(!handles.iter().any(|h| h.is_finished()), "supervisors keep running");
        }
        // ...and the healthy source kept its cadence the whole time.
        assert!(healthy_mid >= 10, "healthy ran {healthy_mid} times in the first half");
        assert!(healthy.calls() >= healthy_mid + 10, "healthy stalled: {} -> {}", healthy_mid, healthy.calls());
        let empties: i64 = state
            .obs
            .read(|c| {
                c.query_row("select count(*) from fetch_runs where source_id = 'sup-healthy' and status = 'empty'", [], |r| {
                    r.get(0)
                })
            })
            .await
            .unwrap();
        assert!(empties >= 20, "healthy empty runs recorded: {empties}");

        for h in handles {
            h.abort();
        }
    }

    #[tokio::test]
    async fn supervisor_fetch_error_is_recorded_and_throttled_by_governor() {
        let state = test_state();
        let down = ScriptedSource::new("sup-http503", Behaviour::Http503, Duration::from_millis(1));
        let handles = spawn_sources(&state, vec![down.clone() as Arc<dyn Source>], Supervision::default());
        tokio::time::sleep(Duration::from_millis(300)).await;
        // Retry-After: 3600 holds the next attempt; one call only, no restart storm.
        assert_eq!(down.calls(), 1);
        let (status, http, error): (String, Option<i64>, String) = state
            .obs
            .read(|c| {
                c.query_row("select status, http_status, error from fetch_runs where source_id = 'sup-http503'", [], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })
            })
            .await
            .unwrap();
        assert_eq!((status.as_str(), http), ("error", Some(503)));
        assert!(error.contains("HTTP 503"), "{error}");
        let note = governor::note("sup-http503").unwrap();
        assert!(note.contains("after HTTP 503") && note.contains("Retry-After until"), "{note}");
        for h in handles {
            h.abort();
        }
    }

    /// C-A1/G6: only the feeds an app's config lists are planned for it. The python app plans
    /// every adapter; Lionfish Watch leaves NWS, USGS and NWWS out and runs CRW (L3) as a webhook
    /// source; a fake config without the iNat feed does not plan iNat.
    #[tokio::test]
    async fn app_scheduler_plans_only_configured_feeds() {
        let python = test_state();
        let p = plan(&python);
        assert_eq!(p.runnable_ids(), ["nws", "usgs", "ndbc", "coops", "openmeteo", "inat", "nas", "gbif"]);
        assert_eq!(p.known_ids(), ["nws", "usgs", "ndbc", "coops", "openmeteo", "inat", "nas", "gbif", "goes19", "nwws"]);

        let lionfish = crate::app::test_support::test_state_for("lionfish");
        let p = plan(&lionfish);
        assert_eq!(p.runnable_ids(), ["ndbc", "openmeteo-marine", "inat", "nas", "gbif", "crw"]);
        assert!(!p.known_ids().contains(&"nws") && !p.known_ids().contains(&"nwws") && !p.known_ids().contains(&"usgs"));
        let crw = p.known.iter().find(|(i, _)| i.id == "crw").expect("crw registered");
        assert_eq!(crw.0.name, "NOAA Coral Reef Watch");
        assert_eq!(crw.0.mode, crate::ingest::source::Mode::Webhook);
        assert_eq!(crw.1.as_deref(), Some("INVERSA_SOURCES=off"), "tests run with sources off");
        assert!(p.known.iter().any(|(i, r)| i.id == "goes19-sst" && r.as_deref().is_some_and(|r| r.contains("GOES_SQS_URL"))));

        let carp = crate::app::test_support::test_state_for("carp");
        let p = plan(&carp);
        assert_eq!(p.runnable_ids(), ["nws-alerts", "usgs", "nwps", "nws-forecast", "iem"]);
        assert_eq!(p.known_ids(), ["nws-alerts", "usgs", "nwps", "nws-forecast", "iem", "nwws", "aisstream"]);
        let nwws = p.known.iter().find(|(i, _)| i.id == "nwws").unwrap();
        assert!(nwws.1.as_deref().unwrap().contains("NWWS_USER"), "registered but down with the reason: {:?}", nwws.1);

        // A config with the iNat feed removed: the fake app never spawns iNat, and `start`
        // registers exactly its feeds.
        let mut v: serde_json::Value = serde_json::from_str(crate::app::config::builtin_json("python").unwrap()).unwrap();
        v["feeds"].as_array_mut().unwrap().retain(|f| f["source"] != "inat" && f["source"] != "goes19");
        let cfg = crate::app::config::AppConfig::parse("fake.json", &v.to_string()).unwrap();
        let fake = AppState::memory(crate::state::Config::for_tests(), crate::app::config::App::new(cfg).unwrap());
        let p = plan(&fake);
        assert_eq!(p.runnable_ids(), ["nws", "usgs", "ndbc", "coops", "openmeteo", "nas", "gbif"]);
        assert!(!p.known_ids().contains(&"goes19"), "a push feed left out is not even registered as disabled");
        start(fake.clone(), Supervision::default()).await.unwrap();
        let registered: Vec<String> = fake
            .obs
            .read(|c| c.prepare("select id from sources order by id")?.query_map([], |r| r.get(0))?.collect())
            .await
            .unwrap();
        assert_eq!(registered, ["coops", "gbif", "nas", "ndbc", "nws", "nwws", "openmeteo", "usgs"]);
        let feeds = crate::feed_state::compute(&fake.obs, crate::state::now_ms()).await.unwrap();
        assert!(feeds.iter().all(|f| f.source != "inat"));
    }

    #[tokio::test]
    async fn supervisor_start_upserts_sources_without_running_them() {
        let state = test_state();
        assert!(!state.config.sources_enabled);
        let handles = start(state.clone(), Supervision::default()).await.unwrap();
        assert!(handles.is_empty());
        let (mode, cadence): (String, i64) = state
            .obs
            .read(|c| c.query_row("select mode, cadence_s from sources where id = 'inat'", [], |r| Ok((r.get(0)?, r.get(1)?))))
            .await
            .unwrap();
        assert_eq!(mode, "poll");
        assert!(cadence > 0);
        // Idempotent at the next boot.
        start(state.clone(), Supervision::default()).await.unwrap();
        let disabled = crate::ingest::push::disabled(&state.config, &state.app);
        assert_eq!(
            disabled.iter().map(|(i, _)| i.id).collect::<Vec<_>>(),
            ["goes19", "nwws"],
            "no GOES or NWWS secrets in tests"
        );
        assert_eq!(
            count(&state, "sources").await,
            crate::ingest::push::all(&state.config, &state.app).len() as i64
                + crate::ingest::poll::all(&state.config, &state.app).len() as i64
                + disabled.len() as i64
        );
        let reasons: Vec<(String, Option<String>)> = state
            .obs
            .read(|c| {
                c.prepare("select id, disabled_reason from sources order by id")?
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect()
            })
            .await
            .unwrap();
        for (id, reason) in &reasons {
            let reason = reason.as_deref().unwrap_or_default();
            match id.as_str() {
                "goes19" => assert_eq!(reason, "GOES_SQS_URL, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY not set"),
                "nwws" => assert!(reason.starts_with("NWWS_USER and NWWS_PASS not set"), "{reason}"),
                _ => assert_eq!(reason, "INVERSA_SOURCES=off", "{id}"),
            }
        }
        let feeds = crate::feed_state::compute(&state.obs, crate::state::now_ms()).await.unwrap();
        assert_eq!(feeds.len(), reasons.len());
        let goes = feeds.iter().find(|f| f.source == "goes19").unwrap();
        assert_eq!(goes.state, crate::feed_state::Health::Down);
        assert!(goes.note.as_deref().unwrap().starts_with("disabled: GOES_SQS_URL"), "{goes:?}");

        // A boot where a source can run clears its reason (not via `start` here: that would
        // spawn the network pollers).
        let runnable: Vec<(&'static str, Option<String>)> = crate::ingest::poll::all(&state.config, &state.app)
            .iter()
            .map(|s| (s.info().id, None))
            .collect();
        set_disabled(&state, runnable).await.unwrap();
        let still: Vec<String> = state
            .obs
            .read(|c| {
                c.prepare("select id from sources where disabled_reason is not null order by id")?
                    .query_map([], |r| r.get(0))?
                    .collect()
            })
            .await
            .unwrap();
        assert_eq!(still, ["goes19", "nwws"]);
    }

    /// Readings upsert precedence on the same (station, param, observed_at, origin) key.
    #[tokio::test]
    async fn readings_upsert_precedence() {
        let state = test_state();
        let src = FakeSource::new("prec");
        let at = 1_790_000_000_000;
        let reading = |param: Param, value: Option<f64>, flag: Flag| {
            Row::Reading(ReadingRow { station: station(), param, value, flag, observed_at: at, origin: Origin::Satellite })
        };
        let ingest = |rows: Vec<Row>, n: u32| {
            let state = state.clone();
            let src = &src;
            async move {
                let mut raw = payload(&rows, None);
                raw.fetched_at += i64::from(n); // distinct raw objects, so nothing is skipped as a replay
                ingest_payload(&state, src, raw, None).await.unwrap().rows_written
            }
        };
        let read = |param: &'static str| {
            let state = state.clone();
            async move {
                state
                    .obs
                    .read(move |c| {
                        c.query_row(
                            "select value, flag from readings r join stations s on s.id = r.station_id
                             where s.ext_id = 'VAKF1' and r.param = ?1",
                            [param],
                            |r| Ok((r.get::<_, Option<f64>>(0)?, r.get::<_, String>(1)?)),
                        )
                    })
                    .await
                    .unwrap()
            }
        };

        // 1. A null never overwrites a value, whatever its flag.
        ingest(vec![reading(Param::LstC, Some(31.5), Flag::Ok)], 1).await;
        assert_eq!(ingest(vec![reading(Param::LstC, None, Flag::Cloud)], 2).await, 0);
        assert_eq!(ingest(vec![reading(Param::LstC, None, Flag::BadDqf)], 3).await, 0);
        assert_eq!(read("lst_c").await, (Some(31.5), "ok".into()));

        // 2. Between nulls: cloud beats bad_dqf beats missing, in either arrival order; equal is a no-op.
        ingest(vec![reading(Param::SstC, None, Flag::Missing)], 4).await;
        assert_eq!(ingest(vec![reading(Param::SstC, None, Flag::BadDqf)], 5).await, 1);
        assert_eq!(read("sst_c").await, (None, "bad_dqf".into()));
        assert_eq!(ingest(vec![reading(Param::SstC, None, Flag::Cloud)], 6).await, 1);
        assert_eq!(ingest(vec![reading(Param::SstC, None, Flag::BadDqf)], 7).await, 0);
        assert_eq!(ingest(vec![reading(Param::SstC, None, Flag::Missing)], 8).await, 0);
        assert_eq!(ingest(vec![reading(Param::SstC, None, Flag::Cloud)], 9).await, 0);
        assert_eq!(read("sst_c").await, (None, "cloud".into()));
        // A value then replaces the flagged null.
        assert_eq!(ingest(vec![reading(Param::SstC, Some(29.0), Flag::Ok)], 10).await, 1);
        assert_eq!(read("sst_c").await, (Some(29.0), "ok".into()));

        // 3. Between values the newer write wins; the same value again changes nothing.
        ingest(vec![reading(Param::FireFrp, Some(12.0), Flag::Ok)], 11).await;
        assert_eq!(ingest(vec![reading(Param::FireFrp, Some(15.0), Flag::Ok)], 12).await, 1);
        assert_eq!(ingest(vec![reading(Param::FireFrp, Some(15.0), Flag::Ok)], 13).await, 0);
        assert_eq!(read("fire_frp").await, (Some(15.0), "ok".into()));
    }
}
