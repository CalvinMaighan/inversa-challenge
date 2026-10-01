//! Dedupe and revisions for sightings (T9, PRD §7 "Data quality"). Runs inside the write
//! transaction of every payload whose rows changed.
//!
//! - **GBIF mirror of iNat:** a GBIF row from the iNat research-grade dataset whose
//!   `catalogNumber` equals an iNat `ext_id` gets `canonical_id` = that iNat sighting. The GBIF
//!   `ext_id` is `<datasetKey>:<catalogNumber>:<gbifKey>` (see `poll::gbif`), so both directions
//!   are index lookups: GBIF row to iNat by parsed catalog number, iNat row to GBIF by prefix
//!   range on the unique `(source_id, ext_id)` index.
//! - **NAS spatial-temporal:** a NAS row within [`NAS_RADIUS_M`] and [`NAS_WINDOW_MS`] of a
//!   same-taxon sighting from another source gets `canonical_id` = the earliest such sighting
//!   (by `observed_at`, then id), resolved to its own canonical when it has one.
//! - **Conflicts:** a sighting with a `taxon` revision (an iNat ID flip) gets `conflict = 1`.
//!   The flag stays set once the ID settles: the revision history is the record of the dispute.
//!
//! Work is limited to the rows this payload wrote: the source's rows carrying the payload's
//! raw object (the scheduler records the payload's `fetch_runs` row, with its
//! `raw_object_id`, before calling this hook in the same transaction). An iNat page can touch
//! observations from any year, so a pass over the whole `observed_at` window would rescan most
//! of the table on every poll. Each pass runs from whichever side was just written, so links
//! form in either arrival order. Links are only set or corrected, never cleared.

use rusqlite::{params, OptionalExtension, Transaction};

use crate::ingest::poll::gbif;

pub const NAS_RADIUS_M: f64 = 50.0;
pub const NAS_WINDOW_MS: i64 = 24 * 3600 * 1000;

/// A sighting written by the current payload.
struct Touched {
    id: i64,
    ext_id: String,
    taxon_id: i64,
    lat: f64,
    lon: f64,
    at: i64,
}

pub fn post_write(tx: &Transaction, source_id: &str, from_ms: i64, to_ms: i64) -> rusqlite::Result<()> {
    let raw_object_id: Option<i64> = tx
        .prepare_cached("select raw_object_id from fetch_runs where source_id = ?1 order by id desc limit 1")?
        .query_row([source_id], |r| r.get(0))
        .optional()?
        .flatten();
    let Some(raw_object_id) = raw_object_id else { return Ok(()) };
    let touched: Vec<Touched> = tx
        .prepare_cached(
            "select id, ext_id, taxon_id, lat, lon, observed_at from sightings
             where source_id = ?1 and raw_object_id = ?2 and observed_at between ?3 and ?4",
        )?
        .query_map(params![source_id, raw_object_id, from_ms, to_ms], |r| {
            Ok(Touched { id: r.get(0)?, ext_id: r.get(1)?, taxon_id: r.get(2)?, lat: r.get(3)?, lon: r.get(4)?, at: r.get(5)? })
        })?
        .collect::<rusqlite::Result<_>>()?;
    if touched.is_empty() {
        return Ok(());
    }

    match source_id {
        gbif::ID => {
            for t in &touched {
                link_gbif_to_inat(tx, t)?;
            }
        }
        crate::ingest::poll::inat::ID => {
            for t in &touched {
                link_mirrors_of_inat(tx, t)?;
            }
        }
        _ => {}
    }

    if source_id == crate::ingest::poll::nas::ID {
        for t in &touched {
            link_nas(tx, t.id, t.taxon_id, t.lat, t.lon, t.at)?;
        }
    } else {
        // A new or moved sighting may be the match for NAS records already stored.
        for t in &touched {
            for (id, lat, lon, at) in nas_near(tx, t.taxon_id, t.lat, t.lon, t.at)? {
                link_nas(tx, id, t.taxon_id, lat, lon, at)?;
            }
        }
    }
    flatten_nas(tx)?;

    for t in &touched {
        tx.prepare_cached(
            "update sightings set conflict = 1 where id = ?1 and conflict = 0
               and exists (select 1 from sighting_revisions r where r.sighting_id = ?1 and r.field = 'taxon')",
        )?
        .execute([t.id])?;
    }
    Ok(())
}

fn set_canonical(tx: &Transaction, id: i64, canonical: i64) -> rusqlite::Result<()> {
    tx.prepare_cached("update sightings set canonical_id = ?2 where id = ?1 and canonical_id is not ?2")?
        .execute(params![id, canonical])?;
    Ok(())
}

fn link_gbif_to_inat(tx: &Transaction, t: &Touched) -> rusqlite::Result<()> {
    let Some(inat_id) = gbif::mirrored_inat_id(&t.ext_id) else { return Ok(()) };
    let target: Option<i64> = tx
        .prepare_cached("select id from sightings where source_id = 'inat' and ext_id = ?1")?
        .query_row([inat_id], |r| r.get(0))
        .optional()?;
    if let Some(target) = target {
        set_canonical(tx, t.id, target)?;
    }
    Ok(())
}

fn link_mirrors_of_inat(tx: &Transaction, t: &Touched) -> rusqlite::Result<()> {
    let prefix = gbif::inat_mirror_prefix(&t.ext_id);
    // ':' + 1 = ';', so [prefix, prefix-with-';') is exactly the ext_ids starting with prefix.
    let upper = format!("{};", &prefix[..prefix.len() - 1]);
    let mirrors: Vec<i64> = tx
        .prepare_cached(
            "select id from sightings where source_id = 'gbif' and ext_id >= ?1 and ext_id < ?2
               and canonical_id is not ?3",
        )?
        .query_map(params![prefix, upper, t.id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in mirrors {
        set_canonical(tx, id, t.id)?;
    }
    Ok(())
}

/// Great-circle distance in metres (haversine, mean Earth radius).
pub fn distance_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dp = p2 - p1;
    let dl = (lon2 - lon1).to_radians();
    let a = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    2.0 * 6_371_008.8 * a.sqrt().min(1.0).asin()
}

/// Degree half-widths of a box that contains the radius around `lat` (with margin).
fn radius_box(lat: f64) -> (f64, f64) {
    let dlat = NAS_RADIUS_M / 111_000.0 * 1.5;
    (dlat, dlat / lat.to_radians().cos().max(0.1))
}

/// Same-taxon sightings within the radius and window, excluding NAS itself when `nas` is
/// false, as `(id, canonical_id, lat, lon, observed_at)`.
#[allow(clippy::type_complexity)]
fn near(
    tx: &Transaction,
    nas: bool,
    taxon_id: i64,
    lat: f64,
    lon: f64,
    at: i64,
) -> rusqlite::Result<Vec<(i64, Option<i64>, f64, f64, i64)>> {
    let (dlat, dlon) = radius_box(lat);
    let sql = if nas {
        "select id, canonical_id, lat, lon, observed_at from sightings
         where taxon_id = ?1 and observed_at between ?2 and ?3 and source_id = 'nas'
           and lat between ?4 and ?5 and lon between ?6 and ?7"
    } else {
        "select id, canonical_id, lat, lon, observed_at from sightings
         where taxon_id = ?1 and observed_at between ?2 and ?3 and source_id != 'nas'
           and lat between ?4 and ?5 and lon between ?6 and ?7"
    };
    let rows = tx
        .prepare_cached(sql)?
        .query_map(
            params![taxon_id, at - NAS_WINDOW_MS, at + NAS_WINDOW_MS, lat - dlat, lat + dlat, lon - dlon, lon + dlon],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )?
        .collect::<rusqlite::Result<Vec<(i64, Option<i64>, f64, f64, i64)>>>()?;
    Ok(rows.into_iter().filter(|(_, _, clat, clon, _)| distance_m(lat, lon, *clat, *clon) <= NAS_RADIUS_M).collect())
}

/// NAS records a sighting at this place and time could duplicate: `(id, lat, lon, observed_at)`.
fn nas_near(tx: &Transaction, taxon_id: i64, lat: f64, lon: f64, at: i64) -> rusqlite::Result<Vec<(i64, f64, f64, i64)>> {
    Ok(near(tx, true, taxon_id, lat, lon, at)?.into_iter().map(|(id, _, la, lo, t)| (id, la, lo, t)).collect())
}

/// Point NAS record `id` at the earliest other-source sighting in range (its canonical root).
fn link_nas(tx: &Transaction, id: i64, taxon_id: i64, lat: f64, lon: f64, at: i64) -> rusqlite::Result<()> {
    let best = near(tx, false, taxon_id, lat, lon, at)?.into_iter().min_by_key(|(cid, _, _, _, cat)| (*cat, *cid));
    if let Some((cid, canonical, ..)) = best {
        set_canonical(tx, id, canonical.unwrap_or(cid))?;
    }
    Ok(())
}

/// A NAS record may point at a GBIF row that was later linked to iNat; re-point it at the root.
/// Only NAS links can go stale this way: GBIF links always point at iNat rows, which are roots.
fn flatten_nas(tx: &Transaction) -> rusqlite::Result<()> {
    tx.prepare_cached(
        "update sightings set canonical_id = (select c.canonical_id from sightings c where c.id = sightings.canonical_id)
         where source_id = 'nas' and canonical_id in (select id from sightings where canonical_id is not null)",
    )?
    .execute([])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::app::test_support::test_state;
    use crate::ingest::poll::inat::tests::{fixture, payload};
    use crate::ingest::poll::{gbif::Gbif, inat::Inat, nas::Nas};
    use crate::ingest::scheduler::ingest_payload;
    use crate::ingest::source::Source;
    use crate::model::{Quality, Row, SightingRow, TaxonRef};
    use crate::state::AppState;

    const INAT_LIONFISH: &str = "335508189";
    const GBIF_MIRROR: &str = "50c9509d-22c7-4a22-a47d-8c48425ef4a7:335508189:6130701656";
    const NAS_LIONFISH: &str = "1936573";

    async fn ingest(state: &AppState, src: &dyn Source, name: &str) {
        let out = ingest_payload(state, src, payload(&format!("fixture:{name}"), fixture(name)), None).await.unwrap();
        assert!(out.error.is_none(), "{name}: {:?}", out.error);
    }

    /// (source, ext_id) -> (id, canonical_id).
    async fn links(state: &AppState) -> HashMap<(String, String), (i64, Option<i64>)> {
        state
            .obs
            .read(|c| {
                let mut st = c.prepare("select source_id, ext_id, id, canonical_id from sightings")?;
                let rows = st.query_map([], |r| Ok(((r.get(0)?, r.get(1)?), (r.get(2)?, r.get(3)?))))?;
                rows.collect()
            })
            .await
            .unwrap()
    }

    fn get<'a>(l: &'a HashMap<(String, String), (i64, Option<i64>)>, src: &str, ext: &str) -> &'a (i64, Option<i64>) {
        l.get(&(src.to_string(), ext.to_string())).unwrap_or_else(|| panic!("no {src}:{ext}"))
    }

    fn assert_real_links(l: &HashMap<(String, String), (i64, Option<i64>)>) {
        let (inat_id, inat_canon) = *get(l, "inat", INAT_LIONFISH);
        assert_eq!(inat_canon, None, "iNat is the canonical record");
        assert_eq!(get(l, "gbif", GBIF_MIRROR).1, Some(inat_id), "GBIF mirror links to iNat");
        assert_eq!(get(l, "nas", NAS_LIONFISH).1, Some(inat_id), "NAS record links to the earliest (iNat) sighting");
        // 339784054 is in both the iNat and GBIF pages.
        let (obscured_id, _) = *get(l, "inat", "339784054");
        assert_eq!(get(l, "gbif", "50c9509d-22c7-4a22-a47d-8c48425ef4a7:339784054:6162994368").1, Some(obscured_id));
        // Nothing else is linked: 2 GBIF mirrors + 1 NAS record.
        let linked: Vec<_> = l.iter().filter(|(_, (_, c))| c.is_some()).map(|(k, _)| k.clone()).collect();
        assert_eq!(linked.len(), 3, "{linked:?}");
    }

    #[tokio::test]
    async fn quality_bio_links_real_fixtures_inat_first() {
        let state = test_state();
        ingest(&state, &Inat::new(state.app.clone()), "inat/focus-p1.json").await;
        ingest(&state, &Gbif::new(state.app.clone()), "gbif/modified-p1.json").await;
        ingest(&state, &Nas::new(state.app.clone()), "nas/pterois-2026-p1.json").await;
        ingest(&state, &Nas::new(state.app.clone()), "nas/python-2026-p1.json").await;
        assert_real_links(&links(&state).await);
    }

    #[tokio::test]
    async fn quality_bio_links_real_fixtures_in_reverse_arrival_order() {
        let state = test_state();
        ingest(&state, &Nas::new(state.app.clone()), "nas/pterois-2026-p1.json").await;
        ingest(&state, &Nas::new(state.app.clone()), "nas/python-2026-p1.json").await;
        ingest(&state, &Gbif::new(state.app.clone()), "gbif/modified-p1.json").await;
        let before = links(&state).await;
        // NAS 1936573 first matches the GBIF mirror (same instant, same point) ...
        assert_eq!(get(&before, "nas", NAS_LIONFISH).1, Some(get(&before, "gbif", GBIF_MIRROR).0));
        ingest(&state, &Inat::new(state.app.clone()), "inat/focus-p1.json").await;
        let l = links(&state).await;
        // ... and moves to the iNat sighting when it arrives: the GBIF mirror now resolves to
        // iNat, and NAS follows the earliest candidate to its canonical root.
        assert_real_links(&l);
    }

    /// Minimal constructed rows for the NAS edges (no real record sits 49 m from another).
    struct RowsSource(&'static str);

    #[async_trait::async_trait]
    impl Source for RowsSource {
        fn info(&self) -> crate::ingest::source::SourceInfo {
            crate::ingest::source::SourceInfo {
                id: self.0,
                name: self.0,
                homepage: "https://example.test",
                mode: crate::ingest::source::Mode::Poll,
                cadence: std::time::Duration::from_secs(60),
                max_latency: std::time::Duration::from_secs(60),
            }
        }
        async fn fetch(&self, _ctx: &crate::ingest::source::FetchCtx<'_>) -> anyhow::Result<Vec<crate::ingest::source::RawPayload>> {
            Ok(vec![])
        }
        fn normalize(&self, raw: &crate::ingest::source::RawPayload) -> anyhow::Result<Vec<Row>> {
            Ok(serde_json::from_slice(&raw.bytes)?)
        }
    }

    fn row(ext: &str, name: &str, lat: f64, lon: f64, at: i64) -> Row {
        Row::Sighting(SightingRow {
            ext_id: ext.into(),
            taxon: TaxonRef::named(name, ""),
            lat,
            lon,
            accuracy_m: None,
            observed_at: at,
            quality: Quality::Curated,
            photo_url: None,
        })
    }

    async fn write(state: &AppState, src: &'static str, rows: Vec<Row>) {
        let raw = payload("test:rows", serde_json::to_vec(&rows).unwrap());
        ingest_payload(state, &RowsSource(src), raw, None).await.unwrap();
    }

    #[tokio::test]
    async fn quality_bio_nas_radius_window_taxon_and_earliest() {
        let state = test_state();
        let t = 1_780_000_000_000i64;
        let m_per_deg_lat = 111_195.0;
        write(
            &state,
            "inat",
            vec![
                row("near-late", "Python bivittatus", 25.5, -80.5, t + 3_600_000),
                row("near-early", "Python bivittatus", 25.5 + 20.0 / m_per_deg_lat, -80.5, t - 3_600_000),
                row("far", "Python bivittatus", 25.6 + 60.0 / m_per_deg_lat, -80.6, t),
                row("late", "Python bivittatus", 25.7, -80.7, t + NAS_WINDOW_MS + 60_000),
                row("other-taxon", "Iguana iguana", 25.8, -80.8, t),
            ],
        )
        .await;
        write(
            &state,
            "nas",
            vec![
                row("n-match", "Python bivittatus", 25.5 + 10.0 / m_per_deg_lat, -80.5, t),
                row("n-far", "Python bivittatus", 25.6, -80.6, t),
                row("n-late", "Python bivittatus", 25.7, -80.7, t),
                row("n-taxon", "Python bivittatus", 25.8, -80.8, t),
                row("n-nas-only", "Python bivittatus", 25.9, -80.9, t),
            ],
        )
        .await;
        // A second NAS record at the same spot is not linked to the first: only other sources count.
        write(&state, "nas", vec![row("n-dup", "Python bivittatus", 25.9, -80.9, t + 60_000)]).await;
        let l = links(&state).await;
        let early = get(&l, "inat", "near-early").0;
        assert_eq!(get(&l, "nas", "n-match").1, Some(early), "two candidates in range: the earliest wins");
        for ext in ["n-far", "n-late", "n-taxon", "n-nas-only", "n-dup"] {
            assert_eq!(get(&l, "nas", ext).1, None, "{ext} must stay unlinked");
        }
        for ext in ["near-late", "near-early", "far", "late", "other-taxon"] {
            assert_eq!(get(&l, "inat", ext).1, None);
        }
        assert!((distance_m(25.5, -80.5, 25.5 + 60.0 / m_per_deg_lat, -80.5) - 60.0).abs() < 0.5);
    }

    #[tokio::test]
    async fn quality_bio_reingest_changes_nothing() {
        let state = test_state();
        ingest(&state, &Inat::new(state.app.clone()), "inat/focus-p1.json").await;
        ingest(&state, &Gbif::new(state.app.clone()), "gbif/modified-p1.json").await;
        ingest(&state, &Nas::new(state.app.clone()), "nas/pterois-2026-p1.json").await;
        let before = links(&state).await;
        for (src, name) in [("gbif", "gbif/modified-p1.json"), ("nas", "nas/pterois-2026-p1.json"), ("inat", "inat/focus-p1.json")] {
            let s: Box<dyn Source> = match src {
                "gbif" => Box::new(Gbif::new(state.app.clone())),
                "nas" => Box::new(Nas::new(state.app.clone())),
                _ => Box::new(Inat::new(state.app.clone())),
            };
            let out = ingest_payload(&state, s.as_ref(), payload(&format!("fixture:{name}"), fixture(name)), None).await.unwrap();
            assert_eq!(out.rows_written, 0, "{name}");
        }
        assert_eq!(links(&state).await, before);
    }
}
