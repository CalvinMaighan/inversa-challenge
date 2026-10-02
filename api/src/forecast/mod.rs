//! Bitemporal river forecast and alert store (gates/leaf-C3.md; docs/APPS.md carp "replay what
//! was known at the time"). Schema: `migrations/observations/0006_forecasts.sql`.
//!
//! Four times stay apart on every record: `issued_at` (forecast published), `valid_at` (when a
//! point applies), `observed_at` (measurement taken) and `ingested_at` (stored here). All are
//! unix milliseconds UTC. An as-of view at `t` (`query::asof`, `query::status_at`) only uses rows
//! that were knowable at `t`: live-captured rows need `ingested_at <= t`; archive-backfilled rows
//! (`Source::IemArchive`) were public at their `issued_at`/`observed_at`, so that time alone
//! gates them. Nothing in an as-of view ever reads a row from after `t`.
//!
//! Flood categories come from NWPS stage thresholds only (`Thresholds`); `-9999`/`-999` in the
//! feed means "not defined" and is stored as null, never compared.
//!
//! `store` is the write side (idempotent inserts, revisions, alert first/last/ended), `query` the
//! read side (as-of, coverage, status, verification). The C4 adapters call `store`; the GraphQL
//! resolvers call `query`.

pub mod query;
pub mod store;
#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};

/// Where a row came from. Only `NwpsLive` rows are gated by `ingested_at` in as-of views.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Source {
    NwpsLive,
    IemArchive,
    NwsGridpoint,
}

impl Source {
    pub fn db(self) -> &'static str {
        match self {
            Source::NwpsLive => "nwps-live",
            Source::IemArchive => "iem-archive",
            Source::NwsGridpoint => "nws-gridpoint",
        }
    }

    pub fn from_db(s: &str) -> Option<Source> {
        match s {
            "nwps-live" => Some(Source::NwpsLive),
            "iem-archive" => Some(Source::IemArchive),
            "nws-gridpoint" => Some(Source::NwsGridpoint),
            _ => None,
        }
    }

    /// Backfilled rows were public at their own time, so an as-of view does not gate them by
    /// `ingested_at`.
    pub fn backfilled(self) -> bool {
        self != Source::NwpsLive
    }
}

/// The `source` column value a feed (`sources.id`) writes: `nwps` → `nwps-live`, `iem` →
/// `iem-archive`, `nws-forecast` → `nws-gridpoint`. Feed state and backfill counts use it.
pub fn source_of_feed(source_id: &str) -> Option<&'static str> {
    match source_id {
        "nwps" => Some(Source::NwpsLive.db()),
        "iem" => Some(Source::IemArchive.db()),
        "nws-forecast" => Some(Source::NwsGridpoint.db()),
        _ => None,
    }
}

/// NWPS flood category of a stage: "at or above" each threshold, highest wins.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Category {
    None,
    Action,
    Minor,
    Moderate,
    Major,
}

impl Category {
    pub fn db(self) -> &'static str {
        match self {
            Category::None => "none",
            Category::Action => "action",
            Category::Minor => "minor",
            Category::Moderate => "moderate",
            Category::Major => "major",
        }
    }

    pub fn from_db(s: &str) -> Option<Category> {
        match s {
            "none" => Some(Category::None),
            "action" => Some(Category::Action),
            "minor" => Some(Category::Minor),
            "moderate" => Some(Category::Moderate),
            "major" => Some(Category::Major),
            _ => None,
        }
    }
}

/// NWPS flood category thresholds in NWPS stage feet. `None` = not defined at the site.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Thresholds {
    pub action_ft: Option<f64>,
    pub minor_ft: Option<f64>,
    pub moderate_ft: Option<f64>,
    pub major_ft: Option<f64>,
    /// NWPS `lowThreshold` (low water), NWPS stage feet. Not a flood category: it never counts
    /// in [`Thresholds::is_empty`] or [`Thresholds::category`]. Stage at or below it is NWPS's
    /// `low_threshold` state ([`Thresholds::low_water`]).
    #[serde(default)]
    pub low_ft: Option<f64>,
}

/// A feed value as a threshold: `-9999`, `-999`, NaN and infinities are "not defined".
pub fn clean_threshold(v: f64) -> Option<f64> {
    (v.is_finite() && v > -999.0).then_some(v)
}

/// A feed stage or flow value: NWPS writes `-999` (observed) and `-9999` (forecast) for "no
/// value", USGS `-999999`; none of them is a number.
pub fn clean_value(v: Option<f64>) -> Option<f64> {
    v.and_then(clean_threshold)
}

impl Thresholds {
    /// From the raw feed numbers (`-9999` = missing).
    pub fn from_feed(action: f64, minor: f64, moderate: f64, major: f64) -> Thresholds {
        Thresholds {
            action_ft: clean_threshold(action),
            minor_ft: clean_threshold(minor),
            moderate_ft: clean_threshold(moderate),
            major_ft: clean_threshold(major),
            low_ft: None,
        }
    }

    /// The same thresholds with NWPS's low-water threshold (feed value; `-9999` = missing).
    pub fn with_low(mut self, low: Option<f64>) -> Thresholds {
        self.low_ft = low.and_then(clean_threshold);
        self
    }

    /// NWPS's `low_threshold` state: stage at or below the low-water threshold. `None` when the
    /// stage or the threshold is missing.
    pub fn low_water(&self, stage_ft: Option<f64>) -> Option<bool> {
        let stage = stage_ft.filter(|s| s.is_finite())?;
        Some(stage <= self.low_ft?)
    }

    pub fn is_empty(&self) -> bool {
        self.action_ft.is_none() && self.minor_ft.is_none() && self.moderate_ft.is_none() && self.major_ft.is_none()
    }

    /// Category of a stage; `None` when the stage is missing or no threshold is defined.
    pub fn category(&self, stage_ft: Option<f64>) -> Option<Category> {
        let stage = stage_ft.filter(|s| s.is_finite())?;
        if self.is_empty() {
            return None;
        }
        let at_or_above = |t: Option<f64>| t.is_some_and(|t| stage >= t);
        Some(if at_or_above(self.major_ft) {
            Category::Major
        } else if at_or_above(self.moderate_ft) {
            Category::Moderate
        } else if at_or_above(self.minor_ft) {
            Category::Minor
        } else if at_or_above(self.action_ft) {
            Category::Action
        } else {
            Category::None
        })
    }
}

/// One forecast point as the adapter hands it in. Stage in NWPS feet, flow in kcfs.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub valid_at: i64,
    pub stage_ft: Option<f64>,
    pub flow_kcfs: Option<f64>,
}

/// One observed value as the adapter hands it in (NWPS observed series).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Observation {
    pub observed_at: i64,
    pub stage_ft: Option<f64>,
    pub flow_kcfs: Option<f64>,
}

/// A stored forecast point.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StoredPoint {
    pub valid_at: i64,
    pub stage_ft: Option<f64>,
    pub flow_kcfs: Option<f64>,
    pub category: Option<Category>,
}

/// A stored snapshot with its points, valid order.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub id: i64,
    pub site: String,
    pub product: String,
    pub issued_at: i64,
    pub ingested_at: i64,
    pub source: Source,
    pub payload_hash: String,
    pub revision: i64,
    pub valid_from: Option<i64>,
    pub valid_to: Option<i64>,
    pub horizon_end: Option<i64>,
    pub points: Vec<StoredPoint>,
}

impl Snapshot {
    /// Highest forecast stage, its time and category.
    pub fn peak(&self) -> Option<&StoredPoint> {
        self.points.iter().filter(|p| p.stage_ft.is_some()).max_by(|a, b| a.stage_ft.partial_cmp(&b.stage_ft).unwrap_or(std::cmp::Ordering::Equal))
    }
}

/// A stored observation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StoredObservation {
    pub observed_at: i64,
    pub stage_ft: Option<f64>,
    pub flow_kcfs: Option<f64>,
    pub source: Source,
    pub ingested_at: i64,
}

#[cfg(test)]
mod category_tests {
    use super::*;

    #[test]
    fn forecast_store_thresholds_treat_minus_9999_as_missing() {
        let t = Thresholds::from_feed(4.0, 6.0, 7.0, 12.0);
        assert_eq!(t.category(Some(3.37)), Some(Category::None));
        assert_eq!(t.category(Some(4.0)), Some(Category::Action), "at or above");
        assert_eq!(t.category(Some(6.5)), Some(Category::Minor));
        assert_eq!(t.category(Some(7.0)), Some(Category::Moderate));
        assert_eq!(t.category(Some(40.0)), Some(Category::Major));
        assert_eq!(t.category(None), None);
        assert_eq!(t.category(Some(f64::NAN)), None);

        let missing = Thresholds::from_feed(-9999.0, -9999.0, -9999.0, -9999.0);
        assert!(missing.is_empty());
        assert_eq!(missing.category(Some(1e6)), None, "no threshold: no category, never a number compare");
        let partial = Thresholds::from_feed(-999.0, 29.0, -9999.0, 43.0);
        assert_eq!(partial, Thresholds { action_ft: None, minor_ft: Some(29.0), moderate_ft: None, major_ft: Some(43.0), low_ft: None });
        assert_eq!(partial.category(Some(28.5)), Some(Category::None));
        assert_eq!(partial.category(Some(41.0)), Some(Category::Minor));
        assert_eq!(partial.category(Some(43.0)), Some(Category::Major));
        assert_eq!(clean_threshold(f64::INFINITY), None);
        assert_eq!(Source::from_db("iem-archive"), Some(Source::IemArchive));
        assert!(Source::IemArchive.backfilled() && !Source::NwpsLive.backfilled());
    }
}
