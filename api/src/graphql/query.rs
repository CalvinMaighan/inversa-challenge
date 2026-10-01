//! Query resolvers (PLAN.md C2) over `observations.db` / `team.db`. `frames`, `hotspots`,
//! `explainCell` and `backtest` delegate to T11 (`frames`, `hotspot`); `board` and `opsSince`
//! to T12 (`crdt`); `evidence` to `crate::evidence`.
//!
//! Validation shared by the list queries: the bbox must lie inside the app's regions (C15,
//! C-A4), `from` must not be after `to`, and a window spans at most [`MAX_WINDOW_MS`]. Species
//! arguments name the app's taxa (config id, scientific name or `taxa.id`). Result lists are capped; a
//! capped list comes with a `TRUNCATED` error next to the data, so partial results never pass
//! for complete ones.

use async_graphql::{Context, ErrorExtensions, Object, Result, ID};
use base64::Engine;
use rusqlite::params;

use super::types::{
    Alert, BBox, Backtest, BacktestDay, Board, Evidence, FeedState, ForecastVerification, ForecastView, FrameChunk,
    HotspotCell, HotspotExplain, HotspotGrid, HotspotTerm, Message, Mission, Op, Param, Quality, Reading, ReadingFlag,
    ReadingOrigin, Sighting, SiteStatus, SpeciesCount, Station, Taxon, Time,
};
use super::{app_state, now_ms};
use crate::app::config::{App, Taxon as AppTaxon};
use crate::db::Db;
use crate::hotspot;
use crate::{crdt, feed_state, forecast, frames};

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
/// `taxa` returns at most this many rows; `speciesCounts` at most this many taxa (default 50).
pub const MAX_TAXA: usize = 500;
pub const DEFAULT_SPECIES_TOP: i32 = 50;
/// Upper bound on ops returned by one `opsSince` call or one subscription replay page.
pub const OPS_PAGE: i64 = 5000;
/// Complexity charged for a root field that scans a table or builds a blob (sightings, readings, frames,
/// hotspots, explain, backtest, evidence, board, opsSince), on top of its selection. With
/// [`super::MAX_COMPLEXITY`] it caps one document at about a dozen of them, so aliasing cannot fan one
/// request out into hundreds of 31-day scans. `alerts` stays cheap: the HUD sends ~240 aliased samples.
pub const HEAVY_FIELD: usize = 250;

fn check_window(from: Time, to: Time) -> Result<()> {
    if from > to {
        return Err("`from` must not be after `to`".into());
    }
    if to.0 - from.0 > MAX_WINDOW_MS {
        return Err(format!("window of {:.1} days exceeds the 31-day cap", (to.0 - from.0) as f64 / DAY_MS as f64).into());
    }
    Ok(())
}

/// A focus taxon of the app by config id, scientific name or `taxa.id`.
fn species<'a>(app: &'a App, id: &ID) -> Result<&'a AppTaxon> {
    app.taxon(id).ok_or_else(|| {
        format!("unknown species {:?} for app {}; expected one of {}", id.as_str(), app.id(), app.taxon_choices()).into()
    })
}

/// A species app's hotspot surface; a conditions app has none.
fn hotspot_app<'a>(ctx: &Context<'a>) -> Result<&'a App> {
    let app = &app_state(ctx).app;
    if !app.is_species() {
        return Err(format!("app {} has no hotspot grid (kind conditions): no frames, hotspots, explainCell or backtest", app.id()).into());
    }
    Ok(app)
}

/// `forecasts` returns at most this many issuances of history.
pub const MAX_FORECAST_HISTORY: i32 = 60;

/// A conditions app's forecast store, and the site as one of its configured NWPS ids. A species
/// app gets a typed error (`code: NOT_CONDITIONS_APP`); an unknown site `UNKNOWN_SITE`.
fn forecast_site(ctx: &Context<'_>, site: &ID) -> Result<String> {
    let app = &app_state(ctx).app;
    if app.is_species() {
        return Err(async_graphql::Error::new(format!(
            "app {} has no forecast store (kind species): forecasts, forecastVerify and siteStatusAt serve kind conditions apps only",
            app.id()
        ))
        .extend_with(|_, e| e.set("code", "NOT_CONDITIONS_APP")));
    }
    let wanted = site.trim().to_ascii_uppercase();
    let known: Vec<&str> = app.cfg.locations.iter().filter_map(|l| l.nwps.as_deref()).collect();
    if !known.contains(&wanted.as_str()) {
        return Err(async_graphql::Error::new(format!(
            "unknown site {:?} for app {}; expected an NWPS id of a configured location: {}",
            site.as_str(),
            app.id(),
            known.join(", ")
        ))
        .extend_with(|_, e| e.set("code", "UNKNOWN_SITE")));
    }
    Ok(wanted)
}

/// `taxa.id`s from ids or focus species names (the app's taxa ids).
fn taxon_ids(app: &App, ids: &[ID]) -> Result<Vec<i64>> {
    ids.iter()
        .map(|id| {
            id.parse::<i64>()
                .ok()
                .filter(|n| *n > 0)
                .or_else(|| app.taxon(id).map(|t| t.taxon_id))
                .ok_or_else(|| async_graphql::Error::new(format!("unknown taxon {:?}", id.as_str())))
        })
        .collect()
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
    #[graphql(complexity = "HEAVY_FIELD + child_complexity")]
    async fn sightings(
        &self,
        ctx: &Context<'_>,
        bbox: BBox,
        from: Time,
        to: Time,
        taxa: Option<Vec<ID>>,
        quality: Option<Vec<Quality>>,
    ) -> Result<Vec<Sighting>> {
        let app = &app_state(ctx).app;
        bbox.validate(app)?;
        check_window(from, to)?;
        let taxa = json_list(taxa.map(|ids| taxon_ids(app, &ids)).transpose()?);
        let quality = json_list(quality.map(|q| q.into_iter().map(Quality::db).collect()));
        let mut rows = app_state(ctx)
            .obs
            .read(move |c| {
                let mut st = c.prepare_cached(&format!(
                    "select s.id, s.source_id, s.ext_id, s.lat, s.lon, s.accuracy_m, s.observed_at, s.quality, s.photo_url,
                            s.canonical_id, s.conflict, s.ingested_at, {}
                     from sightings s join taxa t on t.id = s.taxon_id
                     where s.observed_at between ?1 and ?2
                       and s.lat between ?3 and ?4 and s.lon between ?5 and ?6
                       and (?7 is null or s.taxon_id in (select value from json_each(?7)))
                       and (?8 is null or s.quality in (select value from json_each(?8)))
                     order by s.observed_at desc, s.id desc
                     limit ?9",
                    Taxon::COLUMNS
                ))?;
                let rows = st.query_map(
                    params![from.0, to.0, bbox.south, bbox.north, bbox.west, bbox.east, taxa, quality, MAX_SIGHTINGS as i64 + 1],
                    |r| {
                        let quality: String = r.get(7)?;
                        Ok(Sighting {
                            id: ID(r.get::<_, i64>(0)?.to_string()),
                            source: r.get(1)?,
                            ext_id: r.get(2)?,
                            taxon: Taxon::from_row(r, 12)?,
                            lat: r.get(3)?,
                            lon: r.get(4)?,
                            accuracy_m: r.get(5)?,
                            observed_at: Time(r.get(6)?),
                            quality: Quality::from_db(&quality).ok_or_else(|| bad_column(7, "quality", &quality))?,
                            photo_url: r.get(8)?,
                            canonical_id: r.get::<_, Option<i64>>(9)?.map(|id| ID(id.to_string())),
                            conflict: r.get(10)?,
                            ingested_at: Time(r.get(11)?),
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

    /// Taxa by id (`taxa.id` or a focus species name) and/or by name (`q`, matched case-insensitively
    /// inside the common or scientific name), at most 500, focus species first then by id.
    async fn taxa(&self, ctx: &Context<'_>, ids: Option<Vec<ID>>, q: Option<String>) -> Result<Vec<Taxon>> {
        let q = q.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        if ids.is_none() && q.is_none() {
            return Err("`taxa` needs `ids` or `q`".into());
        }
        let ids = json_list(ids.map(|ids| taxon_ids(&app_state(ctx).app, &ids)).transpose()?);
        // `%` and `_` in the caller's text are literal (escaped), never wildcards.
        let like = q.map(|s| format!("%{}%", s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")));
        let rows = app_state(ctx)
            .obs
            .read(move |c| {
                let mut st = c.prepare_cached(&format!(
                    "select {} from taxa t
                     where (?1 is null or t.id in (select value from json_each(?1)))
                       and (?2 is null or t.common_name like ?2 escape '\\' or t.scientific_name like ?2 escape '\\')
                     order by t.focus desc, t.id
                     limit ?3",
                    Taxon::COLUMNS
                ))?;
                let rows = st.query_map(params![ids, like, MAX_TAXA as i64], |r| Taxon::from_row(r, 0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()
            })
            .await?;
        Ok(rows)
    }

    /// Distinct sightings per taxon inside `bbox` observed in `from..=to`, most first. `groups` keeps
    /// taxa whose `iconicGroup` is listed (`other` also matches taxa with no group); `top` defaults to 50.
    #[graphql(complexity = "HEAVY_FIELD + child_complexity")]
    async fn species_counts(
        &self,
        ctx: &Context<'_>,
        bbox: BBox,
        from: Time,
        to: Time,
        groups: Option<Vec<String>>,
        top: Option<i32>,
    ) -> Result<Vec<SpeciesCount>> {
        bbox.validate(&app_state(ctx).app)?;
        check_window(from, to)?;
        let top = top.unwrap_or(DEFAULT_SPECIES_TOP);
        if !(1..=MAX_TAXA as i32).contains(&top) {
            return Err(format!("`top` must be 1..={MAX_TAXA}").into());
        }
        let groups = groups
            .map(|gs| {
                gs.iter()
                    .map(|g| {
                        crate::taxon_info::GROUPS
                            .iter()
                            .find(|known| known.eq_ignore_ascii_case(g.trim()))
                            .map(|k| k.to_string())
                            .ok_or_else(|| {
                                async_graphql::Error::new(format!("unknown group {g:?}; expected one of {}", crate::taxon_info::GROUPS.join(", ")))
                            })
                    })
                    .collect::<Result<Vec<String>>>()
            })
            .transpose()?;
        let other = groups.as_ref().is_some_and(|g| g.iter().any(|g| g == "other"));
        let groups = json_list(groups);
        let rows = app_state(ctx)
            .obs
            .read(move |c| {
                let mut st = c.prepare_cached(&format!(
                    "select {}, count(*) as n, s.id, max(s.observed_at)
                     from sightings s join taxa t on t.id = s.taxon_id
                     where s.observed_at between ?1 and ?2
                       and s.lat between ?3 and ?4 and s.lon between ?5 and ?6
                       and s.canonical_id is null
                       and (?7 is null or t.iconic_group in (select value from json_each(?7)) or (?8 and t.iconic_group is null))
                     group by t.id
                     order by n desc, t.id
                     limit ?9",
                    Taxon::COLUMNS
                ))?;
                let rows = st.query_map(params![from.0, to.0, bbox.south, bbox.north, bbox.west, bbox.east, groups, other, top as i64], |r| {
                    Ok(SpeciesCount {
                        taxon: Taxon::from_row(r, 0)?,
                        count: r.get::<_, i64>(9)? as i32,
                        latest_sighting_id: r.get::<_, Option<i64>>(10)?.map(|id| ID(id.to_string())),
                    })
                })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()
            })
            .await?;
        Ok(rows)
    }

    /// Readings of stations inside `bbox` observed in `from..=to`, newest first, at most 10000.
    #[graphql(complexity = "HEAVY_FIELD + child_complexity")]
    async fn readings(
        &self,
        ctx: &Context<'_>,
        bbox: BBox,
        from: Time,
        to: Time,
        params: Option<Vec<Param>>,
    ) -> Result<Vec<Reading>> {
        bbox.validate(&app_state(ctx).app)?;
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
        bbox.validate(&app_state(ctx).app)?;
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
    #[graphql(complexity = "HEAVY_FIELD + child_complexity")]
    async fn frames(&self, ctx: &Context<'_>, from: Time, to: Time, step_minutes: i32) -> Result<FrameChunk> {
        let app = hotspot_app(ctx)?;
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
        let bytes = frames::chunk(&app_state(ctx).obs, app, from.0, to.0, step_minutes as u32).await?;
        Ok(FrameChunk {
            from,
            to,
            step_minutes,
            frame_count: count as i32,
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    }

    /// Top cells of `species` at `at` inside `bbox` (default 100, at most 5000).
    #[graphql(complexity = "HEAVY_FIELD + child_complexity")]
    async fn hotspots(&self, ctx: &Context<'_>, species: ID, at: Time, bbox: BBox, top: Option<i32>) -> Result<HotspotGrid> {
        let app = hotspot_app(ctx)?;
        bbox.validate(app)?;
        let sp = self::species(app, &species)?;
        if let Some(t) = top {
            if !(1..=MAX_HOTSPOT_TOP).contains(&t) {
                return Err(format!("`top` must be 1..={MAX_HOTSPOT_TOP}").into());
            }
        }
        let area = hotspot::score::BBox { west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north };
        let cells = hotspot::score::hotspots(&app_state(ctx).obs, app, sp, at.0, area, top.map(|t| t as usize)).await?;
        Ok(HotspotGrid {
            species: ID(sp.id().into()),
            at,
            cells: cells
                .into_iter()
                .map(|c| HotspotCell { cell: ID(c.cell), lat: c.lat, lon: c.lon, score: c.score as f64 })
                .collect(),
        })
    }

    /// Each term of the score of one scoring cell (`<col>:<row>`, or `<region>:<col>:<row>` in a
    /// multi-region app; C14).
    #[graphql(complexity = "HEAVY_FIELD + child_complexity")]
    async fn explain_cell(&self, ctx: &Context<'_>, cell: ID, species: ID, at: Time) -> Result<HotspotExplain> {
        let app = hotspot_app(ctx)?;
        let sp = self::species(app, &species)?;
        if app.parse_cell(&cell).is_none() {
            return Err(format!("bad cell id {:?}; expected {}", cell.as_str(), app.cell_shape()).into());
        }
        let ex = hotspot::score::explain(&app_state(ctx).obs, app, &cell, sp, at.0).await?;
        Ok(HotspotExplain {
            cell,
            species: ID(sp.id().into()),
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
    #[graphql(complexity = "HEAVY_FIELD + child_complexity")]
    async fn backtest(&self, ctx: &Context<'_>, species: ID, days: i32) -> Result<Backtest> {
        let app = hotspot_app(ctx)?;
        let sp = self::species(app, &species)?;
        if !(1..=MAX_BACKTEST_DAYS).contains(&days) {
            return Err(format!("`days` must be 1..={MAX_BACKTEST_DAYS}").into());
        }
        let b = hotspot::backtest::backtest(&app_state(ctx).obs, app, sp, days as u32).await?;
        Ok(backtest_out(b))
    }

    /// Provenance of one record (C14 id): normalized record, raw payload, feed state and links.
    #[graphql(complexity = "HEAVY_FIELD + child_complexity")]
    async fn evidence(&self, ctx: &Context<'_>, id: ID) -> Result<Evidence> {
        crate::evidence::evidence(app_state(ctx), &id).await.map_err(|e| e.extend())
    }

    /// Materialized board: live missions and notes, messages by HLC, removal totals.
    #[graphql(complexity = "HEAVY_FIELD + child_complexity")]
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
                .map(|m| Message { id: ID(m.id), body: m.body, hlc: m.hlc, node_id: m.node_id, to: m.to, thread: m.thread })
                .collect(),
            removals: serde_json::to_value(view.removals)?,
        })
    }

    /// Persisted ops for a board with `seq` greater than the given one, in seq order, at most 5000
    /// per call (page with the last seq).
    #[graphql(complexity = "HEAVY_FIELD + child_complexity")]
    async fn ops_since(&self, ctx: &Context<'_>, board_id: ID, seq: i64) -> Result<Vec<Op>> {
        Ok(ops_after(&app_state(ctx).team, board_id.0, seq).await?)
    }

    /// The river forecast known at `asOf` (default now) for a site (NWPS id of a configured
    /// location), plus the last `history` issuances known then (default 1, at most 60) and
    /// where replay coverage starts. Conditions apps only (C3).
    #[graphql(complexity = "HEAVY_FIELD + child_complexity")]
    async fn forecasts(&self, ctx: &Context<'_>, site: ID, as_of: Option<Time>, history: Option<i32>) -> Result<ForecastView> {
        let site = forecast_site(ctx, &site)?;
        let as_of = as_of.unwrap_or_else(|| Time(now_ms()));
        let history = history.unwrap_or(1);
        if !(0..=MAX_FORECAST_HISTORY).contains(&history) {
            return Err(format!("`history` must be 0..={MAX_FORECAST_HISTORY}").into());
        }
        let site2 = site.clone();
        let (snapshot, hist, cov) = app_state(ctx)
            .obs
            .read(move |c| {
                Ok((
                    forecast::query::asof(c, &site2, as_of.0)?,
                    forecast::query::history(c, &site2, as_of.0, history as usize)?,
                    forecast::query::coverage(c, &site2)?,
                ))
            })
            .await?;
        Ok(ForecastView {
            site: ID(site),
            as_of,
            snapshot: snapshot.map(Into::into),
            history: hist.into_iter().map(Into::into).collect(),
            replay_coverage_start: cov.replay_coverage_start.map(Time),
            live_coverage_start: cov.live_coverage_start.map(Time),
            snapshot_count: cov.snapshots as i32,
        })
    }

    /// The issuance at `issuedAt` (newest revision) against every NWPS observation stored since:
    /// per-point error (nearest observation within 30 min; missing stays missing, never
    /// interpolated), bias, and whether the observed peak reached the forecast peak's category.
    #[graphql(complexity = "HEAVY_FIELD + child_complexity")]
    async fn forecast_verify(&self, ctx: &Context<'_>, site: ID, issued_at: Time) -> Result<ForecastVerification> {
        let site = forecast_site(ctx, &site)?;
        let site2 = site.clone();
        let v = app_state(ctx).obs.read(move |c| forecast::query::verify(c, &site2, issued_at.0)).await?;
        v.map(Into::into).ok_or_else(|| {
            async_graphql::Error::new(format!("no forecast for {site} issued at {}", forecast::query::iso(issued_at.0)))
                .extend_with(|_, e| e.set("code", "NOT_FOUND"))
        })
    }

    /// What was known about a site at `asOf`: newest NWPS observation and its flood category
    /// (NWPS thresholds only), freshness bands, the forecast in force, active alert count, and
    /// conflicts (gauge vs forecast differing by more than `conflictFt`, default 1 ft; stale
    /// feeds; missing thresholds). Conditions apps only.
    #[graphql(complexity = "HEAVY_FIELD + child_complexity")]
    async fn site_status_at(&self, ctx: &Context<'_>, site: ID, as_of: Time, conflict_ft: Option<f64>) -> Result<SiteStatus> {
        let site = forecast_site(ctx, &site)?;
        let conflict_ft = conflict_ft.unwrap_or(forecast::query::DEFAULT_CONFLICT_FT);
        if !(conflict_ft >= 0.0 && conflict_ft.is_finite()) {
            return Err("`conflictFt` must be a non-negative number".into());
        }
        let site2 = site.clone();
        let s = app_state(ctx).obs.read(move |c| forecast::query::status_at(c, &site2, as_of.0, conflict_ft)).await?;
        Ok(SiteStatus {
            site: ID(site),
            as_of,
            stage_ft: s.observation.and_then(|o| o.stage_ft),
            observation: s.observation.map(Into::into),
            category: s.category.map(Into::into),
            thresholds: s.thresholds.map(Into::into),
            observation_freshness: s.observation_freshness.into(),
            forecast_freshness: s.forecast_freshness.into(),
            forecast: s.forecast.map(Into::into),
            forecast_now: s.forecast_now.map(Into::into),
            conflicts: s.conflicts.into_iter().map(Into::into).collect(),
            active_alerts: s.active_alerts as i32,
        })
    }
}

pub fn backtest_out(b: hotspot::backtest::Backtest) -> Backtest {
    Backtest {
        species: ID(b.species),
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
        let app = crate::hotspot::score::testkit::python_app();
        assert_eq!(species(&app, &ID("python".into())).unwrap().id(), "python");
        assert_eq!(species(&app, &ID("4".into())).unwrap().id(), "lionfish");
        assert!(species(&app, &ID("otter".into())).unwrap_err().message.contains("python, tegu, iguana, lionfish"));
        assert_eq!(taxon_ids(&app, &[ID("tegu".into()), ID("7".into())]).unwrap(), [2, 7]);
        let lf = crate::ingest::poll::bio::testing::lionfish();
        assert!(species(&lf, &ID("python".into())).is_err(), "not a taxon of Lionfish Watch");
        assert_eq!(species(&lf, &ID("4".into())).unwrap().id(), "lionfish");
    }
}
