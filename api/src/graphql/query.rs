//! Query resolvers. `feeds` and `opsSince` are live; the rest validate their arguments and
//! return empty results until T10 implements them against `observations.db` / `team.db`.

use async_graphql::{Context, Object, Result, ID};

use crate::db::Db;

use super::types::{
    BBox, Backtest, Board, Evidence, FeedState, FrameChunk, HotspotExplain, HotspotGrid, Op, Param, Quality, Reading,
    Sighting, Time,
};
use super::{app_state, now_ms};
use crate::feed_state;

pub struct QueryRoot;

fn check_range(from: Time, to: Time) -> Result<()> {
    if from <= to {
        Ok(())
    } else {
        Err("`from` must not be after `to`".into())
    }
}

#[Object(name = "Query")]
impl QueryRoot {
    /// Freshness of every registered feed, ordered by source id.
    async fn feeds(&self, ctx: &Context<'_>) -> Result<Vec<FeedState>> {
        let states = feed_state::compute(&app_state(ctx).obs, now_ms()).await?;
        Ok(states.into_iter().map(FeedState::from).collect())
    }

    async fn sightings(
        &self,
        bbox: BBox,
        from: Time,
        to: Time,
        taxa: Option<Vec<ID>>,
        quality: Option<Vec<Quality>>,
    ) -> Result<Vec<Sighting>> {
        bbox.validate()?;
        check_range(from, to)?;
        let _ = (taxa, quality);
        Ok(Vec::new())
    }

    async fn readings(&self, bbox: BBox, from: Time, to: Time, params: Option<Vec<Param>>) -> Result<Vec<Reading>> {
        bbox.validate()?;
        check_range(from, to)?;
        let _ = params;
        Ok(Vec::new())
    }

    async fn alerts(&self, bbox: BBox, at: Time) -> Result<Vec<super::types::Alert>> {
        bbox.validate()?;
        let _ = at;
        Ok(Vec::new())
    }

    async fn frames(&self, from: Time, to: Time, step_minutes: i32) -> Result<FrameChunk> {
        check_range(from, to)?;
        if step_minutes <= 0 {
            return Err("`stepMinutes` must be positive".into());
        }
        Ok(FrameChunk { from, to, step_minutes, frame_count: 0, data: String::new() })
    }

    async fn hotspots(&self, species: ID, at: Time, bbox: BBox, top: Option<i32>) -> Result<HotspotGrid> {
        bbox.validate()?;
        let _ = top;
        Ok(HotspotGrid { species, at, cells: Vec::new() })
    }

    async fn explain_cell(&self, cell: ID, species: ID, at: Time) -> Result<HotspotExplain> {
        Ok(HotspotExplain { cell, species, at, score: 0.0, terms: Vec::new() })
    }

    async fn backtest(&self, species: ID, days: i32) -> Result<Backtest> {
        if days <= 0 {
            return Err("`days` must be positive".into());
        }
        Ok(Backtest { species, days, hit_rate: 0.0, baseline: 0.0, per_day: Vec::new() })
    }

    async fn evidence(&self, id: ID) -> Result<Evidence> {
        Err(format!("no evidence with id {:?}", id.as_str()).into())
    }

    async fn board(&self, id: ID) -> Result<Board> {
        Ok(Board {
            id,
            last_seq: 0,
            missions: Vec::new(),
            messages: Vec::new(),
            removals: serde_json::Value::Object(Default::default()),
        })
    }

    /// Persisted ops for a board with `seq` greater than the given one, in seq order.
    async fn ops_since(&self, ctx: &Context<'_>, board_id: ID, seq: i64) -> Result<Vec<Op>> {
        Ok(ops_after(&app_state(ctx).team, board_id.0, seq).await?)
    }
}

/// Upper bound on ops returned by one `opsSince` call or one subscription replay.
pub const OPS_PAGE: i64 = 5000;

/// Ops of `board_id` with `seq > after_seq` from `team.db`, oldest first, at most [`OPS_PAGE`].
pub async fn ops_after(team: &Db, board_id: String, after_seq: i64) -> anyhow::Result<Vec<Op>> {
    team.read(move |c| {
        let mut stmt = c.prepare_cached(
            "select seq, id, hlc, entity, entity_id, field, value, node_id from ops
             where board_id = ?1 and seq > ?2 order by seq limit ?3",
        )?;
        let rows = stmt.query_map(rusqlite::params![board_id, after_seq, OPS_PAGE], |r| {
            let value: Option<String> = r.get(6)?;
            let value = value
                .map(|v| serde_json::from_str(&v))
                .transpose()
                .map_err(|e| rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(e)))?;
            Ok(Op {
                seq: r.get(0)?,
                id: ID(r.get(1)?),
                hlc: r.get(2)?,
                board_id: ID(board_id.clone()),
                entity: r.get(3)?,
                entity_id: ID(r.get(4)?),
                field: r.get(5)?,
                value,
                node_id: r.get(7)?,
            })
        })?;
        rows.collect()
    })
    .await
}
