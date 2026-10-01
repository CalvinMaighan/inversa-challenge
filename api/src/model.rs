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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
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
    /// Open-Meteo Marine mean wave period, s (L4).
    WavePeriodS,
    /// Open-Meteo Marine ocean current speed, m/s (converted from the provider's km/h).
    CurrentMs,
    /// Open-Meteo Marine ocean current direction, degrees, the direction the water flows towards.
    CurrentDirDeg,
    /// USGS discharge (parameter 00060), cubic feet per second, as the gauge reports it. Kept in
    /// cfs (not kcfs) so a number on screen matches the USGS page; NWPS flow is kcfs and lives in
    /// the forecast store, never mixed with this (docs/evidence/carp-data-proof.md, Monroe).
    DischargeCfs,
    /// NWS gridpoint probability of precipitation, percent, for the 12 h forecast period that
    /// starts at `observed_at` (modeled; a chance, never an amount).
    PopPct,
    /// NWS gridpoint wind gust, m/s (the raw grid's km/h converted), per hour (modeled).
    WindGustMs,
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
            Param::WavePeriodS => "wave_period_s",
            Param::CurrentMs => "current_ms",
            Param::CurrentDirDeg => "current_dir_deg",
            Param::DischargeCfs => "discharge_cfs",
            Param::PopPct => "pop_pct",
            Param::WindGustMs => "wind_gust_ms",
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

/// Taxon by name. The apps' species have fixed ids (1 python, 4 lionfish; migration seed); a
/// taxon an ID flip moves a stored sighting to is upserted by name. `inat_taxon_id` is known
/// to the iNat adapter only; other adapters leave it `None` and the row writer keeps whatever
/// the row already has.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TaxonRef {
    pub scientific_name: String,
    pub common_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inat_taxon_id: Option<i64>,
}

#[cfg(test)]
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
    /// When the animal was seen. Time windows count by this.
    pub observed_at: i64,
    /// When the record reached its source (iNat `created_at`); `None` when the source has no
    /// such time (GBIF, NAS). Can lag `observed_at` by years.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submitted_at: Option<i64>,
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

/// One modeled value from a forecast run, kept with the run's issuance time (`marine_forecasts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ForecastRow {
    pub station: StationRef,
    pub param: Param,
    pub value: Option<f64>,
    /// Unit of `value` as stored (`m`, `s`, `m/s`, `deg`).
    pub unit: String,
    /// Unit the provider sent (`km/h` for currents).
    pub source_unit: String,
    pub model: String,
    pub issued_at: i64,
    pub valid_at: i64,
}

/// NWPS observed stage/flow for one site (the datum the flood categories are defined on).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ForecastObservationsRow {
    /// NWPS lid (`locations[].nwps`).
    pub site: String,
    pub source: crate::forecast::Source,
    pub observations: Vec<crate::forecast::Observation>,
}

/// NWPS flood category thresholds for one site, as the gauge metadata reports them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThresholdsRow {
    pub site: String,
    pub thresholds: crate::forecast::Thresholds,
}

/// The NWS alerts one poll found in effect at one site. An empty list is a positive statement
/// ("no active alerts at `seen_at`"): known versions missing from it are ended.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SiteAlertsRow {
    pub site: String,
    pub seen_at: i64,
    pub alerts: Vec<crate::forecast::store::AlertSeen>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Row {
    Sighting(SightingRow),
    Reading(ReadingRow),
    Alert(AlertRow),
    Station(StationRef),
    Revision(RevisionRow),
    Forecast(ForecastRow),
    /// A river or weather forecast issuance (forecast store, conditions apps).
    ForecastSnapshot(crate::forecast::store::NewSnapshot),
    ForecastObservations(ForecastObservationsRow),
    Thresholds(ThresholdsRow),
    SiteAlerts(SiteAlertsRow),
}
