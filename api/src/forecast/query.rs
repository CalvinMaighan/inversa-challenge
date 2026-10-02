//! Read side: as-of views, coverage, site status and forecast verification. Every function takes
//! a read connection (`Db::read`). `t` is the as-of time; nothing stored after what was knowable
//! at `t` is read (see the module doc).

use rusqlite::{params, Connection, OptionalExtension};

use super::store::thresholds_asof;
use super::{Category, Snapshot, Source, StoredObservation, StoredPoint, Thresholds};

pub const HOUR_MS: i64 = 3_600_000;
/// A forecast point pairs with an observation at most this far from its valid time.
pub const PAIR_WINDOW_MS: i64 = 30 * 60_000;
/// Observation freshness bands (docs/evidence/carp-data-proof.md): green <= 2 h, amber <= 6 h.
pub const OBS_FRESH_MS: i64 = 2 * HOUR_MS;
pub const OBS_AGING_MS: i64 = 6 * HOUR_MS;
/// Forecast freshness: NWPS issues once a day; stale after 36 h.
pub const FCST_FRESH_MS: i64 = 24 * HOUR_MS;
pub const FCST_AGING_MS: i64 = 36 * HOUR_MS;
/// Default gauge-vs-forecast disagreement that counts as a conflict.
pub const DEFAULT_CONFLICT_FT: f64 = 1.0;

/// SQL fragment: the row was knowable at `?t` (bind index given). Live rows need
/// `ingested_at <= t`; backfilled rows only their own time, which the caller filters.
fn knowable(t_idx: usize) -> String {
    format!("(source != 'nwps-live' or ingested_at <= ?{t_idx})")
}

const SNAPSHOT_COLUMNS: &str =
    "id, site, product, issued_at, ingested_at, source, payload_hash, revision, valid_from, valid_to, horizon_end";

fn snapshot_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Snapshot> {
    let source: String = r.get(5)?;
    Ok(Snapshot {
        id: r.get(0)?,
        site: r.get(1)?,
        product: r.get(2)?,
        issued_at: r.get(3)?,
        ingested_at: r.get(4)?,
        source: Source::from_db(&source).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, format!("unexpected source {source:?}").into())
        })?,
        payload_hash: r.get(6)?,
        revision: r.get(7)?,
        valid_from: r.get(8)?,
        valid_to: r.get(9)?,
        horizon_end: r.get(10)?,
        points: Vec::new(),
    })
}

fn load_points(conn: &Connection, id: i64) -> rusqlite::Result<Vec<StoredPoint>> {
    let mut st = conn.prepare_cached(
        "select valid_at, stage_ft, flow_kcfs, category from forecast_points where snapshot_id = ?1 order by valid_at",
    )?;
    let rows = st.query_map([id], |r| {
        let cat: Option<String> = r.get(3)?;
        Ok(StoredPoint { valid_at: r.get(0)?, stage_ft: r.get(1)?, flow_kcfs: r.get(2)?, category: cat.as_deref().and_then(Category::from_db) })
    })?;
    rows.collect()
}

fn with_points(conn: &Connection, mut s: Snapshot) -> rusqlite::Result<Snapshot> {
    s.points = load_points(conn, s.id)?;
    Ok(s)
}

/// The NWS gridpoint weather run shares the store (`product = gridpoint`, no stage) but is not a
/// river forecast: the as-of forecast, history, site status, the review engine and coverage skip
/// it; [`weather_run`] reads it.
const RIVER_ONLY: &str = "product != 'gridpoint'";

/// The river forecast known at `t`: greatest `issued_at <= t` among rows knowable at `t`, newest
/// revision of that issuance. None when nothing was known.
pub fn asof(conn: &Connection, site: &str, t: i64) -> rusqlite::Result<Option<Snapshot>> {
    let sql = format!(
        "select {SNAPSHOT_COLUMNS} from forecast_snapshots
         where site = ?1 and issued_at <= ?2 and {RIVER_ONLY} and {}
         order by issued_at desc, revision desc limit 1",
        knowable(2)
    );
    let mut st = conn.prepare_cached(&sql)?;
    let snap = st.query_row(params![site, t], snapshot_row).optional()?;
    snap.map(|s| with_points(conn, s)).transpose()
}

/// The newest NWS gridpoint weather run known at `t` (`product = gridpoint`), without points:
/// its `issued_at` is the office's `updateTime`, `ingested_at` our fetch. None when no run is
/// stored for the site.
pub fn weather_run(conn: &Connection, site: &str, t: i64) -> rusqlite::Result<Option<Snapshot>> {
    let sql = format!(
        "select {SNAPSHOT_COLUMNS} from forecast_snapshots
         where site = ?1 and issued_at <= ?2 and product = 'gridpoint' and {}
         order by issued_at desc, revision desc limit 1",
        knowable(2)
    );
    let mut st = conn.prepare_cached(&sql)?;
    st.query_row(params![site, t], snapshot_row).optional()
}

/// River issuances known at `t`, newest first, at most `limit`; one row per issuance (its newest
/// knowable revision). Points included.
pub fn history(conn: &Connection, site: &str, t: i64, limit: usize) -> rusqlite::Result<Vec<Snapshot>> {
    let sql = format!(
        "select {SNAPSHOT_COLUMNS} from forecast_snapshots s
         where site = ?1 and issued_at <= ?2 and {RIVER_ONLY} and {}
           and revision = (select max(x.revision) from forecast_snapshots x
                           where x.site = s.site and x.product = s.product and x.issued_at = s.issued_at
                             and (x.source != 'nwps-live' or x.ingested_at <= ?2))
         order by issued_at desc, product limit ?3",
        knowable(2)
    );
    let mut st = conn.prepare_cached(&sql)?;
    let snaps = st.query_map(params![site, t, limit as i64], snapshot_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    snaps.into_iter().map(|s| with_points(conn, s)).collect()
}

/// A snapshot by id, with points (for `evidence(id: "forecast:<id>")`, C4).
#[allow(dead_code)]
pub fn by_id(conn: &Connection, id: i64) -> rusqlite::Result<Option<Snapshot>> {
    let mut st = conn.prepare_cached(&format!("select {SNAPSHOT_COLUMNS} from forecast_snapshots where id = ?1"))?;
    st.query_row([id], snapshot_row).optional()?.map(|s| with_points(conn, s)).transpose()
}

/// Where replay can start for a site.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Coverage {
    /// The first `asOf` that returns a forecast: the earliest time any stored snapshot became
    /// knowable (archive rows at their `issued_at`, live rows at the later of `issued_at` and
    /// `ingested_at`).
    pub replay_coverage_start: Option<i64>,
    /// Earliest live capture (`ingested_at` of the first `nwps-live` snapshot): from here on the
    /// store holds what this process saw itself, not an archive's copy.
    pub live_coverage_start: Option<i64>,
    pub snapshots: i64,
}

pub fn coverage(conn: &Connection, site: &str) -> rusqlite::Result<Coverage> {
    conn.query_row(
        &format!(
            "select min(case when source = 'nwps-live' then max(issued_at, ingested_at) else issued_at end),
                    min(case when source = 'nwps-live' then ingested_at end), count(*)
             from forecast_snapshots where site = ?1 and {RIVER_ONLY}"
        ),
        [site],
        |r| Ok(Coverage { replay_coverage_start: r.get(0)?, live_coverage_start: r.get(1)?, snapshots: r.get(2)? }),
    )
}

/// Observations with `observed_at` in `from..=to` that were knowable at `t`, oldest first.
pub fn observations_asof(conn: &Connection, site: &str, from: i64, to: i64, t: i64) -> rusqlite::Result<Vec<StoredObservation>> {
    let sql = format!(
        "select observed_at, stage_ft, flow_kcfs, source, ingested_at from forecast_observations
         where site = ?1 and observed_at between ?2 and ?3 and observed_at <= ?4 and {}
         order by observed_at",
        knowable(4)
    );
    let mut st = conn.prepare_cached(&sql)?;
    let rows = st.query_map(params![site, from, to, t], |r| {
        let source: String = r.get(3)?;
        Ok(StoredObservation {
            observed_at: r.get(0)?,
            stage_ft: r.get(1)?,
            flow_kcfs: r.get(2)?,
            source: Source::from_db(&source).unwrap_or(Source::NwpsLive),
            ingested_at: r.get(4)?,
        })
    })?;
    rows.collect()
}

/// Newest observation knowable at `t` with `observed_at <= t`.
pub fn latest_observation_asof(conn: &Connection, site: &str, t: i64) -> rusqlite::Result<Option<StoredObservation>> {
    let sql = format!(
        "select observed_at, stage_ft, flow_kcfs, source, ingested_at from forecast_observations
         where site = ?1 and observed_at <= ?2 and {}
         order by observed_at desc limit 1",
        knowable(2)
    );
    let mut st = conn.prepare_cached(&sql)?;
    st.query_row(params![site, t], |r| {
        let source: String = r.get(3)?;
        Ok(StoredObservation {
            observed_at: r.get(0)?,
            stage_ft: r.get(1)?,
            flow_kcfs: r.get(2)?,
            source: Source::from_db(&source).unwrap_or(Source::NwpsLive),
            ingested_at: r.get(4)?,
        })
    })
    .optional()
}

/// Age band of a feed value at `t`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Freshness {
    Fresh,
    Aging,
    Stale,
    Missing,
}

pub fn freshness(age_ms: Option<i64>, fresh_ms: i64, aging_ms: i64) -> Freshness {
    match age_ms {
        None => Freshness::Missing,
        Some(a) if a <= fresh_ms => Freshness::Fresh,
        Some(a) if a <= aging_ms => Freshness::Aging,
        Some(_) => Freshness::Stale,
    }
}

/// Gauge and forecast disagree, or the site cannot be judged.
#[derive(Debug, Clone, PartialEq)]
pub struct Conflict {
    /// `gauge_vs_forecast`, `stale_forecast`, `stale_observation`, `no_thresholds`
    pub kind: &'static str,
    pub detail: String,
    pub forecast_ft: Option<f64>,
    pub observed_ft: Option<f64>,
    pub difference_ft: Option<f64>,
}

/// What was known about a site at `t`.
#[derive(Debug, Clone, PartialEq)]
pub struct Status {
    pub site: String,
    pub as_of: i64,
    pub observation: Option<StoredObservation>,
    /// Category of the observed stage against the thresholds known at `t`.
    pub category: Option<Category>,
    pub thresholds: Option<Thresholds>,
    pub observation_freshness: Freshness,
    pub forecast: Option<Snapshot>,
    pub forecast_freshness: Freshness,
    /// The forecast point whose valid time is nearest `t` (within the pairing window).
    pub forecast_now: Option<StoredPoint>,
    pub conflicts: Vec<Conflict>,
    pub active_alerts: i64,
    /// The alert poller's newest runs known at `t`, so `active_alerts = 0` can say when it was
    /// checked (or that it was not).
    pub alert_check: Option<AlertCheck>,
    /// NWPS `low_threshold` state of the observed stage; `None` without a low-water threshold.
    pub low_water: Option<bool>,
}

/// Feeds whose fetch runs are the NWS alert poll (carp `nws-alerts`, python `nws`). The poll is
/// statewide, so one run checks every site.
pub const ALERT_FEEDS: [&str; 2] = ["nws-alerts", "nws"];
/// A successful alert poll older than this no longer vouches for "no alert in effect": the
/// poller runs every 60 s (5 min once NWWS-OI is live), so 15 min without one means it is down.
pub const ALERT_CHECK_STALE_MS: i64 = 15 * 60_000;

/// The alert poller as known at some `t`, from `fetch_runs` (every poll records one, empty polls
/// included).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlertCheck {
    /// Newest poll, whatever its status.
    pub last_run_id: i64,
    pub last_at: i64,
    /// `ok`, `empty`, `partial` or `error`.
    pub last_status: String,
    /// Newest poll that did not fail.
    pub ok_run_id: Option<i64>,
    pub ok_at: Option<i64>,
}

impl AlertCheck {
    /// A successful poll within [`ALERT_CHECK_STALE_MS`] of `t`.
    pub fn current(&self, t: i64) -> bool {
        self.ok_at.is_some_and(|at| t - at <= ALERT_CHECK_STALE_MS)
    }
}

/// The alert poller's newest runs known at `t` (fetched and recorded by then).
pub fn alert_check_asof(conn: &Connection, t: i64) -> rusqlite::Result<Option<AlertCheck>> {
    let newest = |ok_only: bool| -> rusqlite::Result<Option<(i64, i64, String)>> {
        conn.prepare_cached(
            "select id, fetched_at, status from fetch_runs
             where source_id in (?1, ?2) and fetched_at <= ?3 and received_at <= ?3 and (?4 = 0 or status != 'error')
             order by fetched_at desc, id desc limit 1",
        )?
        .query_row(params![ALERT_FEEDS[0], ALERT_FEEDS[1], t, ok_only], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()
    };
    let Some((last_run_id, last_at, last_status)) = newest(false)? else { return Ok(None) };
    let ok = if last_status == "error" { newest(true)? } else { Some((last_run_id, last_at, last_status.clone())) };
    Ok(Some(AlertCheck { last_run_id, last_at, last_status, ok_run_id: ok.as_ref().map(|o| o.0), ok_at: ok.map(|o| o.1) }))
}

/// Times in `(from, to]` at which [`AlertCheck::current`] can flip: a successful poll becoming
/// knowable after a gap, and [`ALERT_CHECK_STALE_MS`] after the last poll before a gap.
pub fn alert_check_changes(conn: &Connection, from: i64, to: i64) -> rusqlite::Result<Vec<i64>> {
    let mut st = conn.prepare_cached(
        "select fetched_at, max(fetched_at, received_at) from fetch_runs
         where source_id in (?1, ?2) and status != 'error' and received_at > ?3 and fetched_at <= ?4
         order by 2",
    )?;
    let polls: Vec<(i64, i64)> = st
        .query_map(params![ALERT_FEEDS[0], ALERT_FEEDS[1], from - ALERT_CHECK_STALE_MS - 1, to], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    // (fetched, known): a poll vouches from when it is known until fetched + the stale age.
    let mut out = Vec::new();
    let mut prev: Option<i64> = None;
    for &(fetched, known) in &polls {
        if prev.is_none_or(|p| known > p + ALERT_CHECK_STALE_MS) {
            out.extend(prev.map(|p| p + ALERT_CHECK_STALE_MS + 1));
            out.push(known);
        }
        prev = Some(prev.map_or(fetched, |p| p.max(fetched)));
    }
    out.extend(prev.map(|p| p + ALERT_CHECK_STALE_MS + 1));
    out.retain(|t| *t > from && *t <= to);
    Ok(out)
}

/// Alert versions in effect at `t`: first seen at or before `t` and not ended by `t`. Uses
/// `first_seen`, which is the poll time (ingestion), so the count never includes alerts this
/// process had not yet seen at `t`.
pub fn active_alerts_asof(conn: &Connection, site: &str, t: i64) -> rusqlite::Result<i64> {
    conn.query_row(
        "select count(*) from alert_snapshots where site = ?1 and first_seen <= ?2 and (ended_at is null or ended_at > ?2)",
        params![site, t],
        |r| r.get(0),
    )
}

/// Site status at `t`: observed stage and its category, freshness bands, the forecast known
/// then, and conflicts (gauge vs forecast difference over `conflict_ft`, stale feeds, missing
/// thresholds).
pub fn status_at(conn: &Connection, site: &str, t: i64, conflict_ft: f64) -> rusqlite::Result<Status> {
    let observation = latest_observation_asof(conn, site, t)?;
    let thresholds = thresholds_asof(conn, site, t)?;
    let forecast = asof(conn, site, t)?;
    let observation_freshness = freshness(observation.map(|o| t - o.observed_at), OBS_FRESH_MS, OBS_AGING_MS);
    let forecast_freshness = freshness(forecast.as_ref().map(|f| t - f.issued_at), FCST_FRESH_MS, FCST_AGING_MS);
    let category = thresholds.and_then(|th| th.category(observation.and_then(|o| o.stage_ft)));
    let forecast_now = forecast.as_ref().and_then(|f| {
        f.points.iter().filter(|p| (p.valid_at - t).abs() <= PAIR_WINDOW_MS).min_by_key(|p| (p.valid_at - t).abs()).copied()
    });
    let mut conflicts = Vec::new();
    if let (Some(o), Some(p)) = (observation, forecast_now) {
        if let (Some(obs), Some(fc)) = (o.stage_ft, p.stage_ft) {
            let diff = obs - fc;
            if diff.abs() > conflict_ft {
                conflicts.push(Conflict {
                    kind: "gauge_vs_forecast",
                    detail: format!(
                        "NWPS observed {obs:.2} ft at {} vs forecast {fc:.2} ft valid {} (issued {}): {diff:+.2} ft, over the {conflict_ft} ft threshold",
                        iso(o.observed_at),
                        iso(p.valid_at),
                        iso(forecast.as_ref().map(|f| f.issued_at).unwrap_or(t))
                    ),
                    forecast_ft: Some(fc),
                    observed_ft: Some(obs),
                    difference_ft: Some(diff),
                });
            }
        }
    }
    if forecast_freshness == Freshness::Stale {
        let f = forecast.as_ref().expect("stale implies a forecast");
        conflicts.push(Conflict {
            kind: "stale_forecast",
            detail: format!("forecast issued {} is {:.1} h old at {}; over 36 h, dropped from review scoring", iso(f.issued_at), (t - f.issued_at) as f64 / HOUR_MS as f64, iso(t)),
            forecast_ft: None,
            observed_ft: None,
            difference_ft: None,
        });
    }
    if observation_freshness == Freshness::Stale {
        let o = observation.expect("stale implies an observation");
        conflicts.push(Conflict {
            kind: "stale_observation",
            detail: format!("newest NWPS observation {} is {:.1} h old at {}; over 6 h, dropped from review scoring", iso(o.observed_at), (t - o.observed_at) as f64 / HOUR_MS as f64, iso(t)),
            forecast_ft: None,
            observed_ft: o.stage_ft,
            difference_ft: None,
        });
    }
    if thresholds.is_none_or(|th| th.is_empty()) && observation.is_some() {
        conflicts.push(Conflict {
            kind: "no_thresholds",
            detail: "no NWPS flood categories known for this site; stage is shown without a category".into(),
            forecast_ft: None,
            observed_ft: observation.and_then(|o| o.stage_ft),
            difference_ft: None,
        });
    }
    let active_alerts = active_alerts_asof(conn, site, t)?;
    let alert_check = alert_check_asof(conn, t)?;
    let low_water = thresholds.and_then(|th| th.low_water(observation.and_then(|o| o.stage_ft)));
    Ok(Status {
        alert_check,
        low_water,
        site: site.to_string(),
        as_of: t,
        observation,
        category,
        thresholds,
        observation_freshness,
        forecast,
        forecast_freshness,
        forecast_now,
        conflicts,
        active_alerts,
    })
}

/// One forecast point against what was later observed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VerifiedPoint {
    pub valid_at: i64,
    pub forecast_ft: Option<f64>,
    pub forecast_category: Option<Category>,
    /// The nearest observation within [`PAIR_WINDOW_MS`]; None = missing, never interpolated.
    pub observed_at: Option<i64>,
    pub observed_ft: Option<f64>,
    pub observed_category: Option<Category>,
    /// forecast - observed, feet.
    pub error_ft: Option<f64>,
}

impl VerifiedPoint {
    pub fn missing(&self) -> bool {
        self.error_ft.is_none()
    }
}

/// How a snapshot verified against observations stored since.
#[derive(Debug, Clone, PartialEq)]
pub struct Verification {
    pub snapshot: Snapshot,
    pub points: Vec<VerifiedPoint>,
    pub paired: usize,
    pub missing: usize,
    /// Mean of forecast - observed over paired points (positive = forecast too high).
    pub bias_ft: Option<f64>,
    pub mean_abs_error_ft: Option<f64>,
    pub max_abs_error_ft: Option<f64>,
    pub peak_forecast_ft: Option<f64>,
    pub peak_forecast_category: Option<Category>,
    pub peak_observed_ft: Option<f64>,
    pub peak_observed_category: Option<Category>,
    /// The observed peak reached the forecast peak's category. None when either side is unknown.
    pub peak_category_hit: Option<bool>,
}

/// Verify the newest revision of the issuance at `issued_at` (or a snapshot by id via
/// `verify_snapshot`) against every observation stored to date. Uses the latest thresholds (the
/// verification is a hindsight view by definition). Observations pair by nearest `observed_at`
/// within 30 minutes of each valid time; a point without one is reported missing.
pub fn verify(conn: &Connection, site: &str, issued_at: i64) -> rusqlite::Result<Option<Verification>> {
    let mut st = conn.prepare_cached(&format!(
        "select {SNAPSHOT_COLUMNS} from forecast_snapshots where site = ?1 and issued_at = ?2 order by revision desc, product limit 1"
    ))?;
    let Some(snap) = st.query_row(params![site, issued_at], snapshot_row).optional()? else { return Ok(None) };
    let snap = with_points(conn, snap)?;
    verify_snapshot(conn, snap).map(Some)
}

pub fn verify_snapshot(conn: &Connection, snapshot: Snapshot) -> rusqlite::Result<Verification> {
    let thresholds = super::store::newest_thresholds(conn, &snapshot.site)?.unwrap_or_default();
    let (from, to) = match (snapshot.valid_from, snapshot.valid_to) {
        (Some(f), Some(t)) => (f - PAIR_WINDOW_MS, t + PAIR_WINDOW_MS),
        _ => (0, 0),
    };
    let obs = observations_asof(conn, &snapshot.site, from, to, i64::MAX)?;
    let mut points = Vec::with_capacity(snapshot.points.len());
    for p in &snapshot.points {
        // `obs` is sorted by observed_at; nearest within the window, earlier one on a tie.
        let idx = obs.partition_point(|o| o.observed_at < p.valid_at);
        let nearest = [idx.checked_sub(1), Some(idx)]
            .into_iter()
            .flatten()
            .filter_map(|i| obs.get(i))
            .filter(|o| (o.observed_at - p.valid_at).abs() <= PAIR_WINDOW_MS && o.stage_ft.is_some())
            .min_by_key(|o| (o.observed_at - p.valid_at).abs());
        let observed_ft = nearest.and_then(|o| o.stage_ft);
        points.push(VerifiedPoint {
            valid_at: p.valid_at,
            forecast_ft: p.stage_ft,
            forecast_category: p.category,
            observed_at: nearest.map(|o| o.observed_at),
            observed_ft,
            observed_category: thresholds.category(observed_ft),
            error_ft: match (p.stage_ft, observed_ft) {
                (Some(f), Some(o)) => Some(f - o),
                _ => None,
            },
        });
    }
    let errors: Vec<f64> = points.iter().filter_map(|p| p.error_ft).collect();
    let paired = errors.len();
    let missing = points.len() - paired;
    let mean = |xs: &[f64]| (!xs.is_empty()).then(|| xs.iter().sum::<f64>() / xs.len() as f64);
    let bias_ft = mean(&errors);
    let abs: Vec<f64> = errors.iter().map(|e| e.abs()).collect();
    let mean_abs_error_ft = mean(&abs);
    let max_abs_error_ft = abs.iter().copied().fold(None, |m: Option<f64>, e| Some(m.map_or(e, |m| m.max(e))));
    let peak = snapshot.peak().copied();
    let peak_forecast_ft = peak.and_then(|p| p.stage_ft);
    let peak_forecast_category = peak.and_then(|p| p.category.or_else(|| thresholds.category(p.stage_ft)));
    // Observed peak over the forecast's valid window (every stored observation, not only paired ones).
    let peak_observed_ft = obs.iter().filter_map(|o| o.stage_ft).fold(None, |m: Option<f64>, s| Some(m.map_or(s, |m| m.max(s))));
    let peak_observed_category = thresholds.category(peak_observed_ft);
    let peak_category_hit = match (peak_forecast_category, peak_observed_category) {
        (Some(f), Some(o)) => Some(o == f),
        _ => None,
    };
    Ok(Verification {
        snapshot,
        points,
        paired,
        missing,
        bias_ft,
        mean_abs_error_ft,
        max_abs_error_ft,
        peak_forecast_ft,
        peak_forecast_category,
        peak_observed_ft,
        peak_observed_category,
        peak_category_hit,
    })
}

pub fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_else(|| ms.to_string())
}
