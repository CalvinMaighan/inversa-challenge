//! Publisher web pages for evidence records (PLAN.md C19): `Evidence.sourcePageUrl`, the human page a
//! user opens in a new tab. `sourceUrl` stays the API URL the poller fetched.
//!
//! | source | page |
//! |---|---|
//! | `inat` | `https://www.inaturalist.org/observations/<id>` |
//! | `gbif` | `https://www.gbif.org/occurrence/<gbifKey>` (last part of `<datasetKey>:<catalogNumber>:<gbifKey>`) |
//! | `nas` | `https://nas.er.usgs.gov/queries/SpecimenViewer.aspx?SpecimenID=<key>` |
//! | `usgs` | `https://waterdata.usgs.gov/monitoring-location/USGS-<site>/` (`<site>` or `<site>:<methodID>`) |
//! | `ndbc` | `https://www.ndbc.noaa.gov/station_page.php?station=<id>` |
//! | `coops` | `https://tidesandcurrents.noaa.gov/stationhome.html?id=<id>` |
//! | `nws`, `nwws` VTEC event | the Iowa Environmental Mesonet VTEC event page |
//! | `nws` CAP message | `https://api.weather.gov/alerts/<urn:oid:…>` |
//!
//! NWS publishes no web page per alert (alerts.weather.gov does not resolve), so a CAP-keyed alert links
//! its CAP id URL. VTEC-keyed rows carry no CAP id (the key outlives every CAP update), and IEM's VTEC
//! browser is the permanent public page for one VTEC event, with every product text issued for it.
//!
//! Null: Open-Meteo grid points (modelled), GOES cells, web-hook sightings, NWWS products without VTEC
//! (their id is an NWWS-OI sequence number, not a public one), and kinds with no row at a publisher
//! (hotspot, fetch, backtest).
//!
//! Ids are checked against a strict character set before they go into a URL, so a malformed `ext_id`
//! yields no link rather than an odd one.

/// Every host a page URL may point at, with the publisher name the UI shows ("Open at <name>").
/// `apps/web/shared/source-pages.ts` mirrors this list; a web test keeps the two equal.
pub const PUBLISHERS: &[(&str, &str)] = &[
    ("www.inaturalist.org", "iNaturalist"),
    ("www.gbif.org", "GBIF"),
    ("nas.er.usgs.gov", "USGS NAS"),
    ("waterdata.usgs.gov", "USGS Water Data"),
    ("www.ndbc.noaa.gov", "NOAA NDBC"),
    ("tidesandcurrents.noaa.gov", "NOAA Tides & Currents"),
    ("api.weather.gov", "NWS"),
    ("mesonet.agron.iastate.edu", "IEM VTEC browser"),
];

fn all(s: &str, ok: impl Fn(char) -> bool, max: usize) -> Option<&str> {
    (!s.is_empty() && s.len() <= max && s.chars().all(ok)).then_some(s)
}

fn digits(s: &str) -> Option<&str> {
    all(s, |c| c.is_ascii_digit(), 20)
}

fn alnum(s: &str) -> Option<&str> {
    all(s, |c| c.is_ascii_alphanumeric(), 12)
}

/// The publisher page for a row of `source` with `ext_id` (sightings, stations and alerts share the
/// source namespace), or `None` when the publisher has none.
pub fn source_page_url(source: &str, ext_id: &str) -> Option<String> {
    // Whatever a pattern builds, only https URLs on the allowlist leave this function.
    page_for(source, ext_id).filter(|url| publisher(url).is_some())
}

fn page_for(source: &str, ext_id: &str) -> Option<String> {
    Some(match source {
        "inat" => format!("https://www.inaturalist.org/observations/{}", digits(ext_id)?),
        "gbif" => format!("https://www.gbif.org/occurrence/{}", digits(ext_id.rsplit(':').next()?)?),
        "nas" => format!("https://nas.er.usgs.gov/queries/SpecimenViewer.aspx?SpecimenID={}", digits(ext_id)?),
        "usgs" => {
            format!("https://waterdata.usgs.gov/monitoring-location/USGS-{}/", digits(ext_id.split(':').next()?)?)
        }
        "ndbc" => format!("https://www.ndbc.noaa.gov/station_page.php?station={}", alnum(ext_id)?.to_ascii_lowercase()),
        "coops" => format!("https://tidesandcurrents.noaa.gov/stationhome.html?id={}", digits(ext_id)?),
        "nws" | "nwws" => alert_page(ext_id)?,
        _ => return None,
    })
}

/// `vtec:<office>.<phen>.<sig>.<etn>.<year>:<zones>` (`poll::nws::vtec_ext_id`) or a CAP `urn:oid:` id.
fn alert_page(ext_id: &str) -> Option<String> {
    if let Some(rest) = ext_id.strip_prefix("vtec:") {
        let event = rest.split(':').next()?;
        let parts: Vec<&str> = event.split('.').collect();
        let [office, phen, sig, etn, year] = parts.as_slice() else { return None };
        let letters = |s: &str, n: usize| s.len() == n && s.chars().all(|c| c.is_ascii_alphabetic());
        if !(letters(office, 4) && letters(phen, 2) && letters(sig, 1) && etn.len() <= 4 && year.len() == 4) {
            return None;
        }
        let (etn, year) = (digits(etn)?, digits(year)?);
        return Some(format!(
            "https://mesonet.agron.iastate.edu/vtec/?wfo={office}&phenomena={phen}&significance={sig}&eventid={etn:0>4}&year={year}"
        ));
    }
    let oid = ext_id.strip_prefix("urn:oid:")?;
    all(oid, |c| c.is_ascii_hexdigit() || c == '.', 120)?;
    Some(format!("https://api.weather.gov/alerts/{ext_id}"))
}

/// The publisher name for a page URL on an allowlisted https host.
pub fn publisher(url: &str) -> Option<&'static str> {
    let rest = url.strip_prefix("https://")?;
    let host = rest.split(['/', '?', '#']).next()?;
    PUBLISHERS.iter().find(|(h, _)| *h == host).map(|(_, name)| *name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::poll::{coops, gbif, inat, nas, ndbc, nws, openmeteo, usgs};
    use crate::model::Row;

    fn fixture(rel: &str) -> Vec<u8> {
        let path = format!("{}/fixtures/{rel}", env!("CARGO_MANIFEST_DIR"));
        std::fs::read(&path).unwrap_or_else(|e| panic!("fixture {path}: {e}"))
    }

    fn sighting_ids(rows: Vec<Row>) -> Vec<String> {
        rows.into_iter()
            .filter_map(|r| match r {
                Row::Sighting(s) => Some(s.ext_id),
                _ => None,
            })
            .collect()
    }

    fn station_ids(rows: Vec<Row>) -> Vec<String> {
        let mut ids: Vec<String> = rows
            .into_iter()
            .filter_map(|r| match r {
                Row::Reading(r) => Some(r.station.ext_id),
                Row::Station(s) => Some(s.ext_id),
                _ => None,
            })
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }

    fn alert_ids(rows: Vec<Row>) -> Vec<String> {
        rows.into_iter()
            .filter_map(|r| match r {
                Row::Alert(a) => Some(a.ext_id),
                _ => None,
            })
            .collect()
    }

    /// One fixture record per source, the URL it maps to, and every row of that fixture mapping to a page.
    /// Shared with the live link check below.
    pub(super) fn fixture_links() -> Vec<(&'static str, String, String)> {
        let inat = sighting_ids(inat::normalize(&fixture("inat/focus-p1.json")).unwrap());
        let gbif = sighting_ids(gbif::normalize(&fixture("gbif/modified-p1.json")).unwrap());
        let nas = sighting_ids(nas::normalize(&fixture("nas/python-2026-p1.json")).unwrap());
        let usgs = station_ids(usgs::normalize_iv(&fixture("usgs/iv.json"), 0).unwrap());
        let ndbc_st = ndbc::station("KYWF1").unwrap();
        let ndbc = station_ids(ndbc::normalize_txt(ndbc_st, &fixture("ndbc/KYWF1.txt"), 1_790_800_000_000).unwrap());
        let coops = station_ids(coops::normalize_product("8723214", "water_level", &fixture("coops/8723214.water_level.json")).unwrap());
        let alerts = alert_ids(nws::normalize_alerts(&fixture("nws/alerts_active_fl_am_gm.json")).unwrap());
        let vtec = alerts.iter().find(|a| a.starts_with("vtec:KKEY.SC.Y.0019")).unwrap().clone();
        let cap = alerts.iter().find(|a| a.starts_with("urn:oid:")).unwrap().clone();
        let method = usgs.iter().find(|s| s.contains(':')).unwrap().clone();
        [
            ("inat", inat[0].clone()),
            ("gbif", gbif[0].clone()),
            ("nas", nas[0].clone()),
            ("usgs", usgs[0].clone()),
            ("usgs", method),
            ("ndbc", ndbc[0].clone()),
            ("coops", coops[0].clone()),
            ("nws", vtec),
            ("nws", cap),
        ]
        .into_iter()
        .map(|(source, ext)| {
            let url = source_page_url(source, &ext).unwrap_or_else(|| panic!("{source} {ext}: no page"));
            (source, ext, url)
        })
        .collect()
    }

    #[test]
    fn source_page_url_inat_observation() {
        let ids = sighting_ids(inat::normalize(&fixture("inat/focus-p1.json")).unwrap());
        assert_eq!(ids[0], "335508189");
        assert_eq!(source_page_url("inat", &ids[0]).as_deref(), Some("https://www.inaturalist.org/observations/335508189"));
        assert!(ids.iter().all(|id| source_page_url("inat", id).is_some()));
    }

    #[test]
    fn source_page_url_gbif_occurrence_from_composite_ext_id() {
        let ids = sighting_ids(gbif::normalize(&fixture("gbif/modified-p1.json")).unwrap());
        let mirror = ids.iter().find(|id| id.ends_with(":6130701656")).unwrap();
        assert_eq!(mirror, "50c9509d-22c7-4a22-a47d-8c48425ef4a7:335508189:6130701656");
        assert_eq!(source_page_url("gbif", mirror).as_deref(), Some("https://www.gbif.org/occurrence/6130701656"));
        // Catalog numbers with spaces or colons do not matter: the key is the last part.
        assert_eq!(source_page_url("gbif", "x:UF 1:3:42").as_deref(), Some("https://www.gbif.org/occurrence/42"));
        assert!(ids.iter().all(|id| source_page_url("gbif", id).is_some()));
    }

    #[test]
    fn source_page_url_nas_specimen_viewer() {
        let ids = sighting_ids(nas::normalize(&fixture("nas/python-2026-p1.json")).unwrap());
        assert_eq!(ids[0], "1936189");
        assert_eq!(
            source_page_url("nas", &ids[0]).as_deref(),
            Some("https://nas.er.usgs.gov/queries/SpecimenViewer.aspx?SpecimenID=1936189")
        );
    }

    #[test]
    fn source_page_url_usgs_site_and_site_method() {
        let ids = station_ids(usgs::normalize_iv(&fixture("usgs/iv.json"), 0).unwrap());
        assert!(ids.contains(&"02281200".to_string()), "{ids:?}");
        let page = "https://waterdata.usgs.gov/monitoring-location/USGS-02281200/";
        assert_eq!(source_page_url("usgs", "02281200").as_deref(), Some(page));
        let method = ids.iter().find(|s| s.contains(':')).expect("a site:methodID station in the fixture");
        let site = method.split(':').next().unwrap();
        assert_eq!(
            source_page_url("usgs", method),
            Some(format!("https://waterdata.usgs.gov/monitoring-location/USGS-{site}/"))
        );
        assert!(ids.iter().all(|id| source_page_url("usgs", id).is_some()));
    }

    #[test]
    fn source_page_url_ndbc_station_page() {
        let st = ndbc::station("KYWF1").unwrap();
        let ids = station_ids(ndbc::normalize_txt(st, &fixture("ndbc/KYWF1.txt"), 1_790_800_000_000).unwrap());
        assert_eq!(ids, ["KYWF1"]);
        assert_eq!(
            source_page_url("ndbc", "KYWF1").as_deref(),
            Some("https://www.ndbc.noaa.gov/station_page.php?station=kywf1")
        );
        assert_eq!(source_page_url("ndbc", "41122").as_deref(), Some("https://www.ndbc.noaa.gov/station_page.php?station=41122"));
    }

    #[test]
    fn source_page_url_coops_station_home() {
        let ids = station_ids(
            coops::normalize_product("8723214", "water_level", &fixture("coops/8723214.water_level.json")).unwrap(),
        );
        assert_eq!(ids, ["8723214"]);
        assert_eq!(
            source_page_url("coops", "8723214").as_deref(),
            Some("https://tidesandcurrents.noaa.gov/stationhome.html?id=8723214")
        );
    }

    #[test]
    fn source_page_url_nws_vtec_event_and_cap_id() {
        let ids = alert_ids(nws::normalize_alerts(&fixture("nws/alerts_active_fl_am_gm.json")).unwrap());
        let sca = ids.iter().find(|a| a.starts_with("vtec:KKEY.SC.Y.0019")).unwrap();
        assert_eq!(
            source_page_url("nws", sca).as_deref(),
            Some("https://mesonet.agron.iastate.edu/vtec/?wfo=KKEY&phenomena=SC&significance=Y&eventid=0019&year=2026")
        );
        let mws = ids.iter().find(|a| a.starts_with("urn:oid:2.49.0.1.840.0.f0378ab3")).unwrap();
        assert_eq!(source_page_url("nws", mws), Some(format!("https://api.weather.gov/alerts/{mws}")));
        // Every alert in the fixture has a page.
        assert!(ids.iter().all(|id| source_page_url("nws", id).is_some()), "{ids:?}");
        // NWWS shares the VTEC key; its non-VTEC segments carry only an NWWS-OI sequence number.
        assert_eq!(source_page_url("nwws", sca), source_page_url("nws", sca));
        assert_eq!(source_page_url("nwws", "nwws:11723.44102:0"), None);
    }

    #[test]
    fn source_page_url_null_for_modelled_grid_goes_and_hooks() {
        use crate::ingest::poll::physical::testing::{fixture_str, recorded};
        let url = fixture_str("openmeteo/forecast.url");
        let raw = recorded(url.trim(), "application/json", fixture("openmeteo/forecast.json"), 200, 1_790_800_000_000);
        let grid = station_ids(openmeteo::normalize_payload(&raw).unwrap());
        assert!(!grid.is_empty());
        assert!(grid.iter().all(|id| source_page_url("openmeteo", id).is_none()));
        assert_eq!(source_page_url("goes19", "g5:1234"), None);
        assert_eq!(source_page_url("web", "web-1"), None);
    }

    #[test]
    fn source_page_url_rejects_malformed_ids() {
        for (source, ext) in [
            ("inat", ""),
            ("inat", "12 34"),
            ("inat", "1?x=<script>"),
            ("gbif", "a:b:"),
            ("gbif", "a:b:../x"),
            ("nas", "1936189&x=1"),
            ("usgs", "abc"),
            ("ndbc", "kywf1/../"),
            ("coops", "872 3214"),
            ("nws", "vtec:KKEY.SC.Y"),
            ("nws", "vtec:KKEY.SC.Y.0019.20x6:FLZ1"),
            ("nws", "vtec:K&EY.SC.Y.0019.2026:FLZ1"),
            ("nws", "urn:oid:2.49/../x"),
            ("nws", "urn:1"),
        ] {
            assert_eq!(source_page_url(source, ext), None, "{source} {ext:?}");
        }
    }

    #[test]
    fn source_page_url_hosts_allowlisted() {
        let links = fixture_links();
        assert_eq!(links.len(), 9);
        let mut hosts = std::collections::BTreeSet::new();
        for (source, ext, url) in &links {
            assert!(url.starts_with("https://"), "{source} {ext}: {url}");
            assert!(publisher(url).is_some(), "{source} {ext}: {url} is not on the allowlist");
            hosts.insert(url.trim_start_matches("https://").split(['/', '?']).next().unwrap().to_string());
        }
        // Every allowlisted host is used by some source, so the list carries no stale entries.
        let listed: std::collections::BTreeSet<String> = PUBLISHERS.iter().map(|(h, _)| h.to_string()).collect();
        assert_eq!(hosts, listed);
        assert_eq!(publisher("http://www.gbif.org/occurrence/1"), None);
        assert_eq!(publisher("https://www.gbif.org.evil.test/occurrence/1"), None);
        assert_eq!(publisher("https://evil.test/?https://www.gbif.org/"), None);
        assert_eq!(publisher("https://www.inaturalist.org/observations/1"), Some("iNaturalist"));
    }

    /// G4: fetch one generated page per source from the publisher. Network; run with
    /// `cargo test --manifest-path api/Cargo.toml source_page_url_live -- --ignored --nocapture`.
    /// Cloudflare-fronted publishers (iNaturalist, GBIF) answer non-browser clients with a JS challenge
    /// (HTTP 403, `cf-mitigated: challenge`); those count as `blocked`, and the record is confirmed
    /// through the publisher's API instead.
    #[tokio::test]
    #[ignore]
    async fn source_page_url_live_links_resolve() {
        let client = reqwest::Client::builder()
            .user_agent("inversa-everglades-ops link check (+https://github.com/calvinmaighan)")
            .timeout(std::time::Duration::from_secs(40))
            .build()
            .unwrap();
        let (mut ok, mut fail, mut blocked) = (0, 0, 0);
        for (source, ext, url) in fixture_links() {
            let res = client.get(&url).header("accept", "text/html").send().await;
            let (status, challenged) = match &res {
                Ok(r) => (r.status().as_u16(), r.headers().get("cf-mitigated").is_some_and(|v| v == "challenge")),
                Err(e) => {
                    println!("FAIL {source:<6} {url} ({e})");
                    fail += 1;
                    continue;
                }
            };
            if status < 400 {
                ok += 1;
                println!("ok   {source:<6} {status} {url}");
            } else if challenged {
                let api = match source {
                    "inat" => format!("https://api.inaturalist.org/v1/observations/{ext}"),
                    "gbif" => format!("https://api.gbif.org/v1/occurrence/{}", ext.rsplit(':').next().unwrap()),
                    _ => String::new(),
                };
                let api_status = match api.is_empty() {
                    true => 0,
                    false => client.get(&api).send().await.map(|r| r.status().as_u16()).unwrap_or(0),
                };
                if (200..300).contains(&api_status) {
                    blocked += 1;
                    println!("blk  {source:<6} {status} {url} (Cloudflare challenge; record {api} -> {api_status})");
                } else {
                    fail += 1;
                    println!("FAIL {source:<6} {status} {url} (challenge; api {api_status})");
                }
            } else {
                fail += 1;
                println!("FAIL {source:<6} {status} {url}");
            }
        }
        println!("LINKS ok={ok} fail={fail} blocked={blocked}");
        assert_eq!(fail, 0);
    }
}
