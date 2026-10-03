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
//! | `crw` 5 km cell `<lat>,<lon>` | the PacIOOS ERDDAP table of that cell's SST, anomaly, DHW and BAA for the last 30 days |
//!
//! CRW publishes no page per cell; ERDDAP's `htmlTable` view of the same `dhw_5km` dataset is the
//! human page for one cell's values. Every CRW evidence card also carries [`CRW_CREDIT`]: the products
//! are free to use without restriction, provided NOAA Coral Reef Watch is credited and the DOI cited.
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
    ("pae-paha.pacioos.hawaii.edu", "NOAA Coral Reef Watch (PacIOOS ERDDAP)"),
    ("water.noaa.gov", "NOAA National Water Prediction Service"),
    ("www.vesselfinder.com", "VesselFinder"),
];

/// DOI CRW asks users to cite for the CoralTemp v3.1 5 km product suite (Skirving et al. 2020,
/// Remote Sensing 12, 3856). The dataset's `license` attribute asks for "the appropriate DOI"; the
/// CRW citation page lists this one for the v3.1 suite.
pub const CRW_DOI: &str = "https://doi.org/10.3390/rs12233856";

/// Credit line for every NOAA Coral Reef Watch value shown (dataset `license` attribute,
/// `https://pae-paha.pacioos.hawaii.edu/erddap/info/dhw_5km/index.html`). The OSTIA academic-use
/// clause in the same attribute covers only the 1985-2002 climatology inputs.
pub const CRW_CREDIT: &str = "Data: NOAA Coral Reef Watch (CRW), CoralTemp v3.1 daily global 5 km heat stress products, \
served by PacIOOS ERDDAP (dhw_5km). Free to use without restriction; credit NOAA Coral Reef Watch and cite \
https://doi.org/10.3390/rs12233856.";

/// The credit line and DOI a source's records must carry, if its licence asks for them. Reading
/// evidence puts them in `record.credit` and `record.doi`.
pub fn credit(source: &str) -> Option<(&'static str, &'static str)> {
    (source == "crw").then_some((CRW_CREDIT, CRW_DOI))
}

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
        "nws" | "nws-alerts" | "nwws" => alert_page(ext_id)?,
        "crw" => crw_page(ext_id)?,
        // NWPS lid (`BTRL1`), the station ext_id of the nwps, iem and nws-forecast sources.
        "nwps" | "iem" | "nws-forecast" => format!("https://water.noaa.gov/gauges/{}", alnum(ext_id)?.to_ascii_uppercase()),
        // A vessel by MMSI (GE4); VesselFinder redirects an MMSI to the ship's page.
        "aisstream" => crate::vessels::page_url(digits(ext_id)?.parse().ok().filter(|m| crate::vessels::valid_mmsi(*m))?),
        _ => return None,
    })
}

/// `<lat>,<lon>` of a CRW cell centre (`poll::crw`) to its ERDDAP table for the last 30 days.
fn crw_page(ext_id: &str) -> Option<String> {
    all(ext_id, |c| c.is_ascii_digit() || matches!(c, '-' | '.' | ','), 20)?;
    let (lat, lon) = ext_id.split_once(',')?;
    let (lat, lon): (f64, f64) = (lat.parse().ok()?, lon.parse().ok()?);
    if !((-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon)) {
        return None;
    }
    // ERDDAP time arithmetic is in seconds: last-2592000 is 30 days before the newest product.
    let sel = format!("%5B(last-2592000):1:(last)%5D%5B({lat:.3})%5D%5B({lon:.3})%5D");
    Some(format!(
        "https://pae-paha.pacioos.hawaii.edu/erddap/griddap/dhw_5km.htmlTable?CRW_SST{sel},CRW_SSTANOMALY{sel},CRW_DHW{sel},CRW_BAA{sel}"
    ))
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

// ---------------------------------------------------------------------------------------------
// Source facts (gates/leaf-E1.md G2): `sources` / `sourceInfo(feed)` and `source:<feed>` evidence
// ---------------------------------------------------------------------------------------------

/// What a feed's publisher says about it, per source id. Numbers and wording come from
/// docs/ingest-modes.md (measured 2026-10-01). Runtime facts (mode, cadence, max latency) come
/// from the adapter's `SourceInfo`, the feed's `name`/`homepage` from the app config when set.
#[derive(Debug, Clone, Copy)]
pub struct SourceFacts {
    pub publisher: &'static str,
    /// The API endpoint the adapter calls.
    pub api_url: &'static str,
    /// The publisher's human page about the product.
    pub page_url: &'static str,
    pub licence: &'static str,
    /// The credit line to show with the data.
    pub attribution: &'static str,
    pub doi: Option<&'static str>,
    /// The cadence as run, in words (the seconds come from the adapter).
    pub cadence: &'static str,
    /// Provider delay plus our worst-case wait.
    pub expected_latency: &'static str,
    pub rate_limit: &'static str,
    pub coverage: &'static str,
    /// What the feed cannot tell us.
    pub limits: &'static [&'static str],
    /// For a poll feed: the push search that came up empty, and why polling is enough.
    pub why_poll: Option<&'static str>,
}

const NWS_LIMIT: &str = "Not published (\"not public information\"), described as generous; a User-Agent is required.";
const NWS_WHY_POLL: &str = "api.weather.gov has no webhook or stream and its ATOM feed has no WebSub hub. The push channel \
(NWWS-OI XMPP) needs an emailed account; until then IEMBot product webhooks nudge this poller.";
const OPEN_METEO_LICENCE: &str = "CC BY 4.0. The free tier is non-commercial and under 10,000 calls a day; commercial use needs a paid key.";
const OPEN_METEO_CREDIT: &str = "Weather data by Open-Meteo.com (CC BY 4.0).";
const GOES: SourceFacts = SourceFacts {
    publisher: "NOAA (GOES-19 ABI Level 2 on the AWS Open Data registry)",
    api_url: "arn:aws:sns:us-east-1:123901341784:NewGOES19Object (SNS to our SQS queue)",
    page_url: "https://registry.opendata.aws/noaa-goes/",
    licence: "NOAA open data, no restrictions.",
    attribution: "Data: NOAA GOES-19 ABI Level 2 products.",
    doi: None,
    cadence: "Push: each new file arrives over SNS to SQS, read with a 20 s long poll.",
    expected_latency: "A file lands about 2.8 min after its scan ends, plus up to 20 s and the decode.",
    rate_limit: "None from NOAA; needs an AWS account with one SQS queue.",
    coverage: "Full disk (SST) and CONUS (LST, cloud, fire) products, cut to the app's regions.",
    limits: &["Clouds mask surface temperature; masked pixels are kept as cloud, not as values.", "Skin temperature, not water or air temperature."],
    why_poll: None,
};

/// Facts for a feed id (`feeds[].source` of an app config).
pub fn source_facts(source: &str) -> Option<SourceFacts> {
    Some(match source {
        "usgs" => SourceFacts {
            publisher: "U.S. Geological Survey, Water Data for the Nation",
            api_url: "https://api.waterdata.usgs.gov/ogcapi/v0/collections/continuous/items",
            page_url: "https://api.waterdata.usgs.gov/docs/ogcapi/",
            licence: "Public domain (U.S. Government work).",
            attribution: "Data: U.S. Geological Survey, Water Data for the Nation (provisional).",
            doi: None,
            cadence: "Every 15 min, all sites in one request.",
            expected_latency: "Values are 0.3 to 1.1 h old when served, plus up to 15 min.",
            rate_limit: "Anonymous per-IP hourly limit, number unpublished; a free API key raises it (X-RateLimit-Limit: 1000).",
            coverage: "The USGS gauges of the app's locations: stage (00065) and, where measured, discharge (00060).",
            limits: &[
                "Recent values are provisional and can be revised.",
                "USGS stage can sit on a different datum than NWPS (KRZL1 about 2.45 ft lower), so it is never compared with flood thresholds.",
            ],
            why_poll: Some("The OGC API has no subscription endpoint, WaterAlert only emails or texts a person, and responses are no-store with no validator."),
        },
        "nwps" => SourceFacts {
            publisher: "NOAA National Weather Service, National Water Prediction Service",
            api_url: "https://api.water.noaa.gov/nwps/v1/gauges",
            page_url: "https://water.noaa.gov",
            licence: "NOAA public data, no restrictions.",
            attribution: "Data: NOAA National Water Prediction Service.",
            doi: None,
            cadence: "Every 15 min from 12:00 to 18:00Z (the issuance window), hourly otherwise; at once on a nudge.",
            expected_latency: "Forecast: generated 8 min after issue, so up to 23 min in the window. Observed: hourly, about 55 min after the valid time, plus up to 60 min.",
            rate_limit: "No published limit; about 2 requests per site per poll, 300 ms apart.",
            coverage: "The NWPS gauges of the app's locations: observed stage and flow, the current forecast and the flood categories.",
            limits: &["No forecast history: past issuances come from the IEM archive.", "Flood categories are in NWPS stage feet; -9999 means not defined."],
            why_poll: Some("The NWPS swagger has no subscription path and responses carry no ETag; IEMBot flood products nudge this poller."),
        },
        "nws-alerts" | "nws" => SourceFacts {
            publisher: "NOAA National Weather Service",
            api_url: "https://api.weather.gov/alerts/active",
            page_url: "https://www.weather.gov/documentation/services-web-api",
            licence: "Public domain (U.S. Government work).",
            attribution: "Data: NOAA National Weather Service.",
            doi: None,
            cadence: "Every 60 s (5 min once NWWS-OI is live); every poll, empty or not, is recorded as a check.",
            expected_latency: "Up to 65 s (60 s poll plus 5 s CDN max-age).",
            rate_limit: NWS_LIMIT,
            coverage: "Alerts for the app's area; a site is covered by an alert's polygon, or by its zone when there is no polygon.",
            limits: &["If-None-Match still answers 200, so every poll is a full fetch.", "No alert in the store is only \"no alerts\" while the poller is current."],
            why_poll: Some(NWS_WHY_POLL),
        },
        "nws-forecast" => SourceFacts {
            publisher: "NOAA National Weather Service",
            api_url: "https://api.weather.gov/gridpoints",
            page_url: "https://www.weather.gov/documentation/services-web-api",
            licence: "Public domain (U.S. Government work).",
            attribution: "Data: NOAA National Weather Service gridpoint forecast.",
            doi: None,
            cadence: "Every 60 min; a version is stored only when the office's updateTime changes.",
            expected_latency: "Forecasts were 0.6 to 6.5 h old when served, plus up to 60 min.",
            rate_limit: NWS_LIMIT,
            coverage: "The NWS forecast grid cell of each location.",
            limits: &["Weather periods (temperature, wind, precipitation chance), not river stage.", "updateTime is per office run, so sites of one office share it."],
            why_poll: Some(NWS_WHY_POLL),
        },
        "iem" => SourceFacts {
            publisher: "Iowa Environmental Mesonet, Iowa State University",
            api_url: "https://mesonet.agron.iastate.edu/cgi-bin/request/hml.py",
            page_url: "https://mesonet.agron.iastate.edu/request/hml.php",
            licence: "Free, run by Iowa State University; credit the IEM.",
            attribution: "Data: Iowa Environmental Mesonet (Iowa State University), NWS HML products.",
            doi: None,
            cadence: "Once at boot for the replay window, then daily at 18:00Z to fill gaps.",
            expected_latency: "Not live: an archive of every HML issuance.",
            rate_limit: "No published limit; stored issuances are never pulled again.",
            coverage: "HML river forecasts of the app's NWPS gauges.",
            limits: &["An archive copy: the newest issuance can lag NWPS."],
            why_poll: Some("IEM offers CSV downloads only."),
        },
        "inat" => SourceFacts {
            publisher: "iNaturalist (California Academy of Sciences and National Geographic Society)",
            api_url: "https://api.inaturalist.org/v1/observations",
            page_url: "https://www.inaturalist.org",
            licence: "Per observation: CC0, CC BY, CC BY-NC or all rights reserved.",
            attribution: "Observations from iNaturalist; credit each observer under the observation's licence.",
            doi: None,
            cadence: "Every 10 min with If-None-Match (a conditional GET).",
            expected_latency: "Upload to index takes minutes, plus up to 10 min, plus up to 5 min of CDN cache.",
            rate_limit: "At most 100 requests a minute; asks for 60 a minute and under 10,000 a day.",
            coverage: "The app's species inside its regions.",
            limits: &["Community identifications can change; changes are kept as revisions.", "Where people look, not how many animals there are."],
            why_poll: Some("The API has no hook; its subscriptions follow one observation or project for a signed-in user."),
        },
        "gbif" => SourceFacts {
            publisher: "GBIF Secretariat",
            api_url: "https://api.gbif.org/v1/occurrence/search",
            page_url: "https://www.gbif.org",
            licence: "Per dataset: CC0, CC BY or CC BY-NC.",
            attribution: "GBIF.org occurrence data; cite the datasets used.",
            doi: None,
            cadence: "Daily, over a modified-date window.",
            expected_latency: "Days to weeks of index lag, plus up to 24 h.",
            rate_limit: "No published hard limit; responses are cached for 600 s.",
            coverage: "The app's species inside its regions.",
            limits: &["Re-ingests iNaturalist weekly; those copies link to the iNaturalist sighting and are never counted twice."],
            why_poll: Some("The occurrence API has no webhook or callback; download notices are email only."),
        },
        "nas" => SourceFacts {
            publisher: "U.S. Geological Survey, Nonindigenous Aquatic Species program",
            api_url: "https://nas.er.usgs.gov/api/v2/occurrence/search",
            page_url: "https://nas.er.usgs.gov",
            licence: "Public domain (U.S. Government work).",
            attribution: "Data: U.S. Geological Survey Nonindigenous Aquatic Species Database.",
            doi: None,
            cadence: "Weekly.",
            expected_latency: "Curated records lag weeks to months, plus up to 7 days.",
            rate_limit: "No published limit; a 5,000-row page takes about 26 s, so pages are read in sequence.",
            coverage: "The app's focus genus, filtered to its regions.",
            limits: &["Curated, verified records: never real time."],
            why_poll: Some("NAS Alerts (email and RSS) announce a species new to an area, not new records."),
        },
        "eddmaps" => SourceFacts {
            publisher: "Bugwood Center, University of Georgia (EDDMapS, Florida's IveGot1)",
            api_url: "https://api.bugwood.org/rest/api/occurrence",
            page_url: "https://www.eddmaps.org",
            licence: "Open, no key; terms of use not confirmed when this was added.",
            attribution: "Data: EDDMapS, Bugwood Center, University of Georgia.",
            doi: None,
            cadence: "Every 30 min, one request.",
            expected_latency: "Reports appear the day they are entered, plus up to 30 min.",
            rate_limit: "No published limit; one request per poll.",
            coverage: "Burmese python reports in the app's regions (41 records when added).",
            limits: &["A small set: it adds recent verified reports, not volume.", "Some reports repeat iNaturalist or NAS records and are not linked as duplicates."],
            why_poll: Some("The API has no subscription or push endpoint."),
        },
        "ndbc" => SourceFacts {
            publisher: "NOAA National Data Buoy Center",
            api_url: "https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt",
            page_url: "https://www.ndbc.noaa.gov",
            licence: "Public domain (U.S. Government work).",
            attribution: "Data: NOAA National Data Buoy Center.",
            doi: None,
            cadence: "Every 10 min, one bulk file with If-None-Match.",
            expected_latency: "About 25 min from observation to file, plus up to 10 min.",
            rate_limit: "No published limit; one request covers every station.",
            coverage: "Buoys and C-MAN stations inside the app's regions.",
            limits: &["Few buoys report water temperature inside the reef areas (only Florida for lionfish)."],
            why_poll: Some("NDBC has no push; the bulk file answers 304 when unchanged, so a poll costs little."),
        },
        "coops" => SourceFacts {
            publisher: "NOAA Center for Operational Oceanographic Products and Services (Tides and Currents)",
            api_url: "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter",
            page_url: "https://tidesandcurrents.noaa.gov",
            licence: "Public domain (U.S. Government work).",
            attribution: "Data: NOAA CO-OPS.",
            doi: None,
            cadence: "Every 6 min.",
            expected_latency: "6 to 10 min, plus up to 6 min.",
            rate_limit: "No published limit; one station per request.",
            coverage: "Florida tide stations.",
            limits: &["Florida only."],
            why_poll: Some("CO-OPS has no push, no validator and sends no-store."),
        },
        "openmeteo" => SourceFacts {
            publisher: "Open-Meteo",
            api_url: "https://api.open-meteo.com/v1/forecast",
            page_url: "https://open-meteo.com",
            licence: OPEN_METEO_LICENCE,
            attribution: OPEN_METEO_CREDIT,
            doi: None,
            cadence: "Hourly.",
            expected_latency: "The model run plus up to 1 h.",
            rate_limit: "Under 10,000 calls a day on the free tier.",
            coverage: "A grid over the app's regions.",
            limits: &["Modelled, not measured."],
            why_poll: Some("Open-Meteo has no push or webhook."),
        },
        "openmeteo-marine" => SourceFacts {
            publisher: "Open-Meteo",
            api_url: "https://marine-api.open-meteo.com/v1/marine",
            page_url: "https://open-meteo.com/en/docs/marine-weather-api",
            licence: OPEN_METEO_LICENCE,
            attribution: OPEN_METEO_CREDIT,
            doi: None,
            cadence: "meta.json every 15 min; data only when a new model run lands.",
            expected_latency: "Up to 15 min after a run becomes available.",
            rate_limit: "Under 10,000 calls a day on the free tier.",
            coverage: "A grid over the app's regions.",
            limits: &["Modelled waves and currents, coarse near reefs and coasts."],
            why_poll: Some("Open-Meteo has no push; meta.json says when a model run lands, so data is fetched once per run."),
        },
        "crw" => SourceFacts {
            publisher: "NOAA Coral Reef Watch, served by PacIOOS ERDDAP",
            api_url: "https://pae-paha.pacioos.hawaii.edu/erddap/griddap/dhw_5km.json",
            page_url: "https://coralreefwatch.noaa.gov/product/5km/",
            licence: "Free to use without restriction; credit NOAA Coral Reef Watch and cite the DOI.",
            attribution: CRW_CREDIT,
            doi: Some(CRW_DOI),
            cadence: "On an ERDDAP dataset-change nudge, with a 3 h backstop poll.",
            expected_latency: "About 31 h after the product day; minutes after publication with a nudge, up to 3 h without.",
            rate_limit: "No published limit; one request per area per change.",
            coverage: "Daily 5 km reef heat stress (SST, anomaly, DHW, BAA) at the app's reef cells.",
            limits: &["Satellite sea surface temperature at 5 km, once a day.", "Heat stress, not where lionfish are."],
            why_poll: None,
        },
        "goes19" | "goes19-sst" => GOES,
        "aisstream" => SourceFacts {
            publisher: "AISStream.io (terrestrial AIS receivers)",
            api_url: "wss://stream.aisstream.io/v0/stream",
            page_url: "https://aisstream.io/documentation",
            licence: "Free (beta), no formal terms of service or SLA; AIS is a public radio broadcast. A key from aisstream.io is required and must stay server side.",
            attribution: "Vessel positions: AISStream.io",
            doi: None,
            cadence: "Push: a websocket stream of every AIS message in the app's boxes; positions kept at most one per vessel per minute.",
            expected_latency: "Seconds after a receiver hears the ship.",
            rate_limit: "3 subscribed connections per account, 3 open per IP, one subscription update per second; slow consumers lose messages.",
            coverage: "Ships with AIS transponders inside the app's region boxes, where a shore receiver hears them.",
            limits: &[
                "Only ships that broadcast AIS; small boats often do not.",
                "Terrestrial receivers only: coverage thins offshore and away from ports.",
                "Needs AISSTREAM_API_KEY; without it the feed shows as down with the reason, and stored history still replays.",
            ],
            why_poll: None,
        },
        "nwws" => SourceFacts {
            publisher: "NOAA National Weather Service, NOAA Weather Wire Service (NWWS-OI)",
            api_url: "xmpp://nwws-oi.weather.gov (room nwws)",
            page_url: "https://www.weather.gov/nwws/",
            licence: "Free; an account is requested by email.",
            attribution: "Data: NOAA National Weather Service products via NWWS-OI.",
            doi: None,
            cadence: "Push: products arrive as they are issued.",
            expected_latency: "Seconds.",
            rate_limit: "One session per account.",
            coverage: "Products from the app's NWS offices.",
            limits: &["Needs NWWS-OI credentials; without them the feed shows as down with the reason."],
            why_poll: None,
        },
        _ => return None,
    })
}

/// One feed of an app as `sources` / `sourceInfo` / `source:<feed>` report it.
#[derive(Debug, Clone, PartialEq)]
pub struct SourceView {
    pub feed: String,
    pub name: String,
    pub publisher: String,
    /// `push`, `poll` or `webhook` (the adapter's mode).
    pub mode: &'static str,
    /// `POST|GET /v1/{app}/ingest/nudge/{feed}/{token}` wakes it (`ingest::push::nudge`).
    pub nudge: bool,
    /// The adapter's data cadence (what feed state measures lag against).
    pub cadence_seconds: i64,
    /// Seconds between fetches of the running poll loop (`Source::min_interval`): CRW polls its
    /// 3 h backstop although a product lands every day. `None` for push and stopped feeds.
    pub poll_seconds: Option<i64>,
    pub cadence: String,
    pub max_latency_seconds: i64,
    pub expected_latency: String,
    /// Median of `received_at - fetched_at` over the last [`OBSERVED_RUNS`] runs: our fetch to
    /// commit time.
    pub observed_fetch_seconds: Option<f64>,
    /// Now minus the newest observation the feed delivered (feed state lag).
    pub observed_lag_seconds: Option<i64>,
    pub licence: String,
    pub attribution: String,
    pub doi: Option<String>,
    pub rate_limit: String,
    pub api_url: String,
    pub page_url: String,
    pub coverage: String,
    pub limits: Vec<String>,
    pub why_poll: Option<String>,
    pub last_fetch_at: Option<i64>,
    pub last_fetch_status: Option<String>,
    pub last_fetch_run_id: Option<i64>,
    /// Feed health (`nominal`, `lagging`, `stale`, `down`) and its note, from feed state.
    pub state: Option<crate::feed_state::Health>,
    pub note: Option<String>,
}

/// Fetch runs the observed fetch time is taken over.
pub const OBSERVED_RUNS: i64 = 20;

/// Every feed `state.app` runs or registers (running, waiting for secrets, hook-only), in plan
/// order, with its facts, its newest fetch run and its feed state at `state.now_ms()`.
pub async fn source_views(state: &crate::state::AppState) -> anyhow::Result<Vec<SourceView>> {
    let plan = crate::ingest::scheduler::plan(state);
    let infos: Vec<crate::ingest::source::SourceInfo> = plan.known.iter().map(|(info, _)| info.clone()).collect();
    let poll_every = |id: &str| {
        plan.runnable
            .iter()
            .find(|s| s.info().id == id)
            .map(|s| s.min_interval().as_secs() as i64)
            .filter(|s| *s > 0)
    };
    let ids: Vec<String> = infos.iter().map(|i| i.id.to_string()).collect();
    let runs = state
        .obs
        .read(move |c| {
            let mut last = c.prepare_cached(
                "select id, fetched_at, status from fetch_runs where source_id = ?1 order by fetched_at desc, id desc limit 1",
            )?;
            let mut recent = c.prepare_cached(
                "select received_at - fetched_at from fetch_runs where source_id = ?1 order by fetched_at desc, id desc limit ?2",
            )?;
            let mut out = Vec::with_capacity(ids.len());
            for id in &ids {
                let newest: Option<(i64, i64, String)> =
                    rusqlite::OptionalExtension::optional(last.query_row([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))))?;
                let mut lags: Vec<i64> = recent.query_map(rusqlite::params![id, OBSERVED_RUNS], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
                lags.sort_unstable();
                let median = (!lags.is_empty()).then(|| {
                    let n = lags.len();
                    if n % 2 == 1 { lags[n / 2] as f64 } else { (lags[n / 2 - 1] + lags[n / 2]) as f64 / 2.0 }
                });
                out.push((newest, median.map(|ms| ms / 1000.0)));
            }
            Ok(out)
        })
        .await?;
    let feeds = crate::feed_state::compute(&state.obs, state.now_ms()).await?;
    Ok(infos
        .into_iter()
        .zip(runs)
        .map(|(info, (newest, median))| {
            let facts = source_facts(info.id);
            let cfg = state.app.cfg.feed(info.id);
            let feed = feeds.iter().find(|f| f.source == info.id);
            let text = |f: fn(&SourceFacts) -> &'static str, fallback: &str| facts.as_ref().map_or(fallback.to_string(), |x| f(x).to_string());
            SourceView {
                feed: info.id.to_string(),
                name: cfg.and_then(|c| c.name.clone()).unwrap_or_else(|| info.name.to_string()),
                publisher: text(|f| f.publisher, info.name),
                mode: info.mode.as_str(),
                nudge: crate::ingest::push::nudge::capable(info.id, info.mode),
                cadence_seconds: info.cadence.as_secs() as i64,
                poll_seconds: poll_every(info.id),
                cadence: text(|f| f.cadence, "As the adapter's cadence."),
                max_latency_seconds: info.max_latency.as_secs() as i64,
                expected_latency: text(|f| f.expected_latency, "Not measured."),
                observed_fetch_seconds: median,
                observed_lag_seconds: feed.and_then(|f| f.lag_seconds),
                licence: text(|f| f.licence, "Not recorded."),
                attribution: text(|f| f.attribution, info.name),
                doi: facts.as_ref().and_then(|f| f.doi).map(str::to_string),
                rate_limit: text(|f| f.rate_limit, "Not recorded."),
                api_url: text(|f| f.api_url, info.homepage),
                page_url: cfg.and_then(|c| c.homepage.clone()).unwrap_or_else(|| text(|f| f.page_url, info.homepage)),
                coverage: text(|f| f.coverage, "The app's regions."),
                limits: facts.as_ref().map(|f| f.limits.iter().map(|s| s.to_string()).collect()).unwrap_or_default(),
                why_poll: (info.mode == crate::ingest::source::Mode::Poll).then(|| facts.as_ref().and_then(|f| f.why_poll)).flatten().map(str::to_string),
                last_fetch_at: newest.as_ref().map(|n| n.1),
                last_fetch_status: newest.as_ref().map(|n| n.2.clone()),
                last_fetch_run_id: newest.map(|n| n.0),
                state: feed.map(|f| f.state),
                note: feed.and_then(|f| f.note.clone()),
            }
        })
        .collect())
}

/// One view as JSON (the `source:<feed>` evidence record).
pub fn source_view_json(v: &SourceView) -> serde_json::Value {
    let iso = |ms: Option<i64>| {
        ms.and_then(chrono::DateTime::from_timestamp_millis).map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
    };
    serde_json::json!({
        "feed": v.feed, "name": v.name, "publisher": v.publisher, "mode": v.mode, "nudge": v.nudge,
        "cadenceSeconds": v.cadence_seconds, "pollSeconds": v.poll_seconds, "cadence": v.cadence,
        "maxLatencySeconds": v.max_latency_seconds, "expectedLatency": v.expected_latency,
        "observedFetchSeconds": v.observed_fetch_seconds, "observedLagSeconds": v.observed_lag_seconds,
        "licence": v.licence, "attribution": v.attribution, "doi": v.doi, "rateLimit": v.rate_limit,
        "apiUrl": v.api_url, "pageUrl": v.page_url, "coverage": v.coverage, "limits": v.limits, "whyPoll": v.why_poll,
        "lastFetchAt": iso(v.last_fetch_at), "lastFetchStatus": v.last_fetch_status,
        "lastFetchRunId": v.last_fetch_run_id.map(|id| id.to_string()),
        "state": v.state, "note": v.note,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::poll::bio::testing::python;
    use crate::ingest::poll::{coops, crw, gbif, inat, nas, ndbc, nws, openmeteo, usgs};
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
        let inat = sighting_ids(inat::normalize(&fixture("inat/focus-p1.json"), &python()).unwrap());
        let gbif = sighting_ids(gbif::normalize(&fixture("gbif/modified-p1.json"), &python()).unwrap());
        let nas = sighting_ids(nas::normalize(&fixture("nas/python-2026-p1.json"), &python()).unwrap());
        let usgs = station_ids(usgs::normalize_iv(&fixture("usgs/iv.json"), 0).unwrap());
        let ndbc_st = ndbc::station("KYWF1").unwrap();
        let ndbc = station_ids(ndbc::normalize_txt(ndbc_st, &fixture("ndbc/KYWF1.txt"), 1_790_800_000_000).unwrap());
        let coops = station_ids(coops::normalize_product("8723214", "water_level", &fixture("coops/8723214.water_level.json")).unwrap());
        let alerts = alert_ids(nws::normalize_alerts(&fixture("nws/alerts_active_fl_am_gm.json"), &nws::Scope::for_app(&python())).unwrap());
        let vtec = alerts.iter().find(|a| a.starts_with("vtec:KKEY.SC.Y.0019")).unwrap().clone();
        let cap = alerts.iter().find(|a| a.starts_with("urn:oid:")).unwrap().clone();
        let method = usgs.iter().find(|s| s.contains(':')).unwrap().clone();
        let crw = station_ids(crw::normalize_payload(&fixture("crw/fl-keys.json")).unwrap());
        let looe_key = crw.iter().find(|s| *s == "24.525,-81.375").unwrap().clone();
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
            ("crw", looe_key),
            ("nwps", "SMML1".to_string()),
            // The recorded real AIS frame (api/tests/fixtures/ais/position_report.json).
            ("aisstream", "538006783".to_string()),
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
        let ids = sighting_ids(inat::normalize(&fixture("inat/focus-p1.json"), &python()).unwrap());
        assert_eq!(ids[0], "398628449");
        assert_eq!(source_page_url("inat", &ids[0]).as_deref(), Some("https://www.inaturalist.org/observations/398628449"));
        assert!(ids.iter().all(|id| source_page_url("inat", id).is_some()));
    }

    #[test]
    fn source_page_url_gbif_occurrence_from_composite_ext_id() {
        let ids = sighting_ids(gbif::normalize(&fixture("gbif/modified-p1.json"), &python()).unwrap());
        let mirror = ids.iter().find(|id| id.ends_with(":6550750302")).unwrap();
        assert_eq!(mirror, "50c9509d-22c7-4a22-a47d-8c48425ef4a7:398269828:6550750302");
        assert_eq!(source_page_url("gbif", mirror).as_deref(), Some("https://www.gbif.org/occurrence/6550750302"));
        // Catalog numbers with spaces or colons do not matter: the key is the last part.
        assert_eq!(source_page_url("gbif", "x:UF 1:3:42").as_deref(), Some("https://www.gbif.org/occurrence/42"));
        assert!(ids.iter().all(|id| source_page_url("gbif", id).is_some()));
    }

    #[test]
    fn source_page_url_nas_specimen_viewer() {
        let ids = sighting_ids(nas::normalize(&fixture("nas/python-2026-p1.json"), &python()).unwrap());
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
        let ids = alert_ids(nws::normalize_alerts(&fixture("nws/alerts_active_fl_am_gm.json"), &nws::Scope::for_app(&python())).unwrap());
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
    fn source_page_url_null_for_modelled_grid_and_goes() {
        use crate::ingest::poll::physical::testing::{fixture_str, recorded};
        let url = fixture_str("openmeteo/forecast.url");
        let raw = recorded(url.trim(), "application/json", fixture("openmeteo/forecast.json"), 200, 1_790_800_000_000);
        let grid = station_ids(openmeteo::normalize_payload(&raw).unwrap());
        assert!(!grid.is_empty());
        assert!(grid.iter().all(|id| source_page_url("openmeteo", id).is_none()));
        assert_eq!(source_page_url("goes19", "g5:1234"), None);
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
        assert_eq!(links.len(), 12);
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

    /// L3: a CRW cell links its ERDDAP table; the licence credit and DOI travel with the source.
    #[test]
    fn crw_source_page_and_credit() {
        let sel = "%5B(last-2592000):1:(last)%5D%5B(24.525)%5D%5B(-81.375)%5D";
        assert_eq!(
            source_page_url("crw", "24.525,-81.375").as_deref(),
            Some(format!("https://pae-paha.pacioos.hawaii.edu/erddap/griddap/dhw_5km.htmlTable?CRW_SST{sel},CRW_SSTANOMALY{sel},CRW_DHW{sel},CRW_BAA{sel}").as_str())
        );
        assert_eq!(publisher(&source_page_url("crw", "12.525,-81.625").unwrap()), Some("NOAA Coral Reef Watch (PacIOOS ERDDAP)"));
        for bad in ["24.525", "24.525,-81.375,1", "91,0", "0,181", "24.5;x,1", "", "a,b"] {
            assert_eq!(source_page_url("crw", bad), None, "{bad:?}");
        }
        let (line, doi) = credit("crw").unwrap();
        assert_eq!(doi, CRW_DOI);
        assert!(line.contains("NOAA Coral Reef Watch") && line.contains(CRW_DOI) && line.contains("without restriction"));
        assert_eq!(credit("inat"), None);
    }

    // ---- E1 G2: sources / sourceInfo ---------------------------------------------------------

    /// Every feed each app registers has publisher facts; the mode, cadence and max latency are the
    /// adapter's; poll feeds say why they are polled and push/webhook feeds do not.
    #[tokio::test]
    async fn source_info_every_feed_of_every_app() {
        use crate::app::test_support::test_state_for;
        for app in crate::app::config::APP_IDS {
            let state = test_state_for(app);
            let views = source_views(&state).await.unwrap();
            let plan: Vec<&str> = crate::ingest::scheduler::plan(&state).known.iter().map(|(i, _)| i.id).collect();
            assert_eq!(views.iter().map(|v| v.feed.as_str()).collect::<Vec<_>>(), plan, "{app}");
            for v in &views {
                assert!(source_facts(&v.feed).is_some(), "{app}/{}: no facts in source_pages.rs", v.feed);
                for (what, text) in [("publisher", &v.publisher), ("licence", &v.licence), ("attribution", &v.attribution), ("rateLimit", &v.rate_limit), ("expectedLatency", &v.expected_latency), ("cadence", &v.cadence), ("apiUrl", &v.api_url), ("pageUrl", &v.page_url), ("coverage", &v.coverage)] {
                    assert!(!text.trim().is_empty(), "{app}/{}: empty {what}", v.feed);
                }
                assert!(v.cadence_seconds > 0 && v.max_latency_seconds > 0, "{app}/{}", v.feed);
                assert_eq!(v.why_poll.is_some(), v.mode == "poll", "{app}/{}: whyPoll only for poll feeds", v.feed);
                assert!(["push", "poll", "webhook"].contains(&v.mode));
                assert_eq!((v.last_fetch_at, v.observed_fetch_seconds), (None, None), "nothing fetched in a fresh state");
            }
        }
        // Registered as the scheduler does at boot (sources off in tests: every feed carries why).
        let carp_state = test_state_for("carp");
        crate::ingest::scheduler::start(carp_state.clone(), Default::default()).await.unwrap();
        let carp = source_views(&carp_state).await.unwrap();
        let get = |feed: &str| carp.iter().find(|v| v.feed == feed).unwrap();
        assert_eq!((get("nwps").mode, get("nwps").nudge, get("usgs").nudge, get("nws-alerts").nudge), ("poll", true, false, true));
        assert_eq!(get("nwps").name, "NOAA National Water Prediction Service", "config name wins");
        assert_eq!(get("nwps").page_url, "https://water.noaa.gov", "config homepage wins");
        assert_eq!(get("nwws").mode, "push");
        assert_eq!(get("nwws").state, Some(crate::feed_state::Health::Down), "no credentials: down, with the reason");
        let lionfish = source_views(&test_state_for("lionfish")).await.unwrap();
        let crw = lionfish.iter().find(|v| v.feed == "crw").unwrap();
        assert_eq!((crw.mode, crw.nudge, crw.doi.as_deref(), crw.why_poll.as_deref()), ("webhook", true, Some(CRW_DOI), None));
        assert_eq!(crw.attribution, CRW_CREDIT);
        let info = crate::ingest::source::Source::info(&crate::ingest::poll::crw::Crw::new(test_state_for("lionfish").app.clone()));
        assert_eq!((crw.cadence_seconds, crw.max_latency_seconds), (info.cadence.as_secs() as i64, info.max_latency.as_secs() as i64), "the adapter's numbers");
        assert_eq!(crw.poll_seconds, Some(3 * 3600), "the 3 h backstop poll");
        assert_eq!(lionfish.iter().find(|v| v.feed == "goes19-sst").unwrap().poll_seconds, None, "push, and not running");
    }

    /// Last fetch and status from `fetch_runs`; the observed fetch time is the median of
    /// `received_at - fetched_at` over the newest runs; the lag comes from feed state.
    #[tokio::test]
    async fn source_info_last_fetch_and_observed_latency() {
        use crate::app::test_support::test_state_for;
        let state = test_state_for("carp").with_clock(crate::state::Clock::Fixed(1_790_856_000_000));
        crate::ingest::scheduler::upsert_sources(&state, crate::ingest::scheduler::plan(&state).known.iter().map(|(i, _)| i.clone()).collect()).await.unwrap();
        let t = 1_790_850_000_000;
        state
            .obs
            .write(move |tx| {
                for (k, (lag, status)) in [(1000, "ok"), (3000, "empty"), (2000, "ok"), (9000, "error")].into_iter().enumerate() {
                    let at = t + k as i64 * 900_000;
                    tx.execute(
                        "insert into fetch_runs (source_id, fetched_at, received_at, status) values ('nwps', ?1, ?2, ?3)",
                        rusqlite::params![at, at + lag, status],
                    )?;
                }
                crate::forecast::store::insert_observations(tx, "SMML1", crate::forecast::Source::NwpsLive, t, &[crate::forecast::Observation { observed_at: t - 3_600_000, stage_ft: Some(30.0), flow_kcfs: None }])?;
                Ok(())
            })
            .await
            .unwrap();
        let views = source_views(&state).await.unwrap();
        let nwps = views.iter().find(|v| v.feed == "nwps").unwrap();
        assert_eq!(nwps.last_fetch_at, Some(t + 3 * 900_000));
        assert_eq!(nwps.last_fetch_status.as_deref(), Some("error"));
        assert_eq!(nwps.observed_fetch_seconds, Some(2.5), "median of 1, 2, 3 and 9 s");
        assert_eq!(nwps.observed_lag_seconds, Some((1_790_856_000_000 - (t - 3_600_000)) / 1000));
        let json = source_view_json(nwps);
        assert_eq!(json["lastFetchStatus"], "error");
        assert_eq!(json["lastFetchRunId"], nwps.last_fetch_run_id.unwrap().to_string());
    }

    /// GraphQL: `sources` lists the app's feeds with `FeedMode` including WEBHOOK; `sourceInfo`
    /// answers one feed and null for a feed the app does not run.
    #[tokio::test]
    async fn source_info_graphql_sources_and_source_info() {
        use axum::body::Body;
        use axum::http::{header, Request};
        use http_body_util::BodyExt;
        use tower::ServiceExt;
        let state = crate::app::test_support::test_state_for("lionfish");
        let router = crate::app::test_support::router_for(&state);
        let q = r#"{ sources { feed mode nudge whyPoll licence attribution doi cadenceSeconds maxLatencySeconds expectedLatency rateLimit pageUrl apiUrl lastFetchAt state }
                    crw: sourceInfo(feed: "crw") { feed mode doi }
                    none: sourceInfo(feed: "nwps") { feed } }"#;
        let res = router
            .oneshot(Request::post("/v1/lionfish/graphql").header(header::CONTENT_TYPE, "application/json").body(Body::from(serde_json::json!({ "query": q }).to_string())).unwrap())
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
        let sources = body["data"]["sources"].as_array().unwrap_or_else(|| panic!("{body}"));
        let mut feeds: Vec<&str> = sources.iter().map(|s| s["feed"].as_str().unwrap()).collect();
        feeds.sort_unstable();
        assert_eq!(feeds, ["aisstream", "coops", "crw", "gbif", "goes19-sst", "inat", "nas", "ndbc", "openmeteo-marine"]);
        assert_eq!(body["data"]["crw"], serde_json::json!({"feed": "crw", "mode": "WEBHOOK", "doi": CRW_DOI}));
        assert_eq!(body["data"]["none"], serde_json::Value::Null);
        let goes = sources.iter().find(|s| s["feed"] == "goes19-sst").unwrap();
        assert_eq!((goes["mode"].as_str(), goes["whyPoll"].clone()), (Some("PUSH"), serde_json::Value::Null));
        let inat = sources.iter().find(|s| s["feed"] == "inat").unwrap();
        assert_eq!(inat["mode"], "POLL");
        assert!(inat["whyPoll"].as_str().unwrap().contains("no hook"));
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
