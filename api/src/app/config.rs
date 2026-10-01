//! App configuration (PLAN.md C-A3). The three JSON files under `spec/apps/` are the contract:
//! Rust loads them with serde (this module), the web loads the same files with zod, and
//! `spec/apps/app-config.schema.json` documents the shape for both.
//!
//! `AppConfig` is the file as written. `App` is the resolved runtime form: every region carries
//! its scoring grid and frame layout, every taxon its position in the frame (`TaxonIdx`, the
//! order in `taxa[]`) and, once an observations database is open, its `taxa.id` there
//! (`App::resolve_taxa`). No bbox, species or feed literal lives outside these files (C-A4).

use std::collections::{BTreeMap, HashSet};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::frames::Layout;
use crate::hotspot::rules::{self, RuleSet};
use crate::hotspot::Grid;
use crate::model::TaxonRef;

/// The three apps (C-A1), in selector order. `carp` is the default.
pub const APP_IDS: [&str; 3] = ["carp", "lionfish", "python"];
pub const DEFAULT_APP: &str = "carp";

/// Every source id a `feeds[]` entry may name, with the mode its adapter runs in. `crw` and
/// `nwps` have no adapter yet (leaves L3 and C2); a config may list them, and the scheduler
/// registers them as down with that reason so the feed chips are honest.
pub const SOURCES: [(&str, Mode); 13] = [
    ("inat", Mode::Poll),
    ("nas", Mode::Poll),
    ("gbif", Mode::Poll),
    ("nws", Mode::Poll),
    ("usgs", Mode::Poll),
    ("ndbc", Mode::Poll),
    ("coops", Mode::Poll),
    ("openmeteo", Mode::Poll),
    ("goes19", Mode::Push),
    ("nwws", Mode::Push),
    ("web", Mode::Push),
    ("crw", Mode::Poll),
    ("nwps", Mode::Poll),
];

/// Sources listed in `SOURCES` whose adapter does not exist yet.
pub const PENDING_SOURCES: [&str; 2] = ["crw", "nwps"];

/// Cells per axis the scoring grid must divide into: the hotspot grid is 2 cells, the
/// environment (GOES g5) grid 5 cells, so a region edge is a whole number of 10 cells.
pub const GRID_MULTIPLE: u32 = 10;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("{file}: not a valid AppConfig: {source}")]
    Json {
        file: String,
        #[source]
        source: serde_json::Error,
    },
    #[error("{file}: {reason}")]
    Invalid { file: String, reason: String },
    #[error("unknown app {0:?}; apps are carp, lionfish, python")]
    UnknownApp(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppKind {
    Species,
    Conditions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Push,
    Poll,
}

/// `[west, south, east, north]` in the file.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(from = "[f64; 4]", into = "[f64; 4]")]
pub struct BBox {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

impl From<[f64; 4]> for BBox {
    fn from([west, south, east, north]: [f64; 4]) -> Self {
        BBox { west, south, east, north }
    }
}

impl From<BBox> for [f64; 4] {
    fn from(b: BBox) -> Self {
        [b.west, b.south, b.east, b.north]
    }
}

impl BBox {
    /// Closed on every edge.
    pub fn contains(&self, lat: f64, lon: f64) -> bool {
        (self.south..=self.north).contains(&lat) && (self.west..=self.east).contains(&lon)
    }

    pub fn intersects(&self, other: &BBox) -> bool {
        self.west <= other.east && other.west <= self.east && self.south <= other.north && other.south <= self.north
    }

    /// Both boxes share more than an edge.
    pub fn overlaps(&self, other: &BBox) -> bool {
        self.west < other.east && other.west < self.east && self.south < other.north && other.south < self.north
    }

    pub fn union(&self, other: &BBox) -> BBox {
        BBox {
            west: self.west.min(other.west),
            south: self.south.min(other.south),
            east: self.east.max(other.east),
            north: self.north.max(other.north),
        }
    }
}

/// Species category ids of `taxa[].category` (`apps/web/shared/species-categories.ts` `CATEGORY_IDS`,
/// the schema's enum; the conformance tests hold all three equal).
pub const CATEGORIES: [&str; 13] =
    ["snakes", "lizards", "turtles", "crocodilians", "frogs", "birds", "mammals", "fish", "snails", "insects", "spiders", "plants", "other"];

/// IANA zones `copy.timezone` may name (the schema's enum): the zones of the regions the apps can
/// cover. A closed list, so Rust (no tz database) and the web (`Intl`) accept the same files.
pub const TIMEZONES: [&str; 18] = [
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Phoenix",
    "America/Los_Angeles",
    "America/Anchorage",
    "Pacific/Honolulu",
    "America/Puerto_Rico",
    "America/Cancun",
    "America/Merida",
    "America/Belize",
    "America/Bogota",
    "America/Havana",
    "America/Nassau",
    "America/Jamaica",
    "America/Panama",
    "America/Costa_Rica",
    "UTC",
];

/// Most `helperQuestions` an app may list (the welcome guide shows them all).
pub const MAX_HELPER_QUESTIONS: usize = 8;

/// An optional field that may be absent but never `null`: the schema types these as plain
/// strings or numbers, and the web's zod rejects `null` for them, so serde must too.
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaxonCfg {
    pub id: String,
    /// Common name.
    pub name: String,
    /// Chip label ("Python"); the name when absent.
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub short: Option<String>,
    /// One plain line for the welcome guide.
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub line: Option<String>,
    /// Other names people use for it, matched lower case.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    /// Category icon id (one of [`CATEGORIES`]).
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    pub scientific_name: String,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub inat_taxon_id: Option<i64>,
    #[serde(default)]
    pub inat_lineage_ids: Vec<i64>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub gbif_key: Option<i64>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub nas_genus: Option<String>,
    /// `null` (or absent) matches any species of the genus.
    #[serde(default)]
    pub nas_species: Option<String>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub iconic_group: Option<String>,
    pub color: String,
    pub half_life_days: f64,
    /// Name of the activity/access rule set (`hotspot::rules::ruleset`).
    pub rules: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Camera {
    pub lat: f64,
    pub lon: f64,
    pub height_m: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegionCfg {
    pub id: String,
    pub name: String,
    pub bbox: BBox,
    pub cell_deg: f64,
    pub camera: Camera,
    #[serde(default)]
    pub thin: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocationCfg {
    pub id: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    #[serde(default)]
    pub usgs: Option<String>,
    #[serde(default)]
    pub nwps: Option<String>,
    #[serde(default)]
    pub nws: Option<String>,
    #[serde(default)]
    pub provisional: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedCfg {
    pub source: String,
    pub mode: Mode,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default)]
    pub params: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScoreComponent {
    pub id: String,
    pub label: String,
    pub weight: f64,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScoreCfg {
    pub label: String,
    pub components: Vec<ScoreComponent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowsCfg {
    pub default_hours: u32,
    pub options_hours: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayerCfg {
    pub id: String,
    pub label: String,
    pub default_on: bool,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// `copy`: the three strings every app must have, plus free-form UI strings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CopyCfg {
    /// The About popover's first line.
    pub about: String,
    /// The app's area in words ("South Florida").
    pub region: String,
    /// IANA zone of the app's local times (one of [`TIMEZONES`]).
    pub timezone: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCfg {
    pub persona: String,
    pub scope: String,
    pub tools: Vec<String>,
    pub refusal: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvalCfg {
    pub golden_set: String,
}

/// One `spec/apps/<id>.json`, as written.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppConfig {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub tagline: String,
    pub question: String,
    pub kind: AppKind,
    #[serde(default)]
    pub provisional: bool,
    pub taxa: Vec<TaxonCfg>,
    pub regions: Vec<RegionCfg>,
    pub locations: Vec<LocationCfg>,
    pub feeds: Vec<FeedCfg>,
    pub score: ScoreCfg,
    pub windows: WindowsCfg,
    pub layers: Vec<LayerCfg>,
    pub legend: BTreeMap<String, String>,
    pub copy: CopyCfg,
    pub helper_questions: Vec<String>,
    pub agent: AgentCfg,
    pub eval: EvalCfg,
}

/// The config files, compiled in: the binary needs no path to `spec/` at runtime.
pub fn builtin_json(id: &str) -> Option<&'static str> {
    match id {
        "carp" => Some(include_str!("../../../spec/apps/carp.json")),
        "lionfish" => Some(include_str!("../../../spec/apps/lionfish.json")),
        "python" => Some(include_str!("../../../spec/apps/python.json")),
        _ => None,
    }
}

impl AppConfig {
    /// Parse and validate one file's text. `file` names it in errors.
    pub fn parse(file: &str, json: &str) -> Result<AppConfig, ConfigError> {
        let cfg: AppConfig = serde_json::from_str(json).map_err(|source| ConfigError::Json { file: file.to_string(), source })?;
        cfg.validate().map_err(|reason| ConfigError::Invalid { file: file.to_string(), reason })?;
        Ok(cfg)
    }

    pub fn builtin(id: &str) -> Result<AppConfig, ConfigError> {
        let json = builtin_json(id).ok_or_else(|| ConfigError::UnknownApp(id.to_string()))?;
        let cfg = AppConfig::parse(&format!("spec/apps/{id}.json"), json)?;
        if cfg.id != id {
            return Err(ConfigError::Invalid { file: format!("spec/apps/{id}.json"), reason: format!("id {:?} does not match the file name", cfg.id) });
        }
        Ok(cfg)
    }

    #[cfg(test)]
    pub fn builtin_all() -> Result<Vec<AppConfig>, ConfigError> {
        APP_IDS.iter().map(|id| AppConfig::builtin(id)).collect()
    }

    pub fn feed(&self, source: &str) -> Option<&FeedCfg> {
        self.feeds.iter().find(|f| f.source == source)
    }

    pub fn has_feed(&self, source: &str) -> bool {
        self.feed(source).is_some()
    }

    /// Every rule the file must obey beyond its shape. One reason per failure, the first found.
    pub fn validate(&self) -> Result<(), String> {
        let id_ok = |s: &str| {
            !s.is_empty()
                && s.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
                && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        };
        // Every text the UI or the agent shows must say something (the web's zod trims and needs one character).
        let blank = |what: &str, v: &str| if v.trim().is_empty() { Err(format!("{what} is empty")) } else { Ok(()) };
        if !APP_IDS.contains(&self.id.as_str()) {
            return Err(format!("id {:?} is not one of {}", self.id, APP_IDS.join(", ")));
        }
        for (what, v) in [("name", &self.name), ("icon", &self.icon), ("tagline", &self.tagline), ("question", &self.question)] {
            blank(what, v)?;
        }
        match self.kind {
            AppKind::Species if self.taxa.is_empty() => return Err("kind species needs at least one taxon".into()),
            AppKind::Conditions if !self.taxa.is_empty() => return Err("kind conditions must list no taxa".into()),
            AppKind::Conditions if self.locations.is_empty() => return Err("kind conditions needs at least one location".into()),
            _ => {}
        }
        if self.taxa.len() > u8::MAX as usize {
            return Err("more than 255 taxa".into());
        }
        let mut seen = HashSet::new();
        let mut names = HashSet::new();
        for t in &self.taxa {
            if !id_ok(&t.id) {
                return Err(format!("taxon id {:?} is not lowercase kebab-case", t.id));
            }
            if !seen.insert(t.id.as_str()) {
                return Err(format!("duplicate taxon id {:?}", t.id));
            }
            blank(&format!("taxon {:?}: name", t.id), &t.name)?;
            for (what, v) in [("short", &t.short), ("line", &t.line), ("nasGenus", &t.nas_genus), ("iconicGroup", &t.iconic_group)] {
                if let Some(v) = v {
                    blank(&format!("taxon {:?}: {what}", t.id), v)?;
                }
            }
            if t.aliases.iter().any(|a| a.trim().is_empty()) {
                return Err(format!("taxon {:?}: aliases has an empty name", t.id));
            }
            if let Some(c) = &t.category {
                if !CATEGORIES.contains(&c.as_str()) {
                    return Err(format!("taxon {:?}: category {c:?} is not one of {}", t.id, CATEGORIES.join(", ")));
                }
            }
            if t.inat_taxon_id.is_some_and(|k| k < 1) || t.gbif_key.is_some_and(|k| k < 1) || t.inat_lineage_ids.iter().any(|&k| k < 1) {
                return Err(format!("taxon {:?}: iNat and GBIF keys must be positive", t.id));
            }
            if t.scientific_name.trim().is_empty() || !names.insert(t.scientific_name.trim()) {
                return Err(format!("taxon {:?}: empty or duplicate scientificName", t.id));
            }
            if !(t.half_life_days > 0.0 && t.half_life_days.is_finite()) {
                return Err(format!("taxon {:?}: halfLifeDays must be positive", t.id));
            }
            if rules::ruleset(&t.rules).is_none() {
                return Err(format!("taxon {:?}: unknown rules {:?}; known: {}", t.id, t.rules, rules::names().join(", ")));
            }
            if !(t.color.len() == 7 && t.color.starts_with('#') && t.color[1..].bytes().all(|b| b.is_ascii_hexdigit())) {
                return Err(format!("taxon {:?}: color {:?} is not #rrggbb", t.id, t.color));
            }
        }
        if self.regions.is_empty() {
            return Err("regions is empty".into());
        }
        if self.regions.len() > u8::MAX as usize {
            return Err("more than 255 regions".into());
        }
        let mut seen = HashSet::new();
        for (i, r) in self.regions.iter().enumerate() {
            if !id_ok(&r.id) {
                return Err(format!("region id {:?} is not lowercase kebab-case", r.id));
            }
            if !seen.insert(r.id.as_str()) {
                return Err(format!("duplicate region id {:?}", r.id));
            }
            blank(&format!("region {:?}: name", r.id), &r.name)?;
            grid_of(r).map_err(|e| format!("region {:?}: {e}", r.id))?;
            let c = r.camera;
            if !(-90.0..=90.0).contains(&c.lat) || !(-180.0..=180.0).contains(&c.lon) || c.height_m <= 0.0 || !c.height_m.is_finite() {
                return Err(format!("region {:?}: camera needs lat/lon on the globe and a positive heightM", r.id));
            }
            for other in &self.regions[..i] {
                if r.bbox.overlaps(&other.bbox) {
                    return Err(format!("regions {:?} and {:?} overlap", other.id, r.id));
                }
            }
        }
        let mut seen = HashSet::new();
        for l in &self.locations {
            if !id_ok(&l.id) || !seen.insert(l.id.as_str()) {
                return Err(format!("location id {:?} is invalid or duplicated", l.id));
            }
            blank(&format!("location {:?}: name", l.id), &l.name)?;
            if !(-90.0..=90.0).contains(&l.lat) || !(-180.0..=180.0).contains(&l.lon) {
                return Err(format!("location {:?}: lat/lon out of range", l.id));
            }
        }
        if self.feeds.is_empty() {
            return Err("feeds is empty".into());
        }
        let mut seen = HashSet::new();
        for f in &self.feeds {
            let Some((_, mode)) = SOURCES.iter().find(|(id, _)| *id == f.source) else {
                return Err(format!("feed {:?} is not a known source; known: {}", f.source, SOURCES.iter().map(|s| s.0).collect::<Vec<_>>().join(", ")));
            };
            if *mode != f.mode {
                return Err(format!("feed {:?} runs in mode {:?}, not {:?}", f.source, mode, f.mode));
            }
            if !seen.insert(f.source.as_str()) {
                return Err(format!("feed {:?} listed twice", f.source));
            }
        }
        if self.score.components.is_empty() {
            return Err("score.components is empty".into());
        }
        let mut seen = HashSet::new();
        for c in &self.score.components {
            if !seen.insert(c.id.as_str()) {
                return Err(format!("score component {:?} listed twice", c.id));
            }
            if !(c.weight >= 0.0 && c.weight.is_finite()) {
                return Err(format!("score component {:?}: weight must be a non-negative number", c.id));
            }
        }
        if self.windows.options_hours.contains(&0) || self.windows.default_hours == 0 {
            return Err("windows hours must be at least 1".into());
        }
        if self.windows.options_hours.is_empty() || !self.windows.options_hours.contains(&self.windows.default_hours) {
            return Err("windows.defaultHours must be one of windows.optionsHours".into());
        }
        let mut seen = HashSet::new();
        for l in &self.layers {
            if !id_ok(&l.id) {
                return Err(format!("layer id {:?} is not lowercase kebab-case", l.id));
            }
            if !seen.insert(l.id.as_str()) {
                return Err(format!("layer {:?} listed twice", l.id));
            }
        }
        if let Some(k) = self.legend.keys().find(|k| !seen.contains(k.as_str())) {
            return Err(format!("legend {k:?} names no layer in layers[]"));
        }
        blank("copy.about", &self.copy.about)?;
        blank("copy.region", &self.copy.region)?;
        if !TIMEZONES.contains(&self.copy.timezone.as_str()) {
            return Err(format!("copy.timezone {:?} is not one of {}", self.copy.timezone, TIMEZONES.join(", ")));
        }
        if self.helper_questions.is_empty() || self.helper_questions.len() > MAX_HELPER_QUESTIONS {
            return Err(format!("helperQuestions needs 1 to {MAX_HELPER_QUESTIONS} questions"));
        }
        if self.helper_questions.iter().any(|q| q.trim().is_empty()) {
            return Err("helperQuestions has an empty question".into());
        }
        for (what, v) in [("agent.persona", &self.agent.persona), ("agent.scope", &self.agent.scope), ("agent.refusal", &self.agent.refusal)] {
            blank(what, v)?;
        }
        let mut seen = HashSet::new();
        if self.agent.tools.is_empty() || self.agent.tools.iter().any(|t| t.trim().is_empty() || !seen.insert(t.as_str())) {
            return Err("agent.tools needs at least one tool, each named once".into());
        }
        blank("eval.goldenSet", &self.eval.golden_set)?;
        Ok(())
    }
}

/// The scoring grid of a region: its bbox at `cellDeg`, edges a whole multiple of
/// [`GRID_MULTIPLE`] cells.
pub fn grid_of(r: &RegionCfg) -> Result<Grid, String> {
    let b = r.bbox;
    if !(b.west < b.east && b.south < b.north) {
        return Err(format!("bbox {:?} needs west < east and south < north", <[f64; 4]>::from(b)));
    }
    if b.south < -90.0 || b.north > 90.0 || b.west < -180.0 || b.east > 180.0 {
        return Err("bbox leaves the globe".into());
    }
    if !(r.cell_deg > 0.0 && r.cell_deg.is_finite()) {
        return Err("cellDeg must be positive".into());
    }
    let cells = |span: f64, what: &str| -> Result<u32, String> {
        let n = span / r.cell_deg;
        let rounded = n.round();
        if (n - rounded).abs() > 1e-6 || !(1.0..=1e6).contains(&rounded) {
            return Err(format!("{what} {span:.4} deg is not a whole number of {} deg cells", r.cell_deg));
        }
        let n = rounded as u32;
        if !n.is_multiple_of(GRID_MULTIPLE) {
            return Err(format!("{what} is {n} cells; must be a multiple of {GRID_MULTIPLE}"));
        }
        Ok(n)
    };
    Ok(Grid { west: b.west, south: b.south, cell_deg: r.cell_deg, cols: cells(b.east - b.west, "width")?, rows: cells(b.north - b.south, "height")? })
}

// ---------------------------------------------------------------------------------------------
// Resolved runtime form
// ---------------------------------------------------------------------------------------------

/// A focus taxon at runtime. `idx` is its position in `taxa[]` and in every frame's hotspot
/// section; `taxon_id` is its `taxa.id` in the app's observations database (0 until
/// `App::resolve_taxa` ran against that database).
#[derive(Debug, Clone, PartialEq)]
pub struct Taxon {
    pub idx: u8,
    pub taxon_id: i64,
    pub cfg: TaxonCfg,
}

impl Taxon {
    pub fn id(&self) -> &str {
        &self.cfg.id
    }

    pub fn half_life_days(&self) -> f64 {
        self.cfg.half_life_days
    }

    pub fn rules(&self) -> &'static RuleSet {
        rules::ruleset(&self.cfg.rules).expect("validated rule set name")
    }

    /// Does an iNat taxon lineage (the taxon and its ancestors) fall under this taxon?
    pub fn matches_inat(&self, lineage: impl IntoIterator<Item = i64>) -> bool {
        let Some(root) = self.cfg.inat_taxon_id else { return false };
        lineage.into_iter().any(|id| id == root || self.cfg.inat_lineage_ids.contains(&id))
    }

    pub fn matches_gbif(&self, species_key: Option<i64>, genus_key: Option<i64>) -> bool {
        self.cfg.gbif_key.is_some_and(|k| species_key == Some(k) || genus_key == Some(k))
    }

    pub fn matches_nas(&self, genus: &str, species: &str) -> bool {
        self.cfg.nas_genus.as_deref() == Some(genus) && self.cfg.nas_species.as_deref().is_none_or(|s| s == species)
    }

    /// The taxon as the row writer resolves it: the config's scientific name, which the
    /// migration seeds (or the first ingest inserts) and the unique index keys on.
    pub fn taxon_ref(&self) -> TaxonRef {
        TaxonRef {
            scientific_name: self.cfg.scientific_name.clone(),
            common_name: self.cfg.name.clone(),
            inat_taxon_id: self.cfg.inat_taxon_id,
            iconic_group: self.cfg.iconic_group.clone(),
            ancestor_ids: None,
        }
    }
}

/// A region at runtime: its bbox, 0.01° scoring grid and the frame layout built from it.
#[derive(Debug, Clone, PartialEq)]
pub struct Region {
    pub idx: u8,
    pub cfg: RegionCfg,
    pub grid: Grid,
    pub layout: Layout,
}

impl Region {
    pub fn id(&self) -> &str {
        &self.cfg.id
    }

    pub fn bbox(&self) -> BBox {
        self.cfg.bbox
    }

    pub fn contains(&self, lat: f64, lon: f64) -> bool {
        self.cfg.bbox.contains(lat, lon)
    }
}

/// An app with its regions and taxa resolved.
#[derive(Debug, Clone)]
pub struct App {
    pub cfg: AppConfig,
    pub taxa: Vec<Taxon>,
    pub regions: Vec<Region>,
}

impl App {
    pub fn new(cfg: AppConfig) -> Result<App, ConfigError> {
        cfg.validate().map_err(|reason| ConfigError::Invalid { file: format!("spec/apps/{}.json", cfg.id), reason })?;
        let regions = cfg
            .regions
            .iter()
            .enumerate()
            .map(|(i, r)| {
                let grid = grid_of(r).expect("validated");
                let layout = Layout::for_grid(grid).map_err(|e| ConfigError::Invalid {
                    file: format!("spec/apps/{}.json", cfg.id),
                    reason: format!("region {:?}: {e:#}", r.id),
                })?;
                Ok(Region { idx: i as u8, cfg: r.clone(), grid, layout })
            })
            .collect::<Result<Vec<_>, ConfigError>>()?;
        let taxa = cfg.taxa.iter().enumerate().map(|(i, t)| Taxon { idx: i as u8, taxon_id: 0, cfg: t.clone() }).collect();
        Ok(App { cfg, taxa, regions })
    }

    pub fn builtin(id: &str) -> Result<App, ConfigError> {
        App::new(AppConfig::builtin(id)?)
    }

    pub fn id(&self) -> &str {
        &self.cfg.id
    }

    pub fn is_species(&self) -> bool {
        self.cfg.kind == AppKind::Species
    }

    /// Sync the `taxa` table with the config and learn each taxon's `taxa.id`: config taxa are
    /// upserted by scientific name with `focus = 1`; every other row loses focus. Runs on the
    /// database's first connection, before any reader or writer starts.
    pub fn resolve_taxa(&mut self, conn: &Connection) -> rusqlite::Result<()> {
        let mut upsert = conn.prepare(
            "insert into taxa (scientific_name, common_name, focus, inat_taxon_id, iconic_group) values (?1, ?2, 1, ?3, ?4)
             on conflict(scientific_name) do update set focus = 1,
               inat_taxon_id = coalesce(taxa.inat_taxon_id, excluded.inat_taxon_id),
               iconic_group = coalesce(taxa.iconic_group, excluded.iconic_group),
               common_name = case when taxa.common_name = '' then excluded.common_name else taxa.common_name end",
        )?;
        let mut select = conn.prepare("select id from taxa where scientific_name = ?1")?;
        for t in &mut self.taxa {
            upsert.execute(rusqlite::params![t.cfg.scientific_name, t.cfg.name, t.cfg.inat_taxon_id, t.cfg.iconic_group])?;
            t.taxon_id = select.query_row([&t.cfg.scientific_name], |r| r.get(0))?;
        }
        let names = serde_json::to_string(&self.taxa.iter().map(|t| t.cfg.scientific_name.as_str()).collect::<Vec<_>>())
            .expect("string list");
        conn.execute(
            "update taxa set focus = 0 where focus = 1 and scientific_name not in (select value from json_each(?1))",
            [names],
        )?;
        Ok(())
    }

    /// A taxon by config id (`python`), observations `taxa.id` (`1`) or scientific name.
    pub fn taxon(&self, s: &str) -> Option<&Taxon> {
        let s = s.trim();
        let lower = s.to_ascii_lowercase();
        self.taxa.iter().find(|t| {
            t.cfg.id == lower || t.cfg.scientific_name.eq_ignore_ascii_case(s) || (t.taxon_id > 0 && s == t.taxon_id.to_string())
        })
    }

    /// What a species argument may be, for error messages.
    pub fn taxon_choices(&self) -> String {
        let mut out: Vec<String> = self.taxa.iter().map(|t| t.cfg.id.clone()).collect();
        if self.taxa.iter().any(|t| t.taxon_id > 0) {
            out.push(format!("or taxon id {}", self.taxa.iter().map(|t| t.taxon_id.to_string()).collect::<Vec<_>>().join("/")));
        }
        out.join(", ")
    }

    pub fn region(&self, id: &str) -> Option<&Region> {
        self.regions.iter().find(|r| r.cfg.id == id)
    }

    /// The region containing a point (regions never overlap).
    pub fn region_of(&self, lat: f64, lon: f64) -> Option<&Region> {
        self.regions.iter().find(|r| r.contains(lat, lon))
    }

    /// Bounding box of every region.
    pub fn hull(&self) -> BBox {
        self.regions.iter().skip(1).fold(self.regions[0].cfg.bbox, |h, r| h.union(&r.cfg.bbox))
    }

    pub fn single_region(&self) -> bool {
        self.regions.len() == 1
    }

    /// Cell id of a scoring cell (C14): `<col>:<row>` in a single-region app,
    /// `<region>:<col>:<row>` otherwise.
    pub fn cell_id(&self, region: &Region, idx: usize) -> String {
        let cell = region.grid.cell_id(idx);
        if self.single_region() {
            cell
        } else {
            format!("{}:{cell}", region.cfg.id)
        }
    }

    /// Inverse of [`App::cell_id`]. A single-region app also accepts its region's id in front.
    pub fn parse_cell(&self, id: &str) -> Option<(&Region, usize)> {
        let parts: Vec<&str> = id.split(':').collect();
        match parts.as_slice() {
            [col, row] if self.single_region() => {
                let r = &self.regions[0];
                r.grid.parse_cell(&format!("{col}:{row}")).map(|i| (r, i))
            }
            [region, col, row] => {
                let r = self.region(region)?;
                r.grid.parse_cell(&format!("{col}:{row}")).map(|i| (r, i))
            }
            _ => None,
        }
    }

    /// The shape of a cell id, for error messages.
    pub fn cell_shape(&self) -> String {
        if self.single_region() {
            let g = &self.regions[0].grid;
            format!("<col>:<row> on the {} x {} grid", g.cols, g.rows)
        } else {
            format!("<region>:<col>:<row> with region one of {}", self.regions.iter().map(|r| r.cfg.id.as_str()).collect::<Vec<_>>().join(", "))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_config_loads_all_three_builtin_files() {
        let all = AppConfig::builtin_all().unwrap();
        assert_eq!(all.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), APP_IDS);
        let python = App::builtin("python").unwrap();
        assert_eq!(python.cfg.kind, AppKind::Species);
        assert_eq!(python.taxa.iter().map(|t| t.id()).collect::<Vec<_>>(), ["python", "tegu", "iguana", "lionfish"]);
        assert_eq!(python.regions.len(), 1);
        let g = python.regions[0].grid;
        assert_eq!((g.cols, g.rows, g.cell_deg), (340, 320, 0.01));
        assert_eq!((python.regions[0].layout.hs.cols, python.regions[0].layout.env.rows), (170, 64));
        assert!(python.cfg.has_feed("goes19") && python.cfg.has_feed("web"));

        let lionfish = App::builtin("lionfish").unwrap();
        assert_eq!(lionfish.regions.iter().map(|r| r.id()).collect::<Vec<_>>(), ["fl-keys", "mx-caribbean", "belize", "co-caribbean"]);
        assert_eq!(lionfish.taxa.len(), 1);
        assert!(lionfish.regions.iter().all(|r| r.grid.cols.is_multiple_of(10) && r.grid.rows.is_multiple_of(10)));
        assert!(lionfish.region("belize").unwrap().cfg.thin);
        // Every lionfish region is inside the hull and none overlaps another.
        let hull = lionfish.hull();
        for r in &lionfish.regions {
            assert!(hull.contains(r.bbox().south, r.bbox().west) && hull.contains(r.bbox().north, r.bbox().east));
        }
        assert_eq!(lionfish.cell_id(&lionfish.regions[1], 0), "mx-caribbean:0:0");
        assert_eq!(lionfish.parse_cell("mx-caribbean:0:0").map(|(r, i)| (r.id(), i)), Some(("mx-caribbean", 0)));
        assert_eq!(lionfish.parse_cell("0:0"), None, "a multi-region app needs the region");

        let carp = App::builtin("carp").unwrap();
        assert_eq!(carp.cfg.kind, AppKind::Conditions);
        assert!(carp.taxa.is_empty());
        assert!(carp.cfg.provisional && carp.cfg.locations.iter().all(|l| l.provisional));
        assert!(carp.cfg.has_feed("nwps"), "pending adapter may be listed");
        assert_eq!(python.cell_id(&python.regions[0], python.regions[0].grid.index(12, 7)), "12:7");
        assert_eq!(python.parse_cell("everglades:12:7").map(|(_, i)| i), python.parse_cell("12:7").map(|(_, i)| i));
    }

    #[test]
    fn app_config_rejects_invalid_files_with_typed_errors() {
        let base: serde_json::Value = serde_json::from_str(builtin_json("python").unwrap()).unwrap();
        let mutate = |f: &dyn Fn(&mut serde_json::Value)| {
            let mut v = base.clone();
            f(&mut v);
            AppConfig::parse("t.json", &v.to_string())
        };
        // Shape errors come from serde (unknown field, wrong type, missing field).
        let e = mutate(&|v| v["bogus"] = serde_json::json!(1)).unwrap_err();
        assert!(matches!(e, ConfigError::Json { .. }), "{e}");
        assert!(e.to_string().contains("bogus"), "{e}");
        let e = mutate(&|v| v["kind"] = serde_json::json!("hotspots")).unwrap_err();
        assert!(matches!(e, ConfigError::Json { .. }), "{e}");
        let e = mutate(&|v| {
            v.as_object_mut().unwrap().remove("agent");
        })
        .unwrap_err();
        assert!(matches!(e, ConfigError::Json { .. }) && e.to_string().contains("agent"), "{e}");
        // Rule errors come from validate.
        for (f, needle) in [
            // Shrink the east edge by half a hotspot cell, by half a scoring cell, or swap the edges.
            (&(|v: &mut serde_json::Value| {
                let e = v["regions"][0]["bbox"][2].as_f64().unwrap();
                v["regions"][0]["bbox"][2] = serde_json::json!(e - 0.05);
            }) as &dyn Fn(&mut serde_json::Value), "multiple of 10"),
            (&|v| {
                let e = v["regions"][0]["bbox"][2].as_f64().unwrap();
                v["regions"][0]["bbox"][2] = serde_json::json!(e - 0.005);
            }, "whole number"),
            (&|v| {
                let (w, e) = (v["regions"][0]["bbox"][0].clone(), v["regions"][0]["bbox"][2].clone());
                v["regions"][0]["bbox"][0] = e;
                v["regions"][0]["bbox"][2] = w;
            }, "west < east"),
            (&|v| v["taxa"][0]["rules"] = serde_json::json!("dragon"), "unknown rules"),
            (&|v| v["taxa"][1]["id"] = serde_json::json!("python"), "duplicate taxon id"),
            (&|v| v["feeds"][0]["source"] = serde_json::json!("twitter"), "not a known source"),
            (&|v| v["feeds"][0]["mode"] = serde_json::json!("push"), "runs in mode"),
            (&|v| v["windows"]["defaultHours"] = serde_json::json!(5), "defaultHours"),
            (&|v| v["kind"] = serde_json::json!("conditions"), "must list no taxa"),
            (&|v| v["id"] = serde_json::json!("otter"), "not one of"),
            (&|v| {
                let r = v["regions"][0].clone();
                v["regions"].as_array_mut().unwrap().push(r);
            }, "duplicate region id"),
            (&|v| {
                let mut r = v["regions"][0].clone();
                r["id"] = serde_json::json!("twin");
                r["bbox"] = serde_json::json!([-82.0, 25.0, -80.0, 27.0]);
                v["regions"].as_array_mut().unwrap().push(r);
            }, "overlap"),
        ] {
            let e = mutate(f).unwrap_err();
            assert!(matches!(e, ConfigError::Invalid { .. }), "{needle}: {e}");
            assert!(e.to_string().contains(needle), "{needle}: {e}");
        }
        assert!(matches!(App::builtin("otter").unwrap_err(), ConfigError::UnknownApp(_)));
    }

    fn spec_dir() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../spec/apps")
    }

    /// The shared invalid corpus (`spec/apps/invalid/*.json`, each named for the field it breaks):
    /// every file must be refused here and by the web's zod (`app config conformance` in
    /// apps/web/tests/shared/apps/schema.test.ts). `bun scripts/gen-invalid-app-configs.ts` writes it.
    #[test]
    fn app_config_conformance_rejects_the_shared_invalid_corpus() {
        let mut files: Vec<_> = std::fs::read_dir(spec_dir().join("invalid"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .collect();
        files.sort();
        assert!(files.len() >= 20, "corpus has {} files", files.len());
        for f in &files {
            let json = std::fs::read_to_string(f).unwrap();
            let name = f.file_name().unwrap().to_string_lossy().to_string();
            assert!(AppConfig::parse(&name, &json).is_err(), "{name} parsed but must be refused");
        }
    }

    /// The closed lists in this file equal the schema's enums.
    #[test]
    fn app_config_conformance_enums_match_the_schema() {
        let schema: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(spec_dir().join("app-config.schema.json")).unwrap()).unwrap();
        let p = &schema["properties"];
        let list = |v: &serde_json::Value| v.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(list(&p["id"]["enum"]), APP_IDS);
        assert_eq!(list(&p["feeds"]["items"]["properties"]["source"]["enum"]), SOURCES.iter().map(|s| s.0).collect::<Vec<_>>());
        assert_eq!(list(&p["taxa"]["items"]["properties"]["category"]["enum"]), CATEGORIES);
        assert_eq!(list(&p["taxa"]["items"]["properties"]["rules"]["enum"]), rules::names());
        assert_eq!(list(&p["copy"]["properties"]["timezone"]["enum"]), TIMEZONES);
        assert_eq!(p["helperQuestions"]["maxItems"].as_u64(), Some(MAX_HELPER_QUESTIONS as u64));
        let cfg = AppConfig::builtin("carp").unwrap();
        assert_eq!((cfg.copy.timezone.as_str(), cfg.copy.extra.contains_key("about")), ("America/Chicago", false));
        // Round trip: what Rust writes back parses again, unchanged.
        for id in APP_IDS {
            let cfg = AppConfig::builtin(id).unwrap();
            assert_eq!(AppConfig::parse(id, &serde_json::to_string(&cfg).unwrap()).unwrap(), cfg);
        }
    }

    #[test]
    fn app_config_taxon_matching_and_refs() {
        let app = App::builtin("python").unwrap();
        let lionfish = app.taxon("lionfish").unwrap();
        assert!(lionfish.matches_inat([123459, 47284]) && lionfish.matches_inat([47280]) && !lionfish.matches_inat([1]));
        assert!(lionfish.matches_gbif(Some(2334433), Some(2334432)) && !lionfish.matches_gbif(Some(1), Some(2)));
        assert!(lionfish.matches_nas("Pterois", "volitans/miles") && lionfish.matches_nas("Pterois", "miles"));
        let python = app.taxon("Python bivittatus").unwrap();
        assert!(python.matches_nas("Python", "bivittatus") && !python.matches_nas("Python", "sebae"));
        assert_eq!(python.taxon_ref().common_name, "Burmese python");
        assert_eq!(python.rules().name, "python");
        assert_eq!(app.taxon("TEGU").map(|t| t.idx), Some(1));
        assert_eq!(app.taxon("1"), None, "db ids resolve only after resolve_taxa");
    }

    #[test]
    fn app_config_resolves_taxa_against_the_seeded_db() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&mut conn, "observations").unwrap();
        let mut app = App::builtin("lionfish").unwrap();
        app.resolve_taxa(&conn).unwrap();
        assert_eq!(app.taxa[0].taxon_id, 4, "the seeded lionfish row");
        let focus: Vec<i64> =
            conn.prepare("select id from taxa where focus = 1 order by id").unwrap().query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(focus, [4], "python, tegu and iguana lose focus in the lionfish app");
        assert_eq!(app.taxon("4").map(|t| t.id()), Some("lionfish"));
        let mut python = App::builtin("python").unwrap();
        python.resolve_taxa(&conn).unwrap();
        assert_eq!(python.taxa.iter().map(|t| t.taxon_id).collect::<Vec<_>>(), [1, 2, 3, 4]);
        let n: i64 = conn.query_row("select count(*) from taxa where focus = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 4);
    }
}
