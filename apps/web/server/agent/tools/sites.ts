/**
 * Site resolution for conditions apps (carp): the configured locations by NWPS lid, id, name or the town in
 * the name, and the camera presets by name ("Atchafalaya" is the basin's four sites). Pure.
 */

import type { BBox } from "@/shared/agent/events";
import type { AppConfig } from "@/shared/apps";

export type SiteRef = {
  lid: string;
  id: string;
  name: string;
  /** The town or reach after "at", "near" or "above" in the name. */
  short: string;
  lat: number;
  lon: number;
  usgs: string | null;
  office: string | null;
  grid: string | null;
  zones: string[];
  note: string;
  basin: string;
  tidal: boolean;
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Every configured location with an NWPS id. */
export function carpSites(app: AppConfig): SiteRef[] {
  const basinOf = (id: string) => app.cameraPresets?.find((p) => p.locations?.includes(id))?.name ?? "";
  return app.locations
    .filter((l): l is typeof l & { nwps: string } => typeof l.nwps === "string")
    .map((l) => ({
      lid: l.nwps,
      id: l.id,
      name: l.name,
      short: l.name.replace(/^.*\b(at|near|above|below)\b\s+/i, ""),
      lat: l.lat,
      lon: l.lon,
      usgs: l.usgs ?? null,
      office: l.nwsGrid?.office ?? l.nws ?? null,
      grid: l.nwsGrid ? `${l.nwsGrid.x},${l.nwsGrid.y}` : null,
      zones: l.nwsZones ?? [],
      note: l.note ?? "",
      basin: basinOf(l.id),
      tidal: /tidal/i.test(l.note ?? ""),
    }));
}

/** One site by lid, id, name or town; null when nothing matches. */
export function findSite(app: AppConfig, name: string): SiteRef | null {
  const q = norm(name);
  if (!q) return null;
  const all = carpSites(app);
  const exact = all.find((s) => [s.lid, s.id, s.name, s.short].map(norm).includes(q));
  if (exact) return exact;
  return all.find((s) => [s.name, s.short, s.lid, s.id].map(norm).some((n) => n.includes(q) || (q.length >= 4 && q.includes(n)))) ?? null;
}

/**
 * Sites named by lid, id, name, town, or a preset name (the Atchafalaya Basin). No names means every site.
 * An unknown name throws the app's refusal: the tools never answer for places outside the demonstration set.
 */
export function resolveSites(app: AppConfig, names: readonly string[] | undefined): SiteRef[] {
  const all = carpSites(app);
  if (!names || names.length === 0) return all;
  const out = new Map<string, SiteRef>();
  for (const raw of names) {
    const q = norm(raw);
    const preset = (app.cameraPresets ?? []).find((p) => norm(p.name).includes(q) || norm(p.id) === q || (q.length >= 5 && norm(p.name).split(" ").includes(q)));
    if (preset?.locations?.length) {
      for (const id of preset.locations) {
        const site = all.find((s) => s.id === id);
        if (site) out.set(site.lid, site);
      }
      continue;
    }
    if (q === "all" || q === "all sites" || q === "every site") return all;
    const site = findSite(app, raw);
    if (!site) throw new Error(`"${raw}" is not one of the ${all.length} demonstration locations (${all.map((s) => `${s.lid} ${s.short}`).join(", ")}). ${app.agent.refusal}`);
    out.set(site.lid, site);
  }
  return [...out.values()];
}

/** A box around a site, degrees. */
export function siteBox(site: Pick<SiteRef, "lat" | "lon">, halfDeg = 0.15): BBox {
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return { west: r(site.lon - halfDeg), south: r(site.lat - halfDeg), east: r(site.lon + halfDeg), north: r(site.lat + halfDeg) };
}

/** The box around several sites, padded. */
export function sitesBox(list: readonly Pick<SiteRef, "lat" | "lon">[], padDeg = 0.3): BBox {
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return {
    west: r(Math.min(...list.map((s) => s.lon)) - padDeg),
    south: r(Math.min(...list.map((s) => s.lat)) - padDeg),
    east: r(Math.max(...list.map((s) => s.lon)) + padDeg),
    north: r(Math.max(...list.map((s) => s.lat)) + padDeg),
  };
}

/** A web-map zoom level at a point to a box: 360° / 2^zoom across, 2:1 wide, clamped to the globe. */
export function presetBox(preset: { lat: number; lon: number; zoom: number }): BBox {
  const width = 360 / 2 ** preset.zoom;
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return {
    west: r(Math.max(-180, preset.lon - width / 2)),
    south: r(Math.max(-90, preset.lat - width / 4)),
    east: r(Math.min(180, preset.lon + width / 2)),
    north: r(Math.min(90, preset.lat + width / 4)),
  };
}
