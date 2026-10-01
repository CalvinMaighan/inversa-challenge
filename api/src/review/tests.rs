//! Needs-review engine tests. Names: `review_rule_*` (G1, pure rules), `review_asof_*` (G2, store
//! as-of), `review_honesty_*` (G3), `review_scene` (G4, fixture replay).

use rusqlite::Connection;
use serde::Deserialize;

use super::*;
use crate::forecast::store::{self, AlertSeen, NewSnapshot};
use crate::forecast::{Observation, Point, StoredPoint};

const H: i64 = HOUR_MS;
const DAY: i64 = 24 * H;
/// 2026-09-30T12:00:00Z
const T: i64 = 1_790_726_400_000 + 12 * H;

fn cfg() -> ReviewCfg {
    ReviewCfg::default()
}

fn obs(at: i64, stage: f64) -> StoredObservation {
    StoredObservation { observed_at: at, stage_ft: Some(stage), flow_kcfs: None, source: Source::NwpsLive, ingested_at: at + 55 * 60_000 }
}

/// Hourly observations ending one hour before `T`, stage from `start` rising `per_h` per hour over
/// `hours` hours (the newest is `start + per_h * hours`).
fn hourly(start: f64, per_h: f64, hours: i64) -> Vec<StoredObservation> {
    (0..=hours).map(|k| obs(T - H - (hours - k) * H, start + per_h * k as f64)).collect()
}

/// A forecast issued 3 h before `T`, 6-hourly points from `T`, rising `step` per point.
fn forecast(lid: &str, start: f64, step: f64, n: usize) -> Snapshot {
    let issued = T - 3 * H;
    Snapshot {
        id: 1,
        site: lid.into(),
        product: "stageflow".into(),
        issued_at: issued,
        ingested_at: issued + H,
        source: Source::NwpsLive,
        payload_hash: "h".into(),
        revision: 0,
        valid_from: Some(T),
        valid_to: Some(T + (n as i64 - 1) * 6 * H),
        horizon_end: Some(T + (n as i64 - 1) * 6 * H),
        points: (0..n).map(|k| StoredPoint { valid_at: T + k as i64 * 6 * H, stage_ft: Some(start + step * k as f64), flow_kcfs: None, category: None }).collect(),
    }
}

fn smml1_thresholds() -> Thresholds {
    Thresholds::from_feed(35.0, 40.0, 44.0, 50.0)
}

/// A quiet site: 25 h of hourly observations near 30 ft, a flat forecast, thresholds.
fn quiet(lid: &str) -> Inputs {
    let window = hourly(30.0, 0.01, 25);
    Inputs {
        lid: lid.into(),
        usgs_site: None,
        as_of: T,
        latest: window.last().copied(),
        window,
        forecast: Some(forecast(lid, 30.3, 0.05, 40)),
        thresholds: Some(smml1_thresholds()),
        alerts: vec![],
        alert_check: Some(polled(T - 60_000)),
        usgs: None,
    }
}

/// An alert poller whose newest poll (successful) was at `at`.
fn polled(at: i64) -> AlertCheck {
    AlertCheck { last_run_id: 7, last_at: at, last_status: "ok".into(), ok_run_id: Some(7), ok_at: Some(at) }
}

fn with_obs(mut i: Inputs, window: Vec<StoredObservation>) -> Inputs {
    i.latest = window.last().copied();
    i.window = window;
    i
}

fn site(lid: &str) -> SiteRef {
    SiteRef { lid: lid.into(), location: lid.to_ascii_lowercase(), name: format!("{lid} (test)"), usgs: None }
}

fn fired(rs: &[Reason]) -> Vec<&'static str> {
    rs.iter().filter(|r| r.outcome == Outcome::Fired).map(|r| r.rule.id()).collect()
}

// ---------------------------------------------------------------------------------------------
// G1: rules
// ---------------------------------------------------------------------------------------------

#[test]
fn review_rule_stage_rise_fires_at_threshold_not_below() {
    let c = cfg();
    // 24 h rise of exactly 2.00 ft: fires ("at or above").
    let i = with_obs(quiet("SMML1"), hourly(30.0, 2.0 / 24.0, 25));
    let r = rule_stage_rise(&i, &c);
    assert_eq!(r.outcome, Outcome::Fired, "{}", r.explanation);
    assert!((r.value.unwrap() - 2.0).abs() < 1e-9);
    assert_eq!((r.threshold, r.unit, r.source.as_str()), (Some(2.0), Some("ft"), "nwps-live"));
    assert_eq!(r.observed_at, Some(T - H));
    assert_eq!(r.evidence_ids, [reading_id("SMML1", T - 25 * H), reading_id("SMML1", T - H)]);
    assert_eq!(r.link.as_deref(), Some("https://water.noaa.gov/gauges/smml1"));
    assert!(r.explanation.contains("rose 2.00 ft in 24 h"), "{}", r.explanation);
    // 1.99 ft: clear, with the value still reported.
    let i = with_obs(quiet("SMML1"), hourly(30.0, 1.99 / 24.0, 25));
    let r = rule_stage_rise(&i, &c);
    assert_eq!(r.outcome, Outcome::Clear);
    assert!((r.value.unwrap() - 1.99).abs() < 1e-9);
    // A 3 ft fall is not a rise.
    let i = with_obs(quiet("SMML1"), hourly(30.0, -3.0 / 24.0, 25));
    let r = rule_stage_rise(&i, &c);
    assert_eq!(r.outcome, Outcome::Clear);
    assert!(r.explanation.contains("fell 3.00 ft"), "{}", r.explanation);
}

#[test]
fn review_rule_stage_rise_missing_and_stale_are_unknown() {
    let c = cfg();
    // No observation at all.
    let i = with_obs(quiet("SMML1"), vec![]);
    assert_eq!(rule_stage_rise(&i, &c).outcome, Outcome::Unknown);
    // Only 22 h of history: no baseline within 1 h of newest - 24 h.
    let i = with_obs(quiet("SMML1"), hourly(30.0, 0.5, 22));
    let r = rule_stage_rise(&i, &c);
    assert_eq!(r.outcome, Outcome::Unknown, "{}", r.explanation);
    // Baseline exactly 1 h off the 24 h mark is accepted; 1 h 1 ms is not.
    let mut w = vec![obs(T - H - 25 * H, 30.0), obs(T - H, 33.0)];
    let i = with_obs(quiet("SMML1"), w.clone());
    assert_eq!(rule_stage_rise(&i, &c).outcome, Outcome::Fired);
    w[0].observed_at -= 1;
    let i = with_obs(quiet("SMML1"), w);
    assert_eq!(rule_stage_rise(&i, &c).outcome, Outcome::Unknown);
    // Newest observation 6 h + 1 ms old: stale, so the rise is not scored even though it is big.
    let mut i = with_obs(quiet("SMML1"), hourly(30.0, 0.5, 25));
    i.as_of = T - H + c.stale_observation_ms() + 1;
    assert_eq!(rule_stage_rise(&i, &c).outcome, Outcome::Unknown);
    i.as_of = T - H + c.stale_observation_ms();
    assert_eq!(rule_stage_rise(&i, &c).outcome, Outcome::Fired, "exactly 6 h is not stale");
    // Newest observation without a stage.
    let mut w = hourly(30.0, 0.5, 25);
    w.last_mut().unwrap().stage_ft = None;
    let i = with_obs(quiet("SMML1"), w);
    assert_eq!(rule_stage_rise(&i, &c).outcome, Outcome::Unknown);
}

#[test]
fn review_rule_stage_rise_tidal_noise_floor() {
    let c = cfg();
    // Morgan City is tidal: 2.5 ft in 24 h is under its 3 ft noise floor; at Baton Rouge it fires.
    let rise = |lid: &str, ft: f64| rule_stage_rise(&with_obs(quiet(lid), hourly(3.0, ft / 24.0, 25)), &c);
    let r = rise("MCGL1", 2.5);
    assert_eq!((r.outcome, r.threshold), (Outcome::Clear, Some(3.0)));
    assert!(r.explanation.contains("tidal site"), "{}", r.explanation);
    assert_eq!(rise("BTRL1", 2.5).outcome, Outcome::Fired);
    assert_eq!(rise("MCGL1", 3.0).outcome, Outcome::Fired);
    assert_eq!(rise("mcgl1", 3.0).threshold, Some(3.0), "lid match ignores case");
    // A semidiurnal swing of +-1 ft around a flat river: the 24 h point difference stays under
    // the tidal floor however the phases line up.
    for phase in 0..12 {
        let w: Vec<StoredObservation> = (0..=25)
            .map(|k| {
                let at = T - H - (25 - k) * H;
                obs(at, 3.0 + (2.0 * std::f64::consts::PI * (k + phase) as f64 / 12.42).sin())
            })
            .collect();
        assert_eq!(rule_stage_rise(&with_obs(quiet("MCGL1"), w), &c).outcome, Outcome::Clear, "phase {phase}");
    }
    // Rapid forecast rise: tidal floor too.
    let mut i = quiet("MCGL1");
    i.forecast = Some(forecast("MCGL1", 3.0, 0.625, 20)); // 2.5 ft per 24 h
    assert_eq!(rule_rapid_change_forecast(&i, &c).outcome, Outcome::Clear);
    i.lid = "BTRL1".into();
    assert_eq!(rule_rapid_change_forecast(&i, &c).outcome, Outcome::Fired);
}

#[test]
fn review_rule_forecast_category_fires_on_action_and_above() {
    let c = cfg();
    // Flat forecast at 30 ft vs SMML1 action 35: clear, reporting the next threshold.
    let i = quiet("SMML1");
    let r = rule_forecast_category(&i, &c);
    assert_eq!(r.outcome, Outcome::Clear);
    assert_eq!((r.value_text.as_deref(), r.threshold), (Some("none"), Some(35.0)));
    assert!(r.explanation.contains("below action stage (35.00 ft)"), "{}", r.explanation);
    // Crest exactly 35.0 within 72 h: action, medium.
    let mut i = quiet("SMML1");
    i.forecast = Some(forecast("SMML1", 33.0, 0.25, 40)); // 35.0 at +48 h
    let r = rule_forecast_category(&i, &c);
    assert_eq!((r.outcome, r.severity, r.value_text.as_deref(), r.threshold), (Outcome::Fired, Severity::Medium, Some("action"), Some(35.0)));
    assert!((r.value.unwrap() - 36.0).abs() < 1e-9, "peak in 72 h is 33 + 12 * 0.25");
    assert_eq!(r.issued_at, Some(T - 3 * H));
    assert_eq!(r.observed_at, Some(T + 72 * H), "peak valid time");
    assert_eq!(r.evidence_ids, [format!("forecast:SMML1:{}", T - 3 * H)]);
    // Minor or above: high.
    i.forecast = Some(forecast("SMML1", 38.0, 0.25, 40));
    let r = rule_forecast_category(&i, &c);
    assert_eq!((r.severity, r.value_text.as_deref(), r.threshold), (Severity::High, Some("minor"), Some(40.0)));
    // 34.99 is not action.
    i.forecast = Some(forecast("SMML1", 34.99, 0.0, 40));
    assert_eq!(rule_forecast_category(&i, &c).outcome, Outcome::Clear);
}

#[test]
fn review_rule_forecast_category_horizon_and_past_points() {
    let c = cfg();
    let mut i = quiet("SMML1");
    // Crosses action only after 72 h: not in the horizon.
    let mut f = forecast("SMML1", 30.0, 0.0, 40);
    f.points[13].stage_ft = Some(36.0); // +78 h
    i.forecast = Some(f.clone());
    assert_eq!(rule_forecast_category(&i, &c).outcome, Outcome::Clear);
    // Exactly at +72 h: in.
    f.points[12].stage_ft = Some(36.0);
    i.forecast = Some(f.clone());
    assert_eq!(rule_forecast_category(&i, &c).outcome, Outcome::Fired);
    // A crest valid before as_of is history, not a forecast.
    let mut f = forecast("SMML1", 30.0, 0.0, 40);
    f.points[0].stage_ft = Some(36.0);
    i.forecast = Some(f);
    i.as_of = T + 1;
    assert_eq!(rule_forecast_category(&i, &c).outcome, Outcome::Clear);
    // Stored categories are ignored: thresholds known at as_of decide.
    let mut f = forecast("SMML1", 30.0, 0.0, 40);
    f.points.iter_mut().for_each(|p| p.category = Some(Category::Major));
    i.forecast = Some(f);
    i.as_of = T;
    assert_eq!(rule_forecast_category(&i, &c).outcome, Outcome::Clear);
}

#[test]
fn review_rule_forecast_category_missing_stale_and_undefined_thresholds() {
    let c = cfg();
    let mut i = quiet("SMML1");
    i.forecast = None;
    assert_eq!(rule_forecast_category(&i, &c).outcome, Outcome::Unknown);
    // Stale (36 h + 1 ms) forecast crossing major: dropped, not fired.
    let mut i = quiet("SMML1");
    i.forecast = Some(forecast("SMML1", 60.0, 0.0, 40));
    i.as_of = T - 3 * H + c.stale_forecast_ms() + 1;
    let r = rule_forecast_category(&i, &c);
    assert_eq!(r.outcome, Outcome::Unknown);
    assert!(r.explanation.contains("stale"), "{}", r.explanation);
    // -9999 everywhere: no category, never a numeric compare.
    let mut i = quiet("SMML1");
    i.forecast = Some(forecast("SMML1", 60.0, 0.0, 40));
    i.thresholds = Some(Thresholds::from_feed(-9999.0, -9999.0, -9999.0, -9999.0));
    assert_eq!(rule_forecast_category(&i, &c).outcome, Outcome::Unknown);
    i.thresholds = None;
    assert_eq!(rule_forecast_category(&i, &c).outcome, Outcome::Unknown);
    // Partial thresholds (action missing): the first defined one is the bar.
    i.thresholds = Some(Thresholds::from_feed(-9999.0, 40.0, -9999.0, 50.0));
    i.forecast = Some(forecast("SMML1", 38.0, 0.0, 40));
    let r = rule_forecast_category(&i, &c);
    assert_eq!((r.outcome, r.threshold), (Outcome::Clear, Some(40.0)));
    assert!(r.explanation.contains("below minor stage"), "{}", r.explanation);
    // No points in the horizon.
    let mut i = quiet("SMML1");
    let mut f = forecast("SMML1", 30.0, 0.0, 3);
    f.points.iter_mut().for_each(|p| p.valid_at -= 30 * DAY);
    i.forecast = Some(f);
    assert_eq!(rule_forecast_category(&i, &c).outcome, Outcome::Unknown);
}

/// KRZL1: USGS reads 1.47 ft while NWPS reads 3.92 ft at the same hour (datum offset -2.45 ft).
/// Only NWPS stage meets the NWPS thresholds, and the offset is not a conflict.
#[test]
fn review_rule_forecast_category_datum_trap_krzl1() {
    let c = cfg();
    let krzl1 = Thresholds::from_feed(28.0, 29.0, 40.0, 43.0);
    let mut i = quiet("KRZL1");
    i.window = hourly(3.65, 0.27 / 24.0, 25); // +0.27 ft in 24 h, ending at 3.92
    i.latest = i.window.last().copied();
    i.thresholds = Some(krzl1);
    let mut f = forecast("KRZL1", 3.92, 0.1, 40);
    f.points.insert(0, StoredPoint { valid_at: T - H, stage_ft: Some(3.92), flow_kcfs: None, category: None });
    i.forecast = Some(f);
    i.usgs = Some(UsgsNow { observed_at: T - H, stage_ft: Some(1.47), flow_cfs: None, flow_at: None });
    let review = evaluate(&site("KRZL1"), &i, &c);
    assert_eq!(review.status, Status::Ok, "{:#?}", review.reasons);
    assert_eq!(review.category_now, Some(Category::None));
    assert_eq!(review.usgs_stage_ft, Some(1.47));
    let gauge = review.checks.iter().find(|r| r.value_text.as_deref() == Some("gauge_vs_forecast")).unwrap();
    assert_eq!(gauge.outcome, Outcome::Clear, "NWPS gauge vs NWPS forecast; USGS stage is not compared: {}", gauge.explanation);
    // Now a site whose USGS datum sits 2.45 ft *above* NWPS, with NWPS just under action 4.0:
    // USGS 5.95 ft would read as action if compared; it is not.
    let mut i = quiet("MCGL1");
    i.thresholds = Some(Thresholds::from_feed(4.0, 6.0, 7.0, 12.0));
    i.window = hourly(3.4, 0.1 / 24.0, 25);
    i.latest = i.window.last().copied();
    i.forecast = Some(forecast("MCGL1", 3.5, 0.0, 40));
    i.usgs = Some(UsgsNow { observed_at: T - H, stage_ft: Some(5.95), flow_cfs: None, flow_at: None });
    let r = rule_forecast_category(&i, &c);
    assert_eq!((r.outcome, r.value), (Outcome::Clear, Some(3.5)));
    let review = evaluate(&site("MCGL1"), &i, &c);
    assert_eq!(review.status, Status::Ok);
    assert_eq!(review.category_now, Some(Category::None), "categoryNow is NWPS stage only");
}

#[test]
fn review_rule_active_alert() {
    let alert = |event: &str, severity: &str, seen: i64, expires: Option<i64>| AlertIn {
        ext_id: format!("urn:oid:{event}"),
        event: event.into(),
        severity: severity.into(),
        headline: Some(format!("{event} for test")),
        onset: Some(seen),
        expires,
        first_seen: seen,
    };
    let mut i = quiet("SMML1");
    let rs = rule_active_alert(&i);
    assert_eq!((rs.len(), rs[0].outcome), (1, Outcome::Clear));
    i.alerts = vec![
        alert("Flood Warning", "Severe", T - H, Some(T + DAY)),
        alert("Wind Advisory", "Moderate", T - H, None),
        alert("Flood Watch", "Moderate", T - 2 * DAY, Some(T)), // expired at T
        alert("Flash Flood Warning", "Severe", T + 1, None),   // not seen yet
    ];
    let rs = rule_active_alert(&i);
    assert_eq!(rs.iter().map(|r| (r.value_text.as_deref().unwrap(), r.severity)).collect::<Vec<_>>(), [("Flood Warning", Severity::High), ("Wind Advisory", Severity::Medium)]);
    assert!(rs.iter().all(|r| r.outcome == Outcome::Fired && r.source == "nws"));
    assert_eq!(rs[0].evidence_ids, ["alert:urn:oid:Flood Warning"]);
    assert_eq!(rs[0].link.as_deref(), Some("https://api.weather.gov/alerts/urn:oid:Flood Warning"));
    assert_eq!(rs[0].observed_at, Some(T - H));
    assert!(rs[0].explanation.contains("expires"), "{}", rs[0].explanation);
}

#[test]
fn review_rule_rapid_change_forecast() {
    let c = cfg();
    let mut i = quiet("SMML1");
    // 0.5 ft per 6 h = 2.0 ft per 24 h: fires at the threshold.
    i.forecast = Some(forecast("SMML1", 20.0, 0.5, 40));
    let r = rule_rapid_change_forecast(&i, &c);
    assert_eq!((r.outcome, r.unit), (Outcome::Fired, Some("ft/24 h")));
    assert!((r.value.unwrap() - 2.0).abs() < 1e-9);
    // 0.45 per 6 h: 1.8, clear.
    i.forecast = Some(forecast("SMML1", 20.0, 0.45, 40));
    assert_eq!(rule_rapid_change_forecast(&i, &c).outcome, Outcome::Clear);
    // Falling fast is not a rise.
    i.forecast = Some(forecast("SMML1", 20.0, -1.0, 40));
    let r = rule_rapid_change_forecast(&i, &c);
    assert_eq!(r.outcome, Outcome::Clear);
    assert!(r.value.unwrap() < 0.0);
    // A 3 ft jump in one 6 h step beyond the horizon does not count; inside it does.
    let mut f = forecast("SMML1", 20.0, 0.0, 40);
    f.points[14].stage_ft = Some(23.0); // +84 h
    i.forecast = Some(f.clone());
    assert_eq!(rule_rapid_change_forecast(&i, &c).outcome, Outcome::Clear);
    f.points[5].stage_ft = Some(23.0); // +30 h
    i.forecast = Some(f);
    assert_eq!(rule_rapid_change_forecast(&i, &c).outcome, Outcome::Fired);
    // A rise under way at as_of counts from the last point before it.
    let mut f = forecast("SMML1", 20.0, 0.0, 40);
    f.points[1].stage_ft = Some(22.5);
    i.forecast = Some(f);
    i.as_of = T + 3 * H;
    assert_eq!(rule_rapid_change_forecast(&i, &c).outcome, Outcome::Fired);
    // One point only, or no forecast: unknown.
    i.as_of = T;
    i.forecast = Some(forecast("SMML1", 20.0, 0.5, 1));
    assert_eq!(rule_rapid_change_forecast(&i, &c).outcome, Outcome::Unknown);
    i.forecast = None;
    assert_eq!(rule_rapid_change_forecast(&i, &c).outcome, Outcome::Unknown);
}

#[test]
fn review_rule_stale_input_boundaries() {
    let c = cfg();
    let mut i = quiet("SMML1");
    i.as_of = T - H + 6 * H; // newest observation exactly 6 h old
    assert!(rule_stale_input(&i, &c).iter().all(|r| r.outcome == Outcome::Clear));
    i.as_of += 1;
    let rs = rule_stale_input(&i, &c);
    assert_eq!(fired(&rs), ["stale_input"]);
    assert_eq!(rs[0].value_text.as_deref(), Some("observation"));
    assert_eq!(rs[0].threshold, Some(6.0));
    // Forecast issued T - 3 h: stale after 36 h.
    i.window.iter_mut().for_each(|o| o.observed_at += 40 * H);
    i.latest = i.window.last().copied();
    i.as_of = T - 3 * H + 36 * H;
    assert!(rule_stale_input(&i, &c).iter().all(|r| r.outcome == Outcome::Clear));
    i.as_of += 1;
    let rs = rule_stale_input(&i, &c);
    let f = rs.iter().find(|r| r.value_text.as_deref() == Some("forecast")).unwrap();
    assert_eq!((f.outcome, f.threshold, f.issued_at), (Outcome::Fired, Some(36.0), Some(T - 3 * H)));
    // Missing feeds are rule 6, not 5.
    let mut i = quiet("SMML1");
    i.forecast = None;
    i.latest = None;
    i.window.clear();
    assert!(rule_stale_input(&i, &c).is_empty());
}

#[test]
fn review_rule_missing_input_each_gap() {
    let c = cfg();
    let rs = rule_missing_input(&quiet("SMML1"), &c);
    assert_eq!((rs.len(), rs[0].outcome), (1, Outcome::Clear));
    let gaps = |i: &Inputs| rule_missing_input(i, &c).into_iter().filter(|r| r.outcome == Outcome::Fired).map(|r| r.value_text.unwrap()).collect::<Vec<_>>();
    let mut i = quiet("SMML1");
    i.latest = None;
    i.window.clear();
    i.forecast = None;
    i.thresholds = Some(Thresholds::from_feed(-9999.0, -9999.0, -9999.0, -9999.0));
    assert_eq!(gaps(&i), ["observation", "forecast", "thresholds"]);
    // Fresh newest observation without one 24 h earlier: the baseline is missing.
    let i = with_obs(quiet("SMML1"), hourly(30.0, 0.0, 10));
    assert_eq!(gaps(&i), ["baseline"]);
}

#[test]
fn review_rule_source_conflict_gauge_and_flow() {
    let c = cfg();
    // Forecast point at T - H pairs with the newest observation (also T - H).
    let mut i = quiet("SMML1");
    let mut f = forecast("SMML1", 30.0, 0.0, 40);
    f.points.insert(0, StoredPoint { valid_at: T - H, stage_ft: Some(29.25), flow_kcfs: None, category: None });
    i.forecast = Some(f.clone());
    let gauge = |i: &Inputs| rule_source_conflict(i, &c).into_iter().find(|r| r.value_text.as_deref() == Some("gauge_vs_forecast")).unwrap();
    let r = gauge(&i);
    assert_eq!(r.outcome, Outcome::Clear, "1.00 ft apart is not over 1.0: {}", r.explanation);
    f.points[0].stage_ft = Some(29.24);
    i.forecast = Some(f);
    let r = gauge(&i);
    assert_eq!(r.outcome, Outcome::Fired);
    assert!((r.value.unwrap() - 1.01).abs() < 1e-9);
    assert_eq!(r.source, "nwps-live+nwps-live");
    assert_eq!(r.evidence_ids, [reading_id("SMML1", T - H), format!("forecast:SMML1:{}", T - 3 * H)]);
    // No forecast point within 30 min of the observation: unknown, not a conflict.
    assert_eq!(gauge(&quiet("SMML1")).outcome, Outcome::Unknown);

    // Flow: Monroe, NWPS 8.18 kcfs vs USGS 1430 cfs (factor 5.7): conflict, never averaged.
    let flow = |i: &Inputs| rule_source_conflict(i, &c).into_iter().find(|r| r.unit == Some("ratio")).unwrap();
    let mut i = quiet("MLUL1");
    i.usgs_site = Some("07367005".into());
    i.latest.as_mut().unwrap().flow_kcfs = Some(8.18);
    i.usgs = Some(UsgsNow { observed_at: T - H, stage_ft: Some(18.21), flow_cfs: Some(1430.0), flow_at: Some(T - H) });
    let r = flow(&i);
    assert_eq!(r.outcome, Outcome::Fired);
    assert!((r.value.unwrap() - 8180.0 / 1430.0).abs() < 1e-9);
    assert_eq!(r.value_text.as_deref(), Some("flow: NWPS 8180 cfs vs USGS 1430 cfs"));
    assert!(r.explanation.contains("never averaged"));
    assert_eq!(r.evidence_ids, [reading_id("MLUL1", T - H), discharge_id("07367005", T - H)]);
    // Within the ratio: clear. Missing USGS flow, or readings > 1 h apart: unknown.
    i.usgs.as_mut().unwrap().flow_cfs = Some(6000.0);
    assert_eq!(flow(&i).outcome, Outcome::Clear);
    i.usgs.as_mut().unwrap().flow_at = Some(T - H - H - 1);
    assert_eq!(flow(&i).outcome, Outcome::Unknown);
    i.usgs.as_mut().unwrap().flow_cfs = None;
    assert_eq!(flow(&i).outcome, Outcome::Unknown);
}

#[test]
fn review_rule_status_and_severity_order() {
    let c = cfg();
    let r = evaluate(&site("SMML1"), &quiet("SMML1"), &c);
    assert_eq!(r.status, Status::Ok, "{:#?}", r.reasons);
    assert!(r.reasons.is_empty());
    assert_eq!(r.checks.iter().map(|x| x.rule).collect::<std::collections::BTreeSet<_>>().len(), 7, "every rule is checked");
    assert!(r.checks.windows(2).all(|w| w[0].rule <= w[1].rule), "checks in rule order");
    // Rise + crest at minor + a watch: all fire; high first, ties by rule number.
    let mut i = with_obs(quiet("SMML1"), hourly(30.0, 2.5 / 24.0, 25));
    i.forecast = Some(forecast("SMML1", 38.0, 0.25, 40));
    i.alerts = vec![AlertIn { ext_id: "w".into(), event: "Flood Watch".into(), severity: "Moderate".into(), headline: None, onset: None, expires: None, first_seen: T - H }];
    let r = evaluate(&site("SMML1"), &i, &c);
    assert_eq!(r.status, Status::Review);
    assert_eq!(r.reasons.iter().map(|x| x.rule.id()).collect::<Vec<_>>(), ["forecast_category", "stage_rise", "active_alert"]);
    assert!(r.summary.starts_with("Needs review: forecast_category, stage_rise, active_alert"), "{}", r.summary);
    assert_eq!(r.category_peak, Some(Category::Minor));
    assert!((r.change_24h_ft.unwrap() - 2.5).abs() < 1e-9);
    assert_eq!(r.active_alerts, 1);
    // Review rule plus stale forecast: still review, the staleness listed after it.
    let mut i = quiet("SMML1");
    i.alerts = vec![AlertIn { ext_id: "w".into(), event: "Flood Warning".into(), severity: "Severe".into(), headline: None, onset: None, expires: None, first_seen: T - 50 * H }];
    i.as_of = T + 40 * H;
    let r = evaluate(&site("SMML1"), &i, &c);
    assert_eq!(r.status, Status::Review);
    assert_eq!(r.reasons.iter().map(|x| x.rule.id()).collect::<Vec<_>>(), ["active_alert", "stale_input", "stale_input"]);
    // Only gaps: cannot_assess, never ok.
    let mut i = quiet("SMML1");
    i.forecast = None;
    let r = evaluate(&site("SMML1"), &i, &c);
    assert_eq!(r.status, Status::CannotAssess);
    assert!(r.summary.contains("missing_input forecast"), "{}", r.summary);
}

#[test]
fn review_rule_config_defaults_and_validation() {
    let c = ReviewCfg::default();
    assert!(c.validate().is_ok());
    let carp = crate::app::config::AppConfig::builtin("carp").unwrap();
    assert_eq!(carp.review.as_ref(), Some(&c), "spec/apps/carp.json review block = engine defaults");
    let partial: ReviewCfg = serde_json::from_str(r#"{"stageRiseFt": 1.5}"#).unwrap();
    assert_eq!((partial.stage_rise_ft, partial.stale_forecast_hours), (1.5, 36.0));
    assert!(serde_json::from_str::<ReviewCfg>(r#"{"riskFloor": 1}"#).is_err(), "unknown fields rejected");
    for bad in [
        ReviewCfg { stage_rise_ft: 0.0, ..c.clone() },
        ReviewCfg { stale_forecast_hours: f64::NAN, ..c.clone() },
        ReviewCfg { flow_conflict_ratio: 1.0, ..c.clone() },
        ReviewCfg { tidal_stage_rise_ft: 1.0, ..c.clone() },
    ] {
        assert!(bad.validate().is_err(), "{bad:?}");
    }
    // A species app may not carry a review block.
    let mut v: serde_json::Value = serde_json::from_str(crate::app::config::builtin_json("python").unwrap()).unwrap();
    v["review"] = serde_json::json!({});
    let e = crate::app::config::AppConfig::parse("python.json", &v.to_string()).unwrap_err();
    assert!(e.to_string().contains("review is for kind conditions apps only"), "{e}");
}

// ---------------------------------------------------------------------------------------------
// G2: as-of over the store
// ---------------------------------------------------------------------------------------------

/// A migrated store whose alert poller ran every 10 min from 40 days before `T` to 10 days after
/// (so "no alert" is vouched for); [`bare_conn`] has no polls.
fn conn() -> Connection {
    let c = bare_conn();
    seed_alert_polls(&c, T - 40 * DAY, T + 10 * DAY);
    c
}

fn bare_conn() -> Connection {
    let mut c = Connection::open_in_memory().unwrap();
    crate::db::migrate(&mut c, "observations").unwrap();
    c
}

const POLL_EVERY: i64 = 10 * 60_000;

/// Successful `nws-alerts` polls every [`POLL_EVERY`] in `[from, to)`, recorded 2 s after each.
fn seed_alert_polls(c: &Connection, from: i64, to: i64) {
    c.execute(
        "insert or ignore into sources (id, name, homepage, mode, cadence_s, max_latency_s) values ('nws-alerts', 'NWS alerts', 'https://api.weather.gov', 'poll', 60, 900)",
        [],
    )
    .unwrap();
    let mut st = c.prepare("insert into fetch_runs (source_id, fetched_at, received_at, status) values ('nws-alerts', ?1, ?1 + 2000, 'ok')").unwrap();
    let mut at = from;
    while at < to {
        st.execute([at]).unwrap();
        at += POLL_EVERY;
    }
}

/// 40 six-hourly points from `from`, stage `start + step * k`.
fn snap(lid: &str, issued: i64, ingested: i64, source: Source, hash: &str, (from, start, step): (i64, f64, f64)) -> NewSnapshot {
    NewSnapshot {
        site: lid.into(),
        product: "stageflow".into(),
        issued_at: issued,
        ingested_at: ingested,
        source,
        payload_hash: hash.into(),
        points: (0..40).map(|k| Point { valid_at: from + k * 6 * H, stage_ft: Some(start + step * k as f64), flow_kcfs: None }).collect(),
    }
}

/// Hourly NWPS observations for `lid` over `[from, to)`, each captured 55 min after, flat at `ft`.
fn seed_obs(c: &Connection, lid: &str, from: i64, to: i64, ft: impl Fn(i64) -> f64) {
    let mut at = from;
    while at < to {
        store::insert_observations(c, lid, Source::NwpsLive, at + 55 * 60_000, &[Observation { observed_at: at, stage_ft: Some(ft(at)), flow_kcfs: None }]).unwrap();
        at += H;
    }
}

fn warning(id: &str) -> AlertSeen {
    AlertSeen {
        ext_id: id.into(),
        event: "Flood Warning".into(),
        severity: "Severe".into(),
        headline: Some("Flood Warning (test)".into()),
        onset: None,
        expires: None,
        source: Source::NwsGridpoint,
        payload_hash: format!("{id}-v1"),
    }
}

/// SMML1 quiet on day 0 (forecast f0 flat at 30 ft); f1 issued day 1 15Z crests at 41 ft
/// (minor), captured 15:45Z; a Flood Warning seen day 2 03Z, gone at day 2 09Z.
fn seed_story(c: &Connection) -> (i64, i64) {
    let t0 = T - 12 * H; // day 0 00Z
    store::upsert_thresholds(c, "SMML1", t0 - 10 * DAY, &smml1_thresholds()).unwrap();
    seed_obs(c, "SMML1", t0 - 2 * DAY, t0 + 4 * DAY, |_| 30.0);
    let f0 = t0 + 15 * H;
    store::insert_snapshot(c, &snap("SMML1", f0, f0 + 50 * 60_000, Source::NwpsLive, "f0", (f0 + 3 * H, 30.0, 0.0)), &smml1_thresholds()).unwrap();
    let f1 = f0 + DAY;
    store::insert_snapshot(c, &snap("SMML1", f1, f1 + 45 * 60_000, Source::NwpsLive, "f1", (f1 + 3 * H, 30.0, 1.0)), &smml1_thresholds()).unwrap();
    store::record_alerts(c, "SMML1", t0 + 2 * DAY + 3 * H, &[warning("w1")]).unwrap();
    store::record_alerts(c, "SMML1", t0 + 2 * DAY + 9 * H, &[]).unwrap();
    (f0, f1)
}

#[test]
fn review_asof_same_site_two_times_differ() {
    let c = conn();
    let (f0, f1) = seed_story(&c);
    let s = site("SMML1");
    let at = |t: i64| site_review(&c, &s, t, &cfg()).unwrap();
    let day0 = at(f0 + 3 * H);
    assert_eq!(day0.status, Status::Ok, "{:#?}", day0.reasons);
    assert_eq!(day0.forecast_issued_at, Some(f0));
    // f1 issued but not captured yet (15:30Z): still f0, still ok.
    let r = at(f1 + 30 * 60_000);
    assert_eq!((r.status, r.forecast_issued_at), (Status::Ok, Some(f0)));
    // Captured at 15:45Z: f1 in force, crest within 72 h above minor.
    let r = at(f1 + 45 * 60_000);
    assert_eq!(r.status, Status::Review);
    assert_eq!(r.forecast_issued_at, Some(f1));
    assert_eq!(fired(&r.reasons), ["forecast_category", "rapid_change_forecast"]);
    assert_eq!(r.category_peak, Some(Category::Minor));
    // Day 2 03Z: + active_alert.
    let r = at(f1 + 12 * H);
    assert_eq!(fired(&r.reasons), ["forecast_category", "active_alert", "rapid_change_forecast"]);
}

#[test]
fn review_asof_never_reads_future_rows() {
    let c = conn();
    let s = site("BTRL1");
    let th = Thresholds::from_feed(30.0, 35.0, 38.0, 40.0);
    // Thresholds learnt at T; observations and a forecast captured late.
    store::upsert_thresholds(&c, "BTRL1", T, &th).unwrap();
    seed_obs(&c, "BTRL1", T - 2 * DAY, T + DAY, |_| 10.0);
    // Issued T - 3 h with a 31 ft crest, but this process only captured it at T + 2 h.
    store::insert_snapshot(&c, &snap("BTRL1", T - 3 * H, T + 2 * H, Source::NwpsLive, "late", (T, 10.0, 0.0)), &th).unwrap();
    let mut crest = snap("BTRL1", T - 3 * H, T + 2 * H, Source::NwpsLive, "late2", (T, 10.0, 0.0));
    crest.points[4].stage_ft = Some(31.0);
    store::insert_snapshot(&c, &crest, &th).unwrap();
    // An alert first polled at T + 1 h.
    store::record_alerts(&c, "BTRL1", T + H, &[warning("late")]).unwrap();
    let r = site_review(&c, &s, T + 30 * 60_000, &cfg()).unwrap();
    assert_eq!(r.status, Status::CannotAssess, "the forecast was public but not captured: {:#?}", r.reasons);
    assert_eq!(r.forecast_issued_at, None);
    assert_eq!(r.active_alerts, 0, "alert not seen yet");
    assert_eq!(r.observed_at, Some(T - H), "the T observation lands at T + 55 min");
    assert!(r.reasons.iter().any(|x| x.value_text.as_deref() == Some("forecast")));
    // Before the thresholds were known: no categories at all, even though they never changed.
    let r = site_review(&c, &s, T - 1, &cfg()).unwrap();
    assert!(r.reasons.iter().any(|x| x.value_text.as_deref() == Some("thresholds")), "{:#?}", r.reasons);
    assert_eq!(r.category_now, None);
    // Once captured: the revision with the crest, and the alert.
    let r = site_review(&c, &s, T + 2 * H, &cfg()).unwrap();
    assert_eq!(fired(&r.reasons), ["active_alert", "forecast_category", "rapid_change_forecast"], "warning (high) before action stage (medium)");
    // An archive backfill ingested a year later is knowable at its issue time (it was public).
    store::insert_snapshot(&c, &snap("BTRL1", T - 30 * H, T + 365 * DAY, Source::IemArchive, "arch", (T - 27 * H, 10.0, 0.0)), &th).unwrap();
    let r = site_review(&c, &s, T + 30 * 60_000, &cfg()).unwrap();
    assert_eq!((r.status, r.forecast_issued_at, r.forecast_source), (Status::Ok, Some(T - 30 * H), Some(Source::IemArchive)));
    // Nothing used in any review is newer than its as-of time.
    for t in [T - DAY, T, T + 30 * 60_000, T + 2 * H] {
        let i = load_inputs(&c, &s, t).unwrap();
        assert!(i.window.iter().chain(i.latest.iter()).all(|o| o.observed_at <= t && o.ingested_at <= t));
        assert!(i.forecast.iter().all(|f| f.issued_at <= t && (f.source.backfilled() || f.ingested_at <= t)));
        assert!(i.alerts.iter().all(|a| a.first_seen <= t));
    }
}

#[test]
fn review_asof_history_returns_flips_with_reasons() {
    let c = conn();
    let (f0, f1) = seed_story(&c);
    let s = site("SMML1");
    let from = f0 + 3 * H;
    let to = f1 + 2 * DAY;
    let h = history(&c, &s, from, to, &cfg()).unwrap();
    assert_eq!(h.initial.status, Status::Ok);
    let flips: Vec<(i64, Status, Status)> = h.transitions.iter().map(|t| (t.at, t.from, t.to)).collect();
    // Enters review the moment f1 is captured. Leaves it when the crest passes out of the
    // horizon... it does not here (f1 keeps rising for 10 days), so the next flip is the
    // forecast going stale 36 h after issue: no review rule can fire, so cannot_assess.
    assert_eq!(flips[0], (f1 + 45 * 60_000, Status::Ok, Status::Review), "{flips:?}");
    assert_eq!(h.transitions[0].reasons.iter().map(|r| r.rule.id()).collect::<Vec<_>>(), ["forecast_category", "rapid_change_forecast"]);
    let leave = h.transitions.iter().find(|t| t.from == Status::Review).expect("left review");
    assert_eq!((leave.at, leave.to), (f1 + 36 * H + 1, Status::CannotAssess), "{flips:?}");
    assert_eq!(leave.cleared.iter().map(|r| r.id()).collect::<Vec<_>>(), ["forecast_category", "rapid_change_forecast"]);
    assert!(leave.reasons.iter().any(|r| r.rule == Rule::StaleInput && r.value_text.as_deref() == Some("forecast")));
    assert_eq!(flips.len(), 2, "{flips:?}");
    assert!(h.evaluations > 10);
    // A window wholly before f1: no flips.
    let h = history(&c, &s, from, f1, &cfg()).unwrap();
    assert!(h.transitions.is_empty());
    // A 7-day window over a busy site stays quick (every input change is evaluated).
    let start = std::time::Instant::now();
    let h = history(&c, &s, f0 - 2 * DAY, f0 + 5 * DAY, &cfg()).unwrap();
    let ms = start.elapsed().as_millis();
    println!("REVIEW-HISTORY evaluations={} ms={ms}", h.evaluations);
    assert!(ms < 5000, "{ms} ms");
}

/// The largest `reviewHistory` window (31 days) at a site with a daily 15-day 6-hourly forecast
/// and hourly observations. Prints `REVIEW-HISTORY-31D evaluations=<n> ms=<n>`.
#[test]
fn review_asof_history_31_days_perf() {
    let c = conn();
    let th = smml1_thresholds();
    store::upsert_thresholds(&c, "SMML1", T - 40 * DAY, &th).unwrap();
    seed_obs(&c, "SMML1", T - 33 * DAY, T, |at| 30.0 + ((at / H) % 48) as f64 * 0.1);
    for d in 0..33 {
        let issued = T - 33 * DAY + d * DAY + 15 * H;
        store::insert_snapshot(&c, &snap("SMML1", issued, issued + H, Source::NwpsLive, &format!("d{d}"), (issued + 3 * H, 30.0 + (d % 7) as f64, 0.2)), &th).unwrap();
    }
    let start = std::time::Instant::now();
    let h = history(&c, &site("SMML1"), T - 31 * DAY, T, &cfg()).unwrap();
    let ms = start.elapsed().as_millis();
    println!("REVIEW-HISTORY-31D evaluations={} transitions={} ms={ms}", h.evaluations, h.transitions.len());
    assert!(!h.transitions.is_empty());
    assert!(ms < 10_000, "{ms} ms");
}

#[test]
fn review_asof_board_ranks_and_counts() {
    let c = conn();
    let (_, f1) = seed_story(&c);
    // BTRL1: fresh and quiet. KRZL1: nothing at all.
    store::upsert_thresholds(&c, "BTRL1", T - 10 * DAY, &Thresholds::from_feed(30.0, 35.0, 38.0, 40.0)).unwrap();
    seed_obs(&c, "BTRL1", T - 2 * DAY, T + 4 * DAY, |_| 8.0);
    store::insert_snapshot(&c, &snap("BTRL1", f1, f1 + H, Source::NwpsLive, "b", (f1 + 3 * H, 8.0, 0.0)), &Thresholds::default()).unwrap();
    let sites = [site("KRZL1"), site("BTRL1"), site("SMML1")];
    let b = board(&c, &sites, f1 + 12 * H, &cfg()).unwrap();
    assert_eq!(b.sites.iter().map(|s| (s.site.lid.as_str(), s.status)).collect::<Vec<_>>(), [("SMML1", Status::Review), ("KRZL1", Status::CannotAssess), ("BTRL1", Status::Ok)]);
    assert_eq!((b.review, b.cannot_assess, b.ok), (1, 1, 1));
    assert_eq!(b.as_of, f1 + 12 * H);
    // The same board before f1 was captured: nothing in review.
    let b = board(&c, &sites, f1, &cfg()).unwrap();
    assert_eq!(b.review, 0);
}

// ---------------------------------------------------------------------------------------------
// G3: honesty
// ---------------------------------------------------------------------------------------------

#[test]
fn review_honesty_outage_gives_cannot_assess_not_ok() {
    let c = conn();
    let s = site("SMML1");
    store::upsert_thresholds(&c, "SMML1", T - 10 * DAY, &smml1_thresholds()).unwrap();
    // Gauge reports until T, then goes silent (outage).
    seed_obs(&c, "SMML1", T - 2 * DAY, T, |_| 30.0);
    store::insert_snapshot(&c, &snap("SMML1", T - 3 * H, T - 2 * H, Source::NwpsLive, "f", (T, 30.0, 0.0)), &smml1_thresholds()).unwrap();
    let at = |t: i64| site_review(&c, &s, t, &cfg()).unwrap();
    assert_eq!(at(T).status, Status::Ok);
    // Newest observation (T - 1 h) is 6 h old at T + 5 h: still ok. 1 ms later: cannot_assess.
    assert_eq!(at(T + 5 * H).status, Status::Ok);
    let r = at(T + 5 * H + 1);
    assert_eq!(r.status, Status::CannotAssess, "{:#?}", r.reasons);
    assert_eq!(r.observation_freshness, Freshness::Stale);
    assert!(r.summary.contains("stale_input observation"), "{}", r.summary);
    // Gauge back, forecast feed down: issued T - 3 h, stale from T + 33 h.
    seed_obs(&c, "SMML1", T, T + 3 * DAY, |_| 30.0);
    assert_eq!(at(T + 33 * H).status, Status::Ok);
    let r = at(T + 33 * H + 1);
    assert_eq!(r.status, Status::CannotAssess);
    assert_eq!(r.forecast_freshness, Freshness::Stale);
    // Nothing stored at all: cannot_assess with every gap named.
    let r = site_review(&c, &site("BXAL1"), T, &cfg()).unwrap();
    assert_eq!(r.status, Status::CannotAssess);
    assert_eq!(r.reasons.iter().filter_map(|x| x.value_text.as_deref()).collect::<Vec<_>>(), ["observation", "forecast", "thresholds"]);
    assert_eq!((r.observation_freshness, r.forecast_freshness), (Freshness::Missing, Freshness::Missing));
}

const FORBIDDEN: [&str; 5] = ["risk", "probab", "catch", "abundan", "safe"];

/// Field names and enum values of the review types in the served schema, and every text the
/// engine writes, carry no risk, probability, catch, abundance or safety claim.
#[test]
fn review_honesty_schema_field_names() {
    use async_graphql::parser::{parse_schema, types::{TypeKind, TypeSystemDefinition}};
    let sdl = crate::graphql::schema().sdl();
    let doc = parse_schema(&sdl).unwrap();
    let review_types = ["ReviewStatus", "ReviewSeverity", "ReviewOutcome", "ReviewReason", "SiteReview", "ReviewBoard", "ReviewTransition", "ReviewHistory"];
    let mut seen = Vec::new();
    for def in doc.definitions {
        let TypeSystemDefinition::Type(t) = def else { continue };
        let name = t.node.name.node.to_string();
        let names: Vec<String> = match &t.node.kind {
            TypeKind::Object(o) if name == "Query" => o
                .fields
                .iter()
                .filter(|f| f.node.name.node.contains("eview"))
                .flat_map(|f| std::iter::once(f.node.name.node.to_string()).chain(f.node.arguments.iter().map(|a| a.node.name.node.to_string())))
                .collect(),
            _ if !review_types.contains(&name.as_str()) => continue,
            TypeKind::Object(o) => o.fields.iter().map(|f| f.node.name.node.to_string()).collect(),
            TypeKind::Enum(e) => e.values.iter().map(|v| v.node.value.node.to_string()).collect(),
            _ => continue,
        };
        seen.push(name.clone());
        for n in names {
            let lower = n.to_ascii_lowercase();
            assert!(!FORBIDDEN.iter().any(|w| lower.contains(w)), "{name}.{n}");
        }
    }
    seen.sort();
    let mut want: Vec<String> = review_types.iter().map(|s| s.to_string()).chain(["Query".to_string()]).collect();
    want.sort();
    assert_eq!(seen, want, "the check saw every review type");
    // The exact SiteReview and ReviewReason fields (a rename or addition must pass this test).
    let fields = |ty: &str| -> Vec<String> {
        let doc = parse_schema(&sdl).unwrap();
        doc.definitions
            .into_iter()
            .find_map(|d| match d {
                TypeSystemDefinition::Type(t) if t.node.name.node == ty => match &t.node.kind {
                    TypeKind::Object(o) => Some(o.fields.iter().map(|f| f.node.name.node.to_string()).collect()),
                    _ => None,
                },
                _ => None,
            })
            .unwrap()
    };
    assert_eq!(
        fields("ReviewReason"),
        ["rule", "outcome", "severity", "value", "valueText", "threshold", "unit", "source", "observedAt", "issuedAt", "link", "evidenceIds", "explanation"]
    );
    assert_eq!(
        fields("SiteReview"),
        [
            "site", "location", "name", "asOf", "status", "summary", "reasons", "checks", "stageFt", "observedAt", "change24hFt", "categoryNow",
            "peakStageFt", "peakAt", "categoryPeak", "forecastIssuedAt", "forecastSource", "observationFreshness", "forecastFreshness",
            "activeAlerts", "usgsStageFt", "usgsObservedAt", "usgsFlowCfs", "usgsFlowAt", "tidal", "lowWater", "lowThresholdFt",
            "alertsCheckedAt", "alertsCheckRunId", "alertsCheckCurrent"
        ]
    );
    // Texts: every check of a busy review and of an empty one.
    let mut i = with_obs(quiet("MLUL1"), hourly(30.0, 0.2, 25));
    i.forecast = Some(forecast("MLUL1", 38.0, 0.6, 40));
    i.alerts = vec![AlertIn { ext_id: "a".into(), event: "Flood Warning".into(), severity: "Severe".into(), headline: Some("h".into()), onset: None, expires: None, first_seen: T - H }];
    i.latest.as_mut().unwrap().flow_kcfs = Some(8.18);
    i.usgs = Some(UsgsNow { observed_at: T - H, stage_ft: Some(18.2), flow_cfs: Some(1430.0), flow_at: Some(T - H) });
    let mut empty = quiet("BXAL1");
    empty.latest = None;
    empty.window.clear();
    empty.forecast = None;
    empty.thresholds = None;
    for r in [evaluate(&site("MLUL1"), &i, &cfg()), evaluate(&site("BXAL1"), &empty, &cfg())] {
        for text in r.checks.iter().map(|x| x.explanation.to_ascii_lowercase()).chain([r.summary.to_ascii_lowercase()]) {
            assert!(!FORBIDDEN.iter().any(|w| text.contains(w)), "{text}");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// G4: replay scene from fixtures
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scene {
    scene: String,
    site: SceneSite,
    thresholds: SceneThresholds,
    observations: SceneObs,
    forecasts: Vec<SceneForecast>,
    alert_polls: Vec<ScenePoll>,
    checkpoints: std::collections::BTreeMap<String, String>,
    expect: std::collections::BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct SceneSite {
    lid: String,
    location: String,
    name: String,
    usgs: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SceneThresholds {
    ingested_at: String,
    action_ft: f64,
    minor_ft: f64,
    moderate_ft: f64,
    major_ft: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SceneObs {
    source: String,
    from: String,
    hours: i64,
    start_ft: f64,
    ft_per_hour: f64,
    lag_minutes: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SceneForecast {
    source: String,
    payload_hash: String,
    issued_at: String,
    ingested_at: String,
    valid_from: String,
    step_hours: i64,
    points: i64,
    start_ft: f64,
    rise_ft_per_step: f64,
    rising_steps: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScenePoll {
    seen_at: String,
    alerts: Vec<SceneAlert>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SceneAlert {
    ext_id: String,
    event: String,
    severity: String,
    headline: Option<String>,
    onset: Option<String>,
    expires: Option<String>,
}

fn ts(s: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(s).unwrap_or_else(|e| panic!("{s}: {e}")).timestamp_millis()
}

/// Load a scene into the store through the C3 write side (what the C4 adapters call).
fn seed_scene(c: &Connection, s: &Scene) {
    // The alert poller ran through the scene (its empty polls are what "no alert" rests on).
    let last = s.checkpoints.values().map(|t| ts(t)).max().unwrap_or(0);
    seed_alert_polls(c, ts(&s.observations.from) - DAY, last + DAY);
    let th = Thresholds::from_feed(s.thresholds.action_ft, s.thresholds.minor_ft, s.thresholds.moderate_ft, s.thresholds.major_ft);
    let lid = s.site.lid.as_str();
    store::upsert_thresholds(c, lid, ts(&s.thresholds.ingested_at), &th).unwrap();
    let o = &s.observations;
    let source = Source::from_db(&o.source).unwrap();
    for k in 0..o.hours {
        let at = ts(&o.from) + k * H;
        let ob = Observation { observed_at: at, stage_ft: Some(o.start_ft + o.ft_per_hour * k as f64), flow_kcfs: None };
        store::insert_observations(c, lid, source, at + o.lag_minutes * 60_000, &[ob]).unwrap();
    }
    for f in &s.forecasts {
        let points = (0..f.points)
            .map(|k| Point {
                valid_at: ts(&f.valid_from) + k * f.step_hours * H,
                stage_ft: Some(f.start_ft + f.rise_ft_per_step * k.min(f.rising_steps) as f64),
                flow_kcfs: None,
            })
            .collect();
        let snap = NewSnapshot {
            site: lid.into(),
            product: "stageflow".into(),
            issued_at: ts(&f.issued_at),
            ingested_at: ts(&f.ingested_at),
            source: Source::from_db(&f.source).unwrap(),
            payload_hash: f.payload_hash.clone(),
            points,
        };
        store::insert_snapshot(c, &snap, &th).unwrap();
    }
    for p in &s.alert_polls {
        let alerts: Vec<AlertSeen> = p
            .alerts
            .iter()
            .map(|a| AlertSeen {
                ext_id: a.ext_id.clone(),
                event: a.event.clone(),
                severity: a.severity.clone(),
                headline: a.headline.clone(),
                onset: a.onset.as_deref().map(ts),
                expires: a.expires.as_deref().map(ts),
                source: Source::NwsGridpoint,
                payload_hash: format!("{}:{}", a.ext_id, a.event),
            })
            .collect();
        store::record_alerts(c, lid, ts(&p.seen_at), &alerts).unwrap();
    }
}

/// `ok`, or `review:<fired rule ids, severity order>`, or `cannot_assess:<gaps>`.
fn label(r: &SiteReview) -> String {
    let mut ids: Vec<&str> = Vec::new();
    for x in &r.reasons {
        if !ids.contains(&x.rule.id()) {
            ids.push(x.rule.id());
        }
    }
    if ids.is_empty() {
        r.status.id().to_string()
    } else {
        format!("{}:{}", r.status.id(), ids.join(","))
    }
}

/// G4: the board at three knowledge times of the rise scene. Prints
/// `REVIEW-SCENE t1=ok t2=review:forecast_category t3=review:forecast_category,active_alert`.
#[test]
fn review_scene() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/carp_scene");
    let mut scenes: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path().join("scene.json")).filter(|p| p.exists()).collect();
    scenes.sort();
    assert!(!scenes.is_empty(), "no scene under {}", dir.display());
    for path in scenes {
        let scene: Scene = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let c = conn();
        seed_scene(&c, &scene);
        let s = SiteRef { lid: scene.site.lid.clone(), location: scene.site.location.clone(), name: scene.site.name.clone(), usgs: scene.site.usgs.clone() };
        let mut got = Vec::new();
        for (key, at) in &scene.checkpoints {
            let b = board(&c, std::slice::from_ref(&s), ts(at), &cfg()).unwrap();
            let r = &b.sites[0];
            // Every reason names its source and links to it.
            assert!(r.reasons.iter().all(|x| !x.source.is_empty() && x.link.is_some() && !x.evidence_ids.is_empty()), "{key}: {:#?}", r.reasons);
            assert_eq!(&label(r), &scene.expect[key], "{} {key}: {:#?}", scene.scene, r.checks);
            got.push(format!("{key}={}", label(r)));
        }
        println!("REVIEW-SCENE {}", got.join(" "));
        // History over the scene names both flips' causes in order.
        let first = ts(&scene.checkpoints["t1"]);
        let last = ts(&scene.checkpoints["t3"]);
        let h = history(&c, &s, first, last, &cfg()).unwrap();
        assert_eq!(h.transitions.len(), 1, "{:#?}", h.transitions);
        assert_eq!((h.transitions[0].from, h.transitions[0].to), (Status::Ok, Status::Review));
        assert_eq!(h.transitions[0].at, ts(&scene.forecasts[1].ingested_at), "entered review when the second issuance was captured");
    }
}

// ---------------------------------------------------------------------------------------------
// E1 G3: follow-ups (flow conflict from stored USGS discharge, low water, alert poll checks)
// ---------------------------------------------------------------------------------------------

/// SMML1 quiet around `T` (hourly NWPS stage near 30 ft with `flow_kcfs`, a flat forecast,
/// thresholds), as the C4 adapters store it.
fn seed_quiet_site(c: &Connection, lid: &str, flow_kcfs: Option<f64>) {
    store::upsert_thresholds(c, lid, T - 10 * DAY, &smml1_thresholds()).unwrap();
    let mut at = T - 2 * DAY;
    while at < T {
        let ob = Observation { observed_at: at, stage_ft: Some(30.0), flow_kcfs };
        store::insert_observations(c, lid, Source::NwpsLive, at + 55 * 60_000, &[ob]).unwrap();
        at += H;
    }
    store::insert_snapshot(c, &snap(lid, T - 3 * H, T - 2 * H, Source::NwpsLive, "q", (T, 30.0, 0.0)), &smml1_thresholds()).unwrap();
}

/// A USGS `discharge_cfs` reading at `at` for station `site` (as the OGC adapter writes it).
fn seed_usgs_discharge(c: &Connection, site: &str, at: i64, cfs: f64) {
    c.execute(
        "insert or ignore into sources (id, name, homepage, mode, cadence_s, max_latency_s) values ('usgs', 'USGS', 'https://waterdata.usgs.gov', 'poll', 900, 7200)",
        [],
    )
    .unwrap();
    c.execute(
        "insert or ignore into stations (source_id, ext_id, name, lat, lon, kind) values ('usgs', ?1, 'test gage', 30.98, -91.8, 'gage')",
        [site],
    )
    .unwrap();
    c.execute(
        "insert into readings (station_id, param, value, flag, observed_at, origin)
         select id, 'discharge_cfs', ?2, 'ok', ?3, 'measured' from stations where source_id = 'usgs' and ext_id = ?1",
        rusqlite::params![site, cfs, at],
    )
    .unwrap();
}

/// (a) The flow half of `source_conflict` reads USGS `discharge_cfs` from the store and NWPS
/// flow (kcfs) from the forecast store, fires above the configured ratio (strictly), names both
/// sources and both values, and never blends them.
#[test]
fn review_followup_flow_conflict_from_stored_discharge() {
    let s = SiteRef { usgs: Some("07381490".into()), ..site("SMML1") };
    let flow = |c: &Connection, ratio: f64| {
        let cfg = ReviewCfg { flow_conflict_ratio: ratio, ..cfg() };
        let r = site_review(c, &s, T, &cfg).unwrap();
        let check = r.checks.iter().find(|x| x.rule == Rule::SourceConflict && x.unit == Some("ratio")).cloned().unwrap();
        (r, check)
    };
    // NWPS 200 kcfs at T - 1 h; USGS 100,000 cfs 15 min later: a factor of 2.
    let c = conn();
    seed_quiet_site(&c, "SMML1", Some(200.0));
    seed_usgs_discharge(&c, "07381490", T - 45 * 60_000, 100_000.0);
    let (r, check) = flow(&c, 1.5);
    assert_eq!(check.outcome, Outcome::Fired, "{}", check.explanation);
    assert_eq!(r.status, Status::Review);
    assert!((check.value.unwrap() - 2.0).abs() < 1e-9);
    assert_eq!(check.source, "nwps-live+usgs");
    assert_eq!(check.value_text.as_deref(), Some("flow: NWPS 200000 cfs vs USGS 100000 cfs"));
    assert!(check.explanation.contains("200.00 kcfs") && check.explanation.contains("USGS discharge 100000 cfs") && check.explanation.contains("never averaged"));
    assert!(!check.explanation.contains("150000"), "no blended value: {}", check.explanation);
    assert_eq!(check.evidence_ids, [reading_id("SMML1", T - H), discharge_id("07381490", T - 45 * 60_000)]);
    assert_eq!((r.usgs_flow_cfs, r.usgs_flow_at), (Some(100_000.0), Some(T - 45 * 60_000)));
    // Exactly at the configured ratio: not over it, clear; just under: fires.
    assert_eq!(flow(&c, 2.0).1.outcome, Outcome::Clear);
    assert_eq!(flow(&c, 1.99).1.outcome, Outcome::Fired);
    assert_eq!(flow(&c, 2.5).1.outcome, Outcome::Clear);
    // USGS discharge more than 1 h from the NWPS observation: not compared.
    let c = conn();
    seed_quiet_site(&c, "SMML1", Some(200.0));
    seed_usgs_discharge(&c, "07381490", T - 3 * H, 100_000.0);
    let (r, check) = flow(&c, 1.5);
    assert_eq!((check.outcome, r.status), (Outcome::Unknown, Status::Ok), "{}", check.explanation);
    // History sees the discharge arrive (a flip into review at its observation time).
    let c = conn();
    seed_quiet_site(&c, "SMML1", Some(200.0));
    // At T - 1 h the newest knowable NWPS observation is T - 2 h (captured T - 65 min): the
    // discharge observed then pairs with it, and nothing else changes at that instant.
    seed_usgs_discharge(&c, "07381490", T - H, 100_000.0);
    let h = history(&c, &s, T - 2 * H, T, &cfg()).unwrap();
    assert_eq!(h.transitions.iter().map(|t| (t.at, t.to)).collect::<Vec<_>>(), [(T - H, Status::Review)], "{:#?}", h.transitions);
}

/// (b) `lowWater` from the NWPS low-water threshold: parsed from the gauge body, stored with the
/// categories, and stage at or below it is the `low_threshold` state on SiteReview and SiteStatus.
#[test]
fn review_followup_low_water_from_nwps_low_threshold() {
    let gauge = |lid: &str| -> serde_json::Value { serde_json::from_slice(&crate::ingest::poll::physical::testing::fixture(&format!("nwps/{lid}.json"))).unwrap() };
    let mlul1 = crate::ingest::poll::nwps::thresholds(&gauge("MLUL1"));
    assert_eq!(mlul1.low_ft, Some(19.0), "MLUL1 lowThreshold 19 ft (its feed says ObservedFloodCategory low_threshold)");
    assert_eq!(crate::ingest::poll::nwps::thresholds(&gauge("SMML1")).low_ft, None, "lowThreshold null");
    assert!(Thresholds::default().with_low(Some(19.0)).is_empty(), "low water is not a flood category");
    let c = conn();
    store::upsert_thresholds(&c, "MLUL1", T - 10 * DAY, &mlul1).unwrap();
    let s = site("MLUL1");
    let obs_at = |c: &Connection, at: i64, ft: f64| {
        store::insert_observations(c, "MLUL1", Source::NwpsLive, at + 55 * 60_000, &[Observation { observed_at: at, stage_ft: Some(ft), flow_kcfs: None }]).unwrap();
    };
    obs_at(&c, T - 3 * H, 18.6);
    let r = site_review(&c, &s, T, &cfg()).unwrap();
    assert_eq!((r.low_water, r.low_threshold_ft), (Some(true), Some(19.0)));
    assert_eq!(crate::forecast::query::status_at(&c, "MLUL1", T, 1.0).unwrap().low_water, Some(true));
    assert_eq!(to_json(&r)["lowWater"], true);
    obs_at(&c, T - 2 * H, 19.0);
    assert_eq!(site_review(&c, &s, T, &cfg()).unwrap().low_water, Some(true), "at the threshold counts");
    obs_at(&c, T - H, 19.4);
    assert_eq!(site_review(&c, &s, T, &cfg()).unwrap().low_water, Some(false));
    // A changed threshold is a new row; the as-of view uses the one known then.
    store::upsert_thresholds(&c, "MLUL1", T + H, &mlul1.with_low(Some(20.0))).unwrap();
    assert_eq!(site_review(&c, &s, T, &cfg()).unwrap().low_water, Some(false));
    assert_eq!(site_review(&c, &s, T + 2 * H, &cfg()).unwrap().low_water, Some(true));
    // No low-water threshold: unknown, not false.
    assert_eq!(site_review(&c, &site("BXAL1"), T, &cfg()).unwrap().low_water, None);
}

/// (c) Alert checks: every poll (empty ones included) is a `fetch_runs` row; "no alert" cites the
/// newest successful poll ("checked at T"); a poller silent for over 15 min, or one that never
/// succeeded, makes the alert check unknown and the site cannot_assess instead of ok.
#[test]
fn review_followup_alert_check_dead_poller_is_cannot_assess() {
    let s = site("SMML1");
    // Never polled.
    let c = bare_conn();
    seed_quiet_site(&c, "SMML1", None);
    let r = site_review(&c, &s, T, &cfg()).unwrap();
    let alert = r.checks.iter().find(|x| x.rule == Rule::ActiveAlert).unwrap();
    assert_eq!((alert.outcome, r.status), (Outcome::Unknown, Status::CannotAssess), "{}", alert.explanation);
    assert!(alert.explanation.contains("no recorded poll"), "{}", alert.explanation);
    assert!(r.summary.contains("active_alert unknown"), "{}", r.summary);
    let st = crate::forecast::query::status_at(&c, "SMML1", T, 1.0).unwrap();
    assert_eq!((st.active_alerts, st.alert_check.as_ref()), (0, None));

    // Polled until T - 1 h, then dead.
    seed_alert_polls(&c, T - DAY, T - H);
    let last = T - H - POLL_EVERY;
    let r = site_review(&c, &s, T, &cfg()).unwrap();
    let alert = r.checks.iter().find(|x| x.rule == Rule::ActiveAlert).unwrap();
    assert_eq!((alert.outcome, r.status), (Outcome::Unknown, Status::CannotAssess), "{}", alert.explanation);
    assert!(alert.explanation.contains(&iso(last)) && alert.explanation.contains("over the 15 min limit"), "{}", alert.explanation);
    let run: i64 = c.query_row("select id from fetch_runs where fetched_at = ?1", [last], |r| r.get(0)).unwrap();
    assert_eq!(alert.evidence_ids, [format!("fetch:{run}")]);
    assert_eq!(r.alert_check.as_ref().and_then(|c| c.ok_at), Some(last));
    assert!(!to_json(&r)["alertsCheckCurrent"].as_bool().unwrap());
    // Within 15 min of the last poll it vouches: ok, "checked at".
    let r = site_review(&c, &s, last + 15 * 60_000, &cfg()).unwrap();
    let alert = r.checks.iter().find(|x| x.rule == Rule::ActiveAlert).unwrap();
    assert_eq!((alert.outcome, r.status), (Outcome::Clear, Status::Ok), "{}", alert.explanation);
    assert!(alert.explanation.contains(&format!("checked at {}", iso(last))), "{}", alert.explanation);
    assert_eq!(alert.evidence_ids, [format!("fetch:{run}")]);
    let st = crate::forecast::query::status_at(&c, "SMML1", last + 60_000, 1.0).unwrap();
    assert!(st.alert_check.as_ref().is_some_and(|k| k.current(last + 60_000) && k.ok_at == Some(last)));
    // History: ok, then cannot_assess 15 min after the last poll.
    let h = history(&c, &s, T - 90 * 60_000, T, &cfg()).unwrap();
    assert_eq!(h.initial.status, Status::Ok, "{:#?}", h.initial.reasons);
    assert_eq!(h.transitions.iter().map(|t| (t.at, t.from, t.to)).collect::<Vec<_>>(), [(last + 15 * 60_000 + 1, Status::Ok, Status::CannotAssess)]);

    // A failing poll after a recent success: the success still vouches, the failure is named.
    c.execute("insert into fetch_runs (source_id, fetched_at, received_at, status, error) values ('nws-alerts', ?1, ?1, 'error', 'HTTP 503')", [last + 60_000]).unwrap();
    let r = site_review(&c, &s, last + 2 * 60_000, &cfg()).unwrap();
    let alert = r.checks.iter().find(|x| x.rule == Rule::ActiveAlert).unwrap();
    assert_eq!(alert.outcome, Outcome::Clear);
    assert!(alert.explanation.contains("newest poll") && alert.explanation.contains("failed"), "{}", alert.explanation);
    // Only failures for 15 min: unknown, citing the failed poll.
    let r = site_review(&c, &s, last + 16 * 60_000, &cfg()).unwrap();
    let alert = r.checks.iter().find(|x| x.rule == Rule::ActiveAlert).unwrap();
    assert_eq!(alert.outcome, Outcome::Unknown);
    assert!(alert.explanation.contains("(error)"), "{}", alert.explanation);
    // An alert in effect fires whatever the poller's state.
    store::record_alerts(&c, "SMML1", T - 2 * H, &[warning("w9")]).unwrap();
    let r = site_review(&c, &s, T, &cfg()).unwrap();
    assert_eq!(r.status, Status::Review);
    assert_eq!(r.active_alerts, 1);
}
