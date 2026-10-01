//! Top-10% hit-rate backtest (T11, PRD section 8).
//!
//! For each UTC day D in the window, every region's grid is scored at D 00:00 using only data
//! observed before D. A sighting observed during D is a hit when its cell ranks in the top 10%
//! of its region's cells by score (and the score is above zero, so an empty grid never "hits").
//! The hit rate is hits over sightings across all days and regions, reported next to the 10%
//! chance baseline.

use rayon::prelude::*;

use super::score::{Snapshot, DAY_MS};
use crate::app::config::{App, Taxon};
use crate::db::Db;

pub const BASELINE: f64 = 0.1;
pub const TOP_SHARE: f64 = 0.1;

#[derive(Debug, Clone, PartialEq)]
pub struct BacktestDay {
    /// Start of the day, unix ms UTC.
    pub day: i64,
    pub sightings: u32,
    pub hits: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Backtest {
    /// The taxon's config id (`python`).
    pub species: String,
    pub days: u32,
    pub hit_rate: f64,
    pub baseline: f64,
    pub per_day: Vec<BacktestDay>,
    /// Days after each evaluation day in which a report counts (1 here; 7 for lionfish).
    pub horizon_days: u32,
    pub evaluated: u32,
    pub hits: u32,
    /// Regions with too little data to score (lionfish thin regions).
    pub insufficient_regions: Vec<String>,
    pub note: Option<String>,
}

pub fn floor_day(t: i64) -> i64 {
    t.div_euclid(DAY_MS) * DAY_MS
}

/// Score at or above which a cell is in the top `TOP_SHARE` of the grid. When fewer cells
/// than that have any score, the top set is the scored cells; a zero score never qualifies.
pub fn top_threshold(scores: &[f32]) -> f32 {
    let k = ((scores.len() as f64 * TOP_SHARE).ceil() as usize).clamp(1, scores.len());
    let mut sorted: Vec<f32> = scores.to_vec();
    let (_, kth, _) = sorted.select_nth_unstable_by(k - 1, |a, b| b.total_cmp(a));
    kth.max(f32::MIN_POSITIVE)
}

/// The last `days` full UTC days before `end_ms` (callers pass their app's clock,
/// `AppState::now_ms`).
pub async fn backtest_until(db: &Db, app: &App, taxon: &Taxon, days: u32, end_ms: i64) -> anyhow::Result<Backtest> {
    if super::lionfish::enabled(app) {
        return super::lionfish::backtest_until(db, app, taxon, days, end_ms).await;
    }
    anyhow::ensure!((1..=366).contains(&days), "days must be 1..=366, got {days}");
    let end_day = floor_day(end_ms);
    let from = end_day - days as i64 * DAY_MS;
    let mut per_day: Vec<BacktestDay> = (0..days as i64).map(|i| BacktestDay { day: from + i * DAY_MS, sightings: 0, hits: 0 }).collect();
    for region in &app.regions {
        let snap = Snapshot::load_day_boundaries(db, &app.taxa, region.grid, from, end_day).await?;
        let taxon = taxon.clone();
        let region_days = tokio::task::spawn_blocking(move || {
            (0..days as i64)
                .into_par_iter()
                .map(|i| {
                    let day = from + i * DAY_MS;
                    let scores = snap.score_grid(&taxon, day);
                    let threshold = top_threshold(&scores);
                    let (mut sightings, mut hits) = (0u32, 0u32);
                    for s in snap.sightings.iter().filter(|s| {
                        s.observed_at >= day && s.observed_at < day + DAY_MS && !s.duplicate() && s.taxon_id == taxon.taxon_id
                    }) {
                        sightings += 1;
                        let score = scores[snap.grid.index(s.col, s.row)];
                        if score >= threshold {
                            hits += 1;
                        }
                    }
                    (sightings, hits)
                })
                .collect::<Vec<_>>()
        })
        .await?;
        for (d, (s, h)) in per_day.iter_mut().zip(region_days) {
            d.sightings += s;
            d.hits += h;
        }
    }
    let total: u32 = per_day.iter().map(|d| d.sightings).sum();
    let hits: u32 = per_day.iter().map(|d| d.hits).sum();
    let hit_rate = if total == 0 { 0.0 } else { hits as f64 / total as f64 };
    Ok(Backtest {
        species: taxon.id().to_string(),
        days,
        hit_rate,
        baseline: BASELINE,
        per_day,
        horizon_days: 1,
        evaluated: total,
        hits,
        insufficient_regions: Vec::new(),
        note: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hotspot::score::testkit::*;

    #[test]
    fn backtest_threshold_is_tenth_percentile_and_ignores_zeros() {
        let mut scores = vec![0f32; 100];
        for (i, s) in scores.iter_mut().enumerate().take(20) {
            *s = (i + 1) as f32;
        }
        assert_eq!(top_threshold(&scores), 11.0, "10 of 100 cells: 20..=11");
        assert_eq!(top_threshold(&[0.0; 50]), f32::MIN_POSITIVE, "an empty grid has no hits");
        assert_eq!(top_threshold(&[0.0, 0.0, 3.0]), 3.0);
        let sparse: Vec<f32> = (0..1000).map(|i| if i < 5 { 0.5 } else { 0.0 }).collect();
        assert_eq!(top_threshold(&sparse), f32::MIN_POSITIVE, "fewer scored cells than 10%: all of them count");
    }

    #[tokio::test]
    async fn backtest_loads_day_boundary_readings() {
        use crate::hotspot::score::CondParam;
        let db = Db::memory("observations");
        seed_sources(&db).await;
        let app = python_app();
        let g = app.regions[0].grid;
        let d0 = floor_day(ms(2025, 4, 10, 0));
        let idx = g.index(100, 100);
        let (lon, lat) = g.center(idx);
        let st = insert_station(&db, "nws", "KMIA", lat, lon, "grid").await;
        // 12 °C an hour before day 1 counts; 30 °C at noon of day 0 is never a midnight condition.
        insert_readings(&db, vec![(st, "air_c", Some(30.0), d0 + 12 * HOUR), (st, "air_c", Some(12.0), d0 + DAY - HOUR)]).await;
        let snap = Snapshot::load_day_boundaries(&db, &app.taxa, g, d0, d0 + 2 * DAY).await.unwrap();
        assert_eq!(snap.conditions(d0 + DAY).value(CondParam::AirC, idx), Some(12.0));
        assert_eq!(snap.conditions(d0).value(CondParam::AirC, idx), None);
        assert_eq!(snap.conditions(d0 + 13 * HOUR).value(CondParam::AirC, idx), None, "noon reading not loaded");
        let full = Snapshot::load(&db, &app.taxa, g, d0, d0 + 2 * DAY).await.unwrap();
        assert_eq!(full.conditions(d0 + 13 * HOUR).value(CondParam::AirC, idx), Some(30.0));
    }

    #[tokio::test]
    async fn backtest_seeded_hit_rate() {
        let db = Db::memory("observations");
        seed_sources(&db).await;
        let app = python_app();
        let python = app.taxon("python").unwrap();
        let g = app.regions[0].grid;
        let d0 = floor_day(ms(2025, 4, 10, 0));
        let (lon_a, lat_a) = g.center(g.index(100, 100));
        let (lon_b, lat_b) = g.center(g.index(300, 300));
        // History: pythons at A on the two days before the window.
        insert_sighting(&db, "inat", 1, lat_a, lon_a, d0 - DAY + 5 * HOUR, "research", None).await;
        insert_sighting(&db, "inat", 1, lat_a, lon_a, d0 - 2 * DAY + 5 * HOUR, "research", None).await;
        // Day 0: one at A (hit), one at B where nothing was ever seen (miss), a duplicate (ignored).
        insert_sighting(&db, "inat", 1, lat_a, lon_a, d0 + 9 * HOUR, "research", None).await;
        insert_sighting(&db, "inat", 1, lat_b, lon_b, d0 + 10 * HOUR, "research", None).await;
        insert_sighting(&db, "gbif", 1, lat_a, lon_a, d0 + 9 * HOUR, "research", Some(3)).await;
        // Day 1: one next to A (hit, inside the kernel) and a lionfish row (another app's species, ignored).
        let (lon_c, lat_c) = g.center(g.index(102, 101));
        insert_sighting(&db, "inat", 1, lat_c, lon_c, d0 + DAY + HOUR, "research", None).await;
        insert_sighting(&db, "inat", 4, lat_b, lon_b, d0 + DAY + HOUR, "research", None).await;
        // Day 2: nothing.
        let bt = backtest_until(&db, &app, python, 3, d0 + 3 * DAY).await.unwrap();
        assert_eq!(bt.baseline, 0.1);
        assert_eq!(bt.days, 3);
        assert_eq!(bt.species, "python");
        assert_eq!(bt.per_day.len(), 3);
        assert_eq!(bt.per_day[0], BacktestDay { day: d0, sightings: 2, hits: 1 });
        assert_eq!(bt.per_day[1], BacktestDay { day: d0 + DAY, sightings: 1, hits: 1 });
        assert_eq!(bt.per_day[2], BacktestDay { day: d0 + 2 * DAY, sightings: 0, hits: 0 });
        assert!((bt.hit_rate - 2.0 / 3.0).abs() < 1e-9);
        assert_eq!((bt.horizon_days, bt.evaluated, bt.hits, bt.insufficient_regions.len(), bt.note), (1, 3, 2, 0, None));
        // No sightings at all: a measured zero, not an error.
        let empty = backtest_until(&db, &app, python, 2, d0 - 10 * DAY).await.unwrap();
        assert_eq!(empty.hit_rate, 0.0);
        assert!(empty.per_day.iter().all(|d| d.sightings == 0));
        assert!(backtest_until(&db, &app, python, 0, d0).await.is_err());
    }
}
