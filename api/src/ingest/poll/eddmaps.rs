//! EDDMapS (Bugwood, University of Georgia) occurrence poller: the Early Detection and Distribution Mapping
//! System behind Florida's IveGot1 app. Its public REST API needs no key:
//!
//! `GET https://api.bugwood.org/rest/api/occurrence?scientificName=<name>&length=<n>` answers a DataTables-style
//! document, `{"columns": [...], "data": [[...], ...]}`, one row per verified report. Reports arrive the day they are
//! entered (measured 2026-10-03: Burmese python reports observed and entered on 2026-10-02), so this is the freshest
//! python source we have; iNaturalist's newest record was days older. The set is small (41 Burmese python records),
//! so one request covers it.
//!
//! The feed's `params.scientificNames` lists the names to ask for (`Python molurus`: EDDMapS files the Burmese python
//! as `Python molurus ssp. bivittatus`). `Observationdate` is local time (Eastern in Florida) and `dateentered` UTC.
//! Records are verified by EDDMapS reviewers, so they are stored as curated, like NAS. No duplicate linking against
//! iNaturalist is done: EDDMapS re-publishes some of the same reports.
//!
//! Terms of use were not readable when this was written (the developer pages are geo-blocked from some networks):
//! the API is open and unauthenticated, and we poll it politely (one request per half hour).

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::NaiveDateTime;
use serde_json::Value;

use super::bio::{self, Pacer};
use crate::app::config::App;
use crate::ingest::source::{FetchCtx, Mode, RawPayload, Source, SourceInfo};
use crate::model::{Quality, Row, SightingRow};

pub const ID: &str = "eddmaps";
pub const API: &str = "https://api.bugwood.org/rest/api/occurrence";
pub const CADENCE: Duration = Duration::from_secs(30 * 60);
const LENGTH: usize = 1000;

pub struct Eddmaps {
    app: Arc<App>,
    pacer: Arc<Pacer>,
}

impl Eddmaps {
    pub fn new(app: Arc<App>) -> Self {
        Eddmaps { app, pacer: Pacer::shared(ID, Duration::from_secs(1)) }
    }
}

/// `params.scientificNames`, or the app's taxa names.
pub fn names(app: &App) -> Vec<String> {
    let listed: Vec<String> = app
        .cfg
        .feed(ID)
        .and_then(|f| f.params.get("scientificNames"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if listed.is_empty() {
        app.taxa.iter().map(|t| t.cfg.scientific_name.clone()).collect()
    } else {
        listed
    }
}

pub fn url(name: &str) -> String {
    format!("{API}?scientificName={}&length={LENGTH}", bio::encode(name))
}

#[async_trait]
impl Source for Eddmaps {
    fn info(&self) -> SourceInfo {
        SourceInfo {
            id: ID,
            name: "EDDMapS (IveGot1)",
            homepage: "https://www.eddmaps.org",
            mode: Mode::Poll,
            cadence: CADENCE,
            max_latency: Duration::from_secs(7 * 24 * 3600),
        }
    }

    fn min_interval(&self) -> Duration {
        CADENCE
    }

    async fn fetch(&self, ctx: &FetchCtx<'_>) -> anyhow::Result<Vec<RawPayload>> {
        let mut out = Vec::new();
        for name in names(&self.app) {
            out.push(bio::get_page(ctx.state, &self.pacer, &url(&name)).await?);
        }
        Ok(out)
    }

    fn normalize(&self, raw: &RawPayload) -> anyhow::Result<Vec<Row>> {
        normalize(&raw.bytes, &self.app)
    }
}

/// The genus and species of an EDDMapS scientific name: `Python molurus ssp. bivittatus` is `Python bivittatus`.
fn genus_species(name: &str) -> Option<(String, String)> {
    let words: Vec<&str> = name.split_whitespace().collect();
    let genus = words.first()?;
    let species = match words.iter().position(|w| w.trim_end_matches('.') == "ssp") {
        Some(i) => words.get(i + 1)?,
        None => words.get(1)?,
    };
    Some(((*genus).to_string(), (*species).to_string()))
}

fn number(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
}

fn local_time(s: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(s.get(..19)?, "%Y-%m-%dT%H:%M:%S").ok()
}

/// Pure: one answer to rows, the app's regions and species only.
pub fn normalize(bytes: &[u8], app: &App) -> anyhow::Result<Vec<Row>> {
    let doc: Value = serde_json::from_slice(bytes)?;
    let columns: Vec<String> = doc["columns"].as_array().map(|c| c.iter().filter_map(|v| v.as_str().map(str::to_lowercase)).collect()).unwrap_or_default();
    let at = |name: &str| columns.iter().position(|c| c == name);
    let (Some(i_id), Some(i_lat), Some(i_lon), Some(i_name), Some(i_obs)) = (at("objectid"), at("latitude"), at("longitude"), at("scientificname"), at("observationdate")) else {
        anyhow::bail!("eddmaps: unexpected columns {columns:?}");
    };
    let i_entered = at("dateentered");
    let mut rows = Vec::new();
    for r in doc["data"].as_array().into_iter().flatten() {
        let (Some(id), Some(lat), Some(lon)) = (r[i_id].as_i64(), number(&r[i_lat]), number(&r[i_lon])) else { continue };
        if !bio::in_region(app, lat, lon) {
            continue;
        }
        let Some((genus, species)) = r[i_name].as_str().and_then(genus_species) else { continue };
        let Some(taxon) = bio::taxon_for_nas(app, &genus, &species) else { continue };
        let Some(observed) = r[i_obs].as_str().and_then(local_time) else { continue };
        let submitted_at = i_entered.and_then(|i| r[i].as_str()).and_then(local_time).map(|t| t.and_utc().timestamp_millis());
        rows.push(Row::Sighting(SightingRow {
            ext_id: id.to_string(),
            taxon: taxon.taxon_ref(),
            lat,
            lon,
            accuracy_m: None,
            observed_at: bio::eastern_to_ms(observed),
            submitted_at,
            quality: Quality::Curated,
            photo_url: None,
        }));
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::poll::bio::testing::{lionfish, python};
    use serde_json::json;

    const COLUMNS: [&str; 13] = ["objectid", "reporterid", "latitude", "longitude", "countyfips", "taxonid", "taxonsystem", "scientificname", "hostsystem", "hostid", "hostscientificname", "Observationdate", "dateentered"];

    fn page() -> Vec<u8> {
        let row = |id: i64, lat: &str, lon: &str, name: &str, obs: &str| json!([id, 1, lat, lon, "12021", 20461, "Bugwood", name, "Bugwood", "", "", obs, "2026-10-02T12:45:36.817"]);
        serde_json::to_vec(&json!({ "columns": COLUMNS, "recordsFiltered": 4, "data": [
            row(14153443, "  26.10944", " -81.67440", "Python molurus ssp. bivittatus", "2026-10-02T08:24:00"),
            // Outside south Florida (Georgia).
            row(2, "  32.1", " -82.5", "Python molurus ssp. bivittatus", "2026-10-02T08:24:00"),
            // Another species.
            row(3, "  26.1", " -81.6", "Boa constrictor", "2026-10-02T08:24:00"),
            // No usable date.
            row(4, "  26.1", " -81.6", "Python molurus ssp. bivittatus", ""),
        ]}))
        .unwrap()
    }

    #[test]
    fn names_and_species_are_read_from_the_ssp_form() {
        assert_eq!(genus_species("Python molurus ssp. bivittatus"), Some(("Python".into(), "bivittatus".into())));
        assert_eq!(genus_species("Pterois volitans"), Some(("Pterois".into(), "volitans".into())));
        assert_eq!(genus_species("Python"), None);
    }

    #[test]
    fn normalize_keeps_dated_burmese_pythons_in_the_region() {
        let rows = normalize(&page(), &python()).unwrap();
        assert_eq!(rows.len(), 1);
        let Row::Sighting(s) = &rows[0] else { panic!("sighting") };
        assert_eq!((s.ext_id.as_str(), s.taxon.scientific_name.as_str(), s.quality), ("14153443", "Python bivittatus", Quality::Curated));
        assert_eq!((s.lat, s.lon), (26.10944, -81.6744));
        assert_eq!(s.observed_at, bio::parse_time_ms("2026-10-02T08:24:00-04:00").unwrap());
        assert_eq!(s.submitted_at, bio::parse_time_ms("2026-10-02T12:45:36Z"));
        // Lionfish Watch has no such taxon: nothing is kept.
        assert!(normalize(&page(), &lionfish()).unwrap().is_empty());
    }

    #[test]
    fn unexpected_columns_are_an_error() {
        assert!(normalize(br#"{"columns":["a"],"data":[]}"#, &python()).is_err());
    }

    #[test]
    fn the_request_names_the_species_and_asks_for_one_page() {
        assert_eq!(url("Python molurus"), "https://api.bugwood.org/rest/api/occurrence?scientificName=Python%20molurus&length=1000");
    }
}
