//! Conflict detection for physical readings (T8, PRD §7 "Data quality"). Runs inside the
//! ingest write transaction, after a payload's rows are upserted, over the changed rows'
//! `observed_at` window.
//!
//! Two disagreements set `readings.conflict = 1` on both rows of a pair:
//!
//! - **SST:** a satellite `sst_c` within [`SST_MAX_KM`] and ±1 h of a measured (buoy / C-MAN)
//!   `sst_c` that differs by more than [`SST_MAX_DIFF_C`]. GOES SST is a skin temperature
//!   retrieval; buoys read the bulk temperature at ~1 m, and a >1.5 °C gap is beyond normal
//!   skin/bulk and retrieval error.
//! - **LST vs air:** a satellite `lst_c` and a measured `air_c` in the same scoring cell of
//!   the same region (PLAN.md C14, C-A4) within ±1 h whose difference `lst - air` falls outside
//!   [`SKIN_OFFSET_C`]. Stations outside every region are in no cell and never pair.
//!   Land skin runs a few degrees below air at night (radiative cooling) and up to ~10-15 °C
//!   above it under full sun, so [-5, +15] °C is the plausible band; outside it one of the two
//!   is suspect (sub-pixel cloud, a wet or shaded sensor, a mislocated pixel).
//!
//! Only `flag = ok` rows with a value take part. Flags are recomputed, not only raised: a row
//! whose partner changed so the pair now agrees is cleared again. Rows whose partners can change
//! lie within 1 h of the window, so those are the rows re-evaluated; partners are searched 2 h
//! out.

use std::collections::HashSet;

use rusqlite::{params, Transaction};

use crate::app::config::App;

/// Pairing tolerance in time, ms.
pub const PAIR_WINDOW_MS: i64 = 3_600_000;
/// Satellite pixel to buoy distance, km.
pub const SST_MAX_KM: f64 = 5.0;
/// Allowed satellite vs buoy SST difference, °C.
pub const SST_MAX_DIFF_C: f64 = 1.5;
/// Plausible `lst - air` range, °C.
pub const SKIN_OFFSET_C: (f64, f64) = (-5.0, 15.0);

/// `(region, col, row)` of the scoring cell containing a point, or `None` outside every region.
/// The grid's own epsilon keeps cell centres and edges written as decimals (25.37 = 107 cells)
/// in the cell their decimal value names.
pub fn cell_of(app: &App, lat: f64, lon: f64) -> Option<(u8, u32, u32)> {
    let region = app.region_of(lat, lon)?;
    let (col, row) = region.grid.col_row(lon, lat)?;
    Some((region.idx, col, row))
}

/// Great-circle distance, km.
pub fn distance_km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dp = p2 - p1;
    let dl = (lon2 - lon1).to_radians();
    let a = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    6371.0088 * 2.0 * a.sqrt().asin()
}

/// The four kinds of reading that take part in conflict checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Kind {
    SatSst,
    BuoySst,
    SatLst,
    StationAir,
}

impl Kind {
    fn param_origin(self) -> (&'static str, &'static str) {
        match self {
            Kind::SatSst => ("sst_c", "satellite"),
            Kind::BuoySst => ("sst_c", "measured"),
            Kind::SatLst => ("lst_c", "satellite"),
            Kind::StationAir => ("air_c", "measured"),
        }
    }

    fn of(param: &str, origin: &str) -> Option<Kind> {
        match (param, origin) {
            ("sst_c", "satellite") => Some(Kind::SatSst),
            ("sst_c", "measured") => Some(Kind::BuoySst),
            ("lst_c", "satellite") => Some(Kind::SatLst),
            ("air_c", "measured") => Some(Kind::StationAir),
            _ => None,
        }
    }
}

/// A reading's primary key, reduced to what the checks need.
type Key = (i64, Kind, i64);

const KINDS_SQL: &str = "((r.param = 'sst_c' and r.origin in ('satellite', 'measured'))
    or (r.param = 'lst_c' and r.origin = 'satellite') or (r.param = 'air_c' and r.origin = 'measured'))";

pub fn post_write(tx: &Transaction, app: &App, source_id: &str, from_ms: i64, to_ms: i64) -> rusqlite::Result<()> {
    if !touches_checked_kinds(tx, source_id, from_ms, to_ms)? {
        return Ok(());
    }
    let (anchor_from, anchor_to) = (from_ms - 2 * PAIR_WINDOW_MS, to_ms + 2 * PAIR_WINDOW_MS);
    let mut conflicts: HashSet<Key> = HashSet::new();
    sst_conflicts(tx, anchor_from, anchor_to, &mut conflicts)?;
    lst_conflicts(tx, app, anchor_from, anchor_to, &mut conflicts)?;

    // Recompute: clear flags that no longer have a conflicting partner...
    let (eval_from, eval_to) = (from_ms - PAIR_WINDOW_MS, to_ms + PAIR_WINDOW_MS);
    let flagged: Vec<Key> = {
        let mut stmt = tx.prepare_cached(&format!(
            "select r.station_id, r.param, r.origin, r.observed_at from readings r
             where r.conflict = 1 and r.observed_at between ?1 and ?2 and {KINDS_SQL}"
        ))?;
        let rows = stmt.query_map(params![eval_from, eval_to], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (station, param, origin, at) = row?;
            if let Some(kind) = Kind::of(&param, &origin) {
                out.push((station, kind, at));
            }
        }
        out
    };
    let mut set = tx.prepare_cached(
        "update readings set conflict = ?5
         where station_id = ?1 and param = ?2 and observed_at = ?3 and origin = ?4 and conflict != ?5",
    )?;
    for key @ (station, kind, at) in flagged {
        if !conflicts.contains(&key) {
            let (param, origin) = kind.param_origin();
            set.execute(params![station, param, at, origin, 0])?;
        }
    }
    // ...and raise the current ones.
    for (station, kind, at) in &conflicts {
        let (param, origin) = kind.param_origin();
        set.execute(params![station, param, at, origin, 1])?;
    }
    Ok(())
}

/// Did this source write any reading of a checked kind in the window? Cheap guard so sources
/// that never take part (models, gages, alerts, sightings) skip the pair search.
fn touches_checked_kinds(tx: &Transaction, source_id: &str, from_ms: i64, to_ms: i64) -> rusqlite::Result<bool> {
    tx.prepare_cached(&format!(
        "select exists(select 1 from stations s join readings r on r.station_id = s.id
           where s.source_id = ?1 and r.param in ('sst_c', 'lst_c', 'air_c') and r.observed_at between ?2 and ?3
             and {KINDS_SQL})"
    ))?
    .query_row(params![source_id, from_ms, to_ms], |r| r.get(0))
}

/// Measured SST anchors in the window, each against satellite SST pixels within ~6 km (the box
/// prefilter) and ±1 h; the exact distance and difference are checked here.
fn sst_conflicts(tx: &Transaction, from: i64, to: i64, out: &mut HashSet<Key>) -> rusqlite::Result<()> {
    // 0.05° latitude = 5.6 km; 0.06° longitude >= 5.3 km anywhere in the region.
    let mut stmt = tx.prepare_cached(
        "select b.station_id, b.observed_at, b.value, bs.lat, bs.lon,
                s.station_id, s.observed_at, s.value, ss.lat, ss.lon
         from readings b
         join stations bs on bs.id = b.station_id
         join stations ss on ss.lat between bs.lat - 0.05 and bs.lat + 0.05
                         and ss.lon between bs.lon - 0.06 and bs.lon + 0.06
         join readings s on s.station_id = ss.id and s.param = 'sst_c' and s.origin = 'satellite'
                        and s.observed_at between b.observed_at - ?3 and b.observed_at + ?3
         where b.param = 'sst_c' and b.origin = 'measured' and b.observed_at between ?1 and ?2
           and b.flag = 'ok' and b.value is not null and s.flag = 'ok' and s.value is not null",
    )?;
    let rows = stmt.query_map(params![from, to, PAIR_WINDOW_MS], |r| {
        Ok((
            (r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, f64>(2)?, r.get::<_, f64>(3)?, r.get::<_, f64>(4)?),
            (r.get::<_, i64>(5)?, r.get::<_, i64>(6)?, r.get::<_, f64>(7)?, r.get::<_, f64>(8)?, r.get::<_, f64>(9)?),
        ))
    })?;
    for row in rows {
        let ((b_id, b_at, b_val, b_lat, b_lon), (s_id, s_at, s_val, s_lat, s_lon)) = row?;
        if distance_km(b_lat, b_lon, s_lat, s_lon) <= SST_MAX_KM && (s_val - b_val).abs() > SST_MAX_DIFF_C {
            out.insert((b_id, Kind::BuoySst, b_at));
            out.insert((s_id, Kind::SatSst, s_at));
        }
    }
    Ok(())
}

/// Measured air temperature anchors in the window against satellite LST in the same app cell
/// within ±1 h.
fn lst_conflicts(tx: &Transaction, app: &App, from: i64, to: i64, out: &mut HashSet<Key>) -> rusqlite::Result<()> {
    let mut stmt = tx.prepare_cached(
        "select a.station_id, a.observed_at, a.value, st.lat, st.lon,
                l.station_id, l.observed_at, l.value, ls.lat, ls.lon
         from readings a
         join stations st on st.id = a.station_id
         join stations ls on ls.lat between st.lat - 0.011 and st.lat + 0.011
                         and ls.lon between st.lon - 0.011 and st.lon + 0.011
         join readings l on l.station_id = ls.id and l.param = 'lst_c' and l.origin = 'satellite'
                        and l.observed_at between a.observed_at - ?3 and a.observed_at + ?3
         where a.param = 'air_c' and a.origin = 'measured' and a.observed_at between ?1 and ?2
           and a.flag = 'ok' and a.value is not null and l.flag = 'ok' and l.value is not null",
    )?;
    let rows = stmt.query_map(params![from, to, PAIR_WINDOW_MS], |r| {
        Ok((
            (r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, f64>(2)?, r.get::<_, f64>(3)?, r.get::<_, f64>(4)?),
            (r.get::<_, i64>(5)?, r.get::<_, i64>(6)?, r.get::<_, f64>(7)?, r.get::<_, f64>(8)?, r.get::<_, f64>(9)?),
        ))
    })?;
    let (lo, hi) = SKIN_OFFSET_C;
    for row in rows {
        let ((a_id, a_at, air, a_lat, a_lon), (l_id, l_at, lst, l_lat, l_lon)) = row?;
        let (Some(a_cell), Some(l_cell)) = (cell_of(app, a_lat, a_lon), cell_of(app, l_lat, l_lon)) else { continue };
        if a_cell != l_cell {
            continue;
        }
        let offset = lst - air;
        if !(lo..=hi).contains(&offset) {
            out.insert((a_id, Kind::StationAir, a_at));
            out.insert((l_id, Kind::SatLst, l_at));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use async_trait::async_trait;

    use super::*;
    use crate::app::test_support::test_state;
    use crate::ingest::scheduler::ingest_payload;
    use crate::ingest::source::{FetchCtx, Mode, RawPayload, Source, SourceInfo};
    use crate::model::*;
    use crate::state::AppState;

    /// Source whose payloads are JSON arrays of rows.
    struct Rows(&'static str);

    #[async_trait]
    impl Source for Rows {
        fn info(&self) -> SourceInfo {
            SourceInfo {
                id: self.0,
                name: self.0,
                homepage: "https://example.test",
                mode: Mode::Poll,
                cadence: Duration::from_secs(60),
                max_latency: Duration::from_secs(600),
            }
        }
        async fn fetch(&self, _ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
            Ok(vec![])
        }
        fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
            Ok(serde_json::from_slice(&raw.bytes)?)
        }
    }

    const T: i64 = 1_790_800_000_000;
    const MIN: i64 = 60_000;

    fn station(ext: &str, lat: f64, lon: f64, kind: StationKind) -> StationRef {
        StationRef { ext_id: ext.into(), name: ext.into(), lat, lon, kind }
    }

    fn r(st: &StationRef, param: Param, value: f64, at: i64, origin: Origin) -> Row {
        Row::Reading(ReadingRow { station: st.clone(), param, value: Some(value), flag: Flag::Ok, observed_at: at, origin })
    }

    async fn ingest(state: &AppState, source: &'static str, rows: Vec<Row>) {
        let raw = RawPayload {
            source_url: "https://example.test".into(),
            content_type: "application/json".into(),
            bytes: serde_json::to_vec(&rows).unwrap(),
            http_status: Some(200),
            fetched_at: T,
            next_cursor: None,
            ack: None,
        };
        let out = ingest_payload(state, &Rows(source), raw, None).await.unwrap();
        assert!(out.error.is_none(), "{out:?}");
    }

    /// `(station ext_id, param, observed_at) -> conflict` for every reading.
    async fn flags(state: &AppState) -> Vec<(String, String, i64, i64)> {
        state
            .obs
            .read(|c| {
                let mut stmt = c.prepare(
                    "select s.ext_id, r.param, r.observed_at, r.conflict from readings r join stations s on s.id = r.station_id
                     order by s.ext_id, r.param, r.observed_at",
                )?;
                let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
                rows.collect()
            })
            .await
            .unwrap()
    }

    fn flag_of(all: &[(String, String, i64, i64)], ext: &str, at: i64) -> i64 {
        all.iter().find(|(e, _, t, _)| e == ext && *t == at).unwrap_or_else(|| panic!("{ext}@{at} in {all:?}")).3
    }

    #[test]
    fn quality_phys_cells_and_distance() {
        let app = crate::hotspot::score::testkit::python_app();
        let g = app.regions[0].grid;
        assert_eq!(cell_of(&app, g.south, g.west), Some((0, 0, 0)));
        assert_eq!(cell_of(&app, g.south + 0.005, g.west + 0.005), Some((0, 0, 0)));
        assert_eq!(cell_of(&app, 25.37, -80.0), Some((0, 320, 107)));
        assert_eq!(cell_of(&app, g.north() - 0.001, g.east() - 0.001), Some((0, 339, 319)));
        assert_eq!(cell_of(&app, g.north() + 1.0, g.east()), None, "outside every region");
        let lf = crate::ingest::poll::bio::testing::lionfish();
        assert_eq!(cell_of(&lf, 20.5, -87.0).map(|c| c.0), Some(1), "Cozumel is in region 1 of Lionfish Watch");
        let d = distance_km(24.628, -81.109, 24.646, -81.109);
        assert!((d - 2.0).abs() < 0.01, "{d}");
    }

    #[tokio::test]
    async fn quality_phys_sst_satellite_vs_buoy() {
        let state = test_state();
        // Sombrero Key C-MAN, buoy SST 28.0 at T.
        let buoy = station("SMKF1", 24.628, -81.109, StationKind::Buoy);
        ingest(&state, "test-buoy", vec![r(&buoy, Param::SstC, 28.0, T, Origin::Measured)]).await;

        let near = station("near", 24.646, -81.109, StationKind::GoesCell); // 2.0 km
        let far = station("far", 24.718, -81.109, StationKind::GoesCell); // 10 km
        let close_agree = station("agree", 24.618, -81.100, StationKind::GoesCell); // 1.4 km
        ingest(
            &state,
            "test-goes",
            vec![
                r(&near, Param::SstC, 30.0, T + 30 * MIN, Origin::Satellite), // +2.0 C, 30 min: conflict
                r(&near, Param::SstC, 31.0, T + 90 * MIN, Origin::Satellite), // outside +-1 h
                r(&far, Param::SstC, 31.0, T, Origin::Satellite),             // too far
                r(&close_agree, Param::SstC, 29.4, T, Origin::Satellite),     // +1.4 C: agrees
            ],
        )
        .await;
        let f = flags(&state).await;
        assert_eq!(flag_of(&f, "SMKF1", T), 1, "buoy flagged");
        assert_eq!(flag_of(&f, "near", T + 30 * MIN), 1, "pixel flagged");
        assert_eq!(flag_of(&f, "near", T + 90 * MIN), 0);
        assert_eq!(flag_of(&f, "far", T), 0);
        assert_eq!(flag_of(&f, "agree", T), 0);

        // The pixel is reprocessed and now agrees: both flags clear.
        ingest(&state, "test-goes", vec![r(&near, Param::SstC, 28.9, T + 30 * MIN, Origin::Satellite)]).await;
        let f = flags(&state).await;
        assert_eq!(flag_of(&f, "SMKF1", T), 0, "buoy cleared");
        assert_eq!(flag_of(&f, "near", T + 30 * MIN), 0, "pixel cleared");

        // A missing (cloud) pixel never conflicts.
        let cloudy = Row::Reading(ReadingRow {
            station: near.clone(),
            param: Param::SstC,
            value: None,
            flag: Flag::Cloud,
            observed_at: T + 10 * MIN,
            origin: Origin::Satellite,
        });
        ingest(&state, "test-goes", vec![cloudy]).await;
        assert_eq!(flag_of(&flags(&state).await, "SMKF1", T), 0);
    }

    #[tokio::test]
    async fn quality_phys_lst_vs_air_offset() {
        let state = test_state();
        // AIR1 sits in cell (220, 90): lat 25.20-25.21, lon -81.00..-80.99.
        let st_a = station("AIR1", 25.2049, -80.9951, StationKind::Buoy);
        let st_b = station("AIR2", 25.4049, -80.7951, StationKind::Buoy);
        let st_c = station("AIR3", 25.6049, -80.5951, StationKind::Buoy);
        ingest(
            &state,
            "test-station",
            vec![
                r(&st_a, Param::AirC, 25.0, T, Origin::Measured),
                r(&st_b, Param::AirC, 25.0, T, Origin::Measured),
                r(&st_c, Param::AirC, 25.0, T, Origin::Measured),
            ],
        )
        .await;
        let cell_a = station("220:90", 25.205, -80.995, StationKind::GoesCell);
        let cell_a_next = station("221:90", 25.205, -80.985, StationKind::GoesCell);
        let cell_b = station("240:110", 25.405, -80.795, StationKind::GoesCell);
        let cell_c = station("260:130", 25.605, -80.595, StationKind::GoesCell);
        ingest(
            &state,
            "test-goes",
            vec![
                r(&cell_a, Param::LstC, 45.0, T + 20 * MIN, Origin::Satellite), // +20 C: too hot
                r(&cell_a_next, Param::LstC, 60.0, T, Origin::Satellite),      // neighbouring cell
                r(&cell_b, Param::LstC, 35.0, T - 20 * MIN, Origin::Satellite), // +10 C: plausible
                r(&cell_c, Param::LstC, 18.0, T, Origin::Satellite),           // -7 C: too cold
            ],
        )
        .await;
        let f = flags(&state).await;
        assert_eq!(flag_of(&f, "AIR1", T), 1);
        assert_eq!(flag_of(&f, "220:90", T + 20 * MIN), 1);
        assert_eq!(flag_of(&f, "221:90", T), 0, "other cell never pairs");
        assert_eq!(flag_of(&f, "AIR2", T), 0);
        assert_eq!(flag_of(&f, "240:110", T - 20 * MIN), 0);
        assert_eq!(flag_of(&f, "AIR3", T), 1);
        assert_eq!(flag_of(&f, "260:130", T), 1);

        // Boundaries of the band are plausible.
        ingest(&state, "test-goes", vec![r(&cell_c, Param::LstC, 20.0, T, Origin::Satellite)]).await;
        let f = flags(&state).await;
        assert_eq!((flag_of(&f, "AIR3", T), flag_of(&f, "260:130", T)), (0, 0), "-5 C is inside the band");
    }

    #[tokio::test]
    async fn quality_phys_modeled_rows_never_conflict() {
        let state = test_state();
        let grid = station("24.625,-81.125", 24.625, -81.125, StationKind::Grid);
        let buoy = station("SMKF1", 24.628, -81.109, StationKind::Buoy);
        ingest(&state, "test-buoy", vec![r(&buoy, Param::SstC, 28.0, T, Origin::Measured)]).await;
        ingest(&state, "test-model", vec![r(&grid, Param::SstC, 32.0, T, Origin::Modeled)]).await;
        assert!(flags(&state).await.iter().all(|(_, _, _, c)| *c == 0));
    }
}
