/**
 * Publisher pages for records (PLAN.md C19). The API computes `Evidence.sourcePageUrl`
 * (`api/src/source_pages.rs`); the web side needs the host allowlist to decide which URLs become links, and the
 * sighting patterns for agent table rows, which come from `sightings` rows (source + extId) rather than evidence.
 */

/** Host → publisher name. Mirrors `PUBLISHERS` in api/src/source_pages.rs; a test keeps the two equal. */
export const PUBLISHERS: Readonly<Record<string, string>> = {
  "www.inaturalist.org": "iNaturalist",
  "www.gbif.org": "GBIF",
  "nas.er.usgs.gov": "USGS NAS",
  "waterdata.usgs.gov": "USGS Water Data",
  "www.ndbc.noaa.gov": "NOAA NDBC",
  "tidesandcurrents.noaa.gov": "NOAA Tides & Currents",
  "api.weather.gov": "NWS",
  "mesonet.agron.iastate.edu": "IEM VTEC browser",
};

/** The publisher name of an https URL on an allowlisted host, or null (any other scheme, host, port or userinfo). */
export function publisherOf(url: unknown): string | null {
  if (typeof url !== "string" || !url.startsWith("https://")) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password) return null;
  return Object.hasOwn(PUBLISHERS, parsed.hostname) ? PUBLISHERS[parsed.hostname]! : null;
}

const DIGITS = /^\d{1,20}$/;

/** Sighting page by source and `ext_id`, same patterns as the API (GBIF ext ids end in the GBIF key). */
export function sightingPageUrl(source: string, extId: string): string | null {
  switch (source) {
    case "inat":
      return DIGITS.test(extId) ? `https://www.inaturalist.org/observations/${extId}` : null;
    case "gbif": {
      const key = extId.slice(extId.lastIndexOf(":") + 1);
      return DIGITS.test(key) ? `https://www.gbif.org/occurrence/${key}` : null;
    }
    case "nas":
      return DIGITS.test(extId) ? `https://nas.er.usgs.gov/queries/SpecimenViewer.aspx?SpecimenID=${extId}` : null;
    default:
      return null;
  }
}
