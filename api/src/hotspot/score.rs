//! density × activity × access (T11, PRD section 8).
//!
//! A `Snapshot` holds everything the scorer needs for one region and time window, loaded
//! once from the observations db: in-grid sightings, stations and the condition readings.
//! Scoring a frame time then touches no database, so frame builds and backtests parallelise
//! with rayon. Taxa come from the app config (`App::taxa`); the snapshot keeps one density
//! index per taxon in config order.
//!
//! Density: each non-duplicate sighting of the taxon is splatted with a Gaussian kernel
//! (σ = 2 cells, truncated at 3σ) and weighted by `0.5^(age / half_life)`. Sightings from the
//! `nas` and `gbif` history sources are a static prior: weight 0.2 and no time decay. The
//! grid is normalised to 0..1 by its maximum, per frame.
//!
//! Conditions: for every parameter, the latest valid reading per station inside the last
//! `STALE_MS` is taken and each cell reads its nearest reporting station (within
//! `CondParam::max_cells`). Cells with no station in reach have no data for that parameter.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::Datelike;
use rayon::prelude::*;

use super::rules::{self, Conditions};
use super::Grid;
use crate::app::config::{App, Taxon};
use crate::db::Db;

/// Kernel width in cells; truncated at 3σ.
pub const SIGMA_CELLS: f64 = 2.0;
pub const KERNEL_RADIUS: i32 = 6;
/// Weight of a `nas` / `gbif` history record.
pub const PRIOR_WEIGHT: f32 = 0.2;
/// Decayed sightings older than this many half-lives are dropped (weight < 1/64).
pub const DECAY_WINDOW_HALF_LIVES: f64 = 6.0;
/// A reading older than this is not a current condition.
pub const STALE_MS: i64 = 6 * 3_600_000;
/// A sighting ingested this long after it was observed carries the `late` flag.
pub const LATE_MS: i64 = 24 * 3_600_000;
pub const PRIOR_SOURCES: [&str; 2] = ["nas", "gbif"];
pub const DAY_MS: i64 = 86_400_000;

pub const FLAG_DUPLICATE: u8 = 1;
pub const FLAG_CONFLICT: u8 = 2;
pub const FLAG_LATE: u8 = 4;

/// Condition parameters, in `Conditions` field order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CondParam {
    AirC = 0,
    LstC = 1,
    SstC = 2,
    StageM = 3,
    WaveM = 4,
    WindMs = 5,
}

impl CondParam {
    pub const ALL: [CondParam; 6] =
        [CondParam::AirC, CondParam::LstC, CondParam::SstC, CondParam::StageM, CondParam::WaveM, CondParam::WindMs];

    /// `readings.param` value.
    pub fn column(self) -> &'static str {
        match self {
            CondParam::AirC => "air_c",
            CondParam::LstC => "lst_c",
            CondParam::SstC => "sst_c",
            CondParam::StageM => "stage_m",
            CondParam::WaveM => "wave_m",
            CondParam::WindMs => "wind_ms",
        }
    }

    pub fn parse(s: &str) -> Option<CondParam> {
        CondParam::ALL.iter().copied().find(|p| p.column() == s)
    }

    /// How far (in cells) a cell may look for a reporting station. Satellite grids are
    /// dense, so a cell only takes a neighbouring pixel; point stations cover the region.
    pub fn max_cells(self) -> u32 {
        match self {
            CondParam::LstC | CondParam::SstC => 5,
            _ => 200,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SightingPt {
    pub id: i64,
    pub taxon_id: i64,
    pub lon: f32,
    pub lat: f32,
    pub col: u32,
    pub row: u32,
    pub observed_at: i64,
    /// From a history source (`nas`, `gbif`): static prior, no decay.
    pub prior: bool,
    /// PLAN.md C4 quality code.
    pub quality: u8,
    /// PLAN.md C4 flag bits.
    pub flags: u8,
}

impl SightingPt {
    pub fn duplicate(&self) -> bool {
        self.flags & FLAG_DUPLICATE != 0
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReadingPt {
    /// Index into `Snapshot::stations`.
    pub station: u32,
    pub observed_at: i64,
    /// NaN when the reading is null or flagged.
    pub value: f32,
}

pub fn quality_code(q: &str) -> u8 {
    match q {
        "research" => 0,
        "needs_id" => 1,
        "casual" => 2,
        "curated" => 3,
        _ => 2,
    }
}

/// Gaussian stencil, (2R+1)², zero outside the 3σ disc.
pub(super) struct Kernel {
    w: Vec<f32>,
}

impl Kernel {
    pub(super) fn new() -> Kernel {
        let n = (2 * KERNEL_RADIUS + 1) as usize;
        let mut w = vec![0f32; n * n];
        for dy in -KERNEL_RADIUS..=KERNEL_RADIUS {
            for dx in -KERNEL_RADIUS..=KERNEL_RADIUS {
                let d2 = (dx * dx + dy * dy) as f64;
                if d2 <= (KERNEL_RADIUS * KERNEL_RADIUS) as f64 {
                    let i = (dy + KERNEL_RADIUS) as usize * n + (dx + KERNEL_RADIUS) as usize;
                    w[i] = (-d2 / (2.0 * SIGMA_CELLS * SIGMA_CELLS)).exp() as f32;
                }
            }
        }
        Kernel { w }
    }

    pub(super) fn splat(&self, grid: &Grid, acc: &mut [f32], col: u32, row: u32, weight: f32) {
        let n = 2 * KERNEL_RADIUS + 1;
        let (cols, rows) = (grid.cols as i32, grid.rows as i32);
        for dy in -KERNEL_RADIUS..=KERNEL_RADIUS {
            let r = row as i32 + dy;
            if r < 0 || r >= rows {
                continue;
            }
            let krow = ((dy + KERNEL_RADIUS) * n) as usize;
            let base = r as usize * cols as usize;
            for dx in -KERNEL_RADIUS..=KERNEL_RADIUS {
                let c = col as i32 + dx;
                if c < 0 || c >= cols {
                    continue;
                }
                let k = self.w[krow + (dx + KERNEL_RADIUS) as usize];
                if k > 0.0 {
                    acc[base + c as usize] += weight * k;
                }
            }
        }
    }
}

/// One condition layer at a frame time: the reporting stations' values and each cell's
/// nearest reporting station (index into `values`, or `u32::MAX`).
struct CondLayer {
    nearest: Arc<Vec<u32>>,
    values: Vec<f32>,
    /// `Snapshot::stations` index of each value.
    stations: Vec<u32>,
}

/// Conditions for every cell at one frame time.
pub struct CondFrame {
    pub month: u32,
    layers: [Option<CondLayer>; 6],
}

impl CondFrame {
    pub fn value(&self, p: CondParam, idx: usize) -> Option<f32> {
        self.value_from(p, idx).map(|(v, _)| v)
    }

    /// `value`, with the `Snapshot::stations` index of the station it was read from.
    pub fn value_from(&self, p: CondParam, idx: usize) -> Option<(f32, u32)> {
        let layer = self.layers[p as usize].as_ref()?;
        let n = layer.nearest[idx];
        (n != u32::MAX).then(|| (layer.values[n as usize], layer.stations[n as usize]))
    }

    pub fn at(&self, idx: usize) -> Conditions {
        Conditions {
            air_c: self.value(CondParam::AirC, idx),
            lst_c: self.value(CondParam::LstC, idx),
            sst_c: self.value(CondParam::SstC, idx),
            stage_m: self.value(CondParam::StageM, idx),
            wave_m: self.value(CondParam::WaveM, idx),
            wind_ms: self.value(CondParam::WindMs, idx),
            month: self.month,
        }
    }
}

type NearestCache = Mutex<HashMap<(CondParam, Vec<u32>), Arc<Vec<u32>>>>;

/// Everything needed to score any time in `[from, to)` on one region's grid without touching
/// the database.
pub struct Snapshot {
    pub grid: Grid,
    /// The app's focus taxa in frame order; `taxon_id` resolved against the database.
    pub taxa: Vec<Taxon>,
    /// Every in-grid sighting with `observed_at < to`, duplicates included, sorted by time.
    pub sightings: Vec<SightingPt>,
    /// Non-duplicate decaying sightings per taxon, sorted by time.
    recent: Vec<Vec<SightingPt>>,
    /// Non-duplicate prior sightings observed at or after `from`, per taxon, sorted by time.
    prior_recent: Vec<Vec<SightingPt>>,
    /// Prior sightings observed before `from`, already splatted, per taxon.
    prior_grid: Vec<Vec<f32>>,
    /// (lat, lon) per station index.
    pub stations: Vec<(f64, f64)>,
    readings: [Vec<ReadingPt>; 6],
    kernel: Kernel,
    nearest_cache: NearestCache,
    /// Component scoring for apps `lionfish::enabled` (set by `load_app`); frames then carry
    /// `rankScore` instead of density × rules.
    pub lionfish: Option<Arc<super::lionfish::Index>>,
}

impl Snapshot {
    /// Build from rows already in memory (tests, golden file, benchmarks).
    pub fn new(
        grid: Grid,
        taxa: Vec<Taxon>,
        from: i64,
        to: i64,
        mut sightings: Vec<SightingPt>,
        stations: Vec<(f64, f64)>,
        mut readings: [Vec<ReadingPt>; 6],
    ) -> Snapshot {
        let kernel = Kernel::new();
        sightings.retain(|s| s.observed_at < to && s.col < grid.cols && s.row < grid.rows);
        sightings.sort_by_key(|s| (s.observed_at, s.id));
        let n = taxa.len();
        let mut recent: Vec<Vec<SightingPt>> = vec![Vec::new(); n];
        let mut prior_recent: Vec<Vec<SightingPt>> = vec![Vec::new(); n];
        let mut prior_grid: Vec<Vec<f32>> = (0..n).map(|_| vec![0f32; grid.cells()]).collect();
        for s in &sightings {
            if s.duplicate() {
                continue;
            }
            let Some(i) = taxa.iter().position(|t| t.taxon_id == s.taxon_id) else { continue };
            if !s.prior {
                recent[i].push(s.clone());
            } else if s.observed_at >= from {
                prior_recent[i].push(s.clone());
            } else {
                kernel.splat(&grid, &mut prior_grid[i], s.col, s.row, PRIOR_WEIGHT);
            }
        }
        for r in readings.iter_mut() {
            r.retain(|p| (p.station as usize) < stations.len());
            r.sort_by_key(|p| p.observed_at);
        }
        Snapshot {
            grid,
            taxa,
            sightings,
            recent,
            prior_recent,
            prior_grid,
            stations,
            readings,
            kernel,
            nearest_cache: Mutex::new(HashMap::new()),
            lionfish: None,
        }
    }

    /// [`Snapshot::load`] for one of the app's regions, with the lionfish component index when
    /// the app scores by components (`lionfish::enabled`).
    pub async fn load_app(db: &Db, app: &App, region: &crate::app::config::Region, from: i64, to: i64) -> anyhow::Result<Snapshot> {
        let mut snap = Snapshot::load(db, &app.taxa, region.grid, from, to).await?;
        if super::lionfish::enabled(app) {
            let taxon = app.taxa.first().ok_or_else(|| anyhow::anyhow!("app {} has no taxon", app.id()))?;
            snap.lionfish = Some(Arc::new(super::lionfish::Index::load(db, app, region, taxon, from, to).await?));
        }
        Ok(snap)
    }

    /// The frame grid of `taxon` at `at` given the conditions: `rankScore` for a component app,
    /// density × activity × access otherwise.
    pub fn score_at(&self, taxon: &Taxon, at: i64, cond: &CondFrame) -> Vec<f32> {
        match &self.lionfish {
            Some(index) => index.frame(at, crate::ingest::quality_bio::DateBasis::Submitted, index.weights).rank(),
            None => self.apply_rules(taxon, self.density(taxon, at), cond),
        }
    }

    /// Load the window `[from, to)` from the observations db. Sightings before `to` are
    /// loaded when they can still contribute (history sources always, others within the
    /// longest decay window); readings from `from - STALE_MS` up to `to`.
    pub async fn load(db: &Db, taxa: &[Taxon], grid: Grid, from: i64, to: i64) -> anyhow::Result<Snapshot> {
        Snapshot::load_with(db, taxa, grid, from, to, "").await
    }

    /// Like `load`, but only the readings that can be current at a UTC day boundary (the
    /// last `STALE_MS` of each day). Backtests score at midnight, so a year-long window
    /// stays small even with dense satellite readings.
    pub async fn load_day_boundaries(db: &Db, taxa: &[Taxon], grid: Grid, from: i64, to: i64) -> anyhow::Result<Snapshot> {
        const FILTER: &str = "and (observed_at % 86400000 >= 64800000 or observed_at % 86400000 = 0)";
        const _: () = assert!(STALE_MS == 86_400_000 - 64_800_000 && DAY_MS == 86_400_000);
        Snapshot::load_with(db, taxa, grid, from, to, FILTER).await
    }

    async fn load_with(
        db: &Db,
        taxa: &[Taxon],
        grid: Grid,
        from: i64,
        to: i64,
        reading_filter: &'static str,
    ) -> anyhow::Result<Snapshot> {
        let max_hl = taxa.iter().map(|t| t.half_life_days()).fold(0.0, f64::max);
        let decay_floor = from - (DECAY_WINDOW_HALF_LIVES * max_hl * DAY_MS as f64) as i64;
        let (west, south, east, north) = (grid.west, grid.south, grid.east(), grid.north());
        let rows = db
            .read(move |c| {
                let mut st = c.prepare(
                    "select id, source_id, taxon_id, lat, lon, observed_at, quality, canonical_id is not null, conflict, \
                     ingested_at from sightings \
                     where observed_at < ?1 and (observed_at >= ?2 or source_id in ('nas', 'gbif')) \
                     and lat >= ?3 and lat < ?4 and lon >= ?5 and lon < ?6 order by observed_at, id",
                )?;
                let rows = st
                    .query_map(rusqlite::params![to, decay_floor, south, north, west, east], |r| {
                        Ok((
                            r.get::<_, i64>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, i64>(2)?,
                            r.get::<_, f64>(3)?,
                            r.get::<_, f64>(4)?,
                            r.get::<_, i64>(5)?,
                            r.get::<_, String>(6)?,
                            r.get::<_, bool>(7)?,
                            r.get::<_, i64>(8)?,
                            r.get::<_, i64>(9)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await?;
        let sightings = rows
            .into_iter()
            .filter_map(|(id, source, taxon_id, lat, lon, observed_at, quality, dup, conflict, ingested_at)| {
                let (col, row) = grid.col_row(lon, lat)?;
                let mut flags = 0u8;
                if dup {
                    flags |= FLAG_DUPLICATE;
                }
                if conflict != 0 {
                    flags |= FLAG_CONFLICT;
                }
                if ingested_at - observed_at > LATE_MS {
                    flags |= FLAG_LATE;
                }
                Some(SightingPt {
                    id,
                    taxon_id,
                    lon: lon as f32,
                    lat: lat as f32,
                    col,
                    row,
                    observed_at,
                    prior: PRIOR_SOURCES.contains(&source.as_str()),
                    quality: quality_code(&quality),
                    flags,
                })
            })
            .collect();

        let stations: Vec<(i64, f64, f64)> = db
            .read(|c| {
                let mut st = c.prepare("select id, lat, lon from stations order by id")?;
                let rows = st
                    .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?, r.get::<_, f64>(2)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await?;
        let station_index: HashMap<i64, u32> = stations.iter().enumerate().map(|(i, s)| (s.0, i as u32)).collect();
        let station_pts: Vec<(f64, f64)> = stations.iter().map(|s| (s.1, s.2)).collect();

        let reading_from = from - STALE_MS;
        let raw = db
            .read(move |c| {
                let mut st = c.prepare(&format!(
                    "select station_id, param, value, flag, observed_at from readings \
                     where param in ('air_c', 'lst_c', 'sst_c', 'stage_m', 'wave_m', 'wind_ms') \
                     and observed_at > ?1 and observed_at < ?2 {reading_filter} \
                     order by observed_at, case origin when 'modeled' then 0 when 'satellite' then 1 else 2 end"
                ))?;
                let rows = st
                    .query_map(rusqlite::params![reading_from, to], |r| {
                        Ok((
                            r.get::<_, i64>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, Option<f64>>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, i64>(4)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await?;
        let mut readings: [Vec<ReadingPt>; 6] = Default::default();
        for (station_id, param, value, flag, observed_at) in raw {
            let (Some(&station), Some(p)) = (station_index.get(&station_id), CondParam::parse(&param)) else {
                continue;
            };
            let value = match (value, flag.as_str()) {
                (Some(v), "ok") => v as f32,
                _ => f32::NAN,
            };
            readings[p as usize].push(ReadingPt { station, observed_at, value });
        }
        Ok(Snapshot::new(grid, taxa.to_vec(), from, to, sightings, station_pts, readings))
    }

    /// Kernel density of `taxon` at `at`, normalised to 0..1.
    pub fn density(&self, taxon: &Taxon, at: i64) -> Vec<f32> {
        let i = taxon.idx as usize;
        let mut acc = self.prior_grid[i].clone();
        let prior_end = self.prior_recent[i].partition_point(|s| s.observed_at < at);
        for s in &self.prior_recent[i][..prior_end] {
            self.kernel.splat(&self.grid, &mut acc, s.col, s.row, PRIOR_WEIGHT);
        }
        let hl_ms = taxon.half_life_days() * DAY_MS as f64;
        let window = (DECAY_WINDOW_HALF_LIVES * hl_ms) as i64;
        let recent = &self.recent[i];
        let lo = recent.partition_point(|s| s.observed_at < at - window);
        let hi = recent.partition_point(|s| s.observed_at < at);
        for s in &recent[lo..hi] {
            let age = (at - s.observed_at) as f64;
            let w = 0.5f64.powf(age / hl_ms) as f32;
            self.kernel.splat(&self.grid, &mut acc, s.col, s.row, w);
        }
        let max = acc.iter().copied().fold(0f32, f32::max);
        if max > 0.0 {
            // Divide rather than multiply by the reciprocal so the peak is exactly 1.0.
            acc.iter_mut().for_each(|v| *v /= max);
        }
        acc
    }

    /// Conditions at `at` for every cell.
    pub fn conditions(&self, at: i64) -> CondFrame {
        let month = chrono::DateTime::from_timestamp_millis(at).map(|d| d.month()).unwrap_or(1);
        let layers = CondParam::ALL.map(|p| self.layer(p, at));
        CondFrame { month, layers }
    }

    /// Stations that reported `p` in the `STALE_MS` up to `at` with flagged values only (cloud,
    /// bad DQF, missing): there, but with nothing usable. Sorted by station index.
    pub fn flagged_stations(&self, p: CondParam, at: i64) -> Vec<u32> {
        let readings = &self.readings[p as usize];
        let lo = readings.partition_point(|r| r.observed_at <= at - STALE_MS);
        let hi = readings.partition_point(|r| r.observed_at <= at);
        let mut any_valid: HashMap<u32, bool> = HashMap::new();
        for r in &readings[lo..hi] {
            *any_valid.entry(r.station).or_insert(false) |= !r.value.is_nan();
        }
        let mut out: Vec<u32> = any_valid.into_iter().filter(|&(_, valid)| !valid).map(|(s, _)| s).collect();
        out.sort_unstable();
        out
    }

    fn layer(&self, p: CondParam, at: i64) -> Option<CondLayer> {
        let readings = &self.readings[p as usize];
        let lo = readings.partition_point(|r| r.observed_at <= at - STALE_MS);
        let hi = readings.partition_point(|r| r.observed_at <= at);
        // Latest valid reading per station; the query order puts measured last on ties.
        let mut latest: Vec<Option<(i64, f32)>> = vec![None; self.stations.len()];
        for r in &readings[lo..hi] {
            if r.value.is_nan() {
                continue;
            }
            let slot = &mut latest[r.station as usize];
            if slot.is_none_or(|(t, _)| r.observed_at >= t) {
                *slot = Some((r.observed_at, r.value));
            }
        }
        let mut ids: Vec<u32> = Vec::new();
        let mut values: Vec<f32> = Vec::new();
        for (i, slot) in latest.iter().enumerate() {
            if let Some((_, v)) = slot {
                ids.push(i as u32);
                values.push(*v);
            }
        }
        if ids.is_empty() {
            return None;
        }
        let key = (p, ids.clone());
        let nearest = {
            let cache = self.nearest_cache.lock().expect("nearest cache");
            cache.get(&key).cloned()
        };
        let nearest = match nearest {
            Some(n) => n,
            None => {
                let pts: Vec<(f64, f64)> = key.1.iter().map(|&i| self.stations[i as usize]).collect();
                let n = Arc::new(nearest_index(&self.grid, &pts, p.max_cells()));
                let mut cache = self.nearest_cache.lock().expect("nearest cache");
                if cache.len() >= 64 {
                    cache.clear();
                }
                cache.insert(key, n.clone());
                n
            }
        };
        Some(CondLayer { nearest, values, stations: ids })
    }

    /// density × activity × access for every cell, given a density grid and the conditions.
    pub fn apply_rules(&self, taxon: &Taxon, mut density: Vec<f32>, cond: &CondFrame) -> Vec<f32> {
        let set = taxon.rules();
        let cols = self.grid.cols as usize;
        density.par_chunks_mut(cols).enumerate().for_each(|(row, chunk)| {
            for (col, v) in chunk.iter_mut().enumerate() {
                if *v > 0.0 {
                    let c = cond.at(row * cols + col);
                    *v *= rules::multiplier(set.activity, &c) * rules::multiplier(set.access, &c);
                }
            }
        });
        density
    }

    pub fn score_grid(&self, taxon: &Taxon, at: i64) -> Vec<f32> {
        let cond = self.conditions(at);
        self.apply_rules(taxon, self.density(taxon, at), &cond)
    }

    /// Each term's contribution at one cell.
    pub fn explain_cell(&self, taxon: &Taxon, at: i64, idx: usize) -> Explain {
        let density = self.density(taxon, at)[idx];
        let cond = self.conditions(at).at(idx);
        let mut terms = vec![Term {
            name: "density".into(),
            value: density,
            rationale: format!(
                "kernel-weighted {} sightings (Gaussian σ {} cells, half-life {} d, nas/gbif history at {} weight), \
                 normalised to the frame maximum",
                taxon.id(),
                SIGMA_CELLS,
                taxon.half_life_days(),
                PRIOR_WEIGHT
            ),
        }];
        let mut score = density;
        let set = taxon.rules();
        for (kind, rules) in [("activity", set.activity), ("access", set.access)] {
            for rule in rules {
                let (value, rationale) = match (rule.applies)(&cond) {
                    Some(v) => (v, rule.rationale.to_string()),
                    None => (1.0, format!("no data: inputs missing at this cell, neutral 1.0 ({})", rule.rationale)),
                };
                score *= value;
                terms.push(Term { name: format!("{kind}.{}", rule.name), value, rationale });
            }
        }
        terms.push(Term { name: "conditions".into(), value: 1.0, rationale: describe_conditions(&cond) });
        Explain { score, terms }
    }

    /// Cells of a score grid inside `bbox` (by centre), best first. `cell` is the grid-local
    /// `<col>:<row>`; callers prefix the region (`App::cell_id`).
    pub fn top_cells(&self, scores: &[f32], bbox: Option<&BBox>, top: usize) -> Vec<Cell> {
        let mut cells: Vec<(usize, f32)> = scores
            .iter()
            .copied()
            .enumerate()
            .filter(|&(i, s)| {
                s > 0.0
                    && bbox.is_none_or(|b| {
                        let (lon, lat) = self.grid.center(i);
                        lon >= b.west && lon < b.east && lat >= b.south && lat < b.north
                    })
            })
            .collect();
        cells.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
        cells
            .into_iter()
            .take(top)
            .map(|(i, score)| {
                let (lon, lat) = self.grid.center(i);
                Cell { cell: self.grid.cell_id(i), lat, lon, score }
            })
            .collect()
    }
}

fn describe_conditions(c: &Conditions) -> String {
    let show = |name: &str, v: Option<f32>| match v {
        Some(v) => format!("{name} {v:.1}"),
        None => format!("{name} no data"),
    };
    format!(
        "{}, {}, {}, {}, {}, {}, month {}",
        show("air_c", c.air_c),
        show("lst_c", c.lst_c),
        show("sst_c", c.sst_c),
        show("stage_m", c.stage_m),
        show("wave_m", c.wave_m),
        show("wind_ms", c.wind_ms),
        c.month
    )
}

/// For every cell, the index of the nearest point (in cell units) within `max_cells`, or
/// `u32::MAX`. Points are bucketed on a coarse grid and searched ring by ring, so it is
/// linear in cells for both a handful of buoys and a dense satellite grid.
pub fn nearest_index(grid: &Grid, pts: &[(f64, f64)], max_cells: u32) -> Vec<u32> {
    const B: i64 = 10;
    let cells = grid.cells();
    if pts.is_empty() {
        return vec![u32::MAX; cells];
    }
    let cols = grid.cols as i64;
    let bc = grid.cols.div_ceil(B as u32) as i64;
    let br = grid.rows.div_ceil(B as u32) as i64;
    let fpts: Vec<(f64, f64)> = pts.iter().map(|&(lat, lon)| grid.frac(lon, lat)).collect();
    let mut buckets: Vec<Vec<u32>> = vec![Vec::new(); (bc * br) as usize];
    for (i, &(fc, fr)) in fpts.iter().enumerate() {
        let bx = ((fc / B as f64).floor() as i64).clamp(0, bc - 1);
        let by = ((fr / B as f64).floor() as i64).clamp(0, br - 1);
        buckets[(by * bc + bx) as usize].push(i as u32);
    }
    // A hair of slack so a station exactly `max_cells` away (a common case on cell centres)
    // is not lost to float rounding in the degree-to-cell conversion.
    let max_d2 = (max_cells as f64) * (max_cells as f64) + 1e-6;
    let max_ring = (bc.max(br)) + 1;
    let mut out = vec![u32::MAX; cells];
    // Sequential on purpose: callers run this inside `OnceLock::get_or_init` from rayon workers, and a parallel body
    // there lets the initialising thread steal a job that blocks on the same lock (deadlock seen in L5 + UL).
    out.chunks_mut(cols as usize).enumerate().for_each(|(row, chunk)| {
        let by0 = row as i64 / B;
        for (col, slot) in chunk.iter_mut().enumerate() {
            let bx0 = col as i64 / B;
            let (cx, cy) = (col as f64 + 0.5, row as f64 + 0.5);
            let mut best = (f64::INFINITY, u32::MAX);
            for r in 0..=max_ring {
                // Every point in ring r sits at least (r - 1) buckets away.
                let bound = ((r - 1).max(0) * B) as f64;
                if best.0 <= bound * bound || bound * bound > max_d2 {
                    break;
                }
                let mut any = false;
                for by in (by0 - r)..=(by0 + r) {
                    if by < 0 || by >= br {
                        continue;
                    }
                    let edge_row = by == by0 - r || by == by0 + r;
                    let mut bx = bx0 - r;
                    while bx <= bx0 + r {
                        if bx >= 0 && bx < bc {
                            any = true;
                            for &i in &buckets[(by * bc + bx) as usize] {
                                let (fc, fr) = fpts[i as usize];
                                let d2 = (fc - cx) * (fc - cx) + (fr - cy) * (fr - cy);
                                if d2 < best.0 {
                                    best = (d2, i);
                                }
                            }
                        }
                        bx += if edge_row || r == 0 { 1 } else { 2 * r };
                    }
                }
                if !any && r > 0 {
                    break;
                }
            }
            if best.0 <= max_d2 {
                *slot = best.1;
            }
        }
    });
    out
}

#[derive(Debug, Clone, PartialEq)]
pub struct Term {
    pub name: String,
    pub value: f32,
    pub rationale: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Explain {
    pub score: f32,
    pub terms: Vec<Term>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Cell {
    /// Cell id (PLAN.md C14): `<col>:<row>`, prefixed with the region in multi-region apps.
    pub cell: String,
    pub lat: f64,
    pub lon: f64,
    pub score: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BBox {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

impl From<crate::app::config::BBox> for BBox {
    fn from(b: crate::app::config::BBox) -> Self {
        BBox { west: b.west, south: b.south, east: b.east, north: b.north }
    }
}

pub const DEFAULT_TOP: usize = 100;

/// Ranked cells of `taxon` at `at` inside `bbox` across every region the box touches
/// (GraphQL `hotspots`). Cell ids carry the region in multi-region apps.
pub async fn hotspots(db: &Db, app: &App, taxon: &Taxon, at: i64, bbox: BBox, top: Option<usize>) -> anyhow::Result<Vec<Cell>> {
    let top = top.unwrap_or(DEFAULT_TOP);
    let mut out: Vec<Cell> = Vec::new();
    let query = crate::app::config::BBox { west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north };
    for region in app.regions.iter().filter(|r| r.bbox().intersects(&query)) {
        let snap = Snapshot::load(db, &app.taxa, region.grid, at, at + 1).await?;
        let taxon = taxon.clone();
        let cells = tokio::task::spawn_blocking(move || {
            let scores = snap.score_grid(&taxon, at);
            snap.top_cells(&scores, Some(&bbox), top)
        })
        .await?;
        out.extend(cells.into_iter().map(|c| {
            let idx = region.grid.parse_cell(&c.cell).expect("own cell id");
            Cell { cell: app.cell_id(region, idx), ..c }
        }));
    }
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal).then(a.cell.cmp(&b.cell)));
    out.truncate(top);
    Ok(out)
}

/// Each term of the score at one cell (GraphQL `explainCell`). `cell` is an `App::cell_id`.
pub async fn explain(db: &Db, app: &App, cell: &str, taxon: &Taxon, at: i64) -> anyhow::Result<Explain> {
    let (region, idx) = app.parse_cell(cell).ok_or_else(|| anyhow::anyhow!("bad cell id {cell:?}; expected {}", app.cell_shape()))?;
    let snap = Snapshot::load(db, &app.taxa, region.grid, at, at + 1).await?;
    let taxon = taxon.clone();
    Ok(tokio::task::spawn_blocking(move || snap.explain_cell(&taxon, at, idx)).await?)
}

/// Seeding helpers shared by the hotspot, frames and backtest tests.
#[cfg(test)]
pub mod testkit {
    use crate::app::config::App;
    use crate::db::Db;

    pub const HOUR: i64 = 3_600_000;
    pub const DAY: i64 = super::DAY_MS;

    /// Unix ms of a UTC date and hour.
    pub fn ms(y: i32, m: u32, d: u32, h: u32) -> i64 {
        chrono::NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(h, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp_millis()
    }

    /// The python app with its taxa resolved to the migration's seeded ids (1-4, config order),
    /// for tests that open a bare `Db::memory("observations")` instead of an `AppState`.
    pub fn python_app() -> App {
        let mut app = App::builtin("python").unwrap();
        for t in &mut app.taxa {
            t.taxon_id = t.idx as i64 + 1;
        }
        app
    }

    pub async fn seed_sources(db: &Db) {
        db.write(|tx| {
            for (id, mode) in [
                ("inat", "poll"),
                ("nas", "poll"),
                ("gbif", "poll"),
                ("nws", "poll"),
                ("ndbc", "poll"),
                ("usgs", "poll"),
                ("goes19", "push"),
                ("test", "poll"),
            ] {
                tx.execute(
                    "insert or ignore into sources (id, name, homepage, mode, cadence_s, max_latency_s) \
                     values (?1, ?1, 'https://example.test', ?2, 3600, 7200)",
                    rusqlite::params![id, mode],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
    }

    pub async fn insert_station(db: &Db, source: &str, ext_id: &str, lat: f64, lon: f64, kind: &str) -> i64 {
        let (source, ext_id, kind) = (source.to_string(), ext_id.to_string(), kind.to_string());
        db.write(move |tx| {
            tx.execute(
                "insert into stations (source_id, ext_id, name, lat, lon, kind) values (?1, ?2, ?2, ?3, ?4, ?5)",
                rusqlite::params![source, ext_id, lat, lon, kind],
            )?;
            Ok(tx.last_insert_rowid())
        })
        .await
        .unwrap()
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn insert_sighting(
        db: &Db,
        source: &str,
        taxon_id: i64,
        lat: f64,
        lon: f64,
        observed_at: i64,
        quality: &str,
        canonical_id: Option<i64>,
    ) -> i64 {
        let (source, quality) = (source.to_string(), quality.to_string());
        db.write(move |tx| {
            let ext: i64 = tx.query_row("select coalesce(max(id), 0) + 1 from sightings", [], |r| r.get(0))?;
            tx.execute(
                "insert into sightings (source_id, ext_id, taxon_id, lat, lon, observed_at, quality, canonical_id, ingested_at) \
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?6)",
                rusqlite::params![source, ext.to_string(), taxon_id, lat, lon, observed_at, quality, canonical_id],
            )?;
            Ok(tx.last_insert_rowid())
        })
        .await
        .unwrap()
    }

    /// `(station_id, param, value, observed_at)`; a None value is stored with flag `missing`.
    pub async fn insert_readings(db: &Db, rows: Vec<(i64, &'static str, Option<f64>, i64)>) {
        db.write(move |tx| {
            let mut st = tx.prepare(
                "insert or replace into readings (station_id, param, value, flag, observed_at, origin) \
                 values (?1, ?2, ?3, ?4, ?5, 'measured')",
            )?;
            for (station, param, value, at) in rows {
                let flag = if value.is_some() { "ok" } else { "missing" };
                st.execute(rusqlite::params![station, param, value, flag, at])?;
            }
            Ok(())
        })
        .await
        .unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::*;
    use super::*;
    use crate::hotspot::rules::{
        IGUANA_COLD_STUN_BOOST, LIONFISH_NO_ACCESS, PYTHON_COLD_SUPPRESS, PYTHON_WARM_BOOST, TEGU_BRUMATION_SUPPRESS,
    };

    /// A 40 × 30 grid off the south-west corner of the region.
    const G: Grid = Grid { west: -81.0, south: 25.0, cell_deg: 0.01, cols: 40, rows: 30 };

    fn at_cell(col: u32, row: u32) -> (f64, f64) {
        (G.south + (row as f64 + 0.5) * G.cell_deg, G.west + (col as f64 + 0.5) * G.cell_deg)
    }

    async fn db() -> Db {
        let db = Db::memory("observations");
        seed_sources(&db).await;
        db
    }

    fn kernel_at(dx: i32, dy: i32) -> f32 {
        (-((dx * dx + dy * dy) as f64) / 8.0).exp() as f32
    }

    async fn load(db: &Db, grid: Grid, from: i64, to: i64) -> Snapshot {
        Snapshot::load(db, &python_app().taxa, grid, from, to).await.unwrap()
    }

    #[tokio::test]
    async fn hotspot_density_kernel_and_decay() {
        let db = db().await;
        let app = python_app();
        let t = ms(2025, 7, 10, 12);
        let (lat, lon) = at_cell(10, 10);
        // Tegu at (10,10) now, another at (30,10) one half-life (14 d) earlier: weights 1 and 0.5.
        insert_sighting(&db, "inat", 2, lat, lon, t - HOUR, "research", None).await;
        let (lat2, lon2) = at_cell(30, 10);
        insert_sighting(&db, "inat", 2, lat2, lon2, t - HOUR - 14 * DAY, "research", None).await;
        let snap = load(&db, G, t, t + 1).await;
        let d = snap.density(app.taxon("tegu").unwrap(), t);
        assert_eq!(d[G.index(10, 10)], 1.0);
        assert!((d[G.index(11, 10)] - kernel_at(1, 0)).abs() < 1e-5, "one cell east: exp(-1/8)");
        assert!((d[G.index(12, 12)] - kernel_at(2, 2)).abs() < 1e-5);
        assert_eq!(d[G.index(17, 10)], 0.0, "outside 3 sigma");
        let w1 = 0.5f64.powf(HOUR as f64 / (14.0 * DAY as f64));
        let w2 = 0.5f64.powf((HOUR + 14 * DAY) as f64 / (14.0 * DAY as f64));
        assert!((d[G.index(30, 10)] - (w2 / w1) as f32).abs() < 1e-5, "one half-life old: half weight");
        // Python sees nothing.
        assert!(snap.density(app.taxon("python").unwrap(), t).iter().all(|&v| v == 0.0));
    }

    #[tokio::test]
    async fn hotspot_prior_and_duplicates() {
        let db = db().await;
        let app = python_app();
        let t = ms(2025, 7, 10, 12);
        let (lat, lon) = at_cell(5, 5);
        insert_sighting(&db, "inat", 1, lat, lon, t - HOUR, "research", None).await;
        let (lat2, lon2) = at_cell(30, 20);
        // Old NAS history: static 0.2 prior, no decay even after three years.
        insert_sighting(&db, "nas", 1, lat2, lon2, t - 1100 * DAY, "curated", None).await;
        // A duplicate of the first sighting is skipped.
        insert_sighting(&db, "gbif", 1, lat, lon, t - HOUR, "research", Some(1)).await;
        let snap = load(&db, G, t, t + 1).await;
        let d = snap.density(app.taxon("python").unwrap(), t);
        let w_recent = 0.5f64.powf(HOUR as f64 / (21.0 * DAY as f64)) as f32;
        assert_eq!(d[G.index(5, 5)], 1.0);
        assert!((d[G.index(30, 20)] - PRIOR_WEIGHT / w_recent).abs() < 1e-5);
        assert_eq!(snap.sightings.len(), 3, "the index keeps duplicates, flagged");
        assert_eq!(snap.sightings.iter().filter(|s| s.duplicate()).count(), 1);
    }

    #[tokio::test]
    async fn hotspot_iguana_cold_stun() {
        let db = db().await;
        let app = python_app();
        let iguana = app.taxon("iguana").unwrap();
        let t = ms(2025, 1, 22, 11);
        let (lat, lon) = at_cell(20, 15);
        insert_sighting(&db, "inat", 3, lat, lon, t - 2 * HOUR, "research", None).await;
        let st = insert_station(&db, "nws", "KMIA", lat + 0.02, lon, "grid").await;
        insert_readings(&db, vec![(st, "air_c", Some(7.5), t - HOUR)]).await;
        let snap = load(&db, G, t, t + 1).await;
        let idx = G.index(20, 15);
        let scores = snap.score_grid(iguana, t);
        assert_eq!(scores[idx], 1.0 * IGUANA_COLD_STUN_BOOST * 1.0);
        let ex = snap.explain_cell(iguana, t, idx);
        assert_eq!(ex.score, IGUANA_COLD_STUN_BOOST);
        let stun = ex.terms.iter().find(|x| x.name == "activity.iguana_cold_stun_easy_capture_window").unwrap();
        assert_eq!(stun.value, IGUANA_COLD_STUN_BOOST);
        assert!(stun.rationale.contains("easy capture window"));
        // Product of the terms equals the score.
        let product: f32 = ex.terms.iter().map(|x| x.value).product();
        assert!((product - ex.score).abs() < 1e-6);
        // A warm reading later removes the boost.
        insert_readings(&db, vec![(st, "air_c", Some(24.0), t + HOUR)]).await;
        let snap = load(&db, G, t + 2 * HOUR, t + 2 * HOUR + 1).await;
        let ex = snap.explain_cell(iguana, t + 2 * HOUR, idx);
        let stun = ex.terms.iter().find(|x| x.name.ends_with("cold_stun_easy_capture_window")).unwrap();
        assert_eq!(stun.value, 1.0);
    }

    #[tokio::test]
    async fn hotspot_lionfish_no_access_waves() {
        let db = db().await;
        let app = python_app();
        let lionfish = app.taxon("lionfish").unwrap();
        let t = ms(2025, 8, 3, 15);
        let (lat, lon) = at_cell(8, 8);
        insert_sighting(&db, "inat", 4, lat, lon, t - 3 * HOUR, "research", None).await;
        let buoy = insert_station(&db, "ndbc", "41114", lat - 0.03, lon + 0.05, "buoy").await;
        insert_readings(&db, vec![(buoy, "wave_m", Some(2.1), t - HOUR), (buoy, "wind_ms", Some(4.0), t - HOUR)]).await;
        let snap = load(&db, G, t, t + 1).await;
        let idx = G.index(8, 8);
        let scores = snap.score_grid(lionfish, t);
        assert!((scores[idx] - LIONFISH_NO_ACCESS).abs() < 1e-6, "rough seas: 1.0 × 1.0 × 0.1");
        let ex = snap.explain_cell(lionfish, t, idx);
        let sea = ex.terms.iter().find(|x| x.name == "access.lionfish_sea_state").unwrap();
        assert_eq!(sea.value, LIONFISH_NO_ACCESS);
        let base = ex.terms.iter().find(|x| x.name == "activity.lionfish_year_round").unwrap();
        assert_eq!(base.value, 1.0);
        // Calm seas an hour later: full access.
        insert_readings(&db, vec![(buoy, "wave_m", Some(0.6), t + HOUR)]).await;
        let snap = load(&db, G, t + HOUR, t + HOUR + 1).await;
        let scores = snap.score_grid(lionfish, t + HOUR);
        assert!((scores[idx] - 1.0).abs() < 1e-6);
    }

    #[tokio::test]
    async fn hotspot_python_cold_and_stage() {
        let db = db().await;
        let app = python_app();
        let python = app.taxon("python").unwrap();
        let t = ms(2025, 12, 5, 6);
        let (lat, lon) = at_cell(25, 12);
        insert_sighting(&db, "inat", 1, lat, lon, t - HOUR, "research", None).await;
        let nws = insert_station(&db, "nws", "KTMB", lat, lon - 0.01, "grid").await;
        let gage = insert_station(&db, "usgs", "S12A", lat + 0.01, lon, "gage").await;
        insert_readings(&db, vec![(nws, "air_c", Some(12.0), t - HOUR), (gage, "stage_m", Some(2.0), t - HOUR)]).await;
        let snap = load(&db, G, t, t + 1).await;
        let idx = G.index(25, 12);
        let s = snap.score_grid(python, t);
        assert!((s[idx] - PYTHON_COLD_SUPPRESS * 0.9).abs() < 1e-6, "12 °C suppresses, 2 m stage gives 0.9");
        // Warm and no stage data: 1.5 × neutral 1.0, and the explain says so.
        insert_readings(&db, vec![(nws, "air_c", Some(26.0), t + 3 * HOUR)]).await;
        let t2 = t + 8 * HOUR; // the stage reading is now stale (> 6 h), the air reading is 5 h old
        let snap = load(&db, G, t2, t2 + 1).await;
        let ex = snap.explain_cell(python, t2, idx);
        let stage = ex.terms.iter().find(|x| x.name == "access.python_levee_stage").unwrap();
        assert_eq!(stage.value, 1.0);
        assert!(stage.rationale.starts_with("no data"));
        let warm = ex.terms.iter().find(|x| x.name == "activity.python_warm_temperature").unwrap();
        assert_eq!(warm.value, PYTHON_WARM_BOOST);
        let expect = snap.density(python, t2)[idx] * PYTHON_WARM_BOOST;
        assert!((ex.score - expect).abs() < 1e-6);
    }

    #[tokio::test]
    async fn hotspot_tegu_brumation_and_ranking() {
        let db = db().await;
        let app = python_app();
        let tegu = app.taxon("tegu").unwrap();
        let t = ms(2025, 11, 20, 9);
        let (lat_a, lon_a) = at_cell(5, 5);
        let (lat_b, lon_b) = at_cell(35, 25);
        insert_sighting(&db, "inat", 2, lat_a, lon_a, t - HOUR, "research", None).await;
        insert_sighting(&db, "inat", 2, lat_b, lon_b, t - HOUR - 14 * DAY, "research", None).await;
        let snap = load(&db, G, t, t + 1).await;
        let s = snap.score_grid(tegu, t);
        let (ia, ib) = (G.index(5, 5), G.index(35, 25));
        assert!((s[ia] - TEGU_BRUMATION_SUPPRESS).abs() < 1e-6);
        let ratio = 0.5f64.powf((HOUR + 14 * DAY) as f64 / (14.0 * DAY as f64))
            / 0.5f64.powf(HOUR as f64 / (14.0 * DAY as f64));
        assert!((s[ib] - TEGU_BRUMATION_SUPPRESS * ratio as f32).abs() < 1e-5);
        let top = snap.top_cells(&s, None, 3);
        assert_eq!(top[0].cell, "5:5");
        assert!(top[0].score >= top[1].score && top[1].score >= top[2].score);
        let east_only = BBox { west: -80.8, south: 25.0, east: -80.6, north: 25.3 };
        let top = snap.top_cells(&s, Some(&east_only), 5);
        assert_eq!(top[0].cell, "35:25");
        assert!(top.iter().all(|c| c.lon >= -80.8));
        // May: no brumation.
        let t_may = ms(2025, 5, 20, 9);
        let snap = load(&db, G, t_may, t_may + 1).await;
        assert!(snap.score_grid(tegu, t_may).iter().all(|&v| v == 0.0), "nothing observed before May");
    }

    #[tokio::test]
    async fn hotspot_public_entry_points() {
        let db = db().await;
        let app = python_app();
        let lionfish = app.taxon("lionfish").unwrap();
        let t = ms(2025, 6, 1, 12);
        let g = app.regions[0].grid;
        let idx = g.index(120, 100);
        let (lon, lat) = g.center(idx);
        insert_sighting(&db, "inat", 4, lat, lon, t - HOUR, "research", None).await;
        let cells = hotspots(&db, &app, lionfish, t, app.hull().into(), Some(5)).await.unwrap();
        assert_eq!(cells.len(), 5);
        assert_eq!(cells[0].cell, "120:100");
        assert_eq!(cells[0].score, 1.0);
        let ex = explain(&db, &app, "120:100", lionfish, t).await.unwrap();
        assert_eq!(ex.score, 1.0);
        assert!(ex.terms.iter().any(|x| x.name == "access.lionfish_sea_state" && x.rationale.starts_with("no data")));
        assert!(explain(&db, &app, "999:1", lionfish, t).await.is_err());
        // A box touching no region ranks nothing.
        let far = BBox { west: 0.0, south: 0.0, east: 1.0, north: 1.0 };
        assert!(hotspots(&db, &app, lionfish, t, far, Some(5)).await.unwrap().is_empty());
    }

    /// Two regions: each gets its own snapshot, cells carry the region id, and the merged
    /// ranking is score-ordered across regions.
    #[tokio::test]
    async fn hotspot_multi_region_cells_carry_region_ids() {
        let db = db().await;
        let mut app = App::builtin("lionfish").unwrap();
        app.taxa[0].taxon_id = 4;
        let lionfish = &app.taxa[0];
        let t = ms(2025, 6, 1, 12);
        let (fl, mx) = (app.region("fl-keys").unwrap(), app.region("mx-caribbean").unwrap());
        let (lon_a, lat_a) = fl.grid.center(fl.grid.index(10, 10));
        let (lon_b, lat_b) = mx.grid.center(mx.grid.index(20, 30));
        insert_sighting(&db, "inat", 4, lat_a, lon_a, t - HOUR, "research", None).await;
        insert_sighting(&db, "inat", 4, lat_b, lon_b, t - 10 * DAY, "research", None).await;
        let cells = hotspots(&db, &app, lionfish, t, app.hull().into(), Some(4)).await.unwrap();
        assert_eq!(cells.len(), 4);
        assert_eq!(cells[0].cell, "fl-keys:10:10");
        assert_eq!(cells[0].score, 1.0);
        assert!(cells.iter().any(|c| c.cell == "mx-caribbean:20:30"), "{cells:?}");
        assert!(cells.iter().all(|c| c.score > 0.0));
        // Each region normalises its own density: the older Mexican sighting still peaks at 1.0 there.
        let only_mx = hotspots(&db, &app, lionfish, t, mx.bbox().into(), Some(1)).await.unwrap();
        assert_eq!((only_mx[0].cell.as_str(), only_mx[0].score), ("mx-caribbean:20:30", 1.0));
        let ex = explain(&db, &app, "mx-caribbean:20:30", lionfish, t).await.unwrap();
        assert_eq!(ex.score, 1.0);
        assert!(explain(&db, &app, "20:30", lionfish, t).await.is_err(), "region required");
    }

    #[test]
    fn hotspot_nearest_index_matches_brute_force() {
        let g = Grid { west: 0.0, south: 0.0, cell_deg: 1.0, cols: 37, rows: 23 };
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let pts: Vec<(f64, f64)> = (0..25).map(|_| (rnd() * 30.0 - 3.0, rnd() * 45.0 - 4.0)).collect();
        for max in [3u32, 12, 200] {
            let fast = nearest_index(&g, &pts, max);
            for (idx, &got) in fast.iter().enumerate() {
                let (lon, lat) = g.center(idx);
                let (cx, cy) = g.frac(lon, lat);
                let mut best = (f64::INFINITY, u32::MAX);
                for (i, &(plat, plon)) in pts.iter().enumerate() {
                    let (fc, fr) = g.frac(plon, plat);
                    let d2 = (fc - cx).powi(2) + (fr - cy).powi(2);
                    if d2 < best.0 {
                        best = (d2, i as u32);
                    }
                }
                let want = if best.0 <= (max * max) as f64 { best.1 } else { u32::MAX };
                assert_eq!(got, want, "cell {idx} max {max}");
            }
        }
        assert!(nearest_index(&g, &[], 5).iter().all(|&v| v == u32::MAX));
    }

    #[tokio::test]
    async fn hotspot_flagged_readings_are_no_data() {
        let db = db().await;
        let t = ms(2025, 3, 3, 3);
        let (lat, lon) = at_cell(3, 3);
        let st = insert_station(&db, "goes19", "cell-3-3", lat, lon, "goes_cell").await;
        insert_readings(&db, vec![(st, "lst_c", None, t - HOUR), (st, "sst_c", Some(25.5), t - HOUR)]).await;
        let snap = load(&db, G, t, t + 1).await;
        let cond = snap.conditions(t);
        assert_eq!(cond.value(CondParam::LstC, G.index(3, 3)), None, "flagged reading");
        assert_eq!(cond.value(CondParam::SstC, G.index(3, 3)), Some(25.5));
        assert_eq!(cond.value(CondParam::SstC, G.index(8, 3)), Some(25.5), "5 cells away still reads the pixel");
        assert_eq!(cond.value(CondParam::SstC, G.index(9, 3)), None, "6 cells is out of reach");
        assert_eq!(cond.value(CondParam::SstC, G.index(20, 20)), None);
        assert_eq!(cond.value(CondParam::WaveM, G.index(3, 3)), None, "no layer at all");
        assert_eq!(cond.month, 3);
    }
}
