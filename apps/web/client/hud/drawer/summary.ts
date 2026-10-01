/**
 * The evidence card's plain-language lead (T41), for someone new to the field: what, where in place words, when
 * in relative time, and how sure, e.g.
 *
 *   Green iguana spotted near Coral Gables · 2 h ago · confirmed by the iNaturalist community
 *
 * Pure over the evidence record (C14 shapes from Axum) and the time cursor. Never shows raw coordinates or ids;
 * those stay under "Details for experts".
 */
import { categoryOfTaxon, isFocusTaxon, taxonName } from "client/state/taxa";
import { nearestPlace } from "client/voice/gazetteer";
import { QUALITY_CODES } from "shared/frames";
import { CATEGORY_NOUNS, FOCUS_CATEGORIES, type CategoryId } from "shared/species-categories";

import { SPECIES_GUIDE } from "../help/content";
import { feedLabel } from "../topbar/feed-chips";
import { ago, formatReading, NETWORK_LABELS } from "../tooltip/model";

export type PlainSummary = {
  /** One line, the parts joined with " · ". */
  line: string;
  /** What it is, for the card's heading. */
  title: string;
  /** The rest of the line, in order. */
  parts: string[];
  /** Same-origin photo: the observation's (`/v1/media/<id>`), else the species' (`/v1/media/taxon/<id>`). */
  photo: string | null;
  /** The species card (T44), for sightings only. */
  species?: SpeciesCard;
};

/** What a sighting's card says about its species: every taxon gets one, not only the focus four. */
export type SpeciesCard = {
  /** Common name in sentence case, or the scientific name when there is none. */
  name: string;
  /** Latin name, shown in italics; null when it is the name already. */
  scientificName: string | null;
  /** "introduced species", with the group in plain words when known ("introduced reptile"). */
  status: string;
  /** One About line: Inversa's one-liner for a focus species, else the plain Wikipedia summary. */
  about: string | null;
  /** Its kind (snakes, lizards, …): the icon and colour the globe draws it with. */
  category: CategoryId;
  /** "More about <name> on iNaturalist" target, opened in a new tab. */
  moreUrl: string | null;
  moreLabel: string | null;
};

/** The species card of a sighting record's `taxon` (the API's Taxon JSON, T44), or a bare one for an old API. */
export function speciesCard(taxon: Record<string, unknown>): SpeciesCard {
  const id = Number(taxon.id);
  const common = str(taxon.commonName);
  const sci = str(taxon.scientificName);
  const name = taxonName({ commonName: common ?? "", scientificName: sci ?? "" }, "Unnamed species");
  const focusIndex = isFocusTaxon(id) ? id - 1 : -1;
  const guide = focusIndex >= 0 ? SPECIES_GUIDE[focusIndex] : undefined;
  const category = focusIndex >= 0 ? FOCUS_CATEGORIES[focusIndex]! : categoryOfTaxon(taxon as Parameters<typeof categoryOfTaxon>[0]);
  const summary = str(taxon.summary);
  const pageUrl = str(taxon.pageUrl);
  return {
    name,
    scientificName: sci && sci !== name ? sci : null,
    category,
    status: `introduced ${CATEGORY_NOUNS[category]}`,
    about: guide ? sentence(guide.line) + "." : summary,
    moreUrl: pageUrl && /^https:\/\/www\.inaturalist\.org\/taxa\/\d+$/.test(pageUrl) ? pageUrl : null,
    moreLabel: pageUrl ? `More about ${name} on iNaturalist` : null,
  };
}


/** Quality grade in plain words; research grade names the community that confirmed it when known. */
export function qualityWords(quality: unknown, source: unknown): string | null {
  switch (QUALITY_CODES.indexOf(String(quality ?? "").toLowerCase() as (typeof QUALITY_CODES)[number])) {
    case 0: // research
      return source === "inat" ? "confirmed by the iNaturalist community" : "community-confirmed";
    case 1: // needs_id
      return "needs ID (not yet confirmed)";
    case 2: // casual
      return "casual record (unconfirmed)";
    case 3: // curated
      return "official record";
    default:
      return null;
  }
}

/** "near Coral Gables", or "in South Florida" when no named place is close. Never coordinates. */
export function placeWords(lat: unknown, lon: unknown): string {
  const place = typeof lat === "number" && typeof lon === "number" ? nearestPlace(lat, lon) : null;
  return place ? `near ${place.name}` : "in South Florida";
}

/** Feed sources as a newcomer would name them. */
const SOURCE_NAMES: Record<string, string> = {
  inat: "iNaturalist",
  gbif: "GBIF",
  nas: "USGS NAS",
  usgs: "USGS water gauges",
  ndbc: "NOAA buoys",
  coops: "NOAA tide gauges",
  nws: "National Weather Service alerts",
  nwws: "National Weather Service alerts",
  openmeteo: "Open-Meteo weather",
  goes: "GOES satellite",
  goes19: "GOES satellite",
};

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const when = (iso: unknown, atMs: number) => (typeof iso === "string" && Number.isFinite(Date.parse(iso)) ? ago(Date.parse(iso), atMs) : null);
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function build(title: string, parts: (string | null)[], photo: string | null = null, species?: SpeciesCard): PlainSummary {
  const kept = parts.filter((p): p is string => !!p);
  return { title, parts: kept, line: [title, ...kept].join(" · "), photo, ...(species ? { species } : {}) };
}

/** A same-origin media path, never a remote URL. */
const local = (v: unknown) => {
  const s = str(v);
  return s && s.startsWith("/") ? s : null;
};

/** Plain summary for an evidence record, or null for kinds whose panel says it already (backtests). */
export function plainSummary(kind: string, record: Record<string, unknown>, atMs: number): PlainSummary | null {
  switch (kind) {
    case "sighting": {
      const taxon = (record.taxon ?? {}) as Record<string, unknown>;
      const species = speciesCard(taxon);
      // The observation's own photo first; the species' photo stands in when the observer took none.
      const photo = local(record.mediaUrl) ?? local(taxon.photoUrl);
      return build(`${species.name} spotted ${placeWords(record.lat, record.lon)}`, [when(record.observedAt, atMs), qualityWords(record.quality, record.source)], photo, species);
    }
    case "reading": {
      const station = (record.station ?? {}) as Record<string, unknown>;
      const network = NETWORK_LABELS[String(station.source ?? "").toLowerCase()] ?? "Station";
      const value = typeof record.value === "number" ? record.value : null;
      return build(`${network}${str(station.name) ? ` at ${str(station.name)}` : ""}`, [formatReading(String(record.param ?? ""), value), when(record.observedAt, atMs)]);
    }
    case "alert": {
      const expires = when(record.expires, atMs);
      return build(str(record.event) ?? "Weather alert", [str(record.headline), expires ? (expires.startsWith("in ") ? `ends ${expires}` : `ended ${expires}`) : null]);
    }
    case "hotspot": {
      const species = sentence(str(record.species) ?? "Species");
      const score = typeof record.score === "number" ? `likelihood score ${record.score.toFixed(2)} (a rough guide, not a forecast)` : null;
      return build(`${species} hotspot ${placeWords(record.lat, record.lon)}`, [score]);
    }
    case "fetch": {
      const source = String(record.source ?? "").toLowerCase();
      const rows = typeof record.rowsIn === "number" ? `${record.rowsIn} record${record.rowsIn === 1 ? "" : "s"} received` : null;
      const failed = str(record.error) ? "the check failed" : null;
      return build(`Data check of ${SOURCE_NAMES[source] ?? feedLabel(source)}`, [when(record.fetchedAt, atMs), rows, failed]);
    }
    default:
      return null;
  }
}

