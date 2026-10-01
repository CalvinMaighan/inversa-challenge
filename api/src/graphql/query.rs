//! Query resolvers (PLAN.md C2) over `observations.db` / `team.db`. `frames`, `hotspots`,
//! `explainCell` and `backtest` delegate to T11 (`frames`, `hotspot`); `board` and `opsSince`
//! to T12 (`crdt`); `evidence` to `crate::evidence`.
//!
//! Validation shared by the list queries: the bbox must lie inside the region (C15), `from` must
//! not be after `to`, and a window spans at most [`MAX_WINDOW_MS`]. Result lists are capped; a
//! capped list comes with a `TRUNCATED` error next to the data, so partial results never pass
//! for complete ones.

use async_graphql::{Context, ErrorExtensions, Object, Result, ID};
use base64::Engine;
use rusqlite::params;

use super::types::{
    Alert, BBox, Backtest, BacktestDay, Board, Evidence, FeedState, FrameChunk, HotspotCell, HotspotExplain,
    HotspotGrid, HotspotTerm, Message, Mission, Op, Param, Quality, Reading, ReadingFlag, ReadingOrigin, Sighting,
    Station, Taxon, Time,
};
use super::{app_state, now_ms};
use crate::db::Db;
use crate::hotspot::{self, Species};
use crate::{crdt, feed_state, frames};

pub struct QueryRoot;

pub const DAY_MS: i64 = 86_400_000;
/// Longest `from`..`to` window of `sightings` and `readings`.
pub const MAX_WINDOW_MS: i64 = 31 * DAY_MS;
pub const MAX_SIGHTINGS: usize = 5000;
pub const MAX_READINGS: usize = 10_000;
pub const MAX_ALERTS: usize = 500;
/// GraphQL `frames` carries at most this many frames; bulk goes through REST.
pub const MAX_GQL_FRAMES: i64 = 24;
pub const MAX_HOTSPOT_TOP: i32 = 5000;
pub const MAX_BACKTEST_DAYS: i32 = 366;
/// Upper bound on ops returned by one `opsSince` call or one subscription replay page.
pub const OPS_PAGE: i64 = 5000;

fn check_window(from: Time, to: Time) -> Result<()> {
    if from > to {
        return Err("`from` must not be after `to`".into());
    }
    if to.0 - from.0 > MAX_WINDOW_MS {
        return Err(format!("window of {:.1} days exceeds the 31-day cap", (to.0 - from.0) as f64 / DAY_MS as f64).into());
    }
    Ok(())
}

fn species(id: &ID) -> Result<Species> {
    Species::parse(id).ok_or_else(|| {
        format!("unknown species {:?}; expected python, tegu, iguana, lionfish or taxon id 1-4", id.as_str()).into()
    })
}

/// Report a capped list next to the data it did return.
fn note_truncated(ctx: &Context<'_>, what: &str, cap: usize) {
    let err = async_graphql::Error::new(format!(
        "{what} truncated to the first {cap} (newest first); narrow the bbox, window or filters"
    ))
    .extend_with(|_, e| {
        e.set("code", "TRUNCATED");
        e.set("limit", cap as u64);
    });
    ctx.add_error(ctx.set_error_path(err.into_server_error(ctx.item.pos)));
}

/// JSON array text for `json_each(?)` filters; `None` means "no filter".
fn json_list<T: serde::Serialize>(items: Option<Vec<T>>) -> Option<String> {
    items.map(|v| serde_json::to_string(&v).expect("serializable list"))
}

fn bad_column(idx: usize, what: &str, value: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        idx,
        rusqlite::types::Type::Text,
        format!("unexpected {what} {value:?} in the database").into(),
    )
}

#[Object(name = "Query")]
impl QueryRoot {
    /// Freshness of every registered feed, ordered by source id.
    async fn feeds(&self, ctx: &Context<'_>) -> Result<Vec<FeedState>> {
        let states = feed_state::compute(&app_state(ctx).obs, now_ms()).await?;
        Ok(states.into_iter().map(FeedState::from).collect())
    }

    /// Sightings inside `bbox` observed in `from..=to`, newest first, at most 5000. `taxa` takes
    /// taxon ids or focus species names; an empty `taxa` or `quality` list matches nothing.
    async fn sightings(
        &self,
        ctx: &Context<'_>,
        bbox: BBox,
        from: Time,
        to: Time,
        taxa: Option<Vec<ID>>,
        quality: Option<Vec<Quality>>,
    ) -> Result<Vec<Sighting>> {
        bbox.validate()?;
        check_window(from, to)?;
        let taxa = taxa
            .map(|ids| {
                ids.iter()
                    .map(|id| {
                        id.parse::<i64>()
                            .ok()
                            .filter(|n| *n > 0)
                            .or_else(|| Species::parse(id).map(Species::taxon_id))
                            .ok_or_else(|| async_graphql::Error::new(format!("unknown taxon {:?}", id.as_str())))
                    })
                    .collect::<Result<Vec<i64>>>()
            })
            .transpose()?;
        let taxa = json_list(taxa);
        let quality = json_list(quality.map(|q| q.into_iter().map(Quality::db).collect()));
        let mut rows = app_state(ctx)
            .obs
            .read(move |c| {
                let mut st = c.prepare_cached(
                    "select s.id, s.source_id, s.ext_id, s.taxon_id, t.scientific_name, t.common_name, t.focus,
                            s.lat, s.lon, s.accuracy_m, s.observed_at, s.quality, s.photo_url, s.canonical_id, s.conflict,
                            s.ingested_at
                     from sightings s join taxa t on t.id = s.taxon_id
                     where s.observed_at between ?1 and ?2
                       and s.lat between ?3 and ?4 and s.lon between ?5 and ?6
                       and (?7 is null or s.taxon_id in (select value from json_each(?7)))
                       and (?8 is null or s.quality in (select value from json_each(?8)))
                     order by s.observed_at desc, s.id desc
                     limit ?9",
                )?;
                let rows = st.query_map(
                    params![from.0, to.0, bbox.south, bbox.north, bbox.west, bbox.east, taxa, quality, MAX_SIGHTINGS as i64 + 1],
                    |r| {
                        let quality: String = r.get(11)?;
                        Ok(Sighting {
                            id: ID(r.get::<_, i64>(0)?.to_string()),
                            source: r.get(1)?,
                            ext_id: r.get(2)?,
                            taxon: Taxon {
                                id: ID(r.get::<_, i64>(3)?.to_string()),
                                scientific_name: r.get(4)?,
                                common_name: r.get(5)?,
                                focus: r.get(6)?,
                            },
                            lat: r.get(7)?,
                            lon: r.get(8)?,
                            accuracy_m: r.get(9)?,
                            observed_at: Time(r.get(10)?),
                            quality: Quality::from_db(&quality).ok_or_else(|| bad_column(11, "quality", &quality))?,
                            photo_url: r.get(12)?,
                            canonical_id: r.get::<_, Option<i64>>(13)?.map(|id| ID(id.to_string())),
                            conflict: r.get(14)?,
                            ingested_at: Time(r.get(15)?),
                        })
                    },
                )?;
                rows.collect::<rusqlite::Result<Vec<_>>>()
            })
            .await?;
        if rows.len() > MAX_SIGHTINGS {
            rows.truncate(MAX_SIGHTINGS);
            note_truncated(ctx, "sightings", MAX_SIGHTINGS);
        }
        Ok(rows)
    }

    /// Readings of stations inside `bbox` observed in `from..=to`, newest first, at most 10000.
    async fn readings(
        &self,
        ctx: &Context<'_>,
        bbox: BBox,
        from: Time,
        to: Time,
        params: Option<Vec<Param>>,
    ) -> Result<Vec<Reading>> {
        bbox.validate()?;
        check_window(from, to)?;
        let wanted = json_list(params.map(|p| p.into_iter().map(Param::db).collect()));
        let mut rows = app_state(ctx)
            .obs
            .read(move |c| {
                let mut st = c.prepare_cached(
                    "select s.id, s.source_id, s.name, s.lat, s.lon, s.kind, r.param, r.value, r.flag, r.observed_at, r.origin
                     from readings r join stations s on s.id = r.station_id
                     where r.observed_at between ?1 and ?2
                       and s.lat between ?3 and ?4 and s.lon between ?5 and ?6
                       and (?7 is null or r.param in (select value from json_each(?7)))
                     order by r.observed_at desc, r.station_id, r.param, r.origin
                     limit ?8",
                )?;
                let rows = st.query_map(
                    params![from.0, to.0, bbox.south, bbox.north, bbox.west, bbox.east, wanted, MAX_READINGS as i64 + 1],
                    |r| {
                        let (param, flag, origin): (String, String, String) = (r.get(6)?, r.get(8)?, r.get(10)?);
                        Ok(Reading {
                            station: Station {
                                id: ID(r.get::<_, i64>(0)?.to_string()),
                                source: r.get(1)?,
                                name: r.get(2)?,
                                lat: r.get(3)?,
                                lon: r.get(4)?,
                                kind: r.get(5)?,
                            },
                            param: Param::from_db(&param).ok_or_else(|| bad_column(6, "param", &param))?,
                            value: r.get(7)?,
                            flag: ReadingFlag::from_db(&flag).ok_or_else(|| bad_column(8, "flag", &flag))?,
                            observed_at: Time(r.get(9)?),
                            origin: ReadingOrigin::from_db(&origin).ok_or_else(|| bad_column(10, "origin", &origin))?,
                        })
                    },
                )?;
                rows.collect::<rusqlite::Result<Vec<_>>>()
            })
            .await?;
        if rows.len() > MAX_READINGS {
            rows.truncate(MAX_READINGS);
            note_truncated(ctx, "readings", MAX_READINGS);
        }
        Ok(rows)
    }

    /// Alerts in effect at `at` (onset ≤ at ≤ expires, open ends count as in effect) whose area
    /// intersects `bbox`. Alerts without a polygon (zone-based) are region-wide and always match.
    async fn alerts(&self, ctx: &Context<'_>, bbox: BBox, at: Time) -> Result<Vec<Alert>> {
        bbox.validate()?;
        let rows = app_state(ctx)
            .obs
            .read(move |c| {
                let mut st = c.prepare_cached(
                    "select id, event, severity, headline, area_geojson, onset, expires from alerts
                     where (onset is null or onset <= ?1) and (expires is null or expires >= ?1)
                     order by onset desc, id desc",
                )?;
                let rows = st.query_map([at.0], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, Option<i64>>(5)?,
                        r.get::<_, Option<i64>>(6)?,
                    ))
                })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()
            })
            .await?;
        let mut out = Vec::new();
        for (id, event, severity, headline, area, onset, expires) in rows {
            let area: Option<serde_json::Value> = area.and_then(|a| serde_json::from_str(&a).ok());
            if let Some(extent) = area.as_ref().and_then(geojson_extent) {
                let [w, s, e, n] = extent;
                if w > bbox.east || e < bbox.west || s > bbox.north || n < bbox.south {
                    continue;
                }
            }
            if out.len() == MAX_ALERTS {
                note_truncated(ctx, "alerts", MAX_ALERTS);
                break;
            }
            out.push(Alert {
                id: ID(id.to_string()),
                event,
                severity,
                headline,
                area_geojson: area,
                onset: onset.map(Time),
                expires: expires.map(Time),
            });
        }
        Ok(out)
    }

    /// At most 24 frames as base64 EVF2 (C4). Larger requests go to `GET /v1/frames`.
    async fn frames(&self, ctx: &Context<'_>, from: Time, to: Time, step_minutes: i32) -> Result<FrameChunk> {
        if from > to {
            return Err("`from` must not be after `to`".into());
        }
        if !(1..=1440).contains(&step_minutes) {
            return Err("`stepMinutes` must be 1..=1440".into());
        }
        let step_ms = step_minutes as i64 * 60_000;
        let count = (frames::align(to.0, step_ms) - frames::align(from.0, step_ms)) / step_ms + 1;
        if count > MAX_GQL_FRAMES {
            return Err(async_graphql::Error::new(format!(
                "{count} frames requested; GraphQL `frames` returns at most {MAX_GQL_FRAMES}. \
                 Fetch bulk frames with GET /v1/frames?from=&to=&step= (application/x-evf, gzip)"
            ))
            .extend_with(|_, e| e.set("code", "TOO_MANY_FRAMES")));
        }
        let bytes = frames::chunk(&app_state(ctx).obs, from.0, to.0, step_minutes as u32).await?;
        Ok(FrameChunk {
            from,
            to,
            step_minutes,
            frame_count: count as i32,
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    }

    /// Top cells of `species` at `at` inside `bbox` (default 100, at most 5000).
    async fn hotspots(&self, ctx: &Context<'_>, species: ID, at: Time, bbox: BBox, top: Option<i32>) -> Result<HotspotGrid> {
        bbox.validate()?;
        let sp = self::species(&species)?;
        if let Some(t) = top {
            if !(1..=MAX_HOTSPOT_TOP).contains(&t) {
                return Err(format!("`top` must be 1..={MAX_HOTSPOT_TOP}").into());
            }
        }
        let area = hotspot::score::BBox { west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north };
        let cells = hotspot::score::hotspots(&app_state(ctx).obs, sp, at.0, area, top.map(|t| t as usize)).await?;
        Ok(HotspotGrid {
            species: ID(sp.name().into()),
            at,
            cells: cells
                .into_iter()
                .map(|c| HotspotCell { cell: ID(c.cell), lat: c.lat, lon: c.lon, score: c.score as f64 })
                .collect(),
        })
    }

    /// Each term of the score of one 0.01° cell (`<col>:<row>`, C14).
    async fn explain_cell(&self, ctx: &Context<'_>, cell: ID, species: ID, at: Time) -> Result<HotspotExplain> {
        let sp = self::species(&species)?;
        if hotspot::Grid::REGION.parse_cell(&cell).is_none() {
            return Err(format!("bad cell id {:?}; expected <col>:<row> on the 340 x 320 grid", cell.as_str()).into());
        }
        let ex = hotspot::score::explain(&app_state(ctx).obs, &cell, sp, at.0).await?;
        Ok(HotspotExplain {
            cell,
            species: ID(sp.name().into()),
            at,
            score: ex.score as f64,
            terms: ex
                .terms
                .into_iter()
                .map(|t| HotspotTerm { name: t.name, value: t.value as f64, rationale: t.rationale })
                .collect(),
        })
    }

    /// Top-10% hit rate over the last `days` full UTC days (1..=366).
    async fn backtest(&self, ctx: &Context<'_>, species: ID, days: i32) -> Result<Backtest> {
        let sp = self::species(&species)?;
        if !(1..=MAX_BACKTEST_DAYS).contains(&days) {
            return Err(format!("`days` must be 1..={MAX_BACKTEST_DAYS}").into());
        }
        let b = hotspot::backtest::backtest(&app_state(ctx).obs, sp, days as u32).await?;
        Ok(backtest_out(b))
    }

    /// Provenance of one record (C14 id): normalized record, raw payload, feed state and links.
    async fn evidence(&self, ctx: &Context<'_>, id: ID) -> Result<Evidence> {
        crate::evidence::evidence(app_state(ctx), &id).await.map_err(|e| e.extend())
    }

    /// Materialized board: live missions and notes, messages by HLC, removal totals.
    async fn board(&self, ctx: &Context<'_>, id: ID) -> Result<Board> {
        let board_id = id.0.clone();
        let view = app_state(ctx).team.read(move |c| crdt::board(c, &board_id)).await?;
        let entity = |e: crdt::EntityView| Mission { id: ID(e.id), fields: e.fields };
        Ok(Board {
            id,
            last_seq: view.last_seq,
            missions: view.missions.into_iter().map(entity).collect(),
            notes: view.notes.into_iter().map(entity).collect(),
            messages: view
                .messages
                .into_iter()
                .map(|m| Message { id: ID(m.id), body: m.body, hlc: m.hlc, node_id: m.node_id })
                .collect(),
            removals: serde_json::to_value(view.removals)?,
        })
    }

    /// Persisted ops for a board with `seq` greater than the given one, in seq order, at most 5000
    /// per call (page with the last seq).
    async fn ops_since(&self, ctx: &Context<'_>, board_id: ID, seq: i64) -> Result<Vec<Op>> {
        Ok(ops_after(&app_state(ctx).team, board_id.0, seq).await?)
    }
}

pub fn backtest_out(b: hotspot::backtest::Backtest) -> Backtest {
    Backtest {
        species: ID(b.species.name().into()),
        days: b.days as i32,
        hit_rate: b.hit_rate,
        baseline: b.baseline,
        per_day: b
            .per_day
            .into_iter()
            .map(|d| BacktestDay { day: Time(d.day), sightings: d.sightings as i32, hits: d.hits as i32 })
            .collect(),
    }
}

/// Ops of `board_id` with `seq > after_seq` from `team.db`, oldest first, at most [`OPS_PAGE`].
pub async fn ops_after(team: &Db, board_id: String, after_seq: i64) -> anyhow::Result<Vec<Op>> {
    let ops = team.read(move |c| crdt::ops_since(c, &board_id, after_seq, OPS_PAGE as usize)).await?;
    Ok(ops
        .into_iter()
        .map(|o| Op {
            seq: o.seq,
            id: ID(o.id),
            hlc: o.hlc,
            board_id: ID(o.board_id),
            entity: o.entity,
            entity_id: ID(o.entity_id),
            field: o.field,
            value: Some(o.value).filter(|v| !v.is_null()),
            node_id: o.node_id,
        })
        .collect())
}

/// `[west, south, east, north]` of every coordinate in a GeoJSON geometry, feature or
/// collection. None when it holds no coordinates.
pub fn geojson_extent(v: &serde_json::Value) -> Option<[f64; 4]> {
    fn walk(v: &serde_json::Value, ext: &mut Option<[f64; 4]>) {
        match v {
            serde_json::Value::Array(items) => {
                if let [x, y, ..] = items.as_slice() {
                    if let (Some(x), Some(y)) = (x.as_f64(), y.as_f64()) {
                        let e = ext.get_or_insert([x, y, x, y]);
                        *e = [e[0].min(x), e[1].min(y), e[2].max(x), e[3].max(y)];
                        return;
                    }
                }
                items.iter().for_each(|i| walk(i, ext));
            }
            serde_json::Value::Object(map) => {
                for key in ["coordinates", "geometry", "geometries", "features"] {
                    if let Some(child) = map.get(key) {
                        walk(child, ext);
                    }
                }
            }
            _ => {}
        }
    }
    let mut ext = None;
    walk(v, &mut ext);
    ext
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn geojson_extent_covers_nested_geometries() {
        let poly = json!({"type": "Polygon", "coordinates": [[[-81.0, 25.0], [-80.5, 25.0], [-80.5, 25.4], [-81.0, 25.0]]]});
        assert_eq!(geojson_extent(&poly), Some([-81.0, 25.0, -80.5, 25.4]));
        let fc = json!({"type": "FeatureCollection", "features": [
            {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-82.0, 24.5]}},
            {"type": "Feature", "geometry": poly},
        ]});
        assert_eq!(geojson_extent(&fc), Some([-82.0, 24.5, -80.5, 25.4]));
        assert_eq!(geojson_extent(&json!({"type": "Polygon", "coordinates": []})), None);
        assert_eq!(geojson_extent(&json!(null)), None);
    }

    #[test]
    fn window_checks() {
        assert!(check_window(Time(0), Time(MAX_WINDOW_MS)).is_ok());
        assert!(check_window(Time(0), Time(MAX_WINDOW_MS + 1)).is_err());
        assert!(check_window(Time(2), Time(1)).is_err());
    }

    #[test]
    fn species_ids_accept_names_and_taxon_ids() {
        assert_eq!(species(&ID("python".into())).unwrap(), Species::Python);
        assert_eq!(species(&ID("4".into())).unwrap(), Species::Lionfish);
        assert!(species(&ID("otter".into())).is_err());
    }
}
