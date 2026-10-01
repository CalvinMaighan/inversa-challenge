//! Normalized rows produced by source adapters (PLAN.md C12). Field names follow the
//! migration tables. Times are unix milliseconds. Adapters produce rows; only the ingest
//! pipeline writes them.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Quality {
    Research,
    NeedsId,
    Casual,
    Curated,
}

impl Quality {
    pub fn as_str(self) -> &'static str {
        match self {
            Quality::Research => "research",
            Quality::NeedsId => "needs_id",
            Quality::Casual => "casual",
            Quality::Curated => "curated",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
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
    /// NOAA Coral Reef Watch CoralTemp SST, °C, daily 5 km (L3). Kept apart from `SstC` so the
    /// GOES SST frames, the hotspot conditions and the buoy/satellite conflict check never mix it in.
    Sst,
    /// CRW SST anomaly against the 1985-2012 climatology, °C.
    SstAnomaly,
    /// CRW degree heating weeks, °C-weeks: accumulated heat stress over 12 weeks.
    Dhw,
    /// CRW bleaching alert area, 0-4 (no stress, watch, warning, alert 1, alert 2): the current state.
    Baa,
}

impl Param {
    pub fn as_str(self) -> &'static str {
        match self {
            Param::LstC => "lst_c",
            Param::AirC => "air_c",
            Param::WaterC => "water_c",
            Param::SstC => "sst_c",
            Param::RainMm => "rain_mm",
            Param::StageM => "stage_m",
            Param::WaveM => "wave_m",
            Param::WindMs => "wind_ms",
            Param::FireFrp => "fire_frp",
            Param::Sst => "sst",
            Param::SstAnomaly => "sst_anomaly",
            Param::Dhw => "dhw",
            Param::Baa => "baa",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    Measured,
    Satellite,
    Modeled,
}

impl Origin {
    pub fn as_str(self) -> &'static str {
        match self {
            Origin::Measured => "measured",
            Origin::Satellite => "satellite",
            Origin::Modeled => "modeled",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Flag {
    Ok,
    Cloud,
    BadDqf,
    Missing,
}

impl Flag {
    pub fn as_str(self) -> &'static str {
        match self {
            Flag::Ok => "ok",
            Flag::Cloud => "cloud",
            Flag::BadDqf => "bad_dqf",
            Flag::Missing => "missing",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StationKind {
    Buoy,
    Gage,
    Tide,
    Grid,
    GoesCell,
}

impl StationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            StationKind::Buoy => "buoy",
            StationKind::Gage => "gage",
            StationKind::Tide => "tide",
            StationKind::Grid => "grid",
            StationKind::GoesCell => "goes_cell",
        }
    }
}

/// Taxon by name. Focus taxa have fixed ids 1-4 (migration seed); others are upserted by name.
/// `inat_taxon_id` and `iconic_group` (T44) are known to the iNat adapter only; other adapters
/// leave them `None` and the row writer keeps whatever the row already has.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TaxonRef {
    pub scientific_name: String,
    pub common_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inat_taxon_id: Option<i64>,
    /// iNat iconic taxon: Reptilia, Amphibia, Aves, Mammalia, Actinopterygii, Mollusca, Insecta,
    /// Arachnida, Plantae, Fungi or other.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iconic_group: Option<String>,
    /// iNat `ancestor_ids`, root first; the web app derives the category (snakes, lizards, ...) from it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ancestor_ids: Option<Vec<i64>>,
}

impl TaxonRef {
    pub fn named(scientific_name: impl Into<String>, common_name: impl Into<String>) -> TaxonRef {
        TaxonRef { scientific_name: scientific_name.into(), common_name: common_name.into(), ..TaxonRef::default() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StationRef {
    pub ext_id: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    pub kind: StationKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SightingRow {
    pub ext_id: String,
    pub taxon: TaxonRef,
    pub lat: f64,
    pub lon: f64,
    pub accuracy_m: Option<f64>,
    pub observed_at: i64,
    pub quality: Quality,
    pub photo_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReadingRow {
    pub station: StationRef,
    pub param: Param,
    pub value: Option<f64>,
    pub flag: Flag,
    pub observed_at: i64,
    pub origin: Origin,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AlertRow {
    pub ext_id: String,
    pub event: String,
    pub severity: String,
    pub headline: Option<String>,
    pub area_geojson: Option<serde_json::Value>,
    pub onset: Option<i64>,
    pub expires: Option<i64>,
}

/// A field change on an existing sighting (e.g. an iNat community ID flip).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RevisionRow {
    pub sighting_ext_id: String,
    pub field: String,
    pub old: Option<String>,
    pub new: Option<String>,
    pub changed_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Row {
    Sighting(SightingRow),
    Reading(ReadingRow),
    Alert(AlertRow),
    Station(StationRef),
    Revision(RevisionRow),
}
