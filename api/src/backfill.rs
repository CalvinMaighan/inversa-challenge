//! `inversa-api backfill` subcommand (T9).

use crate::state::AppState;

pub async fn run(_state: AppState, _args: &[String]) -> anyhow::Result<()> {
    anyhow::bail!("backfill lands in T9")
}
