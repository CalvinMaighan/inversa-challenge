/** Carp test data shaped like the API answers (recorded fixture values, docs/evidence/carp-data-proof.md). */
import { getApp } from "shared/apps";

import { sitesOf, type GqlReading, type Site, type SiteStatus, type Snapshot } from "client/carp/model";

export const CARP_APP = getApp("carp");
export const SITES = sitesOf(CARP_APP.locations);
export const site = (lid: string): Site => SITES.find((s) => s.lid === lid)!;

export const H = 3_600_000;
export const NOW = Date.parse("2026-10-01T09:00:00Z");
export const ZONE = "America/Chicago";

/** A forecast issuance with 6-hourly points `values` starting at `from`. */
export function snap(over: Partial<Snapshot> & { issuedAt: string; values?: number[]; from?: string }): Snapshot {
  const from = Date.parse(over.from ?? over.issuedAt);
  const points = (over.values ?? []).map((v, i) => ({ validAt: new Date(from + i * 6 * H).toISOString(), stageFt: v, flowKcfs: null, category: null }));
  return {
    id: "1",
    site: "KRZL1",
    product: "hml",
    ingestedAt: over.issuedAt,
    source: "IEM_ARCHIVE",
    revision: 0,
    validFrom: points[0]?.validAt ?? null,
    validTo: points.at(-1)?.validAt ?? null,
    horizonEnd: points.at(-1)?.validAt ?? null,
    peakStageFt: null,
    peakAt: null,
    peakCategory: null,
    points,
    ...over,
  };
}

export function status(over: Partial<SiteStatus> = {}): SiteStatus {
  return {
    site: "KRZL1",
    asOf: new Date(NOW).toISOString(),
    observation: { observedAt: "2026-10-01T06:00:00Z", ingestedAt: "2026-10-01T07:01:00Z", source: "NWPS_LIVE", stageFt: 4.05, flowKcfs: null },
    stageFt: 4.05,
    category: "NONE",
    thresholds: { actionFt: 28, minorFt: 29, moderateFt: 40, majorFt: 43 },
    observationFreshness: "AGING",
    conflicts: [],
    activeAlerts: 0,
    ...over,
  };
}

/** USGS readings as stored: stage in metres, discharge in cfs. */
export function usgsReadings(s: Site, rows: { at: string; stageFt?: number; cfs?: number }[], stationId = "6"): GqlReading[] {
  const station = { id: stationId, source: "usgs", name: s.name, lat: s.lat - 0.02, lon: s.lon + 0.01 };
  return rows.flatMap((r) => [
    ...(r.stageFt !== undefined ? [{ param: "STAGE_M", value: r.stageFt * 0.3048, observedAt: r.at, origin: "MEASURED", flag: "OK", station }] : []),
    ...(r.cfs !== undefined ? [{ param: "DISCHARGE_CFS", value: r.cfs, observedAt: r.at, origin: "MEASURED", flag: "OK", station }] : []),
  ]);
}
