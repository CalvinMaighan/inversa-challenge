//! GraphQL `vessels` (GE4, docs/GODS_EYE.md GC4): AIS tracks from `observations.db`
//! (`crate::vessels`). Only apps that list the `aisstream` feed (carp, lionfish) answer; another
//! app gets `code: NO_VESSEL_FEED`.

use async_graphql::{Context, ErrorExtensions, Result, SimpleObject, ID};

use super::app_state;
use super::types::{BBox, Time};
use crate::vessels::{self, TrackQuery, CATEGORIES, DAY_MS};

/// Longest `from`..`to` window.
pub const MAX_WINDOW_MS: i64 = 7 * DAY_MS;
pub const DEFAULT_LIMIT: i32 = 300;
pub const MAX_LIMIT: i32 = 1000;
/// Most points over all returned tracks.
pub const MAX_POINTS: usize = 100_000;

/// One AIS fix.
#[derive(Debug, Clone, PartialEq, SimpleObject)]
pub struct VesselPoint {
    pub at: Time,
    pub lat: f64,
    pub lon: f64,
    /// Speed over ground, knots.
    pub sog: Option<f64>,
    /// Course over ground, degrees true.
    pub cog: Option<f64>,
    /// True heading, degrees.
    pub heading: Option<f64>,
}

/// A vessel and its fixes in the window, oldest first. Cite it as `vessel:<mmsi>`.
#[derive(Debug, Clone, PartialEq, SimpleObject)]
pub struct VesselTrack {
    pub mmsi: ID,
    pub name: Option<String>,
    /// cargo, tanker, passenger, fishing, tug, pleasure, highspeed, service, other or unknown.
    #[graphql(name = "type")]
    pub kind: String,
    pub points: Vec<VesselPoint>,
}

/// The resolver body of `Query.vessels`.
pub async fn vessels(ctx: &Context<'_>, bbox: BBox, from: Time, to: Time, types: Option<Vec<String>>, limit: Option<i32>) -> Result<Vec<VesselTrack>> {
    let state = app_state(ctx);
    if !state.app.cfg.has_feed(vessels::SOURCE_ID) {
        return Err(async_graphql::Error::new(format!("app {} has no vessel feed; vessels serves the apps that list aisstream (carp, lionfish)", state.app.id()))
            .extend_with(|_, e| e.set("code", "NO_VESSEL_FEED")));
    }
    bbox.validate(&state.app)?;
    if from > to {
        return Err("`from` must not be after `to`".into());
    }
    if to.0 - from.0 > MAX_WINDOW_MS {
        return Err(format!("window of {:.1} days exceeds the 7-day cap of vessels", (to.0 - from.0) as f64 / DAY_MS as f64).into());
    }
    if let Some(bad) = types.iter().flatten().find(|t| !CATEGORIES.contains(&t.as_str())) {
        return Err(format!("unknown vessel type {bad:?}; expected one of {}", CATEGORIES.join(", ")).into());
    }
    let limit = limit.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(format!("limit must be 1..={MAX_LIMIT}").into());
    }
    let q = TrackQuery { bbox: [bbox.west, bbox.south, bbox.east, bbox.north], from: from.0, to: to.0, categories: types, limit: limit as usize, max_points: MAX_POINTS };
    let (tracks, truncated) = state.obs.read(move |c| vessels::tracks(c, &q)).await?;
    if truncated {
        let err = async_graphql::Error::new(format!("vessels truncated to {} tracks (most recently seen first); narrow the bbox, window or types", tracks.len()))
            .extend_with(|_, e| {
                e.set("code", "TRUNCATED");
                e.set("limit", limit);
            });
        ctx.add_error(ctx.set_error_path(err.into_server_error(ctx.item.pos)));
    }
    Ok(tracks
        .into_iter()
        .map(|t| VesselTrack {
            mmsi: ID(t.mmsi.to_string()),
            name: t.name,
            kind: vessels::category(t.type_code).to_string(),
            points: t.points.into_iter().map(|p| VesselPoint { at: Time(p.at), lat: p.lat, lon: p.lon, sog: p.sog, cog: p.cog, heading: p.heading }).collect(),
        })
        .collect())
}
