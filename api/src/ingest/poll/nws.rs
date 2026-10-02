//! NWS alerts API poller (T8, PRD §2): `api.weather.gov/alerts/active` for Florida plus the
//! Atlantic and Gulf marine areas, every 60 s, conditional on the previous `ETag` /
//! `Last-Modified`. A 304 yields no payload.
//!
//! Kept: alerts whose geometry intersects the region, whose SAME county codes are region
//! counties (zone-based alerts carry no geometry), or that come from the Miami (MFL) or Key West
//! (KEY) forecast offices, which cover the region's land and marine zones.
//!
//! VTEC-coded alerts are keyed by their VTEC event and zone set (see [`vtec_ext_id`]) instead of
//! the CAP message id, which changes on every update. Continuations and extensions then update
//! one row in place, and the NWWS-OI push source (`push::nwws`) derives the same key from the
//! raw product text, so both feeds converge on one row per event segment.

use std::sync::Mutex;
use std::time::Duration;

use anyhow::Context;
use async_trait::async_trait;
use chrono::{Datelike, TimeZone, Utc};
use reqwest::header::{ACCEPT, ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED, USER_AGENT};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use sha2::Digest;

use crate::app::config::App;
use crate::forecast::store::AlertSeen;
use crate::ingest::governor;
use crate::ingest::poll::physical::{self, parse_rfc3339_ms, BBox};
use crate::ingest::source::{FetchCtx, Mode, RawPayload, Source, SourceInfo};
use crate::model::{AlertRow, Row, SiteAlertsRow};
use crate::state::Config;

pub const API: &str = "https://api.weather.gov/alerts/active";
/// The python app's query (`params.area` FL,AM,GM), the recorded fixture's URL.
#[cfg(test)]
pub const URL: &str = "https://api.weather.gov/alerts/active?area=FL,AM,GM";

/// Forecast offices of the python app (VTEC office ids); the NWWS-OI push source, which only
/// the python app lists, filters products by them.
pub const REGION_OFFICES: [&str; 2] = ["KMFL", "KKEY"];

/// What an app's `nws` feed covers, from its config: the region boxes (polygon alerts) plus the
/// feed's `params`: `area` (the API query), `offices` (VTEC/AWIPS office ids), `senders`
/// (`senderName` values) and `sameCodes` (county FIPS codes) for zone-based alerts.
#[derive(Debug, Clone, PartialEq)]
pub struct Scope {
    pub regions: Vec<BBox>,
    pub area: String,
    pub offices: Vec<String>,
    pub senders: Vec<String>,
    pub same_codes: Vec<String>,
}

/// A configured site alerts are matched to (carp): point for polygon alerts, UGC codes
/// (`nwsZones`: forecast zone, county) for zone-based ones.
#[derive(Debug, Clone, PartialEq)]
pub struct SiteRef {
    pub lid: String,
    pub lat: f64,
    pub lon: f64,
    pub zones: Vec<String>,
}

/// The feed entry that configures the alerts poller: `nws-alerts` (carp, with site matching)
/// or `nws` (python).
pub fn feed_id(app: &App) -> &'static str {
    if app.cfg.has_feed("nws-alerts") {
        "nws-alerts"
    } else {
        "nws"
    }
}

/// The sites an app's alerts are matched to: its locations with an NWPS id (carp only).
pub fn sites(app: &App) -> Vec<SiteRef> {
    if feed_id(app) != "nws-alerts" {
        return Vec::new();
    }
    app.cfg
        .locations
        .iter()
        .filter_map(|l| l.nwps.clone().map(|lid| SiteRef { lid, lat: l.lat, lon: l.lon, zones: l.nws_zones.clone() }))
        .collect()
}

impl Scope {
    pub fn for_app(app: &App) -> Scope {
        let params = app.cfg.feed(feed_id(app)).map(|f| &f.params);
        let list = |key: &str| -> Vec<String> {
            params
                .and_then(|p| p.get(key))
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect())
                .unwrap_or_default()
        };
        Scope {
            regions: physical::region_boxes(app),
            area: params.and_then(|p| p.get("area")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
            offices: list("offices"),
            senders: list("senders"),
            same_codes: list("sameCodes"),
        }
    }

    pub fn url(&self) -> String {
        if self.area.is_empty() {
            API.to_string()
        } else {
            format!("{API}?area={}", self.area)
        }
    }
}

/// Conditional-request validators, persisted as the source cursor.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
struct Validators {
    #[serde(skip_serializing_if = "Option::is_none")]
    etag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_modified: Option<String>,
}

pub struct Nws {
    id: &'static str,
    user_agent: String,
    scope: Scope,
    sites: Vec<SiteRef>,
    validators: Mutex<Option<Validators>>,
}

impl Nws {
    pub fn new(config: &Config, app: std::sync::Arc<App>) -> Self {
        Nws { id: feed_id(&app), user_agent: config.user_agent.clone(), scope: Scope::for_app(&app), sites: sites(&app), validators: Mutex::new(None) }
    }
}

#[async_trait]
impl Source for Nws {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: self.id,
            name: "NWS alerts API",
            homepage: "https://www.weather.gov/documentation/services-web-api",
            mode: Mode::Poll,
            cadence: Duration::from_secs(60),
            max_latency: Duration::from_secs(15 * 60),
        }
    }

    async fn fetch(&self, ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
        let known = self.validators.lock().expect("validators").clone().or_else(|| {
            ctx.cursor.as_deref().and_then(|c| serde_json::from_str::<Validators>(c).ok())
        });
        let url = self.scope.url();
        let mut req = ctx
            .state
            .http
            .get(&url)
            .header(USER_AGENT, &self.user_agent)
            .header(ACCEPT, "application/geo+json");
        if let Some(v) = &known {
            if let Some(etag) = &v.etag {
                req = req.header(IF_NONE_MATCH, etag);
            }
            if let Some(lm) = &v.last_modified {
                req = req.header(IF_MODIFIED_SINCE, lm);
            }
        }
        let res = req.send().await.context("nws alerts request")?;
        if res.status() == StatusCode::NOT_MODIFIED {
            return Ok(Vec::new());
        }
        let res = governor::check_response(res)?;
        let header = |name| res.headers().get(name).and_then(|v: &reqwest::header::HeaderValue| v.to_str().ok()).map(String::from);
        let validators = Validators { etag: header(ETAG), last_modified: header(LAST_MODIFIED) };
        let status = res.status().as_u16();
        let content_type = physical::content_type(&res, "application/geo+json");
        let bytes = res.bytes().await.context("nws alerts body")?.to_vec();
        let cursor = (validators != Validators::default()).then(|| serde_json::to_string(&validators)).transpose()?;
        *self.validators.lock().expect("validators") = Some(validators);
        Ok(vec![physical::payload(&url, &content_type, bytes, status, cursor)])
    }

    fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
        let mut rows = normalize_alerts(&raw.bytes, &self.scope)?;
        rows.extend(site_alert_rows(&raw.bytes, &self.sites, raw.fetched_at)?);
        Ok(rows)
    }
}

/// CAP GeoJSON FeatureCollection to alert rows for the scope.
pub fn normalize_alerts(bytes: &[u8], scope: &Scope) -> anyhow::Result<Vec<Row>> {
    let doc: Value = serde_json::from_slice(bytes).context("alerts json")?;
    let features = doc.get("features").and_then(Value::as_array).context("alerts: no features array")?;
    let mut rows = Vec::new();
    for f in features {
        let p = &f["properties"];
        if p["status"].as_str() != Some("Actual") || !in_region(f, scope) {
            continue;
        }
        if let Some(row) = alert_row(f) {
            rows.push(Row::Alert(row));
        }
    }
    Ok(rows)
}

/// One `Row::SiteAlerts` per site (carp): the actual alerts whose polygon contains the site or
/// whose UGC codes name its zone or county, as seen at `seen_at`. A site with none still gets a
/// row with an empty list: "no active alerts" is a recorded check, and it ends alert versions
/// that were in effect at the previous poll. The version key is the CAP message id, which NWS
/// changes on every update, so an updated alert is a new version and the old one ends.
pub fn site_alert_rows(bytes: &[u8], sites: &[SiteRef], seen_at: i64) -> anyhow::Result<Vec<Row>> {
    if sites.is_empty() {
        return Ok(Vec::new());
    }
    let doc: Value = serde_json::from_slice(bytes).context("alerts json")?;
    let features = doc.get("features").and_then(Value::as_array).context("alerts: no features array")?;
    let mut rows = Vec::with_capacity(sites.len());
    for site in sites {
        let mut alerts = Vec::new();
        for f in features {
            let p = &f["properties"];
            if p["status"].as_str() != Some("Actual") || !alert_covers_site(f, site) {
                continue;
            }
            let Some(a) = alert_row(f) else { continue };
            let cap_id = p["id"].as_str().unwrap_or_default();
            alerts.push(AlertSeen {
                ext_id: a.ext_id,
                event: a.event,
                severity: a.severity,
                headline: a.headline,
                onset: a.onset,
                expires: a.expires,
                source: crate::forecast::Source::NwsGridpoint,
                payload_hash: hex::encode(sha2::Sha256::digest(cap_id.as_bytes())),
            });
        }
        rows.push(Row::SiteAlerts(SiteAlertsRow { site: site.lid.clone(), seen_at, alerts }));
    }
    Ok(rows)
}

/// Does an alert cover a site: its polygon contains the point, or (no polygon) its UGC codes
/// include the site's forecast zone or county.
pub fn alert_covers_site(f: &Value, site: &SiteRef) -> bool {
    let g = &f["geometry"];
    if !g.is_null() {
        return geometry_contains(g, site.lat, site.lon);
    }
    strings(&f["properties"]["geocode"]["UGC"]).iter().any(|u| site.zones.iter().any(|z| z == u))
}

/// Is `(lat, lon)` inside a GeoJSON Polygon or MultiPolygon (outer rings)?
pub fn geometry_contains(g: &Value, lat: f64, lon: f64) -> bool {
    match g["type"].as_str() {
        Some("Polygon") => g["coordinates"].get(0).map(ring).is_some_and(|r| r.len() >= 3 && point_in_ring((lon, lat), &r)),
        Some("MultiPolygon") => g["coordinates"].as_array().is_some_and(|polys| {
            polys.iter().any(|p| p.get(0).map(ring).is_some_and(|r| r.len() >= 3 && point_in_ring((lon, lat), &r)))
        }),
        Some("GeometryCollection") => g["geometries"].as_array().is_some_and(|gs| gs.iter().any(|g| geometry_contains(g, lat, lon))),
        _ => false,
    }
}

fn strings(v: &Value) -> Vec<&str> {
    v.as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default()
}

/// The VTEC to key an alert on: the one naming the alert's own event, else the first that is
/// still in effect (an upgrade or a same-segment expiry rides along), else the first.
fn primary_vtec(p: &Value) -> Option<Vtec> {
    let all: Vec<Vtec> = strings(&p["parameters"]["VTEC"]).into_iter().filter_map(Vtec::parse).collect();
    let event = p["event"].as_str().unwrap_or_default();
    all.iter()
        .find(|v| v.event_name() == event && !v.ends_event())
        .or_else(|| all.iter().find(|v| !v.ends_event()))
        .or(all.first())
        .cloned()
}

fn in_region(f: &Value, scope: &Scope) -> bool {
    let p = &f["properties"];
    if scope.regions.iter().any(|r| geometry_intersects(&f["geometry"], r)) {
        return true;
    }
    if strings(&p["geocode"]["SAME"]).iter().any(|s| scope.same_codes.iter().any(|c| c == s)) {
        return true;
    }
    let office_from_vtec =
        strings(&p["parameters"]["VTEC"]).into_iter().filter_map(Vtec::parse).any(|v| scope.offices.contains(&v.office));
    let office_from_awips = strings(&p["parameters"]["AWIPSidentifier"])
        .iter()
        .any(|a| a.len() == 6 && scope.offices.iter().any(|o| o.len() == 4 && o[1..] == a[3..]));
    let office_from_sender = p["senderName"].as_str().is_some_and(|s| scope.senders.iter().any(|x| x == s));
    office_from_vtec || office_from_awips || office_from_sender
}

fn alert_row(f: &Value) -> Option<AlertRow> {
    let p = &f["properties"];
    let id = p["id"].as_str()?;
    let sent = p["sent"].as_str().and_then(parse_rfc3339_ms);
    let vtec = primary_vtec(p);
    let ext_id = match (&vtec, sent) {
        (Some(v), Some(sent)) => {
            let zones: Vec<String> = strings(&p["geocode"]["UGC"]).into_iter().map(String::from).collect();
            vtec_ext_id(v, utc_year(sent), &zones)
        }
        _ => id.to_string(),
    };
    let headline = strings(&p["parameters"]["NWSheadline"])
        .first()
        .map(|h| squash(h))
        .or_else(|| p["headline"].as_str().map(squash))
        .filter(|h| !h.is_empty());
    let onset = p["onset"].as_str().or(p["effective"].as_str()).and_then(parse_rfc3339_ms).or(sent);
    let mut expires = p["ends"].as_str().or(p["expires"].as_str()).and_then(parse_rfc3339_ms);
    let cancelled = p["messageType"].as_str() == Some("Cancel") || vtec.as_ref().is_some_and(|v| v.ends_event());
    if cancelled {
        expires = match (expires, sent) {
            (Some(e), Some(s)) => Some(e.min(s)),
            (e, s) => s.or(e),
        };
    }
    let geometry = &f["geometry"];
    Some(AlertRow {
        ext_id,
        event: p["event"].as_str().unwrap_or("Unknown").to_string(),
        severity: p["severity"].as_str().unwrap_or("Unknown").to_string(),
        headline,
        area_geojson: (!geometry.is_null()).then(|| geometry.clone()),
        onset,
        expires,
    })
}

/// Collapse whitespace (product headlines wrap across lines).
pub fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn utc_year(ms: i64) -> i32 {
    Utc.timestamp_millis_opt(ms).single().map(|t| t.year()).unwrap_or(1970)
}

// ---------------------------------------------------------------------------------------------
// VTEC and UGC (shared with push::nwws)
// ---------------------------------------------------------------------------------------------

/// One P-VTEC string, e.g. `/O.EXT.KKEY.CF.Y.0003.000000T0000Z-261001T0900Z/`.
#[derive(Debug, Clone, PartialEq)]
pub struct Vtec {
    pub class: char,
    pub action: String,
    pub office: String,
    pub phenomena: String,
    pub significance: String,
    pub etn: u32,
    /// None for `000000T0000Z` (already in effect / until further notice).
    pub begin: Option<i64>,
    pub end: Option<i64>,
}

impl Vtec {
    /// Parse an operational (`O`) P-VTEC; test, experimental and H-VTEC strings give `None`.
    pub fn parse(s: &str) -> Option<Vtec> {
        let s = s.trim().strip_prefix('/')?.strip_suffix('/')?;
        let parts: Vec<&str> = s.split('.').collect();
        if parts.len() != 7 {
            return None;
        }
        let class = parts[0].chars().next()?;
        if class != 'O' || parts[0].len() != 1 {
            return None;
        }
        let (begin, end) = parts[6].split_once('-')?;
        let time = |t: &str| -> Option<Option<i64>> {
            if t == "000000T0000Z" {
                return Some(None);
            }
            physical::parse_utc_ms(t, "%y%m%dT%H%MZ").map(Some)
        };
        let v = Vtec {
            class,
            action: parts[1].to_string(),
            office: parts[2].to_string(),
            phenomena: parts[3].to_string(),
            significance: parts[4].to_string(),
            etn: parts[5].parse().ok()?,
            begin: time(begin)?,
            end: time(end)?,
        };
        let ok = v.action.len() == 3 && v.office.len() == 4 && v.phenomena.len() == 2 && v.significance.len() == 1;
        ok.then_some(v)
    }

    /// Cancellation or expiry: the event is over at issuance.
    pub fn ends_event(&self) -> bool {
        matches!(self.action.as_str(), "CAN" | "EXP" | "UPG")
    }

    /// The event name NWS uses in CAP for this phenomenon/significance.
    pub fn event_name(&self) -> String {
        event_name(&self.phenomena, &self.significance)
            .map(String::from)
            .unwrap_or_else(|| format!("{}.{} event", self.phenomena, self.significance))
    }

    /// CAP-style severity from the significance (NWWS text carries none).
    pub fn severity(&self) -> &'static str {
        match (self.phenomena.as_str(), self.significance.as_str()) {
            ("TO" | "HU" | "SS" | "EW", "W") => "Extreme",
            (_, "W") | (_, "A") => "Severe",
            (_, "Y") | (_, "S") => "Minor",
            _ => "Unknown",
        }
    }
}

/// Stable id of one VTEC event segment: office, phenomenon, significance, ETN, year of issuance
/// (ETNs restart yearly) and the sorted zone list. The NWS API and NWWS-OI both produce it.
pub fn vtec_ext_id(v: &Vtec, year: i32, zones: &[String]) -> String {
    let mut zones: Vec<&str> = zones.iter().map(String::as_str).collect();
    zones.sort_unstable();
    zones.dedup();
    format!("vtec:{}.{}.{}.{:04}.{year}:{}", v.office, v.phenomena, v.significance, v.etn, zones.join(","))
}

fn event_name(phen: &str, sig: &str) -> Option<&'static str> {
    Some(match (phen, sig) {
        ("CF", "W") => "Coastal Flood Warning",
        ("CF", "A") => "Coastal Flood Watch",
        ("CF", "Y") => "Coastal Flood Advisory",
        ("CF", "S") => "Coastal Flood Statement",
        ("LS", "Y") => "Lakeshore Flood Advisory",
        ("SU", "W") => "High Surf Warning",
        ("SU", "Y") => "High Surf Advisory",
        ("RP", "S") => "Rip Current Statement",
        ("BH", "S") => "Beach Hazards Statement",
        ("SC", "Y") => "Small Craft Advisory",
        ("SW", "Y") => "Small Craft Advisory",
        ("RB", "Y") => "Small Craft Advisory",
        ("SI", "Y") => "Small Craft Advisory",
        ("GL", "W") => "Gale Warning",
        ("GL", "A") => "Gale Watch",
        ("SR", "W") => "Storm Warning",
        ("SR", "A") => "Storm Watch",
        ("HF", "W") => "Hurricane Force Wind Warning",
        ("HF", "A") => "Hurricane Force Wind Watch",
        ("SE", "W") => "Hazardous Seas Warning",
        ("SE", "A") => "Hazardous Seas Watch",
        ("MA", "W") => "Special Marine Warning",
        ("MF", "Y") => "Dense Fog Advisory",
        ("MH", "Y") => "Ashfall Advisory",
        ("FZ", "W") => "Freeze Warning",
        ("FZ", "A") => "Freeze Watch",
        ("HZ", "W") => "Hard Freeze Warning",
        ("HZ", "A") => "Hard Freeze Watch",
        ("FR", "Y") => "Frost Advisory",
        ("CW", "Y") => "Cold Weather Advisory",
        ("EC", "W") => "Extreme Cold Warning",
        ("EC", "A") => "Extreme Cold Watch",
        ("WC", "Y") => "Wind Chill Advisory",
        ("WC", "W") => "Wind Chill Warning",
        ("WC", "A") => "Wind Chill Watch",
        ("HT", "Y") => "Heat Advisory",
        ("EH", "W") | ("XH", "W") => "Extreme Heat Warning",
        ("EH", "A") | ("XH", "A") => "Extreme Heat Watch",
        ("FL", "W") | ("FA", "W") => "Flood Warning",
        ("FL", "A") | ("FA", "A") => "Flood Watch",
        ("FL", "Y") | ("FA", "Y") => "Flood Advisory",
        ("FL", "S") => "Flood Statement",
        ("FF", "W") => "Flash Flood Warning",
        ("FF", "A") => "Flash Flood Watch",
        ("FF", "S") => "Flash Flood Statement",
        ("FW", "W") => "Red Flag Warning",
        ("FW", "A") => "Fire Weather Watch",
        ("WI", "Y") => "Wind Advisory",
        ("HW", "W") => "High Wind Warning",
        ("HW", "A") => "High Wind Watch",
        ("FG", "Y") => "Dense Fog Advisory",
        ("SM", "Y") => "Dense Smoke Advisory",
        ("HU", "W") => "Hurricane Warning",
        ("HU", "A") => "Hurricane Watch",
        ("TR", "W") => "Tropical Storm Warning",
        ("TR", "A") => "Tropical Storm Watch",
        ("SS", "W") => "Storm Surge Warning",
        ("SS", "A") => "Storm Surge Watch",
        ("EW", "W") => "Extreme Wind Warning",
        ("TO", "W") => "Tornado Warning",
        ("TO", "A") => "Tornado Watch",
        ("SV", "W") => "Severe Thunderstorm Warning",
        ("SV", "A") => "Severe Thunderstorm Watch",
        _ => return None,
    })
}

/// A parsed UGC group: zone codes plus the product expiry time (DDHHMM, resolved against the
/// issuance time).
#[derive(Debug, Clone, PartialEq)]
pub struct Ugc {
    pub zones: Vec<String>,
    pub expires: Option<i64>,
}

/// Parse a UGC string such as `FLZ076>078-010900-` or `AMZ630-650-GMZ656-010430-` (already
/// joined across line breaks). `issued_ms` anchors the DDHHMM expiry.
pub fn parse_ugc(s: &str, issued_ms: i64) -> Option<Ugc> {
    let tokens: Vec<&str> = s.split('-').map(str::trim).filter(|t| !t.is_empty()).collect();
    let (last, codes) = tokens.split_last()?;
    if last.len() != 6 || !last.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let mut zones = Vec::new();
    let mut prefix = String::new();
    for tok in codes {
        let (head, range_end) = match tok.split_once('>') {
            Some((a, b)) => (a, Some(b)),
            None => (*tok, None),
        };
        let number = if head.len() == 6 && head[..3].bytes().all(|b| b.is_ascii_uppercase()) {
            prefix = head[..3].to_string();
            &head[3..]
        } else if head.len() == 3 && !prefix.is_empty() {
            head
        } else {
            return None;
        };
        let from: u32 = number.parse().ok()?;
        let to: u32 = match range_end {
            Some(end) => end.parse().ok()?,
            None => from,
        };
        if to < from || to - from > 999 {
            return None;
        }
        for n in from..=to {
            zones.push(format!("{prefix}{n:03}"));
        }
    }
    if zones.is_empty() {
        return None;
    }
    Some(Ugc { zones, expires: resolve_ddhhmm(last, issued_ms) })
}

/// DDHHMM (UTC) at or after the issuance month; rolls into the next month when the day is
/// earlier than the issuance day.
pub fn resolve_ddhhmm(s: &str, issued_ms: i64) -> Option<i64> {
    let day: u32 = s.get(0..2)?.parse().ok()?;
    let hour: u32 = s.get(2..4)?.parse().ok()?;
    let minute: u32 = s.get(4..6)?.parse().ok()?;
    let issued = Utc.timestamp_millis_opt(issued_ms).single()?;
    let (mut year, mut month) = (issued.year(), issued.month());
    if day < issued.day() {
        month += 1;
        if month == 13 {
            month = 1;
            year += 1;
        }
    }
    Utc.with_ymd_and_hms(year, month, day, hour, minute, 0).single().map(|t| t.timestamp_millis())
}

/// Does a GeoJSON geometry (Polygon, MultiPolygon, Point, GeometryCollection) touch `bbox`?
pub fn geometry_intersects(g: &Value, bbox: &physical::BBox) -> bool {
    match g["type"].as_str() {
        Some("Point") => point(&g["coordinates"]).is_some_and(|(x, y)| bbox.contains(y, x)),
        Some("Polygon") => polygon_intersects(&g["coordinates"], bbox),
        Some("MultiPolygon") => {
            g["coordinates"].as_array().is_some_and(|polys| polys.iter().any(|p| polygon_intersects(p, bbox)))
        }
        Some("GeometryCollection") => {
            g["geometries"].as_array().is_some_and(|gs| gs.iter().any(|g| geometry_intersects(g, bbox)))
        }
        _ => false,
    }
}

fn point(v: &Value) -> Option<(f64, f64)> {
    Some((v.get(0)?.as_f64()?, v.get(1)?.as_f64()?))
}

fn ring(v: &Value) -> Vec<(f64, f64)> {
    v.as_array().map(|pts| pts.iter().filter_map(point).collect()).unwrap_or_default()
}

/// Polygon (outer ring) vs rectangle: a vertex inside the box, a box corner inside the ring, or
/// crossing edges.
fn polygon_intersects(coords: &Value, b: &physical::BBox) -> bool {
    let Some(outer) = coords.get(0).map(ring) else { return false };
    if outer.len() < 3 {
        return false;
    }
    if outer.iter().any(|&(x, y)| b.contains(y, x)) {
        return true;
    }
    let corners = [(b.west, b.south), (b.east, b.south), (b.east, b.north), (b.west, b.north)];
    if corners.iter().any(|&c| point_in_ring(c, &outer)) {
        return true;
    }
    let box_edges = [(corners[0], corners[1]), (corners[1], corners[2]), (corners[2], corners[3]), (corners[3], corners[0])];
    outer.windows(2).any(|e| box_edges.iter().any(|&(p, q)| segments_cross(e[0], e[1], p, q)))
}

fn point_in_ring((x, y): (f64, f64), ring: &[(f64, f64)]) -> bool {
    let mut inside = false;
    let mut j = ring.len() - 1;
    for i in 0..ring.len() {
        let (xi, yi) = ring[i];
        let (xj, yj) = ring[j];
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn segments_cross(a: (f64, f64), b: (f64, f64), c: (f64, f64), d: (f64, f64)) -> bool {
    let orient = |p: (f64, f64), q: (f64, f64), r: (f64, f64)| (q.0 - p.0) * (r.1 - p.1) - (q.1 - p.1) * (r.0 - p.0);
    let (d1, d2, d3, d4) = (orient(c, d, a), orient(c, d, b), orient(a, b, c), orient(a, b, d));
    ((d1 > 0.0) != (d2 > 0.0)) && ((d3 > 0.0) != (d4 > 0.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::poll::physical::testing::{assert_idempotent, fixture, python_app, python_region, recorded, FakeFetch};
    use crate::model::Row;

    const FIXTURE: &str = "nws/alerts_active_fl_am_gm.json";
    /// 2026-09-30T20:30:15Z, when the fixture was recorded.
    const RECORDED_AT: i64 = 1_790_800_215_000;

    fn python_scope() -> Scope {
        Scope::for_app(&python_app())
    }

    fn alerts() -> Vec<AlertRow> {
        normalize_alerts(&fixture(FIXTURE), &python_scope())
            .unwrap()
            .into_iter()
            .map(|r| match r {
                Row::Alert(a) => a,
                other => panic!("unexpected row {other:?}"),
            })
            .collect()
    }

    fn ms(s: &str) -> i64 {
        parse_rfc3339_ms(s).unwrap()
    }

    #[test]
    fn nws_fixture_keeps_region_alerts_only() {
        let rows = alerts();
        let mut events: Vec<&str> = rows.iter().map(|a| a.event.as_str()).collect();
        events.sort_unstable();
        // Kept: Key West SCA + coastal flood (office), Miami x2 (office), Melbourne flood advisory
        // over Martin County and Melbourne marine statement (both polygons reach into the bbox).
        // Dropped: Houston SCA, Mobile rip current, Melbourne flood warning (Lake/Volusia).
        assert_eq!(
            events,
            [
                "Coastal Flood Advisory",
                "Coastal Flood Statement",
                "Coastal Flood Statement",
                "Flood Advisory",
                "Marine Weather Statement",
                "Small Craft Advisory"
            ]
        );
        let ids: std::collections::HashSet<&str> = rows.iter().map(|a| a.ext_id.as_str()).collect();
        assert_eq!(ids.len(), 6, "distinct ext ids");
    }

    #[test]
    fn nws_fixture_vtec_rows_have_stable_keys_and_times() {
        let rows = alerts();
        let cf = rows.iter().find(|a| a.event == "Coastal Flood Advisory").unwrap();
        assert_eq!(cf.ext_id, "vtec:KKEY.CF.Y.0003.2026:FLZ076,FLZ077,FLZ078");
        assert_eq!(cf.severity, "Minor");
        assert_eq!(cf.headline.as_deref(), Some("COASTAL FLOOD ADVISORY NOW IN EFFECT UNTIL 5 AM EDT THURSDAY"));
        assert_eq!(cf.onset, Some(ms("2026-09-30T11:36:00-04:00")));
        assert_eq!(cf.expires, Some(ms("2026-10-01T05:00:00-04:00")));
        assert_eq!(cf.area_geojson, None);

        let sca = rows.iter().find(|a| a.event == "Small Craft Advisory").unwrap();
        assert_eq!(sca.ext_id, "vtec:KKEY.SC.Y.0019.2026:GMZ052,GMZ053,GMZ054,GMZ055,GMZ072,GMZ073,GMZ074,GMZ075");
        // `ends` (event end) wins over `expires` (message expiry).
        assert_eq!(sca.expires, Some(ms("2026-10-01T11:00:00-04:00")));

        // Two segments of one Miami statement: same ETN, different zone sets, two rows.
        let mut cfs: Vec<&str> =
            rows.iter().filter(|a| a.event == "Coastal Flood Statement").map(|a| a.ext_id.as_str()).collect();
        cfs.sort_unstable();
        assert_eq!(cfs, ["vtec:KMFL.CF.S.0004.2026:FLZ069,FLZ075,FLZ174", "vtec:KMFL.CF.S.0004.2026:FLZ168,FLZ172,FLZ173"]);

        // No VTEC: keyed by the CAP id, polygon kept.
        let mws = rows.iter().find(|a| a.event == "Marine Weather Statement").unwrap();
        assert!(mws.ext_id.starts_with("urn:oid:2.49.0.1.840.0.f0378ab3"), "{}", mws.ext_id);
        assert_eq!(mws.area_geojson.as_ref().unwrap()["type"], "Polygon");
        assert_eq!(mws.expires, Some(ms("2026-09-30T17:15:00-04:00")));
    }

    #[test]
    fn nws_cancel_ends_event_at_issuance() {
        let doc = serde_json::json!({"features": [{
            "geometry": null,
            "properties": {
                "id": "urn:x", "status": "Actual", "messageType": "Update", "event": "Freeze Warning",
                "severity": "Severe", "senderName": "NWS Miami FL", "sent": "2026-01-10T12:00:00Z",
                "onset": "2026-01-10T12:00:00Z", "ends": "2026-01-11T14:00:00Z",
                "parameters": {"VTEC": ["/O.CAN.KMFL.FZ.W.0001.000000T0000Z-260111T1400Z/"]},
                "geocode": {"UGC": ["FLZ063"], "SAME": ["012051"]}
            }
        }, {
            "geometry": null,
            "properties": {"id": "urn:test", "status": "Test", "event": "Test Message", "senderName": "NWS Miami FL"}
        }]});
        let rows = normalize_alerts(doc.to_string().as_bytes(), &python_scope()).unwrap();
        assert_eq!(rows.len(), 1, "status Test dropped");
        let Row::Alert(a) = &rows[0] else { panic!() };
        assert_eq!(a.ext_id, "vtec:KMFL.FZ.W.0001.2026:FLZ063");
        assert_eq!(a.expires, Some(ms("2026-01-10T12:00:00Z")));
    }

    #[test]
    fn nws_vtec_and_ugc_parsing() {
        let v = Vtec::parse("/O.NEW.KKEY.SC.Y.0019.260930T2016Z-261001T1500Z/").unwrap();
        assert_eq!((v.office.as_str(), v.phenomena.as_str(), v.significance.as_str(), v.etn), ("KKEY", "SC", "Y", 19));
        assert_eq!(v.begin, Some(ms("2026-09-30T20:16:00Z")));
        assert_eq!(v.end, Some(ms("2026-10-01T15:00:00Z")));
        assert_eq!(v.event_name(), "Small Craft Advisory");
        assert!(Vtec::parse("/T.NEW.KKEY.SC.Y.0019.260930T2016Z-261001T1500Z/").is_none(), "test VTEC ignored");
        assert!(Vtec::parse("/00000.0.ER.000000T0000Z.000000T0000Z.000000T0000Z.OO/").is_none(), "H-VTEC ignored");

        let issued = ms("2026-09-30T20:16:00Z");
        let u = parse_ugc("GMZ052>055-072>075-010430-", issued).unwrap();
        assert_eq!(u.zones, ["GMZ052", "GMZ053", "GMZ054", "GMZ055", "GMZ072", "GMZ073", "GMZ074", "GMZ075"]);
        assert_eq!(u.expires, Some(ms("2026-10-01T04:30:00Z")), "day 01 rolls into October");
        let u = parse_ugc("AMZ630-650-GMZ656-302300-", issued).unwrap();
        assert_eq!(u.zones, ["AMZ630", "AMZ650", "GMZ656"]);
        assert_eq!(u.expires, Some(ms("2026-09-30T23:00:00Z")));
        assert!(parse_ugc("Monroe Upper Keys-Monroe Middle Keys-", issued).is_none());
        let dec = ms("2026-12-31T20:00:00Z");
        assert_eq!(resolve_ddhhmm("010600", dec), Some(ms("2027-01-01T06:00:00Z")));
    }

    #[test]
    fn nws_geometry_intersection() {
        let poly = |pts: &[(f64, f64)]| {
            serde_json::json!({"type": "Polygon", "coordinates": [pts.iter().map(|(x, y)| [*x, *y]).collect::<Vec<_>>()]})
        };
        let region = python_region();
        // Entirely inside.
        assert!(geometry_intersects(&poly(&[(-80.5, 25.0), (-80.4, 25.0), (-80.4, 25.1), (-80.5, 25.0)]), &region));
        // Encloses the whole bbox (no vertex inside).
        assert!(geometry_intersects(&poly(&[(-90.0, 20.0), (-70.0, 20.0), (-70.0, 30.0), (-90.0, 30.0), (-90.0, 20.0)]), &region));
        // A thin band crossing the bbox with every vertex outside.
        assert!(geometry_intersects(&poly(&[(-85.0, 25.0), (-78.0, 25.0), (-78.0, 25.1), (-85.0, 25.1), (-85.0, 25.0)]), &region));
        // North of the box.
        assert!(!geometry_intersects(&poly(&[(-81.5, 29.08), (-81.69, 29.32), (-81.57, 29.35), (-81.5, 29.08)]), &region));
        assert!(!geometry_intersects(&Value::Null, &region));
    }

    /// The scope comes from the feed's params: the python app queries FL,AM,GM and keys its
    /// zone-based alerts on the Miami and Key West offices; the carp skeleton queries LA and keeps
    /// none of the Florida fixture's alerts.
    #[test]
    fn nws_scope_from_config() {
        let scope = python_scope();
        assert_eq!(scope.url(), URL);
        assert_eq!(scope.offices, ["KMFL", "KKEY"]);
        assert_eq!(scope.senders, ["NWS Miami FL", "NWS Key West FL"]);
        assert_eq!(scope.same_codes.len(), 17);
        assert!(scope.same_codes.contains(&"012086".to_string()), "Miami-Dade");
        assert_eq!(scope.regions, vec![python_region()]);
        let carp = Scope::for_app(&crate::app::config::App::builtin("carp").unwrap());
        assert_eq!(carp.url(), "https://api.weather.gov/alerts/active?area=LA");
        assert_eq!(carp.offices, ["KLIX", "KSHV", "KLCH", "KJAN"]);
        assert!(normalize_alerts(&fixture(FIXTURE), &carp).unwrap().is_empty(), "no Florida alert reaches the carp app");
        assert_eq!(alerts().len(), 6, "the python scope keeps the recorded six");
    }

    // ---- carp: `nws-alerts`, area=LA, matched to sites -------------------------------------

    const LA_FIXTURE: &str = "nws_la/alerts/active_la.json";
    /// 2026-10-01T07:01:03Z, when the Louisiana fixture was recorded (no active alerts).
    const LA_RECORDED_AT: i64 = 1_790_838_063_000;

    fn carp_nws() -> Nws {
        Nws::new(&Config::for_tests(), std::sync::Arc::new(crate::app::config::App::builtin("carp").unwrap()))
    }

    /// A Louisiana alert document: a polygon flood warning around Krotz Springs and a
    /// zone-based flood watch over the Baton Rouge zone, plus a test message.
    fn la_doc() -> Value {
        serde_json::json!({"features": [{
            "geometry": {"type": "Polygon", "coordinates": [[[-91.9, 30.4], [-91.6, 30.4], [-91.6, 30.7], [-91.9, 30.7], [-91.9, 30.4]]]},
            "properties": {
                "id": "urn:oid:2.49.0.1.840.0.aaaa.001.1", "status": "Actual", "messageType": "Alert", "event": "Flood Warning",
                "severity": "Severe", "senderName": "NWS Lake Charles LA", "sent": "2026-10-01T06:00:00Z",
                "onset": "2026-10-01T06:00:00Z", "ends": "2026-10-03T12:00:00Z",
                "parameters": {"VTEC": ["/O.NEW.KLCH.FL.W.0011.261001T0600Z-261003T1200Z/"], "NWSheadline": ["FLOOD WARNING IN EFFECT"]},
                "geocode": {"UGC": ["LAC097"], "SAME": ["022097"]}
            }
        }, {
            "geometry": null,
            "properties": {
                "id": "urn:oid:2.49.0.1.840.0.bbbb.001.1", "status": "Actual", "messageType": "Alert", "event": "Flood Watch",
                "severity": "Moderate", "senderName": "NWS New Orleans LA", "sent": "2026-10-01T05:00:00Z",
                "onset": "2026-10-01T05:00:00Z", "expires": "2026-10-02T05:00:00Z",
                "parameters": {"VTEC": ["/O.NEW.KLIX.FA.A.0005.261001T0500Z-261002T0500Z/"]},
                "geocode": {"UGC": ["LAZ046", "LAZ047"], "SAME": ["022033", "022121"]}
            }
        }, {
            "geometry": null,
            "properties": {"id": "urn:test", "status": "Test", "event": "Test Message", "senderName": "NWS Lake Charles LA", "geocode": {"UGC": ["LAZ047"]}}
        }]})
    }

    /// The carp poller is `nws-alerts`, queries LA and knows the eight sites with their zones;
    /// the recorded quiet day yields one empty `SiteAlerts` row per site, never nothing.
    #[test]
    fn nws_la_fixture_quiet_day_records_a_check_per_site() {
        let nws = carp_nws();
        assert_eq!(nws.info().id, "nws-alerts");
        assert_eq!(nws.scope.url(), "https://api.weather.gov/alerts/active?area=LA");
        assert_eq!(nws.sites.iter().map(|s| s.lid.as_str()).collect::<Vec<_>>(), ["SMML1", "KRZL1", "BLRL1", "MCGL1", "BTRL1", "AEXL1", "MLUL1", "BXAL1"]);
        assert_eq!(nws.sites[1].zones, ["LAZ033", "LAC097"]);
        let raw = recorded(&nws.scope.url(), "application/geo+json", fixture(LA_FIXTURE), 200, LA_RECORDED_AT);
        let rows = nws.normalize(&raw).unwrap();
        assert_eq!(rows.len(), 8, "{rows:?}");
        for (row, site) in rows.iter().zip(&nws.sites) {
            let Row::SiteAlerts(a) = row else { panic!("{row:?}") };
            assert_eq!((a.site.as_str(), a.seen_at, a.alerts.len()), (site.lid.as_str(), LA_RECORDED_AT, 0));
        }
        // The python poller keeps its id and matches no sites.
        let py = Nws::new(&Config::for_tests(), python_app());
        assert_eq!((py.info().id, py.sites.len()), ("nws", 0));
    }

    /// Polygon alerts match the site inside them; zone alerts match through the site's UGC
    /// codes; test messages never match; the geometry test is a real point-in-polygon.
    #[test]
    fn nws_la_alerts_match_sites_by_polygon_and_zone() {
        let nws = carp_nws();
        let raw = recorded(&nws.scope.url(), "application/geo+json", la_doc().to_string().into_bytes(), 200, LA_RECORDED_AT);
        let rows = nws.normalize(&raw).unwrap();
        let alerts: Vec<&AlertRow> = rows.iter().filter_map(|r| if let Row::Alert(a) = r { Some(a) } else { None }).collect();
        assert_eq!(alerts.len(), 2, "both actual alerts are in the Louisiana region");
        let by_site: std::collections::BTreeMap<&str, Vec<&str>> = rows
            .iter()
            .filter_map(|r| if let Row::SiteAlerts(s) = r { Some((s.site.as_str(), s.alerts.iter().map(|a| a.event.as_str()).collect())) } else { None })
            .collect();
        assert_eq!(by_site["KRZL1"], ["Flood Warning"], "inside the polygon (also its county, but the polygon decides)");
        assert_eq!(by_site["BTRL1"], ["Flood Watch"], "zone LAZ047");
        for quiet in ["SMML1", "BLRL1", "MCGL1", "AEXL1", "MLUL1", "BXAL1"] {
            assert!(by_site[quiet].is_empty(), "{quiet}");
        }
        let krzl1 = rows.iter().find_map(|r| if let Row::SiteAlerts(s) = r { (s.site == "KRZL1").then_some(s) } else { None }).unwrap();
        let a = &krzl1.alerts[0];
        assert_eq!(a.ext_id, "vtec:KLCH.FL.W.0011.2026:LAC097");
        assert_eq!((a.severity.as_str(), a.headline.as_deref()), ("Severe", Some("FLOOD WARNING IN EFFECT")));
        assert_eq!(a.expires, Some(ms("2026-10-03T12:00:00Z")));
        assert_eq!(a.source, crate::forecast::Source::NwsGridpoint);
        assert_eq!(a.payload_hash.len(), 64);

        let site = &nws.sites[1];
        let poly = &la_doc()["features"][0];
        assert!(alert_covers_site(poly, site));
        assert!(!alert_covers_site(poly, &SiteRef { lid: "X".into(), lat: 31.3, lon: -92.4, zones: vec!["LAC097".into()] }), "outside the polygon: the polygon decides even with a matching county");
        assert!(geometry_contains(&serde_json::json!({"type": "MultiPolygon", "coordinates": [[[[-92.0, 30.0], [-91.0, 30.0], [-91.0, 31.0], [-92.0, 31.0], [-92.0, 30.0]]]]}), 30.5, -91.5));
        assert!(!geometry_contains(&Value::Null, 30.5, -91.5));
    }

    /// Through the pipeline: alert versions open at the first poll, are refreshed by a repeat,
    /// and end when a later poll no longer lists them; every poll is a fetch run with a time.
    #[tokio::test]
    async fn nws_la_ingest_opens_refreshes_and_ends_site_alerts() {
        use crate::app::test_support::test_state_for;
        use crate::forecast::query::active_alerts_asof;
        use crate::ingest::scheduler::ingest_payload;
        let state = test_state_for("carp");
        let nws = carp_nws();
        let t1 = LA_RECORDED_AT;
        let raw = |doc: &Value, at: i64| recorded(&nws.scope.url(), "application/geo+json", doc.to_string().into_bytes(), 200, at);
        let first = ingest_payload(&state, &nws, raw(&la_doc(), t1), None).await.unwrap();
        assert_eq!((first.rows_in, first.rows_skipped, first.error.clone()), (10, 0, None), "{first:?}");
        assert_eq!(first.rows_written, 2 + 2, "two alert rows, two sites with a new version");
        let again = ingest_payload(&state, &nws, raw(&la_doc(), t1 + 60_000), None).await.unwrap();
        assert_eq!(again.rows_written, 0, "{again:?}");
        let counts = |t: i64| {
            let state = state.clone();
            async move { state.obs.read(move |c| Ok((active_alerts_asof(c, "KRZL1", t)?, active_alerts_asof(c, "BTRL1", t)?, active_alerts_asof(c, "SMML1", t)?))).await.unwrap() }
        };
        assert_eq!(counts(t1 + 60_000).await, (1, 1, 0));
        assert_eq!(counts(t1 - 1).await, (0, 0, 0), "not yet seen");
        // The quiet recorded day comes next: both versions end at that poll.
        let t2 = t1 + 10 * 60_000;
        let quiet = recorded(&nws.scope.url(), "application/geo+json", fixture(LA_FIXTURE), 200, t2);
        let out = ingest_payload(&state, &nws, quiet, None).await.unwrap();
        assert_eq!((out.rows_in, out.rows_written, out.status), (8, 2, crate::ingest::scheduler::RunStatus::Ok), "{out:?}");
        assert_eq!(counts(t2).await, (0, 0, 0));
        assert_eq!(counts(t2 - 1).await, (1, 1, 0), "still in effect just before the poll that ended them");
        let (runs, last_at): (i64, i64) = state
            .obs
            .read(|c| c.query_row("select count(*), max(fetched_at) from fetch_runs where source_id = 'nws-alerts' and status in ('ok', 'empty')", [], |r| Ok((r.get(0)?, r.get(1)?))))
            .await
            .unwrap();
        assert_eq!((runs, last_at), (3, t2), "the quiet poll is a recorded check with its time");
        let alerts: i64 = state.obs.read(|c| c.query_row("select count(*) from alerts where source_id = 'nws-alerts'", [], |r| r.get(0))).await.unwrap();
        assert_eq!(alerts, 2, "the region's alerts also land in the alerts table for the map layer");
    }

    #[tokio::test]
    async fn nws_idempotent() {
        let raw = recorded(URL, "application/geo+json", fixture(FIXTURE), 200, RECORDED_AT);
        let (state, first) = assert_idempotent(FakeFetch { inner: Nws::new(&Config::for_tests(), python_app()), payloads: vec![raw] }).await;
        assert_eq!(first[0].rows_written, 6);
        let n: i64 = state.obs.read(|c| c.query_row("select count(*) from alerts where source_id = 'nws'", [], |r| r.get(0))).await.unwrap();
        assert_eq!(n, 6);
    }
}
