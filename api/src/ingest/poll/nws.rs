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

use crate::ingest::governor;
use crate::ingest::poll::physical::{self, parse_rfc3339_ms, REGION};
use crate::ingest::source::{FetchCtx, Mode, RawPayload, Source, SourceInfo};
use crate::model::{AlertRow, Row};
use crate::state::Config;

pub const URL: &str = "https://api.weather.gov/alerts/active?area=FL,AM,GM";

/// Forecast offices whose zones are the region (VTEC office ids).
pub const REGION_OFFICES: [&str; 2] = ["KMFL", "KKEY"];

/// SAME (FIPS) codes of the Florida counties that intersect the region bbox.
const REGION_COUNTIES: [&str; 17] = [
    "012011", // Broward
    "012015", // Charlotte
    "012021", // Collier
    "012027", // DeSoto
    "012043", // Glades
    "012049", // Hardee
    "012051", // Hendry
    "012055", // Highlands
    "012071", // Lee
    "012081", // Manatee
    "012085", // Martin
    "012086", // Miami-Dade
    "012087", // Monroe
    "012093", // Okeechobee
    "012099", // Palm Beach
    "012111", // St. Lucie
    "012115", // Sarasota
];

/// Conditional-request validators, persisted as the source cursor.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
struct Validators {
    #[serde(skip_serializing_if = "Option::is_none")]
    etag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_modified: Option<String>,
}

pub struct Nws {
    user_agent: String,
    validators: Mutex<Option<Validators>>,
}

impl Nws {
    pub fn new(config: &Config) -> Self {
        Nws { user_agent: config.user_agent.clone(), validators: Mutex::new(None) }
    }
}

#[async_trait]
impl Source for Nws {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: "nws",
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
        let mut req = ctx
            .state
            .http
            .get(URL)
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
        Ok(vec![physical::payload(URL, &content_type, bytes, status, cursor)])
    }

    fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
        normalize_alerts(&raw.bytes)
    }
}

/// CAP GeoJSON FeatureCollection to alert rows for the region.
pub fn normalize_alerts(bytes: &[u8]) -> anyhow::Result<Vec<Row>> {
    let doc: Value = serde_json::from_slice(bytes).context("alerts json")?;
    let features = doc.get("features").and_then(Value::as_array).context("alerts: no features array")?;
    let mut rows = Vec::new();
    for f in features {
        let p = &f["properties"];
        if p["status"].as_str() != Some("Actual") || !in_region(f) {
            continue;
        }
        if let Some(row) = alert_row(f) {
            rows.push(Row::Alert(row));
        }
    }
    Ok(rows)
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

fn in_region(f: &Value) -> bool {
    let p = &f["properties"];
    if geometry_intersects(&f["geometry"], &REGION) {
        return true;
    }
    if strings(&p["geocode"]["SAME"]).iter().any(|s| REGION_COUNTIES.contains(s)) {
        return true;
    }
    let office_from_vtec = strings(&p["parameters"]["VTEC"]).into_iter().filter_map(Vtec::parse).any(|v| REGION_OFFICES.contains(&v.office.as_str()));
    let office_from_awips =
        strings(&p["parameters"]["AWIPSidentifier"]).iter().any(|a| a.len() == 6 && REGION_OFFICES.iter().any(|o| o[1..] == a[3..]));
    let office_from_sender = matches!(p["senderName"].as_str(), Some("NWS Miami FL" | "NWS Key West FL"));
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
    use crate::ingest::poll::physical::testing::{assert_idempotent, fixture, recorded, FakeFetch};
    use crate::model::Row;

    const FIXTURE: &str = "nws/alerts_active_fl_am_gm.json";
    /// 2026-09-30T20:30:15Z, when the fixture was recorded.
    const RECORDED_AT: i64 = 1_790_800_215_000;

    fn alerts() -> Vec<AlertRow> {
        normalize_alerts(&fixture(FIXTURE))
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
        let rows = normalize_alerts(doc.to_string().as_bytes()).unwrap();
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
        // Entirely inside.
        assert!(geometry_intersects(&poly(&[(-80.5, 25.0), (-80.4, 25.0), (-80.4, 25.1), (-80.5, 25.0)]), &REGION));
        // Encloses the whole bbox (no vertex inside).
        assert!(geometry_intersects(&poly(&[(-90.0, 20.0), (-70.0, 20.0), (-70.0, 30.0), (-90.0, 30.0), (-90.0, 20.0)]), &REGION));
        // A thin band crossing the bbox with every vertex outside.
        assert!(geometry_intersects(&poly(&[(-85.0, 25.0), (-78.0, 25.0), (-78.0, 25.1), (-85.0, 25.1), (-85.0, 25.0)]), &REGION));
        // North of the box.
        assert!(!geometry_intersects(&poly(&[(-81.5, 29.08), (-81.69, 29.32), (-81.57, 29.35), (-81.5, 29.08)]), &REGION));
        assert!(!geometry_intersects(&Value::Null, &REGION));
    }

    #[tokio::test]
    async fn nws_idempotent() {
        let raw = recorded(URL, "application/geo+json", fixture(FIXTURE), 200, RECORDED_AT);
        let (state, first) = assert_idempotent(FakeFetch { inner: Nws::new(&Config::for_tests()), payloads: vec![raw] }).await;
        assert_eq!(first[0].rows_written, 6);
        let n: i64 = state.obs.read(|c| c.query_row("select count(*) from alerts where source_id = 'nws'", [], |r| r.get(0))).await.unwrap();
        assert_eq!(n, 6);
    }
}
