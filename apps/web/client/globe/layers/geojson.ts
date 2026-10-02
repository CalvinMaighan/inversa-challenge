/**
 * GeoJSON polygons out of an alert's `areaGeojson` (NWS polygons, sometimes wrapped in a Feature or a
 * collection). Pure, so malformed payloads are pinned down by tests rather than found on the globe.
 */

/** One polygon: outer ring first, then holes; each ring flat `[lon, lat, lon, lat, …]`, unclosed. */
export type PolygonRings = number[][];

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function ring(coords: unknown): number[] | null {
  if (!Array.isArray(coords)) return null;
  const flat: number[] = [];
  for (const p of coords) {
    if (!Array.isArray(p) || typeof p[0] !== "number" || typeof p[1] !== "number") continue;
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    flat.push(p[0], p[1]);
  }
  // GeoJSON rings repeat the first point last; Cesium closes loops itself.
  const n = flat.length;
  if (n >= 4 && flat[0] === flat[n - 2] && flat[1] === flat[n - 1]) flat.length = n - 2;
  return flat.length >= 6 ? flat : null;
}

function polygon(coords: unknown): PolygonRings | null {
  if (!Array.isArray(coords)) return null;
  const rings = coords.map(ring);
  const outer = rings[0];
  if (!outer) return null;
  return [outer, ...rings.slice(1).filter((r): r is number[] => r !== null)];
}

/** Every polygon in a GeoJSON value; anything unrecognised contributes nothing. */
export function polygonsOf(geojson: unknown, depth = 0): PolygonRings[] {
  if (depth > 4) return [];
  const value = typeof geojson === "string" ? safeParse(geojson) : geojson;
  if (!isObject(value)) return [];
  switch (value.type) {
    case "Polygon": {
      const p = polygon(value.coordinates);
      return p ? [p] : [];
    }
    case "MultiPolygon":
      return Array.isArray(value.coordinates) ? value.coordinates.map(polygon).filter((p): p is PolygonRings => p !== null) : [];
    case "Feature":
      return polygonsOf(value.geometry, depth + 1);
    case "FeatureCollection":
      return Array.isArray(value.features) ? value.features.flatMap((f) => polygonsOf(f, depth + 1)) : [];
    case "GeometryCollection":
      return Array.isArray(value.geometries) ? value.geometries.flatMap((g) => polygonsOf(g, depth + 1)) : [];
    default:
      return [];
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
