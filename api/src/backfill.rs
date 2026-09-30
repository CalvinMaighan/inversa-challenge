//! `inversa-api backfill` subcommand (T9, PRD §6):
//!
//! ```text
//! inversa-api backfill [--days N] [--baseline-years Y] [--dry-run] [--fixtures]
//! ```
//!
//! - `--days N` (default 30): iNat observations updated in the last N days.
//! - `--baseline-years Y` (default 5): NAS and GBIF records observed in the last Y years.
//! - `--fixtures`: instead of the network, feed the recorded payloads in `api/fixtures/{inat,nas,gbif}`
//!   (listed by each directory's `manifest.json`; `INVERSA_FIXTURES_DIR` overrides the root).
//! - `--dry-run`: run the whole pipeline against an in-memory database and archive, so nothing
//!   is persisted; the counts are measured from that database.
//!
//! Every page goes through `scheduler::ingest_payload` (archive, normalize, one transaction,
//! dedupe), so a backfill and the live pollers produce identical rows and re-runs add nothing.
//! Network pages are paced by each source's 1 s pacer and a per-source governor that backs off on
//! 429/5xx and honours `Retry-After`.
//!
//! Output: one line per source with measured counts, then `BACKFILL-DRY-RUN-OK` (dry run) or
//! `BACKFILL-OK`.

use std::path::PathBuf;
use std::time::Instant;

use anyhow::Context;
use chrono::{Datelike, Months};
use serde::Deserialize;

use crate::ingest::governor::{self, Attempt, Governor};
use crate::ingest::poll::bio::{self, Pacer, Pager};
use crate::ingest::poll::gbif::{self, Gbif, GbifPager};
use crate::ingest::poll::inat::{self, Inat, InatPager};
use crate::ingest::poll::nas::{self, Nas, NasPager};
use crate::ingest::scheduler::{ingest_payload, RunStatus};
use crate::ingest::source::{RawPayload, Source};
use crate::state::AppState;

/// Consecutive failed requests on one page before the backfill gives up.
const MAX_ATTEMPTS: u32 = 6;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Args {
    pub days: u32,
    pub baseline_years: u32,
    pub dry_run: bool,
    pub fixtures: bool,
}

impl Default for Args {
    fn default() -> Self {
        Args { days: 30, baseline_years: 5, dry_run: false, fixtures: false }
    }
}

pub fn parse_args(args: &[String]) -> anyhow::Result<Args> {
    let mut out = Args::default();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let (flag, inline) = match a.split_once('=') {
            Some((f, v)) => (f, Some(v.to_string())),
            None => (a.as_str(), None),
        };
        let mut value = |name: &str| -> anyhow::Result<u32> {
            let v = inline.clone().or_else(|| it.next().cloned()).with_context(|| format!("{name} needs a value"))?;
            let n: u32 = v.parse().with_context(|| format!("{name}: not a number: {v}"))?;
            anyhow::ensure!(n > 0, "{name} must be at least 1");
            Ok(n)
        };
        match flag {
            "--days" => out.days = value("--days")?,
            "--baseline-years" => out.baseline_years = value("--baseline-years")?,
            "--dry-run" if inline.is_none() => out.dry_run = true,
            "--fixtures" if inline.is_none() => out.fixtures = true,
            _ => anyhow::bail!("unknown argument {a}; usage: backfill [--days N] [--baseline-years Y] [--dry-run] [--fixtures]"),
        }
    }
    Ok(out)
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Tally {
    pub payloads: usize,
    pub rows_in: usize,
    pub rows_written: usize,
    pub rows_skipped: usize,
    pub errors: usize,
}

impl Tally {
    fn add(&mut self, out: &crate::ingest::scheduler::IngestOutcome) {
        self.payloads += 1;
        self.rows_in += out.rows_in;
        self.rows_written += out.rows_written;
        self.rows_skipped += out.rows_skipped;
        if out.status == RunStatus::Error {
            self.errors += 1;
        }
    }
}

/// Database counts for one source, measured after every source has run (links need both sides).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Measured {
    pub sightings: i64,
    pub revisions: i64,
    pub conflicts: i64,
    pub linked: i64,
}

pub async fn measure(state: &AppState, source_id: &'static str) -> anyhow::Result<Measured> {
    state
        .obs
        .read(move |c| {
            c.query_row(
                "select count(*),
                   (select count(*) from sighting_revisions r join sightings s on s.id = r.sighting_id where s.source_id = ?1),
                   coalesce(sum(conflict), 0),
                   count(canonical_id)
                 from sightings where source_id = ?1",
                [source_id],
                |r| Ok(Measured { sightings: r.get(0)?, revisions: r.get(1)?, conflicts: r.get(2)?, linked: r.get(3)? }),
            )
        })
        .await
}

pub async fn run(state: AppState, args: &[String]) -> anyhow::Result<()> {
    let args = parse_args(args)?;
    let target = if args.dry_run { AppState::memory((*state.config).clone()) } else { state };
    let (inat_src, nas_src, gbif_src) = (Inat::new(), Nas::new(), Gbif::new());

    let tallies: Vec<(&'static str, Tally)> = if args.fixtures {
        let root = fixtures_root();
        vec![
            (inat::ID, ingest_fixtures(&target, &inat_src, &root).await?),
            (nas::ID, ingest_fixtures(&target, &nas_src, &root).await?),
            (gbif::ID, ingest_fixtures(&target, &gbif_src, &root).await?),
        ]
    } else {
        let now = chrono::Utc::now();
        let today = now.date_naive();
        let baseline_from = today.checked_sub_months(Months::new(12 * args.baseline_years)).context("baseline start")?;
        let mut inat_pager = InatPager::resume(None, (now - chrono::Duration::days(args.days as i64)).timestamp_millis());
        let mut nas_pager = NasPager::new(baseline_from.year(), today.year());
        let mut gbif_pager = GbifPager::new(gbif::Filter::EventDate { from: baseline_from, to: today }, None);
        vec![
            (inat::ID, walk(&target, &inat_src, inat_src.pacer(), &mut inat_pager).await?),
            (nas::ID, walk(&target, &nas_src, nas_src.pacer(), &mut nas_pager).await?),
            (gbif::ID, walk(&target, &gbif_src, gbif_src.pacer(), &mut gbif_pager).await?),
        ]
    };

    let mut errors = 0;
    for (id, t) in &tallies {
        let m = measure(&target, id).await?;
        errors += t.errors;
        println!(
            "{id}: payloads={} rows_in={} written={} skipped={} errors={} sightings={} revisions={} conflicts={} linked={}",
            t.payloads, t.rows_in, t.rows_written, t.rows_skipped, t.errors, m.sightings, m.revisions, m.conflicts, m.linked
        );
    }
    anyhow::ensure!(errors == 0, "{errors} payloads failed to normalize (see fetch_runs)");
    println!("{}", if args.dry_run { "BACKFILL-DRY-RUN-OK" } else { "BACKFILL-OK" });
    Ok(())
}

pub fn fixtures_root() -> PathBuf {
    std::env::var_os("INVERSA_FIXTURES_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures")))
}

#[derive(Deserialize)]
struct Manifest {
    recorded_at: String,
    files: Vec<ManifestFile>,
}

#[derive(Deserialize)]
struct ManifestFile {
    file: String,
    url: String,
}

/// Feed `<root>/<source>/manifest.json`'s payloads through the pipeline, in manifest order.
pub async fn ingest_fixtures(state: &AppState, source: &dyn Source, root: &std::path::Path) -> anyhow::Result<Tally> {
    let dir = root.join(source.info().id);
    let manifest_path = dir.join("manifest.json");
    let manifest: Manifest = serde_json::from_slice(
        &std::fs::read(&manifest_path).with_context(|| format!("read {}", manifest_path.display()))?,
    )
    .with_context(|| format!("parse {}", manifest_path.display()))?;
    let fetched_at = chrono::DateTime::parse_from_rfc3339(&manifest.recorded_at)
        .with_context(|| format!("{}: recorded_at", manifest_path.display()))?
        .timestamp_millis();
    let mut tally = Tally::default();
    for f in &manifest.files {
        let path = dir.join(&f.file);
        let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
        let raw = RawPayload {
            source_url: f.url.clone(),
            content_type: "application/json".into(),
            bytes,
            http_status: Some(200),
            fetched_at,
            next_cursor: None,
            ack: None,
        };
        tally.add(&ingest_payload(state, source, raw, None).await?);
    }
    Ok(tally)
}

/// Real paginated backfill of one source: each page is fetched (paced, governed, retried) and
/// committed before the next is requested, so memory stays at one page.
async fn walk(state: &AppState, source: &dyn Source, pacer: &Pacer, pager: &mut dyn Pager) -> anyhow::Result<Tally> {
    let id = source.info().id;
    let gov = Governor::new(pacer.interval());
    let mut tally = Tally::default();
    let mut cursor: Option<String> = None;
    while let Some(url) = pager.next_url() {
        let mut attempts = 0;
        let mut raw = loop {
            let wait = gov.wait(Instant::now());
            if !wait.is_zero() {
                tokio::time::sleep(wait).await;
            }
            match bio::get_page(state, pacer, &url).await {
                Ok(raw) => {
                    gov.record(Attempt::Success, Instant::now());
                    break raw;
                }
                Err(e) => {
                    gov.record(governor::classify(&e), Instant::now());
                    attempts += 1;
                    if attempts >= MAX_ATTEMPTS {
                        return Err(e.context(format!("{id}: {url}")));
                    }
                    let note = gov.snapshot(Instant::now()).note().unwrap_or_default();
                    tracing::warn!(source = id, "backfill page failed ({attempts}/{MAX_ATTEMPTS}): {e:#} [{note}]");
                }
            }
        };
        pager.advance(&raw.bytes)?;
        raw.next_cursor = pager.cursor();
        let out = ingest_payload(state, source, raw, cursor.clone()).await?;
        if out.cursor.is_some() {
            cursor = out.cursor.clone();
        }
        tally.add(&out);
        if tally.payloads % 10 == 0 {
            tracing::info!(source = id, "backfill: {} pages, {} rows written", tally.payloads, tally.rows_written);
        }
    }
    Ok(tally)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::test_support::test_state;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn backfill_parses_args() {
        assert_eq!(parse_args(&[]).unwrap(), Args::default());
        assert_eq!(
            parse_args(&s(&["--days", "7", "--baseline-years=2", "--dry-run", "--fixtures"])).unwrap(),
            Args { days: 7, baseline_years: 2, dry_run: true, fixtures: true }
        );
        assert!(parse_args(&s(&["--days"])).is_err());
        assert!(parse_args(&s(&["--days", "x"])).is_err());
        assert!(parse_args(&s(&["--days", "0"])).is_err());
        assert!(parse_args(&s(&["--verbose"])).is_err());
        assert!(parse_args(&s(&["--dry-run=yes"])).is_err());
    }

    #[tokio::test]
    async fn backfill_fixtures_measured_counts_and_rerun_adds_nothing() {
        let state = test_state();
        let root = fixtures_root();
        let (i, n, g) = (Inat::new(), Nas::new(), Gbif::new());
        let ti = ingest_fixtures(&state, &i, &root).await.unwrap();
        let tn = ingest_fixtures(&state, &n, &root).await.unwrap();
        let tg = ingest_fixtures(&state, &g, &root).await.unwrap();
        // 12 focus + 10 introduced + 1 flip observation, plus two real revisions (the tegu
        // maverick dispute and the Calotropis coarsening).
        assert_eq!((ti.payloads, ti.rows_in, ti.rows_written, ti.errors), (3, 25, 25, 0));
        assert_eq!((tn.payloads, tn.rows_in, tn.rows_written), (4, 31, 31));
        assert_eq!((tg.payloads, tg.rows_in, tg.rows_written), (1, 20, 20));
        assert_eq!(measure(&state, inat::ID).await.unwrap(), Measured { sightings: 23, revisions: 2, conflicts: 2, linked: 0 });
        assert_eq!(measure(&state, nas::ID).await.unwrap(), Measured { sightings: 31, revisions: 0, conflicts: 0, linked: 1 });
        assert_eq!(measure(&state, gbif::ID).await.unwrap(), Measured { sightings: 20, revisions: 0, conflicts: 0, linked: 2 });

        for src in [&i as &dyn Source, &n, &g] {
            let again = ingest_fixtures(&state, src, &root).await.unwrap();
            assert_eq!(again.rows_written, 0, "{}", src.info().id);
        }
    }
}
