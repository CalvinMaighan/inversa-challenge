//! Carp "needs review" engine (gates/leaf-C5.md, docs/APPS.md carp "Output and boundaries").
//!
//! Output per site is a status (`review`, `ok`, `cannot_assess`) with specific reasons and their
//! sources. It is never a score of abundance, catch, access or trip safety: the feeds cannot
//! establish any of those.
//!
//! Inputs come only from the C3 forecast store (`crate::forecast`), read as of `t`: NWPS observed
//! stage, the NWPS forecast in force, the NWPS thresholds known then, and the NWS alert versions
//! seen by then. Nothing ingested after `t` is read. USGS stage is loaded for display only and is
//! never compared with flood thresholds or with NWPS stage (datums differ: KRZL1 USGS 1.47 ft vs
//! NWPS 3.92 ft at the same hour).
//!
//! Rules (each a pure function over [`Inputs`]):
//! 1. `stage_rise`: NWPS observed rise over 24 h at or above `stageRiseFt` (tidal sites use the
//!    larger `tidalStageRiseFt` noise floor).
//! 2. `forecast_category`: forecast peak within the horizon at action stage or above (NWPS stage
//!    against NWPS thresholds known at `t`; stored point categories are not trusted because a
//!    backfilled row was categorised with thresholds fetched later).
//! 3. `active_alert`: an NWS alert version in effect at `t` for the site.
//! 4. `rapid_change_forecast`: forecast rise within any 24 h of the horizon at or above
//!    `rapidRiseFtPer24h` (tidal: `tidalRapidRiseFtPer24h`).
//! 5. `stale_input`: observation older than `staleObservationHours` or forecast issued more than
//!    `staleForecastHours` ago.
//! 6. `missing_input`: no observation, no forecast, no thresholds, or no observation 24 h before
//!    the newest one (so the 24 h change cannot be computed).
//! 7. `source_conflict`: NWPS gauge vs NWPS forecast stage differ by more than `conflictFt` at the
//!    observation time, or NWPS vs USGS flow differ by more than `flowConflictRatio`. Flows are
//!    compared, never blended.
//!
//! Status: `review` when any of 1-4, 7 fires; otherwise `cannot_assess` when 5 or 6 fires (an
//! `ok` would be a guess); otherwise `ok`.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::forecast::query::{self, iso, Freshness, HOUR_MS, OBS_FRESH_MS, PAIR_WINDOW_MS};
use crate::forecast::store::thresholds_asof;
use crate::forecast::{Category, Snapshot, Source, StoredObservation, Thresholds};

#[cfg(test)]
mod tests;

/// The 24 h baseline observation may sit this far from `newest - 24 h`.
pub const BASELINE_TOLERANCE_MS: i64 = HOUR_MS;
/// USGS and NWPS flows pair when observed at most this far apart.
pub const FLOW_PAIR_MS: i64 = HOUR_MS;
/// `reviewHistory` default and maximum windows.
pub const HISTORY_DEFAULT_MS: i64 = 7 * 24 * HOUR_MS;
pub const HISTORY_MAX_MS: i64 = 31 * 24 * HOUR_MS;
const FEET_PER_METRE: f64 = 1.0 / 0.3048;
/// Float slack for "at or above" comparisons of differences (2.0 ft read as 1.9999999).
const EPS: f64 = 1e-9;

/// `review` block of a conditions app's config (`spec/apps/carp.json`). Every field has a
/// default, so the block may be partial or absent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct ReviewCfg {
    pub stage_rise_ft: f64,
    /// NWPS ids whose stage carries tide (Morgan City): larger noise floors apply.
    pub tidal_sites: Vec<String>,
    pub tidal_stage_rise_ft: f64,
    pub forecast_horizon_hours: f64,
    pub rapid_rise_ft_per_24h: f64,
    pub tidal_rapid_rise_ft_per_24h: f64,
    pub stale_observation_hours: f64,
    pub stale_forecast_hours: f64,
    pub conflict_ft: f64,
    pub flow_conflict_ratio: f64,
}

impl Default for ReviewCfg {
    fn default() -> Self {
        ReviewCfg {
            stage_rise_ft: 2.0,
            tidal_sites: vec!["MCGL1".into()],
            tidal_stage_rise_ft: 3.0,
            forecast_horizon_hours: 72.0,
            rapid_rise_ft_per_24h: 2.0,
            tidal_rapid_rise_ft_per_24h: 3.0,
            stale_observation_hours: 6.0,
            stale_forecast_hours: 36.0,
            conflict_ft: 1.0,
            flow_conflict_ratio: 1.5,
        }
    }
}

impl ReviewCfg {
    pub fn validate(&self) -> Result<(), String> {
        for (name, v) in [
            ("stageRiseFt", self.stage_rise_ft),
            ("tidalStageRiseFt", self.tidal_stage_rise_ft),
            ("forecastHorizonHours", self.forecast_horizon_hours),
            ("rapidRiseFtPer24h", self.rapid_rise_ft_per_24h),
            ("tidalRapidRiseFtPer24h", self.tidal_rapid_rise_ft_per_24h),
            ("staleObservationHours", self.stale_observation_hours),
            ("staleForecastHours", self.stale_forecast_hours),
            ("conflictFt", self.conflict_ft),
        ] {
            if !(v.is_finite() && v > 0.0) {
                return Err(format!("review.{name} must be a positive number, got {v}"));
            }
        }
        if !(self.flow_conflict_ratio.is_finite() && self.flow_conflict_ratio > 1.0) {
            return Err(format!("review.flowConflictRatio must be above 1, got {}", self.flow_conflict_ratio));
        }
        if self.tidal_stage_rise_ft < self.stage_rise_ft || self.tidal_rapid_rise_ft_per_24h < self.rapid_rise_ft_per_24h {
            return Err("review: tidal noise floors must not be below the non-tidal thresholds".into());
        }
        Ok(())
    }

    pub fn is_tidal(&self, lid: &str) -> bool {
        self.tidal_sites.iter().any(|s| s.eq_ignore_ascii_case(lid))
    }

    fn hours_ms(h: f64) -> i64 {
        (h * HOUR_MS as f64).round() as i64
    }

    pub fn stale_observation_ms(&self) -> i64 {
        Self::hours_ms(self.stale_observation_hours)
    }

    pub fn stale_forecast_ms(&self) -> i64 {
        Self::hours_ms(self.stale_forecast_hours)
    }

    pub fn horizon_ms(&self) -> i64 {
        Self::hours_ms(self.forecast_horizon_hours)
    }
}

/// The seven rules, numbered as in the contract (that number breaks severity ties).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Rule {
    StageRise = 1,
    ForecastCategory = 2,
    ActiveAlert = 3,
    RapidChangeForecast = 4,
    StaleInput = 5,
    MissingInput = 6,
    SourceConflict = 7,
}

impl Rule {
    pub fn id(self) -> &'static str {
        match self {
            Rule::StageRise => "stage_rise",
            Rule::ForecastCategory => "forecast_category",
            Rule::ActiveAlert => "active_alert",
            Rule::RapidChangeForecast => "rapid_change_forecast",
            Rule::StaleInput => "stale_input",
            Rule::MissingInput => "missing_input",
            Rule::SourceConflict => "source_conflict",
        }
    }

    /// Rules 1-4 and 7 put a site in review; 5 and 6 only stop it being `ok`.
    pub fn flags_review(self) -> bool {
        !matches!(self, Rule::StaleInput | Rule::MissingInput)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    Info,
    Medium,
    High,
}

/// What a rule found: it fired, it was checked and did not fire, or it could not be checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Fired,
    Clear,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Status {
    Review,
    CannotAssess,
    Ok,
}

impl Status {
    pub fn id(self) -> &'static str {
        match self {
            Status::Review => "review",
            Status::CannotAssess => "cannot_assess",
            Status::Ok => "ok",
        }
    }
}

/// One rule evaluation with its numbers and sources.
#[derive(Debug, Clone, PartialEq)]
pub struct Reason {
    pub rule: Rule,
    pub outcome: Outcome,
    pub severity: Severity,
    pub value: Option<f64>,
    /// A non-numeric value: a category name, an alert event, a flow pair.
    pub value_text: Option<String>,
    pub threshold: Option<f64>,
    pub unit: Option<&'static str>,
    /// `nwps-live`, `iem-archive`, `nws`, `nwps-live+usgs`, ...
    pub source: String,
    pub observed_at: Option<i64>,
    pub issued_at: Option<i64>,
    pub link: Option<String>,
    pub evidence_ids: Vec<String>,
    /// One plain line.
    pub explanation: String,
}

impl Reason {
    fn new(rule: Rule, outcome: Outcome, explanation: String) -> Reason {
        Reason {
            rule,
            outcome,
            severity: if outcome == Outcome::Fired && rule.flags_review() { Severity::Medium } else { Severity::Info },
            value: None,
            value_text: None,
            threshold: None,
            unit: None,
            source: String::new(),
            observed_at: None,
            issued_at: None,
            link: None,
            evidence_ids: Vec::new(),
            explanation,
        }
    }

    fn fired(&self) -> bool {
        self.outcome == Outcome::Fired
    }
}

/// A carp location as the engine sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiteRef {
    /// NWPS lid, the store key.
    pub lid: String,
    /// Config location id.
    pub location: String,
    pub name: String,
    pub usgs: Option<String>,
}

impl SiteRef {
    /// Locations of an app config that have an NWPS id, config order.
    pub fn all(cfg: &crate::app::config::AppConfig) -> Vec<SiteRef> {
        cfg.locations
            .iter()
            .filter_map(|l| {
                Some(SiteRef { lid: l.nwps.clone()?.to_ascii_uppercase(), location: l.id.clone(), name: l.name.clone(), usgs: l.usgs.clone() })
            })
            .collect()
    }
}

/// An NWS alert version in the store.
#[derive(Debug, Clone, PartialEq)]
pub struct AlertIn {
    pub ext_id: String,
    pub event: String,
    pub severity: String,
    pub headline: Option<String>,
    pub onset: Option<i64>,
    pub expires: Option<i64>,
    pub first_seen: i64,
}

/// Newest USGS reading (display only; see the module doc on datums).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UsgsNow {
    pub observed_at: i64,
    pub stage_ft: Option<f64>,
    pub flow_cfs: Option<f64>,
}

/// Everything known about one site at `as_of`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Inputs {
    pub lid: String,
    pub usgs_site: Option<String>,
    pub as_of: i64,
    /// Newest NWPS observation knowable at `as_of`, however old.
    pub latest: Option<StoredObservation>,
    /// NWPS observations knowable at `as_of` from 25 h before `latest` up to it, oldest first.
    pub window: Vec<StoredObservation>,
    pub forecast: Option<Snapshot>,
    pub thresholds: Option<Thresholds>,
    /// Alert versions first seen by `as_of` and not ended by then.
    pub alerts: Vec<AlertIn>,
    pub usgs: Option<UsgsNow>,
}

impl Inputs {
    fn age_h(&self, at: i64) -> f64 {
        (self.as_of - at) as f64 / HOUR_MS as f64
    }

    fn observation_stale(&self, cfg: &ReviewCfg) -> bool {
        self.latest.is_some_and(|o| self.as_of - o.observed_at > cfg.stale_observation_ms())
    }

    fn forecast_stale(&self, cfg: &ReviewCfg) -> bool {
        self.forecast.as_ref().is_some_and(|f| self.as_of - f.issued_at > cfg.stale_forecast_ms())
    }

    /// The forecast if it may be scored (present and not stale).
    fn usable_forecast(&self, cfg: &ReviewCfg) -> Option<&Snapshot> {
        self.forecast.as_ref().filter(|_| !self.forecast_stale(cfg))
    }

    /// Thresholds with at least one defined value.
    fn usable_thresholds(&self) -> Option<&Thresholds> {
        self.thresholds.as_ref().filter(|t| !t.is_empty())
    }

    /// The newest observation with a stage, if not stale.
    fn fresh_stage(&self, cfg: &ReviewCfg) -> Option<(StoredObservation, f64)> {
        let o = self.latest.filter(|_| !self.observation_stale(cfg))?;
        Some((o, o.stage_ft?))
    }

    /// Observation nearest `latest - 24 h` within the tolerance, with a stage.
    fn baseline(&self) -> Option<(StoredObservation, f64)> {
        let newest = self.latest?;
        let target = newest.observed_at - 24 * HOUR_MS;
        self.window
            .iter()
            .filter(|o| o.stage_ft.is_some() && (o.observed_at - target).abs() <= BASELINE_TOLERANCE_MS)
            .min_by_key(|o| ((o.observed_at - target).abs(), o.observed_at))
            .map(|o| (*o, o.stage_ft.unwrap_or_default()))
    }

    fn change_24h(&self) -> Option<f64> {
        Some(self.latest?.stage_ft? - self.baseline()?.1)
    }
}

// ---------------------------------------------------------------------------------------------
// Sources, links and evidence ids
// ---------------------------------------------------------------------------------------------

fn gauge_link(lid: &str) -> String {
    format!("https://water.noaa.gov/gauges/{}", lid.to_ascii_lowercase())
}

fn forecast_link(f: &Snapshot) -> String {
    match f.source {
        Source::IemArchive => format!(
            "https://mesonet.agron.iastate.edu/cgi-bin/request/hml.py?station={}&kind=forecasts&fmt=csv&sts={}&ets={}",
            f.site,
            iso(f.issued_at),
            iso(f.issued_at + 60_000)
        ),
        _ => gauge_link(&f.site),
    }
}

fn alert_link(ext_id: &str) -> String {
    if ext_id.starts_with("http") {
        ext_id.to_string()
    } else {
        format!("https://api.weather.gov/alerts/{ext_id}")
    }
}

pub fn reading_id(station: &str, at: i64) -> String {
    format!("reading:{station}:stage_m:{at}:measured")
}

pub fn forecast_id(f: &Snapshot) -> String {
    format!("forecast:{}:{}", f.site, f.issued_at)
}

/// The lowest defined threshold and its category: the first one a rising stage crosses.
fn first_threshold(t: &Thresholds) -> Option<(Category, f64)> {
    [(Category::Action, t.action_ft), (Category::Minor, t.minor_ft), (Category::Moderate, t.moderate_ft), (Category::Major, t.major_ft)]
        .into_iter()
        .find_map(|(c, v)| Some((c, v?)))
}

fn threshold_of(t: &Thresholds, c: Category) -> Option<f64> {
    match c {
        Category::None => None,
        Category::Action => t.action_ft,
        Category::Minor => t.minor_ft,
        Category::Moderate => t.moderate_ft,
        Category::Major => t.major_ft,
    }
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

/// Rule 1. NWPS observed stage change over 24 h (offset-free, so USGS-vs-NWPS datum does not
/// matter, but only NWPS is used so one series is compared with itself).
pub fn rule_stage_rise(i: &Inputs, cfg: &ReviewCfg) -> Reason {
    let tidal = cfg.is_tidal(&i.lid);
    let floor = if tidal { cfg.tidal_stage_rise_ft } else { cfg.stage_rise_ft };
    let floor_note = if tidal { " (tidal site: larger noise floor)" } else { "" };
    let Some((newest, stage)) = i.fresh_stage(cfg) else {
        let mut r = Reason::new(Rule::StageRise, Outcome::Unknown, "No current NWPS observation, so the 24 h change cannot be computed.".into());
        r.threshold = Some(floor);
        r.unit = Some("ft");
        return r;
    };
    let Some((base, base_stage)) = i.baseline() else {
        let mut r = Reason::new(
            Rule::StageRise,
            Outcome::Unknown,
            format!("No NWPS observation within 1 h of 24 h before {}, so the 24 h change cannot be computed.", iso(newest.observed_at)),
        );
        r.threshold = Some(floor);
        r.unit = Some("ft");
        r.observed_at = Some(newest.observed_at);
        return r;
    };
    let rise = stage - base_stage;
    let fired = rise >= floor - EPS;
    let mut r = Reason::new(
        Rule::StageRise,
        if fired { Outcome::Fired } else { Outcome::Clear },
        format!(
            "Stage {} {:.2} ft in 24 h ({base_stage:.2} ft at {} to {stage:.2} ft at {}); review threshold is a rise of {floor:.1} ft{floor_note}.",
            if rise >= 0.0 { "rose" } else { "fell" },
            rise.abs(),
            iso(base.observed_at),
            iso(newest.observed_at)
        ),
    );
    r.value = Some(rise);
    r.threshold = Some(floor);
    r.unit = Some("ft");
    r.source = newest.source.db().into();
    r.observed_at = Some(newest.observed_at);
    r.link = Some(gauge_link(&i.lid));
    r.evidence_ids = vec![reading_id(&i.lid, base.observed_at), reading_id(&i.lid, newest.observed_at)];
    r
}

/// Forecast points with a stage valid in `[t, t + horizon]`, plus the last one before `t`
/// (so a rise already under way at `t` is measured from where it started).
fn horizon_points(f: &Snapshot, t: i64, horizon_ms: i64) -> Vec<(i64, f64)> {
    let before = f.points.iter().filter(|p| p.valid_at < t && p.stage_ft.is_some()).max_by_key(|p| p.valid_at);
    before
        .into_iter()
        .chain(f.points.iter().filter(|p| p.valid_at >= t && p.valid_at <= t + horizon_ms))
        .filter_map(|p| Some((p.valid_at, p.stage_ft?)))
        .collect()
}

/// Rule 2. NWPS forecast peak in the horizon against NWPS thresholds known at `t`. USGS stage
/// is not an input: comparing it with NWPS thresholds is the datum trap.
pub fn rule_forecast_category(i: &Inputs, cfg: &ReviewCfg) -> Reason {
    let unknown = |why: String| {
        let mut r = Reason::new(Rule::ForecastCategory, Outcome::Unknown, why);
        r.unit = Some("ft");
        r
    };
    let Some(f) = i.usable_forecast(cfg) else {
        return unknown(match &i.forecast {
            Some(f) => format!("Forecast issued {} is stale ({:.1} h old), so it is not scored.", iso(f.issued_at), i.age_h(f.issued_at)),
            None => "No NWPS forecast known at this time.".into(),
        });
    };
    let Some(th) = i.usable_thresholds() else {
        return unknown("No NWPS flood thresholds known for this site, so a forecast category cannot be judged.".into());
    };
    let horizon = cfg.horizon_ms();
    let peak = horizon_points(f, i.as_of, horizon)
        .into_iter()
        .filter(|(at, _)| *at >= i.as_of)
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal).then(b.0.cmp(&a.0)));
    let Some((peak_at, peak)) = peak else {
        return unknown(format!("Forecast issued {} has no stage points in the next {:.0} h.", iso(f.issued_at), cfg.forecast_horizon_hours));
    };
    let category = th.category(Some(peak)).unwrap_or(Category::None);
    let fired = category >= Category::Action;
    let (threshold_cat, threshold) = if fired {
        (category, threshold_of(th, category))
    } else {
        first_threshold(th).map_or((Category::Action, None), |(c, v)| (c, Some(v)))
    };
    let mut r = Reason::new(
        Rule::ForecastCategory,
        if fired { Outcome::Fired } else { Outcome::Clear },
        if fired {
            format!(
                "NWPS forecast issued {} crests at {peak:.2} ft at {}, at or above {} stage ({:.2} ft), within the next {:.0} h.",
                iso(f.issued_at),
                iso(peak_at),
                threshold_cat.db(),
                threshold.unwrap_or(f64::NAN),
                cfg.forecast_horizon_hours
            )
        } else {
            format!(
                "NWPS forecast issued {} peaks at {peak:.2} ft at {} in the next {:.0} h, below {} stage{}.",
                iso(f.issued_at),
                iso(peak_at),
                cfg.forecast_horizon_hours,
                threshold_cat.db(),
                threshold.map(|v| format!(" ({v:.2} ft)")).unwrap_or_default()
            )
        },
    );
    if fired {
        r.severity = if category >= Category::Minor { Severity::High } else { Severity::Medium };
    }
    r.value = Some(peak);
    r.value_text = Some(category.db().into());
    r.threshold = threshold;
    r.unit = Some("ft");
    r.source = f.source.db().into();
    r.observed_at = Some(peak_at);
    r.issued_at = Some(f.issued_at);
    r.link = Some(forecast_link(f));
    r.evidence_ids = vec![forecast_id(f)];
    r
}

/// Rule 3. One reason per alert version in effect at `t` (seen, not ended, not expired); one
/// clear check when there are none.
pub fn rule_active_alert(i: &Inputs) -> Vec<Reason> {
    let active: Vec<&AlertIn> = i.alerts.iter().filter(|a| a.first_seen <= i.as_of && a.expires.is_none_or(|e| e > i.as_of)).collect();
    if active.is_empty() {
        let mut r = Reason::new(
            Rule::ActiveAlert,
            Outcome::Clear,
            "No NWS alert in effect for this site in what the alert poller had recorded by this time.".into(),
        );
        r.source = "nws".into();
        r.link = Some("https://api.weather.gov/alerts/active?area=LA".into());
        return vec![r];
    }
    active
        .into_iter()
        .map(|a| {
            let mut r = Reason::new(
                Rule::ActiveAlert,
                Outcome::Fired,
                format!(
                    "NWS {} active (first seen {}{}{}){}.",
                    a.event,
                    iso(a.first_seen),
                    a.onset.filter(|o| *o > i.as_of).map(|o| format!(", onset {}", iso(o))).unwrap_or_default(),
                    a.expires.map(|e| format!(", expires {}", iso(e))).unwrap_or_default(),
                    a.headline.as_deref().map(|h| format!(": {h}")).unwrap_or_default()
                ),
            );
            let warning = a.event.contains("Warning") || matches!(a.severity.as_str(), "Extreme" | "Severe");
            r.severity = if warning { Severity::High } else { Severity::Medium };
            r.value_text = Some(a.event.clone());
            r.source = "nws".into();
            r.observed_at = Some(a.first_seen);
            r.issued_at = a.onset;
            r.link = Some(alert_link(&a.ext_id));
            r.evidence_ids = vec![format!("alert:{}", a.ext_id)];
            r
        })
        .collect()
}

/// Rule 4. Largest forecast rise within any 24 h of the horizon.
pub fn rule_rapid_change_forecast(i: &Inputs, cfg: &ReviewCfg) -> Reason {
    let tidal = cfg.is_tidal(&i.lid);
    let floor = if tidal { cfg.tidal_rapid_rise_ft_per_24h } else { cfg.rapid_rise_ft_per_24h };
    let unknown = |why: String| {
        let mut r = Reason::new(Rule::RapidChangeForecast, Outcome::Unknown, why);
        r.threshold = Some(floor);
        r.unit = Some("ft/24 h");
        r
    };
    let Some(f) = i.usable_forecast(cfg) else {
        return unknown("No current NWPS forecast, so the forecast rise rate cannot be computed.".into());
    };
    let pts = horizon_points(f, i.as_of, cfg.horizon_ms());
    let mut best: Option<(f64, i64, i64)> = None;
    for (a, &(ta, sa)) in pts.iter().enumerate() {
        for &(tb, sb) in pts[a + 1..].iter().take_while(|(tb, _)| tb - ta <= 24 * HOUR_MS) {
            if best.is_none_or(|(d, _, _)| sb - sa > d) {
                best = Some((sb - sa, ta, tb));
            }
        }
    }
    let Some((rise, from, to)) = best else {
        return unknown(format!("Forecast issued {} has fewer than two stage points 24 h apart or less in the horizon.", iso(f.issued_at)));
    };
    let fired = rise >= floor - EPS;
    let mut r = Reason::new(
        Rule::RapidChangeForecast,
        if fired { Outcome::Fired } else { Outcome::Clear },
        format!(
            "Largest forecast rise within 24 h is {rise:+.2} ft ({} to {}, issued {}); review threshold is {floor:.1} ft{}.",
            iso(from),
            iso(to),
            iso(f.issued_at),
            if tidal { " (tidal site: larger noise floor)" } else { "" }
        ),
    );
    r.value = Some(rise);
    r.threshold = Some(floor);
    r.unit = Some("ft/24 h");
    r.source = f.source.db().into();
    r.observed_at = Some(to);
    r.issued_at = Some(f.issued_at);
    r.link = Some(forecast_link(f));
    r.evidence_ids = vec![forecast_id(f)];
    r
}

/// Rule 5. One check per feed that is present (absence is rule 6).
pub fn rule_stale_input(i: &Inputs, cfg: &ReviewCfg) -> Vec<Reason> {
    let mut out = Vec::new();
    if let Some(o) = i.latest {
        let stale = i.observation_stale(cfg);
        let mut r = Reason::new(
            Rule::StaleInput,
            if stale { Outcome::Fired } else { Outcome::Clear },
            format!(
                "Newest NWPS observation ({}) is {:.1} h old; observations older than {:.0} h are {}.",
                iso(o.observed_at),
                i.age_h(o.observed_at),
                cfg.stale_observation_hours,
                if stale { "stale and dropped from review scoring" } else { "stale" }
            ),
        );
        r.value = Some(i.age_h(o.observed_at));
        r.value_text = Some("observation".into());
        r.threshold = Some(cfg.stale_observation_hours);
        r.unit = Some("h");
        r.source = o.source.db().into();
        r.observed_at = Some(o.observed_at);
        r.link = Some(gauge_link(&i.lid));
        r.evidence_ids = vec![reading_id(&i.lid, o.observed_at)];
        out.push(r);
    }
    if let Some(f) = &i.forecast {
        let stale = i.forecast_stale(cfg);
        let mut r = Reason::new(
            Rule::StaleInput,
            if stale { Outcome::Fired } else { Outcome::Clear },
            format!(
                "NWPS forecast issued {} is {:.1} h old; forecasts older than {:.0} h are {}.",
                iso(f.issued_at),
                i.age_h(f.issued_at),
                cfg.stale_forecast_hours,
                if stale { "stale and dropped from review scoring" } else { "stale" }
            ),
        );
        r.value = Some(i.age_h(f.issued_at));
        r.value_text = Some("forecast".into());
        r.threshold = Some(cfg.stale_forecast_hours);
        r.unit = Some("h");
        r.source = f.source.db().into();
        r.issued_at = Some(f.issued_at);
        r.link = Some(forecast_link(f));
        r.evidence_ids = vec![forecast_id(f)];
        out.push(r);
    }
    out
}

/// Rule 6. One reason per missing input; one clear check when nothing is missing.
pub fn rule_missing_input(i: &Inputs, cfg: &ReviewCfg) -> Vec<Reason> {
    let mut out = Vec::new();
    let mut missing = |what: &str, why: String| {
        let mut r = Reason::new(Rule::MissingInput, Outcome::Fired, why);
        r.value_text = Some(what.into());
        r.link = Some(gauge_link(&i.lid));
        out.push(r);
    };
    match i.latest {
        None => missing("observation", "No NWPS stage observation known for this site at this time.".into()),
        Some(o) if o.stage_ft.is_none() => missing("observation", format!("Newest NWPS observation ({}) has no stage value.", iso(o.observed_at))),
        Some(_) => {}
    }
    if i.forecast.is_none() {
        missing("forecast", "No NWPS river forecast known for this site at this time.".into());
    }
    if i.usable_thresholds().is_none() {
        missing("thresholds", "No NWPS flood thresholds known for this site at this time.".into());
    }
    if let Some((newest, _)) = i.fresh_stage(cfg) {
        if i.baseline().is_none() {
            missing(
                "baseline",
                format!("No NWPS observation within 1 h of {}, so the 24 h change cannot be computed.", iso(newest.observed_at - 24 * HOUR_MS)),
            );
        }
    }
    if out.is_empty() {
        let mut r = Reason::new(Rule::MissingInput, Outcome::Clear, "Observation, 24 h baseline, forecast and thresholds are all present.".into());
        r.link = Some(gauge_link(&i.lid));
        out.push(r);
    }
    for r in &mut out {
        r.source = "nwps".into();
    }
    out
}

/// Rule 7. Gauge vs forecast stage (both NWPS, same datum) at the observation time, and NWPS vs
/// USGS flow (ratio). Never blended; never USGS stage vs NWPS stage.
pub fn rule_source_conflict(i: &Inputs, cfg: &ReviewCfg) -> Vec<Reason> {
    let mut out = Vec::new();
    // a) gauge vs forecast stage
    let pair = i.fresh_stage(cfg).and_then(|(o, obs)| {
        let f = i.usable_forecast(cfg)?;
        let p = f
            .points
            .iter()
            .filter(|p| p.stage_ft.is_some() && (p.valid_at - o.observed_at).abs() <= PAIR_WINDOW_MS)
            .min_by_key(|p| ((p.valid_at - o.observed_at).abs(), p.valid_at))?;
        Some((o, obs, f, *p, p.stage_ft?))
    });
    match pair {
        None => {
            let mut r = Reason::new(
                Rule::SourceConflict,
                Outcome::Unknown,
                "No fresh NWPS observation with a forecast point within 30 min of it, so gauge and forecast cannot be compared.".into(),
            );
            r.value_text = Some("gauge_vs_forecast".into());
            r.threshold = Some(cfg.conflict_ft);
            r.unit = Some("ft");
            out.push(r);
        }
        Some((o, obs, f, p, fc)) => {
            let diff = obs - fc;
            let fired = diff.abs() > cfg.conflict_ft;
            let mut r = Reason::new(
                Rule::SourceConflict,
                if fired { Outcome::Fired } else { Outcome::Clear },
                format!(
                    "NWPS gauge read {obs:.2} ft at {} while the forecast issued {} had {fc:.2} ft for {}: {diff:+.2} ft apart; more than {:.1} ft is a conflict.",
                    iso(o.observed_at),
                    iso(f.issued_at),
                    iso(p.valid_at),
                    cfg.conflict_ft
                ),
            );
            r.value = Some(diff);
            r.value_text = Some("gauge_vs_forecast".into());
            r.threshold = Some(cfg.conflict_ft);
            r.unit = Some("ft");
            r.source = format!("{}+{}", o.source.db(), f.source.db());
            r.observed_at = Some(o.observed_at);
            r.issued_at = Some(f.issued_at);
            r.link = Some(gauge_link(&i.lid));
            r.evidence_ids = vec![reading_id(&i.lid, o.observed_at), forecast_id(f)];
            out.push(r);
        }
    }
    // b) NWPS vs USGS flow
    let flows = i.latest.filter(|_| !i.observation_stale(cfg)).and_then(|o| {
        let nwps_cfs = o.flow_kcfs? * 1000.0;
        let u = i.usgs?;
        let usgs_cfs = u.flow_cfs?;
        ((u.observed_at - o.observed_at).abs() <= FLOW_PAIR_MS && nwps_cfs > 0.0 && usgs_cfs > 0.0).then_some((o, nwps_cfs, u, usgs_cfs))
    });
    match flows {
        None => {
            let mut r = Reason::new(
                Rule::SourceConflict,
                Outcome::Unknown,
                "NWPS and USGS flow are not both available within 1 h of each other, so flows are not compared.".into(),
            );
            r.value_text = Some("flow".into());
            r.threshold = Some(cfg.flow_conflict_ratio);
            r.unit = Some("ratio");
            out.push(r);
        }
        Some((o, nwps, u, usgs)) => {
            let ratio = nwps.max(usgs) / nwps.min(usgs);
            let fired = ratio > cfg.flow_conflict_ratio;
            let mut r = Reason::new(
                Rule::SourceConflict,
                if fired { Outcome::Fired } else { Outcome::Clear },
                format!(
                    "Flow: NWPS {nwps:.0} cfs at {} vs USGS {usgs:.0} cfs at {}, a factor of {ratio:.1}; over {:.1} is a conflict. Each is shown with its source, never averaged.",
                    iso(o.observed_at),
                    iso(u.observed_at),
                    cfg.flow_conflict_ratio
                ),
            );
            r.value = Some(ratio);
            r.value_text = Some(format!("flow: NWPS {nwps:.0} cfs vs USGS {usgs:.0} cfs"));
            r.threshold = Some(cfg.flow_conflict_ratio);
            r.unit = Some("ratio");
            r.source = format!("{}+usgs", o.source.db());
            r.observed_at = Some(o.observed_at);
            r.link = Some(gauge_link(&i.lid));
            r.evidence_ids = [Some(reading_id(&i.lid, o.observed_at)), i.usgs_site.as_deref().map(|s| reading_id(s, u.observed_at))]
                .into_iter()
                .flatten()
                .collect();
            out.push(r);
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Site review, board, history
// ---------------------------------------------------------------------------------------------

/// A site's review at `as_of`.
#[derive(Debug, Clone, PartialEq)]
pub struct SiteReview {
    pub site: SiteRef,
    pub as_of: i64,
    pub status: Status,
    /// Fired reasons, most severe first (ties by rule number).
    pub reasons: Vec<Reason>,
    /// Every rule evaluation (fired, clear, unknown), rule order.
    pub checks: Vec<Reason>,
    pub summary: String,
    pub stage_ft: Option<f64>,
    pub observed_at: Option<i64>,
    pub change_24h_ft: Option<f64>,
    /// NWPS observed stage against NWPS thresholds known at `as_of`.
    pub category_now: Option<Category>,
    pub peak_stage_ft: Option<f64>,
    pub peak_at: Option<i64>,
    pub category_peak: Option<Category>,
    pub forecast_issued_at: Option<i64>,
    pub forecast_source: Option<Source>,
    pub observation_freshness: Freshness,
    pub forecast_freshness: Freshness,
    pub active_alerts: usize,
    pub usgs_stage_ft: Option<f64>,
    pub usgs_observed_at: Option<i64>,
    pub tidal: bool,
}

/// Distinct items, first-seen order.
fn unique<T: PartialEq>(items: impl Iterator<Item = T>) -> Vec<T> {
    let mut out = Vec::new();
    for x in items {
        if !out.contains(&x) {
            out.push(x);
        }
    }
    out
}

/// Every rule over the inputs, and the status they give.
pub fn evaluate(site: &SiteRef, i: &Inputs, cfg: &ReviewCfg) -> SiteReview {
    let mut checks = vec![rule_stage_rise(i, cfg), rule_forecast_category(i, cfg)];
    checks.extend(rule_active_alert(i));
    checks.push(rule_rapid_change_forecast(i, cfg));
    checks.extend(rule_stale_input(i, cfg));
    checks.extend(rule_missing_input(i, cfg));
    checks.extend(rule_source_conflict(i, cfg));
    checks.sort_by_key(|r| r.rule);
    let mut reasons: Vec<Reason> = checks.iter().filter(|r| r.fired()).cloned().collect();
    reasons.sort_by(|a, b| b.severity.cmp(&a.severity).then(a.rule.cmp(&b.rule)));
    // Rules 1, 2 and 4 must each be checked for an `ok`: an unknown one is a gap, not a pass.
    let core_unknown = checks.iter().any(|r| matches!(r.rule, Rule::StageRise | Rule::ForecastCategory | Rule::RapidChangeForecast) && r.outcome == Outcome::Unknown);
    let status = if reasons.iter().any(|r| r.rule.flags_review()) {
        Status::Review
    } else if !reasons.is_empty() || core_unknown {
        Status::CannotAssess
    } else {
        Status::Ok
    };
    let summary = match status {
        Status::Review => format!(
            "Needs review: {}.",
            unique(reasons.iter().filter(|r| r.rule.flags_review()).map(|r| r.rule.id())).join(", ")
        ),
        Status::CannotAssess => format!(
            "Cannot assess: {}. Reporting ok would be a guess.",
            {
                let mut gaps = unique(reasons.iter().filter_map(|r| r.value_text.as_deref().map(|w| format!("{} {w}", r.rule.id()))));
                if gaps.is_empty() {
                    gaps.push("a core rule could not be checked".into());
                }
                gaps.join(", ")
            }
        ),
        Status::Ok => "No review rule fired and observation, forecast and thresholds are current.".into(),
    };
    let fc = checks.iter().find(|r| r.rule == Rule::ForecastCategory && r.outcome != Outcome::Unknown);
    let obs_fresh = query::freshness(i.latest.map(|o| i.as_of - o.observed_at), OBS_FRESH_MS, cfg.stale_observation_ms());
    let fc_fresh = query::freshness(i.forecast.as_ref().map(|f| i.as_of - f.issued_at), query::FCST_FRESH_MS.min(cfg.stale_forecast_ms()), cfg.stale_forecast_ms());
    SiteReview {
        site: site.clone(),
        as_of: i.as_of,
        status,
        reasons,
        summary,
        stage_ft: i.latest.and_then(|o| o.stage_ft),
        observed_at: i.latest.map(|o| o.observed_at),
        change_24h_ft: i.fresh_stage(cfg).and(i.change_24h()),
        category_now: i.usable_thresholds().and_then(|t| t.category(i.latest.and_then(|o| o.stage_ft))),
        peak_stage_ft: fc.and_then(|r| r.value),
        peak_at: fc.and_then(|r| r.observed_at),
        category_peak: fc.and_then(|r| r.value_text.as_deref()).and_then(Category::from_db),
        forecast_issued_at: i.forecast.as_ref().map(|f| f.issued_at),
        forecast_source: i.forecast.as_ref().map(|f| f.source),
        observation_freshness: obs_fresh,
        forecast_freshness: fc_fresh,
        active_alerts: checks.iter().filter(|r| r.rule == Rule::ActiveAlert && r.fired()).count(),
        usgs_stage_ft: i.usgs.and_then(|u| u.stage_ft),
        usgs_observed_at: i.usgs.map(|u| u.observed_at),
        tidal: cfg.is_tidal(&i.lid),
        checks,
    }
}

/// Alert versions first seen by `t` and not ended by then.
fn alerts_asof(conn: &Connection, lid: &str, t: i64) -> rusqlite::Result<Vec<AlertIn>> {
    let mut st = conn.prepare_cached(
        "select ext_id, event, severity, headline, onset, expires, first_seen from alert_snapshots
         where site = ?1 and first_seen <= ?2 and (ended_at is null or ended_at > ?2) order by first_seen, id",
    )?;
    let rows = st.query_map(params![lid, t], |r| {
        Ok(AlertIn {
            ext_id: r.get(0)?,
            event: r.get(1)?,
            severity: r.get(2)?,
            headline: r.get(3)?,
            onset: r.get(4)?,
            expires: r.get(5)?,
            first_seen: r.get(6)?,
        })
    })?;
    rows.collect()
}

/// Newest USGS stage known at `t` (`readings`, metres, converted). A row with a raw object is
/// knowable once fetched; one without is treated as public at its observation time.
fn usgs_asof(conn: &Connection, usgs: &str, t: i64) -> rusqlite::Result<Option<UsgsNow>> {
    conn.prepare_cached(
        "select r.observed_at, r.value from readings r
         join stations s on s.id = r.station_id
         left join raw_objects o on o.id = r.raw_object_id
         where s.source_id = 'usgs' and (s.ext_id = ?1 or s.ext_id like ?1 || ':%')
           and r.param = 'stage_m' and r.origin = 'measured' and r.flag = 'ok' and r.value is not null
           and r.observed_at <= ?2 and (o.fetched_at is null or o.fetched_at <= ?2)
         order by r.observed_at desc limit 1",
    )?
    .query_row(params![usgs, t], |r| {
        let m: f64 = r.get(1)?;
        // ponytail: readings carry no discharge param yet, so USGS flow stays None and the flow
        // conflict check reports unknown until an adapter stores it.
        Ok(UsgsNow { observed_at: r.get(0)?, stage_ft: Some(m * FEET_PER_METRE), flow_cfs: None })
    })
    .optional()
}

/// Read a site's inputs as of `t` (C3 as-of queries only).
pub fn load_inputs(conn: &Connection, site: &SiteRef, t: i64) -> rusqlite::Result<Inputs> {
    let latest = query::latest_observation_asof(conn, &site.lid, t)?;
    let window = match latest {
        Some(o) => query::observations_asof(conn, &site.lid, o.observed_at - 24 * HOUR_MS - BASELINE_TOLERANCE_MS, o.observed_at, t)?,
        None => Vec::new(),
    };
    Ok(Inputs {
        lid: site.lid.clone(),
        usgs_site: site.usgs.clone(),
        as_of: t,
        latest,
        window,
        forecast: query::asof(conn, &site.lid, t)?,
        thresholds: thresholds_asof(conn, &site.lid, t)?,
        alerts: alerts_asof(conn, &site.lid, t)?,
        usgs: match &site.usgs {
            Some(u) => usgs_asof(conn, u, t)?,
            None => None,
        },
    })
}

pub fn site_review(conn: &Connection, site: &SiteRef, t: i64, cfg: &ReviewCfg) -> rusqlite::Result<SiteReview> {
    Ok(evaluate(site, &load_inputs(conn, site, t)?, cfg))
}

#[derive(Debug, Clone, PartialEq)]
pub struct Board {
    pub as_of: i64,
    /// Review first (most severe first), then cannot_assess, then ok.
    pub sites: Vec<SiteReview>,
    pub review: usize,
    pub ok: usize,
    pub cannot_assess: usize,
}

pub fn board(conn: &Connection, sites: &[SiteRef], t: i64, cfg: &ReviewCfg) -> rusqlite::Result<Board> {
    let mut out: Vec<SiteReview> = sites.iter().map(|s| site_review(conn, s, t, cfg)).collect::<rusqlite::Result<_>>()?;
    let top = |r: &SiteReview| r.reasons.first().map(|x| x.severity).unwrap_or(Severity::Info);
    let flagged = |r: &SiteReview| r.reasons.iter().filter(|x| x.rule.flags_review()).count();
    out.sort_by(|a, b| {
        a.status
            .cmp(&b.status)
            .then(top(b).cmp(&top(a)))
            .then(flagged(b).cmp(&flagged(a)))
            .then(a.site.lid.cmp(&b.site.lid))
    });
    let count = |s: Status| out.iter().filter(|r| r.status == s).count();
    Ok(Board { as_of: t, review: count(Status::Review), ok: count(Status::Ok), cannot_assess: count(Status::CannotAssess), sites: out })
}

/// One status flip.
#[derive(Debug, Clone, PartialEq)]
pub struct Transition {
    pub at: i64,
    pub from: Status,
    pub to: Status,
    /// Fired reasons right after the flip (why it entered review, or what blocks `ok`).
    pub reasons: Vec<Reason>,
    /// Rules that fired before the flip and no longer do (why it left review).
    pub cleared: Vec<Rule>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct History {
    pub site: SiteRef,
    pub from: i64,
    pub to: i64,
    pub initial: SiteReview,
    pub transitions: Vec<Transition>,
    /// How many instants were evaluated (every time an input could change in the window).
    pub evaluations: usize,
}

/// Every time in `(from, to]` at which a review input of the site can change: a row becoming
/// knowable, an alert starting, ending or expiring, a feed crossing its stale age, a forecast
/// point entering or leaving the horizon.
fn change_times(conn: &Connection, lid: &str, from: i64, to: i64, cfg: &ReviewCfg) -> rusqlite::Result<Vec<i64>> {
    let stale_obs = cfg.stale_observation_ms() + 1;
    let stale_fc = cfg.stale_forecast_ms() + 1;
    let horizon = cfg.horizon_ms();
    let mut st = conn.prepare_cached(
        "select case when source = 'nwps-live' then max(issued_at, ingested_at) else issued_at end from forecast_snapshots where site = ?1
         union select issued_at + ?2 from forecast_snapshots where site = ?1
         union select case when source = 'nwps-live' then max(observed_at, ingested_at) else observed_at end from forecast_observations where site = ?1
         union select observed_at + ?3 from forecast_observations where site = ?1
         union select ingested_at from forecast_thresholds where site = ?1
         union select first_seen from alert_snapshots where site = ?1
         union select ended_at from alert_snapshots where site = ?1 and ended_at is not null
         union select expires from alert_snapshots where site = ?1 and expires is not null
         union select p.valid_at - ?4 from forecast_points p join forecast_snapshots s on s.id = p.snapshot_id where s.site = ?1
         union select p.valid_at from forecast_points p join forecast_snapshots s on s.id = p.snapshot_id where s.site = ?1
         union select p.valid_at + 1 from forecast_points p join forecast_snapshots s on s.id = p.snapshot_id where s.site = ?1",
    )?;
    let mut times: Vec<i64> = st.query_map(params![lid, stale_fc, stale_obs, horizon], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    times.retain(|t| *t > from && *t <= to);
    times.sort_unstable();
    times.dedup();
    Ok(times)
}

/// Status flips of a site in `[from, to]`, each with the reasons behind it.
pub fn history(conn: &Connection, site: &SiteRef, from: i64, to: i64, cfg: &ReviewCfg) -> rusqlite::Result<History> {
    let initial = site_review(conn, site, from, cfg)?;
    let times = change_times(conn, &site.lid, from, to, cfg)?;
    let mut prev = initial.clone();
    let mut transitions = Vec::new();
    for &t in &times {
        let now = site_review(conn, site, t, cfg)?;
        if now.status != prev.status {
            let still: Vec<Rule> = now.reasons.iter().map(|r| r.rule).collect();
            let cleared = unique(prev.reasons.iter().map(|r| r.rule).filter(|r| !still.contains(r)));
            transitions.push(Transition { at: t, from: prev.status, to: now.status, reasons: now.reasons.clone(), cleared });
        }
        prev = now;
    }
    Ok(History { site: site.clone(), from, to, initial, transitions, evaluations: times.len() + 1 })
}
