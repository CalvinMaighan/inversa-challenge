//! EVF2 frame builder and bulk route (PLAN.md C4, T11; regions per C-A4).
//!
//! Wire format (little-endian; the authoritative layout is the doc comment in
//! `apps/web/shared/frames.ts`): a 72-byte header (`write_header`) whose grid fields describe
//! region 0 and whose last u32 (offset 68) is the region count. When the app has more than one
//! region, `REGION_DESC_BYTES` descriptors follow the header, one per region in config order:
//! `u32 hsCols, u32 hsRows, f64 west, f64 south, f64 hsCellDeg, u16 envCols, u16 envRows,
//! f32 envCellDeg`. A single-region file is exactly the pre-pivot layout (count 1, no descriptors).
//!
//! Each frame is the concatenation of one body per region, in region order. A region body:
//! - `hotspot` u8 × taxa × hs cells (taxon-major in `taxa[]` order, row-major from the
//!   south-west corner, 2 × cellDeg). Each cell is the max of its 2 × 2 children on the scoring
//!   grid, quantized as `round(score / HOTSPOT_SCALE)` and clamped to 255. For a component app
//!   (`hotspot::lionfish::enabled`) the score is `rankScore` (0..1, submitted-date basis).
//! - pad to 2 bytes.
//! - `lst`, `sst` i16 × env cells (5 × cellDeg, the GOES `g5` cells) in centi-°C: the latest
//!   valid reading of a station inside the cell; `ENV_FLAGGED` (-32767) when a station inside
//!   it reported only flagged values (cloud, bad DQF); `ENV_MISSING` (-32768) when none reported.
//! - pad to 4 bytes.
//! - `u32 sightingCount` and 16-byte records (`u32 id, f32 lon, f32 lat, u16 taxon,
//!   u8 quality, u8 flags`; `id` is `sightings.id`, citable as `sighting:<id>`): the sightings
//!   observed in `[frame_at, frame_at + step)` inside the region, duplicates included and
//!   flagged, so a client that plays frames in order sees each sighting exactly once.
//!
//! Steps: hourly by default; 15-minute frames are allowed for windows of 24 h or less.
//!
//! Storage: the `frames` table keys one row per hourly frame. `frame_at` is the frame time
//! aligned down to the hour, `payload` the zlib-compressed body of that single frame (every
//! region, sighting window 60 min), `built_at` when it was built. `chunk` concatenates stored
//! bodies under a fresh header, building and storing any hourly frame that is missing;
//! 15-minute chunks are built on the fly and not stored, since their sighting windows differ.
//!
//! Transport: `GET /v1/{app}/frames?from=&to=&step=` (`routes`) returns `application/x-evf` with
//! gzip content encoding, at most `MAX_CHUNK_FRAMES` frames; `from`/`to` are unix ms or RFC
//! 3339. GraphQL `frames` (T10) calls `chunk` for at most 24 frames. A conditions app (no
//! hotspot grid) answers 404 `{"error":"no_frames"}`.
//!
//! `spawn_builder` listens for `Event::RowsWritten`, debounces 5 s, rebuilds every hourly
//! frame from the earliest touched time up to now (a sighting changes the density of every
//! later frame) inside the 30-day window, and publishes `Event::FramesUpdated`. CPU work
//! runs on `spawn_blocking` threads with rayon across frames.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::time::Duration;

use axum::extract::Query;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use flate2::read::ZlibDecoder;
use flate2::write::{GzEncoder, ZlibEncoder};
use flate2::Compression;
use rayon::prelude::*;
use serde::Deserialize;
use tokio::sync::broadcast::error::RecvError;

use crate::app::config::App;
use crate::app::AppRegistry;
use crate::db::Db;
use crate::hotspot::score::{CondParam, Snapshot, DAY_MS};
use crate::hotspot::Grid;
use crate::realtime::Event;
use crate::state::AppState;

pub const MAGIC: &[u8; 4] = b"EVF2";
pub const HEADER_BYTES: usize = 72;
/// Bytes of one per-region descriptor after the header (multi-region apps only).
pub const REGION_DESC_BYTES: usize = 40;
pub const SIGHTING_BYTES: usize = 16;
/// `score = u8 × HOTSPOT_SCALE`; scores top out around 2.4 (density 1 × the largest boosts).
pub const HOTSPOT_SCALE: f32 = 0.01;
/// Env cell with no reading at all (outside the product's domain, or nothing reported).
pub const ENV_MISSING: i16 = -32768;
/// Env cell whose pixel reported, but flagged (cloud, bad DQF, missing value): a data gap to show.
pub const ENV_FLAGGED: i16 = -32767;
/// Stored and default step.
pub const STEP_MIN: u32 = 60;
pub const STEP_MS: i64 = STEP_MIN as i64 * 60_000;
/// Fine step, allowed for windows of at most `FINE_WINDOW_MS`.
pub const FINE_STEP_MIN: u32 = 15;
pub const FINE_WINDOW_MS: i64 = DAY_MS;
/// PLAN.md C15: 30-day window.
pub const WINDOW_MS: i64 = 30 * DAY_MS;
/// 31 days of hourly frames; the REST cap. GraphQL `frames` caps itself at 24.
pub const MAX_CHUNK_FRAMES: usize = 744;
pub const CONTENT_TYPE: &str = "application/x-evf";
pub const DEBOUNCE: Duration = Duration::from_secs(5);
const PERSIST_BATCH: usize = 32;
/// Hotspot cells per scoring cell, per axis.
const HS_FACTOR: u32 = 2;
/// Environment cells per scoring cell, per axis.
const ENV_FACTOR: u32 = 5;

/// The three grids of a region's frame section: the scoring grid and its hotspot and
/// environment downsamples. The scoring grid must divide evenly (cols and rows multiples of 10).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Layout {
    pub grid: Grid,
    pub hs: Grid,
    pub env: Grid,
}

impl Layout {
    pub fn for_grid(grid: Grid) -> anyhow::Result<Layout> {
        let m = HS_FACTOR * ENV_FACTOR;
        anyhow::ensure!(
            grid.cols.is_multiple_of(m) && grid.rows.is_multiple_of(m),
            "grid {}x{} is not a multiple of {m}",
            grid.cols,
            grid.rows
        );
        let sub = |f: u32| Grid {
            west: grid.west,
            south: grid.south,
            cell_deg: grid.cell_deg * f as f64,
            cols: grid.cols / f,
            rows: grid.rows / f,
        };
        Ok(Layout { grid, hs: sub(HS_FACTOR), env: sub(ENV_FACTOR) })
    }

    /// Hotspot section bytes for `taxa` taxa.
    pub fn hotspot_bytes(&self, taxa: usize) -> usize {
        taxa * self.hs.cells()
    }

    pub fn lst_offset(&self, taxa: usize) -> usize {
        self.hotspot_bytes(taxa).next_multiple_of(2)
    }

    pub fn sst_offset(&self, taxa: usize) -> usize {
        self.lst_offset(taxa) + self.env.cells() * 2
    }

    pub fn sightings_offset(&self, taxa: usize) -> usize {
        (self.sst_offset(taxa) + self.env.cells() * 2).next_multiple_of(4)
    }

    /// Bytes of one region body with `taxa` taxa and `n` sightings.
    pub fn body_len(&self, taxa: usize, n: usize) -> usize {
        self.sightings_offset(taxa) + 4 + n * SIGHTING_BYTES
    }
}

pub fn align(t: i64, step_ms: i64) -> i64 {
    t.div_euclid(step_ms) * step_ms
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Header bytes for `region_count` regions: descriptors follow only when there are several.
pub fn header_len(region_count: usize) -> usize {
    if region_count > 1 {
        HEADER_BYTES + region_count * REGION_DESC_BYTES
    } else {
        HEADER_BYTES
    }
}

/// Write the header for `layouts` (one per region, region 0 first) and `taxa` taxa.
pub fn write_header(out: &mut Vec<u8>, layouts: &[Layout], taxa: usize, frame_count: u32, frame0: i64, step_min: u32) {
    let first = &layouts[0];
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&frame_count.to_le_bytes());
    out.extend_from_slice(&first.hs.cols.to_le_bytes());
    out.extend_from_slice(&first.hs.rows.to_le_bytes());
    out.extend_from_slice(&first.hs.west.to_le_bytes());
    out.extend_from_slice(&first.hs.south.to_le_bytes());
    out.extend_from_slice(&first.hs.cell_deg.to_le_bytes());
    out.extend_from_slice(&frame0.to_le_bytes());
    out.extend_from_slice(&step_min.to_le_bytes());
    out.extend_from_slice(&(taxa as u32).to_le_bytes());
    out.extend_from_slice(&(first.env.cols as u16).to_le_bytes());
    out.extend_from_slice(&(first.env.rows as u16).to_le_bytes());
    out.extend_from_slice(&(first.env.cell_deg as f32).to_le_bytes());
    out.extend_from_slice(&HOTSPOT_SCALE.to_le_bytes());
    out.extend_from_slice(&(layouts.len() as u32).to_le_bytes());
    if layouts.len() > 1 {
        for l in layouts {
            out.extend_from_slice(&l.hs.cols.to_le_bytes());
            out.extend_from_slice(&l.hs.rows.to_le_bytes());
            out.extend_from_slice(&l.hs.west.to_le_bytes());
            out.extend_from_slice(&l.hs.south.to_le_bytes());
            out.extend_from_slice(&l.hs.cell_deg.to_le_bytes());
            out.extend_from_slice(&(l.env.cols as u16).to_le_bytes());
            out.extend_from_slice(&(l.env.rows as u16).to_le_bytes());
            out.extend_from_slice(&(l.env.cell_deg as f32).to_le_bytes());
        }
    }
}

/// Decoded header; the reader side of `write_header`. Clients decode in TS
/// (`apps/web/shared/frames.ts`), so in Rust only tests read it.
#[cfg(test)]
#[derive(Debug, Clone, PartialEq)]
pub struct Header {
    pub frame_count: u32,
    pub hs: Grid,
    pub env: Grid,
    pub frame0: i64,
    pub step_min: u32,
    pub species_count: u32,
    pub hotspot_scale: f32,
    pub region_count: u32,
    /// (hotspot grid, environment grid) per region; one entry, equal to `hs`/`env`, when single.
    pub regions: Vec<(Grid, Grid)>,
}

#[cfg(test)]
impl Header {
    pub fn len(&self) -> usize {
        header_len(self.regions.len())
    }
}

#[cfg(test)]
pub fn read_header(bytes: &[u8]) -> anyhow::Result<Header> {
    anyhow::ensure!(bytes.len() >= HEADER_BYTES, "EVF: short header");
    anyhow::ensure!(&bytes[..4] == MAGIC, "EVF: bad magic");
    let u16_at = |o: usize| u16::from_le_bytes(bytes[o..o + 2].try_into().unwrap());
    let u32_at = |o: usize| u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
    let f32_at = |o: usize| f32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
    let f64_at = |o: usize| f64::from_le_bytes(bytes[o..o + 8].try_into().unwrap());
    // f32 0.05 is not exactly 0.05; the TS reader rounds the same way.
    let grids = |o: usize| {
        let (west, south) = (f64_at(o + 8), f64_at(o + 16));
        let hs = Grid { cols: u32_at(o), rows: u32_at(o + 4), west, south, cell_deg: f64_at(o + 24) };
        let env = Grid { cols: u16_at(o + 32) as u32, rows: u16_at(o + 34) as u32, west, south, cell_deg: (f32_at(o + 36) as f64 * 1e6).round() / 1e6 };
        (hs, env)
    };
    let (west, south) = (f64_at(16), f64_at(24));
    let hs = Grid { cols: u32_at(8), rows: u32_at(12), west, south, cell_deg: f64_at(32) };
    let env = Grid { cols: u16_at(56) as u32, rows: u16_at(58) as u32, west, south, cell_deg: (f32_at(60) as f64 * 1e6).round() / 1e6 };
    let region_count = u32_at(68);
    let regions = if region_count > 1 {
        anyhow::ensure!(bytes.len() >= header_len(region_count as usize), "EVF: short region table");
        (0..region_count as usize).map(|i| grids(HEADER_BYTES + i * REGION_DESC_BYTES)).collect()
    } else {
        vec![(hs, env)]
    };
    Ok(Header {
        frame_count: u32_at(4),
        hs,
        env,
        frame0: i64::from_le_bytes(bytes[40..48].try_into().unwrap()),
        step_min: u32_at(48),
        species_count: u32_at(52),
        hotspot_scale: f32_at(64),
        region_count,
        regions,
    })
}

fn quantize_score(score: f32) -> u8 {
    (score / HOTSPOT_SCALE).round().clamp(0.0, 255.0) as u8
}

fn quantize_env(value: Option<f32>) -> i16 {
    match value {
        // The two lowest i16 values are the sentinels.
        Some(v) if v.is_finite() => (v * 100.0).round().clamp(-32766.0, 32767.0) as i16,
        _ => ENV_MISSING,
    }
}

/// One region's body at `at`; its sighting index covers `[at, at + step_ms)`.
pub fn region_body(snap: &Snapshot, layout: &Layout, at: i64, step_ms: i64) -> Vec<u8> {
    debug_assert_eq!(snap.grid, layout.grid);
    let grid = &layout.grid;
    let taxa = snap.taxa.len();
    let cond = snap.conditions(at);
    let lo = snap.sightings.partition_point(|s| s.observed_at < at);
    let hi = snap.sightings.partition_point(|s| s.observed_at < at + step_ms);
    let records = &snap.sightings[lo..hi];
    let mut out = Vec::with_capacity(layout.body_len(taxa, records.len()));
    for taxon in &snap.taxa {
        let scores = snap.score_at(taxon, at, &cond);
        for hr in 0..layout.hs.rows {
            for hc in 0..layout.hs.cols {
                let mut best = 0f32;
                for dy in 0..HS_FACTOR {
                    for dx in 0..HS_FACTOR {
                        best = best.max(scores[grid.index(hc * HS_FACTOR + dx, hr * HS_FACTOR + dy)]);
                    }
                }
                out.push(quantize_score(best));
            }
        }
    }
    out.resize(layout.lst_offset(taxa), 0);
    // An env cell shows only a reading from inside it. The scorer lets a fine cell borrow the
    // nearest pixel up to `max_cells` away, which reaches the neighbouring g5 centre; on the
    // display grid that would paint a cloudy or bad-DQF pixel with its neighbour's value, so the
    // gap the globe hatches would vanish (PRD §7: missing data is never interpolated). A cell
    // whose pixel reported only flagged values is `ENV_FLAGGED`, so the client can hatch it even
    // when it never cleared in the loaded window.
    for param in [CondParam::LstC, CondParam::SstC] {
        let flagged: std::collections::HashSet<(u32, u32)> = snap
            .flagged_stations(param, at)
            .into_iter()
            .filter_map(|s| {
                let (lat, lon) = snap.stations[s as usize];
                layout.env.col_row(lon, lat)
            })
            .collect();
        for er in 0..layout.env.rows {
            for ec in 0..layout.env.cols {
                let idx = grid.index(ec * ENV_FACTOR + ENV_FACTOR / 2, er * ENV_FACTOR + ENV_FACTOR / 2);
                let value = cond.value_from(param, idx).and_then(|(v, station)| {
                    let (lat, lon) = snap.stations[station as usize];
                    (layout.env.col_row(lon, lat) == Some((ec, er))).then_some(v)
                });
                let q = match value {
                    None if flagged.contains(&(ec, er)) => ENV_FLAGGED,
                    v => quantize_env(v),
                };
                out.extend_from_slice(&q.to_le_bytes());
            }
        }
    }
    out.resize(layout.sightings_offset(taxa), 0);
    out.extend_from_slice(&(records.len() as u32).to_le_bytes());
    for s in records {
        out.extend_from_slice(&(s.id.clamp(0, u32::MAX as i64) as u32).to_le_bytes());
        out.extend_from_slice(&s.lon.to_le_bytes());
        out.extend_from_slice(&s.lat.to_le_bytes());
        out.extend_from_slice(&(s.taxon_id.clamp(0, u16::MAX as i64) as u16).to_le_bytes());
        out.push(s.quality);
        out.push(s.flags);
    }
    out
}

/// One frame's body: every region's body, in region order. `snaps` and `layouts` are parallel
/// per region.
pub fn frame_body(snaps: &[Snapshot], layouts: &[Layout], at: i64, step_ms: i64) -> Vec<u8> {
    let mut out = Vec::new();
    for (snap, layout) in snaps.iter().zip(layouts) {
        out.extend(region_body(snap, layout, at, step_ms));
    }
    out
}

/// Raw bodies for `times`, built in parallel.
pub fn build_bodies(snaps: &[Snapshot], layouts: &[Layout], times: &[i64], step_ms: i64) -> Vec<(i64, Vec<u8>)> {
    times.par_iter().map(|&t| (t, frame_body(snaps, layouts, t, step_ms))).collect()
}

/// Compressed bodies for `times`, built in parallel (what the `frames` table stores).
pub fn build_packed(snaps: &[Snapshot], layouts: &[Layout], times: &[i64], step_ms: i64) -> Vec<(i64, Vec<u8>)> {
    times.par_iter().map(|&t| (t, compress(&frame_body(snaps, layouts, t, step_ms)))).collect()
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

/// Gzip a whole chunk for the wire.
pub fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut enc = GzEncoder::new(Vec::with_capacity(bytes.len() / 8), Compression::default());
    enc.write_all(bytes).expect("write to vec");
    enc.finish().expect("finish gzip")
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

/// The frame times of a chunk request, validated: `step_min` is 60, or 15 for a window of
/// at most 24 h; both ends align down to the step and are inclusive; at most
/// `MAX_CHUNK_FRAMES` frames.
pub fn chunk_times(from_ms: i64, to_ms: i64, step_min: u32) -> anyhow::Result<Vec<i64>> {
    anyhow::ensure!(from_ms <= to_ms, "from is after to");
    match step_min {
        STEP_MIN => {}
        FINE_STEP_MIN => anyhow::ensure!(
            to_ms - from_ms <= FINE_WINDOW_MS,
            "step {FINE_STEP_MIN} is allowed for windows of at most 24 h; use step {STEP_MIN}"
        ),
        other => anyhow::bail!("step must be {STEP_MIN} or {FINE_STEP_MIN} minutes, got {other}"),
    }
    let step_ms = step_min as i64 * 60_000;
    let frame0 = align(from_ms, step_ms);
    let last = align(to_ms, step_ms);
    let count = ((last - frame0) / step_ms + 1) as usize;
    anyhow::ensure!(count <= MAX_CHUNK_FRAMES, "chunk of {count} frames exceeds {MAX_CHUNK_FRAMES}; narrow the window");
    Ok((0..count as i64).map(|i| frame0 + i * step_ms).collect())
}

fn layouts(app: &App) -> Vec<Layout> {
    app.regions.iter().map(|r| r.layout).collect()
}

/// Does a stored frame body have exactly the shape of these layouts (one section per region,
/// each with its own sighting count)? A body stored under an older region or taxa layout does
/// not, and is rebuilt instead of being served.
pub fn body_matches(body: &[u8], layouts: &[Layout], taxa: usize) -> bool {
    let mut at = 0usize;
    for l in layouts {
        let n_off = at + l.sightings_offset(taxa);
        let Some(n) = body.get(n_off..n_off + 4) else { return false };
        let n = u32::from_le_bytes(n.try_into().expect("4 bytes")) as usize;
        at += l.body_len(taxa, n);
    }
    at == body.len()
}

/// One snapshot per region over `[from, to)`.
async fn snapshots(db: &Db, app: &App, from: i64, to: i64) -> anyhow::Result<Vec<Snapshot>> {
    let mut out = Vec::with_capacity(app.regions.len());
    for r in &app.regions {
        out.push(Snapshot::load_app(db, app, r, from, to).await?);
    }
    Ok(out)
}

/// An EVF2 chunk of every frame at `step_min` from `from_ms` to `to_ms` (see `chunk_times`).
pub async fn chunk(db: &Db, app: &App, from_ms: i64, to_ms: i64, step_min: u32) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(app.is_species(), "app {} has no hotspot grid (kind conditions), so no frames", app.id());
    let times = chunk_times(from_ms, to_ms, step_min)?;
    let step_ms = step_min as i64 * 60_000;
    let (frame0, last) = (times[0], times[times.len() - 1]);
    let layouts = layouts(app);
    let stored_step = step_min == STEP_MIN;

    let mut bodies: HashMap<i64, Vec<u8>> = HashMap::with_capacity(times.len());
    if stored_step {
        let stored: Vec<(i64, Vec<u8>)> = db
            .read(move |c| {
                let mut st = c.prepare("select frame_at, payload from frames where frame_at >= ?1 and frame_at <= ?2")?;
                let rows = st
                    .query_map(rusqlite::params![frame0, last], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await?;
        let check = layouts.clone();
        let taxa = app.taxa.len();
        let decoded = tokio::task::spawn_blocking(move || {
            stored.into_par_iter().map(|(t, p)| decompress(&p).map(|b| (t, b))).collect::<anyhow::Result<Vec<_>>>()
        })
        .await??;
        let (good, stale): (Vec<_>, Vec<_>) = decoded.into_iter().partition(|(_, b)| body_matches(b, &check, taxa));
        if !stale.is_empty() {
            tracing::warn!(app = app.id(), "{} stored frames do not match the current region/taxa layout; rebuilding them", stale.len());
        }
        bodies.extend(good);
    }
    let missing: Vec<i64> = times.iter().copied().filter(|t| !bodies.contains_key(t)).collect();
    if let (Some(first), Some(end)) = (missing.first().copied(), missing.last().copied()) {
        let snaps = snapshots(db, app, first, end + step_ms).await?;
        let layouts = layouts.clone();
        let (built, packed) = tokio::task::spawn_blocking(move || {
            let built = build_bodies(&snaps, &layouts, &missing, step_ms);
            let packed = if stored_step { built.par_iter().map(|(t, b)| (*t, compress(b))).collect() } else { Vec::new() };
            (built, packed)
        })
        .await?;
        if stored_step {
            persist(db, packed).await?;
        }
        bodies.extend(built);
    }

    let empty: usize = layouts.iter().map(|l| l.body_len(app.taxa.len(), 0)).sum();
    let mut out = Vec::with_capacity(header_len(layouts.len()) + times.len() * empty);
    write_header(&mut out, &layouts, app.taxa.len(), times.len() as u32, frame0, step_min);
    for t in &times {
        out.extend_from_slice(&bodies[t]);
    }
    Ok(out)
}

/// Build and store every hourly frame from `from_ms` to `to_ms` (aligned down, inclusive),
/// one day of frames at a time so a month-long rebuild holds one day of readings in memory.
pub async fn rebuild(db: &Db, app: &App, from_ms: i64, to_ms: i64) -> anyhow::Result<(i64, i64)> {
    anyhow::ensure!(app.is_species(), "app {} has no hotspot grid (kind conditions), so no frames", app.id());
    let from = align(from_ms, STEP_MS);
    let to = align(to_ms, STEP_MS);
    anyhow::ensure!(from <= to, "rebuild window is empty");
    let layouts = layouts(app);
    let mut batch_start = from;
    while batch_start <= to {
        let batch_end = (batch_start + DAY_MS).min(to + STEP_MS);
        let times: Vec<i64> = (batch_start..batch_end).step_by(STEP_MS as usize).collect();
        let snaps = snapshots(db, app, batch_start, batch_end).await?;
        let layouts = layouts.clone();
        let packed = tokio::task::spawn_blocking(move || build_packed(&snaps, &layouts, &times, STEP_MS)).await?;
        persist(db, packed).await?;
        batch_start = batch_end;
    }
    Ok((from, to))
}

/// Drop stored frames older than `before_ms`.
pub async fn prune(db: &Db, before_ms: i64) -> anyhow::Result<usize> {
    db.write(move |tx| tx.execute("delete from frames where frame_at < ?1", [before_ms])).await
}

#[derive(Debug, Deserialize)]
pub struct FramesQuery {
    pub from: String,
    pub to: String,
    pub step: Option<u32>,
}

/// Unix ms, or RFC 3339.
pub fn parse_time(s: &str) -> anyhow::Result<i64> {
    let s = s.trim();
    if let Ok(ms) = s.parse::<i64>() {
        return Ok(ms);
    }
    Ok(chrono::DateTime::parse_from_rfc3339(s).map_err(|e| anyhow::anyhow!("bad time {s:?}: {e}"))?.timestamp_millis())
}

pub fn routes() -> Router<AppRegistry> {
    Router::new().route("/frames", get(bulk))
}

async fn bulk(state: AppState, Query(q): Query<FramesQuery>) -> Response {
    if !state.app.is_species() {
        return crate::app::json_error(
            StatusCode::NOT_FOUND,
            "no_frames",
            serde_json::json!({ "app": state.app.id(), "kind": "conditions", "message": "this app has no hotspot grid; use readings, alerts and locations" }),
        );
    }
    let parsed = parse_time(&q.from).and_then(|from| Ok((from, parse_time(&q.to)?)));
    let (from, to) = match parsed {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    };
    let step = q.step.unwrap_or(STEP_MIN);
    if let Err(e) = chunk_times(from, to, step) {
        return (StatusCode::BAD_REQUEST, e.to_string()).into_response();
    }
    let bytes = match chunk(&state.obs, &state.app, from, to, step).await {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(app = state.app.id(), "frames chunk failed: {e:#}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "frames unavailable").into_response();
        }
    };
    let body = match tokio::task::spawn_blocking(move || gzip(&bytes)).await {
        Ok(b) => b,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    (
        [
            (header::CONTENT_TYPE, CONTENT_TYPE),
            (header::CONTENT_ENCODING, "gzip"),
            (header::CACHE_CONTROL, "private, max-age=60"),
        ],
        body,
    )
        .into_response()
}

fn merge(pending: Option<(i64, i64)>, from: i64, to: i64) -> (i64, i64) {
    match pending {
        Some((f, t)) => (f.min(from), t.max(to)),
        None => (from, to),
    }
}

/// Start the frame builder for a species app. A conditions app has no frames; nothing is spawned.
pub fn spawn_builder(state: AppState) {
    spawn_builder_with(state, DEBOUNCE);
}

pub fn spawn_builder_with(state: AppState, debounce_for: Duration) {
    if !state.app.is_species() {
        tracing::info!(app = state.app.id(), "no frame builder: conditions app");
        return;
    }
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
                        tracing::warn!(app = state.app.id(), "frame builder lagged {n} events; rebuilding the whole window");
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
                    match rebuild(&state.obs, &state.app, from, now).await {
                        Ok((f, t)) => {
                            tracing::info!(
                                app = state.app.id(),
                                "frames rebuilt {}..{} ({} frames) in {:?}",
                                f,
                                t,
                                (t - f) / STEP_MS + 1,
                                started.elapsed()
                            );
                            state.hub.publish(Event::FramesUpdated { from: f, to: t });
                        }
                        Err(e) => tracing::warn!(app = state.app.id(), "frame rebuild failed: {e:#}"),
                    }
                    if let Err(e) = prune(&state.obs, now - WINDOW_MS - DAY_MS).await {
                        tracing::warn!(app = state.app.id(), "frame prune failed: {e:#}");
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::config::{AppConfig, Taxon};
    use crate::hotspot::score::testkit::*;
    use crate::hotspot::score::{ReadingPt, SightingPt, FLAG_CONFLICT, FLAG_DUPLICATE, FLAG_LATE};

    fn i16_at(b: &[u8], o: usize) -> i16 {
        i16::from_le_bytes(b[o..o + 2].try_into().unwrap())
    }

    fn u32_at(b: &[u8], o: usize) -> u32 {
        u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
    }

    /// Hotspot byte of `taxon` at scoring cell (col, row) inside one region body.
    fn hs_at(layout: &Layout, body: &[u8], taxon: &Taxon, col: u32, row: u32) -> u8 {
        body[taxon.idx as usize * layout.hs.cells() + layout.hs.index(col / HS_FACTOR, row / HS_FACTOR)]
    }

    /// The python taxa (4) with the seeded db ids.
    fn taxa() -> Vec<Taxon> {
        python_app().taxa
    }

    /// The fixed seed input behind `spec/frames/sample.evf`: a 20 × 10 scoring grid (10 × 5
    /// hotspot, 4 × 2 environment), three hourly frames from 2025-02-01 00:00 UTC, one sighting
    /// of each species plus a NAS prior, a duplicate, a conflict and a late record, and four
    /// stations with mixed valid and flagged readings.
    fn golden_input() -> (Snapshot, Layout, Vec<i64>) {
        let layout = Layout::for_grid(Grid { west: -80.5, south: 25.2, cell_deg: 0.01, cols: 20, rows: 10 }).unwrap();
        let grid = layout.grid;
        let t0 = ms(2025, 2, 1, 0);
        let min = 60_000;
        let pt = |id: i64, taxon_id: i64, col: u32, row: u32, observed_at: i64, prior: bool, quality: u8, flags: u8| {
            let (lon, lat) = grid.center(grid.index(col, row));
            SightingPt { id, taxon_id, lon: lon as f32, lat: lat as f32, col, row, observed_at, prior, quality, flags }
        };
        let sightings = vec![
            pt(1, 1, 2, 2, t0 - 2 * HOUR, false, 0, 0),
            pt(2, 2, 5, 1, t0 - 3 * DAY, false, 1, 0),
            pt(3, 3, 6, 4, t0 + 5 * min, false, 0, 0),
            pt(4, 4, 1, 5, t0 - 10 * DAY, false, 3, 0),
            pt(5, 1, 17, 0, t0 - 400 * DAY, true, 3, 0),
            pt(6, 1, 2, 2, t0 + 80 * min, false, 0, FLAG_DUPLICATE),
            pt(7, 2, 14, 8, t0 + 125 * min, false, 2, FLAG_CONFLICT | FLAG_LATE),
            pt(8, 4, 3, 3, t0 + 140 * min, false, 2, 0),
            pt(9, 1, 0, 0, t0 + 170 * min, false, 0, 0),
        ];
        let at = |col: u32, row: u32| {
            let (lon, lat) = grid.center(grid.index(col, row));
            (lat, lon)
        };
        // NWS grid point, NDBC buoy, two GOES g5 cells (at the env cell centres (0,0) and (1,0)).
        let stations = vec![at(3, 3), at(0, 5), at(2, 2), at(7, 2)];
        let mut readings: [Vec<ReadingPt>; 6] = Default::default();
        let r = |station: u32, observed_at: i64, value: f32| ReadingPt { station, observed_at, value };
        readings[CondParam::AirC as usize] = vec![r(0, t0 - HOUR, 8.0), r(0, t0 + 80 * min, 11.0)];
        readings[CondParam::WaveM as usize] = vec![r(1, t0 - 30 * min, 0.4)];
        readings[CondParam::WindMs as usize] = vec![r(1, t0 - 30 * min, 3.0), r(1, t0 + 100 * min, 9.5)];
        readings[CondParam::LstC as usize] = vec![r(2, t0 - 20 * min, 12.25), r(3, t0 - 20 * min, f32::NAN)];
        readings[CondParam::SstC as usize] = vec![r(3, t0 - 20 * min, 24.0), r(2, t0 - 20 * min, f32::NAN)];
        readings[CondParam::StageM as usize] = vec![r(0, t0 - 2 * HOUR, 1.0)];
        let times = vec![t0, t0 + STEP_MS, t0 + 2 * STEP_MS];
        (Snapshot::new(grid, taxa(), t0, t0 + 3 * STEP_MS, sightings, stations, readings), layout, times)
    }

    fn golden_bytes() -> Vec<u8> {
        let (snap, layout, times) = golden_input();
        let mut out = Vec::new();
        write_header(&mut out, &[layout], 4, times.len() as u32, times[0], STEP_MIN);
        for (_, body) in build_bodies(&[snap], &[layout], &times, STEP_MS) {
            out.extend_from_slice(&body);
        }
        out
    }

    fn golden_check(name: &str, bytes: &[u8]) {
        let path = format!("{}/../spec/frames/{name}", env!("CARGO_MANIFEST_DIR"));
        if std::env::var("EVF_UPDATE_GOLDEN").is_ok() {
            std::fs::create_dir_all(std::path::Path::new(&path).parent().unwrap()).unwrap();
            std::fs::write(&path, bytes).unwrap();
        }
        let golden = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
        assert_eq!(bytes.len(), golden.len(), "{name}: golden length");
        assert!(bytes == golden, "writer output differs from spec/frames/{name}");
    }

    #[test]
    fn evf_golden() {
        let bytes = golden_bytes();
        golden_check("sample.evf", &bytes);
        let app = python_app();
        let (iguana, lionfish, tegu, python) = (app.taxon("iguana").unwrap(), app.taxon("lionfish").unwrap(), app.taxon("tegu").unwrap(), app.taxon("python").unwrap());

        // The file decodes as documented in apps/web/shared/frames.ts.
        let (_, layout, times) = golden_input();
        let h = read_header(&bytes).unwrap();
        assert_eq!(
            h,
            Header {
                frame_count: 3,
                hs: layout.hs,
                env: layout.env,
                frame0: times[0],
                step_min: 60,
                species_count: 4,
                hotspot_scale: HOTSPOT_SCALE,
                region_count: 1,
                regions: vec![(layout.hs, layout.env)],
            }
        );
        assert_eq!(h.len(), HEADER_BYTES, "a single-region file has no region table");
        assert_eq!((layout.hs.cols, layout.hs.rows, layout.env.cols, layout.env.rows), (10, 5, 4, 2));
        assert_eq!(layout.hotspot_bytes(4), 200);
        assert_eq!(layout.lst_offset(4), 200);
        assert_eq!(layout.sst_offset(4), 216);
        assert_eq!(layout.sightings_offset(4), 232);
        assert_eq!(bytes.len(), HEADER_BYTES + 3 * layout.body_len(4, 0) + (1 + 1 + 3) * SIGHTING_BYTES);
        let mut o = HEADER_BYTES;
        let mut counts = Vec::new();
        for frame in 0..3usize {
            let body = &bytes[o..];
            // Iguana observed 00:05 at (6,4): nothing at 00:00, cold stun (8 °C air) at 01:00,
            // lifted by the 11 °C reading at 01:20 for the 02:00 frame. u8 = score / 0.01.
            let want = match frame {
                0 => 0,
                1 => 200,
                _ => 100,
            };
            assert_eq!(hs_at(&layout, body, iguana, 6, 4), want, "iguana frame {frame}");
            // Lionfish at (1,5): calm until the 9.5 m/s wind at 01:40 (0.1 → 10).
            assert_eq!(hs_at(&layout, body, lionfish, 1, 5), if frame < 2 { 100 } else { 10 }, "frame {frame}");
            // Tegu in February brumates (0.3 → 30); the whole 2 × 2 parent shares the max.
            assert_eq!(hs_at(&layout, body, tegu, 5, 1), 30);
            assert_eq!(hs_at(&layout, body, tegu, 4, 0), 30);
            // Python at (2,2): 8 °C suppresses (0.3) and the 1 m stage gives 1.2 → 0.36 → 36.
            assert_eq!(hs_at(&layout, body, python, 2, 2), 36);
            // The NAS prior at (17,0) is 0.2 of the recent sighting's weight: 0.2 × 0.36 → 7.
            assert_eq!(hs_at(&layout, body, python, 17, 0), 7);
            // LST is valid only at the g5 (0,0) pixel: env (0,0) reads 12.25 °C, env (1,1) is out
            // of reach. SST is valid only at g5 (1,0): env (1,0) reads 24 °C, env (3,1) is missing.
            let lst = layout.lst_offset(4);
            assert_eq!(i16_at(body, lst + layout.env.index(0, 0) * 2), 1225);
            assert_eq!(i16_at(body, lst + layout.env.index(1, 1) * 2), ENV_MISSING);
            // Each pixel's flagged parameter is a gap, not the valid neighbour one g5 cell away
            // (PRD §7: never interpolated).
            assert_eq!(i16_at(body, lst + layout.env.index(1, 0) * 2), ENV_FLAGGED);
            let sst = layout.sst_offset(4);
            assert_eq!(i16_at(body, sst + layout.env.index(1, 0) * 2), 2400);
            assert_eq!(i16_at(body, sst + layout.env.index(0, 0) * 2), ENV_FLAGGED);
            assert_eq!(i16_at(body, sst + layout.env.index(3, 1) * 2), ENV_MISSING);
            let n = u32_at(body, layout.sightings_offset(4)) as usize;
            counts.push(n);
            o += layout.body_len(4, n);
        }
        assert_eq!(counts, vec![1, 1, 3], "sightings per hourly window");
        assert_eq!(o, bytes.len());
        // Frame 0's record is the iguana (id 3); frame 1's is the flagged duplicate (id 6).
        let rec = &bytes[HEADER_BYTES + layout.sightings_offset(4) + 4..];
        assert_eq!(u32_at(rec, 0), 3);
        assert_eq!(u16::from_le_bytes([rec[12], rec[13]]), 3);
        let rec = &bytes[HEADER_BYTES + layout.body_len(4, 1) + layout.sightings_offset(4) + 4..];
        assert_eq!(u32_at(rec, 0), 6);
        assert_eq!(f32::from_le_bytes(rec[4..8].try_into().unwrap()), layout.grid.center(layout.grid.index(2, 2)).0 as f32);
        assert_eq!(u16::from_le_bytes([rec[12], rec[13]]), 1);
        assert_eq!(rec[14], 0);
        assert_eq!(rec[15], FLAG_DUPLICATE);
        // Frame 2's three records, in observation order: ids 7, 8, 9.
        let recs = &bytes[HEADER_BYTES + layout.body_len(4, 1) * 2 + layout.sightings_offset(4) + 4..];
        assert_eq!((0..3).map(|k| u32_at(recs, k * SIGHTING_BYTES)).collect::<Vec<_>>(), vec![7, 8, 9]);
    }

    /// A synthetic two-region app (lionfish-like: one taxon) on two small grids. Region A is
    /// the golden grid, region B a 30 × 20 grid to its east with one sighting and one SST pixel.
    fn two_region_app() -> App {
        let mut v: serde_json::Value = serde_json::from_str(crate::app::config::builtin_json("lionfish").unwrap()).unwrap();
        v["regions"] = serde_json::json!([
            { "id": "west", "name": "West", "bbox": [-80.5, 25.2, -80.3, 25.3], "cellDeg": 0.01, "camera": { "lat": 25.25, "lon": -80.4, "heightM": 50000 } },
            { "id": "east", "name": "East", "bbox": [-80.2, 25.2, -79.9, 25.4], "cellDeg": 0.01, "camera": { "lat": 25.3, "lon": -80.05, "heightM": 50000 } }
        ]);
        let cfg = AppConfig::parse("two-regions.json", &v.to_string()).unwrap();
        let mut app = App::new(cfg).unwrap();
        app.taxa[0].taxon_id = 4;
        app
    }

    fn two_region_input(app: &App) -> (Vec<Snapshot>, Vec<Layout>, Vec<i64>) {
        let t0 = ms(2025, 2, 1, 0);
        let min = 60_000;
        let mut snaps = Vec::new();
        for (i, region) in app.regions.iter().enumerate() {
            let grid = region.grid;
            let pt = |id: i64, col: u32, row: u32, observed_at: i64, quality: u8, flags: u8| {
                let (lon, lat) = grid.center(grid.index(col, row));
                SightingPt { id, taxon_id: 4, lon: lon as f32, lat: lat as f32, col, row, observed_at, prior: false, quality, flags }
            };
            let at = |col: u32, row: u32| {
                let (lon, lat) = grid.center(grid.index(col, row));
                (lat, lon)
            };
            let mut readings: [Vec<ReadingPt>; 6] = Default::default();
            let (sightings, stations) = if i == 0 {
                readings[CondParam::WaveM as usize] = vec![ReadingPt { station: 0, observed_at: t0 - 30 * min, value: 0.4 }];
                (vec![pt(1, 2, 2, t0 - 2 * HOUR, 0, 0), pt(2, 5, 1, t0 + 70 * min, 1, FLAG_LATE)], vec![at(0, 5)])
            } else {
                readings[CondParam::SstC as usize] = vec![ReadingPt { station: 0, observed_at: t0 - 20 * min, value: 24.0 }];
                readings[CondParam::WaveM as usize] = vec![ReadingPt { station: 0, observed_at: t0 - 20 * min, value: 2.5 }];
                (vec![pt(3, 10, 10, t0 - HOUR, 0, 0), pt(4, 20, 15, t0 + 130 * min, 2, FLAG_CONFLICT)], vec![at(2, 2)])
            };
            snaps.push(Snapshot::new(grid, app.taxa.clone(), t0, t0 + 3 * STEP_MS, sightings, stations, readings));
        }
        (snaps, app.regions.iter().map(|r| r.layout).collect(), vec![t0, t0 + STEP_MS, t0 + 2 * STEP_MS])
    }

    /// Two regions: the header carries the count and a descriptor per region, each frame is
    /// region A's body then region B's, and the file round-trips through `read_header`.
    /// `spec/frames/two-regions.evf` is the golden vector for the TS reader.
    #[test]
    fn frames_regions_round_trip() {
        let app = two_region_app();
        let (snaps, layouts, times) = two_region_input(&app);
        let mut bytes = Vec::new();
        write_header(&mut bytes, &layouts, 1, times.len() as u32, times[0], STEP_MIN);
        assert_eq!(bytes.len(), HEADER_BYTES + 2 * REGION_DESC_BYTES);
        for (_, body) in build_bodies(&snaps, &layouts, &times, STEP_MS) {
            bytes.extend_from_slice(&body);
        }
        golden_check("two-regions.evf", &bytes);

        let h = read_header(&bytes).unwrap();
        assert_eq!((h.frame_count, h.species_count, h.region_count, h.step_min, h.frame0), (3, 1, 2, 60, times[0]));
        assert_eq!(h.len(), header_len(2));
        assert_eq!(h.regions, vec![(layouts[0].hs, layouts[0].env), (layouts[1].hs, layouts[1].env)]);
        assert_eq!((h.hs, h.env), (layouts[0].hs, layouts[0].env), "the base fields describe region 0");
        assert_eq!((h.regions[1].0.cols, h.regions[1].0.rows, h.regions[1].1.cols, h.regions[1].1.rows), (15, 10, 6, 4));
        assert_eq!(u32_at(&bytes, 68), 2, "region count sits in the former reserved word");

        // Walk the frames: per frame, region A then region B, each with its own sighting count.
        let lionfish = &app.taxa[0];
        let mut o = h.len();
        let mut counts = Vec::new();
        for frame in 0..3usize {
            let mut per_region = Vec::new();
            for (ri, layout) in layouts.iter().enumerate() {
                let body = &bytes[o..];
                let n = u32_at(body, layout.sightings_offset(1)) as usize;
                per_region.push(n);
                if ri == 0 {
                    // Calm sea in the west: the 2 h-old sighting at (2,2) scores 1.0 → 100.
                    assert_eq!(hs_at(layout, body, lionfish, 2, 2), 100, "west frame {frame}");
                    assert_eq!(i16_at(body, layout.sst_offset(1)), ENV_MISSING, "no SST pixel in the west");
                } else {
                    // Rough sea in the east (2.5 m): 0.1 → 10; SST 24 °C at env cell (0,0).
                    assert_eq!(hs_at(layout, body, lionfish, 10, 10), 10, "east frame {frame}");
                    assert_eq!(i16_at(body, layout.sst_offset(1) + layout.env.index(0, 0) * 2), 2400);
                }
                o += layout.body_len(1, n);
            }
            counts.push(per_region);
        }
        assert_eq!(o, bytes.len(), "the file is exactly its frames");
        assert_eq!(counts, vec![vec![0, 0], vec![1, 0], vec![0, 1]], "sightings per region per hourly window");
        // The east sighting record in frame 2 is id 4 with the conflict flag.
        let frame2 = h.len() + (0..2).map(|f| layouts.iter().enumerate().map(|(ri, l)| l.body_len(1, counts[f][ri])).sum::<usize>()).sum::<usize>();
        let east = frame2 + layouts[0].body_len(1, 0);
        let rec = &bytes[east + layouts[1].sightings_offset(1) + 4..];
        assert_eq!((u32_at(rec, 0), rec[14], rec[15]), (4, 2, FLAG_CONFLICT));
    }

    /// The same two-region app through `chunk` and `rebuild` on a real database: stored bodies
    /// hold every region, and a sighting lands in its own region's section only.
    #[tokio::test]
    async fn frames_regions_chunk_from_db() {
        let db = Db::memory("observations");
        seed_sources(&db).await;
        let app = two_region_app();
        let (west, east) = (&app.regions[0], &app.regions[1]);
        let t0 = ms(2025, 6, 1, 12);
        let (lon, lat) = east.grid.center(east.grid.index(5, 5));
        insert_sighting(&db, "inat", 4, lat, lon, t0 + 7 * 60_000, "research", None).await;
        let bytes = chunk(&db, &app, t0, t0 + HOUR, 60).await.unwrap();
        let h = read_header(&bytes).unwrap();
        assert_eq!((h.frame_count, h.region_count), (2, 2));
        let f0 = &bytes[h.len()..];
        let (lw, le) = (west.layout, east.layout);
        assert_eq!(u32_at(f0, lw.sightings_offset(1)), 0, "west carries no record");
        let f0_east = &f0[lw.body_len(1, 0)..];
        assert_eq!(u32_at(f0_east, le.sightings_offset(1)), 1, "east carries the record");
        let f1 = &bytes[h.len() + lw.body_len(1, 0) + le.body_len(1, 1)..];
        assert_eq!(hs_at(&lw, f1, &app.taxa[0], 5, 5), 0);
        // A component app (lionfish config): rankScore = (recentReports 1 + idQuality 0 (no accuracy)
        // + heatStress unknown) / 3, quantized.
        assert_eq!(hs_at(&le, &f1[lw.body_len(1, 0)..], &app.taxa[0], 5, 5), 33);
        assert_eq!(bytes.len(), h.len() + 2 * (lw.body_len(1, 0) + le.body_len(1, 0)) + SIGHTING_BYTES);
        let stored: i64 = db.read(|c| c.query_row("select count(*) from frames", [], |r| r.get(0))).await.unwrap();
        assert_eq!(stored, 2);
        rebuild(&db, &app, t0, t0 + HOUR).await.unwrap();
        assert_eq!(chunk(&db, &app, t0, t0 + HOUR, 60).await.unwrap(), bytes);
        // A body stored under another layout (here: python's single big region) is detected and
        // rebuilt rather than served under the wrong header.
        let python = python_app();
        assert!(!body_matches(&bytes[h.len()..h.len() + lw.body_len(1, 0) + le.body_len(1, 1)], &[python.regions[0].layout], 4));
        assert!(body_matches(&bytes[h.len()..h.len() + lw.body_len(1, 0) + le.body_len(1, 1)], &[lw, le], 1));
        let stale = compress(&[0u8; 100]);
        db.write(move |tx| tx.execute("update frames set payload = ?1 where frame_at = ?2", rusqlite::params![stale, t0])).await.unwrap();
        assert_eq!(chunk(&db, &app, t0, t0 + HOUR, 60).await.unwrap(), bytes, "stale body rebuilt");
    }

    /// Lionfish Watch (4 regions, 1 taxon) frames as the API builds them after a `--fixtures`
    /// backfill: every recorded fixture source is ingested into an in-memory lionfish state, then
    /// `chunk` builds 2026-01-11 06:00 and 07:00 UTC. The fixtures hold lionfish only in Florida
    /// (region 0: the iNat record and its GBIF copy at 06:50), so two synthetic iNat rows are
    /// injected: one off Cozumel (region 1, 06:20) and one off Cartagena (region 3, 07:30).
    /// `spec/frames/lionfish.evf` is the golden vector for the TS reader.
    #[tokio::test]
    async fn frames_regions_lionfish_golden() {
        let state = crate::app::test_support::test_state_for("lionfish");
        let root = crate::backfill::fixtures_root();
        for src in crate::backfill::fixture_sources(&state) {
            crate::backfill::ingest_fixtures(&state, src.as_ref(), &root).await.unwrap();
        }
        let app = &state.app;
        let lionfish = app.taxa[0].taxon_id;
        let t0 = ms(2026, 1, 11, 6);
        let min = 60_000;
        insert_sighting(&state.obs, "inat", lionfish, 20.42, -86.92, t0 + 20 * min, "research", None).await;
        insert_sighting(&state.obs, "inat", lionfish, 10.40, -75.55, t0 + 90 * min, "research", None).await;
        let bytes = chunk(&state.obs, app, t0, t0 + HOUR, 60).await.unwrap();
        golden_check("lionfish.evf", &bytes);

        let layouts = layouts(app);
        let h = read_header(&bytes).unwrap();
        assert_eq!((h.frame_count, h.species_count, h.region_count, h.step_min, h.frame0), (2, 1, 4, 60, t0));
        assert_eq!(h.len(), HEADER_BYTES + 4 * REGION_DESC_BYTES);
        assert_eq!(h.regions, layouts.iter().map(|l| (l.hs, l.env)).collect::<Vec<_>>());
        let mut o = h.len();
        let mut counts = Vec::new();
        for _ in 0..2 {
            let mut per_region = Vec::new();
            for l in &layouts {
                let body = &bytes[o..];
                let n = u32_at(body, l.sightings_offset(1)) as usize;
                for k in 0..n {
                    let rec = &body[l.sightings_offset(1) + 4 + k * SIGHTING_BYTES..];
                    let lon = f32::from_le_bytes(rec[4..8].try_into().unwrap()) as f64;
                    let lat = f32::from_le_bytes(rec[8..12].try_into().unwrap()) as f64;
                    assert!(l.grid.col_row(lon, lat).is_some(), "record ({lon}, {lat}) outside its region");
                    assert_eq!(u16::from_le_bytes([rec[12], rec[13]]) as i64, lionfish);
                }
                per_region.push(n);
                o += l.body_len(1, n);
            }
            counts.push(per_region);
        }
        assert_eq!(o, bytes.len(), "the file is exactly its frames");
        assert_eq!(counts, vec![vec![2, 1, 0, 0], vec![0, 0, 0, 1]], "sightings per region per hourly window");
    }

    #[test]
    fn frames_header_layout_matches_ts_reader() {
        let app = python_app();
        let layout = app.regions[0].layout;
        assert_eq!(Layout::for_grid(app.regions[0].grid).unwrap(), layout);
        let mut out = Vec::new();
        write_header(&mut out, &[layout], 4, 7, 1_700_000_000_000, 60);
        assert_eq!(out.len(), HEADER_BYTES);
        assert_eq!(&out[..4], b"EVF2");
        assert_eq!(u32_at(&out, 4), 7);
        assert_eq!(u32_at(&out, 8), 170);
        assert_eq!(u32_at(&out, 12), 160);
        assert_eq!(f64::from_le_bytes(out[16..24].try_into().unwrap()), layout.grid.west);
        assert_eq!(f64::from_le_bytes(out[24..32].try_into().unwrap()), layout.grid.south);
        assert_eq!(f64::from_le_bytes(out[32..40].try_into().unwrap()), 0.02);
        assert_eq!(i64::from_le_bytes(out[40..48].try_into().unwrap()), 1_700_000_000_000);
        assert_eq!(u32_at(&out, 48), 60);
        assert_eq!(u32_at(&out, 52), 4);
        assert_eq!(u16::from_le_bytes([out[56], out[57]]), 68);
        assert_eq!(u16::from_le_bytes([out[58], out[59]]), 64);
        assert_eq!(f32::from_le_bytes(out[60..64].try_into().unwrap()), 0.05f32);
        assert_eq!(f32::from_le_bytes(out[64..68].try_into().unwrap()), 0.01f32);
        assert_eq!(u32_at(&out, 68), 1, "region count");
        let h = read_header(&out).unwrap();
        assert_eq!((h.hs, h.env), (layout.hs, layout.env));
        // Section offsets on the python layout: 108,800 hotspot bytes, 4,352 env cells.
        assert_eq!(layout.hotspot_bytes(4), 108_800);
        assert_eq!(layout.lst_offset(4), 108_800);
        assert_eq!(layout.sst_offset(4), 108_800 + 8_704);
        assert_eq!(layout.sightings_offset(4), 108_800 + 17_408);
        assert_eq!(layout.body_len(4, 0), 126_212);
        // One taxon (lionfish app) shrinks only the hotspot section.
        assert_eq!(layout.body_len(1, 0), 27_200 + 17_408 + 4);
        assert!(Layout::for_grid(Grid { cols: 25, ..layout.grid }).is_err());
        assert_eq!(align(1_700_000_123_456, STEP_MS), 1_699_999_200_000);
        assert_eq!(align(-1, STEP_MS), -STEP_MS);
        assert_eq!(quantize_score(2.0), 200);
        assert_eq!(quantize_score(9.0), 255);
        assert_eq!(quantize_env(Some(-3.456)), -346);
        assert_eq!(quantize_env(Some(f32::NAN)), ENV_MISSING);
        assert_eq!(quantize_env(None), ENV_MISSING);
        // A value never lands on a sentinel.
        assert_eq!(quantize_env(Some(-400.0)), ENV_FLAGGED + 1);
        let round = compress(&out);
        assert_eq!(decompress(&round).unwrap(), out);
        assert_eq!(parse_time("1738368000000").unwrap(), 1_738_368_000_000);
        assert_eq!(parse_time("2025-02-01T00:00:00Z").unwrap(), 1_738_368_000_000);
        assert_eq!(parse_time("2025-02-01T02:00:00+02:00").unwrap(), 1_738_368_000_000);
        assert!(parse_time("yesterday").is_err());
        assert_eq!(header_len(1), HEADER_BYTES);
        assert_eq!(header_len(4), HEADER_BYTES + 4 * REGION_DESC_BYTES);
    }

    #[test]
    fn frames_chunk_times_validation() {
        let t0 = ms(2025, 6, 1, 12);
        assert_eq!(chunk_times(t0 + 1, t0 + 2 * HOUR + 40 * 60_000, 60).unwrap(), vec![t0, t0 + HOUR, t0 + 2 * HOUR]);
        assert_eq!(chunk_times(t0, t0, 60).unwrap(), vec![t0]);
        assert_eq!(chunk_times(t0, t0 + DAY, 15).unwrap().len(), 97);
        assert!(chunk_times(t0, t0 + DAY + 1, 15).is_err(), "15 min only up to 24 h");
        assert!(chunk_times(t0, t0 + HOUR, 30).is_err(), "only 15 or 60");
        assert_eq!(chunk_times(t0, t0 + 743 * HOUR, 60).unwrap().len(), 744);
        assert!(chunk_times(t0, t0 + 744 * HOUR, 60).is_err(), "over the cap");
        assert!(chunk_times(t0, t0 - 1, 60).is_err());
    }

    #[tokio::test]
    async fn frames_chunk_stores_and_reuses_bodies() {
        let db = Db::memory("observations");
        seed_sources(&db).await;
        let app = python_app();
        let (lionfish, python) = (app.taxon("lionfish").unwrap(), app.taxon("python").unwrap());
        let layout = app.regions[0].layout;
        let g = layout.grid;
        let t0 = ms(2025, 6, 1, 12);
        let (lon, lat) = g.center(g.index(50, 60));
        let id = insert_sighting(&db, "inat", 4, lat, lon, t0 + 7 * 60_000, "research", None).await;
        let bytes = chunk(&db, &app, t0 + 60_000, t0 + 2 * HOUR + 40 * 60_000, 60).await.unwrap();
        let h = read_header(&bytes).unwrap();
        assert_eq!(h.frame_count, 3, "12:00, 13:00, 14:00");
        assert_eq!(h.frame0, t0);
        assert_eq!(h.hs, layout.hs);
        let stored: i64 = db.read(|c| c.query_row("select count(*) from frames", [], |r| r.get(0))).await.unwrap();
        assert_eq!(stored, 3);
        // Frame 0 carries the sighting; frames 1 and 2 carry none. Lionfish density is 1.0 at
        // the cell from 13:00 on (observed 12:07 is after the 12:00 frame time).
        let f0 = &bytes[HEADER_BYTES..];
        assert_eq!(u32_at(f0, layout.sightings_offset(4)), 1);
        let f1 = &bytes[HEADER_BYTES + layout.body_len(4, 1)..];
        assert_eq!(u32_at(f1, layout.sightings_offset(4)), 0);
        assert_eq!(hs_at(&layout, f0, lionfish, 50, 60), 0);
        assert_eq!(hs_at(&layout, f1, lionfish, 50, 60), 100);
        assert_eq!(bytes.len(), HEADER_BYTES + 3 * layout.body_len(4, 0) + SIGHTING_BYTES);

        // Stored bodies are reused: change the row underneath and the chunk still reads the cache.
        db.write(move |tx| tx.execute("update sightings set taxon_id = 1 where id = ?1", [id])).await.unwrap();
        let again = chunk(&db, &app, t0, t0 + 2 * HOUR, 60).await.unwrap();
        assert_eq!(again, bytes);
        // A rebuild refreshes them.
        rebuild(&db, &app, t0, t0 + 2 * HOUR).await.unwrap();
        let fresh = chunk(&db, &app, t0, t0 + 2 * HOUR, 60).await.unwrap();
        assert_ne!(fresh, bytes);
        let f1 = &fresh[HEADER_BYTES + layout.body_len(4, 1)..];
        assert_eq!(hs_at(&layout, f1, python, 50, 60), 100);
        assert_eq!(hs_at(&layout, f1, lionfish, 50, 60), 0);
        // A 15-minute chunk is built on the fly with its own sighting window and not stored.
        let fine = chunk(&db, &app, t0, t0 + 2 * HOUR, 15).await.unwrap();
        assert_eq!(read_header(&fine).unwrap().frame_count, 9);
        assert_eq!(u32_at(&fine[HEADER_BYTES..], layout.sightings_offset(4)), 1);
        assert_eq!(u32_at(&fine[HEADER_BYTES + layout.body_len(4, 1)..], layout.sightings_offset(4)), 0);
        let stored: i64 = db.read(|c| c.query_row("select count(*) from frames", [], |r| r.get(0))).await.unwrap();
        assert_eq!(stored, 3);
        assert!(chunk(&db, &app, t0, t0 + 800 * HOUR, 60).await.is_err(), "over the chunk cap");
        assert_eq!(prune(&db, t0 + STEP_MS).await.unwrap(), 1);
        // A conditions app has no frames at all.
        let carp = App::builtin("carp").unwrap();
        assert!(chunk(&db, &carp, t0, t0 + HOUR, 60).await.unwrap_err().to_string().contains("no hotspot grid"));
    }

    #[tokio::test]
    async fn frames_rest_route() {
        use axum::body::Body;
        use axum::http::Request;
        use http_body_util::BodyExt;
        use tower::ServiceExt;

        let (app, state) = crate::app::test_support::test_app();
        seed_sources(&state.obs).await;
        let layout = state.app.regions[0].layout;
        let python = state.app.taxon("python").unwrap();
        let g = layout.grid;
        let t0 = ms(2025, 6, 1, 12);
        let (lon, lat) = g.center(g.index(80, 90));
        insert_sighting(&state.obs, "inat", 1, lat, lon, t0 + 30 * 60_000, "research", None).await;
        let uri = format!("/v1/python/frames?from={}&to=2025-06-01T14:00:00Z", t0);
        let res = app.clone().oneshot(Request::get(&uri).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers().get(header::CONTENT_TYPE).unwrap(), CONTENT_TYPE);
        assert_eq!(res.headers().get(header::CONTENT_ENCODING).unwrap(), "gzip");
        let gz = res.into_body().collect().await.unwrap().to_bytes();
        let mut bytes = Vec::new();
        flate2::read::GzDecoder::new(&gz[..]).read_to_end(&mut bytes).unwrap();
        let h = read_header(&bytes).unwrap();
        assert_eq!(h.frame_count, 3, "12:00, 13:00, 14:00 hourly by default");
        assert_eq!(h.step_min, 60);
        assert_eq!(h.frame0, t0);
        assert_eq!((h.hs.cols, h.hs.rows, h.env.cols, h.env.rows), (170, 160, 68, 64));
        assert_eq!(bytes.len(), HEADER_BYTES + 3 * layout.body_len(4, 0) + SIGHTING_BYTES);
        assert!(gz.len() < bytes.len() / 10, "gzip {} of {} raw", gz.len(), bytes.len());
        assert_eq!(hs_at(&layout, &bytes[HEADER_BYTES + layout.body_len(4, 1)..], python, 80, 90), 100);

        // 15-minute frames for a short window; bad input is a 400.
        let fine = format!("/v1/python/frames?from={}&to={}&step=15", t0, t0 + HOUR);
        let res = app.clone().oneshot(Request::get(&fine).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let gz = res.into_body().collect().await.unwrap().to_bytes();
        let mut bytes = Vec::new();
        flate2::read::GzDecoder::new(&gz[..]).read_to_end(&mut bytes).unwrap();
        assert_eq!(read_header(&bytes).unwrap().frame_count, 5);
        for bad in [
            format!("/v1/python/frames?from={}&to={}&step=15", t0, t0 + 2 * DAY),
            format!("/v1/python/frames?from={}&to={}&step=20", t0, t0 + HOUR),
            format!("/v1/python/frames?from=yesterday&to={}", t0),
            format!("/v1/python/frames?from={}&to={}", t0 + 1, t0),
            "/v1/python/frames".to_string(),
        ] {
            let res = app.clone().oneshot(Request::get(&bad).body(Body::empty()).unwrap()).await.unwrap();
            assert_eq!(res.status(), StatusCode::BAD_REQUEST, "{bad}");
        }
    }

    #[tokio::test]
    async fn frames_builder_debounces_and_publishes() {
        let state = crate::app::test_support::test_state();
        seed_sources(&state.obs).await;
        let now = now_ms();
        let g = state.app.regions[0].grid;
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
        assert!(stored >= 2);
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

    /// 30 days × 24 hourly frames on the full grid from ~5k sightings and hourly readings,
    /// then one gzip of the whole month as the REST route would send it.
    /// `cargo test --release bench_frames -- --ignored --nocapture`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn bench_frames() {
        let db = Db::memory("observations");
        seed_sources(&db).await;
        let app = python_app();
        let layout = app.regions[0].layout;
        let g = layout.grid;
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
        let mut raw = Vec::new();
        write_header(&mut raw, &[layout], 4, 0, t_start, STEP_MIN);
        let mut frames = 0usize;
        let mut zlib_bytes = 0usize;
        let mut batch_start = t_start;
        while batch_start < t_end {
            let batch_end = (batch_start + DAY).min(t_end);
            let times: Vec<i64> = (batch_start..batch_end).step_by(STEP_MS as usize).collect();
            let snap = Snapshot::load(&db, &app.taxa, g, batch_start, batch_end).await.unwrap();
            let bodies = tokio::task::spawn_blocking(move || {
                let bodies = build_bodies(&[snap], &[layout], &times, STEP_MS);
                let zlib: usize = bodies.par_iter().map(|(_, b)| compress(b).len()).sum();
                (bodies, zlib)
            })
            .await
            .unwrap();
            frames += bodies.0.len();
            zlib_bytes += bodies.1;
            for (_, b) in bodies.0 {
                raw.extend_from_slice(&b);
            }
            batch_start = batch_end;
        }
        let build = started.elapsed();
        let gz = gzip(&raw);
        let elapsed = started.elapsed();
        assert_eq!(frames, 30 * 24);
        println!(
            "BENCH frames {frames} in {:.2}s ({} bytes/frame raw, {} KB gzip for 30 days, {} KB zlib stored, {} readings, build {:.2}s, {:.1} ms/frame)",
            elapsed.as_secs_f64(),
            (raw.len() - HEADER_BYTES) / frames,
            gz.len() / 1024,
            zlib_bytes / 1024,
            n_readings,
            build.as_secs_f64(),
            build.as_secs_f64() * 1000.0 / frames as f64
        );
    }
}
