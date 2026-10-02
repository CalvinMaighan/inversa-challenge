/** Hand-built lionfish records in the shapes the API returns (fixture values from docs/evidence/data-proof.md). */
import { getApp } from "shared/apps";

import { areasOf, DAY, HOUR, type GqlReading, type PriorityCell, type Report } from "client/lionfish/model";

export const LIONFISH_APP = getApp("lionfish");
export const AREAS = areasOf(LIONFISH_APP);
export const NOW = Date.parse("2026-10-01T09:00:00Z");

let next = 1;
export function report(p: Partial<Report> & { observed: string; submitted?: string | null }): Report {
  const { observed, submitted, ...rest } = p;
  return {
    id: String(next++),
    source: "inat",
    extId: String(400000000 + next),
    lat: 24.6,
    lon: -81.3,
    accuracyM: 30,
    observedMs: Date.parse(observed),
    submittedMs: submitted === undefined ? Date.parse(observed) + 2 * DAY : submitted === null ? null : Date.parse(submitted),
    ingestedMs: NOW,
    quality: "RESEARCH",
    photoUrl: null,
    duplicateOf: null,
    conflict: false,
    areaId: "fl-keys",
    ...rest,
  };
}

const station = (id: string, source: string, lat: number, lon: number, kind = "grid") => ({ id, source, name: `${source} ${id}`, lat, lon, kind });

export function crw(id: string, lat: number, lon: number, day: string, v: { sst?: number; anomaly?: number; dhw?: number | null; baa?: number | null }): GqlReading[] {
  const s = station(id, "crw", lat, lon);
  const at = `${day}T12:00:00Z`;
  const row = (param: string, value: number | null | undefined): GqlReading => ({ param, value: value ?? null, flag: value === null || value === undefined ? "MISSING" : "OK", observedAt: at, origin: "SATELLITE", station: s });
  return [row("SST", v.sst), row("SST_ANOMALY", v.anomaly), row("DHW", v.dhw), row("BAA", v.baa)];
}

export function buoy(id: string, lat: number, lon: number, at: string, valueC: number | null, param = "WATER_C"): GqlReading {
  return { param, value: valueC, flag: valueC === null ? "MISSING" : "OK", observedAt: at, origin: "MEASURED", station: station(id, "ndbc", lat, lon, "buoy") };
}

export function marine(id: string, lat: number, lon: number, fromMs: number, waves: number[], currentMs = 0.3): GqlReading[] {
  const s = station(id, "openmeteo-marine", lat, lon);
  return waves.flatMap((w, i) => [
    { param: "WAVE_M", value: w, flag: "OK", observedAt: new Date(fromMs + i * HOUR).toISOString(), origin: "MODELED", station: s },
    { param: "CURRENT_MS", value: currentMs, flag: "OK", observedAt: new Date(fromMs + i * HOUR).toISOString(), origin: "MODELED", station: s },
  ]);
}

export function cell(id: string, regionId: string, lat: number, lon: number, rankScore: number, over: Partial<PriorityCell> = {}): PriorityCell {
  return {
    cell: `${regionId}:${id}`,
    lat,
    lon,
    regionId,
    rankScore,
    thin: false,
    components: { recentReports: { value: 0.8, state: "OK" }, idQuality: { value: 0.5, state: "OK" }, heatStress: { value: null, state: "UNKNOWN" }, completeness: { value: 0.4, state: "OK" } },
    ...over,
  };
}
