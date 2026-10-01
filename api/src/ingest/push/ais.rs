//! AISStream.io push source `aisstream` (gates/leaf-GE4.md, docs/GODS_EYE.md GC4): live vessel
//! positions over a websocket, one connection per app that lists the feed (carp, lionfish).
//!
//! Protocol (read 2026-10-01 at https://aisstream.io/documentation and the published message
//! models, github.com/aisstream/ais-message-models `type-definition.yaml`):
//!
//! - connect to `wss://stream.aisstream.io/v0/stream` and, within 3 s, send
//!   `{"APIKey": ..., "BoundingBoxes": [[[lat, lon], [lat, lon]], ...], "FilterMessageTypes": [...]}`
//!   (boxes are latitude first);
//! - every message is `{"MessageType": T, "MetaData": {MMSI, ShipName, latitude, longitude,
//!   time_utc}, "Message": {T: {...}}}`; `PositionReport` carries `UserID, Latitude, Longitude,
//!   Sog, Cog, TrueHeading`; `ShipStaticData` carries `Name, Type, CallSign, ImoNumber,
//!   Destination, Dimension{A,B,C,D}`; errors arrive as `{"error": "..."}`;
//! - limits: 3 subscribed connections per account and 3 open per IP, one subscription update a
//!   second, no SLA, slow consumers lose messages, reconnect with exponential backoff, and the key
//!   must stay server side (no browser connections).
//!
//! Each app uses one connection (two apps, two of the three allowed) and subscribes to its
//! `regions[]` boxes. The key comes from `AISSTREAM_API_KEY` and is only ever sent in the
//! subscription message to the configured endpoint; it is never logged and never part of an
//! error (upstream text is scrubbed of it). `AISSTREAM_URL` may point the client at a loopback
//! mock (e2e); any other override is refused.
//!
//! The connection task parses each frame (an error envelope or close reason is classified for the
//! watchdog, `ais_watchdog.rs`), thins positions to one per vessel per minute and queues the raw
//! frame text. `fetch` drains the queue into one NDJSON payload (archived as received), and
//! `normalize` turns it into `Row::VesselPosition` / `Row::VesselStatic`; frames it cannot use are
//! counted, never fatal. tungstenite has no permessage-deflate, which AISStream recommends for full
//! bandwidth; regional boxes are far below that, and dropped frames are counted.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use super::ais_watchdog::{classify_http, classify_text, Failure, Health, Next, Policy, Watchdog};
use crate::app::config::App;
use crate::ingest::poll::physical;
use crate::ingest::source::{FetchCtx, Mode, RawPayload, Source, SourceInfo};
use crate::model::Row;
use crate::state::Config;
use crate::vessels::{valid_mmsi, VesselPositionRow, VesselStaticRow, SOURCE_ID};

pub const DEFAULT_URL: &str = "wss://stream.aisstream.io/v0/stream";
/// Longest `fetch` waits for the first queued frame.
pub const WAIT: Duration = Duration::from_secs(20);
/// After the first frame, `fetch` keeps collecting this long, so one payload holds a batch.
pub const GATHER: Duration = Duration::from_secs(10);
/// Frames per payload, at most: about 250 KB, so an archived batch stays under the evidence
/// drawer's inline text cap (`evidence::RAW_TEXT_CAP`).
pub const BATCH: usize = 300;
const QUEUE: usize = 20_000;
/// Frames larger than this are not AIS messages (a few KB at most).
pub const MAX_FRAME_BYTES: usize = 1_000_000;
/// The subscription must arrive within 3 s of the upgrade; connect plus TLS get this long.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const TICK: Duration = Duration::from_secs(5);
/// Static data per vessel is queued again only when it changes or after this long.
const STATIC_REFRESH_MS: i64 = 6 * 3_600_000;
/// Thinning maps are cleared past this many vessels (bounded memory).
const MAX_TRACKED: usize = 50_000;
/// Positions older than 30 days are pruned at most this often.
const PRUNE_EVERY: Duration = Duration::from_secs(3600);
/// Message types subscribed to: class A and B positions and both static reports.
pub const MESSAGE_TYPES: [&str; 5] =
    ["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport", "ShipStaticData", "StaticDataReport"];

/// The AISStream key. Its `Debug` never shows the value.
#[derive(Clone)]
pub struct ApiKey(String);

impl ApiKey {
    pub fn new(value: String) -> Self {
        ApiKey(value)
    }

    fn expose(&self) -> &str {
        &self.0
    }

    /// `text` with every occurrence of the key replaced, for anything that may be shown or logged.
    pub fn scrub(&self, text: &str) -> String {
        if self.0.len() < 4 {
            return text.to_string();
        }
        text.replace(&self.0, "[redacted]")
    }
}

impl std::fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ApiKey([redacted])")
    }
}

/// The endpoint: the AISStream URL, or an `AISSTREAM_URL` override on loopback (a local mock).
pub fn endpoint(override_url: Option<&str>) -> Result<String, String> {
    let Some(url) = override_url else { return Ok(DEFAULT_URL.to_string()) };
    if url == DEFAULT_URL {
        return Ok(url.to_string());
    }
    let rest = url.strip_prefix("ws://").or_else(|| url.strip_prefix("wss://"));
    let host = rest.map(|r| r.split(['/', '?']).next().unwrap_or_default()).unwrap_or_default();
    let host = host.rsplit_once(':').map_or(host, |(h, port)| if port.chars().all(|c| c.is_ascii_digit()) { h } else { host });
    if ["127.0.0.1", "localhost", "[::1]"].contains(&host) {
        Ok(url.to_string())
    } else {
        Err("AISSTREAM_URL must be the AISStream endpoint or a loopback mock (ws://127.0.0.1:<port>)".into())
    }
}

/// Why the source does not run for `app`, if it does not (the feed-state note is `disabled: <reason>`).
pub fn disabled_reason(config: &Config) -> Option<String> {
    if config.aisstream_api_key.is_none() {
        return Some("AISSTREAM_API_KEY not set".into());
    }
    endpoint(config.aisstream_url.as_deref()).err()
}

pub fn info() -> SourceInfo {
    SourceInfo {
        id: SOURCE_ID,
        name: "AISStream.io (AIS vessel positions)",
        homepage: "https://aisstream.io",
        mode: Mode::Push,
        cadence: WAIT + GATHER,
        max_latency: Duration::from_secs(3600),
    }
}

pub fn sources(config: &Config, app: &Arc<App>) -> Vec<Arc<dyn Source>> {
    match (&config.aisstream_api_key, endpoint(config.aisstream_url.as_deref())) {
        (Some(key), Ok(url)) => vec![Arc::new(Ais::new(app.clone(), key.clone(), url, Policy::default()))],
        _ => vec![],
    }
}

/// The subscription message: the app's region boxes, latitude first.
pub fn subscription(key: &ApiKey, app: &App) -> String {
    let boxes: Vec<Value> = app.regions.iter().map(|r| {
        let b = r.bbox();
        json!([[b.south, b.west], [b.north, b.east]])
    }).collect();
    json!({ "APIKey": key.expose(), "BoundingBoxes": boxes, "FilterMessageTypes": MESSAGE_TYPES }).to_string()
}

// ---------------------------------------------------------------------------------------------
// Parsing (pure)
// ---------------------------------------------------------------------------------------------

/// One frame, classified.
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Position(VesselPositionRow),
    Static(VesselStaticRow),
    /// `{"error": ...}`.
    Error(String),
    /// Not a usable AIS record; the reason.
    Malformed(&'static str),
}

/// `MetaData.time_utc`, e.g. `2024-12-09 02:27:43.237370229 +0000 UTC`, as unix ms.
pub fn parse_time_utc(s: &str) -> Option<i64> {
    let s = s.trim().trim_end_matches(" UTC");
    chrono::DateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f %z")
        .ok()
        .or_else(|| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.timestamp_millis())
}

/// An AIS text field: `@` is padding, surrounding spaces are noise; empty is None.
fn ais_text(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?.trim_end_matches('@').trim();
    (!s.is_empty()).then(|| s.to_string())
}

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|x| x.is_finite())
}

fn int(v: Option<&Value>) -> Option<i64> {
    v.and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
}

/// Ship length from the antenna offsets (A bow, B stern), when both are reported.
fn length_m(dim: Option<&Value>) -> Option<f64> {
    let d = dim?;
    let (a, b) = (num(d.get("A"))?, num(d.get("B"))?);
    (a > 0.0 && b > 0.0).then_some(a + b)
}

/// Parse one frame. `received_ms` stands in for a missing or future `time_utc`.
pub fn parse_frame(text: &str, received_ms: i64) -> Frame {
    if text.len() > MAX_FRAME_BYTES {
        return Frame::Malformed("frame too large");
    }
    let Ok(v) = serde_json::from_str::<Value>(text) else { return Frame::Malformed("not JSON") };
    let Some(obj) = v.as_object() else { return Frame::Malformed("not an object") };
    if let Some(err) = obj.get("error") {
        return Frame::Error(err.as_str().map(str::to_string).unwrap_or_else(|| err.to_string()));
    }
    let Some(kind) = obj.get("MessageType").and_then(Value::as_str) else { return Frame::Malformed("no MessageType") };
    let Some(body) = obj.get("Message").and_then(|m| m.get(kind)).filter(|b| b.is_object()) else {
        return Frame::Malformed("no Message body for its MessageType");
    };
    let meta = obj.get("MetaData").or_else(|| obj.get("Metadata")).cloned().unwrap_or(Value::Null);
    let Some(mmsi) = int(meta.get("MMSI")).or_else(|| int(body.get("UserID"))).filter(|m| valid_mmsi(*m)) else {
        return Frame::Malformed("no valid MMSI");
    };
    if body.get("Valid").and_then(Value::as_bool) == Some(false) {
        return Frame::Malformed("report marked invalid");
    }
    let at = meta
        .get("time_utc")
        .and_then(Value::as_str)
        .and_then(parse_time_utc)
        .filter(|t| *t <= received_ms + 5 * 60_000)
        .unwrap_or(received_ms);
    match kind {
        "PositionReport" | "StandardClassBPositionReport" | "ExtendedClassBPositionReport" => {
            let lat = num(body.get("Latitude")).or_else(|| num(meta.get("latitude")).or_else(|| num(meta.get("Latitude"))));
            let lon = num(body.get("Longitude")).or_else(|| num(meta.get("longitude")).or_else(|| num(meta.get("Longitude"))));
            let (Some(lat), Some(lon)) = (lat, lon) else { return Frame::Malformed("no position") };
            // 91 / 181 mean "not available"; 0,0 is an unset receiver.
            if lat.abs() > 90.0 || lon.abs() > 180.0 || (lat == 0.0 && lon == 0.0) {
                return Frame::Malformed("position not available");
            }
            let sog = num(body.get("Sog")).filter(|s| (0.0..102.25).contains(s));
            let cog = num(body.get("Cog")).filter(|c| (0.0..360.0).contains(c));
            let heading = num(body.get("TrueHeading")).filter(|h| (0.0..360.0).contains(h));
            let name = ais_text(meta.get("ShipName")).or_else(|| ais_text(body.get("Name")));
            Frame::Position(VesselPositionRow { mmsi, observed_at: at, lat, lon, sog, cog, heading, name })
        }
        "ShipStaticData" => Frame::Static(VesselStaticRow {
            mmsi,
            seen_at: at,
            name: ais_text(body.get("Name")).or_else(|| ais_text(meta.get("ShipName"))),
            type_code: int(body.get("Type")).filter(|t| (1..=99).contains(t)),
            call_sign: ais_text(body.get("CallSign")),
            imo: int(body.get("ImoNumber")).filter(|n| (1_000_000..=9_999_999).contains(n)),
            destination: ais_text(body.get("Destination")),
            length_m: length_m(body.get("Dimension")),
        }),
        "StaticDataReport" => {
            let part = |k: &str| body.get(k).filter(|p| p.get("Valid").and_then(Value::as_bool) == Some(true));
            let (a, b) = (part("ReportA"), part("ReportB"));
            if a.is_none() && b.is_none() {
                return Frame::Malformed("static data report with no valid part");
            }
            Frame::Static(VesselStaticRow {
                mmsi,
                seen_at: at,
                name: a.and_then(|a| ais_text(a.get("Name"))),
                type_code: b.and_then(|b| int(b.get("ShipType"))).filter(|t| (1..=99).contains(t)),
                call_sign: b.and_then(|b| ais_text(b.get("CallSign"))),
                imo: None,
                destination: None,
                length_m: b.and_then(|b| length_m(b.get("Dimension"))),
            })
        }
        _ => Frame::Malformed("message type not subscribed"),
    }
}

/// What one payload held.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Counts {
    pub positions: usize,
    pub statics: usize,
    pub malformed: usize,
    pub errors: usize,
}

/// NDJSON payload (one frame per line) to rows. Bad lines are counted, never fatal.
pub fn normalize_batch(bytes: &[u8], fetched_at: i64) -> (Vec<Row>, Counts) {
    let mut rows = Vec::new();
    let mut counts = Counts::default();
    for line in String::from_utf8_lossy(bytes).lines().map(str::trim).filter(|l| !l.is_empty()) {
        match parse_frame(line, fetched_at) {
            Frame::Position(p) => {
                counts.positions += 1;
                rows.push(Row::VesselPosition(p));
            }
            Frame::Static(s) => {
                counts.statics += 1;
                rows.push(Row::VesselStatic(s));
            }
            Frame::Error(_) => counts.errors += 1,
            Frame::Malformed(_) => counts.malformed += 1,
        }
    }
    (rows, counts)
}

// ---------------------------------------------------------------------------------------------
// Thinning before the queue
// ---------------------------------------------------------------------------------------------

/// Drops positions in a minute that already has one for the vessel, and static data that did not
/// change (re-sent every [`STATIC_REFRESH_MS`]), so the archive holds what the database keeps.
#[derive(Default)]
pub struct Thinner {
    minute: HashMap<i64, i64>,
    statics: HashMap<i64, (VesselStaticRow, i64)>,
}

impl Thinner {
    pub fn keep(&mut self, frame: &Frame) -> bool {
        if self.minute.len() > MAX_TRACKED {
            self.minute.clear();
        }
        if self.statics.len() > MAX_TRACKED {
            self.statics.clear();
        }
        match frame {
            Frame::Position(p) => {
                let m = p.observed_at.div_euclid(60_000);
                match self.minute.get(&p.mmsi) {
                    Some(seen) if *seen == m => false,
                    _ => {
                        self.minute.insert(p.mmsi, m);
                        true
                    }
                }
            }
            Frame::Static(s) => {
                let key = VesselStaticRow { seen_at: 0, ..s.clone() };
                match self.statics.get(&s.mmsi) {
                    Some((prev, at)) if *prev == key && s.seen_at - at < STATIC_REFRESH_MS => false,
                    _ => {
                        self.statics.insert(s.mmsi, (key, s.seen_at));
                        true
                    }
                }
            }
            _ => false,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------------------------

/// Shared between the connection task and `fetch`.
#[derive(Default)]
pub struct Status {
    pub live: AtomicBool,
    /// The key was rejected: the task stopped.
    pub auth_failed: AtomicBool,
    pub last_error: Mutex<Option<String>>,
    pub connects: AtomicU64,
    pub frames: AtomicU64,
    pub positions: AtomicU64,
    pub statics: AtomicU64,
    pub thinned: AtomicU64,
    pub malformed: AtomicU64,
    pub errors: AtomicU64,
    /// Frames dropped because the queue was full.
    pub dropped: AtomicU64,
}

impl Status {
    fn error(&self, e: impl Into<String>) {
        *self.last_error.lock().unwrap_or_else(|p| p.into_inner()) = Some(e.into());
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

struct Queue {
    rx: mpsc::Receiver<String>,
    task: Option<JoinHandle<()>>,
}

pub struct Ais {
    app: Arc<App>,
    key: ApiKey,
    url: String,
    policy: Policy,
    /// [`GATHER`]; shorter in tests.
    gather: Duration,
    pub status: Arc<Status>,
    queue: tokio::sync::Mutex<Queue>,
    last_prune: Mutex<Option<Instant>>,
}

impl Ais {
    pub fn new(app: Arc<App>, key: ApiKey, url: String, policy: Policy) -> Self {
        let (_, rx) = mpsc::channel(1);
        Ais {
            app,
            key,
            url,
            policy,
            gather: GATHER,
            status: Arc::new(Status::default()),
            queue: tokio::sync::Mutex::new(Queue { rx, task: None }),
            last_prune: Mutex::new(None),
        }
    }

    /// Start (or restart after the task ended) the connection task, with a fresh channel.
    fn ensure_running(&self, q: &mut Queue) {
        if self.status.auth_failed.load(Ordering::Relaxed) || q.task.as_ref().is_some_and(|t| !t.is_finished()) {
            return;
        }
        let (tx, rx) = mpsc::channel(QUEUE);
        q.rx = rx;
        let conn = Conn { url: self.url.clone(), key: self.key.clone(), subscription: subscription(&self.key, &self.app), app: self.app.id().to_string() };
        q.task = Some(tokio::spawn(connection(conn, self.policy.clone(), tx, self.status.clone())));
    }

    async fn maybe_prune(&self, ctx: &FetchCtx<'_>) -> anyhow::Result<()> {
        {
            let mut last = self.last_prune.lock().unwrap_or_else(|p| p.into_inner());
            if last.is_some_and(|t| t.elapsed() < PRUNE_EVERY) {
                return Ok(());
            }
            *last = Some(Instant::now());
        }
        let now = ctx.state.now_ms();
        let removed = ctx.state.obs.write(move |tx| crate::vessels::prune(tx, now)).await?;
        if removed > 0 {
            tracing::info!(app = self.app.id(), source = SOURCE_ID, "pruned {removed} positions older than 30 days");
        }
        Ok(())
    }
}

#[async_trait]
impl Source for Ais {
    fn info(&self) -> SourceInfo {
        info()
    }

    fn min_interval(&self) -> Duration {
        Duration::ZERO
    }

    async fn fetch(&self, ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
        self.maybe_prune(ctx).await?;
        if self.status.auth_failed.load(Ordering::Relaxed) {
            // Retrying cannot fix a rejected key: report it each heartbeat without reconnecting.
            tokio::time::sleep(WAIT).await;
            anyhow::bail!("{}", self.status.last_error().unwrap_or_else(|| "AISStream rejected the API key".into()));
        }
        let mut q = self.queue.lock().await;
        self.ensure_running(&mut q);
        let first = match tokio::time::timeout(WAIT, q.rx.recv()).await {
            Ok(Some(first)) => first,
            Ok(None) => anyhow::bail!("{}", self.status.last_error().unwrap_or_else(|| "aisstream connection task stopped".into())),
            Err(_) => {
                if !self.status.live.load(Ordering::Relaxed) {
                    if let Some(e) = self.status.last_error() {
                        anyhow::bail!("aisstream offline: {e}");
                    }
                }
                return Ok(Vec::new());
            }
        };
        let mut lines = vec![first];
        let until = tokio::time::Instant::now() + self.gather;
        while lines.len() < BATCH {
            match tokio::time::timeout_at(until, q.rx.recv()).await {
                Ok(Some(next)) => lines.push(next),
                Ok(None) | Err(_) => break,
            }
        }
        let mut bytes = lines.join("\n").into_bytes();
        bytes.push(b'\n');
        Ok(vec![RawPayload {
            source_url: self.url.clone(),
            content_type: "application/x-ndjson".into(),
            bytes,
            http_status: None,
            fetched_at: physical::now_ms(),
            next_cursor: None,
            ack: None,
        }])
    }

    fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
        let (rows, counts) = normalize_batch(&raw.bytes, raw.fetched_at);
        if counts.malformed + counts.errors > 0 {
            tracing::debug!(source = SOURCE_ID, "payload: {} unusable frames of {}", counts.malformed + counts.errors, counts.positions + counts.statics + counts.malformed + counts.errors);
        }
        Ok(rows)
    }
}

/// What the connection task needs.
#[derive(Clone)]
pub struct Conn {
    pub url: String,
    pub key: ApiKey,
    /// The subscription JSON (holds the key; never logged).
    pub subscription: String,
    pub app: String,
}

/// Monotonic ms since the task started.
fn mono(start: Instant) -> u64 {
    start.elapsed().as_millis() as u64
}

/// The long-lived connection: connect, subscribe, read, recycle on silence, back off on failure,
/// stop on a rejected key or when `fetch` stops listening.
pub async fn connection(conn: Conn, policy: Policy, tx: mpsc::Sender<String>, status: Arc<Status>) {
    let start = Instant::now();
    let mut wd = Watchdog::new(policy);
    let mut thinner = Thinner::default();
    loop {
        match wd.next(mono(start)) {
            Next::Stop => {
                status.auth_failed.store(true, Ordering::Relaxed);
                status.live.store(false, Ordering::Relaxed);
                tracing::warn!(app = conn.app, source = SOURCE_ID, "stopped: {}", status.last_error().unwrap_or_default());
                return;
            }
            Next::Wait(ms) => {
                tokio::time::sleep(Duration::from_millis(ms)).await;
                continue;
            }
            Next::Connect => {}
        }
        if tx.is_closed() {
            return;
        }
        wd.on_attempt(mono(start));
        status.connects.fetch_add(1, Ordering::Relaxed);
        let failure = session(&conn, &mut wd, start, &mut thinner, &tx, &status).await;
        status.live.store(false, Ordering::Relaxed);
        let Some(failure) = failure else { return };
        let message = conn.key.scrub(&failure.message());
        tracing::warn!(app = conn.app, source = SOURCE_ID, "connection ended: {message}");
        status.error(message);
        wd.on_failure(mono(start), failure);
        if wd.health(mono(start)) == Health::Down {
            tracing::warn!(app = conn.app, source = SOURCE_ID, "backoff ladder exhausted; retrying every 15 min");
        }
    }
}

/// One connection. Returns why it ended; None when the receiver is gone (shut down).
async fn session(conn: &Conn, wd: &mut Watchdog, start: Instant, thinner: &mut Thinner, tx: &mpsc::Sender<String>, status: &Status) -> Option<Failure> {
    let request = match conn.url.as_str().into_client_request() {
        Ok(r) => r,
        Err(e) => return Some(Failure::Transport(format!("bad AISStream URL: {e}"))),
    };
    // Exactly one rustls backend (ring) is compiled in; installing is idempotent.
    let _ = tokio_xmpp::rustls::crypto::ring::default_provider().install_default();
    let mut ws = match tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(request)).await {
        Err(_) => return Some(Failure::Transport("connect timed out".into())),
        Ok(Err(tokio_tungstenite::tungstenite::Error::Http(resp))) => {
            let retry = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).map(str::to_string);
            return Some(classify_http(resp.status().as_u16(), retry.as_deref(), physical::now_ms()));
        }
        Ok(Err(e)) => return Some(Failure::Transport(format!("connect: {e}"))),
        Ok(Ok((ws, _))) => ws,
    };
    if let Err(e) = ws.send(Message::text(conn.subscription.clone())).await {
        return Some(Failure::Transport(format!("subscribe: {e}")));
    }
    wd.on_open(mono(start));
    tracing::info!(app = conn.app, source = SOURCE_ID, "connected and subscribed");
    loop {
        let msg = tokio::select! {
            m = ws.next() => m,
            _ = tokio::time::sleep(TICK) => {
                if wd.check(mono(start)) {
                    let _ = ws.close(None).await;
                    return Some(Failure::Quiet);
                }
                if tx.is_closed() {
                    return None;
                }
                continue;
            }
        };
        let text = match msg {
            Some(Ok(Message::Text(t))) => t.as_str().to_string(),
            Some(Ok(Message::Binary(b))) => match String::from_utf8(b.to_vec()) {
                Ok(t) => t,
                Err(_) => {
                    status.malformed.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
            },
            Some(Ok(Message::Close(frame))) => {
                let reason = frame.map(|f| f.reason.as_str().to_string()).unwrap_or_default();
                return Some(if reason.is_empty() { Failure::Transport("closed by AISStream".into()) } else { classify_text(&reason) });
            }
            Some(Ok(_)) => continue,
            Some(Err(e)) => return Some(Failure::Transport(format!("read: {e}"))),
            None => return Some(Failure::Transport("stream ended".into())),
        };
        status.frames.fetch_add(1, Ordering::Relaxed);
        let frame = parse_frame(&text, physical::now_ms());
        match &frame {
            Frame::Error(e) => {
                status.errors.fetch_add(1, Ordering::Relaxed);
                let _ = ws.close(None).await;
                return Some(classify_text(&conn.key.scrub(e)));
            }
            Frame::Malformed(_) => {
                status.malformed.fetch_add(1, Ordering::Relaxed);
                continue;
            }
            Frame::Position(_) => status.positions.fetch_add(1, Ordering::Relaxed),
            Frame::Static(_) => status.statics.fetch_add(1, Ordering::Relaxed),
        };
        wd.on_data(mono(start));
        status.live.store(true, Ordering::Relaxed);
        if !thinner.keep(&frame) {
            status.thinned.fetch_add(1, Ordering::Relaxed);
            continue;
        }
        match tx.try_send(text) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => {
                status.dropped.fetch_add(1, Ordering::Relaxed);
            }
            Err(mpsc::error::TrySendError::Closed(_)) => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    //! Fixtures in `api/tests/fixtures/ais/`. Provenance: `position_report.json` is a real frame
    //! received from AISStream and published by Paul Fedory ("Tracking Real-Time Ship Data with
    //! Elixir and a WebSocket API", paulfedory.com, 2024-12-09 02:27:43Z, FEDERAL OSHIMA, MMSI
    //! 538006783), converted from its Elixir map dump to JSON with every value kept (the
    //! `ShipName` padding included). The other frames follow the published message models field
    //! for field (AISStream `type-definition.yaml`), with Louisiana coast values; no AISStream key
    //! was available to record more (gates/leaf-GE4.md G5). `ais_live` (ignored, needs the key)
    //! records real frames into `AIS_RECORD_DIR` when that is set.
    use super::*;
    use crate::app::config::App;

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(format!("{}/tests/fixtures/ais/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
    }

    const NOW: i64 = 1_790_900_000_000;

    #[test]
    fn ais_parse_position_report() {
        let Frame::Position(p) = parse_frame(&fixture("position_report.json"), NOW) else { panic!("position") };
        assert_eq!(p.mmsi, 538006783);
        assert_eq!((p.lat, p.lon), (42.30840333333333, -83.083435));
        assert_eq!((p.sog, p.cog, p.heading), (Some(0.0), Some(91.0), Some(43.0)));
        assert_eq!(p.name.as_deref(), Some("FEDERAL OSHIMA"), "padding trimmed");
        assert_eq!(p.observed_at, parse_time_utc("2024-12-09 02:27:43.237370229 +0000 UTC").unwrap());
        assert_eq!(p.observed_at, 1_733_711_263_237);
    }

    #[test]
    fn ais_parse_ship_static_data() {
        let Frame::Static(s) = parse_frame(&fixture("ship_static_data.json"), NOW) else { panic!("static") };
        assert_eq!(s.mmsi, 367123450);
        assert_eq!(s.name.as_deref(), Some("MISS LOUISE"), "@ padding stripped");
        assert_eq!((s.type_code, crate::vessels::category(s.type_code)), (Some(52), "tug"));
        assert_eq!(s.call_sign.as_deref(), Some("WDC6785"));
        assert_eq!(s.imo, None, "ImoNumber 0 is no IMO");
        assert_eq!(s.destination.as_deref(), Some("NEW ORLEANS"));
        assert_eq!(s.length_m, Some(32.0));
    }

    #[test]
    fn ais_parse_class_b_and_static_report() {
        let Frame::Position(p) = parse_frame(&fixture("class_b_position.json"), NOW) else { panic!("class B") };
        assert_eq!((p.mmsi, p.lat, p.lon), (338123456, 29.2361, -89.9876));
        assert_eq!((p.sog, p.cog, p.heading, p.name), (None, None, None, None), "102.3 kn, 360 deg, 511 and an empty name mean not available");
        let Frame::Static(s) = parse_frame(&fixture("static_data_report.json"), NOW) else { panic!("static report") };
        assert_eq!((s.mmsi, s.type_code, s.call_sign.as_deref(), s.length_m, s.name), (338123456, Some(37), Some("WDK9921"), Some(12.0), None));
    }

    #[test]
    fn ais_parse_malformed_and_error_envelope() {
        assert_eq!(parse_frame(&fixture("malformed.txt"), NOW), Frame::Malformed("not JSON"));
        assert_eq!(parse_frame(&fixture("error_envelope.json"), NOW), Frame::Error("Api Key Is Not Valid".into()));
        assert!(matches!(classify_text("Api Key Is Not Valid"), Failure::Auth(_)));
        assert_eq!(parse_frame(&fixture("position_not_available.json"), NOW), Frame::Malformed("position not available"));
        assert_eq!(parse_frame(r#"{"MessageType":"PositionReport","Message":{},"MetaData":{"MMSI":1}}"#, NOW), Frame::Malformed("no Message body for its MessageType"));
        assert_eq!(parse_frame(r#"{"MessageType":"PositionReport","Message":{"PositionReport":{"Latitude":29,"Longitude":-90}},"MetaData":{}}"#, NOW), Frame::Malformed("no valid MMSI"));
        assert_eq!(parse_frame("[1,2]", NOW), Frame::Malformed("not an object"));
        assert_eq!(parse_frame(&"x".repeat(MAX_FRAME_BYTES + 1), NOW), Frame::Malformed("frame too large"));
        // A time in the future (clock skew) falls back to the receive time.
        let future = fixture("position_report.json").replace("2024-12-09", "2099-12-09");
        let Frame::Position(p) = parse_frame(&future, NOW) else { panic!() };
        assert_eq!(p.observed_at, NOW);
    }

    #[test]
    fn ais_parse_batch_counts_bad_frames() {
        let batch = [
            fixture("position_report.json"),
            fixture("malformed.txt"),
            fixture("ship_static_data.json"),
            fixture("error_envelope.json"),
            fixture("class_b_position.json"),
            fixture("static_data_report.json"),
            fixture("position_not_available.json"),
        ]
        .map(|s| s.trim().to_string())
        .join("\n");
        let (rows, counts) = normalize_batch(batch.as_bytes(), NOW);
        assert_eq!(counts, Counts { positions: 2, statics: 2, malformed: 2, errors: 1 });
        assert_eq!(rows.len(), 4);
        // Pure and idempotent.
        assert_eq!(normalize_batch(batch.as_bytes(), NOW).0, rows);
    }

    #[test]
    fn ais_parse_subscription_and_endpoint() {
        let app = App::builtin("lionfish").unwrap();
        let key = ApiKey::new("k3y-value".into());
        let sub: Value = serde_json::from_str(&subscription(&key, &app)).unwrap();
        assert_eq!(sub["APIKey"], "k3y-value");
        assert_eq!(sub["BoundingBoxes"].as_array().unwrap().len(), 4, "one box per region");
        assert_eq!(sub["BoundingBoxes"][0], json!([[24.3, -83.2], [27.5, -79.8]]), "latitude first");
        assert_eq!(format!("{key:?}"), "ApiKey([redacted])");
        assert_eq!(key.scrub("bad key k3y-value"), "bad key [redacted]");
        assert_eq!(endpoint(None).unwrap(), DEFAULT_URL);
        assert!(endpoint(Some("ws://127.0.0.1:9999/v0/stream")).is_ok());
        assert!(endpoint(Some("ws://localhost:1")).is_ok());
        assert!(endpoint(Some("ws://evil.example:1/")).is_err());
        assert!(endpoint(Some("wss://127.0.0.1.evil.example/")).is_err());
        assert!(endpoint(Some("https://stream.aisstream.io/v0/stream")).is_err());
    }

    #[test]
    fn ais_parse_thinner() {
        let mut t = Thinner::default();
        let Frame::Position(p) = parse_frame(&fixture("position_report.json"), NOW) else { panic!() };
        let at = |ms: i64| Frame::Position(VesselPositionRow { observed_at: p.observed_at - p.observed_at % 60_000 + ms, ..p.clone() });
        assert!(t.keep(&at(0)));
        assert!(!t.keep(&at(30_000)), "same minute");
        assert!(t.keep(&at(60_000)));
        let s = parse_frame(&fixture("ship_static_data.json"), NOW);
        assert!(t.keep(&s));
        assert!(!t.keep(&s), "unchanged static data");
        let Frame::Static(mut changed) = s else { panic!() };
        changed.destination = Some("HOUMA".into());
        assert!(t.keep(&Frame::Static(changed)));
    }

    /// A local mock AISStream: accepts one connection, hands over the subscription it got, then
    /// sends `frames` and keeps the socket open.
    async fn mock_server(frames: Vec<String>) -> (String, tokio::sync::oneshot::Receiver<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/v0/stream", listener.local_addr().unwrap());
        let (sub_tx, sub_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let Some(Ok(Message::Text(sub))) = ws.next().await else { panic!("no subscription") };
            let _ = sub_tx.send(sub.as_str().to_string());
            for f in frames {
                // AISStream sends binary frames; text must work too.
                ws.send(Message::binary(f.into_bytes())).await.unwrap();
            }
            while ws.next().await.is_some() {}
        });
        (url, sub_rx)
    }

    fn iso(ms: i64) -> String {
        chrono::DateTime::from_timestamp_millis(ms).unwrap().to_rfc3339()
    }

    /// `fixture` with its time set to `at` and its position moved to `lat, lon`.
    fn frame_at(name: &str, at: i64, lat: f64, lon: f64) -> String {
        let mut v: Value = serde_json::from_str(&fixture(name)).unwrap();
        let kind = v["MessageType"].as_str().unwrap().to_string();
        let t = chrono::DateTime::from_timestamp_millis(at).unwrap().format("%Y-%m-%d %H:%M:%S%.9f +0000 UTC").to_string();
        v["MetaData"]["time_utc"] = json!(t);
        v["MetaData"]["latitude"] = json!(lat);
        v["MetaData"]["longitude"] = json!(lon);
        if v["Message"][&kind].get("Latitude").is_some() {
            v["Message"][&kind]["Latitude"] = json!(lat);
            v["Message"][&kind]["Longitude"] = json!(lon);
        }
        v.to_string()
    }

    #[tokio::test]
    async fn vessels_ingest_from_mock_socket_to_graphql_and_evidence() {
        use crate::app::test_support::test_state_for;
        let state = test_state_for("carp");
        crate::ingest::scheduler::start(state.clone(), Default::default()).await.unwrap();
        let now = physical::now_ms();
        // Five seconds into a minute, so t0 and t0 + 20 s share it.
        let t0 = (now - 30 * 60_000).div_euclid(60_000) * 60_000 + 5_000;
        let frames = vec![
            frame_at("ship_static_data.json", t0, 29.93, -90.06),
            frame_at("class_b_position.json", t0, 29.20, -89.99),
            frame_at("class_b_position.json", t0 + 20_000, 29.21, -89.99), // same minute: thinned
            frame_at("class_b_position.json", t0 + 120_000, 29.22, -89.98),
            fixture("malformed.txt"),
            frame_at("position_report.json", t0, 42.3, -83.0), // Detroit: outside carp, skipped
        ];
        let (url, sub) = mock_server(frames).await;
        let key = ApiKey::new("mock-key-123".into());
        let mut ais = Ais::new(state.app.clone(), key, url, Policy::default());
        ais.gather = Duration::from_millis(500);
        let ctx = FetchCtx { state: &state, cursor: None };
        let payloads = ais.fetch(&ctx).await.unwrap();
        let sub: Value = serde_json::from_str(&sub.await.unwrap()).unwrap();
        assert_eq!(sub["APIKey"], "mock-key-123");
        assert_eq!(sub["BoundingBoxes"], json!([[[28.9, -94.0], [32.9, -88.8]]]), "the carp box, latitude first");
        assert_eq!(payloads.len(), 1);
        let lines = String::from_utf8_lossy(&payloads[0].bytes).lines().count();
        assert_eq!(lines, 4, "static + 2 positions + the out-of-region one; the same-minute fix and the bad frame never queued");
        assert_eq!((ais.status.thinned.load(Ordering::Relaxed), ais.status.malformed.load(Ordering::Relaxed)), (1, 1));
        let out = crate::ingest::scheduler::ingest_payload(&state, &ais, payloads[0].clone(), None).await.unwrap();
        assert_eq!((out.rows_in, out.rows_skipped), (4, 1), "the Detroit fix is outside the app's region");

        let q = r#"query($bbox: BBox!, $from: Time!, $to: Time!) { vessels(bbox: $bbox, from: $from, to: $to) { mmsi name type points { at lat lon sog cog heading } } }"#;
        let vars = json!({ "bbox": { "west": -94.0, "south": 28.9, "east": -88.8, "north": 32.9 }, "from": iso(t0 - 60_000), "to": iso(now) });
        let res = crate::graphql::schema().execute(async_graphql::Request::new(q).variables(async_graphql::Variables::from_json(vars)).data(state.clone())).await;
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        let data = res.data.into_json().unwrap();
        let tracks = data["vessels"].as_array().unwrap();
        assert_eq!(tracks.len(), 1, "only the class B vessel has positions: {data}");
        assert_eq!(tracks[0]["mmsi"], "338123456");
        assert_eq!(tracks[0]["points"].as_array().unwrap().len(), 2);
        assert_eq!(tracks[0]["points"][0]["lat"], 29.2);

        let ev = crate::evidence::evidence(&state, "vessel:367123450").await.unwrap();
        assert_eq!((ev.record["name"].as_str(), ev.record["type"].as_str(), ev.record["destination"].as_str()), (Some("MISS LOUISE"), Some("tug"), Some("NEW ORLEANS")));
        assert_eq!(ev.source_page_url.as_deref(), Some("https://www.vesselfinder.com/vessels/details/367123450"));
        assert_eq!(ev.raw.as_ref().unwrap()["frames"].as_array().unwrap().len(), 1, "only this vessel's frames of the batch");
        assert!(!ev.links.is_empty(), "links the fetch run");
        assert!(matches!(crate::evidence::evidence(&state, "vessel:12").await, Err(crate::evidence::EvidenceError::NotFound(_))));
        assert!(matches!(crate::evidence::evidence(&state, "vessel:abc").await, Err(crate::evidence::EvidenceError::BadId(_))));

        // Feed state: the source is registered disabled in tests (no key), with the reason.
        let feeds = crate::feed_state::compute(&state.obs, state.now_ms()).await.unwrap();
        let f = feeds.iter().find(|f| f.source == SOURCE_ID).unwrap();
        assert_eq!(f.note.as_deref(), Some("disabled: AISSTREAM_API_KEY not set"));
        assert!(f.newest_observed_at.is_some(), "stored history still counts");

        // Python does not list the feed: no vessels there.
        let py = test_state_for("python");
        let res = crate::graphql::schema().execute(async_graphql::Request::new("{ vessels(bbox: {west: -81, south: 25, east: -80, north: 26}, from: \"2026-09-30T00:00:00Z\", to: \"2026-09-30T01:00:00Z\") { mmsi } }").data(py)).await;
        assert_eq!(res.errors[0].extensions.as_ref().unwrap().get("code"), Some(&async_graphql::Value::from("NO_VESSEL_FEED")));
    }

    #[tokio::test]
    async fn vessels_auth_error_envelope_stops_the_source_without_leaking_the_key() {
        use crate::app::test_support::test_state_for;
        let state = test_state_for("carp");
        let (url, _sub) = mock_server(vec![r#"{"error":"Api Key Is Not Valid: mock-key-456"}"#.to_string()]).await;
        let ais = Ais::new(state.app.clone(), ApiKey::new("mock-key-456".into()), url, Policy::default());
        let ctx = FetchCtx { state: &state, cursor: None };
        let err = loop {
            match ais.fetch(&ctx).await {
                Ok(p) => assert!(p.is_empty()),
                Err(e) => break format!("{e:#}"),
            }
        };
        assert!(err.contains("rejected the API key"), "{err}");
        assert!(!err.contains("mock-key-456"), "the key never appears in an error: {err}");
        assert!(ais.status.auth_failed.load(Ordering::Relaxed));
        assert_eq!(ais.status.connects.load(Ordering::Relaxed), 1, "no retry after an auth rejection");
    }

    /// G5: the real feed for the carp box. Needs `AISSTREAM_API_KEY`; run with
    /// `doppler run --project inversa --config dev -- cargo test --release ais_live -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "needs AISSTREAM_API_KEY and the network"]
    async fn ais_live() {
        let key = ApiKey::new(std::env::var("AISSTREAM_API_KEY").expect("AISSTREAM_API_KEY"));
        let app = App::builtin("carp").unwrap();
        let conn = Conn { url: DEFAULT_URL.into(), key: key.clone(), subscription: subscription(&key, &app), app: "carp".into() };
        let (tx, mut rx) = mpsc::channel(QUEUE);
        let status = Arc::new(Status::default());
        let task = tokio::spawn(connection(conn, Policy::default(), tx, status.clone()));
        let record = std::env::var("AIS_RECORD_DIR").ok();
        let mut recorded = std::collections::HashSet::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
        let mut positions = 0;
        while let Ok(Some(text)) = tokio::time::timeout_at(deadline, rx.recv()).await {
            let frame = parse_frame(&text, physical::now_ms());
            if let Frame::Position(p) = &frame {
                assert!(app.region_of(p.lat, p.lon).is_some(), "position outside the carp box: {p:?}");
                positions += 1;
            }
            if let Some(dir) = &record {
                let kind = serde_json::from_str::<Value>(&text).ok().and_then(|v| v["MessageType"].as_str().map(str::to_string)).unwrap_or_default();
                if recorded.insert(kind.clone()) {
                    std::fs::write(format!("{dir}/live_{kind}.json"), key.scrub(&text)).unwrap();
                }
            }
            if positions >= 50 {
                break;
            }
        }
        task.abort();
        println!("AISLIVE app=carp positions={positions} frames={} last_error={:?}", status.frames.load(Ordering::Relaxed), status.last_error());
        assert!(positions > 0);
    }
}
