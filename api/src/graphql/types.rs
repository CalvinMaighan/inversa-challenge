//! GraphQL types mirroring `api/schema.graphql` one to one (PLAN.md C2). Field names are the
//! Rust snake_case of the SDL camelCase names; async-graphql converts them.

use async_graphql::{
    Enum, InputObject, InputValueError, InputValueResult, Scalar, ScalarType, SimpleObject, Value, ID,
};
use chrono::{DateTime, SecondsFormat};

use crate::app::config::App;
use crate::feed_state;
use crate::forecast;
use crate::review;

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

#[derive(Debug, Clone, SimpleObject)]
pub struct HotspotCell {
    pub cell: ID,
    pub lat: f64,
    pub lon: f64,
    pub score: f64,
}

#[derive(Debug, Clone, SimpleObject)]
pub struct HotspotGrid {
    pub species: ID,
    pub at: Time,
    pub cells: Vec<HotspotCell>,
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
    pub terms: Vec<HotspotTerm>,
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

// ---------------------------------------------------------------------------------------------
// Needs review (C5): conditions apps only. Mirrors `crate::review`. No field scores abundance,
// catch, access or trip safety; the feeds cannot establish them.
// ---------------------------------------------------------------------------------------------

/// REVIEW: a review rule fired. OK: none fired and observation, forecast and thresholds are
/// current. CANNOT_ASSESS: inputs missing or stale, so OK would be a guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Enum)]
pub enum ReviewStatus {
    Review,
    Ok,
    CannotAssess,
}

impl From<review::Status> for ReviewStatus {
    fn from(s: review::Status) -> Self {
        match s {
            review::Status::Review => ReviewStatus::Review,
            review::Status::Ok => ReviewStatus::Ok,
            review::Status::CannotAssess => ReviewStatus::CannotAssess,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Enum)]
pub enum ReviewSeverity {
    High,
    Medium,
    Info,
}

impl From<review::Severity> for ReviewSeverity {
    fn from(s: review::Severity) -> Self {
        match s {
            review::Severity::High => ReviewSeverity::High,
            review::Severity::Medium => ReviewSeverity::Medium,
            review::Severity::Info => ReviewSeverity::Info,
        }
    }
}

/// FIRED: the rule applies. CLEAR: checked, does not apply. UNKNOWN: could not be checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Enum)]
pub enum ReviewOutcome {
    Fired,
    Clear,
    Unknown,
}

impl From<review::Outcome> for ReviewOutcome {
    fn from(o: review::Outcome) -> Self {
        match o {
            review::Outcome::Fired => ReviewOutcome::Fired,
            review::Outcome::Clear => ReviewOutcome::Clear,
            review::Outcome::Unknown => ReviewOutcome::Unknown,
        }
    }
}

#[derive(Debug, Clone, PartialEq, SimpleObject)]
pub struct ReviewReason {
    pub rule: String,
    pub outcome: ReviewOutcome,
    pub severity: ReviewSeverity,
    pub value: Option<f64>,
    pub value_text: Option<String>,
    pub threshold: Option<f64>,
    pub unit: Option<String>,
    pub source: String,
    pub observed_at: Option<Time>,
    pub issued_at: Option<Time>,
    pub link: Option<String>,
    pub evidence_ids: Vec<ID>,
    pub explanation: String,
}

impl From<review::Reason> for ReviewReason {
    fn from(r: review::Reason) -> Self {
        ReviewReason {
            rule: r.rule.id().into(),
            outcome: r.outcome.into(),
            severity: r.severity.into(),
            value: r.value,
            value_text: r.value_text,
            threshold: r.threshold,
            unit: r.unit.map(Into::into),
            source: r.source,
            observed_at: r.observed_at.map(Time),
            issued_at: r.issued_at.map(Time),
            link: r.link,
            evidence_ids: r.evidence_ids.into_iter().map(ID).collect(),
            explanation: r.explanation,
        }
    }
}

#[derive(Debug, Clone, PartialEq, SimpleObject)]
pub struct SiteReview {
    pub site: ID,
    pub location: ID,
    pub name: String,
    pub as_of: Time,
    pub status: ReviewStatus,
    pub summary: String,
    pub reasons: Vec<ReviewReason>,
    pub checks: Vec<ReviewReason>,
    pub stage_ft: Option<f64>,
    pub observed_at: Option<Time>,
    #[graphql(name = "change24hFt")]
    pub change_24h_ft: Option<f64>,
    pub category_now: Option<FloodCategory>,
    pub peak_stage_ft: Option<f64>,
    pub peak_at: Option<Time>,
    pub category_peak: Option<FloodCategory>,
    pub forecast_issued_at: Option<Time>,
    pub forecast_source: Option<ForecastSource>,
    pub observation_freshness: Freshness,
    pub forecast_freshness: Freshness,
    pub active_alerts: i32,
    pub usgs_stage_ft: Option<f64>,
    pub usgs_observed_at: Option<Time>,
    pub tidal: bool,
}

impl From<review::SiteReview> for SiteReview {
    fn from(r: review::SiteReview) -> Self {
        SiteReview {
            site: ID(r.site.lid),
            location: ID(r.site.location),
            name: r.site.name,
            as_of: Time(r.as_of),
            status: r.status.into(),
            summary: r.summary,
            reasons: r.reasons.into_iter().map(Into::into).collect(),
            checks: r.checks.into_iter().map(Into::into).collect(),
            stage_ft: r.stage_ft,
            observed_at: r.observed_at.map(Time),
            change_24h_ft: r.change_24h_ft,
            category_now: r.category_now.map(Into::into),
            peak_stage_ft: r.peak_stage_ft,
            peak_at: r.peak_at.map(Time),
            category_peak: r.category_peak.map(Into::into),
            forecast_issued_at: r.forecast_issued_at.map(Time),
            forecast_source: r.forecast_source.map(Into::into),
            observation_freshness: r.observation_freshness.into(),
            forecast_freshness: r.forecast_freshness.into(),
            active_alerts: r.active_alerts as i32,
            usgs_stage_ft: r.usgs_stage_ft,
            usgs_observed_at: r.usgs_observed_at.map(Time),
            tidal: r.tidal,
        }
    }
}

#[derive(Debug, Clone, PartialEq, SimpleObject)]
pub struct ReviewBoard {
    pub as_of: Time,
    pub review: i32,
    pub ok: i32,
    pub cannot_assess: i32,
    pub sites: Vec<SiteReview>,
}

impl From<review::Board> for ReviewBoard {
    fn from(b: review::Board) -> Self {
        ReviewBoard {
            as_of: Time(b.as_of),
            review: b.review as i32,
            ok: b.ok as i32,
            cannot_assess: b.cannot_assess as i32,
            sites: b.sites.into_iter().map(Into::into).collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, SimpleObject)]
pub struct ReviewTransition {
    pub at: Time,
    pub from: ReviewStatus,
    pub to: ReviewStatus,
    pub reasons: Vec<ReviewReason>,
    pub cleared: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, SimpleObject)]
pub struct ReviewHistory {
    pub site: ID,
    pub from: Time,
    pub to: Time,
    pub initial: SiteReview,
    pub transitions: Vec<ReviewTransition>,
    pub evaluations: i32,
}

impl From<review::History> for ReviewHistory {
    fn from(h: review::History) -> Self {
        ReviewHistory {
            site: ID(h.site.lid),
            from: Time(h.from),
            to: Time(h.to),
            initial: h.initial.into(),
            transitions: h
                .transitions
                .into_iter()
                .map(|t| ReviewTransition {
                    at: Time(t.at),
                    from: t.from.into(),
                    to: t.to.into(),
                    reasons: t.reasons.into_iter().map(Into::into).collect(),
                    cleared: t.cleared.into_iter().map(|r| r.id().to_string()).collect(),
                })
                .collect(),
            evaluations: h.evaluations as i32,
        }
    }
}
