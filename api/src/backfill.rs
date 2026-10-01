//! `inversa-api backfill` subcommand (T9, PRD §6):
//!
//! ```text
//! inversa-api backfill [--app ID] [--days N] [--baseline-years Y] [--dry-run] [--fixtures | --scene NAME]
//! ```
//!
//! - `--app ID` (default `carp`, PLAN.md C-A1): the app whose databases are written; only that
//!   app is opened, and only the feeds its config lists are walked.
//! - `--days N` (default 30): iNat observations updated in the last N days; for a conditions
//!   app (carp) N days of USGS readings and of IEM archive issuances, plus one live poll of
//!   NWPS (thresholds first), the NWS gridpoint forecast and the NWS alerts check.
//! - `--baseline-years Y` (default 5): NAS and GBIF records observed in the last Y years.
//! - `--scene NAME`: replay a recorded scene, `<fixtures root>/scenes/NAME/manifest.json`
//!   ([`SceneManifest`]): payloads from several sources over one time window, fed in manifest
//!   order through the same pipeline. Files ending `.gz` are inflated first; every payload gets
//!   the scene's `replay_at` as its fetch time (the true retrieval time is `recorded_at`), so
//!   adapters that judge staleness against the fetch time see the window as current.
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
//! own process, so the server's frame builder never saw these rows. A scene skips the rebuild; its
//! frames build on first request.
//!
//! Output: a `frames:` line, one line per source with measured counts (a scene adds one line of
//! sightings, readings, sub-10 °C air readings and alerts measured in its window), then
//! `BACKFILL-DRY-RUN-OK` (dry run) or `BACKFILL-OK`.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use anyhow::Context;
use async_trait::async_trait;
use chrono::{Datelike, Months};
use serde::Deserialize;

use crate::app::config::{App, APP_IDS};
use crate::ingest::governor::{self, Attempt, Governor};
use crate::ingest::poll::bio::{self, Pacer, Pager};
use crate::ingest::poll::gbif::{self, Gbif};
use crate::ingest::poll::iem::{self, Iem};
use crate::ingest::poll::inat::{self, Inat};
use crate::ingest::poll::nas::{self, Nas};
use crate::ingest::poll::crw;
use crate::ingest::poll::openmeteo::OpenMeteo;
use crate::ingest::poll::usgs::{self, Usgs};
use crate::ingest::poll::{nwps, nws, nws_forecast};
use crate::ingest::push::nwws::Nwws;
use crate::ingest::push::{goes_sqs, nwws};
use crate::ingest::scheduler::{ingest_payload, RunStatus};
use crate::ingest::source::{FetchCtx, RawPayload, Source, SourceInfo};
use crate::model::Row;
use crate::state::AppState;

/// Consecutive failed requests on one page before the backfill gives up.
const MAX_ATTEMPTS: u32 = 6;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Args {
    pub app: Option<String>,
    /// `None`: the app's iNat `backfillDays` (30 unless the config says otherwise; Lionfish Watch 90).
    pub days: Option<u32>,
    pub baseline_years: u32,
    pub dry_run: bool,
    pub fixtures: bool,
    pub scene: Option<String>,
}

impl Default for Args {
    fn default() -> Self {
        Args { app: None, days: None, baseline_years: 5, dry_run: false, fixtures: false, scene: None }
    }
}

const USAGE: &str = "usage: backfill [--app ID] [--days N] [--baseline-years Y] [--dry-run] [--fixtures | --scene NAME]";

/// A scene name is one directory under `fixtures/scenes`: lowercase letters, digits and dashes.
fn valid_scene_name(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('-') && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
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
            "--app" => {
                let v = inline.clone().or_else(|| it.next().cloned()).context("--app needs a value")?;
                anyhow::ensure!(APP_IDS.contains(&v.as_str()), "--app: unknown app {v:?}; apps are {}", APP_IDS.join(", "));
                out.app = Some(v);
            }
            "--days" => out.days = Some(value("--days")?),
            "--baseline-years" => out.baseline_years = value("--baseline-years")?,
            "--dry-run" if inline.is_none() => out.dry_run = true,
            "--fixtures" if inline.is_none() => out.fixtures = true,
            "--scene" => {
                let v = inline.clone().or_else(|| it.next().cloned()).context("--scene needs a value")?;
                anyhow::ensure!(valid_scene_name(&v), "--scene: not a scene name: {v:?}");
                out.scene = Some(v);
            }
            _ => anyhow::bail!("unknown argument {a}; {USAGE}"),
        }
    }
    anyhow::ensure!(!(out.fixtures && out.scene.is_some()), "--fixtures and --scene are exclusive; {USAGE}");
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
    /// Forecast snapshots the source wrote (`nwps`, `iem`, `nws-forecast`; 0 for the rest).
    pub snapshots: i64,
}

pub async fn measure(state: &AppState, source_id: &'static str) -> anyhow::Result<Measured> {
    let forecast_source = crate::forecast::source_of_feed(source_id).unwrap_or("");
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
                   (select count(*) from alerts where source_id = ?1),
                   (select count(*) from forecast_snapshots where source = ?2)
                 from sightings where source_id = ?1",
                rusqlite::params![source_id, forecast_source],
                |r| {
                    Ok(Measured {
                        sightings: r.get(0)?,
                        revisions: r.get(1)?,
                        conflicts: r.get(2)?,
                        linked: r.get(3)?,
                        stations: r.get(4)?,
                        readings: r.get(5)?,
                        alerts: r.get(6)?,
                        snapshots: r.get(7)?,
                    })
                },
            )
        })
        .await
}

/// One live fetch of `source` through the pipeline (the carp pollers in a network backfill).
async fn fetch_once(state: &AppState, source: &dyn Source) -> anyhow::Result<Tally> {
    let id = source.info().id;
    let mut tally = Tally::default();
    let payloads = source.fetch(&FetchCtx { state, cursor: None }).await.with_context(|| format!("{id}: fetch"))?;
    for raw in payloads {
        tally.add(&ingest_payload(state, source, raw, None).await?);
    }
    Ok(tally)
}

pub async fn run(state: AppState, args: &[String]) -> anyhow::Result<()> {
    let args = parse_args(args)?;
    if let Some(app) = &args.app {
        anyhow::ensure!(app == state.app.id(), "--app {app} but the open state is {}", state.app.id());
    }
    let target = if args.dry_run { AppState::memory((*state.config).clone(), (*state.app).clone()) } else { state };
    println!("app: {}", target.app.id());
    if let Some(name) = &args.scene {
        let scene = ingest_scene(&target, &fixtures_root().join("scenes").join(name)).await?;
        let (from, to) = scene.window;
        let mut errors = 0;
        for (id, t) in &scene.tallies {
            errors += t.errors;
            println!(
                "{id}: payloads={} rows_in={} written={} skipped={} errors={}",
                t.payloads, t.rows_in, t.rows_written, t.rows_skipped, t.errors
            );
        }
        let c = measure_window(&target, from, to).await?;
        println!(
            "scene {name} [{}, {}): sightings={} readings={} air_below_10c={} alerts={}",
            bio::rfc3339_utc(from),
            bio::rfc3339_utc(to),
            c.sightings,
            c.readings,
            c.air_below_10c,
            c.alerts
        );
        anyhow::ensure!(errors == 0, "{errors} payloads failed to normalize (see fetch_runs)");
        println!("{}", if args.dry_run { "BACKFILL-DRY-RUN-OK" } else { "BACKFILL-OK" });
        return Ok(());
    }


    let days = args.days.unwrap_or_else(|| inat::backfill_days(&target.app));
    // The end of the area-count window: now, or the fixtures' recording time.
    let mut window_end = crate::state::now_ms();
    let tallies: Vec<(&'static str, Tally)> = if args.fixtures {
        let root = fixtures_root();
        let mut out = Vec::new();
        let mut recorded = None;
        for source in fixture_sources(&target) {
            let (tally, at) = ingest_fixtures_at(&target, source.as_ref(), &root).await?;
            if [inat::ID, nas::ID, gbif::ID].contains(&source.info().id) {
                recorded = recorded.max(Some(at));
            }
            out.push((source.info().id, tally));
        }
        window_end = recorded.unwrap_or(window_end);
        out
    } else {
        let app = target.app.clone();
        let now = chrono::Utc::now();
        let today = now.date_naive();
        let baseline_from = today.checked_sub_months(Months::new(12 * args.baseline_years)).context("baseline start")?;
        let mut out = Vec::new();
        let inat_src = Inat::new(app.clone());
        if app.cfg.has_feed(inat::ID) {
            let mut pager = inat_src.pager(None, (now - chrono::Duration::days(days as i64)).timestamp_millis());
            out.push((inat::ID, walk(&target, &inat_src, inat_src.pacer(), &mut pager).await?));
        }
        if app.cfg.has_feed(nas::ID) {
            let src = Nas::new(app.clone());
            if nas::global(&app) {
                // NAS has no bbox and Lionfish Watch's areas lie outside the US: every record of
                // the genus, pages in parallel, filtered to the areas by `normalize`.
                let pages = retry(nas::ID, || nas::fetch_global(&target, src.pacer(), &app)).await?;
                out.push((nas::ID, ingest_all(&target, &src, pages).await?));
            } else {
                let mut pager = src.pager(baseline_from.year(), today.year());
                out.push((nas::ID, walk(&target, &src, src.pacer(), &mut pager).await?));
            }
        }
        if app.cfg.has_feed(gbif::ID) {
            let src = Gbif::new(app.clone());
            let mut pager = src.pager(gbif::Filter::EventDate { from: baseline_from, to: today }, None);
            out.push((gbif::ID, walk(&target, &src, src.pacer(), &mut pager).await?));
        }
        if app.cfg.has_feed(inat::ID) && inat::mirror_catch_up(&app) {
            // GBIF copies of iNat records older than the iNat window: fetch their originals by id
            // so every copy is linked as a duplicate (quality_bio), batch by batch.
            let mut tally = Tally::default();
            loop {
                let ids = inat_src.mirror_batch(&target).await?;
                if ids.is_empty() {
                    break;
                }
                let url = inat::ids_url(&ids);
                let page = retry(inat::ID, || bio::get_page(&target, inat_src.pacer(), &url)).await?;
                tally.add(&ingest_payload(&target, &inat_src, page, None).await?);
            }
            println!("inat-mirrors: payloads={} rows_in={} written={}", tally.payloads, tally.rows_in, tally.rows_written);
            if let Some((_, t)) = out.iter_mut().find(|(id, _)| *id == inat::ID) {
                t.payloads += tally.payloads;
                t.rows_in += tally.rows_in;
                t.rows_written += tally.rows_written;
                t.rows_skipped += tally.rows_skipped;
                t.errors += tally.errors;
            }
        }
        // The river feeds (carp): N days of USGS readings, one NWPS poll (thresholds before
        // anything that is categorised), the gridpoint forecast, the alerts check, then N days
        // of archived issuances. Each is one fetch through the pipeline, governed as a poll.
        if app.cfg.has_feed(usgs::SOURCE_ID) && !app.is_species() {
            let src = Usgs::new(&target.config, app.clone()).with_history_days(days);
            out.push((usgs::SOURCE_ID, fetch_once(&target, &src).await?));
        }
        if app.cfg.has_feed(nwps::SOURCE_ID) {
            out.push((nwps::SOURCE_ID, fetch_once(&target, &nwps::Nwps::new(app.clone())).await?));
        }
        if app.cfg.has_feed(nws_forecast::SOURCE_ID) {
            out.push((nws_forecast::SOURCE_ID, fetch_once(&target, &nws_forecast::NwsForecast::new(&target.config, app.clone())).await?));
        }
        if app.cfg.has_feed("nws-alerts") {
            out.push(("nws-alerts", fetch_once(&target, &nws::Nws::new(&target.config, app.clone())).await?));
        }
        if app.cfg.has_feed(iem::SOURCE_ID) {
            out.push((iem::SOURCE_ID, fetch_once(&target, &Iem::new(app.clone()).with_days(days as i64)).await?));
        }
        out
    };


    // Frames first, so rows from payloads that did normalize are rendered even if some failed.
    // A conditions app has no frames.
    if target.app.is_species() {
        let started = Instant::now();
        let (from, to) = rebuild_frames(&target).await?;
        println!("frames: rebuilt {} hourly frames {from}..{to} in {:?}", (to - from) / crate::frames::STEP_MS + 1, started.elapsed());
    } else {
        println!("frames: none ({} is a conditions app)", target.app.id());
    }

    let mut errors = 0;
    for (id, t) in &tallies {
        let m = measure(&target, id).await?;
        errors += t.errors;
        println!(
            "{id}: payloads={} rows_in={} written={} skipped={} errors={} sightings={} revisions={} conflicts={} linked={} stations={} readings={} alerts={} snapshots={}",
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
            m.alerts,
            m.snapshots
        );
    }
    if target.app.is_species() && target.app.cfg.has_feed(inat::ID) {
        area_lines(&target, days, window_end, !args.fixtures).await?;
    }
    if !target.app.is_species() {
        let per_site: Vec<(String, i64)> = target
            .obs
            .read(|c| {
                c.prepare("select site, count(*) from forecast_snapshots group by site order by site")?
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect()
            })
            .await?;
        println!("forecast snapshots per site: {}", per_site.iter().map(|(s, n)| format!("{s}={n}")).collect::<Vec<_>>().join(" "));
    }
    anyhow::ensure!(errors == 0, "{errors} payloads failed to normalize (see fetch_runs)");
    println!("{}", if args.dry_run { "BACKFILL-DRY-RUN-OK" } else { "BACKFILL-OK" });
    Ok(())
}

/// Start of the UTC day `days` before `end_ms`: the iNat `d1` boundary.
pub fn window_start(end_ms: i64, days: u32) -> i64 {
    let end = chrono::DateTime::from_timestamp_millis(end_ms).unwrap_or_default().date_naive();
    (end - chrono::Duration::days(days as i64)).and_hms_opt(0, 0, 0).expect("midnight").and_utc().timestamp_millis()
}

fn ymd(ms: Option<i64>) -> String {
    ms.and_then(chrono::DateTime::from_timestamp_millis).map(|t| t.format("%Y-%m-%d").to_string()).unwrap_or_else(|| "none".into())
}

/// Per-area result lines (L4, C-A8): `<APP>-DATA` iNat records observed in the window, one
/// `area` line per area and source, and with `live` the iNat API's own counts for the same
/// boxes and `d1` as `<APP>-LIVE`, so the two can be compared.
async fn area_lines(state: &AppState, days: u32, end_ms: i64, live: bool) -> anyhow::Result<()> {
    use crate::ingest::quality_bio::{area_summary, DateBasis};
    let from = window_start(end_ms, days);
    let app = state.app.clone();
    let (observed, submitted) = {
        let app = app.clone();
        state
            .obs
            .read(move |c| Ok((area_summary(c, &app, from, i64::MAX, DateBasis::Observed)?, area_summary(c, &app, from, i64::MAX, DateBasis::Submitted)?)))
            .await?
    };
    let tag = app.id().to_uppercase();
    let pick = |rows: &[crate::ingest::quality_bio::AreaSource], source: &str| -> String {
        rows.iter().filter(|r| r.source == source).map(|r| format!("{}={}", r.code, r.in_window)).collect::<Vec<_>>().join(" ")
    };
    println!("window: observed or submitted since {} ({days} d)", ymd(Some(from)));
    for (o, s) in observed.iter().zip(&submitted) {
        println!(
            "area {} {}: total={} observed={} submitted={} independent={} vetted={} corroborated={} newest_observed={} newest_submitted={}",
            o.code,
            o.source,
            o.total,
            o.in_window,
            s.in_window,
            o.independent_in_window,
            o.vetted_in_window,
            o.corroborated_in_window,
            ymd(o.newest_observed_at),
            ymd(o.newest_submitted_at)
        );
    }
    println!("{tag}-SUBMITTED {}", pick(&submitted, inat::ID));
    if live {
        let d1 = ymd(Some(from));
        let pacer = Pacer::shared(inat::ID, inat::REQUEST_INTERVAL);
        let mut parts = Vec::new();
        for r in &app.regions {
            let url = inat::count_url(&r.bbox(), &inat::focus_taxon_ids(&app), &d1);
            let page = retry(inat::ID, || bio::get_page(state, &pacer, &url)).await?;
            let n = serde_json::from_slice::<serde_json::Value>(&page.bytes)?["total_results"].as_i64().unwrap_or(-1);
            parts.push(format!("{}={n}", r.cfg.code()));
        }
        println!("{tag}-LIVE {}", parts.join(" "));
    }
    println!("{tag}-DATA {}", pick(&observed, inat::ID));
    Ok(())
}

/// Up to [`MAX_ATTEMPTS`] tries of one request, backing off 2^n s between them.
async fn retry<T, F, Fut>(id: &str, mut f: F) -> anyhow::Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<T>>,
{
    let mut attempt = 0;
    loop {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                attempt += 1;
                if attempt >= MAX_ATTEMPTS {
                    return Err(e.context(format!("{id}: gave up after {attempt} attempts")));
                }
                tracing::warn!(source = id, "backfill request failed ({attempt}/{MAX_ATTEMPTS}): {e:#}");
                tokio::time::sleep(std::time::Duration::from_secs(1 << attempt.min(5))).await;
            }
        }
    }
}

/// Ingest already-fetched payloads in order.
async fn ingest_all(state: &AppState, source: &dyn Source, pages: Vec<RawPayload>) -> anyhow::Result<Tally> {
    let mut tally = Tally::default();
    for raw in pages {
        tally.add(&ingest_payload(state, source, raw, None).await?);
    }
    Ok(tally)
}

/// Rebuild the stored hourly frames of the whole window (PLAN.md C15) and tell subscribers.
pub async fn rebuild_frames(state: &AppState) -> anyhow::Result<(i64, i64)> {
    let now = crate::frames::now_ms();
    let (from, to) = crate::frames::rebuild(&state.obs, &state.app, now - crate::frames::WINDOW_MS, now).await?;
    state.hub.publish(crate::realtime::Event::FramesUpdated { from, to });
    Ok((from, to))
}

/// Every source of the app with recorded fixtures (`<root>/<id>/manifest.json`), in ingest
/// order: the physical pollers, GOES and NWWS as replays, then the bio pollers (iNat before
/// NAS and GBIF, which link to it as duplicates). Only feeds the app's config lists.
pub fn fixture_sources(state: &AppState) -> Vec<Arc<dyn Source>> {
    let app = &state.app;
    let mut out = crate::ingest::poll::physical::sources(&state.config, app);
    if goes_sqs::feed_id(app).is_some() {
        let regions = app.clone();
        out.push(Arc::new(Replay { info: goes_sqs::info_for(app), normalize: Box::new(move |raw| goes_sqs::normalize_object(raw, &regions)) }));
    }
    // The recorded NWWS stanzas are Miami/Key West products; the adapter filters by the python
    // offices, so only a species app replays them (carp's offices are a C3-ledger follow-up).
    if app.cfg.has_feed("nwws") && app.is_species() {
        out.push(Arc::new(Replay { info: nwws::info(), normalize: Box::new(|raw| nwws::normalize_stanza(&raw.bytes, raw.fetched_at)) }));
    }
    if app.cfg.has_feed(crw::SOURCE_ID) {
        out.push(Arc::new(crw::Crw::new(app.clone())));
    }
    out.extend(crate::ingest::poll::bio::sources(&state.config, app));
    out
}

/// Fixture directory of a source id: `goes` for both GOES forms (shared with T7's decoder
/// tests), `openmeteo` for the marine form, the carp recordings (`usgs_ogc` for a conditions
/// app's OGC payload, `nws_la/*` for the Louisiana alerts and gridpoint forecasts), the id otherwise.
pub fn fixture_dir(app: &App, id: &str) -> String {
    match id {
        goes_sqs::SOURCE_ID | goes_sqs::SST_SOURCE_ID => "goes".into(),
        crate::ingest::poll::openmeteo::MARINE_SOURCE_ID => "openmeteo".into(),
        usgs::SOURCE_ID if !app.is_species() => "usgs_ogc".into(),
        "nws-alerts" => "nws_la/alerts".into(),
        nws_forecast::SOURCE_ID => "nws_la/forecast".into(),
        other => other.into(),
    }
}

/// The manifest of `dir` for `app`: `manifest.<app>.json` when the app has its own recordings
/// (Lionfish Watch's four areas), else the shared `manifest.json`.
pub fn manifest_path(dir: &Path, app: &str) -> PathBuf {
    let own = dir.join(format!("manifest.{app}.json"));
    if own.is_file() {
        own
    } else {
        dir.join("manifest.json")
    }
}

/// A push source replayed from recorded payloads: the adapter's own `info` and `normalize`,
/// without its connection (no SQS queue for GOES, no XMPP session for NWWS).
struct Replay {
    info: SourceInfo,
    normalize: Normalizer,
}

type Normalizer = Box<dyn Fn(&RawPayload) -> anyhow::Result<Vec<Row>> + Send + Sync>;

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

/// 2026-10-01T12:00:00Z, after every fixture's `recorded_at`: the pinned "now" of tests that
/// ingest and score the recorded fixtures (`state::Clock::Fixed`).
#[cfg(test)]
pub const FIXTURE_NOW: i64 = 1_790_856_000_000;

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

/// Feed `<root>/<source>/manifest.json`'s payloads (or the app's own `manifest.<app>.json`)
/// through the pipeline, in manifest order.
#[cfg(test)]
pub async fn ingest_fixtures(state: &AppState, source: &dyn Source, root: &std::path::Path) -> anyhow::Result<Tally> {
    Ok(ingest_fixtures_at(state, source, root).await?.0)
}

/// [`ingest_fixtures`], also returning the manifest's `recorded_at` (unix ms).
pub async fn ingest_fixtures_at(state: &AppState, source: &dyn Source, root: &std::path::Path) -> anyhow::Result<(Tally, i64)> {
    let dir = root.join(fixture_dir(&state.app, source.info().id));
    let manifest_path = manifest_path(&dir, state.app.id());
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
    Ok((tally, fetched_at))
}

/// `fixtures/scenes/<name>/manifest.json`, written by the scene's `fetch.sh`. Extra keys
/// (`title`, `originals`: provenance files that are not ingested) are ignored here.
#[derive(Deserialize)]
pub struct SceneManifest {
    pub scene: String,
    pub window: SceneWindow,
    /// When the payloads were retrieved from upstream.
    pub recorded_at: String,
    /// The fetch time every payload is replayed with.
    pub replay_at: String,
    /// Ingested payloads, in load order.
    pub files: Vec<SceneFile>,
}

#[derive(Deserialize)]
pub struct SceneWindow {
    pub from: String,
    pub to: String,
}

#[derive(Deserialize)]
pub struct SceneFile {
    /// Source id whose `normalize` reads the payload.
    pub source: String,
    /// Path relative to the scene directory; `.gz` is inflated before ingest.
    pub file: String,
    /// Where the payload came from, stored as the raw object's source URL.
    pub url: String,
    pub content_type: String,
}

pub struct SceneOutcome {
    /// `[from, to)` in unix ms.
    pub window: (i64, i64),
    /// Per source, in order of first appearance in the manifest.
    pub tallies: Vec<(&'static str, Tally)>,
}

fn rfc3339_ms(s: &str, what: &str) -> anyhow::Result<i64> {
    Ok(chrono::DateTime::parse_from_rfc3339(s).with_context(|| format!("{what}: {s:?}"))?.timestamp_millis())
}

/// The source a scene payload is replayed through. Only `normalize` runs, so no source starts
/// a connection (the NWWS XMPP session is opened by `fetch`, never called here).
fn scene_source(id: &str, state: &AppState) -> anyhow::Result<Box<dyn Source>> {
    let app = &state.app;
    Ok(match id {
        inat::ID => Box::new(Inat::new(app.clone())),
        nas::ID => Box::new(Nas::new(app.clone())),
        gbif::ID => Box::new(Gbif::new(app.clone())),
        "openmeteo" => Box::new(OpenMeteo::new(app.clone())),
        usgs::SOURCE_ID => Box::new(Usgs::new(&state.config, app.clone())),
        "nwws" => Box::new(Nwws::new(String::new(), None)),
        other => anyhow::bail!("scene: no replay source for {other:?}"),
    })
}

fn read_payload(path: &Path) -> anyhow::Result<Vec<u8>> {
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    if path.extension().is_some_and(|e| e == "gz") {
        let mut out = Vec::with_capacity(bytes.len() * 8);
        flate2::read::GzDecoder::new(bytes.as_slice()).read_to_end(&mut out).with_context(|| format!("gunzip {}", path.display()))?;
        return Ok(out);
    }
    Ok(bytes)
}

/// Replay a scene directory through `ingest_payload`, one manifest file at a time.
pub async fn ingest_scene(state: &AppState, dir: &Path) -> anyhow::Result<SceneOutcome> {
    let manifest_path = dir.join("manifest.json");
    let m: SceneManifest = serde_json::from_slice(
        &std::fs::read(&manifest_path).with_context(|| format!("read {}", manifest_path.display()))?,
    )
    .with_context(|| format!("parse {}", manifest_path.display()))?;
    let dir_name = dir.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    anyhow::ensure!(m.scene == dir_name, "{}: scene {:?} in directory {dir_name:?}", manifest_path.display(), m.scene);
    let (from, to) = (rfc3339_ms(&m.window.from, "window.from")?, rfc3339_ms(&m.window.to, "window.to")?);
    anyhow::ensure!(from < to, "{}: empty window", manifest_path.display());
    rfc3339_ms(&m.recorded_at, "recorded_at")?;
    let fetched_at = rfc3339_ms(&m.replay_at, "replay_at")?;
    anyhow::ensure!(!m.files.is_empty(), "{}: no files", manifest_path.display());

    let mut sources: Vec<(&'static str, Box<dyn Source>, Tally)> = Vec::new();
    for f in &m.files {
        let rel = Path::new(&f.file);
        anyhow::ensure!(
            rel.components().all(|c| matches!(c, std::path::Component::Normal(_))),
            "{}: file {:?} leaves the scene directory",
            manifest_path.display(),
            f.file
        );
        let slot = match sources.iter().position(|(id, _, _)| *id == f.source) {
            Some(i) => i,
            None => {
                let src = scene_source(&f.source, state)?;
                sources.push((src.info().id, src, Tally::default()));
                sources.len() - 1
            }
        };
        let raw = RawPayload {
            source_url: f.url.clone(),
            content_type: f.content_type.clone(),
            bytes: read_payload(&dir.join(rel))?,
            http_status: Some(200),
            fetched_at,
            next_cursor: None,
            ack: None,
        };
        let out = ingest_payload(state, sources[slot].1.as_ref(), raw, None).await?;
        sources[slot].2.add(&out);
    }
    Ok(SceneOutcome { window: (from, to), tallies: sources.into_iter().map(|(id, _, t)| (id, t)).collect() })
}

/// Rows of every source inside `[from, to)`: sightings and readings observed in it, alerts in
/// effect during it.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct WindowCounts {
    pub sightings: i64,
    pub readings: i64,
    pub air_below_10c: i64,
    pub alerts: i64,
}

pub async fn measure_window(state: &AppState, from: i64, to: i64) -> anyhow::Result<WindowCounts> {
    state
        .obs
        .read(move |c| {
            c.query_row(
                "select
                   (select count(*) from sightings where observed_at >= ?1 and observed_at < ?2),
                   (select count(*) from readings where observed_at >= ?1 and observed_at < ?2),
                   (select count(*) from readings where param = 'air_c' and flag = 'ok' and value < 10.0
                      and observed_at >= ?1 and observed_at < ?2),
                   (select count(*) from alerts where onset < ?2 and coalesce(expires, onset) >= ?1)",
                [from, to],
                |r| Ok(WindowCounts { sightings: r.get(0)?, readings: r.get(1)?, air_below_10c: r.get(2)?, alerts: r.get(3)? }),
            )
        })
        .await
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
            Args { app: None, days: Some(7), baseline_years: 2, dry_run: true, fixtures: true, scene: None }
        );
        assert_eq!(parse_args(&s(&["--app", "python"])).unwrap().app.as_deref(), Some("python"));
        assert_eq!(parse_args(&s(&["--app=lionfish", "--fixtures"])).unwrap().app.as_deref(), Some("lionfish"));
        assert!(parse_args(&s(&["--app", "otter"])).unwrap_err().to_string().contains("carp, lionfish, python"));
        assert!(parse_args(&s(&["--app"])).is_err());
        assert_eq!(
            parse_args(&s(&["--scene", "cold-snap-2026-02-01", "--dry-run"])).unwrap(),
            Args { dry_run: true, scene: Some("cold-snap-2026-02-01".into()), ..Args::default() }
        );
        assert_eq!(parse_args(&s(&["--scene=a1"])).unwrap().scene.as_deref(), Some("a1"));
        assert!(parse_args(&s(&["--scene"])).is_err());
        assert!(parse_args(&s(&["--scene", "../inat"])).is_err());
        assert!(parse_args(&s(&["--scene", "Cold"])).is_err());
        assert!(parse_args(&s(&["--scene", "x", "--fixtures"])).is_err());
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
        let (i, n, g) = (Inat::new(state.app.clone()), Nas::new(state.app.clone()), Gbif::new(state.app.clone()));
        let ti = ingest_fixtures(&state, &i, &root).await.unwrap();
        let tn = ingest_fixtures(&state, &n, &root).await.unwrap();
        let tg = ingest_fixtures(&state, &g, &root).await.unwrap();
        // 12 python observations + 1 ID-dispute observation, plus its one real revision (the
        // maverick Pantherophis ID coarsened to Serpentes).
        assert_eq!((ti.payloads, ti.rows_in, ti.rows_written, ti.errors), (2, 14, 14, 0));
        assert_eq!((tn.payloads, tn.rows_in, tn.rows_written), (1, 20, 20));
        assert_eq!((tg.payloads, tg.rows_in, tg.rows_written), (1, 20, 20));
        assert_eq!(measure(&state, inat::ID).await.unwrap(), Measured { sightings: 13, revisions: 1, conflicts: 1, linked: 0, ..Default::default() });
        assert_eq!(measure(&state, nas::ID).await.unwrap(), Measured { sightings: 20, revisions: 0, conflicts: 0, linked: 0, ..Default::default() });
        assert_eq!(measure(&state, gbif::ID).await.unwrap(), Measured { sightings: 20, revisions: 0, conflicts: 0, linked: 9, ..Default::default() });

        for src in [&i as &dyn Source, &n, &g] {
            let again = ingest_fixtures(&state, src, &root).await.unwrap();
            assert_eq!(again.rows_written, 0, "{}", src.info().id);
        }

        // The same fixtures into Lionfish Watch land in its own database with only lionfish in focus,
        // and `--app` must name the open app.
        let lf = crate::app::test_support::test_state_for("lionfish");
        run(lf.clone(), &s(&["--fixtures", "--app", "lionfish", "--dry-run"])).await.unwrap();
        assert!(run(lf.clone(), &s(&["--fixtures", "--app", "python"])).await.unwrap_err().to_string().contains("--app python"));
        let ids: Vec<&str> = fixture_sources(&lf).iter().map(|s| s.info().id).collect();
        assert_eq!(ids, ["ndbc", "openmeteo-marine", "goes19-sst", "crw", "inat", "nas", "gbif"]);
        assert_eq!(measure(&state, inat::ID).await.unwrap().sightings, 13, "python's database is untouched");
    }

    /// The recorded cold snap of 30 Jan - 3 Feb 2026 and the rebound to 7 Feb (see the scene's
    /// fetch.sh and docs/demo-script.md): real iNat, Open-Meteo archive, USGS and NWS Miami/Key West
    /// payloads.
    #[tokio::test]
    async fn scene_cold_snap() {
        use crate::hotspot::rules::PYTHON_COLD_SUPPRESS;
        use crate::hotspot::score::{explain, testkit::ms, Explain};

        let state = test_state();
        let python = state.app.taxon("python").unwrap().clone();
        let dir = fixtures_root().join("scenes").join("cold-snap-2026-02-01");
        let scene = ingest_scene(&state, &dir).await.unwrap();
        let (from, to) = scene.window;
        assert_eq!((from, to), (ms(2026, 1, 30, 0), ms(2026, 2, 8, 0)));
        let ids: Vec<&str> = scene.tallies.iter().map(|(id, _)| *id).collect();
        assert_eq!(ids, ["inat", "openmeteo", "usgs", "nwws"]);
        // Measured (iNat re-recorded 2026-10-01): no Burmese python report in the bbox on the cold
        // days, two research-grade reports observed on 6 Feb once it warmed. Open-Meteo 182 grid
        // points x 3 variables x 216 h plus the marine points; USGS 15-minute series; 24 NPW products.
        let rows_in: Vec<(&str, usize, usize, usize)> =
            scene.tallies.iter().map(|(id, t)| (*id, t.payloads, t.rows_in, t.errors)).collect();
        assert_eq!(rows_in, [("inat", 1, 2, 0), ("openmeteo", 2, 171_936, 0), ("usgs", 2, 127_956, 0), ("nwws", 24, 113, 0)]);
        let counts = measure_window(&state, from, to).await.unwrap();
        assert_eq!(counts, WindowCounts { sightings: 2, readings: 299_157, air_below_10c: 6_722, alerts: 43 });
        assert!(counts.air_below_10c > 0, "no sub-10 °C air readings in the window");
        let cold_days = measure_window(&state, from, ms(2026, 2, 4, 0)).await.unwrap();
        assert_eq!(cold_days.sightings, 0, "no python report during the cold days themselves");
        let observed: Vec<i64> = state
            .obs
            .read(|c| {
                let mut st = c.prepare("select observed_at from sightings order by observed_at")?;
                let rows = st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<i64>>>()?;
                Ok(rows)
            })
            .await
            .unwrap();
        assert!(observed.iter().all(|&t| (ms(2026, 2, 6, 0)..ms(2026, 2, 7, 0)).contains(&t)), "both reports observed on 6 Feb: {observed:?}");

        // The NWS Miami products of the night of 31 Jan - 1 Feb.
        let events: Vec<String> = state
            .obs
            .read(|c| {
                let mut st = c.prepare("select distinct event from alerts where source_id = 'nwws' order by event")?;
                let rows = st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
                Ok(rows)
            })
            .await
            .unwrap();
        for e in ["Extreme Cold Warning", "Freeze Warning", "Cold Weather Advisory"] {
            assert!(events.iter().any(|x| x == e), "{e} missing from {events:?}");
        }

        // Cell 292:142 (25.725 N, 80.275 W, Coral Gables / South Miami) on the cold noon of 1 Feb
        // and after the rebound on 3 Feb: the python activity rule follows the air temperature.
        let cell = "292:142";
        let (cold, warm) = (ms(2026, 2, 1, 17), ms(2026, 2, 3, 19));
        let term = |ex: &Explain, name: &str| ex.terms.iter().find(|t| t.name == name).cloned().unwrap();
        let rule = "activity.python_warm_temperature";

        // 12:00 EST on 1 Feb: the nearest Open-Meteo archive point (25.675 N, 80.325 W) reads 7.0 °C,
        // below 15 °C, so pythons hole up (0.3x). No reports, so no density.
        let at_cold = explain(&state.obs, &state.app, cell, &python, cold).await.unwrap();
        assert_eq!(term(&at_cold, "density").value, 0.0);
        assert_eq!(term(&at_cold, rule).value, PYTHON_COLD_SUPPRESS);
        assert!(term(&at_cold, "conditions").rationale.starts_with("air_c 7.0,"), "{:?}", term(&at_cold, "conditions"));

        // 14:00 EST on 3 Feb: 19.1 °C, between the cold and warm bands (1x).
        let at_warm = explain(&state.obs, &state.app, cell, &python, warm).await.unwrap();
        assert_eq!(term(&at_warm, rule).value, 1.0);
        assert!(term(&at_warm, "conditions").rationale.starts_with("air_c 19.1,"), "{:?}", term(&at_warm, "conditions"));

        // Replaying the scene again changes nothing. Sightings and readings are untouched; each
        // NWS product re-applies its update to the event rows it continues, and the last product
        // of each event leaves the row where the first replay did.
        let alerts = |state: AppState| async move {
            state
                .obs
                .read(|c| {
                    let mut st = c.prepare("select ext_id, event, severity, headline, onset, expires from alerts order by ext_id")?;
                    let rows = st
                        .query_map([], |r| {
                            Ok(format!(
                                "{}|{}|{}|{:?}|{:?}|{:?}",
                                r.get::<_, String>(0)?,
                                r.get::<_, String>(1)?,
                                r.get::<_, String>(2)?,
                                r.get::<_, Option<String>>(3)?,
                                r.get::<_, Option<i64>>(4)?,
                                r.get::<_, Option<i64>>(5)?
                            ))
                        })?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    Ok(rows)
                })
                .await
                .unwrap()
        };
        let before = alerts(state.clone()).await;
        let again = ingest_scene(&state, &dir).await.unwrap();
        for (id, t) in &again.tallies {
            if *id != "nwws" {
                assert_eq!(t.rows_written, 0, "{id}");
            }
        }
        assert_eq!(alerts(state.clone()).await, before);
        assert_eq!(measure_window(&state, from, to).await.unwrap(), counts);
    }
}
