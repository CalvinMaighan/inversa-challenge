//! GraphQL types mirroring `api/schema.graphql` one to one (PLAN.md C2). Field names are the
//! Rust snake_case of the SDL camelCase names; async-graphql converts them.

use async_graphql::{
    Enum, InputObject, InputValueError, InputValueResult, Scalar, ScalarType, SimpleObject, Value, ID,
};
use chrono::{DateTime, SecondsFormat};

use crate::app::config::App;
use crate::feed_state;

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
            // `sources.mode` is constrained to push|poll by the migration.
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
