//! `inversa-api backfill` subcommand (T9, PRD §6):
//!
//! ```text
//! inversa-api backfill [--days N] [--baseline-years Y] [--dry-run] [--fixtures]
//! ```
//!
//! - `--days N` (default 30): iNat observations updated in the last N days.
//! - `--baseline-years Y` (default 5): NAS and GBIF records observed in the last Y years.
//! - `--fixtures`: instead of the network, feed the recorded payloads of every source that has
//!   them ([`fixture_sources`]: the physical pollers, GOES, NWWS and the bio pollers), listed by
//!   `api/fixtures/<source>/manifest.json` (`INVERSA_FIXTURES_DIR` overrides the root). GOES and
//!   NWWS replay through their own `normalize` without a queue or XMPP session, so no secret is needed.
//! - `--dry-run`: run the whole pipeline against an in-memory database and archive, so nothing
//!   is persisted; the counts are measured from that database.
//!
//! Every page goes through `scheduler::ingest_payload` (archive, normalize, one transaction,
//! dedupe), so a backfill and the live pollers produce identical rows and re-runs add nothing.
//! Network pages are paced by each source's 1 s pacer and a per-source governor that backs off on
//! 429/5xx and honours `Retry-After`. A network backfill walks the bio sources, the only ones
//! with paginated history.
//!
//! Afterwards the stored hourly frames of the last 30 days are rebuilt: the backfill runs in its
//! own process, so the server's frame builder never saw these rows.
//!
//! Output: a `frames:` line, one line per source with measured counts, then
//! `BACKFILL-DRY-RUN-OK` (dry run) or `BACKFILL-OK`.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use anyhow::Context;
use async_trait::async_trait;
use chrono::{Datelike, Months};
use serde::Deserialize;

use crate::ingest::governor::{self, Attempt, Governor};
use crate::ingest::poll::bio::{self, Pacer, Pager};
use crate::ingest::poll::gbif::{self, Gbif, GbifPager};
use crate::ingest::poll::inat::{self, Inat, InatPager};
use crate::ingest::poll::nas::{self, Nas, NasPager};
use crate::ingest::push::{goes_sqs, nwws};
use crate::ingest::scheduler::{ingest_payload, RunStatus};
use crate::ingest::source::{FetchCtx, RawPayload, Source, SourceInfo};
use crate::model::Row;
use crate::state::{AppState, Config};

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
    pub stations: i64,
    pub readings: i64,
    pub alerts: i64,
}

pub async fn measure(state: &AppState, source_id: &'static str) -> anyhow::Result<Measured> {
    state
        .obs
        .read(move |c| {
            c.query_row(
                "select count(*),
                   (select count(*) from sighting_revisions r join sightings s on s.id = r.sighting_id where s.source_id = ?1),
                   coalesce(sum(conflict), 0),
                   count(canonical_id),
                   (select count(*) from stations where source_id = ?1),
                   (select count(*) from readings r join stations s on s.id = r.station_id where s.source_id = ?1),
                   (select count(*) from alerts where source_id = ?1)
                 from sightings where source_id = ?1",
                [source_id],
                |r| {
                    Ok(Measured {
                        sightings: r.get(0)?,
                        revisions: r.get(1)?,
                        conflicts: r.get(2)?,
                        linked: r.get(3)?,
                        stations: r.get(4)?,
                        readings: r.get(5)?,
                        alerts: r.get(6)?,
                    })
                },
            )
        })
        .await
}

pub async fn run(state: AppState, args: &[String]) -> anyhow::Result<()> {
    let args = parse_args(args)?;
    let target = if args.dry_run { AppState::memory((*state.config).clone()) } else { state };

    let tallies: Vec<(&'static str, Tally)> = if args.fixtures {
        let root = fixtures_root();
        let mut out = Vec::new();
        for source in fixture_sources(&target.config) {
            out.push((source.info().id, ingest_fixtures(&target, source.as_ref(), &root).await?));
        }
        out
    } else {
        let (inat_src, nas_src, gbif_src) = (Inat::new(), Nas::new(), Gbif::new());
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

    // Frames first, so rows from payloads that did normalize are rendered even if some failed.
    let started = Instant::now();
    let (from, to) = rebuild_frames(&target).await?;
    println!("frames: rebuilt {} hourly frames {from}..{to} in {:?}", (to - from) / crate::frames::STEP_MS + 1, started.elapsed());

    let mut errors = 0;
    for (id, t) in &tallies {
        let m = measure(&target, id).await?;
        errors += t.errors;
        println!(
            "{id}: payloads={} rows_in={} written={} skipped={} errors={} sightings={} revisions={} conflicts={} linked={} stations={} readings={} alerts={}",
            t.payloads,
            t.rows_in,
            t.rows_written,
            t.rows_skipped,
            t.errors,
            m.sightings,
            m.revisions,
            m.conflicts,
            m.linked,
            m.stations,
            m.readings,
            m.alerts
        );
    }
    anyhow::ensure!(errors == 0, "{errors} payloads failed to normalize (see fetch_runs)");
    println!("{}", if args.dry_run { "BACKFILL-DRY-RUN-OK" } else { "BACKFILL-OK" });
    Ok(())
}

/// Rebuild the stored hourly frames of the whole window (PLAN.md C15) and tell subscribers.
pub async fn rebuild_frames(state: &AppState) -> anyhow::Result<(i64, i64)> {
    let now = crate::frames::now_ms();
    let (from, to) = crate::frames::rebuild(&state.obs, now - crate::frames::WINDOW_MS, now).await?;
    state.hub.publish(crate::realtime::Event::FramesUpdated { from, to });
    Ok((from, to))
}

/// Every source with recorded fixtures (`<root>/<id>/manifest.json`), in ingest order: the
/// physical pollers, GOES and NWWS as replays, then the bio pollers (iNat before NAS and GBIF,
/// which link to it as duplicates).
pub fn fixture_sources(config: &Config) -> Vec<Arc<dyn Source>> {
    let mut out = crate::ingest::poll::physical::sources(config);
    out.push(Arc::new(Replay { info: goes_sqs::info(), normalize: goes_sqs::normalize_object }));
    out.push(Arc::new(Replay { info: nwws::info(), normalize: |raw| nwws::normalize_stanza(&raw.bytes, raw.fetched_at) }));
    out.extend(crate::ingest::poll::bio::sources(config));
    out
}

/// A push source replayed from recorded payloads: the adapter's own `info` and `normalize`,
/// without its connection (no SQS queue for GOES, no XMPP session for NWWS).
struct Replay {
    info: SourceInfo,
    normalize: fn(&RawPayload) -> anyhow::Result<Vec<Row>>,
}

#[async_trait]
impl Source for Replay {
    fn info(&self) -> SourceInfo {
        self.info.clone()
    }

    async fn fetch(&self, _ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
        anyhow::bail!("{}: replay source; payloads come from fixtures, not fetch", self.info.id)
    }

    fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
        (self.normalize)(raw)
    }
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
    #[serde(default = "json_content_type")]
    content_type: String,
    /// `null` for payloads that did not come over HTTP (NWWS stanzas).
    #[serde(default = "http_ok")]
    http_status: Option<u16>,
}

fn json_content_type() -> String {
    "application/json".into()
}

fn http_ok() -> Option<u16> {
    Some(200)
}

/// Feed `<root>/<source>/manifest.json`'s payloads through the pipeline, in manifest order.
pub async fn ingest_fixtures(state: &AppState, source: &dyn Source, root: &std::path::Path) -> anyhow::Result<Tally> {
    // Fixture directories are named by source id, except GOES (`goes`, shared with T7's decoder tests).
    let id = source.info().id;
    let dir = root.join(if id == goes_sqs::SOURCE_ID { "goes" } else { id });
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
            content_type: f.content_type.clone(),
            bytes,
            http_status: f.http_status,
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
        assert_eq!(measure(&state, inat::ID).await.unwrap(), Measured { sightings: 23, revisions: 2, conflicts: 2, linked: 0, ..Default::default() });
        assert_eq!(measure(&state, nas::ID).await.unwrap(), Measured { sightings: 31, revisions: 0, conflicts: 0, linked: 1, ..Default::default() });
        assert_eq!(measure(&state, gbif::ID).await.unwrap(), Measured { sightings: 20, revisions: 0, conflicts: 0, linked: 2, ..Default::default() });

        for src in [&i as &dyn Source, &n, &g] {
            let again = ingest_fixtures(&state, src, &root).await.unwrap();
            assert_eq!(again.rows_written, 0, "{}", src.info().id);
        }
    }
}
