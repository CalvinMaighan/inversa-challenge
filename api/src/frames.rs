//! EVF1 frame builder (PLAN.md C4, T11).
//!
//! Wire format (little-endian): a 56-byte header (`write_header`, offsets mirrored in
//! `apps/web/shared/frames.ts`), then per frame: `hotspot` f32 × 4 species × cells
//! (species-major, python/tegu/iguana/lionfish), `lst` f32 × cells, `sst` f32 × cells (NaN
//! where missing or flagged), `u32 sightingCount` and 12-byte sighting records
//! (`f32 lon, f32 lat, u16 taxon, u8 quality, u8 flags`), padded to 4 bytes. Cells are
//! row-major from the south-west corner of the C15 grid.
//!
//! A frame's sighting index holds the sightings observed in `[frame_at, frame_at + step)`,
//! duplicates included and flagged, so a client that plays frames in order sees each
//! sighting exactly once.
//!
//! Storage: the `frames` table keys one row per 15-minute frame. `frame_at` is the frame
//! time aligned down to 15 minutes, `payload` is the zlib-compressed body of that single
//! frame (everything after the header, sighting window 15 min), `built_at` when it was
//! built. `chunk` concatenates stored bodies under a fresh header, building and storing any
//! frame that is missing; chunks with a step other than 15 minutes are built on the fly and
//! not stored, since their sighting windows differ.
//!
//! `spawn_builder` listens for `Event::RowsWritten`, debounces 5 s, rebuilds every frame
//! from the earliest touched time up to now (a sighting changes the density of every later
//! frame) inside the 30-day window, and publishes `Event::FramesUpdated`. CPU work runs on
//! `spawn_blocking` threads with rayon across frames.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::time::Duration;

use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use rayon::prelude::*;
use tokio::sync::broadcast::error::RecvError;

use crate::db::Db;
use crate::hotspot::score::{CondParam, Snapshot, DAY_MS};
use crate::hotspot::{Grid, SPECIES};
use crate::realtime::Event;
use crate::state::AppState;

pub const MAGIC: &[u8; 4] = b"EVF1";
pub const HEADER_BYTES: usize = 56;
pub const SIGHTING_BYTES: usize = 12;
pub const SPECIES_COUNT: u32 = 4;
/// PLAN.md C15: 15-minute steps, 30-day window.
pub const STEP_MIN: u32 = 15;
pub const STEP_MS: i64 = STEP_MIN as i64 * 60_000;
pub const WINDOW_MS: i64 = 30 * DAY_MS;
/// Largest chunk one call returns: one day of 15-minute frames, about 250 MB on the full
/// grid (each frame is 2.6 MB of f32 layers). Longer windows are fetched in several calls.
pub const MAX_CHUNK_FRAMES: usize = 96;
pub const DEBOUNCE: Duration = Duration::from_secs(5);
const PERSIST_BATCH: usize = 32;

pub fn align(t: i64, step_ms: i64) -> i64 {
    t.div_euclid(step_ms) * step_ms
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn write_header(out: &mut Vec<u8>, grid: &Grid, frame_count: u32, frame0: i64, step_min: u32) {
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&frame_count.to_le_bytes());
    out.extend_from_slice(&grid.cols.to_le_bytes());
    out.extend_from_slice(&grid.rows.to_le_bytes());
    out.extend_from_slice(&grid.west.to_le_bytes());
    out.extend_from_slice(&grid.south.to_le_bytes());
    out.extend_from_slice(&grid.cell_deg.to_le_bytes());
    out.extend_from_slice(&frame0.to_le_bytes());
    out.extend_from_slice(&step_min.to_le_bytes());
    out.extend_from_slice(&SPECIES_COUNT.to_le_bytes());
}

/// Decoded header; the reader side of `write_header` for Rust consumers and tests.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq)]
pub struct Header {
    pub frame_count: u32,
    pub grid: Grid,
    pub frame0: i64,
    pub step_min: u32,
    pub species_count: u32,
}

#[allow(dead_code)]
pub fn read_header(bytes: &[u8]) -> anyhow::Result<Header> {
    anyhow::ensure!(bytes.len() >= HEADER_BYTES, "EVF: short header");
    anyhow::ensure!(&bytes[..4] == MAGIC, "EVF: bad magic");
    let u32_at = |o: usize| u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
    let f64_at = |o: usize| f64::from_le_bytes(bytes[o..o + 8].try_into().unwrap());
    Ok(Header {
        frame_count: u32_at(4),
        grid: Grid { cols: u32_at(8), rows: u32_at(12), west: f64_at(16), south: f64_at(24), cell_deg: f64_at(32) },
        frame0: i64::from_le_bytes(bytes[40..48].try_into().unwrap()),
        step_min: u32_at(48),
        species_count: u32_at(52),
    })
}

/// Bytes of one frame body with `n` sightings.
pub fn body_len(grid: &Grid, n: usize) -> usize {
    (SPECIES_COUNT as usize + 2) * grid.cells() * 4 + 4 + n * SIGHTING_BYTES
}

fn push_f32s(out: &mut Vec<u8>, values: &[f32]) {
    for v in values {
        out.extend_from_slice(&v.to_le_bytes());
    }
}

/// One frame's body at `at`; its sighting index covers `[at, at + step_ms)`.
pub fn frame_body(snap: &Snapshot, at: i64, step_ms: i64) -> Vec<u8> {
    let cells = snap.grid.cells();
    let cond = snap.conditions(at);
    let lo = snap.sightings.partition_point(|s| s.observed_at < at);
    let hi = snap.sightings.partition_point(|s| s.observed_at < at + step_ms);
    let records = &snap.sightings[lo..hi];
    let mut out = Vec::with_capacity(body_len(&snap.grid, records.len()) + 3);
    for species in SPECIES {
        let scores = snap.apply_rules(species, snap.density(species, at), &cond);
        push_f32s(&mut out, &scores);
    }
    push_f32s(&mut out, &cond.grid(CondParam::LstC, cells));
    push_f32s(&mut out, &cond.grid(CondParam::SstC, cells));
    out.extend_from_slice(&(records.len() as u32).to_le_bytes());
    for s in records {
        out.extend_from_slice(&s.lon.to_le_bytes());
        out.extend_from_slice(&s.lat.to_le_bytes());
        out.extend_from_slice(&(s.taxon_id.clamp(0, u16::MAX as i64) as u16).to_le_bytes());
        out.push(s.quality);
        out.push(s.flags);
    }
    while out.len() % 4 != 0 {
        out.push(0);
    }
    out
}

/// Raw bodies for `times`, built in parallel.
pub fn build_bodies(snap: &Snapshot, times: &[i64], step_ms: i64) -> Vec<(i64, Vec<u8>)> {
    times.par_iter().map(|&t| (t, frame_body(snap, t, step_ms))).collect()
}

/// Compressed bodies for `times`, built in parallel (what the `frames` table stores).
pub fn build_packed(snap: &Snapshot, times: &[i64], step_ms: i64) -> Vec<(i64, Vec<u8>)> {
    times.par_iter().map(|&t| (t, compress(&frame_body(snap, t, step_ms)))).collect()
}

pub fn compress(body: &[u8]) -> Vec<u8> {
    let mut enc = ZlibEncoder::new(Vec::with_capacity(body.len() / 4), Compression::fast());
    enc.write_all(body).expect("write to vec");
    enc.finish().expect("finish zlib")
}

pub fn decompress(payload: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut out = Vec::new();
    ZlibDecoder::new(payload).read_to_end(&mut out)?;
    Ok(out)
}

async fn persist(db: &Db, packed: Vec<(i64, Vec<u8>)>) -> anyhow::Result<()> {
    let built_at = now_ms();
    for batch in packed.chunks(PERSIST_BATCH) {
        let batch = batch.to_vec();
        db.write(move |tx| {
            let mut st = tx.prepare("insert or replace into frames (frame_at, payload, built_at) values (?1, ?2, ?3)")?;
            for (t, payload) in &batch {
                st.execute(rusqlite::params![t, payload, built_at])?;
            }
            Ok(())
        })
        .await?;
    }
    Ok(())
}

/// An EVF1 chunk of every frame at `step_min` from `from_ms` to `to_ms` (both aligned down
/// to the step, both inclusive).
#[allow(dead_code)] // consumed by the GraphQL `frames` resolver (T10)
pub async fn chunk(db: &Db, from_ms: i64, to_ms: i64, step_min: u32) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(step_min >= 1, "stepMinutes must be at least 1");
    anyhow::ensure!(from_ms <= to_ms, "from is after to");
    let step_ms = step_min as i64 * 60_000;
    let frame0 = align(from_ms, step_ms);
    let last = align(to_ms, step_ms);
    let count = ((last - frame0) / step_ms + 1) as usize;
    anyhow::ensure!(
        count <= MAX_CHUNK_FRAMES,
        "chunk of {count} frames exceeds {MAX_CHUNK_FRAMES}; narrow the window or coarsen the step"
    );
    let times: Vec<i64> = (0..count as i64).map(|i| frame0 + i * step_ms).collect();
    let grid = Grid::REGION;

    let mut bodies: HashMap<i64, Vec<u8>> = HashMap::with_capacity(count);
    if step_min == STEP_MIN {
        let stored: Vec<(i64, Vec<u8>)> = db
            .read(move |c| {
                let mut st = c.prepare("select frame_at, payload from frames where frame_at >= ?1 and frame_at <= ?2")?;
                let rows = st
                    .query_map(rusqlite::params![frame0, last], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await?;
        let decoded = tokio::task::spawn_blocking(move || {
            stored.into_par_iter().map(|(t, p)| decompress(&p).map(|b| (t, b))).collect::<anyhow::Result<Vec<_>>>()
        })
        .await??;
        bodies.extend(decoded);
    }
    let missing: Vec<i64> = times.iter().copied().filter(|t| !bodies.contains_key(t)).collect();
    if let (Some(first), Some(end)) = (missing.first().copied(), missing.last().copied()) {
        let snap = Snapshot::load(db, grid, first, end + step_ms).await?;
        let persist_them = step_min == STEP_MIN;
        let (built, packed) = tokio::task::spawn_blocking(move || {
            let built = build_bodies(&snap, &missing, step_ms);
            let packed = if persist_them { built.par_iter().map(|(t, b)| (*t, compress(b))).collect() } else { Vec::new() };
            (built, packed)
        })
        .await?;
        if persist_them {
            persist(db, packed).await?;
        }
        bodies.extend(built);
    }

    let mut out = Vec::with_capacity(HEADER_BYTES + count * body_len(&grid, 0));
    write_header(&mut out, &grid, count as u32, frame0, step_min);
    for t in &times {
        out.extend_from_slice(&bodies[t]);
    }
    Ok(out)
}

/// Build and store every 15-minute frame from `from_ms` to `to_ms` (aligned down, inclusive),
/// one day of frames at a time so a month-long rebuild holds one day of readings in memory.
pub async fn rebuild(db: &Db, from_ms: i64, to_ms: i64) -> anyhow::Result<(i64, i64)> {
    let from = align(from_ms, STEP_MS);
    let to = align(to_ms, STEP_MS);
    anyhow::ensure!(from <= to, "rebuild window is empty");
    let mut batch_start = from;
    while batch_start <= to {
        let batch_end = (batch_start + DAY_MS).min(to + STEP_MS);
        let times: Vec<i64> = (batch_start..batch_end).step_by(STEP_MS as usize).collect();
        let snap = Snapshot::load(db, Grid::REGION, batch_start, batch_end).await?;
        let packed = tokio::task::spawn_blocking(move || build_packed(&snap, &times, STEP_MS)).await?;
        persist(db, packed).await?;
        batch_start = batch_end;
    }
    Ok((from, to))
}

/// Drop stored frames older than `before_ms`.
pub async fn prune(db: &Db, before_ms: i64) -> anyhow::Result<usize> {
    db.write(move |tx| tx.execute("delete from frames where frame_at < ?1", [before_ms])).await
}

fn merge(pending: Option<(i64, i64)>, from: i64, to: i64) -> (i64, i64) {
    match pending {
        Some((f, t)) => (f.min(from), t.max(to)),
        None => (from, to),
    }
}

pub fn spawn_builder(state: AppState) {
    spawn_builder_with(state, DEBOUNCE);
}

pub fn spawn_builder_with(state: AppState, debounce_for: Duration) {
    tokio::spawn(async move {
        let mut rx = state.hub.subscribe();
        let mut pending: Option<(i64, i64)> = None;
        loop {
            let debounce = tokio::time::sleep(debounce_for);
            tokio::pin!(debounce);
            tokio::select! {
                ev = rx.recv() => match ev {
                    Ok(Event::RowsWritten { from, to }) => pending = Some(merge(pending, from, to)),
                    Ok(_) => {}
                    Err(RecvError::Lagged(n)) => {
                        tracing::warn!("frame builder lagged {n} events; rebuilding the whole window");
                        let now = now_ms();
                        pending = Some(merge(pending, now - WINDOW_MS, now));
                    }
                    Err(RecvError::Closed) => return,
                },
                _ = &mut debounce, if pending.is_some() => {
                    let Some((from, _)) = pending.take() else { continue };
                    let now = now_ms();
                    let from = from.max(now - WINDOW_MS);
                    if from > now {
                        continue;
                    }
                    let started = std::time::Instant::now();
                    match rebuild(&state.obs, from, now).await {
                        Ok((f, t)) => {
                            tracing::info!(
                                "frames rebuilt {}..{} ({} frames) in {:?}",
                                f,
                                t,
                                (t - f) / STEP_MS + 1,
                                started.elapsed()
                            );
                            state.hub.publish(Event::FramesUpdated { from: f, to: t });
                        }
                        Err(e) => tracing::warn!("frame rebuild failed: {e:#}"),
                    }
                    if let Err(e) = prune(&state.obs, now - WINDOW_MS - DAY_MS).await {
                        tracing::warn!("frame prune failed: {e:#}");
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hotspot::score::testkit::*;
    use crate::hotspot::score::{ReadingPt, SightingPt, FLAG_CONFLICT, FLAG_DUPLICATE, FLAG_LATE};
    use crate::hotspot::Species;

    fn f32_at(b: &[u8], o: usize) -> f32 {
        f32::from_le_bytes(b[o..o + 4].try_into().unwrap())
    }

    fn u32_at(b: &[u8], o: usize) -> u32 {
        u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
    }

    /// The fixed seed input behind `spec/frames/sample.evf`: an 8 × 6 grid, three frames from
    /// 2025-02-01 00:00 UTC, one sighting of each species plus a NAS prior, a duplicate, a
    /// conflict and a late record, and four stations with mixed valid and flagged readings.
    fn golden_input() -> (Snapshot, Vec<i64>) {
        let grid = Grid { west: -80.5, south: 25.2, cell_deg: 0.01, cols: 8, rows: 6 };
        let t0 = ms(2025, 2, 1, 0);
        let pt = |id: i64, taxon_id: i64, col: u32, row: u32, observed_at: i64, prior: bool, quality: u8, flags: u8| {
            let (lon, lat) = grid.center(grid.index(col, row));
            SightingPt { id, taxon_id, lon: lon as f32, lat: lat as f32, col, row, observed_at, prior, quality, flags }
        };
        let sightings = vec![
            pt(1, 1, 2, 2, t0 - 2 * HOUR, false, 0, 0),
            pt(2, 2, 5, 1, t0 - 3 * DAY, false, 1, 0),
            pt(3, 3, 6, 4, t0 + 5 * 60_000, false, 0, 0),
            pt(4, 4, 1, 5, t0 - 10 * DAY, false, 3, 0),
            pt(5, 1, 7, 0, t0 - 400 * DAY, true, 3, 0),
            pt(6, 1, 2, 2, t0 + 20 * 60_000, false, 0, FLAG_DUPLICATE),
            pt(7, 2, 4, 4, t0 + 31 * 60_000, false, 2, FLAG_CONFLICT | FLAG_LATE),
            pt(8, 4, 3, 3, t0 + 44 * 60_000, false, 2, 0),
            pt(9, 1, 0, 0, t0 + 41 * 60_000, false, 0, 0),
        ];
        // (lat, lon): NWS grid point, NDBC buoy, two GOES cells.
        let stations = vec![
            (grid.center(grid.index(3, 3)).1, grid.center(grid.index(3, 3)).0),
            (grid.center(grid.index(0, 5)).1, grid.center(grid.index(0, 5)).0),
            (grid.center(grid.index(2, 2)).1, grid.center(grid.index(2, 2)).0),
            (grid.center(grid.index(6, 4)).1, grid.center(grid.index(6, 4)).0),
        ];
        let mut readings: [Vec<ReadingPt>; 6] = Default::default();
        let r = |station: u32, observed_at: i64, value: f32| ReadingPt { station, observed_at, value };
        readings[CondParam::AirC as usize] = vec![r(0, t0 - HOUR, 8.0), r(0, t0 + 20 * 60_000, 11.0)];
        readings[CondParam::WaveM as usize] = vec![r(1, t0 - 30 * 60_000, 0.4)];
        readings[CondParam::WindMs as usize] = vec![r(1, t0 - 30 * 60_000, 3.0), r(1, t0 + 25 * 60_000, 9.5)];
        readings[CondParam::LstC as usize] = vec![r(2, t0 - 20 * 60_000, 12.0), r(3, t0 - 20 * 60_000, f32::NAN)];
        readings[CondParam::SstC as usize] = vec![r(3, t0 - 20 * 60_000, 24.0), r(2, t0 - 20 * 60_000, f32::NAN)];
        readings[CondParam::StageM as usize] = vec![r(0, t0 - 2 * HOUR, 1.0)];
        let times = vec![t0, t0 + STEP_MS, t0 + 2 * STEP_MS];
        (Snapshot::new(grid, t0, t0 + 3 * STEP_MS, sightings, stations, readings), times)
    }

    fn golden_bytes() -> Vec<u8> {
        let (snap, times) = golden_input();
        let mut out = Vec::new();
        write_header(&mut out, &snap.grid, times.len() as u32, times[0], STEP_MIN);
        for (_, body) in build_bodies(&snap, &times, STEP_MS) {
            out.extend_from_slice(&body);
        }
        out
    }

    #[test]
    fn evf_golden() {
        let bytes = golden_bytes();
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../spec/frames/sample.evf");
        if std::env::var("EVF_UPDATE_GOLDEN").is_ok() {
            std::fs::create_dir_all(std::path::Path::new(path).parent().unwrap()).unwrap();
            std::fs::write(path, &bytes).unwrap();
        }
        let golden = std::fs::read(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
        assert_eq!(bytes.len(), golden.len(), "golden length");
        assert!(bytes == golden, "writer output differs from spec/frames/sample.evf");

        // The file decodes as documented.
        let h = read_header(&bytes).unwrap();
        let (snap, times) = golden_input();
        assert_eq!(
            h,
            Header { frame_count: 3, grid: snap.grid, frame0: times[0], step_min: 15, species_count: 4 }
        );
        assert_eq!(bytes.len(), HEADER_BYTES + 3 * body_len(&snap.grid, 0) + (1 + 1 + 3) * SIGHTING_BYTES);
        let cells = snap.grid.cells();
        let grid_bytes = (SPECIES_COUNT as usize + 2) * cells * 4;
        let mut o = HEADER_BYTES;
        let mut counts = Vec::new();
        for frame in 0..3usize {
            let body = &bytes[o..];
            // Iguana observed 00:05 at (6,4): nothing at frame 0, cold stun (8 °C air) at 00:15,
            // lifted by the 11 °C reading at 00:20 for the 00:30 frame.
            let iguana = f32_at(body, (Species::Iguana.index() * cells + snap.grid.index(6, 4)) * 4);
            let want = match frame {
                0 => 0.0,
                1 => 2.0,
                _ => 1.0,
            };
            assert_eq!(iguana, want, "frame {frame}");
            // Lionfish at (1,5): calm until the 9.5 m/s wind at 00:25.
            let lion = f32_at(body, (Species::Lionfish.index() * cells + snap.grid.index(1, 5)) * 4);
            assert_eq!(lion, if frame < 2 { 1.0 } else { 0.1 }, "frame {frame}");
            // Tegu in February brumates.
            let tegu = f32_at(body, (Species::Tegu.index() * cells + snap.grid.index(5, 1)) * 4);
            assert!((tegu - 0.3).abs() < 1e-6);
            // LST is valid only at the (2,2) pixel and reaches 5 cells; the flagged (6,4)
            // pixel reads it too (4.5 cells away) while (7,5) is out of reach. SST mirrors that.
            let lst = 4 * cells * 4;
            assert_eq!(f32_at(body, lst + snap.grid.index(2, 2) * 4), 12.0);
            assert_eq!(f32_at(body, lst + snap.grid.index(6, 4) * 4), 12.0);
            assert!(f32_at(body, lst + snap.grid.index(7, 5) * 4).is_nan());
            let sst = 5 * cells * 4;
            assert_eq!(f32_at(body, sst + snap.grid.index(6, 4) * 4), 24.0);
            assert_eq!(f32_at(body, sst + snap.grid.index(2, 2) * 4), 24.0);
            assert!(f32_at(body, sst + snap.grid.index(0, 0) * 4).is_nan());
            let n = u32_at(body, grid_bytes) as usize;
            counts.push(n);
            o += grid_bytes + 4 + n * SIGHTING_BYTES;
        }
        assert_eq!(counts, vec![1, 1, 3], "sightings per 15-minute window");
        assert_eq!(o, bytes.len());
        // Frame 1's record is the flagged duplicate.
        let rec = &bytes[HEADER_BYTES + 2 * grid_bytes + 4 + SIGHTING_BYTES + 4..];
        assert_eq!(u16::from_le_bytes([rec[8], rec[9]]), 1);
        assert_eq!(rec[10], 0);
        assert_eq!(rec[11], FLAG_DUPLICATE);
    }

    #[test]
    fn frames_header_layout_matches_ts_reader() {
        let mut out = Vec::new();
        write_header(&mut out, &Grid::REGION, 7, 1_700_000_000_000, 15);
        assert_eq!(out.len(), HEADER_BYTES);
        assert_eq!(&out[..4], b"EVF1");
        assert_eq!(u32_at(&out, 4), 7);
        assert_eq!(u32_at(&out, 8), 340);
        assert_eq!(u32_at(&out, 12), 320);
        assert_eq!(f64::from_le_bytes(out[16..24].try_into().unwrap()), -83.2);
        assert_eq!(f64::from_le_bytes(out[24..32].try_into().unwrap()), 24.3);
        assert_eq!(f64::from_le_bytes(out[32..40].try_into().unwrap()), 0.01);
        assert_eq!(i64::from_le_bytes(out[40..48].try_into().unwrap()), 1_700_000_000_000);
        assert_eq!(u32_at(&out, 48), 15);
        assert_eq!(u32_at(&out, 52), 4);
        assert_eq!(align(1_700_000_123_456, STEP_MS), 1_700_000_100_000);
        assert_eq!(align(-1, STEP_MS), -STEP_MS);
        let round = compress(&out);
        assert_eq!(decompress(&round).unwrap(), out);
    }

    #[tokio::test]
    async fn frames_chunk_stores_and_reuses_bodies() {
        let db = Db::memory("observations");
        seed_sources(&db).await;
        let g = Grid::REGION;
        let t0 = ms(2025, 6, 1, 12);
        let (lon, lat) = g.center(g.index(50, 60));
        let id = insert_sighting(&db, "inat", 4, lat, lon, t0 + 7 * 60_000, "research", None).await;
        let bytes = chunk(&db, t0 + 60_000, t0 + 40 * 60_000, 15).await.unwrap();
        let h = read_header(&bytes).unwrap();
        assert_eq!(h.frame_count, 3, "12:00, 12:15, 12:30");
        assert_eq!(h.frame0, t0);
        assert_eq!(h.grid, g);
        let stored: i64 = db.read(|c| c.query_row("select count(*) from frames", [], |r| r.get(0))).await.unwrap();
        assert_eq!(stored, 3);
        let grid_bytes = 6 * g.cells() * 4;
        // Frame 0 carries the sighting; frames 1 and 2 carry none. Density for lionfish is
        // 1.0 at the cell from 12:15 on (observed 12:07 is after the 12:00 frame).
        assert_eq!(u32_at(&bytes, HEADER_BYTES + grid_bytes), 1);
        let f0_len = grid_bytes + 4 + SIGHTING_BYTES;
        assert_eq!(u32_at(&bytes, HEADER_BYTES + f0_len + grid_bytes), 0);
        let f1 = &bytes[HEADER_BYTES + f0_len..];
        assert_eq!(f32_at(f1, (Species::Lionfish.index() * g.cells() + g.index(50, 60)) * 4), 1.0);
        assert_eq!(f32_at(&bytes, HEADER_BYTES + (Species::Lionfish.index() * g.cells() + g.index(50, 60)) * 4), 0.0);
        assert_eq!(bytes.len(), HEADER_BYTES + 3 * (grid_bytes + 4) + SIGHTING_BYTES);

        // Stored bodies are reused: change the row underneath and the chunk still reads the cache.
        db.write(move |tx| tx.execute("update sightings set taxon_id = 1 where id = ?1", [id])).await.unwrap();
        let again = chunk(&db, t0, t0 + 30 * 60_000, 15).await.unwrap();
        assert_eq!(again, bytes);
        // A rebuild refreshes them.
        rebuild(&db, t0, t0 + 30 * 60_000).await.unwrap();
        let fresh = chunk(&db, t0, t0 + 30 * 60_000, 15).await.unwrap();
        assert_ne!(fresh, bytes);
        let f1 = &fresh[HEADER_BYTES + f0_len..];
        assert_eq!(f32_at(f1, (Species::Python.index() * g.cells() + g.index(50, 60)) * 4), 1.0);
        // A coarser step is built on the fly with its own sighting window and not stored.
        let hourly = chunk(&db, t0, t0 + 2 * HOUR, 60).await.unwrap();
        assert_eq!(read_header(&hourly).unwrap().frame_count, 3);
        assert_eq!(u32_at(&hourly, HEADER_BYTES + grid_bytes), 1);
        let stored: i64 = db.read(|c| c.query_row("select count(*) from frames", [], |r| r.get(0))).await.unwrap();
        assert_eq!(stored, 3);
        assert!(chunk(&db, t0, t0 + 300 * STEP_MS, 15).await.is_err(), "over the chunk cap");
        assert!(chunk(&db, t0, t0 - 1, 15).await.is_err());
        assert_eq!(prune(&db, t0 + STEP_MS).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn frames_builder_debounces_and_publishes() {
        let state = crate::app::test_support::test_state();
        seed_sources(&state.obs).await;
        let now = now_ms();
        let g = Grid::REGION;
        let (lon, lat) = g.center(g.index(200, 150));
        insert_sighting(&state.obs, "inat", 2, lat, lon, now - 2 * HOUR, "research", None).await;
        let mut rx = state.hub.subscribe();
        spawn_builder_with(state.clone(), Duration::from_millis(100));
        tokio::task::yield_now().await;
        state.hub.publish(Event::RowsWritten { from: now - 2 * HOUR, to: now - 2 * HOUR });
        state.hub.publish(Event::RowsWritten { from: now - HOUR, to: now - HOUR });
        let updated = loop {
            match tokio::time::timeout(Duration::from_secs(120), rx.recv()).await.expect("builder published") {
                Ok(Event::FramesUpdated { from, to }) => break (from, to),
                Ok(_) => continue,
                Err(e) => panic!("{e}"),
            }
        };
        assert_eq!(updated.0, align(now - 2 * HOUR, STEP_MS));
        assert_eq!(updated.1, align(now, STEP_MS));
        let stored: i64 = state.obs.read(|c| c.query_row("select count(*) from frames", [], |r| r.get(0))).await.unwrap();
        assert_eq!(stored, (updated.1 - updated.0) / STEP_MS + 1);
        assert!(stored >= 8);
    }

    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> f64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 >> 11) as f64 / (1u64 << 53) as f64
        }
    }

    /// 30 days × 96 frames on the full grid from ~5k sightings and hourly readings.
    /// `cargo test --release bench_frames -- --ignored --nocapture`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn bench_frames() {
        let db = Db::memory("observations");
        seed_sources(&db).await;
        let g = Grid::REGION;
        let mut rng = Rng(0x5DEE_CE66_D1CE_F00D);
        let t_end = align(ms(2025, 9, 1, 0), STEP_MS);
        let t_start = t_end - 30 * DAY;
        let params: [&str; 6] = ["air_c", "lst_c", "sst_c", "stage_m", "wave_m", "wind_ms"];
        let mut stations = Vec::new();
        for i in 0..60 {
            let lat = g.south + rng.next() * (g.north() - g.south);
            let lon = g.west + rng.next() * (g.east() - g.west);
            stations.push(insert_station(&db, "nws", &format!("st{i}"), lat, lon, "grid").await);
        }
        let mut sightings = Vec::with_capacity(5_000);
        for i in 0..5_000u32 {
            let taxon = 1 + (rng.next() * 4.0) as i64;
            let lat = g.south + rng.next() * (g.north() - g.south);
            let lon = g.west + rng.next() * (g.east() - g.west);
            let at = t_start - 20 * DAY + (rng.next() * 50.0 * DAY as f64) as i64;
            let source = if i % 10 == 0 { "nas" } else { "inat" };
            sightings.push((source, taxon, lat, lon, at));
        }
        db.write(move |tx| {
            let mut st = tx.prepare(
                "insert into sightings (source_id, ext_id, taxon_id, lat, lon, observed_at, quality, ingested_at) \
                 values (?1, ?2, ?3, ?4, ?5, ?6, 'research', ?6)",
            )?;
            for (i, (source, taxon, lat, lon, at)) in sightings.into_iter().enumerate() {
                st.execute(rusqlite::params![source, i.to_string(), taxon, lat, lon, at])?;
            }
            Ok(())
        })
        .await
        .unwrap();
        let mut rows = Vec::new();
        let mut t = t_start - 6 * HOUR;
        while t <= t_end {
            for &st in &stations {
                for (k, p) in params.iter().enumerate() {
                    let v = match k {
                        0 => 18.0 + 12.0 * rng.next(),
                        1 => 15.0 + 20.0 * rng.next(),
                        2 => 22.0 + 6.0 * rng.next(),
                        3 => 0.2 + 2.5 * rng.next(),
                        4 => 0.2 + 2.0 * rng.next(),
                        _ => 1.0 + 10.0 * rng.next(),
                    };
                    rows.push((st, *p, Some(v), t));
                }
            }
            t += HOUR;
        }
        let n_readings = rows.len();
        insert_readings(&db, rows).await;

        let started = std::time::Instant::now();
        let mut frames = 0usize;
        let mut bytes = 0usize;
        let mut batch_start = t_start;
        while batch_start < t_end {
            let batch_end = (batch_start + DAY).min(t_end);
            let times: Vec<i64> = (batch_start..batch_end).step_by(STEP_MS as usize).collect();
            let snap = Snapshot::load(&db, g, batch_start, batch_end).await.unwrap();
            let packed = tokio::task::spawn_blocking(move || build_packed(&snap, &times, STEP_MS)).await.unwrap();
            frames += packed.len();
            bytes += packed.iter().map(|(_, p)| p.len()).sum::<usize>();
            batch_start = batch_end;
        }
        let elapsed = started.elapsed();
        assert_eq!(frames, 30 * 96);
        println!(
            "BENCH frames {frames} in {:.2}s ({} readings, {} compressed MB, {:.1} ms/frame)",
            elapsed.as_secs_f64(),
            n_readings,
            bytes / (1024 * 1024),
            elapsed.as_secs_f64() * 1000.0 / frames as f64
        );
    }
}
