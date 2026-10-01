/**
 * Share links: camera, time, layers and selection in the URL hash (PRD §12, after God's Eye View `sharelink.js`).
 *
 * The hash is a URLSearchParams string, readable by a person and stable under round trip:
 *
 *   #v=1&c=25.76170,-80.19180,45000,12.5,-62.0&t=2026-09-30T20:30Z&l=sightings,hotspots&sp=python&e=sighting:123
 *
 * - `c`: lat, lon (5 decimals, about 1 m), altitude in metres, heading and pitch in degrees (1 decimal).
 * - `t`: the TIME cursor, UTC to the minute (frames are 15-minute steps, so nothing finer exists).
 * - `l`: visible layers, explicit, so layers hidden by default come back on too. Empty means none visible.
 * - `sp`: species filter keys shown (the four focus species and the groups `animals`, `plants`, `others`),
 *   omitted when it is the default (every focus species and animals on, plants and others off).
 * - `st`: taxon overrides on top of the groups (T44): taxon ids shown, hidden ones with a leading `-`.
 * - `w`: the sightings window in hours (48, 168 or 720), omitted at the default.
 * - `e`: selected evidence id (PLAN.md C14).
 *
 * Decoding is defensive: a link is untrusted input, so each field is validated and clamped, and a bad field is
 * dropped instead of failing the whole link. Encode and decode are pure; `client/hud/ShareLinkSync.tsx` wires
 * them to the store and `history.replaceState`.
 */
import { LAYER_IDS } from "shared/voice/ui-tools";

import { isWindowHours, LAYERS, SPECIES_FILTER_IDS, type SpeciesFilterId } from "client/state/layers";
import { parseEvidenceId } from "client/state/selection";
import type { SightingWindowHours } from "shared/frames";

export type LayerId = (typeof LAYER_IDS)[number];
export type SpeciesId = SpeciesFilterId;

export type ShareCamera = { lat: number; lon: number; altitudeM: number; heading: number; pitch: number };

export type ShareState = {
  camera?: ShareCamera;
  /** RFC 3339 UTC. */
  at?: string;
  /** Visible layers. */
  layers?: LayerId[];
  /** Species filter keys shown; absent means the default filter. */
  species?: SpeciesId[];
  /** Taxon overrides: `[taxon id, shown]`, sorted by id. */
  taxa?: [number, boolean][];
  /** Sightings window, hours. */
  hours?: SightingWindowHours;
  evidenceId?: string | null;
};

/** The default species filter as a shown-key list. */
export const DEFAULT_SPECIES: readonly SpeciesId[] = SPECIES_FILTER_IDS.filter((id) => LAYERS.defaults.species[id]);

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v) => b.includes(v));

export const SHARE_LINK_VERSION = 1;
const MAX_ALTITUDE_M = 20_000_000;
const MIN_ALTITUDE_M = 1;

const round = (value: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};

/** Trim trailing zeros so `45000.0` prints as `45000` and links stay short. */
const num = (value: number, decimals: number) => String(round(value, decimals));

const wrapHeading = (deg: number) => ((deg % 360) + 360) % 360;
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/** `2026-09-30T20:30:00.000Z` → `2026-09-30T20:30Z`. */
export function compactIso(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.round(ms / 60_000) * 60_000).toISOString().replace(":00.000Z", "Z");
}

/** State → hash body (no leading `#`). Fields left undefined are omitted. */
export function encodeShareLink(state: ShareState): string {
  const params = new URLSearchParams();
  params.set("v", String(SHARE_LINK_VERSION));
  const c = state.camera;
  if (c && [c.lat, c.lon, c.altitudeM, c.heading, c.pitch].every(Number.isFinite)) {
    params.set(
      "c",
      [num(c.lat, 5), num(c.lon, 5), num(c.altitudeM, 0), num(wrapHeading(c.heading), 1), num(c.pitch, 1)].join(","),
    );
  }
  if (state.at) {
    const t = compactIso(state.at);
    if (t) params.set("t", t);
  }
  if (state.layers) params.set("l", LAYER_IDS.filter((id) => state.layers!.includes(id)).join(","));
  if (state.species && !sameList(state.species, DEFAULT_SPECIES)) {
    params.set("sp", SPECIES_FILTER_IDS.filter((id) => state.species!.includes(id)).join(","));
  }
  if (state.taxa && state.taxa.length > 0) {
    params.set("st", [...state.taxa].sort((a, b) => a[0] - b[0]).map(([id, shown]) => `${shown ? "" : "-"}${id}`).join(","));
  }
  if (state.hours !== undefined && state.hours !== LAYERS.defaults.sightingHours) params.set("w", String(state.hours));
  if (state.evidenceId && parseEvidenceId(state.evidenceId)) params.set("e", state.evidenceId);
  // `,` and `:` are legal in a fragment (RFC 3986) and URLSearchParams reads them back raw; unescaped, the
  // link stays readable.
  return params.toString().replace(/%2C/g, ",").replace(/%3A/g, ":");
}

function decodeCamera(raw: string | null): ShareCamera | undefined {
  if (!raw) return undefined;
  const parts = raw.split(",").map(Number);
  if (parts.length !== 5 || !parts.every(Number.isFinite)) return undefined;
  const [lat, lon, altitudeM, heading, pitch] = parts as [number, number, number, number, number];
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  return {
    lat,
    lon,
    altitudeM: clamp(altitudeM, MIN_ALTITUDE_M, MAX_ALTITUDE_M),
    heading: wrapHeading(heading),
    pitch: clamp(pitch, -90, 90),
  };
}

function decodeList<T extends string>(raw: string | null, allowed: readonly T[]): T[] | undefined {
  if (raw === null) return undefined;
  const wanted = new Set(raw.split(",").filter(Boolean));
  return allowed.filter((id) => wanted.has(id));
}

/** Hash (with or without `#`) → the fields it carries. Unknown versions and invalid fields decode to nothing. */
export function decodeShareLink(hash: string): ShareState {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const version = params.get("v");
  if (version !== null && version !== String(SHARE_LINK_VERSION)) return {};
  const out: ShareState = {};
  const camera = decodeCamera(params.get("c"));
  if (camera) out.camera = camera;
  const t = params.get("t");
  if (t && Number.isFinite(Date.parse(t))) out.at = new Date(Date.parse(t)).toISOString();
  const layers = decodeList(params.get("l"), LAYER_IDS);
  if (layers) out.layers = layers;
  const species = decodeList(params.get("sp"), SPECIES_FILTER_IDS);
  if (species) out.species = species;
  const st = params.get("st");
  if (st !== null) {
    const seen = new Map<number, boolean>();
    for (const item of st.split(",")) {
      const m = /^(-?)(\d{1,9})$/.exec(item.trim());
      if (m && Number(m[2]) > 0 && !seen.has(Number(m[2]))) seen.set(Number(m[2]), m[1] === "");
    }
    if (seen.size > 0) out.taxa = [...seen].sort((a, b) => a[0] - b[0]);
  }
  const w = Number(params.get("w"));
  if (isWindowHours(w)) out.hours = w;
  const e = params.get("e");
  if (e && parseEvidenceId(e)) out.evidenceId = e;
  return out;
}

/** True when the hash carries at least one share-link field. */
export function hasShareFields(state: ShareState): boolean {
  return Object.keys(state).length > 0;
}
