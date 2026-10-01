//! NWWS-OI XMPP push (T8, PRD §2 and §6). Enabled when `NWWS_USER` is set.
//!
//! A background task logs in to `nwws-oi.weather.gov` (STARTTLS, port 5222), joins the
//! `nwws@conference.nwws-oi.weather.gov` room and keeps the session up (tokio-xmpp reconnects
//! on its own; the room is re-joined, with history back to the last product seen, on every
//! `Online`). Each groupchat message carries one product in `<x xmlns="nwws-oi" cccc=...
//! awipsid=... issue=... id=...>`. Products from the Miami (KMFL) and Key West (KKEY) offices
//! whose AWIPS category is relevant (freeze/heat/wind NPW, coastal CFW, marine MWW/SMW/MWS,
//! flood FFW/FFS/FLW/FLS, fire RFW, tropical TCV) go into a channel as the stanza XML.
//! `fetch` drains the channel, waiting up to [`WAIT`] for the first product.
//!
//! `normalize` parses the product text: segments split at `$$`, each with a UGC zone line,
//! P-VTEC lines, a `...HEADLINE...` and an optional `LAT...LON` polygon. VTEC segments get the
//! same ext id the NWS alerts API poller derives (`poll::nws::vtec_ext_id`), so both feeds update
//! one row per event segment.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Context;
use async_trait::async_trait;
use futures_util::StreamExt;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_xmpp::connect::DnsConfig;
use tokio_xmpp::minidom::Element;
use tokio_xmpp::parsers::jid::{BareJid, Jid};
use tokio_xmpp::parsers::message::{Message, MessageType};
use tokio_xmpp::parsers::muc::muc::{History, Muc};
use tokio_xmpp::parsers::presence::{Presence, Type as PresenceType};
use tokio_xmpp::xmlstream::Timeouts;
use tokio_xmpp::{Client, Event, Stanza};

use crate::ingest::poll::nws::{parse_ugc, squash, vtec_ext_id, Vtec, REGION_OFFICES};
use crate::ingest::poll::physical::{self, parse_rfc3339_ms};
use crate::ingest::source::{FetchCtx, Mode, RawPayload, Source, SourceInfo};
use crate::model::{AlertRow, Row};
use crate::state::Config;

pub const HOST: &str = "nwws-oi.weather.gov";
pub const PORT: u16 = 5222;
pub const ROOM: &str = "nwws@conference.nwws-oi.weather.gov";
pub const NS: &str = "nwws-oi";
/// Longest `fetch` waits for the first queued product.
pub const WAIT: Duration = Duration::from_secs(20);
/// At most this many products per fetch.
const BATCH: usize = 200;
/// Room history requested after a reconnect, at most.
const MAX_HISTORY_S: i64 = 3600;
const QUEUE: usize = 1024;

/// AWIPS product categories (first three characters of the AWIPS id) and their names.
pub const PRODUCTS: [(&str, &str); 12] = [
    ("NPW", "Non-Precipitation Weather Message"),
    ("CFW", "Coastal Hazard Message"),
    ("MWW", "Marine Weather Message"),
    ("SMW", "Special Marine Warning"),
    ("MWS", "Marine Weather Statement"),
    ("FFW", "Flash Flood Warning"),
    ("FFS", "Flash Flood Statement"),
    ("FLW", "Flood Warning"),
    ("FLS", "Flood Statement"),
    ("RFW", "Fire Weather Message"),
    ("TCV", "Tropical Cyclone Watch/Warning"),
    ("WSW", "Winter Weather Message"),
];

/// Only products from the region's offices and relevant categories are kept.
pub fn is_relevant(cccc: &str, awipsid: &str) -> bool {
    let office = REGION_OFFICES.contains(&cccc)
        || (awipsid.len() == 6 && REGION_OFFICES.iter().any(|o| o[1..] == awipsid[3..]));
    office && awipsid.get(..3).is_some_and(|cat| PRODUCTS.iter().any(|(p, _)| *p == cat))
}

pub fn sources(config: &Config) -> Vec<Arc<dyn Source>> {
    match &config.nwws_user {
        Some(user) => vec![Arc::new(Nwws::new(user.clone(), config.nwws_pass.clone()))],
        None => vec![],
    }
}

/// Why the source is not running, if it is not (the reason becomes the feed-state note).
pub fn disabled_reason(config: &Config) -> Option<String> {
    config.nwws_user.is_none().then(|| "NWWS_USER and NWWS_PASS not set; alerts come from the nws poller".to_string())
}

/// Static description, shared by the running source and its disabled registration.
///
/// `cadence` is the fetch loop's heartbeat: while connected, `fetch` returns at least every
/// [`WAIT`] (an empty run when no product arrived), so three missed heartbeats mean the
/// connection task is stuck and the feed shows down.
pub fn info() -> SourceInfo {
    SourceInfo {
        id: "nwws",
        name: "NOAA Weather Wire Service (NWWS-OI)",
        homepage: "https://www.weather.gov/nwws/",
        mode: Mode::Push,
        cadence: WAIT,
        max_latency: Duration::from_secs(6 * 3600),
    }
}

#[derive(Default)]
struct Status {
    online: AtomicBool,
    /// Unix ms of the last product received, for the history window after a reconnect.
    last_product_ms: AtomicI64,
    last_error: Mutex<Option<String>>,
}

impl Status {
    fn error(&self, e: impl std::fmt::Display) {
        *self.last_error.lock().expect("status") = Some(e.to_string());
    }
}

struct Queue {
    rx: mpsc::Receiver<Vec<u8>>,
    task: Option<JoinHandle<()>>,
}

pub struct Nwws {
    user: String,
    pass: Option<String>,
    status: Arc<Status>,
    queue: tokio::sync::Mutex<Queue>,
}

impl Nwws {
    pub fn new(user: String, pass: Option<String>) -> Self {
        let (_, rx) = mpsc::channel(1);
        Nwws { user, pass, status: Arc::new(Status::default()), queue: tokio::sync::Mutex::new(Queue { rx, task: None }) }
    }

    /// Start (or restart after a panic) the connection task, with a fresh channel.
    fn ensure_running(&self, q: &mut Queue, pass: &str) {
        if q.task.as_ref().is_some_and(|t| !t.is_finished()) {
            return;
        }
        let (tx, rx) = mpsc::channel(QUEUE);
        q.rx = rx;
        q.task = Some(tokio::spawn(connection(self.user.clone(), pass.to_string(), tx, self.status.clone())));
    }
}

#[async_trait]
impl Source for Nwws {
    fn info(&self) -> SourceInfo {
        info()
    }

    fn min_interval(&self) -> Duration {
        Duration::ZERO
    }

    async fn fetch(&self, _ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
        let pass = self.pass.as_deref().context("NWWS_USER is set but NWWS_PASS is not")?;
        let mut q = self.queue.lock().await;
        self.ensure_running(&mut q, pass);
        let first = match tokio::time::timeout(WAIT, q.rx.recv()).await {
            Ok(Some(first)) => first,
            Ok(None) => anyhow::bail!("nwws-oi connection task stopped"),
            Err(_) => {
                if !self.status.online.load(Ordering::Relaxed) {
                    if let Some(e) = self.status.last_error.lock().expect("status").clone() {
                        anyhow::bail!("nwws-oi offline: {e}");
                    }
                }
                return Ok(Vec::new());
            }
        };
        let mut out = vec![stanza_payload(first)];
        while out.len() < BATCH {
            match q.rx.try_recv() {
                Ok(next) => out.push(stanza_payload(next)),
                Err(_) => break,
            }
        }
        Ok(out)
    }

    fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
        normalize_stanza(&raw.bytes, raw.fetched_at)
    }
}

fn stanza_payload(bytes: Vec<u8>) -> RawPayload {
    RawPayload {
        source_url: format!("xmpp:{ROOM}"),
        content_type: "application/xml".into(),
        bytes,
        http_status: None,
        fetched_at: physical::now_ms(),
        next_cursor: None,
        ack: None,
    }
}

/// The long-lived XMPP session. Never returns while the receiver is alive.
async fn connection(user: String, pass: String, tx: mpsc::Sender<Vec<u8>>, status: Arc<Status>) {
    // Exactly one rustls backend (ring) is compiled in; installing is idempotent across restarts.
    let _ = tokio_xmpp::rustls::crypto::ring::default_provider().install_default();
    let jid_str = if user.contains('@') { user.clone() } else { format!("{user}@{HOST}") };
    let jid = match jid_str.parse::<BareJid>() {
        Ok(j) => j,
        Err(e) => {
            status.error(format!("invalid NWWS_USER {jid_str:?}: {e}"));
            return;
        }
    };
    let room: BareJid = ROOM.parse().expect("room jid");
    let nick = format!("{}-inversa-{}", jid.node().map(|n| n.as_str()).unwrap_or("user"), &uuid::Uuid::now_v7().simple().to_string()[24..]);
    let mut client = Client::new_starttls(jid, pass, DnsConfig::no_srv(HOST, PORT), Timeouts::default());
    while let Some(event) = client.next().await {
        match event {
            Event::Online { .. } => {
                status.online.store(true, Ordering::Relaxed);
                *status.last_error.lock().expect("status") = None;
                let last = status.last_product_ms.load(Ordering::Relaxed);
                let history = if last > 0 {
                    let since = ((physical::now_ms() - last) / 1000 + 5).clamp(0, MAX_HISTORY_S);
                    History::new().with_seconds(since as u32)
                } else {
                    History::new().with_maxstanzas(0)
                };
                let to = match room.with_resource_str(&nick) {
                    Ok(full) => Jid::from(full),
                    Err(e) => {
                        status.error(format!("room nick {nick:?}: {e}"));
                        return;
                    }
                };
                let join = Presence::new(PresenceType::None).with_to(to).with_payload(Muc::new().with_history(history));
                if let Err(e) = client.send_stanza(join.into()).await {
                    status.error(format!("join {ROOM}: {e}"));
                } else {
                    tracing::info!(source = "nwws", "joined {ROOM} as {nick}");
                }
            }
            Event::Disconnected(e) => {
                status.online.store(false, Ordering::Relaxed);
                tracing::warn!(source = "nwws", "disconnected: {e}");
                status.error(e);
            }
            Event::Stanza(Stanza::Message(m)) => {
                if let Some(bytes) = relevant_product(m) {
                    status.last_product_ms.store(physical::now_ms(), Ordering::Relaxed);
                    if tx.send(bytes).await.is_err() {
                        return;
                    }
                }
            }
            Event::Stanza(_) => {}
        }
    }
    status.online.store(false, Ordering::Relaxed);
    status.error("xmpp stream ended");
}

/// The serialized stanza, if it is a room product from the region we keep.
fn relevant_product(m: Message) -> Option<Vec<u8>> {
    if m.type_ != MessageType::Groupchat {
        return None;
    }
    let x = m.payloads.iter().find(|p| p.is("x", NS))?;
    if !is_relevant(x.attr("cccc").unwrap_or_default(), x.attr("awipsid").unwrap_or_default()) {
        return None;
    }
    let el = Element::from(m);
    Some(String::from(&el).into_bytes())
}

/// One product stanza to alert rows. Stanzas outside the region filter give no rows.
pub fn normalize_stanza(bytes: &[u8], fetched_at: i64) -> anyhow::Result<Vec<Row>> {
    let xml = std::str::from_utf8(bytes).context("nwws stanza utf-8")?;
    let el: Element = xml.parse().map_err(|e| anyhow::anyhow!("nwws stanza xml: {e}"))?;
    let x = if el.is("x", NS) { &el } else { el.children().find(|c| c.is("x", NS)).context("nwws: no <x xmlns=\"nwws-oi\">")? };
    let cccc = x.attr("cccc").unwrap_or_default();
    let awips = x.attr("awipsid").unwrap_or_default().trim();
    if !is_relevant(cccc, awips) {
        return Ok(Vec::new());
    }
    let issued = x.attr("issue").and_then(parse_rfc3339_ms).unwrap_or(fetched_at);
    let id = x.attr("id").unwrap_or_default();
    let fallback_id = if id.is_empty() { format!("{cccc}.{awips}.{issued}") } else { id.to_string() };
    Ok(parse_product(&x.text(), issued, &fallback_id, awips).into_iter().map(Row::Alert).collect())
}

/// Raw product text (WMO header, AWIPS id, segments) to alerts. `issued_ms` anchors UGC expiry
/// times and the ETN year.
pub fn parse_product(text: &str, issued_ms: i64, product_id: &str, awips: &str) -> Vec<AlertRow> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let year = chrono::DateTime::from_timestamp_millis(issued_ms).map(|t| chrono::Datelike::year(&t)).unwrap_or(1970);
    let category = awips.get(..3).unwrap_or_default();
    let product_name = PRODUCTS.iter().find(|(p, _)| *p == category).map(|(_, n)| *n).unwrap_or("NWS product");

    let mut out = Vec::new();
    for (seg_idx, segment) in text.split("\n$$").enumerate() {
        let lines: Vec<&str> = segment.lines().map(str::trim_end).collect();
        let Some((ugc, ugc_end)) = find_ugc(&lines, issued_ms) else { continue };
        let body = &lines[ugc_end..];
        let vtecs: Vec<Vtec> = body.iter().filter_map(|l| Vtec::parse(l)).collect();
        let headline = find_headline(body);
        let polygon = find_polygon(body);
        if vtecs.is_empty() {
            out.push(AlertRow {
                ext_id: format!("nwws:{product_id}:{seg_idx}"),
                event: product_name.to_string(),
                severity: "Unknown".into(),
                headline,
                area_geojson: polygon,
                onset: Some(issued_ms),
                expires: ugc.expires,
            });
            continue;
        }
        for v in vtecs {
            let expires = if v.ends_event() { Some(issued_ms) } else { v.end.or(ugc.expires) };
            out.push(AlertRow {
                ext_id: vtec_ext_id(&v, year, &ugc.zones),
                event: v.event_name(),
                severity: v.severity().to_string(),
                headline: headline.clone(),
                area_geojson: polygon.clone(),
                onset: Some(v.begin.unwrap_or(issued_ms)),
                expires,
            });
        }
    }
    out
}

/// The UGC block: starts with `SSCNNN`, may wrap, ends with the `DDHHMM-` expiry. Returns the
/// parsed block and the index of the first line after it.
fn find_ugc(lines: &[&str], issued_ms: i64) -> Option<(crate::ingest::poll::nws::Ugc, usize)> {
    let starts = |l: &str| {
        let b = l.as_bytes();
        b.len() >= 7
            && b[..2].iter().all(u8::is_ascii_uppercase)
            && (b[2] == b'C' || b[2] == b'Z')
            && b[3..6].iter().all(u8::is_ascii_digit)
            && (b[6] == b'-' || b[6] == b'>')
    };
    let start = lines.iter().position(|l| starts(l.trim()))?;
    let mut joined = String::new();
    for (i, line) in lines.iter().enumerate().skip(start).take(8) {
        joined.push_str(line.trim());
        if joined.ends_with('-') {
            if let Some(ugc) = parse_ugc(&joined, issued_ms) {
                return Some((ugc, i + 1));
            }
        }
    }
    None
}

/// First `...HEADLINE...` (may wrap across lines), without the dots.
fn find_headline(lines: &[&str]) -> Option<String> {
    let start = lines.iter().position(|l| l.trim_start().starts_with("...") && !l.trim_start().starts_with("...."))?;
    let mut text = String::new();
    for line in &lines[start..] {
        if line.trim().is_empty() {
            break;
        }
        text.push(' ');
        text.push_str(line.trim());
        if text.trim_end().ends_with("...") && text.trim().len() > 3 {
            break;
        }
    }
    let h = squash(text.trim().trim_start_matches('.').trim_end_matches('.'));
    (!h.is_empty()).then_some(h)
}

/// `LAT...LON 2508 8037 2516 8047 ...` (hundredths of a degree, west longitude positive) to a
/// GeoJSON polygon.
fn find_polygon(lines: &[&str]) -> Option<serde_json::Value> {
    let start = lines.iter().position(|l| l.trim_start().starts_with("LAT...LON"))?;
    let mut nums: Vec<f64> = Vec::new();
    for (i, line) in lines[start..].iter().enumerate() {
        let line = if i == 0 { line.trim_start().trim_start_matches("LAT...LON") } else { line };
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.is_empty() || !tokens.iter().all(|t| t.bytes().all(|b| b.is_ascii_digit())) {
            if i == 0 && tokens.is_empty() {
                continue;
            }
            break;
        }
        nums.extend(tokens.iter().filter_map(|t| t.parse::<f64>().ok()));
    }
    if nums.len() < 6 || !nums.len().is_multiple_of(2) {
        return None;
    }
    let mut ring: Vec<[f64; 2]> = nums.chunks(2).map(|p| [-p[1] / 100.0, p[0] / 100.0]).collect();
    if ring.first() != ring.last() {
        ring.push(ring[0]);
    }
    Some(serde_json::json!({"type": "Polygon", "coordinates": [ring]}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::poll::nws::normalize_alerts;
    use crate::ingest::poll::physical::testing::{assert_idempotent, fixture, python_app, FakeFetch};

    fn stanza(name: &str) -> RawPayload {
        RawPayload { fetched_at: 1_790_800_900_000, ..stanza_payload(fixture(&format!("nwws/{name}"))) }
    }

    fn alerts(name: &str) -> Vec<AlertRow> {
        normalize_stanza(&stanza(name).bytes, 0)
            .unwrap()
            .into_iter()
            .map(|r| match r {
                Row::Alert(a) => a,
                other => panic!("{other:?}"),
            })
            .collect()
    }

    fn ms(s: &str) -> i64 {
        parse_rfc3339_ms(s).unwrap()
    }

    #[test]
    fn nwws_source_absent_without_user() {
        let app = python_app();
        let mut config = Config::for_tests();
        assert!(sources(&config).is_empty());
        assert!(crate::ingest::push::all(&config, &app).iter().all(|s| s.info().id != "nwws"));
        config.nwws_user = Some("someone".into());
        config.nwws_pass = Some("not-a-real-password".into());
        let listed = sources(&config);
        assert_eq!(listed.len(), 1);
        let info = listed[0].info();
        assert_eq!((info.id, info.mode), ("nwws", Mode::Push));
        assert_eq!(listed[0].min_interval(), Duration::ZERO);
        assert!(crate::ingest::push::all(&config, &app).iter().any(|s| s.info().id == "nwws"));
    }

    #[tokio::test]
    async fn nwws_user_without_password_reports_error() {
        let src = Nwws::new("someone".into(), None);
        let state = crate::app::test_support::test_state();
        let err = src.fetch(&FetchCtx { state: &state, cursor: None }).await.unwrap_err();
        assert!(err.to_string().contains("NWWS_PASS"), "{err}");
    }

    #[test]
    fn nwws_relevance_filter() {
        assert!(is_relevant("KKEY", "CFWKEY"));
        assert!(is_relevant("KMFL", "NPWMFL"));
        assert!(is_relevant("KMFL", "MWWMFL"));
        assert!(!is_relevant("KMLB", "CFWMLB"), "other office");
        assert!(!is_relevant("KMFL", "AFDMFL"), "forecast discussion is not an alert");
        assert!(!is_relevant("KMFL", ""));
    }

    #[test]
    fn nwws_fixture_key_coastal_flood_matches_api_row() {
        let rows = alerts("cfwkey.xml");
        assert_eq!(rows.len(), 1);
        let a = &rows[0];
        assert_eq!(a.ext_id, "vtec:KKEY.CF.Y.0003.2026:FLZ076,FLZ077,FLZ078");
        assert_eq!(a.event, "Coastal Flood Advisory");
        assert_eq!(a.severity, "Minor");
        assert_eq!(a.headline.as_deref(), Some("COASTAL FLOOD ADVISORY NOW IN EFFECT UNTIL 5 AM EDT THURSDAY"));
        assert_eq!(a.onset, Some(ms("2026-09-30T15:36:00Z")));
        assert_eq!(a.expires, Some(ms("2026-10-01T09:00:00Z")));

        // The NWS API poll saw the same product as CAP: same key, event, times and headline.
        let api: Vec<AlertRow> = normalize_alerts(&fixture("nws/alerts_active_fl_am_gm.json"), &crate::ingest::poll::nws::Scope::for_app(&python_app()))
            .unwrap()
            .into_iter()
            .filter_map(|r| match r {
                Row::Alert(a) => Some(a),
                _ => None,
            })
            .collect();
        let twin = api.iter().find(|x| x.ext_id == a.ext_id).expect("API row with the same VTEC key");
        assert_eq!((&twin.event, twin.onset, twin.expires, &twin.headline), (&a.event, a.onset, a.expires, &a.headline));
    }

    #[test]
    fn nwws_fixture_miami_multi_segment_with_expiry() {
        let rows = alerts("cfwmfl.xml");
        let keys: Vec<&str> = rows.iter().map(|a| a.ext_id.as_str()).collect();
        assert_eq!(
            keys,
            [
                "vtec:KMFL.CF.Y.0001.2026:FLZ168,FLZ172,FLZ173",
                "vtec:KMFL.CF.S.0004.2026:FLZ168,FLZ172,FLZ173",
                "vtec:KMFL.CF.S.0004.2026:FLZ069,FLZ075,FLZ174",
            ]
        );
        // EXP: over at issuance. CON: until the VTEC end.
        assert_eq!(rows[0].event, "Coastal Flood Advisory");
        assert_eq!(rows[0].expires, Some(ms("2026-09-30T12:00:00Z")));
        assert_eq!(rows[1].expires, Some(ms("2026-10-01T21:00:00Z")));
        assert_eq!(rows[2].expires, Some(ms("2026-10-01T16:00:00Z")));
        assert_eq!(
            rows[1].headline.as_deref(),
            Some("COASTAL FLOOD STATEMENT REMAINS IN EFFECT THROUGH THURSDAY AFTERNOON")
        );
        assert!(rows.iter().all(|a| a.onset == Some(ms("2026-09-30T12:00:00Z"))));
    }

    #[test]
    fn nwws_other_office_stanza_gives_no_rows() {
        let xml = String::from_utf8(fixture("nwws/cfwkey.xml")).unwrap().replace("cccc=\"KKEY\"", "cccc=\"KMLB\"").replace("awipsid=\"CFWKEY\"", "awipsid=\"CFWMLB\"");
        assert!(normalize_stanza(xml.as_bytes(), 0).unwrap().is_empty());
    }

    #[test]
    fn nwws_polygon_and_non_vtec_segment() {
        let text = "\n\n123\nWHUS52 KKEY 011200\nMWSKEY\n\nMarine Weather Statement\n\nGMZ042-043-011300-\n\
            800 AM EDT Thu Oct 1 2026\n\n...A STRONG THUNDERSTORM OVER FLORIDA BAY...\n\n\
            LAT...LON 2508 8037 2516 8047 2505 8060\n      2500 8050\nTIME...MOT...LOC 1158Z 250DEG 10KT 2510 8045\n\n$$\n";
        let issued = ms("2026-10-01T12:00:00Z");
        let rows = parse_product(text, issued, "999.1", "MWSKEY");
        assert_eq!(rows.len(), 1);
        let a = &rows[0];
        assert_eq!(a.ext_id, "nwws:999.1:0");
        assert_eq!(a.event, "Marine Weather Statement");
        assert_eq!(a.headline.as_deref(), Some("A STRONG THUNDERSTORM OVER FLORIDA BAY"));
        assert_eq!(a.expires, Some(ms("2026-10-01T13:00:00Z")));
        let ring = a.area_geojson.as_ref().unwrap()["coordinates"][0].as_array().unwrap().clone();
        assert_eq!(ring.len(), 5, "closed ring");
        assert_eq!(ring[0], serde_json::json!([-80.37, 25.08]));
        assert_eq!(ring[3], serde_json::json!([-80.5, 25.0]));
    }

    #[test]
    fn nwws_stanza_serialization_roundtrip() {
        let el: Element = String::from_utf8(fixture("nwws/cfwkey.xml")).unwrap().parse().unwrap();
        let m = Message::try_from(el).unwrap();
        let bytes = relevant_product(m).expect("relevant");
        assert_eq!(normalize_stanza(&bytes, 0).unwrap().len(), 1, "re-serialized stanza still parses");
    }

    #[tokio::test]
    async fn nwws_idempotent() {
        let src = Nwws::new("someone".into(), Some("unused".into()));
        let (state, first) =
            assert_idempotent(FakeFetch { inner: src, payloads: vec![stanza("cfwkey.xml"), stanza("cfwmfl.xml")] }).await;
        assert_eq!(first.iter().map(|o| o.rows_written).sum::<usize>(), 4);
        let n: i64 = state.obs.read(|c| c.query_row("select count(*) from alerts where source_id = 'nwws'", [], |r| r.get(0))).await.unwrap();
        assert_eq!(n, 4);
    }
}
