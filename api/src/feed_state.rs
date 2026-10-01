//! Feed-state envelope (PLAN.md C3), computed from `sources`, `fetch_runs` and the newest
//! `observed_at` each source has contributed.
//!
//! Rules, first match wins:
//! - `down`: the source is registered but not running (`sources.disabled_reason`: a missing
//!   secret or `INVERSA_SOURCES=off`); the note is `disabled: <reason>`.
//! - `down`: the last [`DOWN_AFTER_ERRORS`] fetch runs all failed, or there has been no fetch
//!   within 3 × cadence (including never).
//! - `stale`: lag (now − newest observed_at) > `max_latency_s`.
//! - `lagging`: lag > cadence + [`LAGGING_GRACE_S`] (the PRD §13 poll-freshness target).
//! - `nominal`: otherwise.
//!
//! While a source's rate governor is backing off, its state ("backoff 120s after HTTP 503") is
//! appended to the note.

use std::collections::HashMap;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::ingest::governor;
use crate::realtime::{Event, Hub};

/// Consecutive failed fetch runs that mark a feed down.
pub const DOWN_AFTER_ERRORS: usize = 3;
/// No fetch for this many cadences marks a feed down.
pub const DOWN_AFTER_CADENCES: i64 = 3;
/// Slack on top of the cadence before a feed counts as lagging.
pub const LAGGING_GRACE_S: i64 = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Health {
    Nominal,
    Lagging,
    Stale,
    Down,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedState {
    pub source: String,
    /// "push", "poll" or "webhook" (a poller the provider nudges on change; the note says so).
    pub mode: String,
    pub state: Health,
    pub newest_observed_at: Option<i64>,
    pub last_fetch_at: Option<i64>,
    /// `fetch_runs.id` of the latest run, so claims about freshness can cite `fetch:<id>` (C14).
    /// A string, like every id on the wire (GraphQL `ID`, TS `string | null`).
    pub last_fetch_run_id: Option<String>,
    pub lag_seconds: Option<i64>,
    pub note: Option<String>,
}

/// One row of `sources`.
struct SourceRow {
    id: String,
    mode: String,
    cadence_s: i64,
    max_latency_s: i64,
    disabled_reason: Option<String>,
}

/// One row of `fetch_runs`, newest first.
struct RunRow {
    id: i64,
    fetched_at: i64,
    status: String,
    error: Option<String>,
}

/// Everything the rules need for one source.
struct Inputs {
    source: SourceRow,
    runs: Vec<RunRow>,
    newest_observed_at: Option<i64>,
    /// Alert-only feed (no sightings or stations): quiet weather is not stale data, so freshness
    /// is the newest successful fetch rather than the newest alert onset.
    event_feed: bool,
}

/// The state of every registered source at `now_ms` (unix ms), ordered by source id.
pub async fn compute(db: &Db, now_ms: i64) -> anyhow::Result<Vec<FeedState>> {
    let inputs = db.read(move |conn| load(conn, now_ms)).await?;
    Ok(inputs
        .into_iter()
        .map(|i| {
            let s = classify(i, now_ms);
            let backoff = governor::note(&s.source);
            with_backoff(s, backoff)
        })
        .collect())
}

/// Append the source's live rate-governor state ("backoff 120s after HTTP 503 ...") to the note
/// while it is backing off, unless the note already carries that text (a failed run records the
/// governor note in its error).
fn with_backoff(mut s: FeedState, backoff: Option<String>) -> FeedState {
    if let Some(b) = backoff {
        s.note = match s.note.take() {
            Some(n) if n.contains(&b) => Some(n),
            Some(n) => Some(format!("{n}; {b}")),
            None => Some(b),
        };
    }
    s
}

/// Recompute feed state every `period` (15 s suits the fastest 1-minute cadences) and publish `Event::FeedState` for each source whose
/// health, last fetch or newest observation changed since the last publish (every source on the
/// first pass). Health also changes with no event at all, when a feed silently stops: this is
/// what moves it to lagging, stale and down for `feeds` subscribers.
pub fn spawn_publisher(obs: Db, hub: Hub, period: Duration) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut last: HashMap<String, (Health, Option<i64>, Option<i64>)> = HashMap::new();
        let mut tick = tokio::time::interval(period);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let states = match compute(&obs, crate::state::now_ms()).await {
                Ok(states) => states,
                Err(e) => {
                    tracing::warn!("feed state: {e:#}");
                    continue;
                }
            };
            for s in states {
                let key = (s.state, s.last_fetch_at, s.newest_observed_at);
                if last.get(&s.source) != Some(&key) {
                    last.insert(s.source.clone(), key);
                    hub.publish(Event::FeedState(s));
                }
            }
        }
    })
}

fn load(conn: &Connection, now_ms: i64) -> rusqlite::Result<Vec<Inputs>> {
    let sources = {
        let mut stmt =
            conn.prepare("select id, mode, cadence_s, max_latency_s, disabled_reason from sources order by id")?;
        let rows = stmt.query_map([], |r| {
            Ok(SourceRow {
                id: r.get(0)?,
                mode: r.get(1)?,
                cadence_s: r.get(2)?,
                max_latency_s: r.get(3)?,
                disabled_reason: r.get(4)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut runs_stmt = conn.prepare(
        "select id, fetched_at, status, error from fetch_runs
         where source_id = ?1 order by fetched_at desc, id desc limit ?2",
    )?;
    let mut out = Vec::with_capacity(sources.len());
    for source in sources {
        let runs = runs_stmt
            .query_map(params![source.id, DOWN_AFTER_ERRORS as i64], |r| {
                Ok(RunRow { id: r.get(0)?, fetched_at: r.get(1)?, status: r.get(2)?, error: r.get(3)? })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let (newest_observed_at, event_feed) = newest_observed_at(conn, &source.id, now_ms)?;
        out.push(Inputs { source, runs, newest_observed_at, event_feed });
    }
    Ok(out)
}

/// Newest observation time at or before `now_ms` across sightings, readings (via stations) and
/// alerts (`onset`). Future-dated rows, such as forecast readings, do not count as fresh data.
///
/// Each table gets an existence check first (index-backed for sightings and stations; alerts is
/// small), so a source never pays for a max() scan over a table it does not write to.
fn newest_observed_at(conn: &Connection, source_id: &str, now_ms: i64) -> rusqlite::Result<(Option<i64>, bool)> {
    const PROBES: [(&str, &str); 3] = [
        (
            "select exists(select 1 from sightings where source_id = ?1)",
            "select max(observed_at) from sightings where source_id = ?1 and observed_at <= ?2",
        ),
        (
            "select exists(select 1 from stations where source_id = ?1)",
            "select max(r.observed_at) from stations s join readings r on r.station_id = s.id
             where s.source_id = ?1 and r.observed_at <= ?2",
        ),
        (
            "select exists(select 1 from alerts where source_id = ?1)",
            "select max(onset) from alerts where source_id = ?1 and onset <= ?2",
        ),
    ];
    let mut newest: Option<i64> = None;
    let mut has = [false; 3];
    for (i, (exists_sql, max_sql)) in PROBES.into_iter().enumerate() {
        has[i] = conn.prepare_cached(exists_sql)?.query_row([source_id], |r| r.get(0))?;
        if !has[i] {
            continue;
        }
        let max: Option<i64> =
            conn.prepare_cached(max_sql)?.query_row(params![source_id, now_ms], |r| r.get(0)).optional()?.flatten();
        newest = newest.max(max);
    }
    // The forecast store (carp): a river poller's freshness is its newest observation (NWPS) or
    // the newest issuance it stored (archive, gridpoint). Issuances are never future-dated.
    if let Some(fsource) = crate::forecast::source_of_feed(source_id) {
        let max: Option<i64> = conn
            .prepare_cached(
                "select max(t) from (select max(observed_at) as t from forecast_observations where source = ?1 and observed_at <= ?2
                                     union all select max(issued_at) from forecast_snapshots where source = ?1 and issued_at <= ?2)",
            )?
            .query_row(params![fsource, now_ms], |r| r.get(0))
            .optional()?
            .flatten();
        newest = newest.max(max);
    }
    // Alerts only: sightings and stations empty, alerts present.
    let event_feed = !has[0] && !has[1] && has[2];
    Ok((newest, event_feed))
}

fn classify(inputs: Inputs, now_ms: i64) -> FeedState {
    let Inputs { source, runs, newest_observed_at, event_feed } = inputs;
    let last_fetch_at = runs.first().map(|r| r.fetched_at);
    let last_fetch_run_id = runs.first().map(|r| r.id.to_string());
    let silent_s = last_fetch_at.map(|t| (now_ms - t) / 1000);
    let fresh_at = if event_feed {
        runs.iter().find(|r| r.status != "error").map(|r| r.fetched_at)
    } else {
        newest_observed_at
    };
    let lag_seconds = fresh_at.map(|t| (now_ms - t).max(0) / 1000);
    let down_after_s = DOWN_AFTER_CADENCES * source.cadence_s;
    let lagging_after_s = source.cadence_s + LAGGING_GRACE_S;

    let last_error = runs.first().filter(|r| r.status == "error").map(|r| r.error.as_deref().unwrap_or("no error text"));
    let all_failed = runs.len() >= DOWN_AFTER_ERRORS && runs.iter().all(|r| r.status == "error");

    let (state, note) = if let Some(reason) = &source.disabled_reason {
        (Health::Down, Some(format!("disabled: {reason}")))
    } else if all_failed {
        (Health::Down, Some(format!("last {DOWN_AFTER_ERRORS} fetches failed: {}", last_error.unwrap_or_default())))
    } else if last_fetch_at.is_none() {
        (Health::Down, Some("never fetched".to_string()))
    } else if let Some(silent) = silent_s.filter(|&s| s > down_after_s) {
        (Health::Down, Some(format!("no fetch for {} (3x cadence is {})", human(silent), human(down_after_s))))
    } else if let Some(lag) = lag_seconds.filter(|&l| l > source.max_latency_s) {
        (
            Health::Stale,
            Some(format!("newest observation is {} old; max latency is {}", human(lag), human(source.max_latency_s))),
        )
    } else if let Some(lag) = lag_seconds.filter(|&l| l > lagging_after_s) {
        (
            Health::Lagging,
            Some(format!(
                "newest observation is {} old; expected within {} (cadence + {})",
                human(lag),
                human(lagging_after_s),
                human(LAGGING_GRACE_S)
            )),
        )
    } else if let Some(err) = last_error {
        (Health::Nominal, Some(format!("last fetch failed: {err}")))
    } else if newest_observed_at.is_none() {
        (Health::Nominal, Some("fetching; no observations stored yet".to_string()))
    } else {
        (Health::Nominal, None)
    };
    // A stale or lagging feed whose last fetch also failed says both: the age explains the state, the
    // failure explains why it is not catching up.
    let note = match (state, note, last_error) {
        (Health::Stale | Health::Lagging, Some(n), Some(err)) => Some(format!("{n}; last fetch failed: {err}")),
        (_, n, _) => n,
    };
    // A webhook source always says how it is driven, after whatever explains its state.
    let note = if source.mode == "webhook" {
        let backstop = match governor::snapshot(&source.id) {
            Some(g) => format!("webhook nudge on dataset change; poll backstop every {}", human(g.min_interval.as_secs() as i64)),
            None => "webhook nudge on dataset change; poll backstop".to_string(),
        };
        Some(match note {
            Some(n) => format!("{n}; {backstop}"),
            None => backstop,
        })
    } else {
        note
    };

    FeedState {
        source: source.id,
        mode: source.mode,
        state,
        newest_observed_at,
        last_fetch_at,
        last_fetch_run_id,
        lag_seconds,
        note,
    }
}

/// Compact duration for notes: "45s", "12m", "3h 5m", "2d 4h".
fn human(seconds: i64) -> String {
    let s = seconds.max(0);
    match s {
        0..=59 => format!("{s}s"),
        60..=3599 => format!("{}m", s / 60),
        3600..=86_399 => match (s % 3600) / 60 {
            0 => format!("{}h", s / 3600),
            m => format!("{}h {m}m", s / 3600),
        },
        _ => match (s % 86_400) / 3600 {
            0 => format!("{}d", s / 86_400),
            h => format!("{}d {h}h", s / 86_400),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_790_000_000_000;
    const MIN: i64 = 60_000;

    /// A memory observations DB with one poll source: cadence 2 min, max latency 30 min.
    async fn db_with_source(id: &'static str) -> Db {
        let db = Db::memory("observations");
        db.write(move |tx| {
            tx.execute(
                "insert into sources (id, name, homepage, mode, cadence_s, max_latency_s)
                 values (?1, ?1, 'https://example.org', 'poll', 120, 1800)",
                [id],
            )
        })
        .await
        .unwrap();
        db
    }

    async fn run(db: &Db, source: &'static str, at: i64, status: &'static str) {
        db.write(move |tx| {
            tx.execute(
                "insert into fetch_runs (source_id, fetched_at, received_at, status, error)
                 values (?1, ?2, ?2, ?3, case when ?3 = 'error' then 'HTTP 503' end)",
                params![source, at, status],
            )
        })
        .await
        .unwrap();
    }

    async fn sighting(db: &Db, source: &'static str, ext: &'static str, observed_at: i64) {
        db.write(move |tx| {
            tx.execute(
                "insert into sightings (source_id, ext_id, taxon_id, lat, lon, observed_at, quality, ingested_at)
                 values (?1, ?2, 1, 25.5, -80.9, ?3, 'research', ?3)",
                params![source, ext, observed_at],
            )
        })
        .await
        .unwrap();
    }

    async fn only(db: &Db) -> FeedState {
        let mut states = compute(db, NOW).await.unwrap();
        assert_eq!(states.len(), 1);
        states.remove(0)
    }

    #[tokio::test]
    async fn nominal_when_fresh() {
        let db = db_with_source("inat").await;
        run(&db, "inat", NOW - MIN, "ok").await;
        sighting(&db, "inat", "1", NOW - 3 * MIN).await;
        // Future-dated rows (forecasts) must not count as fresh data.
        sighting(&db, "inat", "2", NOW + 60 * MIN).await;
        let s = only(&db).await;
        assert_eq!(s.state, Health::Nominal, "{s:?}");
        assert_eq!(s.mode, "poll");
        assert_eq!(s.newest_observed_at, Some(NOW - 3 * MIN));
        assert_eq!(s.last_fetch_at, Some(NOW - MIN));
        assert_eq!(s.last_fetch_run_id.as_deref(), Some("1"));
        assert_eq!(s.lag_seconds, Some(180));
        assert_eq!(s.note, None);
    }

    #[test]
    fn backoff_is_appended_once() {
        let state = |note: Option<&str>| FeedState {
            source: "usgs".into(),
            mode: "poll".into(),
            state: Health::Nominal,
            newest_observed_at: None,
            last_fetch_at: None,
            last_fetch_run_id: None,
            lag_seconds: None,
            note: note.map(String::from),
        };
        let b = "backoff 120s after HTTP 503 (1 consecutive)".to_string();
        assert_eq!(with_backoff(state(None), None).note, None);
        assert_eq!(with_backoff(state(None), Some(b.clone())).note.as_deref(), Some(b.as_str()));
        assert_eq!(
            with_backoff(state(Some("fetching; no observations stored yet")), Some(b.clone())).note.unwrap(),
            format!("fetching; no observations stored yet; {b}")
        );
        let failed = format!("last fetch failed: HTTP 503 from x [{b}]");
        assert_eq!(with_backoff(state(Some(&failed)), Some(b)).note.unwrap(), failed);
    }

    #[tokio::test]
    async fn disabled_source_is_down_with_reason_and_keeps_history() {
        let db = db_with_source("goes19").await;
        run(&db, "goes19", NOW - MIN, "ok").await;
        sighting(&db, "goes19", "1", NOW - 3 * MIN).await;
        db.write(|tx| tx.execute("update sources set disabled_reason = 'GOES_SQS_URL not set' where id = 'goes19'", []))
            .await
            .unwrap();
        let s = only(&db).await;
        assert_eq!(s.state, Health::Down, "{s:?}");
        assert_eq!(s.note.as_deref(), Some("disabled: GOES_SQS_URL not set"));
        // What was fetched before it was disabled is still reported.
        assert_eq!((s.last_fetch_at, s.newest_observed_at), (Some(NOW - MIN), Some(NOW - 3 * MIN)));
        db.write(|tx| tx.execute("update sources set disabled_reason = null", [])).await.unwrap();
        assert_eq!(only(&db).await.state, Health::Nominal);
    }

    #[tokio::test]
    async fn lagging_past_cadence_plus_grace() {
        let db = db_with_source("inat").await;
        run(&db, "inat", NOW - MIN, "ok").await;
        // cadence 120 s + 120 s grace = 240 s; 5 min is past it but under the 30 min max latency.
        sighting(&db, "inat", "1", NOW - 5 * MIN).await;
        let s = only(&db).await;
        assert_eq!(s.state, Health::Lagging, "{s:?}");
        assert_eq!(s.lag_seconds, Some(300));
        assert!(s.note.unwrap().contains("5m old"));
    }

    #[tokio::test]
    async fn stale_past_max_latency() {
        let db = db_with_source("inat").await;
        run(&db, "inat", NOW - MIN, "ok").await;
        sighting(&db, "inat", "1", NOW - 45 * MIN).await;
        let s = only(&db).await;
        assert_eq!(s.state, Health::Stale, "{s:?}");
        assert_eq!(s.lag_seconds, Some(45 * 60));
        assert!(s.note.unwrap().contains("max latency is 30m"));

        // The next fetch fails: still stale, and the note gives both reasons.
        run(&db, "inat", NOW - MIN / 2, "error").await;
        let s = only(&db).await;
        assert_eq!(s.state, Health::Stale, "{s:?}");
        assert_eq!(s.note.as_deref(), Some("newest observation is 45m old; max latency is 30m; last fetch failed: HTTP 503"));
    }

    #[tokio::test]
    async fn down_after_consecutive_errors() {
        let db = db_with_source("inat").await;
        sighting(&db, "inat", "1", NOW - 2 * MIN).await;
        run(&db, "inat", NOW - 5 * MIN, "ok").await;
        run(&db, "inat", NOW - 3 * MIN, "error").await;
        run(&db, "inat", NOW - 2 * MIN, "error").await;
        // Two failures after a success: still nominal, but the note says so.
        let s = only(&db).await;
        assert_eq!(s.state, Health::Nominal, "{s:?}");
        assert_eq!(s.note.as_deref(), Some("last fetch failed: HTTP 503"));

        run(&db, "inat", NOW - MIN, "error").await;
        let s = only(&db).await;
        assert_eq!(s.state, Health::Down, "{s:?}");
        assert_eq!(s.note.as_deref(), Some("last 3 fetches failed: HTTP 503"));
        assert_eq!(s.last_fetch_at, Some(NOW - MIN));
    }

    #[tokio::test]
    async fn down_when_silent_or_never_fetched() {
        let db = db_with_source("inat").await;
        let s = only(&db).await;
        assert_eq!((s.state, s.note.as_deref()), (Health::Down, Some("never fetched")));

        // 3 x 120 s cadence = 6 min; 7 min of silence is down even though the data is fresh-ish.
        run(&db, "inat", NOW - 7 * MIN, "ok").await;
        sighting(&db, "inat", "1", NOW - 2 * MIN).await;
        let s = only(&db).await;
        assert_eq!(s.state, Health::Down, "{s:?}");
        assert_eq!(s.note.as_deref(), Some("no fetch for 7m (3x cadence is 6m)"));
    }

    #[tokio::test]
    async fn readings_and_alerts_count_per_source() {
        let db = Db::memory("observations");
        db.write(|tx| {
            tx.execute_batch(
                "insert into sources (id, name, homepage, mode, cadence_s, max_latency_s) values
                   ('usgs', 'USGS', 'https://waterdata.usgs.gov', 'poll', 900, 3600),
                   ('nws', 'NWS', 'https://api.weather.gov', 'push', 60, 600);
                 insert into stations (id, source_id, ext_id, name, lat, lon, kind)
                   values (1, 'usgs', '0229', 'Shark River', 25.4, -80.9, 'gage');",
            )?;
            tx.execute(
                "insert into readings (station_id, param, value, observed_at, origin) values (1, 'stage_m', 1.2, ?1, 'measured')",
                [NOW - 10 * MIN],
            )?;
            tx.execute(
                "insert into alerts (source_id, ext_id, event, severity, onset, expires) values ('nws', 'a1', 'Freeze Warning', 'Severe', ?1, ?2)",
                params![NOW - 4 * MIN, NOW + 600 * MIN],
            )?;
            for (src, at) in [("usgs", NOW - 5 * MIN), ("nws", NOW - MIN)] {
                tx.execute(
                    "insert into fetch_runs (source_id, fetched_at, received_at, status) values (?1, ?2, ?2, 'ok')",
                    params![src, at],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
        let states = compute(&db, NOW).await.unwrap();
        let ids: Vec<_> = states.iter().map(|s| s.source.as_str()).collect();
        assert_eq!(ids, ["nws", "usgs"]);
        // nws is an alert-only feed: freshness is its last successful fetch (1 min), not the alert onset (4 min).
        assert_eq!((states[0].mode.as_str(), states[0].state, states[0].lag_seconds), ("push", Health::Nominal, Some(60)));
        assert_eq!(states[0].newest_observed_at, Some(NOW - 4 * MIN));
        assert_eq!((states[1].state, states[1].lag_seconds), (Health::Nominal, Some(600)));
    }

    #[tokio::test]
    async fn publisher_emits_initial_states_then_only_changes() {
        use futures_util::StreamExt;

        let db = db_with_source("inat").await;
        let hub = Hub::default();
        let mut events = Box::pin(hub.filtered(crate::realtime::OnLag::Skip, |e| match e {
            Event::FeedState(s) => Some(s),
            _ => None,
        }));
        let task = spawn_publisher(db.clone(), hub.clone(), Duration::from_millis(10));
        let wait = Duration::from_secs(2);

        let first = tokio::time::timeout(wait, events.next()).await.unwrap().unwrap();
        assert_eq!((first.source.as_str(), first.state), ("inat", Health::Down));
        // Several quiet ticks publish nothing; the next event is the fetch below.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let now = crate::state::now_ms();
        run(&db, "inat", now, "ok").await;
        let second = tokio::time::timeout(wait, events.next()).await.unwrap().unwrap();
        assert_eq!((second.state, second.last_fetch_at), (Health::Nominal, Some(now)));
        task.abort();
    }

    #[test]
    fn human_durations() {
        assert_eq!(human(45), "45s");
        assert_eq!(human(300), "5m");
        assert_eq!(human(3600), "1h");
        assert_eq!(human(3 * 3600 + 5 * 60), "3h 5m");
        assert_eq!(human(2 * 86_400 + 4 * 3600), "2d 4h");
        assert_eq!(human(-5), "0s");
    }

    #[test]
    fn serializes_to_the_c3_envelope() {
        let s = FeedState {
            source: "goes19".into(),
            mode: "push".into(),
            state: Health::Stale,
            newest_observed_at: Some(1),
            last_fetch_at: None,
            last_fetch_run_id: Some("7".into()),
            lag_seconds: Some(2),
            note: None,
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            serde_json::json!({"source":"goes19","mode":"push","state":"stale","newestObservedAt":1,
                               "lastFetchAt":null,"lastFetchRunId":"7","lagSeconds":2,"note":null})
        );
    }
}
