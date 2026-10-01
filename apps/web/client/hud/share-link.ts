/**
 * Share links: camera, time, layers and selection in the URL hash (PRD §12, after God's Eye View `sharelink.js`).
 *
 * The hash is a URLSearchParams string, readable by a person and stable under round trip:
 *
 *   #v=2&app=python&c=25.76170,-80.19180,45000,12.5,-62.0&t=2026-09-30T20:30Z&l=sightings,hotspots&sp=python&e=sighting:123
 *
 * - `app` (v=2, PLAN.md C-A5): the app the view belongs to. Species keys and layers are that app's. A `v=1` link
 *   predates the apps and decodes as python (the Everglades build it was made in).
 * - `c`: lat, lon (5 decimals, about 1 m), altitude in metres, heading and pitch in degrees (1 decimal).
 * - `t`: the TIME cursor, UTC to the minute (frames are 15-minute steps, so nothing finer exists).
 * - `l`: visible layers, explicit, so layers hidden by default come back on too. Empty means none visible.
 * - `sp`: species filter keys shown (the app's species), omitted when it is the app's default (shown).
 * - `e`: selected evidence id (PLAN.md C14).
 * - `site`, `asof` (carp): the selected location's NWPS id and the "what we knew" time, UTC to the minute; no
 *   `asof` means live.
 * - `look`, `scope`, `feather` (docs/GODS_EYE.md GC2): the visual preset, the scope mask (`0` off) and its edge
 *   feather (0..100), each omitted at its default (normal, on, 11).
 *
 * Decoding is defensive: a link is untrusted input, so each field is validated and clamped, and a bad field is
 * dropped instead of failing the whole link. Encode and decode are pure; `client/hud/ShareLinkSync.tsx` wires
 * them to the store and `history.replaceState`.
 */
import { LAYER_IDS } from "shared/voice/ui-tools";

import { activeApp, V1_APP } from "client/state/app";
import { layersFor, type SpeciesId } from "client/state/layers";
import { DEFAULT_LOOK, DEFAULT_SCOPE_FEATHER, DEFAULT_SCOPE_ON, featherOf, isLookId, type LookId } from "client/state/look";
import { parseEvidenceId } from "client/state/selection";
import { getApp, isAppId, speciesIds, type AppConfig, type AppId } from "shared/apps";

export type LayerId = (typeof LAYER_IDS)[number];
export type { SpeciesId };

export type ShareCamera = { lat: number; lon: number; altitudeM: number; heading: number; pitch: number };

export type ShareState = {
  /** The app the view belongs to (v=2). */
  app?: AppId;
  camera?: ShareCamera;
  /** RFC 3339 UTC. */
  at?: string;
  /** Visible layers. */
  layers?: LayerId[];
  /** Species filter keys shown; absent means the default filter. */
  species?: SpeciesId[];
  evidenceId?: string | null;
  /** Carp (conditions apps): the selected location's NWPS id and the "what we knew" time (absent: live). */
  site?: string;
  asOf?: string;
  /** The globe's look (GC2); absent means the default. */
  look?: LookId;
  scope?: boolean;
  feather?: number;
};

/** An app's default species filter as a shown-key list. */
export function defaultSpecies(app: AppConfig): SpeciesId[] {
  const { species } = layersFor(app);
  return speciesIds(app).filter((id) => species[id] === true);
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v) => b.includes(v));

export const SHARE_LINK_VERSION = 2;
/** An NWPS location id (`KRZL1`); the store checks it against the app's locations. */
const SITE_ID = /^[A-Za-z0-9]{3,8}$/;
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

/** State → hash body (no leading `#`). Fields left undefined are omitted; species defaults are those of `state.app`. */
export function encodeShareLink(state: ShareState): string {
  const params = new URLSearchParams();
  params.set("v", String(SHARE_LINK_VERSION));
  if (state.app) params.set("app", state.app);
  const app = state.app ? getApp(state.app) : activeApp();
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
  if (state.species && !sameList(state.species, defaultSpecies(app))) {
    params.set("sp", speciesIds(app).filter((id) => state.species!.includes(id)).join(","));
  }
  if (state.evidenceId && parseEvidenceId(state.evidenceId)) params.set("e", state.evidenceId);
  if (state.site && SITE_ID.test(state.site)) params.set("site", state.site);
  if (state.asOf) {
    const k = compactIso(state.asOf);
    if (k) params.set("asof", k);
  }
  if (state.look && state.look !== DEFAULT_LOOK && isLookId(state.look)) params.set("look", state.look);
  if (state.scope !== undefined && state.scope !== DEFAULT_SCOPE_ON) params.set("scope", state.scope ? "1" : "0");
  if (state.feather !== undefined && featherOf(state.feather) !== DEFAULT_SCOPE_FEATHER) params.set("feather", String(featherOf(state.feather)));
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

/**
 * Hash (with or without `#`) → the fields it carries. `v=2` carries its app (an unknown or missing one leaves
 * `app` out); `v=1` (and a hash with no version) decodes as python. Unknown versions and invalid fields decode to
 * nothing. Species keys are checked against the link's app.
 */
export function decodeShareLink(hash: string): ShareState {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const version = params.get("v") ?? "1";
  if (version !== "1" && version !== String(SHARE_LINK_VERSION)) return {};
  const out: ShareState = {};
  const linkApp = version === "1" ? V1_APP : params.get("app");
  if (isAppId(linkApp)) out.app = linkApp;
  const app = out.app ? getApp(out.app) : activeApp();
  const camera = decodeCamera(params.get("c"));
  if (camera) out.camera = camera;
  const t = params.get("t");
  if (t && Number.isFinite(Date.parse(t))) out.at = new Date(Date.parse(t)).toISOString();
  const layers = decodeList(params.get("l"), LAYER_IDS);
  if (layers) out.layers = layers;
  const species = decodeList(params.get("sp"), speciesIds(app));
  if (species) out.species = species;
  const e = params.get("e");
  if (e && parseEvidenceId(e)) out.evidenceId = e;
  const site = params.get("site");
  if (site && SITE_ID.test(site)) out.site = site.toUpperCase();
  const asof = params.get("asof");
  if (asof && Number.isFinite(Date.parse(asof))) out.asOf = new Date(Date.parse(asof)).toISOString();
  const look = params.get("look");
  if (isLookId(look)) out.look = look;
  const scope = params.get("scope");
  if (scope === "0" || scope === "1") out.scope = scope === "1";
  const feather = params.get("feather");
  if (feather !== null && /^\d{1,3}$/.test(feather) && Number(feather) <= 100) out.feather = Number(feather);
  return out;
}

/**
 * True when the hash carries at least one view field. An app alone (the bare `#v=1` an empty old link decodes
 * to) is not a view.
 */
export function hasShareFields(state: ShareState): boolean {
  return Object.keys(state).some((k) => k !== "app");
}
