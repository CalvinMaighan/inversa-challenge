/**
 * Which public record a sighting's source page is, so its place name can be looked up: iNaturalist observations
 * (`https://www.inaturalist.org/observations/<id>`) and GBIF occurrences (`https://www.gbif.org/occurrence/<key>`).
 * Any other page (NAS specimens, anything unrecognised) has no place lookup.
 */
export type ObservationSource = { source: "inat" | "gbif"; id: string };

export function parseSourcePage(url: string | null | undefined): ObservationSource | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const inat = /^\/observations\/(\d{1,12})$/.exec(u.pathname);
  if (inat && /(^|\.)inaturalist\.org$/.test(u.hostname)) return { source: "inat", id: inat[1]! };
  const gbif = /^\/occurrence\/(\d{1,15})$/.exec(u.pathname);
  if (gbif && /(^|\.)gbif\.org$/.test(u.hostname)) return { source: "gbif", id: gbif[1]! };
  return null;
}
