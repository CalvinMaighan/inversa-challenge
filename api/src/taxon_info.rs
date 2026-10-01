//! Taxon enrichment (T44): every species on the globe gets its common name, iNat group, a two-sentence
//! plain summary, a photo and its iNat page, so a "grey dot" opens as a real species card.
//!
//! - The iNat adapter stores `taxa.inat_taxon_id` and `iconic_group` from each observation's taxon at
//!   ingest. Rows ingested before that (or by GBIF/NAS, which carry no iNat id) get their id from the
//!   archived raw iNat payloads ([`backfill_ids_from_archive`]): no network, one pass over the payloads
//!   whose sightings point at unenriched taxa.
//! - [`enrich`] fetches `GET /v1/taxa/<ids>` in batches of [`BATCH`] under the `inat_taxa` governor
//!   (one request per second, backoff on 429/5xx) and stores the Wikipedia summary as plain text
//!   (HTML stripped, at most two sentences), the default photo URL (served through
//!   `/v1/media/taxon/<id>`), the Wikipedia URL and `fetched_at`. A taxon is refreshed after [`REFRESH`].
//! - [`spawn`] runs the archive backfill once, then an enrichment sweep every [`SWEEP`] while sources are
//!   enabled (new taxa arrive with every iNat poll). The CLI backfill runs the same sweep after its walk,
//!   and replays `fixtures/inat/taxa-*.json` for `--fixtures`.

use std::io::Read;
use std::time::{Duration, Instant};

use rusqlite::{params, Transaction};
use serde::Deserialize;

use crate::ingest::governor::{self, Attempt};
use crate::state::AppState;

pub const API: &str = "https://api.inaturalist.org/v1/taxa";
/// Ids per `/v1/taxa/<ids>` request (iNat accepts up to 30 in one call).
pub const BATCH: usize = 30;
/// iNat etiquette: at most one request per second.
pub const REQUEST_INTERVAL: Duration = Duration::from_secs(1);
/// A taxon is fetched again after this long (names, photos and summaries change slowly).
pub const REFRESH: Duration = Duration::from_secs(30 * 24 * 3600);
/// How often the background task looks for taxa to enrich.
pub const SWEEP: Duration = Duration::from_secs(10 * 60);
/// Governor key (not a `sources` row: enrichment is not a feed).
pub const GOVERNOR_ID: &str = "inat_taxa";
/// `summary_plain` holds at most this many sentences.
pub const MAX_SENTENCES: usize = 2;
pub const PAGE_URL: &str = "https://www.inaturalist.org/taxa";

/// The groups `taxa.iconic_group` can hold, as iNat names them, plus `other`.
pub const GROUPS: [&str; 11] = [
    "Reptilia",
    "Amphibia",
    "Aves",
    "Mammalia",
    "Actinopterygii",
    "Mollusca",
    "Insecta",
    "Arachnida",
    "Plantae",
    "Fungi",
    "other",
];

/// iNat `iconic_taxon_name` to the stored group: a known group as is, anything else (Animalia,
/// Chromista, Protozoa, unknown, missing) `other`.
pub fn iconic_group(name: Option<&str>) -> &'static str {
    let name = name.unwrap_or("").trim();
    GROUPS[..GROUPS.len() - 1].iter().copied().find(|g| g.eq_ignore_ascii_case(name)).unwrap_or("other")
}

pub fn page_url(inat_taxon_id: i64) -> String {
    format!("{PAGE_URL}/{inat_taxon_id}")
}

// ---------------------------------------------------------------------------------------------
// Parsing a /v1/taxa page
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct Page {
    #[serde(default)]
    results: Vec<TaxonInfo>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TaxonInfo {
    pub id: i64,
    pub preferred_common_name: Option<String>,
    pub iconic_taxon_name: Option<String>,
    pub wikipedia_url: Option<String>,
    pub wikipedia_summary: Option<String>,
    pub default_photo: Option<Photo>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Photo {
    pub medium_url: Option<String>,
    pub url: Option<String>,
}

impl TaxonInfo {
    /// Medium photo; the `square` URL serves `medium` on the same path (as in the iNat adapter).
    pub fn photo_url(&self) -> Option<String> {
        let p = self.default_photo.as_ref()?;
        if let Some(m) = p.medium_url.as_deref().filter(|u| !u.is_empty()) {
            return Some(m.to_string());
        }
        let url = p.url.as_deref().filter(|u| !u.is_empty())?;
        Some(url.replace("/square.", "/medium."))
    }

    pub fn summary_plain(&self) -> Option<String> {
        self.wikipedia_summary.as_deref().and_then(plain_summary)
    }

    /// Wikipedia URLs come with spaces in the title; the encoded form is what a browser needs.
    pub fn wikipedia_url(&self) -> Option<String> {
        let u = self.wikipedia_url.as_deref()?.trim();
        if u.is_empty() {
            return None;
        }
        Some(u.replace(' ', "_"))
    }
}

/// Pure: one `/v1/taxa/<ids>` body to its taxa.
pub fn parse_page(bytes: &[u8]) -> anyhow::Result<Vec<TaxonInfo>> {
    Ok(serde_json::from_slice::<Page>(bytes)?.results)
}

/// Tags removed, the common entities decoded, whitespace collapsed.
pub fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if in_tag => {}
            '&' => {
                let mut entity = String::new();
                while let Some(&n) = chars.peek() {
                    if n == ';' || entity.len() > 8 || n.is_whitespace() {
                        break;
                    }
                    entity.push(n);
                    chars.next();
                }
                let terminated = chars.peek() == Some(&';');
                if terminated {
                    chars.next();
                }
                match (terminated, entity.as_str()) {
                    (true, "amp") => out.push('&'),
                    (true, "lt") => out.push('<'),
                    (true, "gt") => out.push('>'),
                    (true, "quot") => out.push('"'),
                    (true, "apos" | "#39") => out.push('\''),
                    (true, "nbsp") => out.push(' '),
                    (true, e) if e.starts_with('#') => match e[1..].parse::<u32>().ok().and_then(char::from_u32) {
                        Some(ch) => out.push(ch),
                        None => out.push(' '),
                    },
                    _ => {
                        out.push('&');
                        out.push_str(&entity);
                        if terminated {
                            out.push(';');
                        }
                    }
                }
            }
            c => out.push(c),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The first [`MAX_SENTENCES`] sentences of a plain text. A sentence ends at `.`, `!` or `?` followed by
/// a space and a capital letter, digit or opening bracket, so "Anolis sp. is" and "e.g. the" do not
/// end one. An abbreviation such as "U.S." is kept whole by the capital-letter rule as well.
pub fn first_sentences(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut ends = 0;
    for i in 0..chars.len() {
        if !matches!(chars[i], '.' | '!' | '?') {
            continue;
        }
        let next = chars.get(i + 1).copied();
        let after = chars.get(i + 2).copied();
        let closes = next.is_none()
            || (next == Some(' ') && after.is_some_and(|c| c.is_uppercase() || c.is_ascii_digit() || c == '(' || c == '"'));
        if closes {
            ends += 1;
            if ends == max {
                return chars[..=i].iter().collect::<String>().trim().to_string();
            }
        }
    }
    text.trim().to_string()
}

/// Wikipedia summary HTML to the short plain text the card shows; `None` when nothing is left.
pub fn plain_summary(html: &str) -> Option<String> {
    let text = first_sentences(&strip_html(html), MAX_SENTENCES);
    (!text.is_empty()).then_some(text)
}

// ---------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------

/// Write fetched taxa onto their rows (matched by `inat_taxon_id`). Returns rows updated. The group
/// from `/v1/taxa` is authoritative; a stored common name is kept unless empty, since the seeded focus
/// names are the ones the UI and the agent use.
pub fn apply(tx: &Transaction, infos: &[TaxonInfo], now_ms: i64) -> rusqlite::Result<usize> {
    let mut st = tx.prepare_cached(
        "update taxa set
           common_name = case when common_name = '' then ?2 else common_name end,
           iconic_group = ?3,
           summary_plain = ?4,
           photo_url = ?5,
           wikipedia_url = ?6,
           fetched_at = ?7
         where inat_taxon_id = ?1",
    )?;
    let mut n = 0;
    for t in infos {
        n += st.execute(params![
            t.id,
            t.preferred_common_name.as_deref().unwrap_or("").trim(),
            iconic_group(t.iconic_taxon_name.as_deref()),
            t.summary_plain(),
            t.photo_url(),
            t.wikipedia_url(),
            now_ms,
        ])?;
    }
    Ok(n)
}

/// iNat ids of taxa never fetched, or fetched before `now - REFRESH`, never-fetched first.
pub async fn pending_ids(state: &AppState, now_ms: i64) -> anyhow::Result<Vec<i64>> {
    let stale_before = now_ms - REFRESH.as_millis() as i64;
    state
        .obs
        .read(move |c| {
            let mut st = c.prepare_cached(
                "select distinct inat_taxon_id from taxa
                 where inat_taxon_id is not null and (fetched_at is null or fetched_at < ?1)
                 order by fetched_at is not null, inat_taxon_id",
            )?;
            let ids = st.query_map([stale_before], |r| r.get(0))?.collect::<rusqlite::Result<Vec<i64>>>()?;
            Ok(ids)
        })
        .await
}

pub fn batch_url(ids: &[i64]) -> String {
    let list: Vec<String> = ids.iter().map(i64::to_string).collect();
    format!("{API}/{}", list.join(","))
}

/// Fetch and store every pending taxon, [`BATCH`] per request, under the governor. Returns the number
/// of rows updated. A request failure ends the sweep (the governor holds the backoff for the next one).
pub async fn enrich(state: &AppState) -> anyhow::Result<usize> {
    let now = chrono::Utc::now().timestamp_millis();
    let ids = pending_ids(state, now).await?;
    if ids.is_empty() {
        return Ok(0);
    }
    let gov = governor::for_source(GOVERNOR_ID, REQUEST_INTERVAL);
    let mut updated = 0;
    for chunk in ids.chunks(BATCH) {
        tokio::time::sleep(gov.wait(Instant::now())).await;
        let url = batch_url(chunk);
        let fetched = async {
            let res = state.http.get(&url).header("accept", "application/json").send().await?;
            let res = governor::check_response(res)?;
            Ok::<Vec<u8>, anyhow::Error>(res.bytes().await?.to_vec())
        }
        .await;
        let bytes = match fetched {
            Ok(b) => {
                gov.record(Attempt::Success, Instant::now());
                b
            }
            Err(e) => {
                gov.record(governor::classify(&e), Instant::now());
                tracing::warn!("taxon_info: {url}: {e:#}; {}", gov.snapshot(Instant::now()).note().unwrap_or_default());
                return Err(e.context("taxon_info: iNat /v1/taxa"));
            }
        };
        let infos = parse_page(&bytes)?;
        let now = chrono::Utc::now().timestamp_millis();
        updated += state.obs.write(move |tx| apply(tx, &infos, now)).await?;
    }
    tracing::info!("taxon_info: enriched {updated} taxa in {} requests", ids.len().div_ceil(BATCH));
    Ok(updated)
}

/// Store a recorded `/v1/taxa` page (fixtures, tests).
pub async fn apply_page(state: &AppState, bytes: &[u8]) -> anyhow::Result<usize> {
    let infos = parse_page(bytes)?;
    let now = chrono::Utc::now().timestamp_millis();
    Ok(state.obs.write(move |tx| apply(tx, &infos, now)).await?)
}

/// Fill `inat_taxon_id` and `iconic_group` of taxa whose iNat sightings predate T44, from the archived
/// payloads those sightings came from. Returns taxa updated.
pub async fn backfill_ids_from_archive(state: &AppState) -> anyhow::Result<usize> {
    let keys: Vec<String> = state
        .obs
        .read(|c| {
            let mut st = c.prepare_cached(
                "select distinct r.r2_key from raw_objects r
                 join sightings s on s.raw_object_id = r.id
                 join taxa t on t.id = s.taxon_id
                 where s.source_id = 'inat' and t.inat_taxon_id is null",
            )?;
            let keys = st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
            Ok(keys)
        })
        .await?;
    let mut updated = 0;
    for key in keys {
        let gz = match state.archive.get(&key).await {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!("taxon_info: archive {key}: {e:#}");
                continue;
            }
        };
        let refs = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<crate::model::TaxonRef>> {
            let mut bytes = Vec::new();
            flate2::read::GzDecoder::new(&gz[..]).read_to_end(&mut bytes)?;
            Ok(crate::ingest::poll::inat::normalize(&bytes)?
                .into_iter()
                .filter_map(|row| match row {
                    crate::model::Row::Sighting(s) if s.taxon.inat_taxon_id.is_some() => Some(s.taxon),
                    _ => None,
                })
                .collect())
        })
        .await??;
        updated += state
            .obs
            .write(move |tx| {
                let mut st = tx.prepare_cached(
                    "update taxa set inat_taxon_id = coalesce(inat_taxon_id, ?2), iconic_group = coalesce(iconic_group, ?3)
                     where scientific_name = ?1 and (inat_taxon_id is null or iconic_group is null)",
                )?;
                let mut n = 0;
                for t in &refs {
                    n += st.execute(params![t.scientific_name, t.inat_taxon_id, t.iconic_group])?;
                }
                Ok(n)
            })
            .await?;
    }
    if updated > 0 {
        tracing::info!("taxon_info: {updated} taxa given their iNat id from the archive");
    }
    Ok(updated)
}

/// Background enrichment: the archive backfill once, then a sweep every [`SWEEP`]. Network sweeps only
/// run while sources are enabled; with `INVERSA_SOURCES=off` the task stops after the backfill.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        if let Err(e) = backfill_ids_from_archive(&state).await {
            tracing::warn!("taxon_info: archive backfill: {e:#}");
        }
        if !state.config.sources_enabled {
            return;
        }
        loop {
            if let Err(e) = enrich(&state).await {
                tracing::warn!("taxon_info: {e:#}");
            }
            tokio::time::sleep(SWEEP).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::test_support::test_state;

    fn fixture() -> Vec<u8> {
        std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/inat/taxa-p1.json")).unwrap()
    }

    #[test]
    fn taxon_info_strips_html_and_keeps_two_sentences() {
        let html = "The <b>brown anole</b> (<i>Anolis sagrei</i>) is a lizard native to Cuba and the Bahamas. \
                    It has been widely introduced elsewhere, e.g. by the pet trade, &amp; is now found in Florida. \
                    It has also been introduced to Taiwan.";
        assert_eq!(
            plain_summary(html).unwrap(),
            "The brown anole (Anolis sagrei) is a lizard native to Cuba and the Bahamas. \
             It has been widely introduced elsewhere, e.g. by the pet trade, & is now found in Florida."
        );
        assert_eq!(strip_html("a &lt;b&gt; &#39;c&#39;&nbsp;d  \n e &unknown; f"), "a <b> 'c' d e &unknown; f");
        assert_eq!(first_sentences("One sentence only", 2), "One sentence only");
        assert_eq!(first_sentences("Pterois sp. is a genus. It stings! Really? Yes.", 2), "Pterois sp. is a genus. It stings!");
        assert_eq!(plain_summary("<p></p>"), None);
        assert_eq!(iconic_group(Some("Reptilia")), "Reptilia");
        assert_eq!(iconic_group(Some("plantae")), "Plantae");
        assert_eq!(iconic_group(Some("Animalia")), "other");
        assert_eq!(iconic_group(None), "other");
    }

    #[test]
    fn taxon_info_parses_a_recorded_taxa_page() {
        let infos = parse_page(&fixture()).unwrap();
        assert_eq!(infos.len(), 20);
        let anole = infos.iter().find(|t| t.id == 116461).unwrap();
        assert_eq!(anole.preferred_common_name.as_deref(), Some("Brown Anole"));
        assert_eq!(anole.iconic_taxon_name.as_deref(), Some("Reptilia"));
        assert_eq!(anole.photo_url().unwrap(), "https://inaturalist-open-data.s3.amazonaws.com/photos/22869683/medium.jpg");
        assert_eq!(anole.wikipedia_url().unwrap(), "https://en.wikipedia.org/wiki/Anolis_sagrei");
        let summary = anole.summary_plain().unwrap();
        assert!(summary.starts_with("The brown anole (Anolis sagrei), also known as"), "{summary}");
        assert!(!summary.contains('<'), "{summary}");
        assert!(summary.matches(". ").count() <= 1, "more than two sentences: {summary}");
        assert_eq!(batch_url(&[1, 2, 3]), "https://api.inaturalist.org/v1/taxa/1,2,3");
        assert!(BATCH <= 30);
        assert!(REQUEST_INTERVAL >= Duration::from_secs(1));
    }

    #[tokio::test]
    async fn taxon_info_apply_fills_rows_by_inat_id_and_marks_them_fetched() {
        let state = test_state();
        state
            .obs
            .write(|tx| {
                tx.execute(
                    "insert into taxa (scientific_name, common_name, focus, inat_taxon_id, iconic_group) values ('Anolis sagrei', '', 0, 116461, 'Reptilia')",
                    [],
                )?;
                tx.execute("insert into taxa (scientific_name, common_name, focus) values ('Unknownus nobodyi', 'Nobody', 0)", [])
            })
            .await
            .unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        // Never-fetched taxa with an iNat id are pending: the four seeded focus rows plus the anole.
        let pending = pending_ids(&state, now).await.unwrap();
        assert_eq!(pending, vec![35342, 47284, 116461, 238252, 318758]);

        let n = apply_page(&state, &fixture()).await.unwrap();
        assert_eq!(n, 5, "rows matched by inat_taxon_id");
        let (common, group, summary, photo, wiki, fetched): (String, String, String, String, String, i64) = state
            .obs
            .read(|c| {
                c.query_row(
                    "select common_name, iconic_group, summary_plain, photo_url, wikipedia_url, fetched_at from taxa where inat_taxon_id = 116461",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
                )
            })
            .await
            .unwrap();
        assert_eq!(common, "Brown Anole", "an empty common name is filled");
        assert_eq!(group, "Reptilia");
        assert!(summary.starts_with("The brown anole"), "{summary}");
        assert!(photo.ends_with("/medium.jpg"));
        assert_eq!(wiki, "https://en.wikipedia.org/wiki/Anolis_sagrei");
        assert!(fetched >= now);
        // The seeded focus name is kept over iNat's capitalised one; the lionfish row gets a photo too.
        let (python, lionfish_photo): (String, Option<String>) = state
            .obs
            .read(|c| {
                Ok((
                    c.query_row("select common_name from taxa where id = 1", [], |r| r.get(0))?,
                    c.query_row("select photo_url from taxa where id = 4", [], |r| r.get(0))?,
                ))
            })
            .await
            .unwrap();
        assert_eq!(python, "Burmese python");
        assert!(lionfish_photo.is_some());
        // Nothing left to fetch until REFRESH passes; then everything is due again.
        assert!(pending_ids(&state, now).await.unwrap().is_empty());
        assert_eq!(pending_ids(&state, fetched + REFRESH.as_millis() as i64 + 1).await.unwrap().len(), 5);
    }

    #[tokio::test]
    async fn taxon_info_backfills_ids_from_the_archived_inat_payload() {
        use crate::ingest::poll::inat::tests::{fixture as inat_fixture, payload};
        use crate::ingest::scheduler::ingest_payload;

        let state = test_state();
        let src = crate::ingest::poll::inat::Inat::new();
        let out = ingest_payload(&state, &src, payload("https://api.inaturalist.org/v1/observations?introduced=true", inat_fixture("inat/introduced-p1.json")), None)
            .await
            .unwrap();
        assert!(out.rows_written > 0);
        // Simulate rows written before T44: strip the ids the adapter just stored.
        state
            .obs
            .write(|tx| tx.execute("update taxa set inat_taxon_id = null, iconic_group = null where focus = 0", []))
            .await
            .unwrap();
        let missing: i64 = state
            .obs
            .read(|c| c.query_row("select count(*) from taxa where focus = 0 and inat_taxon_id is null", [], |r| r.get(0)))
            .await
            .unwrap();
        assert!(missing > 0);
        let updated = backfill_ids_from_archive(&state).await.unwrap();
        assert_eq!(updated as i64, missing);
        let (agama_id, agama_group): (i64, String) = state
            .obs
            .read(|c| {
                c.query_row("select inat_taxon_id, iconic_group from taxa where scientific_name = 'Agama picticauda'", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
            })
            .await
            .unwrap();
        assert_eq!((agama_id, agama_group.as_str()), (797597, "Reptilia"));
        let plants: i64 = state
            .obs
            .read(|c| c.query_row("select count(*) from taxa where iconic_group = 'Plantae'", [], |r| r.get(0)))
            .await
            .unwrap();
        assert!(plants > 0, "plants in the introduced fixture are grouped as Plantae");
        // A second pass finds nothing to do.
        assert_eq!(backfill_ids_from_archive(&state).await.unwrap(), 0);
    }
}
