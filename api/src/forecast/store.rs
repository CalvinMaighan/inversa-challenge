//! Write side of the forecast store. Every function takes the writer transaction
//! (`Db::write`) and is idempotent: replaying a poll changes nothing.

use rusqlite::{params, Connection, OptionalExtension};

use super::{Observation, Point, Source, Thresholds};

/// A forecast issuance as the adapter hands it in.
#[derive(Debug, Clone, PartialEq)]
pub struct NewSnapshot {
    /// NWPS lid, e.g. `BTRL1`.
    pub site: String,
    /// `stageflow` for the NWPS API, `hml` for the IEM archive, ...
    pub product: String,
    pub issued_at: i64,
    pub ingested_at: i64,
    pub source: Source,
    /// sha256 hex of the payload the points came from.
    pub payload_hash: String,
    pub points: Vec<Point>,
}

/// What `insert_snapshot` did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Inserted {
    /// First time this issuance was seen.
    New { id: i64 },
    /// Same (site, product, issued_at, payload_hash) already stored; nothing written.
    Duplicate { id: i64 },
    /// Same issuance, different payload: stored next to the earlier revisions.
    Revision { id: i64, revision: i64 },
}

impl Inserted {
    pub fn id(self) -> i64 {
        match self {
            Inserted::New { id } | Inserted::Duplicate { id } | Inserted::Revision { id, .. } => id,
        }
    }
}

/// Store one issuance with its points. Categories are computed against `thresholds` (the NWPS
/// gauge metadata fetched with the forecast); pass `Thresholds::default()` when unknown and the
/// points get no category. Points with the same `valid_at` keep the last one given.
pub fn insert_snapshot(tx: &Connection, snap: &NewSnapshot, thresholds: &Thresholds) -> rusqlite::Result<Inserted> {
    let existing: Option<i64> = tx
        .query_row(
            "select id from forecast_snapshots where site = ?1 and product = ?2 and issued_at = ?3 and payload_hash = ?4",
            params![snap.site, snap.product, snap.issued_at, snap.payload_hash],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        return Ok(Inserted::Duplicate { id });
    }
    let revision: i64 = tx.query_row(
        "select count(*) from forecast_snapshots where site = ?1 and product = ?2 and issued_at = ?3",
        params![snap.site, snap.product, snap.issued_at],
        |r| r.get(0),
    )?;
    let valid_from = snap.points.iter().map(|p| p.valid_at).min();
    let valid_to = snap.points.iter().map(|p| p.valid_at).max();
    tx.execute(
        "insert into forecast_snapshots (site, product, issued_at, ingested_at, source, payload_hash, revision, valid_from, valid_to, horizon_end)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![snap.site, snap.product, snap.issued_at, snap.ingested_at, snap.source.db(), snap.payload_hash, revision, valid_from, valid_to],
    )?;
    let id = tx.last_insert_rowid();
    let mut st = tx.prepare_cached(
        "insert or replace into forecast_points (snapshot_id, valid_at, stage_ft, flow_kcfs, category) values (?1, ?2, ?3, ?4, ?5)",
    )?;
    for p in &snap.points {
        let stage = p.stage_ft.filter(|v| v.is_finite());
        let flow = p.flow_kcfs.filter(|v| v.is_finite());
        st.execute(params![id, p.valid_at, stage, flow, thresholds.category(stage).map(|c| c.db())])?;
    }
    if revision > 0 {
        Ok(Inserted::Revision { id, revision })
    } else {
        Ok(Inserted::New { id })
    }
}

/// Store observed values. The first row stored for a `(site, observed_at)` wins (that is what we
/// knew first); later re-polls of the same hour change nothing. Returns rows inserted.
pub fn insert_observations(
    tx: &Connection,
    site: &str,
    source: Source,
    ingested_at: i64,
    obs: &[Observation],
) -> rusqlite::Result<usize> {
    let mut st = tx.prepare_cached(
        "insert or ignore into forecast_observations (site, observed_at, stage_ft, flow_kcfs, source, ingested_at) values (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    let mut n = 0;
    for o in obs {
        n += st.execute(params![
            site,
            o.observed_at,
            o.stage_ft.filter(|v| v.is_finite()),
            o.flow_kcfs.filter(|v| v.is_finite()),
            source.db(),
            ingested_at
        ])?;
    }
    Ok(n)
}

/// Record the site's NWPS thresholds. A new row only when they differ from the newest stored.
pub fn upsert_thresholds(tx: &Connection, site: &str, ingested_at: i64, t: &Thresholds) -> rusqlite::Result<bool> {
    let newest = newest_thresholds(tx, site)?;
    if newest.as_ref() == Some(t) {
        return Ok(false);
    }
    tx.execute(
        "insert or replace into forecast_thresholds (site, ingested_at, action_ft, minor_ft, moderate_ft, major_ft) values (?1, ?2, ?3, ?4, ?5, ?6)",
        params![site, ingested_at, t.action_ft, t.minor_ft, t.moderate_ft, t.major_ft],
    )?;
    Ok(true)
}

pub(super) fn newest_thresholds(conn: &Connection, site: &str) -> rusqlite::Result<Option<Thresholds>> {
    thresholds_asof(conn, site, i64::MAX)
}

/// Thresholds known at `t`.
pub fn thresholds_asof(conn: &Connection, site: &str, t: i64) -> rusqlite::Result<Option<Thresholds>> {
    conn.query_row(
        "select action_ft, minor_ft, moderate_ft, major_ft from forecast_thresholds where site = ?1 and ingested_at <= ?2 order by ingested_at desc limit 1",
        params![site, t],
        |r| Ok(Thresholds { action_ft: r.get(0)?, minor_ft: r.get(1)?, moderate_ft: r.get(2)?, major_ft: r.get(3)? }),
    )
    .optional()
}

/// An NWS alert in effect at a site, as one poll saw it.
#[derive(Debug, Clone, PartialEq)]
pub struct AlertSeen {
    pub ext_id: String,
    pub event: String,
    pub severity: String,
    pub headline: Option<String>,
    pub onset: Option<i64>,
    pub expires: Option<i64>,
    pub source: Source,
    pub payload_hash: String,
}

/// Outcome of one alert poll at a site.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AlertsRecorded {
    pub new: usize,
    pub refreshed: usize,
    pub ended: usize,
}

/// Record the alerts a poll at `seen_at` found active at `site`: new (site, alert, payload)
/// versions get `first_seen = last_seen = seen_at`, known ones get `last_seen = seen_at`, and
/// every still-open version not in this poll gets `ended_at = seen_at`. A changed payload of a
/// known alert is a new version; the old one ends. Replaying the same poll changes nothing but
/// `last_seen`, which never moves backwards.
// ponytail: polls are assumed to arrive in time order (one poller per app). A poll replayed
// from before the newest one would open a never-ended version; if backfilled alert history
// ever lands, close new rows against the newest later poll instead.
pub fn record_alerts(tx: &Connection, site: &str, seen_at: i64, alerts: &[AlertSeen]) -> rusqlite::Result<AlertsRecorded> {
    let mut out = AlertsRecorded::default();
    let mut ids = Vec::with_capacity(alerts.len());
    for a in alerts {
        let existing: Option<(i64, Option<i64>)> = tx
            .query_row(
                "select id, ended_at from alert_snapshots where site = ?1 and ext_id = ?2 and payload_hash = ?3",
                params![site, a.ext_id, a.payload_hash],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let id = match existing {
            // An ended version seen again (a poll replayed out of order) stays ended at its
            // first end: as-of views must not resurrect it.
            Some((id, _)) => {
                tx.execute("update alert_snapshots set last_seen = max(last_seen, ?2) where id = ?1", params![id, seen_at])?;
                out.refreshed += 1;
                id
            }
            None => {
                tx.execute(
                    "insert into alert_snapshots (site, ext_id, event, severity, headline, onset, expires, source, payload_hash, first_seen, last_seen)
                     values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
                    params![site, a.ext_id, a.event, a.severity, a.headline, a.onset, a.expires, a.source.db(), a.payload_hash, seen_at],
                )?;
                out.new += 1;
                tx.last_insert_rowid()
            }
        };
        ids.push(id);
    }
    let keep = serde_json::to_string(&ids).expect("id list");
    out.ended = tx.execute(
        "update alert_snapshots set ended_at = ?2
         where site = ?1 and ended_at is null and first_seen <= ?2
           and id not in (select value from json_each(?3))",
        params![site, seen_at, keep],
    )?;
    Ok(out)
}
