//! GraphQL types mirroring `api/schema.graphql` one to one (PLAN.md C2). Field names are the
//! Rust snake_case of the SDL camelCase names; async-graphql converts them.

use async_graphql::{
    Enum, InputObject, InputValueError, InputValueResult, Scalar, ScalarType, SimpleObject, Value, ID,
};
use chrono::{DateTime, SecondsFormat};

use crate::app::config::App;
use crate::feed_state;
use crate::forecast;
use crate::hotspot::lionfish;
use crate::ingest::quality_bio::DateBasis;

/// RFC 3339 timestamp, carried as unix milliseconds (the storage format of every time column).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Time(pub i64);

#[Scalar(name = "Time")]
impl ScalarType for Time {
    fn parse(value: Value) -> InputValueResult<Self> {
        match &value {
            Value::String(s) => DateTime::parse_from_rfc3339(s)
                .map(|t| Time(t.timestamp_millis()))
                .map_err(|e| InputValueError::custom(format!("expected an RFC 3339 time, got {s:?}: {e}"))),
            _ => Err(InputValueError::expected_type(value)),
        }
    }

    fn to_value(&self) -> Value {
        match DateTime::from_timestamp_millis(self.0) {
            Some(t) => Value::String(t.to_rfc3339_opts(SecondsFormat::Millis, true)),
            // Outside chrono's range (±262,000 years); no stored time gets here.
            None => Value::Null,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, InputObject)]
#[graphql(name = "BBox")]
pub struct BBox {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

impl BBox {
    /// Rejects NaN, inverted boxes and boxes reaching outside the app's regions (their bounding
    /// box, `App::hull`; 1e-9 degrees of slack for decimal round-off). A single-region app keeps
    /// the pre-pivot rule: inside its one region.
    pub fn validate(&self, app: &App) -> async_graphql::Result<()> {
        const EPS: f64 = 1e-9;
        let BBox { west, south, east, north } = *self;
        let r = app.hull();
        if !(west < east && south < north) {
            return Err(format!("invalid bbox {self:?}: need west < east and south < north").into());
        }
        if west < r.west - EPS || south < r.south - EPS || east > r.east + EPS || north > r.north + EPS {
            return Err(format!(
                "invalid bbox {self:?}: must lie inside the region (west {}, south {}, east {}, north {})",
                r.west, r.south, r.east, r.north
            )
            .into());
        }
        Ok(())
    }
}

/// SQL text of the enums stored in `observations.db` (lowercase snake_case, as in the migration
/// `check` constraints), both ways.
macro_rules! db_text {
    ($ty:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        impl $ty {
            pub fn db(self) -> &'static str {
                match self { $($ty::$variant => $text),+ }
            }
            pub fn from_db(s: &str) -> Option<$ty> {
                match s { $($text => Some($ty::$variant),)+ _ => None }
            }
        }
    };
}

db_text!(Quality { Research => "research", NeedsId => "needs_id", Casual => "casual", Curated => "curated" });
db_text!(Param {
    LstC => "lst_c", AirC => "air_c", WaterC => "water_c", SstC => "sst_c", RainMm => "rain_mm",
    StageM => "stage_m", WaveM => "wave_m", WindMs => "wind_ms", FireFrp => "fire_frp",
    Sst => "sst", SstAnomaly => "sst_anomaly", Dhw => "dhw", Baa => "baa",
    WavePeriodS => "wave_period_s", CurrentMs => "current_ms", CurrentDirDeg => "current_dir_deg",
});
db_text!(ReadingOrigin { Measured => "measured", Satellite => "satellite", Modeled => "modeled" });
db_text!(ReadingFlag { Ok => "ok", Cloud => "cloud", BadDqf => "bad_dqf", Missing => "missing" });

#[derive(Debug, Clone, Copy, PartialEq, Eq, Enum)]
pub enum FeedMode {
    Push,
    Poll,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Enum)]
pub enum FeedHealth {
    Nominal,
    Lagging,
    Stale,
    Down,
}

impl From<feed_state::Health> for FeedHealth {
    fn from(h: feed_state::Health) -> Self {
        match h {
            feed_state::Health::Nominal => FeedHealth::Nominal,
            feed_state::Health::Lagging => FeedHealth::Lagging,
            feed_state::Health::Stale => FeedHealth::Stale,
            feed_state::Health::Down => FeedHealth::Down,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Enum)]
pub enum Quality {
    Research,
    NeedsId,
    Casual,
    Curated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Enum)]
pub enum Param {
    LstC,
    AirC,
    WaterC,
    SstC,
    RainMm,
    StageM,
    WaveM,
    WindMs,
    FireFrp,
    Sst,
    SstAnomaly,
    Dhw,
    Baa,
    WavePeriodS,
    CurrentMs,
    CurrentDirDeg,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Enum)]
pub enum ReadingOrigin {
    Measured,
    Satellite,
    Modeled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Enum)]
pub enum ReadingFlag {
    Ok,
    Cloud,
    BadDqf,
    Missing,
}

#[derive(Debug, Clone, SimpleObject)]
pub struct FeedState {
    pub source: String,
    pub mode: FeedMode,
    pub state: FeedHealth,
    pub newest_observed_at: Option<Time>,
    pub last_fetch_at: Option<Time>,
    pub last_fetch_run_id: Option<ID>,
    pub lag_seconds: Option<i64>,
    pub note: Option<String>,
}

impl From<feed_state::FeedState> for FeedState {
    fn from(s: feed_state::FeedState) -> Self {
        FeedState {
            // `sources.mode` is push|poll|webhook (migration 0006). A webhook source is a poller
            // the provider nudges, so it stays POLL here; the SDL and the web chips know two modes.
            mode: if s.mode == "push" { FeedMode::Push } else { FeedMode::Poll },
            source: s.source,
            state: s.state.into(),
            newest_observed_at: s.newest_observed_at.map(Time),
            last_fetch_at: s.last_fetch_at.map(Time),
            last_fetch_run_id: s.last_fetch_run_id.map(ID),
            lag_seconds: s.lag_seconds,
            note: s.note,
        }
    }
}

#[derive(Debug, Clone, SimpleObject)]
pub struct Taxon {
    pub id: ID,
    pub scientific_name: String,
    pub common_name: String,
    pub focus: bool,
    /// iNaturalist taxon id (T44); null for taxa only GBIF or NAS have reported.
    pub inat_taxon_id: Option<ID>,
    /// Reptilia, Amphibia, Aves, Mammalia, Actinopterygii, Mollusca, Insecta, Arachnida, Plantae, Fungi or other.
    pub iconic_group: Option<String>,
    /// Plain text, at most two sentences, from the taxon's Wikipedia summary.
    pub summary: Option<String>,
    /// Same-origin copy of the taxon's default photo (`/v1/media/taxon/<id>`).
    pub photo_url: Option<String>,
    /// The taxon's page at iNaturalist, for a new-tab link.
    pub page_url: Option<String>,
    /// iNat ancestor taxon ids, root first (the web app derives the category: snakes, lizards, ...). Null when unknown.
    pub ancestor_ids: Option<Vec<ID>>,
}

/// `taxa.ancestor_ids` JSON text to ids; unreadable text reads as unknown.
pub fn ancestry_from_db(text: Option<String>) -> Option<Vec<ID>> {
    let ids: Vec<i64> = serde_json::from_str(text?.as_str()).ok()?;
    Some(ids.into_iter().map(|n| ID(n.to_string())).collect())
}

impl Taxon {
    /// Column order of [`Taxon::COLUMNS`] in a `select` over `taxa t`.
    pub const COLUMNS: &'static str =
        "t.id, t.scientific_name, t.common_name, t.focus, t.inat_taxon_id, t.iconic_group, t.summary_plain, t.photo_url, t.ancestor_ids";

    /// Read the nine [`Taxon::COLUMNS`] starting at `at`.
    pub fn from_row(r: &rusqlite::Row<'_>, at: usize) -> rusqlite::Result<Taxon> {
        let id: i64 = r.get(at)?;
        let inat: Option<i64> = r.get(at + 4)?;
        let photo: Option<String> = r.get(at + 7)?;
        Ok(Taxon {
            id: ID(id.to_string()),
            scientific_name: r.get(at + 1)?,
            common_name: r.get(at + 2)?,
            focus: r.get(at + 3)?,
            inat_taxon_id: inat.map(|n| ID(n.to_string())),
            iconic_group: r.get(at + 5)?,
            summary: r.get(at + 6)?,
            photo_url: photo.map(|_| format!("/v1/media/taxon/{id}")),
            page_url: inat.map(crate::taxon_info::page_url),
            ancestor_ids: ancestry_from_db(r.get(at + 8)?),
        })
    }
}

/// Sightings of one taxon in a window (T44 `speciesCounts`).
#[derive(Debug, Clone, SimpleObject)]
pub struct SpeciesCount {
    pub taxon: Taxon,
    /// Distinct sightings (duplicates stand behind their canonical record).
    pub count: i32,
    /// The newest sighting counted, citable as `sighting:<id>`.
    pub latest_sighting_id: Option<ID>,
}

#[derive(Debug, Clone, SimpleObject)]
pub struct Sighting {
    pub id: ID,
    pub source: String,
    pub ext_id: String,
    pub taxon: Taxon,
    pub lat: f64,
    pub lon: f64,
    pub accuracy_m: Option<f64>,
    pub observed_at: Time,
    pub quality: Quality,
    pub photo_url: Option<String>,
    pub canonical_id: Option<ID>,
    pub conflict: bool,
    /// When the record was first stored. `ingestedAt - observedAt` is its ingest lag; over 24 h
    /// the record is late (frame flag 4).
    pub ingested_at: Time,
}

#[derive(Debug, Clone, SimpleObject)]
pub struct Station {
    pub id: ID,
    pub source: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    pub kind: String,
}

#[derive(Debug, Clone, SimpleObject)]
pub struct Reading {
    pub station: Station,
    pub param: Param,
    pub value: Option<f64>,
    pub flag: ReadingFlag,
    pub observed_at: Time,
    pub origin: ReadingOrigin,
}

#[derive(Debug, Clone, SimpleObject)]
pub struct Alert {
    pub id: ID,
    pub event: String,
    pub severity: String,
    pub headline: Option<String>,
    pub area_geojson: Option<serde_json::Value>,
    pub onset: Option<Time>,
    pub expires: Option<Time>,
}

#[derive(Debug, Clone, SimpleObject)]
pub struct FrameChunk {
    pub from: Time,
    pub to: Time,
    pub step_minutes: i32,
    pub frame_count: i32,
    /// Base64 of the EVF2 binary format (PLAN.md C4), at most 24 frames.
    pub data: String,
}

/// State of one priority component (L5). UNKNOWN carries a null value: unknown is not zero.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Enum)]
pub enum ComponentState {
    Ok,
    Unknown,
    Stale,
}

impl From<lionfish::State> for ComponentState {
    fn from(s: lionfish::State) -> Self {
        match s {
            lionfish::State::Ok => ComponentState::Ok,
            lionfish::State::Unknown => ComponentState::Unknown,
            lionfish::State::Stale => ComponentState::Stale,
        }
    }
}

/// Which date decides what a frame at `at` knew: SUBMITTED (default; iNat `created_at`, else
/// ingest time) or OBSERVED.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Enum)]
pub enum HotspotBasis {
    Submitted,
    Observed,
}

impl From<HotspotBasis> for DateBasis {
    fn from(b: HotspotBasis) -> Self {
        match b {
            HotspotBasis::Submitted => DateBasis::Submitted,
            HotspotBasis::Observed => DateBasis::Observed,
        }
    }
}

impl From<DateBasis> for HotspotBasis {
    fn from(b: DateBasis) -> Self {
        match b {
            DateBasis::Submitted => HotspotBasis::Submitted,
            DateBasis::Observed => HotspotBasis::Observed,
        }
    }
}

/// Per-query rank weight overrides; each finite and >= 0, not all 0. Missing ones keep the config.
#[derive(Debug, Clone, Copy, PartialEq, InputObject)]
pub struct HotspotWeightsInput {
    pub recent_reports: Option<f64>,
    pub id_quality: Option<f64>,
    pub heat_stress: Option<f64>,
}

/// The rank weights in force. `completeness` never has one.
#[derive(Debug, Clone, Copy, PartialEq, SimpleObject)]
pub struct HotspotWeights {
    pub recent_reports: f64,
    pub id_quality: f64,
    pub heat_stress: f64,
}

impl From<lionfish::Weights> for HotspotWeights {
    fn from(w: lionfish::Weights) -> Self {
        HotspotWeights { recent_reports: w.recent_reports as f64, id_quality: w.id_quality as f64, heat_stress: w.heat_stress as f64 }
    }
}

/// One input of a component: a C14 record id with its dates and how it counted.
#[derive(Debug, Clone, SimpleObject)]
pub struct HotspotEvidence {
    pub id: ID,
    pub kind: String,
    pub observed_at: Option<Time>,
    pub submitted_at: Option<Time>,
    pub ingested_at: Option<Time>,
    /// Weight in the component; null when the record did not count (duplicate, out of window).
    pub weight: Option<f64>,
    pub detail: String,
    /// Photo (sightings) or product DOI (CRW).
    pub url: Option<String>,
}

impl From<lionfish::EvidenceItem> for HotspotEvidence {
    fn from(e: lionfish::EvidenceItem) -> Self {
        HotspotEvidence {
            id: ID(e.id),
            kind: e.kind.to_string(),
            observed_at: e.observed_at.map(Time),
            submitted_at: e.submitted_at.map(Time),
            ingested_at: e.ingested_at.map(Time),
            weight: e.weight.map(f64::from),
            detail: e.detail,
            url: e.url,
        }
    }
}

/// One of the four priority components of a cell, in [0, 1] with its own state and inputs.
#[derive(Debug, Clone, SimpleObject)]
pub struct HotspotComponent {
    pub id: ID,
    /// Null when the state is UNKNOWN or STALE.
    pub value: Option<f64>,
    pub state: ComponentState,
    /// Weight in rankScore (0 for completeness, which never ranks).
    pub weight: f64,
    pub rationale: String,
    /// C14 ids of the records that counted (`sighting:<id>`, `reading:<station>:<param>:<ms>:satellite`), or notes.
    pub inputs: Vec<String>,
    /// Every record in reach with dates and weights; filled by `explainCell`, empty in `hotspots`.
    pub evidence: Vec<HotspotEvidence>,
}

impl From<lionfish::Component> for HotspotComponent {
    fn from(c: lionfish::Component) -> Self {
        HotspotComponent {
            id: ID(c.id.to_string()),
            value: c.value.map(f64::from),
            state: c.state.into(),
            weight: c.weight as f64,
            rationale: c.rationale,
            inputs: c.inputs,
            evidence: c.evidence.into_iter().map(Into::into).collect(),
        }
    }
}

#[derive(Debug, Clone, SimpleObject)]
pub struct HotspotComponents {
    pub recent_reports: HotspotComponent,
    pub id_quality: HotspotComponent,
    pub heat_stress: HotspotComponent,
    pub completeness: HotspotComponent,
}

impl From<lionfish::Components> for HotspotComponents {
    fn from(c: lionfish::Components) -> Self {
        HotspotComponents {
            recent_reports: c.recent_reports.into(),
            id_quality: c.id_quality.into(),
            heat_stress: c.heat_stress.into(),
            completeness: c.completeness.into(),
        }
    }
}

/// NOAA Coral Reef Watch values at the cell's 5 km pixel. DHW (accumulated) and BAA (current alert
/// level) can disagree and are both shown.
#[derive(Debug, Clone, SimpleObject)]
pub struct HeatStress {
    /// Degree heating weeks, °C-weeks.
    pub dhw: Option<f64>,
    /// Bleaching alert area level 0-4.
    pub baa: Option<f64>,
    pub sst: Option<f64>,
    pub anomaly: Option<f64>,
    /// Product day (12:00Z).
    pub observed_at: Time,
    pub ingested_at: Time,
    /// `stations.id` of the pixel; readings cite `reading:<station>:<param>:<observedAt ms>:satellite`.
    pub station: ID,
    pub credit: String,
}

impl From<lionfish::Heat> for HeatStress {
    fn from(h: lionfish::Heat) -> Self {
        HeatStress {
            dhw: h.dhw,
            baa: h.baa,
            sst: h.sst,
            anomaly: h.anomaly,
            observed_at: Time(h.observed_at),
            ingested_at: Time(h.ingested_at),
            station: ID(h.station.to_string()),
            credit: crate::source_pages::CRW_CREDIT.to_string(),
        }
    }
}

/// Field conditions over the next 72 h from the nearest Open-Meteo Marine point (the newest run
/// issued by `at`). Planning context only; never part of rankScore.
#[derive(Debug, Clone, SimpleObject)]
pub struct FieldWindow {
    pub state: ComponentState,
    pub issued_at: Option<Time>,
    pub wave_max_m: Option<f64>,
    pub wave_min_m: Option<f64>,
    /// Forecast hours with waves under 1.2 m.
    pub calm_hours: Option<i32>,
    pub horizon_hours: i32,
    pub current_max_ms: Option<f64>,
    pub station: ID,
}

impl From<lionfish::FieldWindow> for FieldWindow {
    fn from(f: lionfish::FieldWindow) -> Self {
        FieldWindow {
            state: f.state.into(),
            issued_at: f.issued_at.map(Time),
            wave_max_m: f.wave_max_m.map(f64::from),
            wave_min_m: f.wave_min_m.map(f64::from),
            calm_hours: f.calm_hours.map(|h| h as i32),
            horizon_hours: f.horizon_hours as i32,
            current_max_ms: f.current_max_ms.map(f64::from),
            station: ID(f.station.to_string()),
        }
    }
}

#[derive(Debug, Clone, SimpleObject)]
pub struct HotspotCell {
    pub cell: ID,
    pub lat: f64,
    pub lon: f64,
    /// density × activity × access (python), or `rankScore` for a component app.
    pub score: f64,
    /// Component apps (Lionfish Watch) only; null for python.
    pub region_id: Option<ID>,
    /// Weighted mean of recentReports, idQuality and heatStress: orders cells, nothing more.
    /// recentReports is normalised per region, so pass `region` to rank within one.
    pub rank_score: Option<f64>,
    /// Too few recent independent reports (or configured thin): the rank is shown with low confidence.
    pub thin: Option<bool>,
    pub components: Option<HotspotComponents>,
    pub heat: Option<HeatStress>,
    pub field_window: Option<FieldWindow>,
}

impl HotspotCell {
    pub fn from_lionfish(c: lionfish::CellScore) -> HotspotCell {
        HotspotCell {
            cell: ID(c.cell),
            lat: c.lat,
            lon: c.lon,
            score: c.rank_score as f64,
            region_id: Some(ID(c.region)),
            rank_score: Some(c.rank_score as f64),
            thin: Some(c.thin),
            components: Some(c.components.into()),
            heat: c.heat.map(Into::into),
            field_window: c.field_window.map(Into::into),
        }
    }
}

#[derive(Debug, Clone, SimpleObject)]
pub struct HotspotGrid {
    pub species: ID,
    pub at: Time,
    pub cells: Vec<HotspotCell>,
    /// Component apps only.
    pub weights: Option<HotspotWeights>,
    pub basis: Option<HotspotBasis>,
}

#[derive(Debug, Clone, SimpleObject)]
pub struct HotspotTerm {
    pub name: String,
    pub value: f64,
    pub rationale: String,
}

#[derive(Debug, Clone, SimpleObject)]
pub struct HotspotExplain {
    pub cell: ID,
    pub species: ID,
    pub at: Time,
    pub score: f64,
    /// Python's multiplicative terms; empty for a component app.
    pub terms: Vec<HotspotTerm>,
    /// Component apps only: the four components with every input, the CRW values, the field window.
    pub region_id: Option<ID>,
    pub rank_score: Option<f64>,
    pub thin: Option<bool>,
    pub components: Option<HotspotComponents>,
    pub heat: Option<HeatStress>,
    pub field_window: Option<FieldWindow>,
    pub weights: Option<HotspotWeights>,
    pub basis: Option<HotspotBasis>,
    /// Honesty caveats the answer must carry (sightings are not abundance; heat stress is context; no causal claim).
    pub caveats: Vec<String>,
    pub credit: Option<String>,
}

impl HotspotExplain {
    pub fn from_lionfish(species: ID, at: Time, ex: lionfish::CellExplain) -> HotspotExplain {
        let c = ex.cell;
        HotspotExplain {
            cell: ID(c.cell),
            species,
            at,
            score: c.rank_score as f64,
            terms: Vec::new(),
            region_id: Some(ID(c.region)),
            rank_score: Some(c.rank_score as f64),
            thin: Some(c.thin),
            components: Some(c.components.into()),
            heat: c.heat.map(Into::into),
            field_window: c.field_window.map(Into::into),
            weights: Some(ex.weights.into()),
            basis: Some(ex.basis.into()),
            caveats: ex.caveats.into_iter().map(str::to_string).collect(),
            credit: Some(ex.credit.to_string()),
        }
    }
}

#[derive(Debug, Clone, SimpleObject)]
pub struct BacktestDay {
    pub day: Time,
    pub sightings: i32,
    pub hits: i32,
}

#[derive(Debug, Clone, SimpleObject)]
pub struct Backtest {
    pub species: ID,
    pub days: i32,
    pub hit_rate: f64,
    pub baseline: f64,
    pub per_day: Vec<BacktestDay>,
    /// Days after each evaluation day in which a report counts (1 for python, 7 for lionfish).
    pub horizon_days: i32,
    pub evaluated: i32,
    pub hits: i32,
    /// Regions with too little data to score at all (thin): reported, not scored.
    pub insufficient_regions: Vec<ID>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, SimpleObject)]
pub struct EvidenceLink {
    pub id: ID,
    pub relation: String,
    pub source: String,
}

#[derive(Debug, Clone, SimpleObject)]
pub struct Evidence {
    pub id: ID,
    pub kind: String,
    pub record: serde_json::Value,
    pub raw: Option<serde_json::Value>,
    pub raw_key: Option<String>,
    pub source_url: Option<String>,
    /// Publisher web page for this record, for a new-tab link (PLAN.md C19). Null when none exists.
    pub source_page_url: Option<String>,
    pub fetched_at: Option<Time>,
    pub ingest_lag_seconds: Option<i64>,
    pub feed: Option<FeedState>,
    pub links: Vec<EvidenceLink>,
}

/// A persisted CRDT op (PLAN.md C5) with its server sequence number.
#[derive(Debug, Clone, PartialEq, SimpleObject)]
pub struct Op {
    pub seq: i64,
    pub id: ID,
    pub hlc: String,
    pub board_id: ID,
    pub entity: String,
    pub entity_id: ID,
    pub field: String,
    pub value: Option<serde_json::Value>,
    pub node_id: String,
}

impl Op {
    /// Build from the payload of `realtime::Event::Op`: the C5 op JSON
    /// (`{id, hlc, boardId, entity, entityId, field, value, nodeId}`). `board_id` and `seq` come
    /// from the event itself. Returns None when a required field is missing.
    pub fn from_event(board_id: &str, seq: i64, op: &serde_json::Value) -> Option<Op> {
        let text = |key: &str| op.get(key).and_then(serde_json::Value::as_str).map(str::to_owned);
        Some(Op {
            seq,
            id: ID(text("id")?),
            hlc: text("hlc")?,
            board_id: ID(board_id.to_owned()),
            entity: text("entity")?,
            entity_id: ID(text("entityId")?),
            field: text("field")?,
            value: op.get("value").filter(|v| !v.is_null()).cloned(),
            node_id: text("nodeId")?,
        })
    }
}

#[derive(Debug, Clone, InputObject)]
pub struct OpInput {
    pub id: ID,
    pub hlc: String,
    pub entity: String,
    pub entity_id: ID,
    pub field: String,
    pub value: Option<serde_json::Value>,
    pub node_id: String,
}

#[derive(Debug, Clone, SimpleObject)]
pub struct ApplyResult {
    pub applied: i32,
    pub duplicates: i32,
    pub last_seq: i64,
}

#[derive(Debug, Clone, SimpleObject)]
pub struct Mission {
    pub id: ID,
    pub fields: serde_json::Value,
}

#[derive(Debug, Clone, SimpleObject)]
pub struct Message {
    pub id: ID,
    pub body: String,
    pub hlc: String,
    pub node_id: String,
}

#[derive(Debug, Clone, SimpleObject)]
pub struct Board {
    pub id: ID,
    pub last_seq: i64,
    pub missions: Vec<Mission>,
    pub notes: Vec<Mission>,
    pub messages: Vec<Message>,
    pub removals: serde_json::Value,
}

#[derive(Debug, Clone, SimpleObject)]
pub struct FrameRange {
    pub from: Time,
    pub to: Time,
}

// ---------------------------------------------------------------------------------------------
// Forecast store (C3): conditions apps only. Mirrors `crate::forecast`.
// ---------------------------------------------------------------------------------------------

/// NWPS flood category, from NWPS stage thresholds only ("at or above").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Enum)]
pub enum FloodCategory {
    None,
    Action,
    Minor,
    Moderate,
    Major,
}

impl From<forecast::Category> for FloodCategory {
    fn from(c: forecast::Category) -> Self {
        match c {
            forecast::Category::None => FloodCategory::None,
            forecast::Category::Action => FloodCategory::Action,
            forecast::Category::Minor => FloodCategory::Minor,
            forecast::Category::Moderate => FloodCategory::Moderate,
            forecast::Category::Major => FloodCategory::Major,
        }
    }
}

/// Where a forecast row came from. `NWPS_LIVE` rows were captured by this process (as-of views
/// gate them by ingestion time); `IEM_ARCHIVE` rows were backfilled from the Iowa Environmental
/// Mesonet HML archive (gated by issuance time only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Enum)]
pub enum ForecastSource {
    NwpsLive,
    IemArchive,
    NwsGridpoint,
}

impl From<forecast::Source> for ForecastSource {
    fn from(s: forecast::Source) -> Self {
        match s {
            forecast::Source::NwpsLive => ForecastSource::NwpsLive,
            forecast::Source::IemArchive => ForecastSource::IemArchive,
            forecast::Source::NwsGridpoint => ForecastSource::NwsGridpoint,
        }
    }
}

/// Age band at the as-of time. Observations: FRESH <= 2 h, AGING <= 6 h, else STALE.
/// Forecasts: FRESH <= 24 h since issuance, AGING <= 36 h, else STALE. MISSING: nothing known.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Enum)]
pub enum Freshness {
    Fresh,
    Aging,
    Stale,
    Missing,
}

impl From<forecast::query::Freshness> for Freshness {
    fn from(f: forecast::query::Freshness) -> Self {
        match f {
            forecast::query::Freshness::Fresh => Freshness::Fresh,
            forecast::query::Freshness::Aging => Freshness::Aging,
            forecast::query::Freshness::Stale => Freshness::Stale,
            forecast::query::Freshness::Missing => Freshness::Missing,
        }
    }
}

#[derive(Debug, Clone, SimpleObject)]
pub struct FloodThresholds {
    pub action_ft: Option<f64>,
    pub minor_ft: Option<f64>,
    pub moderate_ft: Option<f64>,
    pub major_ft: Option<f64>,
}

impl From<forecast::Thresholds> for FloodThresholds {
    fn from(t: forecast::Thresholds) -> Self {
        FloodThresholds { action_ft: t.action_ft, minor_ft: t.minor_ft, moderate_ft: t.moderate_ft, major_ft: t.major_ft }
    }
}

#[derive(Debug, Clone, SimpleObject)]
pub struct ForecastPoint {
    pub valid_at: Time,
    /// NWPS stage, feet.
    pub stage_ft: Option<f64>,
    /// NWPS flow, kcfs (USGS discharge is cfs).
    pub flow_kcfs: Option<f64>,
    /// Null when the stage or the site's thresholds were unknown when stored.
    pub category: Option<FloodCategory>,
}

impl From<forecast::StoredPoint> for ForecastPoint {
    fn from(p: forecast::StoredPoint) -> Self {
        ForecastPoint { valid_at: Time(p.valid_at), stage_ft: p.stage_ft, flow_kcfs: p.flow_kcfs, category: p.category.map(Into::into) }
    }
}

/// One forecast issuance as stored. Cite as `forecast:<id>`.
#[derive(Debug, Clone, SimpleObject)]
pub struct ForecastSnapshot {
    pub id: ID,
    /// NWPS lid (`locations[].nwps`).
    pub site: ID,
    /// `stageflow` (NWPS API), `hml` (IEM archive), ...
    pub product: String,
    pub issued_at: Time,
    pub ingested_at: Time,
    pub source: ForecastSource,
    pub payload_hash: String,
    /// 0 for the first payload seen for this issuance; a changed payload with the same
    /// `issuedAt` is revision 1, 2, ... (all kept).
    pub revision: i32,
    pub valid_from: Option<Time>,
    pub valid_to: Option<Time>,
    pub horizon_end: Option<Time>,
    pub peak_stage_ft: Option<f64>,
    pub peak_at: Option<Time>,
    pub peak_category: Option<FloodCategory>,
    pub points: Vec<ForecastPoint>,
}

impl From<forecast::Snapshot> for ForecastSnapshot {
    fn from(s: forecast::Snapshot) -> Self {
        let peak = s.peak().copied();
        ForecastSnapshot {
            id: ID(s.id.to_string()),
            site: ID(s.site),
            product: s.product,
            issued_at: Time(s.issued_at),
            ingested_at: Time(s.ingested_at),
            source: s.source.into(),
            payload_hash: s.payload_hash,
            revision: s.revision as i32,
            valid_from: s.valid_from.map(Time),
            valid_to: s.valid_to.map(Time),
            horizon_end: s.horizon_end.map(Time),
            peak_stage_ft: peak.and_then(|p| p.stage_ft),
            peak_at: peak.map(|p| Time(p.valid_at)),
            peak_category: peak.and_then(|p| p.category).map(Into::into),
            points: s.points.into_iter().map(Into::into).collect(),
        }
    }
}

/// What was known about a site's forecast at `asOf`.
#[derive(Debug, Clone, SimpleObject)]
pub struct ForecastView {
    pub site: ID,
    pub as_of: Time,
    /// The forecast in force at `asOf`: greatest issuance at or before `asOf` that had been
    /// captured by then (live) or was public by then (archive). Null when none was known.
    pub snapshot: Option<ForecastSnapshot>,
    /// Issuances known at `asOf`, newest first, at most `history`.
    pub history: Vec<ForecastSnapshot>,
    /// The first `asOf` with a forecast: when the earliest stored snapshot became knowable
    /// (archive rows at issuance, live rows when captured).
    pub replay_coverage_start: Option<Time>,
    /// First live capture by this process; before it every forecast is an archive copy.
    pub live_coverage_start: Option<Time>,
    pub snapshot_count: i32,
}

/// An observed NWPS value (stage on the NWPS datum, the one the flood categories use).
#[derive(Debug, Clone, SimpleObject)]
pub struct SiteObservation {
    pub observed_at: Time,
    pub ingested_at: Time,
    pub source: ForecastSource,
    pub stage_ft: Option<f64>,
    pub flow_kcfs: Option<f64>,
}

impl From<forecast::StoredObservation> for SiteObservation {
    fn from(o: forecast::StoredObservation) -> Self {
        SiteObservation { observed_at: Time(o.observed_at), ingested_at: Time(o.ingested_at), source: o.source.into(), stage_ft: o.stage_ft, flow_kcfs: o.flow_kcfs }
    }
}

/// A reason the site cannot be read at face value.
#[derive(Debug, Clone, SimpleObject)]
pub struct SiteConflict {
    /// `gauge_vs_forecast`, `stale_forecast`, `stale_observation` or `no_thresholds`.
    pub kind: String,
    pub detail: String,
    pub forecast_ft: Option<f64>,
    pub observed_ft: Option<f64>,
    /// observed - forecast, feet.
    pub difference_ft: Option<f64>,
}

impl From<forecast::query::Conflict> for SiteConflict {
    fn from(c: forecast::query::Conflict) -> Self {
        SiteConflict { kind: c.kind.to_string(), detail: c.detail, forecast_ft: c.forecast_ft, observed_ft: c.observed_ft, difference_ft: c.difference_ft }
    }
}

#[derive(Debug, Clone, SimpleObject)]
pub struct SiteStatus {
    pub site: ID,
    pub as_of: Time,
    /// Newest NWPS observation knowable at `asOf`.
    pub observation: Option<SiteObservation>,
    pub stage_ft: Option<f64>,
    /// Category of the observed stage against the NWPS thresholds known at `asOf`.
    pub category: Option<FloodCategory>,
    pub thresholds: Option<FloodThresholds>,
    pub observation_freshness: Freshness,
    pub forecast_freshness: Freshness,
    /// The forecast in force at `asOf` (see `ForecastView.snapshot`).
    pub forecast: Option<ForecastSnapshot>,
    /// The forecast point valid nearest `asOf` (within 30 min), the one the gauge is compared to.
    pub forecast_now: Option<ForecastPoint>,
    pub conflicts: Vec<SiteConflict>,
    /// NWS alert versions first seen at or before `asOf` and not ended by then.
    pub active_alerts: i32,
}

/// One forecast point against the observation nearest its valid time (within 30 min).
#[derive(Debug, Clone, SimpleObject)]
pub struct ForecastVerifyPoint {
    pub valid_at: Time,
    pub forecast_ft: Option<f64>,
    pub forecast_category: Option<FloodCategory>,
    pub observed_at: Option<Time>,
    pub observed_ft: Option<f64>,
    pub observed_category: Option<FloodCategory>,
    /// forecast - observed, feet. Null when either side is missing; never interpolated.
    pub error_ft: Option<f64>,
    pub missing: bool,
}

impl From<forecast::query::VerifiedPoint> for ForecastVerifyPoint {
    fn from(p: forecast::query::VerifiedPoint) -> Self {
        ForecastVerifyPoint {
            valid_at: Time(p.valid_at),
            forecast_ft: p.forecast_ft,
            forecast_category: p.forecast_category.map(Into::into),
            observed_at: p.observed_at.map(Time),
            observed_ft: p.observed_ft,
            observed_category: p.observed_category.map(Into::into),
            error_ft: p.error_ft,
            missing: p.missing(),
        }
    }
}

#[derive(Debug, Clone, SimpleObject)]
pub struct ForecastVerification {
    pub site: ID,
    pub issued_at: Time,
    pub snapshot: ForecastSnapshot,
    pub points: Vec<ForecastVerifyPoint>,
    pub paired: i32,
    pub missing: i32,
    /// Mean of forecast - observed over paired points; positive = forecast ran high.
    pub bias_ft: Option<f64>,
    pub mean_abs_error_ft: Option<f64>,
    pub max_abs_error_ft: Option<f64>,
    pub peak_forecast_ft: Option<f64>,
    pub peak_forecast_category: Option<FloodCategory>,
    /// Highest observed stage inside the forecast's valid window.
    pub peak_observed_ft: Option<f64>,
    pub peak_observed_category: Option<FloodCategory>,
    /// The observed peak reached the same category as the forecast peak. Null when either side is unknown.
    pub peak_category_hit: Option<bool>,
}

impl From<forecast::query::Verification> for ForecastVerification {
    fn from(v: forecast::query::Verification) -> Self {
        ForecastVerification {
            site: ID(v.snapshot.site.clone()),
            issued_at: Time(v.snapshot.issued_at),
            snapshot: v.snapshot.into(),
            points: v.points.into_iter().map(Into::into).collect(),
            paired: v.paired as i32,
            missing: v.missing as i32,
            bias_ft: v.bias_ft,
            mean_abs_error_ft: v.mean_abs_error_ft,
            max_abs_error_ft: v.max_abs_error_ft,
            peak_forecast_ft: v.peak_forecast_ft,
            peak_forecast_category: v.peak_forecast_category.map(Into::into),
            peak_observed_ft: v.peak_observed_ft,
            peak_observed_category: v.peak_observed_category.map(Into::into),
            peak_category_hit: v.peak_category_hit,
        }
    }
}
