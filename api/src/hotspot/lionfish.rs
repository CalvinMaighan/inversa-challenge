//! Lionfish survey priority (L5; PLAN.md P3, `docs/LIONFISH_WATCH.md`, `gates/leaf-L5.md`).
//!
//! An app whose `score.components` are `recentReports`, `idQuality`, `heatStress` and
//! `completeness` ([`enabled`]) is scored here instead of `score.rs`'s density × rules product.
//! Every scoring cell gets the four components separately, each in [0, 1] with its own state
//! (`ok`, `unknown`, `stale`) and inputs. `unknown` is a null value, never 0. A configurable
//! weighted mean of the first three (`rankScore`) orders cells and is never a probability, a risk
//! or a percent; `completeness` never enters it (low completeness lowers confidence, not
//! priority). Field conditions (`FieldWindow`, from `marine_forecasts`) are returned next to the
//! cell and never enter the rank either.
//!
//! - `recentReports`: Gaussian kernel density (σ 2 cells, 3σ) of independent reports
//!   (`quality_bio::INDEPENDENT_SQL`: no duplicates, no GBIF copies of iNat) by observed date,
//!   half-life from the taxon config (60 d). Research grade weighs 1, other grades 0.5; NAS and
//!   institutional GBIF history is a static 0.2 prior. Normalised to the region's maximum, so the
//!   value compares cells of one region, not regions. `unknown` when the region has no report
//!   known at `at` at all (no reports can mean no sampling).
//! - `idQuality`: kernel-weighted share of the decaying reports around the cell that are research
//!   grade with a positional accuracy under the cell size. `unknown` without reports.
//! - `heatStress`: NOAA CRW at the cell (nearest CRW pixel within [`CRW_MAX_CELLS`]): DHW mapped
//!   `dhw / 8` and BAA `baa / 4`, each clamped, combined by max; both raw values are returned since
//!   they disagree (Looe Key: DHW 13.65, BAA 1). `unknown` when no product is known at `at`
//!   (product day at or before `at` and ingested by `at`); `stale` when the newest is older than
//!   [`CRW_STALE_MS`] (then the value is null too).
//! - `completeness`: mean of report freshness, CRW state at the cell, NAS coverage of the region
//!   and buoy coverage of the region, halved in a thin region.
//!
//! As-of: a frame at `t` sees reports with `observed_at < t` and `known_at <= t`, where `known_at`
//! is `submitted_at` (iNat `created_at`), or `ingested_at` for sources without one (GBIF, NAS;
//! their backfilled rows become knowable at the backfill). `DateBasis::Observed` relaxes this to
//! the observed date. CRW rows need product day and ingest time at or before `t`; forecasts are
//! gated by issuance (public at issuance, like the forecast store's archive rows).

use std::sync::{Arc, OnceLock};

use rayon::prelude::*;

use super::backtest::{floor_day, top_threshold, Backtest, BacktestDay, BASELINE};
use super::score::{nearest_index, quality_code, BBox, Kernel, DAY_MS, DECAY_WINDOW_HALF_LIVES, KERNEL_RADIUS, PRIOR_WEIGHT};
use super::Grid;
use crate::app::config::{App, Region, Taxon};
use crate::db::Db;
use crate::ingest::quality_bio::{DateBasis, INDEPENDENT_SQL};

pub const COMPONENT_IDS: [&str; 4] = ["recentReports", "idQuality", "heatStress", "completeness"];
pub const RESEARCH_WEIGHT: f32 = 1.0;
pub const OTHER_WEIGHT: f32 = 0.5;
/// DHW at which the mapped heat stress reaches 1 (CRW Bleaching Alert Level 2 starts at 8 °C-weeks).
pub const DHW_SEVERE: f32 = 8.0;
pub const BAA_MAX: f32 = 4.0;
/// A CRW product older than this at `at` is `stale` (the feed's `max_latency`).
pub const CRW_STALE_MS: i64 = 72 * 3_600_000;
/// Products older than this are not even stale, just unknown.
pub const CRW_LOOKBACK_MS: i64 = 30 * DAY_MS;
/// A CRW pixel is 5 scoring cells wide; a cell reads its own pixel or a neighbour.
pub const CRW_MAX_CELLS: u32 = 5;
/// Open-Meteo Marine points sit 0.5° (50 cells) apart.
pub const MARINE_MAX_CELLS: u32 = 60;
pub const FIELD_HORIZON_MS: i64 = 72 * 3_600_000;
pub const FIELD_STALE_MS: i64 = 36 * 3_600_000;
pub const FIELD_MAX_WAVE_M: f32 = super::rules::LIONFISH_MAX_WAVE_M;
/// Fewer independent, non-history reports than this in the last [`THIN_WINDOW_MS`] marks a region thin.
pub const THIN_MIN_REPORTS: u32 = 3;
pub const THIN_WINDOW_MS: i64 = 90 * DAY_MS;
/// Report freshness half-life inside `completeness`.
pub const FRESH_HALF_LIFE_MS: i64 = 30 * DAY_MS;
pub const BACKTEST_HORIZON_DAYS: u32 = 7;
pub const PRIOR_SOURCES: [&str; 2] = ["nas", "gbif"];

pub const CAVEATS: [&str; 4] = [
    "Sightings are not abundance: more reports can mean more observers; no reports can mean no sampling.",
    "Heat stress is context for where reefs are under pressure, not proof of lionfish damage.",
    "No causal claim: the components are shown separately and rankScore only orders cells; it is not a probability, risk or percent.",
    "Field conditions (waves, currents) are planning context and never enter the rank.",
];

/// Lionfish-style component scoring applies to this app.
pub fn enabled(app: &App) -> bool {
    app.is_species() && COMPONENT_IDS.iter().all(|id| app.cfg.score.components.iter().any(|c| c.id == *id))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Ok,
    Unknown,
    Stale,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Ok => "ok",
            State::Unknown => "unknown",
            State::Stale => "stale",
        }
    }
}

/// Rank weights (`score.components[].weight`); `completeness` has none.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Weights {
    pub recent_reports: f32,
    pub id_quality: f32,
    pub heat_stress: f32,
}

impl Weights {
    pub fn from_app(app: &App) -> Weights {
        let w = |id: &str| app.cfg.score.components.iter().find(|c| c.id == id).map(|c| c.weight as f32).unwrap_or(1.0);
        Weights { recent_reports: w("recentReports"), id_quality: w("idQuality"), heat_stress: w("heatStress") }
    }

    /// Per-query overrides; each must be finite and non-negative, and the three must not all be 0.
    pub fn with(self, recent: Option<f64>, id: Option<f64>, heat: Option<f64>) -> anyhow::Result<Weights> {
        let pick = |name: &str, v: Option<f64>, d: f32| -> anyhow::Result<f32> {
            match v {
                None => Ok(d),
                Some(v) if v.is_finite() && v >= 0.0 => Ok(v as f32),
                Some(v) => anyhow::bail!("weight {name} must be a finite number >= 0, got {v}"),
            }
        };
        let w = Weights {
            recent_reports: pick("recentReports", recent, self.recent_reports)?,
            id_quality: pick("idQuality", id, self.id_quality)?,
            heat_stress: pick("heatStress", heat, self.heat_stress)?,
        };
        anyhow::ensure!(w.total() > 0.0, "weights must not all be 0");
        Ok(w)
    }

    pub fn total(&self) -> f32 {
        self.recent_reports + self.id_quality + self.heat_stress
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Report {
    pub id: i64,
    pub source: String,
    pub ext_id: String,
    pub lat: f64,
    pub lon: f64,
    pub col: u32,
    pub row: u32,
    pub accuracy_m: Option<f64>,
    pub observed_at: i64,
    pub submitted_at: Option<i64>,
    pub ingested_at: i64,
    /// PLAN.md C4 quality code (0 research).
    pub quality: u8,
    /// NAS or GBIF history: static prior.
    pub prior: bool,
    /// `quality_bio::INDEPENDENT_SQL`: counted at all.
    pub independent: bool,
    pub canonical_id: Option<i64>,
    pub photo_url: Option<String>,
}

impl Report {
    pub fn known_at(&self, basis: DateBasis) -> i64 {
        match basis {
            DateBasis::Observed => self.observed_at,
            DateBasis::Submitted => self.submitted_at.unwrap_or(self.ingested_at),
        }
    }

    pub fn visible(&self, at: i64, basis: DateBasis) -> bool {
        self.observed_at < at && self.known_at(basis) <= at
    }

    fn research_precise(&self, cell_m: f64) -> bool {
        self.quality == 0 && self.accuracy_m.is_some_and(|a| a < cell_m)
    }

    fn weight(&self, at: i64, half_life_ms: f64) -> f32 {
        if self.prior {
            return PRIOR_WEIGHT;
        }
        let base = if self.quality == 0 { RESEARCH_WEIGHT } else { OTHER_WEIGHT };
        base * 0.5f64.powf((at - self.observed_at) as f64 / half_life_ms) as f32
    }
}

const P_SST: u8 = 0;
const P_ANOM: u8 = 1;
const P_DHW: u8 = 2;
const P_BAA: u8 = 3;

fn crw_param(s: &str) -> Option<u8> {
    match s {
        "sst" => Some(P_SST),
        "sst_anomaly" => Some(P_ANOM),
        "dhw" => Some(P_DHW),
        "baa" => Some(P_BAA),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CrwReading {
    /// Index into `Index::crw_stations`.
    pub station: u32,
    pub param: u8,
    pub observed_at: i64,
    pub ingested_at: i64,
    /// NaN when flagged missing.
    pub value: f64,
}

/// CRW values at a cell's pixel for a frame time.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Heat {
    pub station: i64,
    pub sst: Option<f64>,
    pub anomaly: Option<f64>,
    pub dhw: Option<f64>,
    pub baa: Option<f64>,
    /// Product day (12:00Z) of the newest value used.
    pub observed_at: i64,
    pub ingested_at: i64,
}

impl Heat {
    /// Mapped stress and state at `at`: DHW / 8 and BAA / 4 (clamped), max of the two.
    pub fn stress(&self, at: i64) -> (Option<f32>, State) {
        let dhw = self.dhw.map(|d| (d as f32 / DHW_SEVERE).clamp(0.0, 1.0));
        let baa = self.baa.map(|b| (b as f32 / BAA_MAX).clamp(0.0, 1.0));
        let value = match (dhw, baa) {
            (Some(d), Some(b)) => Some(d.max(b)),
            (d, b) => d.or(b),
        };
        if value.is_none() {
            (None, State::Unknown)
        } else if at - self.observed_at > CRW_STALE_MS {
            (None, State::Stale)
        } else {
            (value, State::Ok)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Forecast {
    /// Index into `Index::marine_stations`.
    pub station: u32,
    pub wave: bool,
    pub issued_at: i64,
    pub valid_at: i64,
    pub value: f32,
}

/// Field conditions over the next [`FIELD_HORIZON_MS`] from the nearest marine forecast point.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FieldWindow {
    pub station: i64,
    pub state: State,
    pub issued_at: Option<i64>,
    pub wave_max_m: Option<f32>,
    pub wave_min_m: Option<f32>,
    /// Forecast hours with waves under [`FIELD_MAX_WAVE_M`].
    pub calm_hours: Option<u32>,
    pub horizon_hours: u32,
    pub current_max_ms: Option<f32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EvidenceItem {
    /// C14 id (`sighting:<id>`, `reading:<station>:<param>:<ms>:satellite`) or `station:<id>`.
    pub id: String,
    pub kind: &'static str,
    pub observed_at: Option<i64>,
    pub submitted_at: Option<i64>,
    pub ingested_at: Option<i64>,
    pub weight: Option<f32>,
    pub detail: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Component {
    pub id: &'static str,
    pub value: Option<f32>,
    pub state: State,
    pub weight: f32,
    pub rationale: String,
    pub inputs: Vec<String>,
    /// Filled by `explain` only.
    pub evidence: Vec<EvidenceItem>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Components {
    pub recent_reports: Component,
    pub id_quality: Component,
    pub heat_stress: Component,
    pub completeness: Component,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CellScore {
    pub idx: usize,
    /// `App::cell_id` (with region).
    pub cell: String,
    pub region: String,
    pub lat: f64,
    pub lon: f64,
    pub rank_score: f32,
    pub thin: bool,
    pub components: Components,
    pub heat: Option<Heat>,
    pub field_window: Option<FieldWindow>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CellExplain {
    pub cell: CellScore,
    pub weights: Weights,
    pub basis: DateBasis,
    pub caveats: Vec<&'static str>,
    pub credit: &'static str,
}

/// Everything one region needs to score any time in `[from, to)` without the database.
pub struct Index {
    pub region: String,
    pub thin_cfg: bool,
    pub grid: Grid,
    pub half_life_ms: f64,
    /// Cell size in metres (at the equator; the accuracy bound).
    pub cell_m: f64,
    pub weights: Weights,
    /// Every report of the taxon inside the grid, sorted by `(observed_at, id)`.
    pub reports: Vec<Report>,
    /// `(stations.id, lat, lon)`.
    pub crw_stations: Vec<(i64, f64, f64)>,
    crw: Vec<CrwReading>,
    pub marine_stations: Vec<(i64, f64, f64)>,
    marine: Vec<Forecast>,
    /// NDBC stations inside the region.
    pub buoys: u32,
    kernel: Kernel,
    crw_nearest: OnceLock<Arc<Vec<u32>>>,
    marine_nearest: OnceLock<Arc<Vec<u32>>>,
}

impl Index {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        region: &Region,
        taxon: &Taxon,
        weights: Weights,
        mut reports: Vec<Report>,
        crw_stations: Vec<(i64, f64, f64)>,
        mut crw: Vec<CrwReading>,
        marine_stations: Vec<(i64, f64, f64)>,
        mut marine: Vec<Forecast>,
        buoys: u32,
    ) -> Index {
        let grid = region.grid;
        reports.retain(|r| r.col < grid.cols && r.row < grid.rows);
        reports.sort_by_key(|r| (r.observed_at, r.id));
        crw.retain(|r| (r.station as usize) < crw_stations.len());
        crw.sort_by_key(|r| r.observed_at);
        marine.retain(|f| (f.station as usize) < marine_stations.len());
        marine.sort_by_key(|f| (f.valid_at, f.issued_at));
        Index {
            region: region.id().to_string(),
            thin_cfg: region.cfg.thin,
            grid,
            half_life_ms: taxon.half_life_days() * DAY_MS as f64,
            cell_m: grid.cell_deg * 111_320.0,
            weights,
            reports,
            crw_stations,
            crw,
            marine_stations,
            marine,
            buoys,
            kernel: Kernel::new(),
            crw_nearest: OnceLock::new(),
            marine_nearest: OnceLock::new(),
        }
    }

    /// Load one region's index for frame times in `[from, to)`.
    pub async fn load(db: &Db, app: &App, region: &Region, taxon: &Taxon, from: i64, to: i64) -> anyhow::Result<Index> {
        let grid = region.grid;
        let (west, south, east, north) = (grid.west, grid.south, grid.east(), grid.north());
        let decay_floor = from - (DECAY_WINDOW_HALF_LIVES * taxon.half_life_days() * DAY_MS as f64) as i64;
        let taxon_id = taxon.taxon_id;
        let rows = db
            .read(move |c| {
                let mut st = c.prepare_cached(&format!(
                    "select s.id, s.source_id, s.ext_id, s.lat, s.lon, s.accuracy_m, s.observed_at, s.submitted_at, s.ingested_at,
                            s.quality, s.canonical_id, s.photo_url, {INDEPENDENT_SQL}
                     from sightings s
                     where s.taxon_id = ?1 and s.observed_at < ?2 and (s.observed_at >= ?3 or s.source_id in ('nas', 'gbif'))
                       and s.lat >= ?4 and s.lat < ?5 and s.lon >= ?6 and s.lon < ?7
                     order by s.observed_at, s.id"
                ))?;
                let rows = st
                    .query_map(rusqlite::params![taxon_id, to, decay_floor, south, north, west, east], |r| {
                        Ok((
                            r.get::<_, i64>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, f64>(3)?,
                            r.get::<_, f64>(4)?,
                            r.get::<_, Option<f64>>(5)?,
                            r.get::<_, i64>(6)?,
                            r.get::<_, Option<i64>>(7)?,
                            r.get::<_, i64>(8)?,
                            r.get::<_, String>(9)?,
                            r.get::<_, Option<i64>>(10)?,
                            r.get::<_, Option<String>>(11)?,
                            r.get::<_, bool>(12)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await?;
        let reports: Vec<Report> = rows
            .into_iter()
            .filter_map(|(id, source, ext_id, lat, lon, accuracy_m, observed_at, submitted_at, ingested_at, quality, canonical_id, photo_url, independent)| {
                let (col, row) = grid.col_row(lon, lat)?;
                Some(Report {
                    id,
                    prior: PRIOR_SOURCES.contains(&source.as_str()),
                    source,
                    ext_id,
                    lat,
                    lon,
                    col,
                    row,
                    accuracy_m,
                    observed_at,
                    submitted_at,
                    ingested_at,
                    quality: quality_code(&quality),
                    independent,
                    canonical_id,
                    photo_url,
                })
            })
            .collect();

        // Ingest time is the raw object's fetch time (every scheduler row has one); a row without
        // one (hand-inserted) counts from its product time.
        let crw_from = from - CRW_LOOKBACK_MS;
        let crw_rows = db
            .read(move |c| {
                let mut st = c.prepare_cached(
                    "select r.station_id, s.lat, s.lon, r.param, r.value, r.flag, r.observed_at, coalesce(o.fetched_at, r.observed_at)
                     from readings r join stations s on s.id = r.station_id left join raw_objects o on o.id = r.raw_object_id
                     where s.source_id = 'crw' and r.param in ('sst', 'sst_anomaly', 'dhw', 'baa')
                       and r.observed_at >= ?1 and r.observed_at < ?2
                       and s.lat >= ?3 and s.lat < ?4 and s.lon >= ?5 and s.lon < ?6
                     order by r.observed_at",
                )?;
                let rows = st
                    .query_map(rusqlite::params![crw_from, to, south, north, west, east], |r| {
                        Ok((
                            r.get::<_, i64>(0)?,
                            r.get::<_, f64>(1)?,
                            r.get::<_, f64>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, Option<f64>>(4)?,
                            r.get::<_, String>(5)?,
                            r.get::<_, i64>(6)?,
                            r.get::<_, i64>(7)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await?;
        let mut crw_stations: Vec<(i64, f64, f64)> = Vec::new();
        let mut crw = Vec::with_capacity(crw_rows.len());
        for (station_id, lat, lon, param, value, flag, observed_at, ingested_at) in crw_rows {
            let Some(param) = crw_param(&param) else { continue };
            let station = match crw_stations.iter().position(|s| s.0 == station_id) {
                Some(i) => i as u32,
                None => {
                    crw_stations.push((station_id, lat, lon));
                    (crw_stations.len() - 1) as u32
                }
            };
            let value = match (value, flag.as_str()) {
                (Some(v), "ok") => v,
                _ => f64::NAN,
            };
            crw.push(CrwReading { station, param, observed_at, ingested_at, value });
        }

        let marine_rows = db
            .read(move |c| {
                let mut st = c.prepare_cached(
                    "select f.station_id, s.lat, s.lon, f.param, f.issued_at, f.valid_at, f.value
                     from marine_forecasts f join stations s on s.id = f.station_id
                     where s.source_id = 'openmeteo-marine' and f.param in ('wave_m', 'current_ms')
                       and f.issued_at < ?1 and f.valid_at >= ?2
                       and s.lat >= ?3 and s.lat < ?4 and s.lon >= ?5 and s.lon < ?6",
                )?;
                let rows = st
                    .query_map(rusqlite::params![to, from, south, north, west, east], |r| {
                        Ok((
                            r.get::<_, i64>(0)?,
                            r.get::<_, f64>(1)?,
                            r.get::<_, f64>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, i64>(4)?,
                            r.get::<_, i64>(5)?,
                            r.get::<_, Option<f64>>(6)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let buoys: i64 = c.query_row(
                    "select count(*) from stations where source_id = 'ndbc' and lat >= ?1 and lat < ?2 and lon >= ?3 and lon < ?4",
                    rusqlite::params![south, north, west, east],
                    |r| r.get(0),
                )?;
                Ok((rows, buoys))
            })
            .await?;
        let (marine_rows, buoys) = marine_rows;
        let mut marine_stations: Vec<(i64, f64, f64)> = Vec::new();
        let mut marine = Vec::with_capacity(marine_rows.len());
        for (station_id, lat, lon, param, issued_at, valid_at, value) in marine_rows {
            let station = match marine_stations.iter().position(|s| s.0 == station_id) {
                Some(i) => i as u32,
                None => {
                    marine_stations.push((station_id, lat, lon));
                    (marine_stations.len() - 1) as u32
                }
            };
            marine.push(Forecast { station, wave: param == "wave_m", issued_at, valid_at, value: value.map(|v| v as f32).unwrap_or(f32::NAN) });
        }
        Ok(Index::new(region, taxon, Weights::from_app(app), reports, crw_stations, crw, marine_stations, marine, buoys as u32))
    }

    fn crw_nearest(&self) -> Arc<Vec<u32>> {
        self.crw_nearest
            .get_or_init(|| {
                let pts: Vec<(f64, f64)> = self.crw_stations.iter().map(|s| (s.1, s.2)).collect();
                Arc::new(nearest_index(&self.grid, &pts, CRW_MAX_CELLS))
            })
            .clone()
    }

    fn marine_nearest(&self) -> Arc<Vec<u32>> {
        self.marine_nearest
            .get_or_init(|| {
                let pts: Vec<(f64, f64)> = self.marine_stations.iter().map(|s| (s.1, s.2)).collect();
                Arc::new(nearest_index(&self.grid, &pts, MARINE_MAX_CELLS))
            })
            .clone()
    }

    /// CRW values per station as known at `at`.
    fn heat_at(&self, at: i64) -> Vec<Option<Heat>> {
        let mut out: Vec<Option<Heat>> = vec![None; self.crw_stations.len()];
        let mut newest: Vec<[Option<(i64, i64, f64)>; 4]> = vec![[None; 4]; self.crw_stations.len()];
        let lo = self.crw.partition_point(|r| r.observed_at < at - CRW_LOOKBACK_MS);
        let hi = self.crw.partition_point(|r| r.observed_at <= at);
        for r in &self.crw[lo..hi] {
            if r.ingested_at > at {
                continue;
            }
            let slot = &mut newest[r.station as usize][r.param as usize];
            if slot.is_none_or(|(t, _, _)| r.observed_at >= t) {
                *slot = Some((r.observed_at, r.ingested_at, r.value));
            }
        }
        for (i, params) in newest.iter().enumerate() {
            let known: Vec<&(i64, i64, f64)> = params.iter().flatten().collect();
            if known.is_empty() {
                continue;
            }
            let observed_at = known.iter().map(|k| k.0).max().unwrap_or(at);
            let ingested_at = known.iter().map(|k| k.1).max().unwrap_or(at);
            let v = |p: u8| params[p as usize].and_then(|(_, _, v)| (!v.is_nan()).then_some(v));
            out[i] = Some(Heat {
                station: self.crw_stations[i].0,
                sst: v(P_SST),
                anomaly: v(P_ANOM),
                dhw: v(P_DHW),
                baa: v(P_BAA),
                observed_at,
                ingested_at,
            });
        }
        out
    }

    /// Field window per marine station from the newest run issued at or before `at`.
    fn field_at(&self, at: i64) -> Vec<Option<FieldWindow>> {
        let n = self.marine_stations.len();
        let mut run: Vec<[Option<i64>; 2]> = vec![[None; 2]; n];
        let lo = self.marine.partition_point(|f| f.valid_at < at);
        let hi = self.marine.partition_point(|f| f.valid_at < at + FIELD_HORIZON_MS);
        let window = &self.marine[lo..hi];
        for f in window {
            if f.issued_at <= at {
                let slot = &mut run[f.station as usize][f.wave as usize];
                *slot = Some(slot.map_or(f.issued_at, |r| r.max(f.issued_at)));
            }
        }
        let mut wave: Vec<(f32, f32, u32, u32)> = vec![(f32::NEG_INFINITY, f32::INFINITY, 0, 0); n];
        let mut current: Vec<Option<f32>> = vec![None; n];
        for f in window {
            let s = f.station as usize;
            if run[s][f.wave as usize] != Some(f.issued_at) || f.value.is_nan() {
                continue;
            }
            if f.wave {
                let w = &mut wave[s];
                w.0 = w.0.max(f.value);
                w.1 = w.1.min(f.value);
                w.3 += 1;
                if f.value < FIELD_MAX_WAVE_M {
                    w.2 += 1;
                }
            } else {
                current[s] = Some(current[s].map_or(f.value, |c| c.max(f.value)));
            }
        }
        (0..n)
            .map(|s| {
                let issued = run[s][1].or(run[s][0])?;
                let (max, min, calm, hours) = wave[s];
                let state = if at - issued > FIELD_STALE_MS {
                    State::Stale
                } else if hours == 0 {
                    State::Unknown
                } else {
                    State::Ok
                };
                Some(FieldWindow {
                    station: self.marine_stations[s].0,
                    state,
                    issued_at: Some(issued),
                    wave_max_m: (hours > 0).then_some(max),
                    wave_min_m: (hours > 0).then_some(min),
                    calm_hours: (hours > 0).then_some(calm),
                    horizon_hours: (FIELD_HORIZON_MS / 3_600_000) as u32,
                    current_max_ms: current[s],
                })
            })
            .collect()
    }

    pub fn frame(&self, at: i64, basis: DateBasis, weights: Weights) -> Frame<'_> {
        Frame::new(self, at, basis, weights)
    }
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map(|t| t.format("%Y-%m-%d").to_string()).unwrap_or_else(|| ms.to_string())
}

/// One region at one frame time.
pub struct Frame<'a> {
    pub index: &'a Index,
    pub at: i64,
    pub basis: DateBasis,
    pub weights: Weights,
    /// Kernel density, un-normalised, and its maximum.
    recent: Vec<f32>,
    recent_max: f32,
    /// Kernel-weighted research-and-precise mass and total decaying mass (no priors).
    good: Vec<f32>,
    all: Vec<f32>,
    heat: Vec<Option<Heat>>,
    field: Vec<Option<FieldWindow>>,
    pub thin: bool,
    /// Independent non-history reports visible at `at` observed in the last 90 d.
    pub recent_reports: u32,
    newest_report: Option<i64>,
    nas_newest: Option<i64>,
    nas_total: u32,
    any_report: bool,
}

impl<'a> Frame<'a> {
    pub fn new(index: &'a Index, at: i64, basis: DateBasis, weights: Weights) -> Frame<'a> {
        let cells = index.grid.cells();
        let (mut recent, mut good, mut all) = (vec![0f32; cells], vec![0f32; cells], vec![0f32; cells]);
        let window = (DECAY_WINDOW_HALF_LIVES * index.half_life_ms) as i64;
        let (mut recent_reports, mut newest_report, mut nas_newest, mut nas_total, mut any_report) = (0u32, None, None, 0u32, false);
        for r in &index.reports {
            if !r.independent || !r.visible(at, basis) {
                continue;
            }
            any_report = true;
            if r.source == "nas" {
                nas_total += 1;
                nas_newest = nas_newest.max(Some(r.observed_at));
            }
            if r.prior {
                index.kernel.splat(&index.grid, &mut recent, r.col, r.row, PRIOR_WEIGHT);
                continue;
            }
            newest_report = newest_report.max(Some(r.observed_at));
            if r.observed_at >= at - THIN_WINDOW_MS {
                recent_reports += 1;
            }
            if r.observed_at < at - window {
                continue;
            }
            let w = r.weight(at, index.half_life_ms);
            index.kernel.splat(&index.grid, &mut recent, r.col, r.row, w);
            index.kernel.splat(&index.grid, &mut all, r.col, r.row, w);
            if r.research_precise(index.cell_m) {
                index.kernel.splat(&index.grid, &mut good, r.col, r.row, w);
            }
        }
        let recent_max = recent.iter().copied().fold(0f32, f32::max);
        Frame {
            index,
            at,
            basis,
            weights,
            recent,
            recent_max,
            good,
            all,
            heat: index.heat_at(at),
            field: index.field_at(at),
            thin: index.thin_cfg || recent_reports < THIN_MIN_REPORTS,
            recent_reports,
            newest_report,
            nas_newest,
            nas_total,
            any_report,
        }
    }

    pub fn heat_at(&self, idx: usize) -> Option<&Heat> {
        let n = self.index.crw_nearest()[idx];
        (n != u32::MAX).then(|| self.heat[n as usize].as_ref()).flatten()
    }

    pub fn field_at(&self, idx: usize) -> Option<&FieldWindow> {
        let n = self.index.marine_nearest()[idx];
        (n != u32::MAX).then(|| self.field[n as usize].as_ref()).flatten()
    }

    fn recent_value(&self, idx: usize) -> f32 {
        if self.recent_max > 0.0 {
            self.recent[idx] / self.recent_max
        } else {
            0.0
        }
    }

    fn id_quality_value(&self, idx: usize) -> Option<f32> {
        (self.all[idx] > 0.0).then(|| (self.good[idx] / self.all[idx]).clamp(0.0, 1.0))
    }

    fn heat_value(&self, idx: usize) -> (Option<f32>, State) {
        self.heat_at(idx).map_or((None, State::Unknown), |h| h.stress(self.at))
    }

    fn rank_of(&self, recent: f32, idq: Option<f32>, heat: Option<f32>) -> f32 {
        let w = self.weights;
        (w.recent_reports * recent + w.id_quality * idq.unwrap_or(0.0) + w.heat_stress * heat.unwrap_or(0.0)) / w.total()
    }

    /// `rankScore` for every cell.
    pub fn rank(&self) -> Vec<f32> {
        let cols = self.index.grid.cols as usize;
        let nearest = self.index.crw_nearest();
        let mut out = vec![0f32; self.index.grid.cells()];
        out.par_chunks_mut(cols).enumerate().for_each(|(row, chunk)| {
            for (col, v) in chunk.iter_mut().enumerate() {
                let idx = row * cols + col;
                let n = nearest[idx];
                let heat = if n == u32::MAX { None } else { self.heat[n as usize].and_then(|h| h.stress(self.at).0) };
                *v = self.rank_of(self.recent_value(idx), self.id_quality_value(idx), heat);
            }
        });
        out
    }

    /// Reports within the kernel disc of a cell that are visible at `at`, with their weight
    /// (`None` for ones not counted: duplicates, outside the decay window).
    fn reports_near(&self, idx: usize) -> Vec<(&'a Report, Option<f32>)> {
        let (c, r) = self.index.grid.col_row_of(idx);
        let window = (DECAY_WINDOW_HALF_LIVES * self.index.half_life_ms) as i64;
        let r2 = (KERNEL_RADIUS * KERNEL_RADIUS) as i64;
        self.index
            .reports
            .iter()
            .filter(|s| s.visible(self.at, self.basis))
            .filter(|s| {
                let (dx, dy) = (s.col as i64 - c as i64, s.row as i64 - r as i64);
                dx * dx + dy * dy <= r2
            })
            .map(|s| {
                let counted = s.independent && (s.prior || s.observed_at >= self.at - window);
                (s, counted.then(|| s.weight(self.at, self.index.half_life_ms)))
            })
            .collect()
    }

    fn report_evidence(&self, s: &Report, weight: Option<f32>, cell_m: f64) -> EvidenceItem {
        let detail = match (s.independent, weight) {
            (false, _) => match s.canonical_id {
                Some(c) => format!("{} record: duplicate of sighting:{c}, not counted", s.source),
                None => format!("{} copy of an iNaturalist record (not stored yet), not counted", s.source),
            },
            (true, None) => format!("{} record older than the decay window, not counted", s.source),
            (true, Some(w)) if s.prior => format!("{} history record, static prior weight {w:.2}", s.source),
            (true, Some(w)) => format!(
                "{} {} grade, accuracy {}, observed {} (submitted {}), weight {w:.3}{}",
                s.source,
                ["research", "needs_id", "casual", "curated"][s.quality.min(3) as usize],
                s.accuracy_m.map_or("unknown".to_string(), |a| format!("{a:.0} m")),
                iso(s.observed_at),
                s.submitted_at.map_or("unknown".to_string(), iso),
                if s.research_precise(cell_m) { "; counts as precise research grade" } else { "" }
            ),
        };
        EvidenceItem {
            id: format!("sighting:{}", s.id),
            kind: "sighting",
            observed_at: Some(s.observed_at),
            submitted_at: s.submitted_at,
            ingested_at: Some(s.ingested_at),
            weight,
            detail,
            url: s.photo_url.clone(),
        }
    }

    fn heat_evidence(&self, h: &Heat) -> Vec<EvidenceItem> {
        let mut out = Vec::new();
        for (name, v, unit) in [("dhw", h.dhw, "°C-weeks"), ("baa", h.baa, "alert level 0-4"), ("sst", h.sst, "°C"), ("sst_anomaly", h.anomaly, "°C")] {
            out.push(EvidenceItem {
                id: format!("reading:{}:{name}:{}:satellite", h.station, h.observed_at),
                kind: "reading",
                observed_at: Some(h.observed_at),
                submitted_at: None,
                ingested_at: Some(h.ingested_at),
                weight: None,
                detail: match v {
                    Some(v) => format!("CRW {name} {v:.2} {unit}, product day {}, ingested {}", iso(h.observed_at), iso(h.ingested_at)),
                    None => format!("CRW {name} missing (masked pixel) on product day {}", iso(h.observed_at)),
                },
                url: Some(crate::source_pages::CRW_DOI.to_string()),
            });
        }
        out
    }

    pub fn cell(&self, idx: usize, with_evidence: bool) -> CellScore {
        let index = self.index;
        let (lon, lat) = index.grid.center(idx);
        let near = self.reports_near(idx);
        let counted: Vec<&(&Report, Option<f32>)> = near.iter().filter(|(_, w)| w.is_some()).collect();
        let decaying = counted.iter().filter(|(s, _)| !s.prior).count();
        let priors = counted.len() - decaying;

        let recent_value = self.recent_value(idx);
        let recent_reports = Component {
            id: "recentReports",
            value: self.any_report.then_some(recent_value),
            state: if self.any_report { State::Ok } else { State::Unknown },
            weight: self.weights.recent_reports,
            rationale: format!(
                "kernel-weighted independent reports by observed date (Gaussian σ 2 cells, half-life {} d; research grade 1, other grades {OTHER_WEIGHT}, NAS/GBIF history {PRIOR_WEIGHT} prior; duplicates and GBIF copies of iNat never counted), normalised to the region maximum: {decaying} decaying and {priors} history records within reach",
                index.half_life_ms / DAY_MS as f64
            ),
            inputs: counted.iter().map(|(s, _)| format!("sighting:{}", s.id)).collect(),
            evidence: if with_evidence { near.iter().map(|(s, w)| self.report_evidence(s, *w, index.cell_m)).collect() } else { Vec::new() },
        };

        let idq = self.id_quality_value(idx);
        let precise: Vec<&&(&Report, Option<f32>)> = counted.iter().filter(|(s, _)| !s.prior && s.research_precise(index.cell_m)).collect();
        let id_quality = Component {
            id: "idQuality",
            value: idq,
            state: if idq.is_some() { State::Ok } else { State::Unknown },
            weight: self.weights.id_quality,
            rationale: format!(
                "kernel-weighted share of recent reports that are research grade with positional accuracy under the cell size ({:.0} m): {} of {decaying}",
                index.cell_m,
                precise.len()
            ),
            inputs: precise.iter().map(|(s, _)| format!("sighting:{}", s.id)).collect(),
            evidence: Vec::new(),
        };

        let heat = self.heat_at(idx).copied();
        let (heat_value, heat_state) = self.heat_value(idx);
        let heat_stress = Component {
            id: "heatStress",
            value: heat_value,
            state: heat_state,
            weight: self.weights.heat_stress,
            rationale: match &heat {
                Some(h) => format!(
                    "NOAA CRW at the nearest 5 km pixel: DHW {} °C-weeks mapped /{DHW_SEVERE} and bleaching alert level {} mapped /{BAA_MAX}, combined by max; product day {}, {} h old{}",
                    h.dhw.map_or("missing".into(), |v| format!("{v:.2}")),
                    h.baa.map_or("missing".into(), |v| format!("{v:.0}")),
                    iso(h.observed_at),
                    (self.at - h.observed_at) / 3_600_000,
                    if heat_state == State::Stale { ": stale beyond 72 h, value withheld" } else { "" }
                ),
                None => "no NOAA CRW product within reach known at this time: unknown, not zero".to_string(),
            },
            inputs: heat.map(|h| vec![format!("reading:{}:dhw:{}:satellite", h.station, h.observed_at), format!("reading:{}:baa:{}:satellite", h.station, h.observed_at)]).unwrap_or_default(),
            evidence: if with_evidence { heat.as_ref().map(|h| self.heat_evidence(h)).unwrap_or_default() } else { Vec::new() },
        };

        let fresh = self.newest_report.map_or(0.0, |t| 0.5f32.powf((self.at - t) as f32 / FRESH_HALF_LIFE_MS as f32));
        let crw_part = match heat_state {
            State::Ok => 1.0,
            State::Stale => 0.5,
            State::Unknown => 0.0,
        };
        let nas_part = match self.nas_newest {
            Some(t) if self.at - t <= 2 * 365 * DAY_MS => 1.0,
            Some(t) if self.at - t <= 10 * 365 * DAY_MS => 0.5,
            Some(_) => 0.25,
            None => 0.0,
        };
        let buoy_part = if index.buoys > 0 { 1.0 } else { 0.0 };
        let completeness_value = (fresh + crw_part + nas_part + buoy_part) / 4.0 * if self.thin { 0.5 } else { 1.0 };
        let completeness = Component {
            id: "completeness",
            value: Some(completeness_value),
            state: State::Ok,
            weight: 0.0,
            rationale: "mean of report freshness (30 d half-life), CRW state at the cell, NAS coverage of the region and buoy coverage of the region, halved in a thin region; lowers confidence, never the rank".to_string(),
            inputs: vec![
                format!(
                    "reports: {} independent in 90 d, newest observed {} ({fresh:.2})",
                    self.recent_reports,
                    self.newest_report.map_or("none".to_string(), iso)
                ),
                format!("crw: {} ({crw_part:.1})", heat_state.as_str()),
                format!(
                    "nas: {} records, newest observed {} ({nas_part:.2})",
                    self.nas_total,
                    self.nas_newest.map_or("none".to_string(), iso)
                ),
                format!("buoys: {} NDBC stations in region ({buoy_part:.0})", index.buoys),
                format!("thin: {}", if self.thin { "yes (×0.5)" } else { "no" }),
            ],
            evidence: Vec::new(),
        };

        CellScore {
            idx,
            cell: index.grid.cell_id(idx),
            region: index.region.clone(),
            lat,
            lon,
            rank_score: self.rank_of(recent_value, idq, heat_value),
            thin: self.thin,
            components: Components { recent_reports, id_quality, heat_stress, completeness },
            heat,
            field_window: self.field_at(idx).copied(),
        }
    }
}

/// Ranked cells across the regions `bbox` touches (optionally one `region`), best first.
/// `recentReports` is normalised per region, so a cross-region list orders relative values;
/// pass `region` to rank within one.
#[allow(clippy::too_many_arguments)]
pub async fn hotspots(
    db: &Db,
    app: &App,
    taxon: &Taxon,
    at: i64,
    bbox: BBox,
    top: usize,
    region: Option<&str>,
    weights: Weights,
    basis: DateBasis,
) -> anyhow::Result<Vec<CellScore>> {
    let query = crate::app::config::BBox { west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north };
    let mut out: Vec<CellScore> = Vec::new();
    for r in app.regions.iter().filter(|r| r.bbox().intersects(&query) && region.is_none_or(|id| id == r.id())) {
        let index = Arc::new(Index::load(db, app, r, taxon, at, at + 1).await?);
        let cells = tokio::task::spawn_blocking(move || {
            let frame = index.frame(at, basis, weights);
            let rank = frame.rank();
            let mut cells: Vec<(usize, f32)> = rank
                .iter()
                .copied()
                .enumerate()
                .filter(|&(i, s)| {
                    s > 0.0 && {
                        let (lon, lat) = index.grid.center(i);
                        lon >= bbox.west && lon < bbox.east && lat >= bbox.south && lat < bbox.north
                    }
                })
                .collect();
            cells.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
            cells.into_iter().take(top).map(|(i, _)| frame.cell(i, false)).collect::<Vec<_>>()
        })
        .await?;
        out.extend(cells.into_iter().map(|c| CellScore { cell: app.cell_id(r, c.idx), ..c }));
    }
    out.sort_by(|a, b| b.rank_score.total_cmp(&a.rank_score).then(a.cell.cmp(&b.cell)));
    out.truncate(top);
    Ok(out)
}

/// One cell with every input listed (`explainCell`, `hotspot:` evidence).
pub async fn explain(db: &Db, app: &App, cell: &str, taxon: &Taxon, at: i64, weights: Weights, basis: DateBasis) -> anyhow::Result<CellExplain> {
    let (region, idx) = app.parse_cell(cell).ok_or_else(|| anyhow::anyhow!("bad cell id {cell:?}; expected {}", app.cell_shape()))?;
    let index = Arc::new(Index::load(db, app, region, taxon, at, at + 1).await?);
    let mut c = tokio::task::spawn_blocking(move || index.frame(at, basis, weights).cell(idx, true)).await?;
    c.cell = app.cell_id(region, idx);
    Ok(CellExplain { cell: c, weights, basis, caveats: CAVEATS.to_vec(), credit: crate::source_pages::CRW_CREDIT })
}

/// Would the ranking at each day `D` (what was submitted by `D`) have put the cells that received
/// independent reports in `[D, D + 7 d)` in the top 10 % of the region? `days` evaluation days end
/// 7 days before `end_ms`. Thin regions are not scored and are listed as insufficient.
pub async fn backtest_until(db: &Db, app: &App, taxon: &Taxon, days: u32, end_ms: i64) -> anyhow::Result<Backtest> {
    anyhow::ensure!((1..=366).contains(&days), "days must be 1..=366, got {days}");
    let horizon = BACKTEST_HORIZON_DAYS as i64 * DAY_MS;
    let end_day = floor_day(end_ms);
    let first = end_day - horizon - days as i64 * DAY_MS;
    let mut per_day: Vec<BacktestDay> = (0..days as i64).map(|i| BacktestDay { day: first + i * DAY_MS, sightings: 0, hits: 0 }).collect();
    let mut insufficient = Vec::new();
    let weights = Weights::from_app(app);
    for r in &app.regions {
        let index = Arc::new(Index::load(db, app, r, taxon, first, end_day).await?);
        let region_days = tokio::task::spawn_blocking(move || {
            // Thin: configured, or too few independent reports over the whole evaluated span.
            let span_reports = index
                .reports
                .iter()
                .filter(|s| s.independent && !s.prior && s.observed_at >= first && s.observed_at < end_day)
                .count();
            if index.thin_cfg || span_reports < THIN_MIN_REPORTS as usize {
                return None;
            }
            Some(
                (0..days as i64)
                    .into_par_iter()
                    .map(|i| {
                        let day = first + i * DAY_MS;
                        let frame = index.frame(day, DateBasis::Submitted, weights);
                        let rank = frame.rank();
                        let threshold = top_threshold(&rank);
                        let (mut n, mut hits) = (0u32, 0u32);
                        for s in index.reports.iter().filter(|s| s.independent && !s.prior && s.observed_at >= day && s.observed_at < day + horizon) {
                            n += 1;
                            if rank[index.grid.index(s.col, s.row)] >= threshold {
                                hits += 1;
                            }
                        }
                        (n, hits)
                    })
                    .collect::<Vec<_>>(),
            )
        })
        .await?;
        match region_days {
            Some(days) => {
                for (d, (s, h)) in per_day.iter_mut().zip(days) {
                    d.sightings += s;
                    d.hits += h;
                }
            }
            None => insufficient.push(r.id().to_string()),
        }
    }
    let total: u32 = per_day.iter().map(|d| d.sightings).sum();
    let hits: u32 = per_day.iter().map(|d| d.hits).sum();
    Ok(Backtest {
        species: taxon.id().to_string(),
        days,
        hit_rate: if total == 0 { 0.0 } else { hits as f64 / total as f64 },
        baseline: BASELINE,
        per_day,
        horizon_days: BACKTEST_HORIZON_DAYS,
        evaluated: total,
        hits,
        insufficient_regions: insufficient,
        note: Some(format!(
            "Hit rate: share of independent reports observed in the {BACKTEST_HORIZON_DAYS} days after each evaluation day whose cell ranked in the top 10 % of its region using only what was submitted by that day; baseline {BASELINE} is the share random cells would hit. Reports reflect observer effort, not lionfish abundance, so a hit means observers returned to ranked cells. Thin regions are not scored."
        )),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::config::App;
    use crate::hotspot::score::testkit::{insert_sighting, insert_station, ms, seed_sources, DAY, HOUR};

    fn app() -> App {
        let mut app = App::builtin("lionfish").unwrap();
        app.taxa[0].taxon_id = 4;
        app
    }

    fn report(id: i64, col: u32, row: u32, observed_at: i64) -> Report {
        Report {
            id,
            source: "inat".into(),
            ext_id: id.to_string(),
            lat: 0.0,
            lon: 0.0,
            col,
            row,
            accuracy_m: Some(50.0),
            observed_at,
            submitted_at: Some(observed_at + HOUR),
            ingested_at: observed_at + 2 * HOUR,
            quality: 0,
            prior: false,
            independent: true,
            canonical_id: None,
            photo_url: None,
        }
    }

    /// A product day's readings, ingested 20 h after the product time (CRW publishes D at about D+1 18:50Z).
    fn crw(station: u32, dhw: f64, baa: f64, at: i64) -> Vec<CrwReading> {
        vec![
            CrwReading { station, param: P_DHW, observed_at: at, ingested_at: at + 20 * HOUR, value: dhw },
            CrwReading { station, param: P_BAA, observed_at: at, ingested_at: at + 20 * HOUR, value: baa },
            CrwReading { station, param: P_SST, observed_at: at, ingested_at: at + 20 * HOUR, value: 30.5 },
        ]
    }

    fn index(region: &str, reports: Vec<Report>, crw_stations: Vec<(i64, f64, f64)>, crw: Vec<CrwReading>) -> Index {
        let app = app();
        let r = app.region(region).unwrap();
        Index::new(r, &app.taxa[0], Weights::from_app(&app), reports, crw_stations, crw, Vec::new(), Vec::new(), 0)
    }

    fn fl_cell(col: u32, row: u32) -> (f64, f64) {
        let app = app();
        let g = app.region("fl-keys").unwrap().grid;
        let (lon, lat) = g.center(g.index(col, row));
        (lat, lon)
    }

    #[test]
    fn lionfish_score_florida_like_case_dhw_and_baa_disagree() {
        // Looe Key: DHW 13.65 with alert level 1; both are returned, the max rules.
        let t = ms(2026, 9, 30, 12);
        let product = ms(2026, 9, 29, 12);
        let (lat, lon) = fl_cell(100, 100);
        let idx = index("fl-keys", vec![report(1, 100, 100, t - 2 * DAY)], vec![(7, lat, lon)], crw(0, 13.65, 1.0, product));
        let frame = idx.frame(t, DateBasis::Submitted, idx.weights);
        let c = frame.cell(idx.grid.index(100, 100), true);
        let h = &c.components.heat_stress;
        assert_eq!((h.value, h.state), (Some(1.0), State::Ok), "{h:?}");
        assert_eq!((c.heat.unwrap().dhw, c.heat.unwrap().baa), (Some(13.65), Some(1.0)));
        assert_eq!(c.components.recent_reports.value, Some(1.0));
        assert_eq!(c.components.id_quality.value, Some(1.0));
        assert_eq!(c.components.recent_reports.inputs, ["sighting:1"]);
        assert!(h.evidence.iter().any(|e| e.id == format!("reading:7:dhw:{product}:satellite") && e.detail.contains("13.65")));
        // rank = (1 + 1 + 1) / 3; completeness never enters.
        assert!((c.rank_score - 1.0).abs() < 1e-6);
        assert!(c.thin, "one report in 90 d is thin");
        assert!(c.components.completeness.value.unwrap() < 0.5, "{:?}", c.components.completeness);
        // BAA alone at level 2 maps to 0.5.
        let idx2 = index("fl-keys", vec![], vec![(7, lat, lon)], crw(0, 1.0, 2.0, product));
        let f2 = idx2.frame(t, DateBasis::Submitted, idx2.weights);
        assert_eq!(f2.cell(idx2.grid.index(100, 100), false).components.heat_stress.value, Some(0.5));
    }

    #[test]
    fn lionfish_score_belize_thin_case_one_report() {
        let app = app();
        let t = ms(2026, 9, 30, 12);
        let idx = index("belize", vec![report(5, 40, 40, t - 30 * DAY)], Vec::new(), Vec::new());
        let frame = idx.frame(t, DateBasis::Submitted, Weights::from_app(&app));
        assert!(frame.thin);
        assert_eq!(frame.recent_reports, 1);
        let c = frame.cell(idx.grid.index(40, 40), false);
        assert_eq!(c.components.recent_reports.value, Some(1.0), "the one report peaks its own region");
        assert_eq!(c.components.heat_stress.state, State::Unknown);
        assert_eq!(c.components.heat_stress.value, None, "unknown is not zero");
        assert!(c.components.completeness.inputs.iter().any(|i| i.starts_with("thin: yes")));
        // Belize is thin by config even with plenty of reports.
        let many: Vec<Report> = (0..10).map(|i| report(10 + i, 40 + i as u32, 40, t - DAY * (i + 1))).collect();
        let idx = index("belize", many, Vec::new(), Vec::new());
        assert!(idx.frame(t, DateBasis::Submitted, idx.weights).thin);
    }

    #[test]
    fn lionfish_score_gbif_copy_of_inat_never_double_counts() {
        let t = ms(2026, 9, 30, 12);
        let original = report(1, 50, 50, t - DAY);
        let mut copy = report(2, 50, 50, t - DAY);
        copy.source = "gbif".into();
        copy.independent = false;
        copy.canonical_id = Some(1);
        copy.prior = true;
        let mut far = report(3, 100, 150, t - DAY);
        far.accuracy_m = Some(5000.0);
        let idx = index("mx-caribbean", vec![original, copy, far], Vec::new(), Vec::new());
        let frame = idx.frame(t, DateBasis::Submitted, idx.weights);
        let a = frame.cell(idx.grid.index(50, 50), true);
        let b = frame.cell(idx.grid.index(100, 150), true);
        assert_eq!(a.components.recent_reports.value, b.components.recent_reports.value, "the copy adds nothing");
        assert_eq!(a.components.recent_reports.inputs, ["sighting:1"]);
        let copy_ev = a.components.recent_reports.evidence.iter().find(|e| e.id == "sighting:2").unwrap();
        assert_eq!(copy_ev.weight, None);
        assert!(copy_ev.detail.contains("duplicate of sighting:1, not counted"), "{}", copy_ev.detail);
        assert_eq!(b.components.id_quality.value, Some(0.0), "5 km accuracy is not precise");
        assert_eq!(a.components.id_quality.value, Some(1.0));
    }

    #[test]
    fn lionfish_score_missing_and_stale_crw() {
        let t = ms(2026, 9, 30, 12);
        let (lat, lon) = fl_cell(100, 100);
        // Missing: no CRW rows at all.
        let idx = index("fl-keys", vec![report(1, 100, 100, t - DAY)], Vec::new(), Vec::new());
        let c = idx.frame(t, DateBasis::Submitted, idx.weights).cell(idx.grid.index(100, 100), true);
        assert_eq!((c.components.heat_stress.value, c.components.heat_stress.state), (None, State::Unknown));
        assert!(c.heat.is_none());
        assert!((c.rank_score - 2.0 / 3.0).abs() < 1e-6, "unknown contributes nothing to the rank");
        // Stale: the newest product is 5 days old.
        let idx = index("fl-keys", vec![report(1, 100, 100, t - DAY)], vec![(7, lat, lon)], crw(0, 4.0, 2.0, t - 5 * DAY));
        let c = idx.frame(t, DateBasis::Submitted, idx.weights).cell(idx.grid.index(100, 100), true);
        assert_eq!((c.components.heat_stress.value, c.components.heat_stress.state), (None, State::Stale));
        assert_eq!(c.heat.unwrap().dhw, Some(4.0), "the stale values are still shown");
        assert!(c.components.heat_stress.rationale.contains("stale beyond 72 h"));
        assert!(c.components.completeness.inputs.iter().any(|i| i == "crw: stale (0.5)"));
        // Masked pixel: a missing flag is unknown, not 0.
        let masked = vec![CrwReading { station: 0, param: P_DHW, observed_at: t - DAY, ingested_at: t - HOUR, value: f64::NAN }];
        let idx = index("fl-keys", vec![], vec![(7, lat, lon)], masked);
        let c = idx.frame(t, DateBasis::Submitted, idx.weights).cell(idx.grid.index(100, 100), false);
        assert_eq!((c.components.heat_stress.value, c.components.heat_stress.state), (None, State::Unknown));
    }

    #[test]
    fn lionfish_score_no_reports_high_heat_ranks_from_heat_only() {
        let t = ms(2026, 9, 30, 12);
        let (lat, lon) = fl_cell(100, 100);
        let idx = index("fl-keys", Vec::new(), vec![(7, lat, lon)], crw(0, 12.0, 3.0, t - 2 * DAY));
        let frame = idx.frame(t, DateBasis::Submitted, idx.weights);
        let c = frame.cell(idx.grid.index(100, 100), false);
        assert_eq!((c.components.recent_reports.value, c.components.recent_reports.state), (None, State::Unknown), "no reports in the region at all");
        assert_eq!(c.components.id_quality.state, State::Unknown);
        assert_eq!(c.components.heat_stress.value, Some(1.0));
        assert!((c.rank_score - 1.0 / 3.0).abs() < 1e-6);
        let completeness = c.components.completeness.value.unwrap();
        assert!(completeness <= 0.25, "no reports, no NAS, no buoys, thin: {completeness}");
        // Weights steer the rank: heat only.
        let heat_only = idx.weights.with(Some(0.0), Some(0.0), Some(2.0)).unwrap();
        assert_eq!(idx.frame(t, DateBasis::Submitted, heat_only).cell(idx.grid.index(100, 100), false).rank_score, 1.0);
        assert!(idx.weights.with(Some(0.0), Some(0.0), Some(0.0)).is_err());
        assert!(idx.weights.with(Some(-1.0), None, None).is_err());
        // A cell with no pixel in reach ranks 0.
        let far = frame.cell(idx.grid.index(300, 300), false);
        assert_eq!(far.rank_score, 0.0);
        assert_eq!(far.components.heat_stress.state, State::Unknown);
    }

    #[test]
    fn lionfish_score_kernel_decay_and_grades() {
        let t = ms(2026, 9, 30, 12);
        let mut casual = report(2, 200, 100, t - DAY);
        casual.quality = 2;
        // A research-grade report one half-life (60 d) older than the casual one.
        let idx = index("fl-keys", vec![report(1, 100, 100, t - 61 * DAY), casual], Vec::new(), Vec::new());
        let frame = idx.frame(t, DateBasis::Submitted, idx.weights);
        let a = frame.cell(idx.grid.index(100, 100), false);
        let b = frame.cell(idx.grid.index(200, 100), false);
        let (va, vb) = (a.components.recent_reports.value.unwrap(), b.components.recent_reports.value.unwrap());
        assert!((va / vb - 0.5f32.powf(61.0 / 60.0) / (OTHER_WEIGHT * 0.5f32.powf(1.0 / 60.0))).abs() < 1e-3, "{va} {vb}");
        assert_eq!(b.components.id_quality.value, Some(0.0));
        let near = frame.cell(idx.grid.index(102, 101), false);
        assert!(near.components.recent_reports.value.unwrap() < va && near.components.recent_reports.value.unwrap() > 0.0);
        assert_eq!(frame.cell(idx.grid.index(110, 100), false).components.recent_reports.value, Some(0.0), "outside 3σ");
        assert_eq!(frame.cell(idx.grid.index(110, 100), false).components.id_quality.state, State::Unknown);
        // Priors: a static 0.2 that never decays, and a history record is not "recent" for thin.
        let mut nas = report(3, 20, 20, t - 2000 * DAY);
        nas.source = "nas".into();
        nas.prior = true;
        nas.submitted_at = None;
        nas.ingested_at = t - HOUR;
        let idx = index("fl-keys", vec![nas, report(4, 100, 100, t - DAY)], Vec::new(), Vec::new());
        let frame = idx.frame(t, DateBasis::Submitted, idx.weights);
        let p = frame.cell(idx.grid.index(20, 20), false);
        assert!((p.components.recent_reports.value.unwrap() - PRIOR_WEIGHT / 0.5f32.powf(1.0 / 60.0)).abs() < 1e-5);
        assert_eq!(p.components.id_quality.state, State::Unknown, "priors carry no grade");
        assert_eq!(frame.recent_reports, 1);
        assert!(p.components.completeness.inputs.iter().any(|i| i.starts_with("nas: 1 records")));
    }

    #[tokio::test]
    async fn lionfish_score_index_loads_independent_rows_and_crw_from_db() {
        let db = Db::memory("observations");
        seed_sources(&db).await;
        db.write(|tx| {
            tx.execute("insert or ignore into sources (id, name, homepage, mode, cadence_s, max_latency_s) values ('crw', 'crw', 'x', 'webhook', 1, 1)", [])?;
            tx.execute("insert or ignore into sources (id, name, homepage, mode, cadence_s, max_latency_s) values ('openmeteo-marine', 'om', 'x', 'poll', 1, 1)", [])?;
            Ok(())
        })
        .await
        .unwrap();
        let app = app();
        let fl = app.region("fl-keys").unwrap();
        let t = ms(2026, 9, 30, 12);
        let (lat, lon) = fl_cell(100, 100);
        let a = insert_sighting(&db, "inat", 4, lat, lon, t - DAY, "research", None).await;
        // GBIF copy of iNat (dataset prefix), linked: never independent.
        db.write(move |tx| {
            tx.execute(
                "insert into sightings (source_id, ext_id, taxon_id, lat, lon, observed_at, quality, canonical_id, ingested_at) values ('gbif', '50c9509d-22c7-4a22-a47d-8c48425ef4a7:123:9', 4, ?1, ?2, ?3, 'research', ?4, ?3)",
                rusqlite::params![lat, lon, t - DAY, a],
            )?;
            tx.execute("update sightings set submitted_at = ?2, accuracy_m = 20 where id = ?1", rusqlite::params![a, t - DAY + 3 * HOUR])?;
            Ok(())
        })
        .await
        .unwrap();
        let st = insert_station(&db, "crw", "24.525,-81.375", lat, lon, "grid").await;
        let product = t - 2 * DAY;
        db.write(move |tx| {
            for (p, v) in [("dhw", Some(13.65)), ("baa", Some(1.0)), ("sst", None)] {
                tx.execute(
                    "insert into readings (station_id, param, value, flag, observed_at, origin) values (?1, ?2, ?3, ?4, ?5, 'satellite')",
                    rusqlite::params![st, p, v, if v.is_some() { "ok" } else { "missing" }, product],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
        let idx = Index::load(&db, &app, fl, &app.taxa[0], t, t + 1).await.unwrap();
        assert_eq!(idx.reports.len(), 2);
        assert_eq!(idx.reports.iter().filter(|r| r.independent).count(), 1);
        assert_eq!(idx.reports[0].submitted_at, Some(t - DAY + 3 * HOUR));
        assert_eq!(idx.crw_stations, [(st, lat, lon)]);
        let c = idx.frame(t, DateBasis::Submitted, idx.weights).cell(idx.grid.index(100, 100), true);
        let h = c.heat.unwrap();
        assert_eq!((h.dhw, h.baa, h.sst), (Some(13.65), Some(1.0), None));
        assert_eq!(c.components.heat_stress.value, Some(1.0));
        assert_eq!(c.components.recent_reports.inputs, [format!("sighting:{a}")]);
        assert_eq!(c.components.recent_reports.evidence.len(), 2, "the copy is listed as not counted");
        // The whole region through the public entry point, cell ids carrying the region.
        let cells = hotspots(&db, &app, &app.taxa[0], t, app.hull().into(), 3, None, idx.weights, DateBasis::Submitted).await.unwrap();
        assert_eq!(cells[0].cell, "fl-keys:100:100");
        assert_eq!(cells.len(), 3);
        let only_mx = hotspots(&db, &app, &app.taxa[0], t, app.hull().into(), 3, Some("mx-caribbean"), idx.weights, DateBasis::Submitted).await.unwrap();
        assert!(only_mx.is_empty());
        let ex = explain(&db, &app, "fl-keys:100:100", &app.taxa[0], t, idx.weights, DateBasis::Submitted).await.unwrap();
        assert_eq!(ex.cell.cell, "fl-keys:100:100");
        assert_eq!(ex.caveats.len(), 4);
        assert!(explain(&db, &app, "100:100", &app.taxa[0], t, idx.weights, DateBasis::Submitted).await.is_err());
    }

    /// A frame at `t` sees a report once submitted (or observed, on request), a CRW product once
    /// ingested, and a marine run once issued; nothing from after `t`.
    #[test]
    fn lionfish_asof_visibility_by_submitted_ingest_and_issuance() {
        let t = ms(2026, 9, 30, 12);
        let mut late = report(1, 100, 100, t - 10 * DAY);
        late.submitted_at = Some(t - DAY);
        late.ingested_at = t - DAY + HOUR;
        let (lat, lon) = fl_cell(100, 100);
        let app = app();
        let fl = app.region("fl-keys").unwrap();
        let marine = (0..72).map(|h| Forecast { station: 0, wave: true, issued_at: t - 6 * HOUR, valid_at: t + h * HOUR, value: 0.8 }).collect();
        let idx = Index::new(fl, &app.taxa[0], Weights::from_app(&app), vec![late], vec![(7, lat, lon)], crw(0, 4.0, 2.0, t - 2 * DAY), vec![(9, lat, lon)], marine, 0);
        let i = idx.grid.index(100, 100);
        // t - 5 d, submitted basis: nothing is known; observed basis: the report counts, nothing else.
        let c = idx.frame(t - 5 * DAY, DateBasis::Submitted, idx.weights).cell(i, false);
        assert_eq!(c.components.recent_reports.state, State::Unknown);
        assert_eq!(c.rank_score, 0.0);
        let c = idx.frame(t - 5 * DAY, DateBasis::Observed, idx.weights).cell(i, false);
        assert_eq!(c.components.recent_reports.value, Some(1.0));
        assert_eq!((c.components.heat_stress.state, c.field_window), (State::Unknown, None));
        // t - 36 h: product day passed, ingest (t - 2 d + 20 h = t - 28 h) not yet.
        let c = idx.frame(t - 36 * HOUR, DateBasis::Submitted, idx.weights).cell(i, false);
        assert_eq!((c.components.recent_reports.state, c.components.heat_stress.state), (State::Unknown, State::Unknown));
        // t - 12 h: report (submitted t - 1 d) and product (ingested t - 28 h) known; the marine run (t - 6 h) not.
        let c = idx.frame(t - 12 * HOUR, DateBasis::Submitted, idx.weights).cell(i, false);
        assert_eq!((c.components.recent_reports.value, c.components.heat_stress.value), (Some(1.0), Some(0.5)));
        assert_eq!(c.field_window, None);
        // t: everything, with a calm 72 h window.
        let c = idx.frame(t, DateBasis::Submitted, idx.weights).cell(i, false);
        let fw = c.field_window.unwrap();
        assert_eq!((fw.state, fw.issued_at, fw.calm_hours, fw.wave_max_m, fw.current_max_ms), (State::Ok, Some(t - 6 * HOUR), Some(72), Some(0.8), None));
        // t + 2 d: the run is stale and only 24 of its hours remain in the horizon.
        let c = idx.frame(t + 2 * DAY, DateBasis::Submitted, idx.weights).cell(i, false);
        let fw = c.field_window.unwrap();
        assert_eq!((fw.state, fw.calm_hours), (State::Stale, Some(24)));
    }

    /// `backfill --fixtures --app lionfish` data, ranked now: Florida and Mexico have a top cell
    /// with reports; Belize and Colombia are thin. Prints `LIONFISH-TOP`.
    #[tokio::test]
    async fn lionfish_top_cells_on_fixtures() {
        let state = crate::app::test_support::test_state_for("lionfish");
        let root = crate::backfill::fixtures_root();
        for source in crate::backfill::fixture_sources(&state) {
            crate::backfill::ingest_fixtures(&state, source.as_ref(), &root).await.unwrap();
        }
        let app = &state.app;
        let now = chrono::Utc::now().timestamp_millis();
        let mut parts = Vec::new();
        for r in &app.regions {
            let cells = hotspots(&state.obs, app, &app.taxa[0], now, app.hull().into(), 1, Some(r.id()), Weights::from_app(app), DateBasis::Submitted).await.unwrap();
            let top = cells.first();
            let thin = top.is_none_or(|c| c.thin);
            if !r.cfg.thin {
                let c = top.unwrap_or_else(|| panic!("{} has no ranked cell", r.id()));
                assert!(!c.thin, "{} is thin: {:?}", r.id(), c.components.completeness);
                assert!(!c.components.recent_reports.inputs.is_empty(), "{} top cell has no reports: {:?}", r.id(), c.components.recent_reports);
                assert_eq!(c.components.recent_reports.value, Some(1.0));
            }
            parts.push(format!("{}={}", r.cfg.code(), if thin { "thin".to_string() } else { top.unwrap().cell.clone() }));
        }
        println!("LIONFISH-TOP {}", parts.join(" "));
        assert!(parts[2].ends_with("=thin") && parts[3].ends_with("=thin"));
    }

    /// Scoring the largest region (co-caribbean, 780 × 380 cells) with a full CRW pixel grid,
    /// marine points and a few hundred reports. Prints `LIONFISH-PERF`.
    #[test]
    fn lionfish_perf_largest_region_grid() {
        let app = app();
        let co = app.region("co-caribbean").unwrap();
        let g = co.grid;
        assert_eq!((g.cols, g.rows), (780, 380));
        let t = ms(2026, 9, 30, 12);
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        let mut rnd = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let reports: Vec<Report> = (0..400)
            .map(|i| report(i, (rnd() * g.cols as f64) as u32, (rnd() * g.rows as f64) as u32, t - (rnd() * 300.0 * DAY as f64) as i64))
            .collect();
        let mut stations = Vec::new();
        let mut crw_rows = Vec::new();
        for r in 0..(g.rows / 5) {
            for c in 0..(g.cols / 5) {
                let (lon, lat) = g.center(g.index(c * 5 + 2, r * 5 + 2));
                let s = stations.len() as u32;
                stations.push((s as i64 + 1, lat, lon));
                crw_rows.extend(crw(s, rnd() * 12.0, (rnd() * 4.0).floor(), t - 2 * DAY));
            }
        }
        let mut marine_stations = Vec::new();
        let mut marine = Vec::new();
        for r in 0..8 {
            for c in 0..16 {
                let (lon, lat) = g.center(g.index(c * 50 + 25, r * 50 + 25));
                let s = marine_stations.len() as u32;
                marine_stations.push((s as i64 + 1, lat, lon));
                for h in 0..72 {
                    marine.push(Forecast { station: s, wave: true, issued_at: t - 6 * HOUR, valid_at: t + h * HOUR, value: (rnd() * 2.0) as f32 });
                    marine.push(Forecast { station: s, wave: false, issued_at: t - 6 * HOUR, valid_at: t + h * HOUR, value: (rnd() * 0.8) as f32 });
                }
            }
        }
        let index = Index::new(co, &app.taxa[0], Weights::from_app(&app), reports, stations.clone(), crw_rows, marine_stations, marine, 0);
        let started = std::time::Instant::now();
        let frame = index.frame(t, DateBasis::Submitted, index.weights);
        let rank = frame.rank();
        let first = started.elapsed();
        let started = std::time::Instant::now();
        let earlier = index.frame(t - DAY, DateBasis::Submitted, index.weights);
        let rank2 = earlier.rank();
        let second = started.elapsed();
        let top = rank.iter().copied().fold(0f32, f32::max);
        let cells: Vec<CellScore> = (0..100).map(|i| frame.cell(i * 2000, false)).collect();
        // The run issued 6 h before `t` was not public a day earlier.
        assert!((0..100).all(|i| earlier.cell(i * 2000, false).field_window.is_none()));
        println!(
            "LIONFISH-PERF cells={} crw_pixels={} first_frame_ms={} second_frame_ms={} top={top:.3} top_cells_100={}",
            g.cells(),
            stations.len(),
            first.as_millis(),
            second.as_millis(),
            cells.len()
        );
        assert_eq!((rank.len(), rank2.len()), (g.cells(), g.cells()));
        assert!(cells.iter().any(|c| c.field_window.is_some()));
        assert!(second.as_millis() < 10_000, "a frame of the largest region took {second:?}");
    }
}
