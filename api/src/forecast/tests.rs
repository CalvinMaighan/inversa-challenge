//! Store, as-of, verification and performance tests over a migrated SQLite connection.
//! Names: `forecast_store_*` (G1), `bitemporal_*` (G2), `forecast_verify_*` (G3), `forecast_perf` (G5).

use rusqlite::Connection;

use super::query::{self, Freshness, PAIR_WINDOW_MS};
use super::store::{self, AlertSeen, Inserted, NewSnapshot};
use super::*;

const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;
/// 2026-09-30T00:00:00Z
const T0: i64 = 1_790_726_400_000;

fn conn() -> Connection {
    let mut c = Connection::open_in_memory().unwrap();
    crate::db::migrate(&mut c, "observations").unwrap();
    c
}

fn file_conn(path: &std::path::Path) -> Connection {
    let mut c = Connection::open(path).unwrap();
    crate::db::configure(&c).unwrap();
    crate::db::migrate(&mut c, "observations").unwrap();
    c
}

/// Hourly points from `start`, `n` of them, stage rising `step` ft per hour from `base`.
fn points(start: i64, n: usize, base: f64, step: f64) -> Vec<Point> {
    (0..n).map(|i| Point { valid_at: start + i as i64 * HOUR, stage_ft: Some(base + step * i as f64), flow_kcfs: Some(100.0 + i as f64) }).collect()
}

fn snap(site: &str, issued_at: i64, ingested_at: i64, source: Source, hash: &str, pts: Vec<Point>) -> NewSnapshot {
    NewSnapshot { site: site.into(), product: "stageflow".into(), issued_at, ingested_at, source, payload_hash: hash.into(), points: pts }
}

fn mcgl1() -> Thresholds {
    Thresholds::from_feed(4.0, 6.0, 7.0, 12.0)
}

#[test]
fn forecast_store_idempotent_and_revisions() {
    let c = conn();
    let th = mcgl1();
    let issued = T0 + 15 * HOUR;
    let a = snap("MCGL1", issued, issued + HOUR, Source::NwpsLive, "h1", points(T0 + 18 * HOUR, 56, 3.0, 0.02));
    let first = store::insert_snapshot(&c, &a, &th).unwrap();
    let Inserted::New { id } = first else { panic!("{first:?}") };
    // Same payload again: no-op.
    assert_eq!(store::insert_snapshot(&c, &a, &th).unwrap(), Inserted::Duplicate { id });
    let mut again = a.clone();
    again.ingested_at += HOUR;
    assert_eq!(store::insert_snapshot(&c, &again, &th).unwrap(), Inserted::Duplicate { id }, "ingested_at is not part of the identity");
    let n: i64 = c.query_row("select count(*) from forecast_snapshots", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
    let np: i64 = c.query_row("select count(*) from forecast_points", [], |r| r.get(0)).unwrap();
    assert_eq!(np, 56);

    // Changed payload, same issued_at: a revision, both kept.
    let mut b = a.clone();
    b.payload_hash = "h2".into();
    b.ingested_at = issued + 3 * HOUR;
    b.points[0].stage_ft = Some(3.5);
    let rev = store::insert_snapshot(&c, &b, &th).unwrap();
    let Inserted::Revision { id: id2, revision: 1 } = rev else { panic!("{rev:?}") };
    assert_ne!(id, id2);
    let rows: Vec<(i64, i64, String, i64, i64)> = c
        .prepare("select id, revision, source, valid_from, horizon_end from forecast_snapshots order by id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(rows, [(id, 0, "nwps-live".to_string(), T0 + 18 * HOUR, T0 + 73 * HOUR), (id2, 1, "nwps-live".to_string(), T0 + 18 * HOUR, T0 + 73 * HOUR)]);
    let got = query::by_id(&c, id2).unwrap().unwrap();
    assert_eq!(got.revision, 1);
    assert_eq!(got.points.len(), 56);
    assert_eq!(got.points[0].stage_ft, Some(3.5));
    // Categories from NWPS thresholds: 3.5 none, 4.0 action (at or above), 6.1 minor.
    assert_eq!(got.points[0].category, Some(Category::None));
    assert_eq!(got.points.iter().find(|p| p.stage_ft == Some(4.0)).unwrap().category, Some(Category::Action));
    let peak = got.peak().unwrap();
    assert!((peak.stage_ft.unwrap() - 4.1).abs() < 1e-9);
    assert_eq!(peak.category, Some(Category::Action));
    assert_eq!((got.valid_from, got.valid_to, got.horizon_end), (Some(T0 + 18 * HOUR), Some(T0 + 73 * HOUR), Some(T0 + 73 * HOUR)));

    // Unknown thresholds: points stored, no category; missing stage stays null.
    let mut no_th = snap("ALXL1", issued, issued + HOUR, Source::NwpsLive, "h3", points(T0, 3, 20.0, 0.0));
    no_th.points[1].stage_ft = Some(f64::NAN);
    let id3 = store::insert_snapshot(&c, &no_th, &Thresholds::default()).unwrap().id();
    let got = query::by_id(&c, id3).unwrap().unwrap();
    assert!(got.points.iter().all(|p| p.category.is_none()));
    assert_eq!(got.points[1].stage_ft, None, "NaN is stored as missing");
    assert_eq!(got.source, Source::NwpsLive);
    assert_eq!(got.payload_hash, "h3");
}

#[test]
fn forecast_store_observations_thresholds_and_alerts() {
    let c = conn();
    let obs = [
        Observation { observed_at: T0, stage_ft: Some(3.3), flow_kcfs: Some(26.9) },
        Observation { observed_at: T0 + HOUR, stage_ft: Some(3.4), flow_kcfs: None },
    ];
    assert_eq!(store::insert_observations(&c, "MCGL1", Source::NwpsLive, T0 + 2 * HOUR, &obs).unwrap(), 2);
    // Replaying the poll (even with a changed value) keeps the first stored row.
    let changed = [Observation { observed_at: T0, stage_ft: Some(9.9), flow_kcfs: None }];
    assert_eq!(store::insert_observations(&c, "MCGL1", Source::NwpsLive, T0 + 3 * HOUR, &changed).unwrap(), 0);
    let got = query::observations_asof(&c, "MCGL1", T0, T0 + DAY, i64::MAX).unwrap();
    assert_eq!(got.len(), 2);
    assert_eq!((got[0].stage_ft, got[0].ingested_at, got[0].source), (Some(3.3), T0 + 2 * HOUR, Source::NwpsLive));

    assert!(store::upsert_thresholds(&c, "MCGL1", T0, &mcgl1()).unwrap());
    assert!(!store::upsert_thresholds(&c, "MCGL1", T0 + DAY, &mcgl1()).unwrap(), "unchanged thresholds add no row");
    let raised = Thresholds::from_feed(5.0, 6.0, 7.0, 12.0);
    assert!(store::upsert_thresholds(&c, "MCGL1", T0 + 2 * DAY, &raised).unwrap());
    assert_eq!(store::thresholds_asof(&c, "MCGL1", T0 + DAY).unwrap(), Some(mcgl1()));
    assert_eq!(store::thresholds_asof(&c, "MCGL1", T0 + 3 * DAY).unwrap(), Some(raised));
    assert_eq!(store::thresholds_asof(&c, "MCGL1", T0 - 1).unwrap(), None);

    let alert = |id: &str, hash: &str| AlertSeen {
        ext_id: id.into(),
        event: "Flood Warning".into(),
        severity: "Moderate".into(),
        headline: Some("Flood Warning for Terrebonne".into()),
        onset: Some(T0),
        expires: Some(T0 + 3 * DAY),
        source: Source::NwsGridpoint,
        payload_hash: hash.into(),
    };
    let p1 = T0 + HOUR;
    let r = store::record_alerts(&c, "MCGL1", p1, &[alert("a1", "x"), alert("a2", "y")]).unwrap();
    assert_eq!((r.new, r.refreshed, r.ended), (2, 0, 0));
    // Same poll replayed: nothing new, nothing ended.
    let r = store::record_alerts(&c, "MCGL1", p1, &[alert("a1", "x"), alert("a2", "y")]).unwrap();
    assert_eq!((r.new, r.refreshed, r.ended), (0, 2, 0));
    // a2 gone, a1 updated (new payload): old a1 version and a2 end; new a1 version starts.
    let p2 = T0 + 3 * HOUR;
    let r = store::record_alerts(&c, "MCGL1", p2, &[alert("a1", "x2")]).unwrap();
    assert_eq!((r.new, r.refreshed, r.ended), (1, 0, 2));
    let rows: Vec<(String, String, i64, i64, Option<i64>)> = c
        .prepare("select ext_id, payload_hash, first_seen, last_seen, ended_at from alert_snapshots order by id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        rows,
        [
            ("a1".to_string(), "x".to_string(), p1, p1, Some(p2)),
            ("a2".to_string(), "y".to_string(), p1, p1, Some(p2)),
            ("a1".to_string(), "x2".to_string(), p2, p2, None),
        ]
    );
    // Another site's alerts are untouched by this site's polls.
    store::record_alerts(&c, "BTRL1", p1, &[alert("b1", "z")]).unwrap();
    store::record_alerts(&c, "MCGL1", T0 + 4 * HOUR, &[]).unwrap();
    assert_eq!(query::active_alerts_asof(&c, "BTRL1", T0 + 5 * HOUR).unwrap(), 1);
    assert_eq!(query::active_alerts_asof(&c, "MCGL1", T0 + 5 * HOUR).unwrap(), 0);
    assert_eq!(query::active_alerts_asof(&c, "MCGL1", p1).unwrap(), 2);
    assert_eq!(query::active_alerts_asof(&c, "MCGL1", p2).unwrap(), 1, "a1 v2 at p2; v1 and a2 ended at p2");
    assert_eq!(query::active_alerts_asof(&c, "MCGL1", p1 - 1).unwrap(), 0, "not yet seen");
}

/// Two issuances a day apart, each captured an hour after issue, plus an archive backfill.
fn seed_bitemporal(c: &Connection) -> (i64, i64, i64) {
    let th = mcgl1();
    let d0 = T0 + 15 * HOUR; // issued day 0 15Z
    let d1 = d0 + DAY; // issued day 1 15Z
    let archive = d0 - DAY; // day -1, from IEM, ingested much later
    store::insert_snapshot(c, &snap("MCGL1", d0, d0 + HOUR, Source::NwpsLive, "d0", points(T0 + 18 * HOUR, 60, 3.0, 0.01)), &th).unwrap();
    store::insert_snapshot(c, &snap("MCGL1", d1, d1 + HOUR, Source::NwpsLive, "d1", points(T0 + 42 * HOUR, 60, 3.5, 0.01)), &th).unwrap();
    store::insert_snapshot(c, &snap("MCGL1", archive, d1 + 5 * DAY, Source::IemArchive, "arch", points(T0 - 6 * HOUR, 60, 2.5, 0.01)), &th).unwrap();
    store::upsert_thresholds(c, "MCGL1", T0, &th).unwrap();
    (archive, d0, d1)
}

#[test]
fn bitemporal_asof_uses_issued_and_ingested_for_live_rows() {
    let c = conn();
    let (archive, d0, d1) = seed_bitemporal(&c);
    // Between issue and capture of d0: d0 was public but we had not stored it; the archive row
    // (issued a day earlier) is what replay can honestly show.
    let s = query::asof(&c, "MCGL1", d0 + 30 * 60_000).unwrap().unwrap();
    assert_eq!((s.issued_at, s.source), (archive, Source::IemArchive));
    // Once captured: d0.
    assert_eq!(query::asof(&c, "MCGL1", d0 + HOUR).unwrap().unwrap().issued_at, d0);
    // Just before d1 was captured: still d0, even though d1's issued_at <= t.
    assert_eq!(query::asof(&c, "MCGL1", d1 + HOUR - 1).unwrap().unwrap().issued_at, d0);
    assert_eq!(query::asof(&c, "MCGL1", d1 + HOUR).unwrap().unwrap().issued_at, d1);
    assert_eq!(query::asof(&c, "MCGL1", i64::MAX).unwrap().unwrap().issued_at, d1);
    // Archive rows are gated by issued_at only: knowable before we ingested them.
    assert_eq!(query::asof(&c, "MCGL1", archive).unwrap().unwrap().source, Source::IemArchive);
    assert_eq!(query::asof(&c, "MCGL1", archive - 1).unwrap(), None);
    assert_eq!(query::asof(&c, "BTRL1", i64::MAX).unwrap(), None, "other site");

    // History at d1 + 1h lists all three, newest first; at d0 + 1h only two.
    let h = query::history(&c, "MCGL1", d1 + HOUR, 10).unwrap();
    assert_eq!(h.iter().map(|s| s.issued_at).collect::<Vec<_>>(), [d1, d0, archive]);
    assert!(h.iter().all(|s| s.points.len() == 60));
    let h = query::history(&c, "MCGL1", d0 + HOUR, 10).unwrap();
    assert_eq!(h.iter().map(|s| s.issued_at).collect::<Vec<_>>(), [d0, archive]);
    assert_eq!(query::history(&c, "MCGL1", d1 + HOUR, 1).unwrap().len(), 1);

    let cov = query::coverage(&c, "MCGL1").unwrap();
    assert_eq!(cov, query::Coverage { replay_coverage_start: Some(archive), live_coverage_start: Some(d0 + HOUR), snapshots: 3 });
    assert_eq!(query::coverage(&c, "BTRL1").unwrap(), query::Coverage::default());

    // An NWS gridpoint weather run issued after d1 shares the store but is never the river
    // forecast: as-of and status keep d1, coverage ignores it, history lists it.
    let th = mcgl1();
    let run = d1 + 6 * HOUR;
    let mut weather = snap("MCGL1", run, run + HOUR, Source::NwsGridpoint, "wx", vec![Point { valid_at: run, stage_ft: None, flow_kcfs: None }]);
    weather.product = "gridpoint".into();
    store::insert_snapshot(&c, &weather, &th).unwrap();
    assert_eq!(query::asof(&c, "MCGL1", run + 2 * HOUR).unwrap().unwrap().issued_at, d1);
    assert_eq!(query::status_at(&c, "MCGL1", run + 2 * HOUR, 1.0).unwrap().forecast.unwrap().issued_at, d1);
    assert_eq!(query::coverage(&c, "MCGL1").unwrap().snapshots, 3);
    let h = query::history(&c, "MCGL1", run + 2 * HOUR, 10).unwrap();
    assert_eq!(h.iter().map(|s| s.issued_at).collect::<Vec<_>>(), [d1, d0, archive], "history is river issuances only");
    let w = query::weather_run(&c, "MCGL1", run + 2 * HOUR).unwrap().unwrap();
    assert_eq!((w.issued_at, w.ingested_at, w.product.as_str(), w.source), (run, run + HOUR, "gridpoint", Source::NwsGridpoint));
    assert_eq!(query::weather_run(&c, "MCGL1", run - 1).unwrap(), None, "not yet issued");
    // A site with only a weather run has no river forecast.
    let mut only = weather.clone();
    only.site = "BTRL1".into();
    store::insert_snapshot(&c, &only, &th).unwrap();
    assert_eq!(query::asof(&c, "BTRL1", i64::MAX).unwrap(), None);
    assert_eq!(query::history(&c, "BTRL1", i64::MAX, 10).unwrap(), Vec::new());
    assert_eq!(query::coverage(&c, "BTRL1").unwrap(), query::Coverage::default());
    assert_eq!(query::weather_run(&c, "BTRL1", i64::MAX).unwrap().unwrap().issued_at, run);
}

#[test]
fn bitemporal_revisions_and_one_valid_time_two_versions() {
    let c = conn();
    let th = mcgl1();
    let issued = T0 + 15 * HOUR;
    let valid = T0 + 30 * HOUR;
    let v1 = snap("MCGL1", issued, issued + HOUR, Source::NwpsLive, "v1", vec![Point { valid_at: valid, stage_ft: Some(3.0), flow_kcfs: None }]);
    let mut v2 = v1.clone();
    v2.payload_hash = "v2".into();
    v2.ingested_at = issued + 4 * HOUR;
    v2.points[0].stage_ft = Some(5.0);
    store::insert_snapshot(&c, &v1, &th).unwrap();
    store::insert_snapshot(&c, &v2, &th).unwrap();
    let stage_at = |t: i64| query::asof(&c, "MCGL1", t).unwrap().unwrap().points[0].stage_ft.unwrap();
    assert_eq!(stage_at(issued + 2 * HOUR), 3.0, "revision 1 was not ingested yet");
    assert_eq!(stage_at(issued + 4 * HOUR), 5.0, "revision 1 wins once ingested");
    assert_eq!(query::asof(&c, "MCGL1", issued + 4 * HOUR).unwrap().unwrap().revision, 1);
    assert_eq!(query::history(&c, "MCGL1", issued + 2 * HOUR, 10).unwrap()[0].revision, 0);
    assert_eq!(query::history(&c, "MCGL1", issued + 9 * HOUR, 10).unwrap().len(), 1, "one row per issuance");

    // A later issuance for the same valid time: another version, picked by t.
    let later = issued + DAY;
    store::insert_snapshot(&c, &snap("MCGL1", later, later + HOUR, Source::NwpsLive, "v3", vec![Point { valid_at: valid, stage_ft: Some(4.2), flow_kcfs: None }]), &th).unwrap();
    assert_eq!(stage_at(later), 5.0, "issued but not yet captured at t");
    assert_eq!(stage_at(later + HOUR), 4.2);
}

#[test]
fn bitemporal_observations_after_t_are_excluded_then_present() {
    let c = conn();
    let th = mcgl1();
    store::upsert_thresholds(&c, "MCGL1", T0, &th).unwrap();
    let issued = T0 + 15 * HOUR;
    store::insert_snapshot(&c, &snap("MCGL1", issued, issued + HOUR, Source::NwpsLive, "f", points(T0 + 18 * HOUR, 24, 3.0, 0.1)), &th).unwrap();
    // Hourly observations, each captured 55 minutes after its valid time.
    for h in 0..30 {
        let at = T0 + h * HOUR;
        store::insert_observations(&c, "MCGL1", Source::NwpsLive, at + 55 * 60_000, &[Observation { observed_at: at, stage_ft: Some(3.0 + 0.05 * h as f64), flow_kcfs: None }]).unwrap();
    }
    let t = T0 + 20 * HOUR + 30 * 60_000; // 20:30Z: the 20Z value is not in yet (arrives 20:55Z)
    let seen = query::observations_asof(&c, "MCGL1", T0, T0 + DAY, t).unwrap();
    assert_eq!(seen.last().unwrap().observed_at, T0 + 19 * HOUR);
    assert_eq!(seen.len(), 20);
    let later = query::observations_asof(&c, "MCGL1", T0, T0 + DAY, t + HOUR).unwrap();
    assert_eq!(later.last().unwrap().observed_at, T0 + 20 * HOUR, "21:30Z: the 20Z value arrived at 20:55Z, the 21Z one lands at 21:55Z");
    assert_eq!(later.len(), 21);
    // An observation taken before t but ingested after it is not in the as-of view.
    let newest = query::latest_observation_asof(&c, "MCGL1", t).unwrap().unwrap();
    assert_eq!(newest.observed_at, T0 + 19 * HOUR);
    assert!(newest.ingested_at <= t);

    // Status at t: observation 1.5 h old (fresh), forecast 5.5 h old (fresh), category none,
    // forecast point nearest t (20:30 pairs 20Z and 21Z at 30 min: earlier wins) within window.
    let s = query::status_at(&c, "MCGL1", t, 1.0).unwrap();
    assert_eq!(s.observation.unwrap().observed_at, T0 + 19 * HOUR);
    assert_eq!(s.observation_freshness, Freshness::Fresh);
    assert_eq!(s.forecast_freshness, Freshness::Fresh);
    assert_eq!(s.category, Some(Category::None));
    assert_eq!(s.forecast.as_ref().unwrap().issued_at, issued);
    assert_eq!(s.forecast_now.unwrap().valid_at, T0 + 20 * HOUR);
    assert!(s.conflicts.is_empty(), "{:?}", s.conflicts);
    assert_eq!(s.thresholds, Some(th));

    // Observation drifts far from the forecast: a gauge_vs_forecast conflict over 1 ft, none over 3 ft.
    // (28:30Z: a new observed_at, since the first row stored for an hour wins.)
    let t2 = T0 + 28 * HOUR + 30 * 60_000;
    store::insert_observations(&c, "MCGL1", Source::NwpsLive, t2, &[Observation { observed_at: t2, stage_ft: Some(6.5), flow_kcfs: None }]).unwrap();
    let s = query::status_at(&c, "MCGL1", t2, 1.0).unwrap();
    assert_eq!(s.category, Some(Category::Minor));
    let gauge = s.conflicts.iter().find(|x| x.kind == "gauge_vs_forecast").expect("conflict");
    assert_eq!((gauge.observed_ft, gauge.forecast_ft), (Some(6.5), Some(4.0)));
    assert!((gauge.difference_ft.unwrap() - 2.5).abs() < 1e-9);
    assert!(gauge.detail.contains("+2.50 ft"), "{}", gauge.detail);
    assert!(query::status_at(&c, "MCGL1", t2, 3.0).unwrap().conflicts.is_empty());

    // Two days on: forecast stale (49 h), observation stale (red band), flagged, not interpolated.
    let t3 = issued + 49 * HOUR;
    let s = query::status_at(&c, "MCGL1", t3, 1.0).unwrap();
    assert_eq!(s.forecast_freshness, Freshness::Stale);
    assert_eq!(s.observation_freshness, Freshness::Stale);
    assert_eq!(s.forecast_now, None, "no forecast point within 30 min of t3");
    let kinds: Vec<&str> = s.conflicts.iter().map(|x| x.kind).collect();
    assert_eq!(kinds, ["stale_forecast", "stale_observation"]);
    // Nothing known at all: everything missing, no conflicts invented.
    let s = query::status_at(&c, "BTRL1", t3, 1.0).unwrap();
    assert_eq!((s.observation, s.forecast.is_none(), s.category), (None, true, None));
    assert_eq!((s.observation_freshness, s.forecast_freshness), (Freshness::Missing, Freshness::Missing));
    assert!(s.conflicts.is_empty());
    // Observation without thresholds: no category and a no_thresholds conflict.
    store::insert_observations(&c, "BTRL1", Source::NwpsLive, t3, &[Observation { observed_at: t3, stage_ft: Some(8.0), flow_kcfs: None }]).unwrap();
    let s = query::status_at(&c, "BTRL1", t3, 1.0).unwrap();
    assert_eq!(s.category, None);
    assert_eq!(s.conflicts.iter().map(|x| x.kind).collect::<Vec<_>>(), ["no_thresholds"]);
    assert_eq!(query::freshness(Some(6 * HOUR), query::OBS_FRESH_MS, query::OBS_AGING_MS), Freshness::Aging);
    assert_eq!(query::freshness(Some(6 * HOUR + 1), query::OBS_FRESH_MS, query::OBS_AGING_MS), Freshness::Stale);
}

#[test]
fn forecast_verify_pairs_within_30_minutes_and_reports_missing() {
    let c = conn();
    let th = mcgl1();
    store::upsert_thresholds(&c, "MCGL1", T0, &th).unwrap();
    let issued = T0 + 15 * HOUR;
    // 6-hourly points: 18Z 3.0, 00Z 4.0 (action), 06Z 6.5 (minor), 12Z 5.0
    let pts = vec![
        Point { valid_at: T0 + 18 * HOUR, stage_ft: Some(3.0), flow_kcfs: None },
        Point { valid_at: T0 + 24 * HOUR, stage_ft: Some(4.0), flow_kcfs: None },
        Point { valid_at: T0 + 30 * HOUR, stage_ft: Some(6.5), flow_kcfs: None },
        Point { valid_at: T0 + 36 * HOUR, stage_ft: Some(5.0), flow_kcfs: None },
        Point { valid_at: T0 + 42 * HOUR, stage_ft: None, flow_kcfs: Some(1.0) },
    ];
    store::insert_snapshot(&c, &snap("MCGL1", issued, issued + HOUR, Source::NwpsLive, "f", pts), &th).unwrap();
    assert_eq!(query::verify(&c, "MCGL1", issued + 1).unwrap(), None, "no issuance at that time");
    // Nothing observed yet: every point missing, no numbers invented.
    let v = query::verify(&c, "MCGL1", issued).unwrap().unwrap();
    assert_eq!((v.paired, v.missing), (0, 5));
    assert!(v.points.iter().all(|p| p.missing() && p.observed_ft.is_none()));
    assert_eq!((v.bias_ft, v.mean_abs_error_ft, v.peak_observed_ft, v.peak_category_hit), (None, None, None, None));
    assert_eq!((v.peak_forecast_ft, v.peak_forecast_category), (Some(6.5), Some(Category::Minor)));

    let obs = |at: i64, s: f64| Observation { observed_at: at, stage_ft: Some(s), flow_kcfs: None };
    store::insert_observations(
        &c,
        "MCGL1",
        Source::NwpsLive,
        T0 + 2 * DAY,
        &[
            obs(T0 + 18 * HOUR + 10 * 60_000, 3.2),  // 10 min after 18Z: pairs (error -0.2)
            obs(T0 + 24 * HOUR - PAIR_WINDOW_MS, 4.5), // exactly 30 min before 00Z: pairs (error -0.5)
            obs(T0 + 24 * HOUR + 20 * 60_000, 4.6),  // 20 min after 00Z: nearer, wins (error -0.6)
            obs(T0 + 30 * HOUR + 31 * 60_000, 7.5),  // 31 min after 06Z: outside the window, missing
            obs(T0 + 33 * HOUR, 7.2),                // between points: not paired, counts for the observed peak
            obs(T0 + 36 * HOUR, 5.0),                // exact: error 0
        ],
    )
    .unwrap();
    let v = query::verify(&c, "MCGL1", issued).unwrap().unwrap();
    let got: Vec<(Option<f64>, Option<f64>, bool)> = v.points.iter().map(|p| (p.observed_ft, p.error_ft, p.missing())).collect();
    assert_eq!(
        got,
        [
            (Some(3.2), Some(3.0 - 3.2), false),
            (Some(4.6), Some(4.0 - 4.6), false),
            (None, None, true),
            (Some(5.0), Some(0.0), false),
            (None, None, true),
        ]
    );
    assert_eq!(v.points[1].observed_at, Some(T0 + 24 * HOUR + 20 * 60_000));
    assert_eq!((v.paired, v.missing), (3, 2));
    let bias = v.bias_ft.unwrap();
    assert!((bias - (-0.2 - 0.6 + 0.0) / 3.0).abs() < 1e-9, "{bias}");
    assert!((v.mean_abs_error_ft.unwrap() - 0.8 / 3.0).abs() < 1e-9);
    assert!((v.max_abs_error_ft.unwrap() - 0.6).abs() < 1e-9);
    assert_eq!(v.points[1].observed_category, Some(Category::Action));
    // Forecast peak 6.5 (minor); observed peak 7.5 (moderate): category not hit.
    assert_eq!((v.peak_observed_ft, v.peak_observed_category, v.peak_category_hit), (Some(7.5), Some(Category::Moderate), Some(false)));
    assert_eq!(v.snapshot.issued_at, issued);

    // Verification follows the newest revision of the issuance.
    let mut rev = snap("MCGL1", issued, issued + 2 * HOUR, Source::NwpsLive, "f2", vec![Point { valid_at: T0 + 36 * HOUR, stage_ft: Some(5.5), flow_kcfs: None }]);
    rev.product = "stageflow".into();
    store::insert_snapshot(&c, &rev, &th).unwrap();
    let v = query::verify(&c, "MCGL1", issued).unwrap().unwrap();
    assert_eq!((v.snapshot.revision, v.paired, v.missing), (1, 1, 0));
    assert!((v.bias_ft.unwrap() - 0.5).abs() < 1e-9);
    assert_eq!(v.peak_category_hit, Some(true), "forecast peak action (5.5), observed peak in window 5.0 action");
}

/// G5: 60 days x 8 sites x 1 snapshot/day x 15 d hourly points, on disk. Prints
/// `FORECAST-PERF p95_ms=<n> size_mb=<n>`.
#[test]
fn forecast_perf() {
    let dir = std::env::temp_dir().join(format!("inversa-forecast-perf-{}-{}", std::process::id(), uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("observations.db");
    let c = file_conn(&path);
    let th = mcgl1();
    let sites = ["SMML1", "KRZL1", "BLRL1", "MCGL1", "BTRL1", "AEXL1", "MLUL1", "BXAL1"];
    let t_start = std::time::Instant::now();
    c.execute_batch("begin").unwrap();
    for site in sites {
        store::upsert_thresholds(&c, site, T0, &th).unwrap();
        for day in 0..60 {
            let issued = T0 + day * DAY + 15 * HOUR;
            let pts = points(issued + 3 * HOUR, 15 * 24, 3.0, 0.001);
            let s = snap(site, issued, issued + 50 * 60_000, Source::NwpsLive, &format!("{site}-{day}"), pts);
            store::insert_snapshot(&c, &s, &th).unwrap();
            // Hourly observations for the day, captured 55 min after each.
            let obs: Vec<Observation> =
                (0..24).map(|h| Observation { observed_at: T0 + day * DAY + h * HOUR, stage_ft: Some(3.0 + h as f64 * 0.01), flow_kcfs: Some(100.0) }).collect();
            store::insert_observations(&c, site, Source::NwpsLive, T0 + day * DAY + 55 * 60_000, &obs).unwrap();
        }
    }
    c.execute_batch("commit").unwrap();
    let load_ms = t_start.elapsed().as_millis();
    let n: i64 = c.query_row("select count(*) from forecast_points", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 60 * 8 * 360);
    c.execute_batch("pragma wal_checkpoint(truncate)").unwrap();
    let size_mb = std::fs::metadata(&path).unwrap().len() as f64 / (1024.0 * 1024.0);

    // Fresh connection, cold statement cache, as-of at 400 spread times across sites.
    drop(c);
    let c = file_conn(&path);
    let mut samples = Vec::with_capacity(400);
    for i in 0..400i64 {
        let site = sites[(i % 8) as usize];
        let t = T0 + (i * 7919) % (60 * DAY) + 16 * HOUR;
        let start = std::time::Instant::now();
        let s = query::asof(&c, site, t).unwrap().expect("a forecast is known");
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(s.points.len(), 360);
        assert!(s.issued_at <= t && s.ingested_at <= t, "never from the future");
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p95 = samples[(samples.len() as f64 * 0.95) as usize - 1];
    let status_start = std::time::Instant::now();
    let st = query::status_at(&c, "MCGL1", T0 + 30 * DAY + 20 * HOUR, 1.0).unwrap();
    let status_ms = status_start.elapsed().as_secs_f64() * 1000.0;
    assert!(st.forecast.is_some() && st.observation.is_some());
    println!("FORECAST-PERF p95_ms={p95:.2} size_mb={size_mb:.1} load_ms={load_ms} status_ms={status_ms:.2} points={n}");
    drop(c);
    let _ = std::fs::remove_dir_all(&dir);
    assert!(size_mb < 25.0, "size {size_mb:.1} MB");
}
