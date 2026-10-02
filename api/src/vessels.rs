//! Vessels (AIS) for the carp and lionfish apps (gates/leaf-GE4.md, docs/GODS_EYE.md GC4).
//!
//! Rows come from the `aisstream` push source (`ingest::push::ais`) through the normal ingest
//! pipeline: `Row::VesselPosition` and `Row::VesselStatic`, written by the writer thread in one
//! transaction per payload (a batch of frames). Positions are thinned to at most one per vessel
//! per minute (the first fix of a minute wins) and kept [`RETENTION_MS`].
//!
//! Read side: [`tracks`] for GraphQL `vessels`, [`evidence_record`] for `vessel:<mmsi>`.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Feed id of the AISStream.io source (`feeds[].source`).
pub const SOURCE_ID: &str = "aisstream";
pub const MINUTE_MS: i64 = 60_000;
pub const DAY_MS: i64 = 86_400_000;
/// How long positions are kept.
pub const RETENTION_MS: i64 = 30 * DAY_MS;

/// One position report (AIS messages 1-3, 18, 19), as stored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VesselPositionRow {
    pub mmsi: i64,
    /// AISStream receive time (`MetaData.time_utc`), unix ms.
    pub observed_at: i64,
    pub lat: f64,
    pub lon: f64,
    /// Knots; None when "not available".
    pub sog: Option<f64>,
    /// Degrees true; None when "not available".
    pub cog: Option<f64>,
    /// Degrees true; None when "not available".
    pub heading: Option<f64>,
    /// `MetaData.ShipName`, trimmed; used only while the vessel has no static name.
    pub name: Option<String>,
}

/// Static and voyage data (AIS message 5 `ShipStaticData`, 24 `StaticDataReport`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VesselStaticRow {
    pub mmsi: i64,
    pub seen_at: i64,
    pub name: Option<String>,
    /// AIS ship-and-cargo type, 1-99.
    pub type_code: Option<i64>,
    pub call_sign: Option<String>,
    pub imo: Option<i64>,
    pub destination: Option<String>,
    pub length_m: Option<f64>,
}

/// Icon categories the API reports as `VesselTrack.type` and `vessels(types:)` filters on.
pub const CATEGORIES: [&str; 10] = ["cargo", "tanker", "passenger", "fishing", "tug", "pleasure", "highspeed", "service", "other", "unknown"];

/// Category of an AIS ship-and-cargo type code (ITU-R M.1371 table 53).
pub fn category(type_code: Option<i64>) -> &'static str {
    match type_code {
        None | Some(0) => "unknown",
        Some(30) => "fishing",
        Some(31 | 32 | 52 | 53) => "tug",
        Some(36 | 37) => "pleasure",
        Some(40..=49) => "highspeed",
        Some(33 | 34 | 35 | 50 | 51 | 54 | 55 | 58 | 59) => "service",
        Some(60..=69) => "passenger",
        Some(70..=79) => "cargo",
        Some(80..=89) => "tanker",
        Some(_) => "other",
    }
}

/// Plain label of a type code, for the evidence card.
pub fn type_label(type_code: Option<i64>) -> &'static str {
    match type_code {
        None | Some(0) => "Unknown type",
        Some(20..=29) => "Wing in ground craft",
        Some(30) => "Fishing vessel",
        Some(31 | 32) => "Towing vessel",
        Some(33) => "Dredger or underwater operations",
        Some(34) => "Diving operations",
        Some(35) => "Military vessel",
        Some(36) => "Sailing vessel",
        Some(37) => "Pleasure craft",
        Some(40..=49) => "High-speed craft",
        Some(50) => "Pilot vessel",
        Some(51) => "Search and rescue vessel",
        Some(52) => "Tug",
        Some(53) => "Port tender",
        Some(54) => "Anti-pollution vessel",
        Some(55) => "Law enforcement vessel",
        Some(58) => "Medical transport",
        Some(59) => "Non-combatant ship",
        Some(60..=69) => "Passenger ship",
        Some(70..=79) => "Cargo ship",
        Some(80..=89) => "Tanker",
        Some(_) => "Other type",
    }
}

/// Type codes of `categories` (plus -1 for "unknown", which also stands for a missing type).
fn codes_of(categories: &[String]) -> Vec<i64> {
    let mut out: Vec<i64> = (0..=99).filter(|c| categories.iter().any(|k| k == category(Some(*c)))).collect();
    if categories.iter().any(|k| k == "unknown") {
        out.push(-1);
    }
    out
}

/// VesselFinder page of a vessel by MMSI (the evidence card's "Open at" link).
pub fn page_url(mmsi: i64) -> String {
    format!("https://www.vesselfinder.com/vessels/details/{mmsi}")
}

/// A plausible MMSI (nine digits, not zero).
pub fn valid_mmsi(mmsi: i64) -> bool {
    (1..=999_999_999).contains(&mmsi)
}

// ---------------------------------------------------------------------------------------------
// Write side (called by the ingest pipeline's RowWriter inside its transaction)
// ---------------------------------------------------------------------------------------------

fn touch(tx: &Transaction, mmsi: i64, at: i64, name: Option<&str>, raw_object_id: i64) -> rusqlite::Result<()> {
    tx.prepare_cached(
        "insert into vessels (mmsi, name, first_seen, last_seen, last_raw_object_id) values (?1, ?2, ?3, ?3, ?4)
         on conflict(mmsi) do update set
           name = coalesce(vessels.name, excluded.name),
           first_seen = min(vessels.first_seen, excluded.first_seen),
           last_seen = max(vessels.last_seen, excluded.last_seen),
           last_raw_object_id = excluded.last_raw_object_id",
    )?
    .execute(params![mmsi, name, at, raw_object_id])?;
    Ok(())
}

/// Store one position. `Ok(true)`: a new fix; `Ok(false)`: this vessel already has a fix in that
/// minute (thinned). The caller rejects positions outside the app's regions before this.
pub fn write_position(tx: &Transaction, p: &VesselPositionRow, raw_object_id: i64) -> rusqlite::Result<bool> {
    touch(tx, p.mmsi, p.observed_at, p.name.as_deref(), raw_object_id)?;
    let n = tx
        .prepare_cached(
            "insert into vessel_positions (mmsi, minute, observed_at, lat, lon, sog, cog, heading)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             on conflict(mmsi, minute) do nothing",
        )?
        .execute(params![p.mmsi, p.observed_at.div_euclid(MINUTE_MS), p.observed_at, p.lat, p.lon, p.sog, p.cog, p.heading])?;
    Ok(n > 0)
}

/// Store static data. A field the report leaves out keeps its stored value. `Ok(true)` when
/// anything changed.
pub fn write_static(tx: &Transaction, s: &VesselStaticRow, raw_object_id: i64) -> rusqlite::Result<bool> {
    /// name, type, call sign, IMO, destination, length.
    type Fields = (Option<String>, Option<i64>, Option<String>, Option<i64>, Option<String>, Option<f64>);
    let before: Option<Fields> = tx
        .prepare_cached("select name, type, call_sign, imo, destination, length_m from vessels where mmsi = ?1")?
        .query_row([s.mmsi], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
        .optional()?;
    tx.prepare_cached(
        "insert into vessels (mmsi, name, type, call_sign, imo, destination, length_m, first_seen, last_seen, last_raw_object_id)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)
         on conflict(mmsi) do update set
           name = coalesce(excluded.name, vessels.name),
           type = coalesce(excluded.type, vessels.type),
           call_sign = coalesce(excluded.call_sign, vessels.call_sign),
           imo = coalesce(excluded.imo, vessels.imo),
           destination = coalesce(excluded.destination, vessels.destination),
           length_m = coalesce(excluded.length_m, vessels.length_m),
           first_seen = min(vessels.first_seen, excluded.first_seen),
           last_seen = max(vessels.last_seen, excluded.last_seen),
           last_raw_object_id = excluded.last_raw_object_id",
    )?
    .execute(params![s.mmsi, s.name, s.type_code, s.call_sign, s.imo, s.destination, s.length_m, s.seen_at, raw_object_id])?;
    let after = (
        s.name.clone().or_else(|| before.as_ref().and_then(|b| b.0.clone())),
        s.type_code.or_else(|| before.as_ref().and_then(|b| b.1)),
        s.call_sign.clone().or_else(|| before.as_ref().and_then(|b| b.2.clone())),
        s.imo.or_else(|| before.as_ref().and_then(|b| b.3)),
        s.destination.clone().or_else(|| before.as_ref().and_then(|b| b.4.clone())),
        s.length_m.or_else(|| before.as_ref().and_then(|b| b.5)),
    );
    Ok(before.as_ref() != Some(&after))
}

/// Drop positions older than [`RETENTION_MS`] before `now`, and vessels with no position left
/// that were last seen before then. Returns the positions removed.
pub fn prune(tx: &Transaction, now: i64) -> rusqlite::Result<usize> {
    let cutoff = now - RETENTION_MS;
    let n = tx.execute("delete from vessel_positions where observed_at < ?1", [cutoff])?;
    tx.execute(
        "delete from vessels where last_seen < ?1 and not exists (select 1 from vessel_positions p where p.mmsi = vessels.mmsi)",
        [cutoff],
    )?;
    Ok(n)
}

// ---------------------------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Point {
    pub at: i64,
    pub lat: f64,
    pub lon: f64,
    pub sog: Option<f64>,
    pub cog: Option<f64>,
    pub heading: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Track {
    pub mmsi: i64,
    pub name: Option<String>,
    pub type_code: Option<i64>,
    pub points: Vec<Point>,
}

/// What [`tracks`] filters on. `bbox` is west, south, east, north.
#[derive(Debug, Clone)]
pub struct TrackQuery {
    pub bbox: [f64; 4],
    pub from: i64,
    pub to: i64,
    /// Categories ([`CATEGORIES`]); None = all.
    pub categories: Option<Vec<String>>,
    /// Most vessels.
    pub limit: usize,
    /// Most points over all tracks; whole tracks past it are dropped.
    pub max_points: usize,
}

/// Tracks of the vessels with at least one fix inside `bbox` during `from..=to`, the most
/// recently seen first, each with every fix of the window in time order. The bool is true when
/// `limit` or `max_points` cut the list.
pub fn tracks(c: &Connection, q: &TrackQuery) -> rusqlite::Result<(Vec<Track>, bool)> {
    let [west, south, east, north] = q.bbox;
    let codes = q.categories.as_ref().map(|c| serde_json::to_string(&codes_of(c)).expect("codes"));
    let picked: Vec<(i64, Option<String>, Option<i64>)> = c
        .prepare_cached(
            "select p.mmsi, v.name, v.type from vessel_positions p left join vessels v on v.mmsi = p.mmsi
             where p.observed_at between ?1 and ?2 and p.lat between ?3 and ?4 and p.lon between ?5 and ?6
               and (?7 is null or coalesce(v.type, -1) in (select value from json_each(?7)))
             group by p.mmsi order by max(p.observed_at) desc, p.mmsi limit ?8",
        )?
        .query_map(params![q.from, q.to, south, north, west, east, codes, q.limit as i64 + 1], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut truncated = picked.len() > q.limit;
    let mut points_stmt = c.prepare_cached(
        "select observed_at, lat, lon, sog, cog, heading from vessel_positions
         where mmsi = ?1 and observed_at between ?2 and ?3 order by observed_at",
    )?;
    let mut out = Vec::new();
    let mut total = 0usize;
    for (mmsi, name, type_code) in picked.into_iter().take(q.limit) {
        let points: Vec<Point> = points_stmt
            .query_map(params![mmsi, q.from, q.to], |r| {
                Ok(Point { at: r.get(0)?, lat: r.get(1)?, lon: r.get(2)?, sog: r.get(3)?, cog: r.get(4)?, heading: r.get(5)? })
            })?
            .collect::<rusqlite::Result<_>>()?;
        if total + points.len() > q.max_points {
            truncated = true;
            break;
        }
        total += points.len();
        out.push(Track { mmsi, name, type_code, points });
    }
    Ok((out, truncated))
}

/// What `evidence(vessel:<mmsi>)` shows: the record, the raw object of the last write, and the
/// last time the vessel was seen. None when the vessel is unknown.
pub struct VesselEvidence {
    pub record: Value,
    pub raw_object_id: Option<i64>,
}

fn iso(ms: i64) -> Value {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| Value::String(t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)))
        .unwrap_or(Value::Null)
}

pub fn evidence_record(c: &Connection, mmsi: i64, now: i64) -> rusqlite::Result<Option<VesselEvidence>> {
    type VesselRow = (Option<String>, Option<i64>, Option<String>, Option<i64>, Option<String>, Option<f64>, i64, i64, Option<i64>);
    let v: Option<VesselRow> = c
        .prepare_cached(
            "select name, type, call_sign, imo, destination, length_m, first_seen, last_seen, last_raw_object_id
             from vessels where mmsi = ?1",
        )?
        .query_row([mmsi], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?)))
        .optional()?;
    let Some((name, type_code, call_sign, imo, destination, length_m, first_seen, last_seen, raw)) = v else { return Ok(None) };
    let last: Option<Point> = c
        .prepare_cached(
            "select observed_at, lat, lon, sog, cog, heading from vessel_positions where mmsi = ?1 and observed_at <= ?2
             order by observed_at desc limit 1",
        )?
        .query_row(params![mmsi, now], |r| {
            Ok(Point { at: r.get(0)?, lat: r.get(1)?, lon: r.get(2)?, sog: r.get(3)?, cog: r.get(4)?, heading: r.get(5)? })
        })
        .optional()?;
    let day: i64 = c
        .prepare_cached("select count(*) from vessel_positions where mmsi = ?1 and observed_at between ?2 and ?3")?
        .query_row(params![mmsi, now - DAY_MS, now], |r| r.get(0))?;
    let record = json!({
        "mmsi": mmsi.to_string(),
        "name": name,
        "type": category(type_code),
        "typeCode": type_code,
        "typeLabel": type_label(type_code),
        "callSign": call_sign,
        "imo": imo,
        "destination": destination,
        "lengthM": length_m,
        "firstSeen": iso(first_seen),
        "lastSeen": iso(last_seen),
        "lastPosition": last.map(|p| json!({
            "at": iso(p.at), "lat": p.lat, "lon": p.lon,
            "sogKnots": p.sog, "cogDeg": p.cog, "headingDeg": p.heading,
        })),
        "positions24h": day,
        "pageUrl": page_url(mmsi),
        "source": SOURCE_ID,
        "credit": "Vessel positions: AISStream.io",
    });
    Ok(Some(VesselEvidence { record, raw_object_id: raw }))
}

/// The archived NDJSON batch narrowed to this vessel's frames (`evidence.raw` of `vessel:<mmsi>`):
/// `{frames: [...], batchBytes}`. Anything else passes through.
pub fn raw_frames_of(raw: Value, mmsi: &str) -> Value {
    let Some(text) = raw.get("text").and_then(Value::as_str) else { return raw };
    let frames: Vec<Value> = text
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|f| f.pointer("/MetaData/MMSI").map(|m| m.to_string()).as_deref() == Some(mmsi))
        .collect();
    json!({ "frames": frames, "batchBytes": raw.get("bytes"), "truncated": raw.get("truncated") })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    const T0: i64 = 1_790_000_000_000;

    fn pos(mmsi: i64, at: i64, lat: f64, lon: f64) -> VesselPositionRow {
        VesselPositionRow { mmsi, observed_at: at, lat, lon, sog: Some(10.0), cog: Some(90.0), heading: None, name: Some(format!("SHIP {mmsi}")) }
    }

    async fn db_with(rows: Vec<VesselPositionRow>, statics: Vec<VesselStaticRow>) -> Db {
        let db = Db::memory("observations");
        db.write(move |tx| {
            tx.execute("insert into sources (id, name, homepage, mode, cadence_s, max_latency_s) values ('aisstream', 'AIS', 'h', 'push', 30, 3600)", [])?;
            tx.execute("insert into raw_objects (id, r2_key, source_id, source_url, fetched_at, bytes, sha256) values (1, 'k', 'aisstream', 'u', 0, 0, 's')", [])?;
            for p in &rows {
                write_position(tx, p, 1)?;
            }
            for s in &statics {
                write_static(tx, s, 1)?;
            }
            Ok(())
        })
        .await
        .unwrap();
        db
    }

    #[test]
    fn vessels_categories_cover_every_code() {
        for code in 0..=99 {
            assert!(CATEGORIES.contains(&category(Some(code))), "{code}");
        }
        assert_eq!((category(Some(70)), category(Some(84)), category(Some(30)), category(Some(52)), category(None)), ("cargo", "tanker", "fishing", "tug", "unknown"));
        assert_eq!(codes_of(&["unknown".into()]), vec![0, -1]);
    }

    #[tokio::test]
    async fn vessels_thinned_to_one_fix_per_minute() {
        let rows = vec![pos(1, T0, 29.0, -90.0), pos(1, T0 + 10_000, 29.1, -90.1), pos(1, T0 + 61_000, 29.2, -90.2)];
        let db = db_with(rows, vec![]).await;
        let n: i64 = db.read(|c| c.query_row("select count(*) from vessel_positions", [], |r| r.get(0))).await.unwrap();
        assert_eq!(n, 2, "the second fix of the first minute is dropped");
        let lat: f64 = db.read(|c| c.query_row("select lat from vessel_positions order by observed_at limit 1", [], |r| r.get(0))).await.unwrap();
        assert_eq!(lat, 29.0, "the first fix of a minute wins");
    }

    #[tokio::test]
    async fn vessels_static_keeps_fields_and_reports_change() {
        let s = VesselStaticRow { mmsi: 9, seen_at: T0, name: Some("A".into()), type_code: Some(70), call_sign: Some("CS".into()), imo: Some(1234567), destination: None, length_m: Some(180.0) };
        let db = db_with(vec![], vec![]).await;
        let (first, again, partial) = db
            .write(move |tx| {
                let first = write_static(tx, &s, 1)?;
                let again = write_static(tx, &s, 1)?;
                let partial = write_static(tx, &VesselStaticRow { destination: Some("NEW ORLEANS".into()), name: None, type_code: None, call_sign: None, imo: None, length_m: None, ..s.clone() }, 1)?;
                Ok((first, again, partial))
            })
            .await
            .unwrap();
        assert!(first && !again && partial, "new vessel is a change, same data is not, a new destination is");
        let (name, dest, ty): (String, String, i64) =
            db.read(|c| c.query_row("select name, destination, type from vessels where mmsi = 9", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))).await.unwrap();
        assert_eq!((name.as_str(), dest.as_str(), ty), ("A", "NEW ORLEANS", 70), "a missing field keeps its stored value");
    }

    #[tokio::test]
    async fn vessels_tracks_window_bbox_order_and_types() {
        let rows = vec![
            pos(1, T0, 29.0, -90.0),
            pos(1, T0 + 2 * MINUTE_MS, 29.01, -90.01),
            pos(1, T0 + 4 * MINUTE_MS, 29.02, -90.02),
            pos(2, T0 + MINUTE_MS, 29.5, -91.0),
            pos(3, T0 + 3 * MINUTE_MS, 40.0, -70.0), // outside the bbox
            pos(4, T0 - DAY_MS, 29.0, -90.0),          // outside the window
        ];
        let statics = vec![VesselStaticRow { mmsi: 2, seen_at: T0, name: Some("TANKER".into()), type_code: Some(80), call_sign: None, imo: None, destination: None, length_m: None }];
        let db = db_with(rows, statics).await;
        let q = TrackQuery { bbox: [-94.0, 28.9, -88.8, 32.9], from: T0 - 1, to: T0 + 10 * MINUTE_MS, categories: None, limit: 10, max_points: 1000 };
        let (t, truncated) = db.read({ let q = q.clone(); move |c| tracks(c, &q) }).await.unwrap();
        assert!(!truncated);
        assert_eq!(t.iter().map(|t| t.mmsi).collect::<Vec<_>>(), vec![1, 2], "inside bbox and window, most recently seen first");
        assert_eq!(t[0].points.iter().map(|p| p.at).collect::<Vec<_>>(), vec![T0, T0 + 2 * MINUTE_MS, T0 + 4 * MINUTE_MS], "time order");
        assert_eq!((t[1].name.as_deref(), category(t[1].type_code)), (Some("TANKER"), "tanker"));
        let (only_tankers, _) = db.read({ let q = TrackQuery { categories: Some(vec!["tanker".into()]), ..q.clone() }; move |c| tracks(c, &q) }).await.unwrap();
        assert_eq!(only_tankers.iter().map(|t| t.mmsi).collect::<Vec<_>>(), vec![2]);
        let (unknown, _) = db.read({ let q = TrackQuery { categories: Some(vec!["unknown".into()]), ..q.clone() }; move |c| tracks(c, &q) }).await.unwrap();
        assert_eq!(unknown.iter().map(|t| t.mmsi).collect::<Vec<_>>(), vec![1], "no static data reads as unknown");
        let (one, cut) = db.read({ let q = TrackQuery { limit: 1, ..q.clone() }; move |c| tracks(c, &q) }).await.unwrap();
        assert_eq!((one.len(), cut), (1, true));
        let (few, cut) = db.read({ let q = TrackQuery { max_points: 3, ..q }; move |c| tracks(c, &q) }).await.unwrap();
        assert_eq!((few.len(), cut), (1, true), "whole tracks past the point cap are dropped");
    }

    #[tokio::test]
    async fn vessels_kept_thirty_days() {
        let rows = vec![pos(1, T0 - RETENTION_MS - 1, 29.0, -90.0), pos(1, T0 - RETENTION_MS + MINUTE_MS, 29.0, -90.0), pos(2, T0 - RETENTION_MS - MINUTE_MS, 29.0, -90.0)];
        let db = db_with(rows, vec![]).await;
        let removed = db.write(|tx| prune(tx, T0)).await.unwrap();
        assert_eq!(removed, 2);
        let (p, v): (i64, i64) = db
            .read(|c| Ok((c.query_row("select count(*) from vessel_positions", [], |r| r.get(0))?, c.query_row("select count(*) from vessels", [], |r| r.get(0))?)))
            .await
            .unwrap();
        assert_eq!((p, v), (1, 1), "vessel 2 has no position left and goes too");
    }

    #[tokio::test]
    async fn vessels_evidence_record() {
        let db = db_with(vec![pos(5, T0, 29.0, -90.0)], vec![VesselStaticRow { mmsi: 5, seen_at: T0, name: Some("FEDERAL OSHIMA".into()), type_code: Some(70), call_sign: Some("V7A2".into()), imo: Some(9200419), destination: Some("DETROIT".into()), length_m: Some(200.0) }]).await;
        let e = db.read(|c| evidence_record(c, 5, T0 + 1000)).await.unwrap().unwrap();
        assert_eq!(e.record["name"], "FEDERAL OSHIMA");
        assert_eq!(e.record["type"], "cargo");
        assert_eq!(e.record["typeLabel"], "Cargo ship");
        assert_eq!(e.record["lastPosition"]["sogKnots"], 10.0);
        assert_eq!(e.record["pageUrl"], "https://www.vesselfinder.com/vessels/details/5");
        assert_eq!(e.raw_object_id, Some(1));
        assert!(db.read(|c| evidence_record(c, 6, T0)).await.unwrap().is_none());
    }
}
