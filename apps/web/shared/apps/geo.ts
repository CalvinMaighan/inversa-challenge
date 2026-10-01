/**
 * Region lookups over an app config (PLAN.md C-A3, C-A4): what used to be the `REGION_BBOX` and `SPECIES_IDS`
 * constants, now read from the active app. Pure.
 */
import { taxonKey, type AppConfig, type AppRegion, type BBox, type LayerId } from "./schema";

/** The box around every region of the app (one region for carp and python, four for lionfish). */
export function appBBox(app: AppConfig): BBox {
  const [first, ...rest] = app.regions;
  const out = { ...first!.bbox };
  for (const r of rest) {
    out.west = Math.min(out.west, r.bbox.west);
    out.south = Math.min(out.south, r.bbox.south);
    out.east = Math.max(out.east, r.bbox.east);
    out.north = Math.max(out.north, r.bbox.north);
  }
  return out;
}

/** The region whose grid anchors evidence cell ids (C14 `<col>:<row>`): the first one. */
export function primaryRegion(app: AppConfig): AppRegion {
  return app.regions[0]!;
}

export function inBBox(b: BBox, lat: number, lon: number): boolean {
  return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
}

/** The first region containing the point, or null. */
export function regionAt(app: AppConfig, lat: number, lon: number): AppRegion | null {
  return app.regions.find((r) => inBBox(r.bbox, lat, lon)) ?? null;
}

const overlaps = (a: BBox, b: BBox) => a.west < b.east && b.west < a.east && a.south < b.north && b.south < a.north;

/**
 * `b` cut to the app's extent, or null when it touches none of the app's regions (open sea between lionfish's
 * four areas is inside their union box but in no area, so it is refused too).
 */
export function clampToApp(app: AppConfig, b: BBox): BBox | null {
  if (!app.regions.some((r) => overlaps(r.bbox, b))) return null;
  const a = appBBox(app);
  const out = { west: Math.max(a.west, b.west), south: Math.max(a.south, b.south), east: Math.min(a.east, b.east), north: Math.min(a.north, b.north) };
  return out.west < out.east && out.south < out.north ? out : null;
}

/** Focus species filter keys, in config order: `taxa.id` is position + 1 (C-A4 TaxonIdx). */
export function speciesIds(app: AppConfig): string[] {
  return app.taxa.map(taxonKey);
}

export function hasLayer(app: AppConfig, layer: LayerId): boolean {
  return app.layers.includes(layer);
}

/** Cell id `<col>:<row>` on `region`'s grid, anchored at its south-west corner. */
export function cellAt(region: AppRegion, lat: number, lon: number, cellDeg: number = region.cellDeg): string {
  const col = Math.floor((lon - region.bbox.west) / cellDeg + 1e-9);
  const row = Math.floor((lat - region.bbox.south) / cellDeg + 1e-9);
  return `${col}:${row}`;
}

/** Centre of a `<col>:<row>` cell on `region`'s grid, or null for a malformed id or one outside the region. */
export function cellCentre(region: AppRegion, cell: string, cellDeg: number = region.cellDeg): { lat: number; lon: number } | null {
  const m = /^(\d+):(\d+)$/.exec(cell);
  if (!m) return null;
  const lon = region.bbox.west + (Number(m[1]) + 0.5) * cellDeg;
  const lat = region.bbox.south + (Number(m[2]) + 0.5) * cellDeg;
  return lon > region.bbox.east || lat > region.bbox.north ? null : { lat, lon };
}

/** Grid size of `region` at `cellDeg`. */
export function gridSize(region: AppRegion, cellDeg: number = region.cellDeg): { cols: number; rows: number } {
  return {
    cols: Math.round((region.bbox.east - region.bbox.west) / cellDeg),
    rows: Math.round((region.bbox.north - region.bbox.south) / cellDeg),
  };
}

/** A string from `copy`, or the fallback. */
export function copyText(app: AppConfig, key: string, fallback: string): string {
  const v = app.copy[key];
  return typeof v === "string" && v.trim() ? v : fallback;
}

/** IANA zone of the app's local times (`copy.timezone`); Florida's when the config names none. */
export function appTimeZone(app: AppConfig): string {
  return copyText(app, "timezone", "America/New_York");
}

/** One line for the legend header: the legend string, or its `title`. */
export function legendTitle(app: AppConfig): string | null {
  const l = app.legend;
  if (typeof l === "string") return l;
  if (!Array.isArray(l) && typeof (l as { title?: unknown }).title === "string") return (l as { title: string }).title;
  return null;
}
