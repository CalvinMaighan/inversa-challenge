//! EVF2 frame builder and bulk route (PLAN.md C4, T11).
//!
//! Wire format (little-endian; the authoritative layout is the doc comment in
//! `apps/web/shared/frames.ts`): a 72-byte header (`write_header`), then per frame:
//! - `hotspot` u8 × 4 species × 170 × 160 cells (species-major, row-major from the
//!   south-west corner, 0.02°). Each cell is the max of its 2 × 2 children on the 0.01°
//!   scoring grid, quantized as `round(score / HOTSPOT_SCALE)` and clamped to 255.
//! - pad to 2 bytes.
//! - `lst`, `sst` i16 × 68 × 64 cells (0.05°, the GOES `g5` cells) in centi-°C: the latest
//!   valid reading of a station inside the cell; `ENV_FLAGGED` (-32767) when a station inside
//!   it reported only flagged values (cloud, bad DQF); `ENV_MISSING` (-32768) when none reported.
//! - pad to 4 bytes.
//! - `u32 sightingCount` and 16-byte records (`u32 id, f32 lon, f32 lat, u16 taxon,
//!   u8 quality, u8 flags`; `id` is `sightings.id`, citable as `sighting:<id>`): the sightings
//!   observed in `[frame_at, frame_at + step)`, duplicates included and flagged, so a client
//!   that plays frames in order sees each sighting exactly once.
//!
//! Steps: hourly by default; 15-minute frames are allowed for windows of 24 h or less.
//!
//! Storage: the `frames` table keys one row per hourly frame. `frame_at` is the frame time
//! aligned down to the hour, `payload` the zlib-compressed body of that single frame
//! (everything after the header, sighting window 60 min), `built_at` when it was built.
//! `chunk` concatenates stored bodies under a fresh header, building and storing any hourly
//! frame that is missing; 15-minute chunks are built on the fly and not stored, since their
//! sighting windows differ.
//!
//! Transport: `GET /v1/frames?from=&to=&step=` (`routes`) returns `application/x-evf` with
//! gzip content encoding, at most `MAX_CHUNK_FRAMES` frames; `from`/`to` are unix ms or RFC
//! 3339. GraphQL `frames` (T10) calls `chunk` for at most 24 frames.
//!
//! `spawn_builder` listens for `Event::RowsWritten`, debounces 5 s, rebuilds every hourly
//! frame from the earliest touched time up to now (a sighting changes the density of every
//! later frame) inside the 30-day window, and publishes `Event::FramesUpdated`. CPU work
//! runs on `spawn_blocking` threads with rayon across frames.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::time::Duration;

use axum::extract::{Query, State};
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

use crate::db::Db;
use crate::hotspot::score::{CondParam, Snapshot, DAY_MS};
use crate::hotspot::{Grid, SPECIES};
use crate::realtime::Event;
use crate::state::AppState;

pub const MAGIC: &[u8; 4] = b"EVF2";
pub const HEADER_BYTES: usize = 72;
pub const SIGHTING_BYTES: usize = 16;
pub const SPECIES_COUNT: u32 = 4;
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

/// The three grids of a frame: the 0.01° scoring grid and its hotspot and environment
/// downsamples. The scoring grid must divide evenly (cols and rows multiples of 10).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Layout {
    pub grid: Grid,
    pub hs: Grid,
    pub env: Grid,
}

impl Layout {
    pub const REGION: Layout = Layout {
        grid: Grid::REGION,
        hs: Grid { west: Grid::REGION.west, south: Grid::REGION.south, cell_deg: 0.02, cols: 170, rows: 160 },
        env: Grid { west: Grid::REGION.west, south: Grid::REGION.south, cell_deg: 0.05, cols: 68, rows: 64 },
    };

    /// Layout of a smaller scoring grid (tests, golden file); `REGION` is the production one.
    #[cfg(test)]
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

    pub fn hotspot_bytes(&self) -> usize {
        SPECIES_COUNT as usize * self.hs.cells()
    }

    pub fn lst_offset(&self) -> usize {
        self.hotspot_bytes().next_multiple_of(2)
    }

    pub fn sst_offset(&self) -> usize {
        self.lst_offset() + self.env.cells() * 2
    }

    pub fn sightings_offset(&self) -> usize {
        (self.sst_offset() + self.env.cells() * 2).next_multiple_of(4)
    }

    /// Bytes of one frame body with `n` sightings.
    pub fn body_len(&self, n: usize) -> usize {
        self.sightings_offset() + 4 + n * SIGHTING_BYTES
    }
}

pub fn align(t: i64, step_ms: i64) -> i64 {
    t.div_euclid(step_ms) * step_ms
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn write_header(out: &mut Vec<u8>, layout: &Layout, frame_count: u32, frame0: i64, step_min: u32) {
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&frame_count.to_le_bytes());
    out.extend_from_slice(&layout.hs.cols.to_le_bytes());
    out.extend_from_slice(&layout.hs.rows.to_le_bytes());
    out.extend_from_slice(&layout.hs.west.to_le_bytes());
    out.extend_from_slice(&layout.hs.south.to_le_bytes());
    out.extend_from_slice(&layout.hs.cell_deg.to_le_bytes());
    out.extend_from_slice(&frame0.to_le_bytes());
    out.extend_from_slice(&step_min.to_le_bytes());
    out.extend_from_slice(&SPECIES_COUNT.to_le_bytes());
    out.extend_from_slice(&(layout.env.cols as u16).to_le_bytes());
    out.extend_from_slice(&(layout.env.rows as u16).to_le_bytes());
    out.extend_from_slice(&(layout.env.cell_deg as f32).to_le_bytes());
    out.extend_from_slice(&HOTSPOT_SCALE.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
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
}

#[cfg(test)]
pub fn read_header(bytes: &[u8]) -> anyhow::Result<Header> {
    anyhow::ensure!(bytes.len() >= HEADER_BYTES, "EVF: short header");
    anyhow::ensure!(&bytes[..4] == MAGIC, "EVF: bad magic");
    let u16_at = |o: usize| u16::from_le_bytes(bytes[o..o + 2].try_into().unwrap());
    let u32_at = |o: usize| u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
    let f32_at = |o: usize| f32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
    let f64_at = |o: usize| f64::from_le_bytes(bytes[o..o + 8].try_into().unwrap());
    let (west, south) = (f64_at(16), f64_at(24));
    Ok(Header {
        frame_count: u32_at(4),
        hs: Grid { cols: u32_at(8), rows: u32_at(12), west, south, cell_deg: f64_at(32) },
        env: Grid {
            cols: u16_at(56) as u32,
            rows: u16_at(58) as u32,
            west,
            south,
            // f32 0.05 is not exactly 0.05; the TS reader rounds the same way.
            cell_deg: (f32_at(60) as f64 * 1e6).round() / 1e6,
        },
        frame0: i64::from_le_bytes(bytes[40..48].try_into().unwrap()),
        step_min: u32_at(48),
        species_count: u32_at(52),
        hotspot_scale: f32_at(64),
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

/// One frame's body at `at`; its sighting index covers `[at, at + step_ms)`.
pub fn frame_body(snap: &Snapshot, layout: &Layout, at: i64, step_ms: i64) -> Vec<u8> {
    debug_assert_eq!(snap.grid, layout.grid);
    let grid = &layout.grid;
    let cond = snap.conditions(at);
    let lo = snap.sightings.partition_point(|s| s.observed_at < at);
    let hi = snap.sightings.partition_point(|s| s.observed_at < at + step_ms);
    let records = &snap.sightings[lo..hi];
    let mut out = Vec::with_capacity(layout.body_len(records.len()));
    for species in SPECIES {
        let scores = snap.apply_rules(species, snap.density(species, at), &cond);
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
    out.resize(layout.lst_offset(), 0);
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
    out.resize(layout.sightings_offset(), 0);
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

/// Raw bodies for `times`, built in parallel.
pub fn build_bodies(snap: &Snapshot, layout: &Layout, times: &[i64], step_ms: i64) -> Vec<(i64, Vec<u8>)> {
    times.par_iter().map(|&t| (t, frame_body(snap, layout, t, step_ms))).collect()
}

/// Compressed bodies for `times`, built in parallel (what the `frames` table stores).
pub fn build_packed(snap: &Snapshot, layout: &Layout, times: &[i64], step_ms: i64) -> Vec<(i64, Vec<u8>)> {
    times.par_iter().map(|&t| (t, compress(&frame_body(snap, layout, t, step_ms)))).collect()
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

/// An EVF2 chunk of every frame at `step_min` from `from_ms` to `to_ms` (see `chunk_times`).
pub async fn chunk(db: &Db, from_ms: i64, to_ms: i64, step_min: u32) -> anyhow::Result<Vec<u8>> {
    let times = chunk_times(from_ms, to_ms, step_min)?;
    let step_ms = step_min as i64 * 60_000;
    let (frame0, last) = (times[0], times[times.len() - 1]);
    let layout = Layout::REGION;
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
        let decoded = tokio::task::spawn_blocking(move || {
            stored.into_par_iter().map(|(t, p)| decompress(&p).map(|b| (t, b))).collect::<anyhow::Result<Vec<_>>>()
        })
        .await??;
        bodies.extend(decoded);
    }
    let missing: Vec<i64> = times.iter().copied().filter(|t| !bodies.contains_key(t)).collect();
    if let (Some(first), Some(end)) = (missing.first().copied(), missing.last().copied()) {
        let snap = Snapshot::load(db, layout.grid, first, end + step_ms).await?;
        let (built, packed) = tokio::task::spawn_blocking(move || {
            let built = build_bodies(&snap, &layout, &missing, step_ms);
            let packed = if stored_step { built.par_iter().map(|(t, b)| (*t, compress(b))).collect() } else { Vec::new() };
            (built, packed)
        })
        .await?;
        if stored_step {
            persist(db, packed).await?;
        }
        bodies.extend(built);
    }

    let mut out = Vec::with_capacity(HEADER_BYTES + times.len() * layout.body_len(0));
    write_header(&mut out, &layout, times.len() as u32, frame0, step_min);
    for t in &times {
        out.extend_from_slice(&bodies[t]);
    }
    Ok(out)
}

/// Build and store every hourly frame from `from_ms` to `to_ms` (aligned down, inclusive),
/// one day of frames at a time so a month-long rebuild holds one day of readings in memory.
pub async fn rebuild(db: &Db, from_ms: i64, to_ms: i64) -> anyhow::Result<(i64, i64)> {
    let from = align(from_ms, STEP_MS);
    let to = align(to_ms, STEP_MS);
    anyhow::ensure!(from <= to, "rebuild window is empty");
    let layout = Layout::REGION;
    let mut batch_start = from;
    while batch_start <= to {
        let batch_end = (batch_start + DAY_MS).min(to + STEP_MS);
        let times: Vec<i64> = (batch_start..batch_end).step_by(STEP_MS as usize).collect();
        let snap = Snapshot::load(db, layout.grid, batch_start, batch_end).await?;
        let packed = tokio::task::spawn_blocking(move || build_packed(&snap, &layout, &times, STEP_MS)).await?;
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

pub fn routes() -> Router<AppState> {
    Router::new().route("/v1/frames", get(bulk))
}

async fn bulk(State(state): State<AppState>, Query(q): Query<FramesQuery>) -> Response {
    let parsed = parse_time(&q.from).and_then(|from| Ok((from, parse_time(&q.to)?)));
    let (from, to) = match parsed {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    };
    let step = q.step.unwrap_or(STEP_MIN);
    if let Err(e) = chunk_times(from, to, step) {
        return (StatusCode::BAD_REQUEST, e.to_string()).into_response();
    }
    let bytes = match chunk(&state.obs, from, to, step).await {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("frames chunk failed: {e:#}");
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

    fn i16_at(b: &[u8], o: usize) -> i16 {
        i16::from_le_bytes(b[o..o + 2].try_into().unwrap())
    }

    fn u32_at(b: &[u8], o: usize) -> u32 {
        u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
    }

    /// Hotspot byte of `species` at scoring cell (col, row) inside one frame body.
    fn hs_at(layout: &Layout, body: &[u8], species: Species, col: u32, row: u32) -> u8 {
        body[species.index() * layout.hs.cells() + layout.hs.index(col / HS_FACTOR, row / HS_FACTOR)]
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
        (Snapshot::new(grid, t0, t0 + 3 * STEP_MS, sightings, stations, readings), layout, times)
    }

    fn golden_bytes() -> Vec<u8> {
        let (snap, layout, times) = golden_input();
        let mut out = Vec::new();
        write_header(&mut out, &layout, times.len() as u32, times[0], STEP_MIN);
        for (_, body) in build_bodies(&snap, &layout, &times, STEP_MS) {
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
            }
        );
        assert_eq!((layout.hs.cols, layout.hs.rows, layout.env.cols, layout.env.rows), (10, 5, 4, 2));
        assert_eq!(layout.hotspot_bytes(), 200);
        assert_eq!(layout.lst_offset(), 200);
        assert_eq!(layout.sst_offset(), 216);
        assert_eq!(layout.sightings_offset(), 232);
        assert_eq!(bytes.len(), HEADER_BYTES + 3 * layout.body_len(0) + (1 + 1 + 3) * SIGHTING_BYTES);
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
            assert_eq!(hs_at(&layout, body, Species::Iguana, 6, 4), want, "iguana frame {frame}");
            // Lionfish at (1,5): calm until the 9.5 m/s wind at 01:40 (0.1 → 10).
            assert_eq!(hs_at(&layout, body, Species::Lionfish, 1, 5), if frame < 2 { 100 } else { 10 }, "frame {frame}");
            // Tegu in February brumates (0.3 → 30); the whole 2 × 2 parent shares the max.
            assert_eq!(hs_at(&layout, body, Species::Tegu, 5, 1), 30);
            assert_eq!(hs_at(&layout, body, Species::Tegu, 4, 0), 30);
            // Python at (2,2): 8 °C suppresses (0.3) and the 1 m stage gives 1.2 → 0.36 → 36.
            assert_eq!(hs_at(&layout, body, Species::Python, 2, 2), 36);
            // The NAS prior at (17,0) is 0.2 of the recent sighting's weight: 0.2 × 0.36 → 7.
            assert_eq!(hs_at(&layout, body, Species::Python, 17, 0), 7);
            // LST is valid only at the g5 (0,0) pixel: env (0,0) reads 12.25 °C, env (1,1) is out
            // of reach. SST is valid only at g5 (1,0): env (1,0) reads 24 °C, env (3,1) is missing.
            let lst = layout.lst_offset();
            assert_eq!(i16_at(body, lst + layout.env.index(0, 0) * 2), 1225);
            assert_eq!(i16_at(body, lst + layout.env.index(1, 1) * 2), ENV_MISSING);
            // Each pixel's flagged parameter is a gap, not the valid neighbour one g5 cell away
            // (PRD §7: never interpolated).
            assert_eq!(i16_at(body, lst + layout.env.index(1, 0) * 2), ENV_FLAGGED);
            let sst = layout.sst_offset();
            assert_eq!(i16_at(body, sst + layout.env.index(1, 0) * 2), 2400);
            assert_eq!(i16_at(body, sst + layout.env.index(0, 0) * 2), ENV_FLAGGED);
            assert_eq!(i16_at(body, sst + layout.env.index(3, 1) * 2), ENV_MISSING);
            let n = u32_at(body, layout.sightings_offset()) as usize;
            counts.push(n);
            o += layout.body_len(n);
        }
        assert_eq!(counts, vec![1, 1, 3], "sightings per hourly window");
        assert_eq!(o, bytes.len());
        // Frame 0's record is the iguana (id 3); frame 1's is the flagged duplicate (id 6).
        let rec = &bytes[HEADER_BYTES + layout.sightings_offset() + 4..];
        assert_eq!(u32_at(rec, 0), 3);
        assert_eq!(u16::from_le_bytes([rec[12], rec[13]]), 3);
        let rec = &bytes[HEADER_BYTES + layout.body_len(1) + layout.sightings_offset() + 4..];
        assert_eq!(u32_at(rec, 0), 6);
        assert_eq!(f32::from_le_bytes(rec[4..8].try_into().unwrap()), layout.grid.center(layout.grid.index(2, 2)).0 as f32);
        assert_eq!(u16::from_le_bytes([rec[12], rec[13]]), 1);
        assert_eq!(rec[14], 0);
        assert_eq!(rec[15], FLAG_DUPLICATE);
        // Frame 2's three records, in observation order: ids 7, 8, 9.
        let recs = &bytes[HEADER_BYTES + layout.body_len(1) * 2 + layout.sightings_offset() + 4..];
        assert_eq!((0..3).map(|k| u32_at(recs, k * SIGHTING_BYTES)).collect::<Vec<_>>(), vec![7, 8, 9]);
    }

    #[test]
    fn frames_header_layout_matches_ts_reader() {
        let layout = Layout::REGION;
        assert_eq!(Layout::for_grid(Grid::REGION).unwrap(), layout);
        let mut out = Vec::new();
        write_header(&mut out, &layout, 7, 1_700_000_000_000, 60);
        assert_eq!(out.len(), HEADER_BYTES);
        assert_eq!(&out[..4], b"EVF2");
        assert_eq!(u32_at(&out, 4), 7);
        assert_eq!(u32_at(&out, 8), 170);
        assert_eq!(u32_at(&out, 12), 160);
        assert_eq!(f64::from_le_bytes(out[16..24].try_into().unwrap()), -83.2);
        assert_eq!(f64::from_le_bytes(out[24..32].try_into().unwrap()), 24.3);
        assert_eq!(f64::from_le_bytes(out[32..40].try_into().unwrap()), 0.02);
        assert_eq!(i64::from_le_bytes(out[40..48].try_into().unwrap()), 1_700_000_000_000);
        assert_eq!(u32_at(&out, 48), 60);
        assert_eq!(u32_at(&out, 52), 4);
        assert_eq!(u16::from_le_bytes([out[56], out[57]]), 68);
        assert_eq!(u16::from_le_bytes([out[58], out[59]]), 64);
        assert_eq!(f32::from_le_bytes(out[60..64].try_into().unwrap()), 0.05f32);
        assert_eq!(f32::from_le_bytes(out[64..68].try_into().unwrap()), 0.01f32);
        assert_eq!(u32_at(&out, 68), 0);
        let h = read_header(&out).unwrap();
        assert_eq!((h.hs, h.env), (layout.hs, layout.env));
        // Section offsets on the region layout: 108,800 hotspot bytes, 4,352 env cells.
        assert_eq!(layout.hotspot_bytes(), 108_800);
        assert_eq!(layout.lst_offset(), 108_800);
        assert_eq!(layout.sst_offset(), 108_800 + 8_704);
        assert_eq!(layout.sightings_offset(), 108_800 + 17_408);
        assert_eq!(layout.body_len(0), 126_212);
        assert!(Layout::for_grid(Grid { cols: 25, ..Grid::REGION }).is_err());
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
        let layout = Layout::REGION;
        let g = layout.grid;
        let t0 = ms(2025, 6, 1, 12);
        let (lon, lat) = g.center(g.index(50, 60));
        let id = insert_sighting(&db, "inat", 4, lat, lon, t0 + 7 * 60_000, "research", None).await;
        let bytes = chunk(&db, t0 + 60_000, t0 + 2 * HOUR + 40 * 60_000, 60).await.unwrap();
        let h = read_header(&bytes).unwrap();
        assert_eq!(h.frame_count, 3, "12:00, 13:00, 14:00");
        assert_eq!(h.frame0, t0);
        assert_eq!(h.hs, layout.hs);
        let stored: i64 = db.read(|c| c.query_row("select count(*) from frames", [], |r| r.get(0))).await.unwrap();
        assert_eq!(stored, 3);
        // Frame 0 carries the sighting; frames 1 and 2 carry none. Lionfish density is 1.0 at
        // the cell from 13:00 on (observed 12:07 is after the 12:00 frame time).
        let f0 = &bytes[HEADER_BYTES..];
        assert_eq!(u32_at(f0, layout.sightings_offset()), 1);
        let f1 = &bytes[HEADER_BYTES + layout.body_len(1)..];
        assert_eq!(u32_at(f1, layout.sightings_offset()), 0);
        assert_eq!(hs_at(&layout, f0, Species::Lionfish, 50, 60), 0);
        assert_eq!(hs_at(&layout, f1, Species::Lionfish, 50, 60), 100);
        assert_eq!(bytes.len(), HEADER_BYTES + 3 * layout.body_len(0) + SIGHTING_BYTES);

        // Stored bodies are reused: change the row underneath and the chunk still reads the cache.
        db.write(move |tx| tx.execute("update sightings set taxon_id = 1 where id = ?1", [id])).await.unwrap();
        let again = chunk(&db, t0, t0 + 2 * HOUR, 60).await.unwrap();
        assert_eq!(again, bytes);
        // A rebuild refreshes them.
        rebuild(&db, t0, t0 + 2 * HOUR).await.unwrap();
        let fresh = chunk(&db, t0, t0 + 2 * HOUR, 60).await.unwrap();
        assert_ne!(fresh, bytes);
        let f1 = &fresh[HEADER_BYTES + layout.body_len(1)..];
        assert_eq!(hs_at(&layout, f1, Species::Python, 50, 60), 100);
        assert_eq!(hs_at(&layout, f1, Species::Lionfish, 50, 60), 0);
        // A 15-minute chunk is built on the fly with its own sighting window and not stored.
        let fine = chunk(&db, t0, t0 + 2 * HOUR, 15).await.unwrap();
        assert_eq!(read_header(&fine).unwrap().frame_count, 9);
        assert_eq!(u32_at(&fine[HEADER_BYTES..], layout.sightings_offset()), 1);
        assert_eq!(u32_at(&fine[HEADER_BYTES + layout.body_len(1)..], layout.sightings_offset()), 0);
        let stored: i64 = db.read(|c| c.query_row("select count(*) from frames", [], |r| r.get(0))).await.unwrap();
        assert_eq!(stored, 3);
        assert!(chunk(&db, t0, t0 + 800 * HOUR, 60).await.is_err(), "over the chunk cap");
        assert_eq!(prune(&db, t0 + STEP_MS).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn frames_rest_route() {
        use axum::body::Body;
        use axum::http::Request;
        use http_body_util::BodyExt;
        use tower::ServiceExt;

        let (app, state) = crate::app::test_support::test_app();
        seed_sources(&state.obs).await;
        let g = Grid::REGION;
        let t0 = ms(2025, 6, 1, 12);
        let (lon, lat) = g.center(g.index(80, 90));
        insert_sighting(&state.obs, "inat", 1, lat, lon, t0 + 30 * 60_000, "research", None).await;
        let uri = format!("/v1/frames?from={}&to=2025-06-01T14:00:00Z", t0);
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
        assert_eq!(bytes.len(), HEADER_BYTES + 3 * Layout::REGION.body_len(0) + SIGHTING_BYTES);
        assert!(gz.len() < bytes.len() / 10, "gzip {} of {} raw", gz.len(), bytes.len());
        assert_eq!(hs_at(&Layout::REGION, &bytes[HEADER_BYTES + Layout::REGION.body_len(1)..], Species::Python, 80, 90), 100);

        // 15-minute frames for a short window; bad input is a 400.
        let fine = format!("/v1/frames?from={}&to={}&step=15", t0, t0 + HOUR);
        let res = app.clone().oneshot(Request::get(&fine).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let gz = res.into_body().collect().await.unwrap().to_bytes();
        let mut bytes = Vec::new();
        flate2::read::GzDecoder::new(&gz[..]).read_to_end(&mut bytes).unwrap();
        assert_eq!(read_header(&bytes).unwrap().frame_count, 5);
        for bad in [
            format!("/v1/frames?from={}&to={}&step=15", t0, t0 + 2 * DAY),
            format!("/v1/frames?from={}&to={}&step=20", t0, t0 + HOUR),
            format!("/v1/frames?from=yesterday&to={}", t0),
            format!("/v1/frames?from={}&to={}", t0 + 1, t0),
            "/v1/frames".to_string(),
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
        let layout = Layout::REGION;
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
        write_header(&mut raw, &layout, 0, t_start, STEP_MIN);
        let mut frames = 0usize;
        let mut zlib_bytes = 0usize;
        let mut batch_start = t_start;
        while batch_start < t_end {
            let batch_end = (batch_start + DAY).min(t_end);
            let times: Vec<i64> = (batch_start..batch_end).step_by(STEP_MS as usize).collect();
            let snap = Snapshot::load(&db, g, batch_start, batch_end).await.unwrap();
            let bodies = tokio::task::spawn_blocking(move || {
                let bodies = build_bodies(&snap, &layout, &times, STEP_MS);
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
