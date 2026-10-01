/**
 * Lionfish Watch tools (gates/leaf-AG2.md): `reef_heat` (NOAA Coral Reef Watch SST, anomaly, DHW and BAA at the
 * reef pixels of the four areas, latest or as a daily series), `marine_forecast` (Open-Meteo Marine waves and
 * currents, 72 h), and the component-app forms of `hotspots`, `explain_cell` and `set_view` (the L5 priority
 * heuristic: four components shown separately, `rankScore` only orders cells, never a single risk percent).
 *
 * Honesty rules the outputs carry (docs/LIONFISH_WATCH.md): every value is labelled with its unit, source and
 * date; DHW and BAA always travel together; sightings are reports, not abundance; heat stress is context; field
 * conditions stay apart from the priority. A component app is any species app whose `score.components` are the
 * four lionfish components, so the tools are config-driven, not hard-wired to the lionfish id.
 */

/* eslint-disable inversa/prefer-catalog-constants -- CRW parameter names ("sst") and the words people say for layers are strings the user types, matched against the config's layer ids at run time */
import { z } from "zod";

import type { CapabilityContext, CapabilityOutput, Evidence } from "@/server/agent/runtime/registry";
import { evidence, hotspotKey, readingKey } from "@/server/agent/tools/evidence";
import { inRegion, lookupGazetteer, type Place } from "@/server/agent/tools/gazetteer";
import { gqlWithFeeds, type GqlFeedState } from "@/server/agent/tools/gql";
import { atTime, bboxSchema, feedsFor, given, givenTime, HOUR_MS, localTime, output, resolveBbox, timeSchema } from "@/server/agent/tools/shared";
import { extentOf, MAX_HIGHLIGHT, withView, type ToolViewData } from "@/server/agent/tools/views";
import type { BBox } from "@/shared/agent/events";
import type { CellsView, ExplainView, SeriesView, TableView } from "@/shared/agent/results";
import { appBBox, cellAt, cellCentre, regionAt, type AppConfig, type AppRegion } from "@/shared/apps";

const DAY_MS = 24 * HOUR_MS;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r1 = (v: number) => Math.round(v * 10) / 10;
const ms = (t: string) => Date.parse(t);
const iso = (t: number) => new Date(t).toISOString();
const lower = (s: string) => s.toLowerCase();

// ---------------------------------------------------------------- areas

const COMPONENT_IDS = ["recentReports", "idQuality", "heatStress", "completeness"] as const;

/** A species app scored by the four lionfish components (L5), as opposed to python's density × activity × access. */
export function isComponentApp(app: Pick<AppConfig, "score"> | undefined): boolean {
  const ids = new Set((app?.score?.components ?? []).map((c) => (typeof c === "string" ? c : String((c as { id?: unknown }).id ?? ""))));
  return COMPONENT_IDS.every((id) => ids.has(id));
}

/** Other words people use for each area, on top of its id, name and code. */
const AREA_WORDS: Record<string, string[]> = {
  "fl-keys": ["florida", "florida keys", "the keys", "keys", "south florida", "fl keys", "florida reef tract"],
  "mx-caribbean": ["mexico", "mexican", "mexican caribbean", "quintana roo", "yucatan", "riviera maya", "mesoamerican reef mexico"],
  belize: ["belize", "belizean", "belize barrier reef"],
  "co-caribbean": ["colombia", "colombian", "colombian caribbean", "san andres and providencia", "colombian coast"],
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function areaNames(r: AppRegion): string[] {
  return [r.id, r.name, r.code ?? "", ...(AREA_WORDS[r.id] ?? []), ...r.name.split("/")].map(norm).filter((n) => n.length >= 2);
}

/** The app region a text names (id, name, code or a known alias, exact or as whole words inside the text); null when none. */
export function findArea(app: AppConfig, text: string | undefined): AppRegion | null {
  const q = norm(text ?? "");
  if (!q || q === "all" || q === "all areas" || q === "every area" || q === "four areas") return null;
  for (const r of app.regions) if (areaNames(r).includes(q)) return r;
  let best: { region: AppRegion; length: number } | null = null;
  for (const r of app.regions) {
    for (const n of areaNames(r)) {
      if (n.length >= 4 && new RegExp(`\\b${escape(n)}\\b`).test(q) && (!best || n.length > best.length)) best = { region: r, length: n.length };
    }
  }
  return best?.region ?? null;
}

const areaInput = z.string().min(2).max(60).optional().describe("One area by id or name: fl-keys (Florida Keys), mx-caribbean (Mexican Caribbean), belize, co-caribbean (Colombian Caribbean). Omit for all four.");

function areaOf(ctx: CapabilityContext, lat: number, lon: number): { id: string; name: string; thin: boolean } | null {
  const r = regionAt(ctx.app, lat, lon);
  return r ? { id: r.id, name: r.name, thin: r.thin } : null;
}

/** A place's box: an area, a gazetteer place inside the app's regions, or null. */
function placeBox(app: AppConfig, text: string | undefined): { name: string; bbox: BBox; area: AppRegion | null } | null {
  const s = given(text);
  if (!s) return null;
  const area = findArea(app, s);
  if (area) return { name: area.name, bbox: area.bbox, area };
  const place: Place | null = lookupGazetteer(s);
  if (place && inRegion(app, place.lat, place.lon)) return { name: place.name, bbox: place.bbox, area: regionAt(app, place.lat, place.lon) };
  return null;
}

type GqlReading = {
  station: { id: string; source: string; name: string; lat: number; lon: number; kind: string };
  param: string;
  value: number | null;
  flag: string;
  observedAt: string;
  origin: string;
};

const READINGS_QUERY = `query AgentReadings($bbox: BBox!, $from: Time!, $to: Time!, $params: [Param!]) {
  readings(bbox: $bbox, from: $from, to: $to, params: $params) {
    station { id source name lat lon kind } param value flag observedAt origin
  }
  feeds { ...FeedFields }
}
`;

const ageDays = (now: Date, at: string) => r1((now.getTime() - ms(at)) / DAY_MS);

// ---------------------------------------------------------------- reef_heat

const BAA_LABELS = ["No Stress", "Bleaching Watch", "Bleaching Warning", "Bleaching Alert Level 1", "Bleaching Alert Level 2"];
const baaLabel = (v: number | null) => (v === null ? "missing" : (BAA_LABELS[Math.round(v)] ?? `level ${v}`));

const CRW_NOTE =
  "NOAA Coral Reef Watch CoralTemp v3.1, 5 km daily product (one value per pixel per day at 12:00Z), about 1.7 days behind real time by design. DHW (degree heating weeks, °C-weeks) accumulates heat stress over the last 12 weeks; the bleaching alert level (BAA, 0 to 4) is the current state and needs a HotSpot (SST above the bleaching threshold) of at least 1 °C, so DHW can stay high while BAA drops once the water cools. Always give both, with the product date and its age. Heat stress is context for survey planning, not proof of lionfish damage to a reef.";
const CRW_CREDIT = "Credit NOAA Coral Reef Watch and cite the dataset DOI https://doi.org/10.3390/rs12233856; free to use without restriction.";

const reefHeatInput = z.object({
  area: areaInput,
  place: z.string().min(2).max(80).optional().describe("A reef or town inside the areas (Looe Key, Cozumel, Glover's Reef, San Andrés). Replaces area."),
  bbox: bboxSchema.optional(),
  at: timeSchema.optional().describe("Latest product on or before this time (default: the reference time)."),
  days: z.number().int().min(1).max(90).optional().describe("Days of daily history to return as a series, ending at `at` (default 1: the latest product only). 7 for 'this week', 30 for a month, 90 for the whole archive."),
});

type Daily = { date: string; at: string; sstC: number | null; anomalyC: number | null; dhwCWeeks: number | null; baa: number | null };

/** Keep at most `max` evenly spaced entries, always the first and last. */
function thin<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const keep = new Set<number>([0, rows.length - 1]);
  for (let i = 0; i < max; i++) keep.add(Math.floor((i * rows.length) / max));
  return [...keep].sort((a, b) => a - b).map((i) => rows[i]!);
}

export const reefHeat = {
  name: "reef_heat",
  description:
    "NOAA Coral Reef Watch values at the reef pixels of the four areas: SST (°C), SST anomaly (°C), degree heating weeks (DHW, °C-weeks, accumulated) and bleaching alert level (BAA 0-4, current), latest product or a daily series, each with the product date, its age and a citation per value. DHW and BAA always come together. Use for heat stress now, how it changed, when it peaked, and whether an alert level changed.",
  inputSchema: reefHeatInput,
  async execute(input: z.infer<typeof reefHeatInput>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const place = placeBox(ctx.app, input.place) ?? placeBox(ctx.app, input.area);
    if ((given(input.place) || given(input.area)) && !place) throw new Error(`"${given(input.place) ?? given(input.area)}" is not one of the four areas or a place inside them. ${ctx.app.agent.refusal}`);
    const bbox = resolveBbox(place?.bbox ?? input.bbox ?? appBBox(ctx.app), ctx);
    const at = atTime(input.at, ctx);
    const days = input.days ?? 1;
    // Four days of slack behind `at` so the latest product (1 to 2 days behind) is inside the window.
    const from = iso(ms(at) - (days + 3) * DAY_MS);
    const data = await gqlWithFeeds<{ readings: GqlReading[]; feeds: GqlFeedState[] }>("AgentReadings", READINGS_QUERY, { bbox, from, to: at, params: ["SST", "SST_ANOMALY", "DHW", "BAA"] }, ctx);
    const rows = data.readings.filter((r) => lower(r.station.source) === "crw");
    const byStation = new Map<string, GqlReading[]>();
    for (const r of rows) byStation.set(r.station.id, [...(byStation.get(r.station.id) ?? []), r]);
    const evidenceRows: Evidence[] = [];
    const seen = new Set<string>();
    const cite = (r: GqlReading) => {
      const key = readingKey(r.station.id, r.param, r.observedAt, r.origin);
      if (!seen.has(key)) {
        seen.add(key);
        evidenceRows.push(evidence("reading", key, `${r.station.name} ${lower(r.param)} ${r.value ?? "missing"} · ${r.observedAt.slice(0, 10)}`, "crw"));
      }
      return `[e:reading:${key}]`;
    };
    const paramOf = (list: GqlReading[], p: string) => list.filter((r) => lower(r.param) === p).sort((a, b) => ms(a.observedAt) - ms(b.observedAt));
    const value = (r: GqlReading | undefined) => (r && lower(r.flag) === "ok" ? r.value : null);
    const areas = [...byStation.entries()]
      .map(([station, list]) => {
        const sst = paramOf(list, "sst");
        const anomaly = paramOf(list, "sst_anomaly");
        const dhw = paramOf(list, "dhw");
        const baa = paramOf(list, "baa");
        const latest = { sst: sst.at(-1), anomaly: anomaly.at(-1), dhw: dhw.at(-1), baa: baa.at(-1) };
        const date = latest.dhw?.observedAt ?? latest.baa?.observedAt ?? list[0]!.observedAt;
        const area = areaOf(ctx, list[0]!.station.lat, list[0]!.station.lon);
        const windowStart = ms(at) - days * DAY_MS;
        const inWindow = (r: GqlReading) => ms(r.observedAt) >= windowStart;
        const dayRows: Daily[] = dhw.filter(inWindow).map((d) => ({
          date: d.observedAt.slice(0, 10),
          at: d.observedAt,
          sstC: value(sst.find((r) => r.observedAt === d.observedAt)),
          anomalyC: value(anomaly.find((r) => r.observedAt === d.observedAt)),
          dhwCWeeks: value(d),
          baa: value(baa.find((r) => r.observedAt === d.observedAt)),
        }));
        const first = dayRows[0];
        const last = dayRows.at(-1);
        const peak = dhw.filter(inWindow).filter((r) => value(r) !== null).reduce<GqlReading | null>((best, r) => (!best || r.value! > best.value! ? r : best), null);
        const baaChanges = dayRows.flatMap((row, i) => (i > 0 && row.baa !== null && dayRows[i - 1]!.baa !== null && row.baa !== dayRows[i - 1]!.baa ? [{ date: row.date, from: dayRows[i - 1]!.baa, to: row.baa, label: baaLabel(row.baa) }] : []));
        const firstDhw = dhw.filter(inWindow)[0];
        const firstBaa = baa.filter(inWindow)[0];
        return {
          area: area?.id ?? null,
          areaName: area?.name ?? null,
          thinArea: area?.thin ?? false,
          station,
          stationName: list[0]!.station.name,
          lat: list[0]!.station.lat,
          lon: list[0]!.station.lon,
          productDate: date.slice(0, 10),
          productAt: date,
          dataAge: `${ageDays(ctx.now, date)} days old`,
          latencyDays: ageDays(ctx.now, date),
          sstC: value(latest.sst),
          anomalyC: value(latest.anomaly),
          dhwCWeeks: value(latest.dhw),
          baa: value(latest.baa),
          baaLabel: baaLabel(value(latest.baa)),
          units: { sstC: "°C", anomalyC: "°C above the climatological maximum month", dhwCWeeks: "°C-weeks", baa: "bleaching alert level 0-4" },
          cite: {
            sst: latest.sst ? cite(latest.sst) : null,
            anomaly: latest.anomaly ? cite(latest.anomaly) : null,
            dhw: latest.dhw ? cite(latest.dhw) : null,
            baa: latest.baa ? cite(latest.baa) : null,
          },
          ...(days > 1 && dayRows.length
            ? {
                series: {
                  days,
                  from: first?.date ?? null,
                  to: last?.date ?? null,
                  points: dayRows.length,
                  dhwStart: first?.dhwCWeeks ?? null,
                  dhwEnd: last?.dhwCWeeks ?? null,
                  dhwChange: first?.dhwCWeeks !== null && first?.dhwCWeeks !== undefined && last?.dhwCWeeks !== null && last?.dhwCWeeks !== undefined ? r2(last.dhwCWeeks - first.dhwCWeeks) : null,
                  dhwPeak: peak ? { dhwCWeeks: peak.value, date: peak.observedAt.slice(0, 10), cite: cite(peak) } : null,
                  baaStart: first?.baa ?? null,
                  baaEnd: last?.baa ?? null,
                  baaChanges,
                  citeStart: { dhw: firstDhw ? cite(firstDhw) : null, baa: firstBaa ? cite(firstBaa) : null },
                  missingDays: dayRows.filter((row) => row.dhwCWeeks === null).map((row) => row.date),
                  daily: thin(dayRows, 31).map((row) => ({ date: row.date, sstC: row.sstC, anomalyC: row.anomalyC, dhwCWeeks: row.dhwCWeeks, baa: row.baa })),
                },
              }
            : {}),
        };
      })
      .sort((a, b) => (a.area ?? "").localeCompare(b.area ?? "") || a.stationName.localeCompare(b.stationName));
    const covered = new Set(areas.map((a) => a.area));
    const missingAreas = ctx.app.regions.filter((r) => !covered.has(r.id) && (!place || place.area?.id === r.id)).map((r) => r.name);
    const feeds = feedsFor(data.feeds, ["crw"], ["crw"]);
    const series: SeriesView = {
      view: "series",
      title: days > 1 ? `Degree heating weeks · last ${days} days` : "Degree heating weeks · latest product",
      unit: "°C-weeks",
      series: [...byStation.entries()].slice(0, 8).map(([station, list]) => ({
        label: list[0]!.station.name,
        evidenceId: areas.find((a) => a.station === station)?.cite.dhw?.slice(3, -1),
        points: paramOf(list, "dhw")
          .filter((r) => ms(r.observedAt) >= ms(at) - days * DAY_MS)
          .map((r) => [ms(r.observedAt), value(r)] as [number, number | null]),
      })),
    };
    const table: TableView = {
      view: "table",
      title: "Reef heat stress · NOAA Coral Reef Watch",
      columns: [
        { key: "area", label: "Area", kind: "text" },
        { key: "station", label: "Pixel", kind: "text" },
        { key: "date", label: "Product day", kind: "time" },
        { key: "sst", label: "SST", unit: "°C", kind: "number" },
        { key: "anomaly", label: "Anomaly", unit: "°C", kind: "number" },
        { key: "dhw", label: "DHW", unit: "°C-weeks", kind: "number" },
        { key: "baa", label: "Alert level", kind: "quality" },
      ],
      rows: areas.map((a) => ({ evidenceId: a.cite.dhw?.slice(3, -1) ?? `reading:${a.station}`, area: a.areaName, station: a.stationName, date: a.productAt, sst: a.sstC, anomaly: a.anomalyC, dhw: a.dhwCWeeks, baa: a.baaLabel, sourcePageUrl: "https://coralreefwatch.noaa.gov/product/5km/index.php" })),
    };
    const view: ToolViewData = { result: days > 1 ? series : table, more: days > 1 ? [table] : [], highlight: evidenceRows.slice(0, MAX_HIGHLIGHT).map((e) => e.id), bbox: extentOf(areas, 0.2) ?? bbox };
    return withView(
      output(
        {
          asOf: at,
          asOfLocal: localTime(ctx.app, at),
          source: "NOAA Coral Reef Watch (crw)",
          note: CRW_NOTE,
          credit: CRW_CREDIT,
          ...(place ? { place: place.name } : {}),
          areas,
          ...(missingAreas.length ? { missingAreas, missingNote: `No CRW product stored for ${missingAreas.join(", ")} in this window: say the heat stress there is unknown, not zero.` } : {}),
          baaLabels: BAA_LABELS.map((label, i) => `${i} = ${label}`).join("; "),
        },
        evidenceRows,
        feeds,
        areas.length,
      ),
      view,
    );
  },
};

// ---------------------------------------------------------------- marine_forecast

const MARINE_NOTE =
  "Open-Meteo Marine forecast (modelled, not measured; MeteoFrance wave and current models; CC BY 4.0, free tier for non-commercial use): wave height (m), wave period (s), current speed (stored in m/s; km/h = m/s × 3.6; the API publishes km/h) and current direction (degrees). Field conditions for planning dives only: separate from the survey priority score, which never uses them (end the answer with the sentence: Field conditions are separate from the priority score). The horizon is 72 hours from the model run; nothing can be said beyond it. Never say a dive is safe or unsafe: give the numbers and let the team judge.";
const CALM_WAVE_M = 1.2;
const MARINE_HORIZON_H = 72;

const marineInput = z
  .object({
    area: areaInput,
    place: z.string().min(2).max(80).optional().describe("A reef or town inside the areas (Cozumel, Banco Chinchorro, Glover's Reef, San Andrés, Looe Key)."),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    bbox: bboxSchema.optional(),
    days: z.number().int().min(1).max(3).optional().describe("Days ahead, 1 to 3 (the 72 h horizon). Default 3."),
  })
  .describe("Give one of area, place, lat+lon or bbox; nothing for every forecast point of the four areas.");

type Slot = Partial<Record<"wave_m" | "wave_period_s" | "current_ms" | "current_dir_deg", number | null>>;

export const marineForecast = {
  name: "marine_forecast",
  description:
    "Open-Meteo Marine hourly forecast (modelled) for the next 72 hours at reef points of the four areas or one place: wave height (m), wave period (s), current speed (m/s and km/h) and direction, with daily summaries (max, mean, calm hours under 1.2 m) and the fetch time. Field conditions only, kept apart from the survey priority. Use for waves, currents, calm windows, 'when' questions, and dive-safety questions (answer with the numbers, never a safety verdict).",
  inputSchema: marineInput,
  async execute(input: z.infer<typeof marineInput>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const named = given(input.place) ?? given(input.area);
    const place = placeBox(ctx.app, input.place) ?? placeBox(ctx.app, input.area);
    if (named && !place) throw new Error(`"${named}" is not one of the four areas or a place inside them. ${ctx.app.agent.refusal}`);
    const point = input.lat !== undefined && input.lon !== undefined ? { lat: input.lat, lon: input.lon } : null;
    if (point && !inRegion(ctx.app, point.lat, point.lon)) throw new Error(`${point.lat}, ${point.lon} is outside the four areas. ${ctx.app.agent.refusal}`);
    const asked = point ? { west: point.lon - 0.35, south: point.lat - 0.35, east: point.lon + 0.35, north: point.lat + 0.35 } : (place?.bbox ?? input.bbox ?? appBBox(ctx.app));
    // A reef's own box is small; the nearest forecast point can sit a few km outside it.
    const bbox = resolveBbox(place && !place.area ? { west: asked.west - 0.3, south: asked.south - 0.3, east: asked.east + 0.3, north: asked.north + 0.3 } : asked, ctx);
    const days = input.days ?? 3;
    const now = ctx.now.getTime();
    const horizon = Math.min(days * 24, MARINE_HORIZON_H);
    const data = await gqlWithFeeds<{ readings: GqlReading[]; feeds: GqlFeedState[] }>(
      "AgentReadings",
      READINGS_QUERY,
      { bbox, from: iso(now - HOUR_MS), to: iso(now + horizon * HOUR_MS), params: ["WAVE_M", "WAVE_PERIOD_S", "CURRENT_MS", "CURRENT_DIR_DEG"] },
      ctx,
    );
    const rows = data.readings.filter((r) => lower(r.origin) === "modeled" && lower(r.station.source).startsWith("openmeteo"));
    const byStation = new Map<string, Map<string, Slot>>();
    const stationOf = new Map<string, GqlReading["station"]>();
    for (const r of rows) {
      stationOf.set(r.station.id, r.station);
      const slots = byStation.get(r.station.id) ?? new Map<string, Slot>();
      const slot = slots.get(r.observedAt) ?? {};
      slot[lower(r.param) as keyof Slot] = lower(r.flag) === "ok" ? r.value : null;
      slots.set(r.observedAt, slot);
      byStation.set(r.station.id, slots);
    }
    // Nearest point first when a single point was asked for.
    const dist = (s: GqlReading["station"]) => (point ? Math.hypot(s.lat - point.lat, s.lon - point.lon) : 0);
    const stationIds = [...byStation.keys()].sort((a, b) => dist(stationOf.get(a)!) - dist(stationOf.get(b)!) || a.localeCompare(b));
    const chosen = point ? stationIds.slice(0, 1) : stationIds;
    const feed = data.feeds.find((f) => f.source === "openmeteo-marine") ?? data.feeds.find((f) => f.source.startsWith("openmeteo")) ?? null;
    const evidenceRows: Evidence[] = [];
    const seen = new Set<string>();
    const cite = (station: GqlReading["station"], param: string, at: string, label: string) => {
      const key = readingKey(station.id, param, at, "modeled");
      if (!seen.has(key)) {
        seen.add(key);
        evidenceRows.push(evidence("reading", key, `${station.name} ${param} · ${label}`, feed?.source ?? "openmeteo-marine"));
      }
      return `[e:reading:${key}]`;
    };
    const localDate = (at: string) => localTime(ctx.app, at).slice(0, 10);
    const weekday = (at: string) => new Intl.DateTimeFormat("en-US", { timeZone: ctx.app.copy.timezone, weekday: "long" }).format(new Date(at));
    const points = chosen.map((id) => {
      const station = stationOf.get(id)!;
      const slots = [...byStation.get(id)!.entries()].sort((a, b) => ms(a[0]) - ms(b[0]));
      const hourly = slots.map(([at, slot]) => ({ at, slot }));
      const days = new Map<string, { at: string; slot: Slot }[]>();
      for (const h of hourly) days.set(localDate(h.at), [...(days.get(localDate(h.at)) ?? []), h]);
      const daily = [...days.entries()].map(([date, list]) => {
        const waves = list.filter((h) => typeof h.slot.wave_m === "number");
        const currents = list.filter((h) => typeof h.slot.current_ms === "number");
        const maxWave = waves.reduce<{ at: string; slot: Slot } | null>((best, h) => (!best || h.slot.wave_m! > best.slot.wave_m! ? h : best), null);
        const maxCurrent = currents.reduce<{ at: string; slot: Slot } | null>((best, h) => (!best || h.slot.current_ms! > best.slot.current_ms! ? h : best), null);
        return {
          date,
          weekday: weekday(list[0]!.at),
          hours: list.length,
          waveMinM: waves.length ? r2(Math.min(...waves.map((h) => h.slot.wave_m!))) : null,
          waveMeanM: waves.length ? r2(waves.reduce((s, h) => s + h.slot.wave_m!, 0) / waves.length) : null,
          waveMaxM: maxWave ? r2(maxWave.slot.wave_m!) : null,
          waveMaxAt: maxWave?.at ?? null,
          calmHours: waves.filter((h) => h.slot.wave_m! < CALM_WAVE_M).length,
          currentMaxMs: maxCurrent ? r2(maxCurrent.slot.current_ms!) : null,
          currentMaxKmh: maxCurrent ? r2(maxCurrent.slot.current_ms! * 3.6) : null,
          cite: maxWave ? cite(station, "wave_m", maxWave.at, `max wave ${r2(maxWave.slot.wave_m!)} m on ${date}`) : null,
          citeCurrent: maxCurrent ? cite(station, "current_ms", maxCurrent.at, `max current ${r2(maxCurrent.slot.current_ms!)} m/s on ${date}`) : null,
        };
      });
      const first = hourly[0];
      const last = hourly.at(-1);
      const allWaves = hourly.filter((h) => typeof h.slot.wave_m === "number").map((h) => h.slot.wave_m!);
      const calmest = daily.filter((d) => d.waveMaxM !== null).reduce<(typeof daily)[number] | null>((best, d) => (!best || d.waveMaxM! < best.waveMaxM! ? d : best), null);
      const trend = first && last && typeof first.slot.wave_m === "number" && typeof last.slot.wave_m === "number" ? (last.slot.wave_m - first.slot.wave_m > 0.2 ? "building" : first.slot.wave_m - last.slot.wave_m > 0.2 ? "dropping" : "steady") : null;
      return {
        station: station.id,
        name: station.name,
        area: areaOf(ctx, station.lat, station.lon)?.id ?? null,
        areaName: areaOf(ctx, station.lat, station.lon)?.name ?? null,
        lat: station.lat,
        lon: station.lon,
        ...(point ? { distanceDeg: r2(dist(station)) } : {}),
        coverage: { from: first?.at ?? null, to: last?.at ?? null, hours: hourly.length },
        waveTrend: trend,
        waveMaxM: allWaves.length ? r2(Math.max(...allWaves)) : null,
        waveMinM: allWaves.length ? r2(Math.min(...allWaves)) : null,
        calmestDay: calmest ? { date: calmest.date, weekday: calmest.weekday, waveMaxM: calmest.waveMaxM, cite: calmest.cite } : null,
        daily,
        hourly: hourly
          .filter((_, i) => i % 3 === 0)
          .slice(0, 26)
          .map((h) => ({
            at: h.at,
            atLocal: localTime(ctx.app, h.at),
            waveM: h.slot.wave_m ?? null,
            wavePeriodS: h.slot.wave_period_s ?? null,
            currentMs: h.slot.current_ms ?? null,
            currentKmh: typeof h.slot.current_ms === "number" ? r2(h.slot.current_ms * 3.6) : null,
            currentDirDeg: h.slot.current_dir_deg ?? null,
          })),
      };
    });
    const ranked = [...points].filter((p) => p.waveMaxM !== null).sort((a, b) => a.waveMaxM! - b.waveMaxM!).map((p) => ({ station: p.station, name: p.name, area: p.area, waveMaxM: p.waveMaxM, calmHours: p.daily.reduce((s, d) => s + d.calmHours, 0) }));
    const feeds = feedsFor(data.feeds, feed ? [feed.source] : [], ["openmeteo"]);
    const series: SeriesView = {
      view: "series",
      title: `Wave height forecast · next ${horizon} h`,
      unit: "m",
      series: points.slice(0, 8).map((p) => ({
        label: p.name,
        evidenceId: p.daily[0]?.cite?.slice(3, -1),
        points: [...byStation.get(p.station)!.entries()].sort((a, b) => ms(a[0]) - ms(b[0])).map(([at, slot]) => [ms(at), slot.wave_m ?? null] as [number, number | null]),
      })),
    };
    const table: TableView = {
      view: "table",
      title: "Daily wave and current summary",
      columns: [
        { key: "point", label: "Point", kind: "text" },
        { key: "date", label: "Day", kind: "text" },
        { key: "waveMax", label: "Wave max", unit: "m", kind: "number" },
        { key: "waveMean", label: "Wave mean", unit: "m", kind: "number" },
        { key: "calm", label: "Calm hours", kind: "number" },
        { key: "current", label: "Current max", unit: "km/h", kind: "number" },
      ],
      rows: points.flatMap((p) => p.daily.map((d) => ({ evidenceId: d.cite?.slice(3, -1) ?? `reading:${p.station}`, point: p.name, date: `${d.weekday} ${d.date}`, waveMax: d.waveMaxM, waveMean: d.waveMeanM, calm: d.calmHours, current: d.currentMaxKmh, sourcePageUrl: "https://open-meteo.com/en/docs/marine-weather-api" }))),
    };
    return withView(
      output(
        {
          source: `Open-Meteo Marine (${feed?.source ?? "openmeteo-marine"})`,
          note: MARINE_NOTE,
          fetchedAt: feed?.lastFetchAt ?? null,
          fetchedLocal: feed?.lastFetchAt ? localTime(ctx.app, feed.lastFetchAt) : null,
          fetchedAge: feed?.lastFetchAt ? `${r1((now - ms(feed.lastFetchAt)) / HOUR_MS)} hours old` : null,
          horizonHours: MARINE_HORIZON_H,
          horizonEnd: iso(now + MARINE_HORIZON_H * HOUR_MS),
          horizonEndLocal: localTime(ctx.app, now + MARINE_HORIZON_H * HOUR_MS),
          beyondHorizon: "Anything later than the horizon end cannot be said: the model gives 72 hours, nothing more.",
          calmThresholdM: CALM_WAVE_M,
          ...(place ? { place: place.name } : {}),
          ...(point ? { asked: point } : {}),
          ...(points.length === 0 ? { missing: "No Open-Meteo Marine forecast stored for this place in the next 72 hours." } : {}),
          citeNote: "Every wave or current number you quote carries its row's cite marker (daily rows: cite and citeCurrent); at least one marker per point you name.",
          calmestFirst: ranked,
          points,
        },
        evidenceRows,
        feeds,
        points.length,
      ),
      { result: points.length ? series : table, more: points.length ? [table] : [], highlight: evidenceRows.slice(0, MAX_HIGHLIGHT).map((e) => e.id), bbox: extentOf(points, 0.2) ?? bbox },
    );
  },
};

// ---------------------------------------------------------------- hotspots (components)

const PRIORITY_NOTE =
  "Survey priority heuristic: four components in [0, 1], each with its own state (ok, unknown, stale) and shown separately: recent reports (kernel-weighted independent reports by observed date, normalised per area), ID quality (share of research-grade reports with precise positions), heat stress (CRW DHW /8 and alert level /4, combined by max) and data completeness (lowers confidence, never the rank). rankScore is a weighted mean of the first three and only orders cells. It is not a probability, a risk, an invasion-risk percent or a population estimate; a thin area has no rankScore (unknown is not zero). Sightings are not abundance. Heat stress is context, not proof of lionfish damage. Field conditions (fieldWindow) are planning context and never enter the rank.";

const COMPONENT_FIELDS = "id value state weight rationale inputs";
const HOT_EVIDENCE_FIELDS = "id kind observedAt submittedAt ingestedAt weight detail url";
const cellFields = (withEvidence: boolean) => {
  const c = withEvidence ? `${COMPONENT_FIELDS} evidence { ${HOT_EVIDENCE_FIELDS} }` : COMPONENT_FIELDS;
  return `cell lat lon score regionId rankScore thin
    components { recentReports { ${c} } idQuality { ${c} } heatStress { ${c} } completeness { ${c} } }
    heat { dhw baa sst anomaly observedAt ingestedAt station credit }
    fieldWindow { state issuedAt waveMaxM waveMinM calmHours horizonHours currentMaxMs station }`;
};

const HOTSPOTS_QUERY = `query AgentHotspots($species: ID!, $at: Time!, $bbox: BBox!, $top: Int, $region: ID, $weights: HotspotWeightsInput, $basis: HotspotBasis) {
  hotspots(species: $species, at: $at, bbox: $bbox, top: $top, region: $region, weights: $weights, basis: $basis) {
    species at basis weights { recentReports idQuality heatStress }
    cells { ${cellFields(false)} }
  }
  feeds { ...FeedFields }
}
`;

const EXPLAIN_QUERY = `query AgentExplainCell($cell: ID!, $species: ID!, $at: Time!, $weights: HotspotWeightsInput, $basis: HotspotBasis) {
  explainCell(cell: $cell, species: $species, at: $at, weights: $weights, basis: $basis) {
    ${cellFields(true)}
    species at basis weights { recentReports idQuality heatStress } caveats credit
  }
  feeds { ...FeedFields }
}
`;

type GqlHotEvidence = { id: string; kind: string; observedAt: string | null; submittedAt: string | null; ingestedAt: string | null; weight: number | null; detail: string; url: string | null };
type GqlComponent = { id: string; value: number | null; state: string; weight: number; rationale: string; inputs: string[]; evidence?: GqlHotEvidence[] };
type GqlHeat = { dhw: number | null; baa: number | null; sst: number | null; anomaly: number | null; observedAt: string; ingestedAt: string; station: string; credit: string } | null;
type GqlFieldWindow = { state: string; issuedAt: string | null; waveMaxM: number | null; waveMinM: number | null; calmHours: number | null; horizonHours: number; currentMaxMs: number | null; station: string } | null;
type GqlCell = {
  cell: string;
  lat: number;
  lon: number;
  score: number;
  regionId: string | null;
  rankScore: number | null;
  thin: boolean | null;
  components: { recentReports: GqlComponent; idQuality: GqlComponent; heatStress: GqlComponent; completeness: GqlComponent } | null;
  heat: GqlHeat;
  fieldWindow: GqlFieldWindow;
};
type GqlWeights = { recentReports: number; idQuality: number; heatStress: number } | null;
type GqlGrid = { species: string; at: string; basis: string | null; weights: GqlWeights; cells: GqlCell[] };
type GqlExplain = GqlCell & { species: string; at: string; basis: string | null; weights: GqlWeights; caveats: string[]; credit: string | null };

const basisInput = z.enum(["submitted", "observed"]).optional().describe("What the frame knew: submitted (default; by the date a report reached the feed) or observed (by the date of the dive).");
const weightsInput = z
  .object({ recentReports: z.number().min(0).optional(), idQuality: z.number().min(0).optional(), heatStress: z.number().min(0).optional() })
  .optional()
  .describe("Rank weight overrides (each >= 0, not all 0). completeness never ranks.");

/** Feed a hotspot input record came from, from the API's detail text ("inat research grade…", "gbif record: duplicate…"). */
function feedOfDetail(detail: string, id: string): string | undefined {
  const m = /^(inat|gbif|nas)\b/i.exec(detail);
  if (m) return lower(m[1]!);
  if (id.startsWith("reading:")) return "crw";
  return /inaturalist/i.test(detail) ? "inat" : undefined;
}

function componentOut(c: GqlComponent, cite: (id: string) => string | null) {
  return {
    value: c.value,
    state: lower(c.state),
    weight: c.weight,
    rationale: c.rationale,
    inputs: c.inputs.slice(0, 8),
    citeInputs: c.inputs
      .slice(0, 8)
      .map(cite)
      .filter((m): m is string => m !== null),
    ...(c.evidence && c.evidence.length
      ? {
          evidence: c.evidence.slice(0, 20).map((e) => ({
            id: e.id,
            cite: cite(e.id),
            kind: e.kind,
            observedAt: e.observedAt,
            submittedAt: e.submittedAt,
            lagDays: e.observedAt && e.submittedAt ? r1((ms(e.submittedAt) - ms(e.observedAt)) / DAY_MS) : null,
            weight: e.weight,
            counted: e.weight !== null,
            detail: e.detail,
            url: e.url,
          })),
        }
      : {}),
  };
}

function heatOut(h: GqlHeat, now: Date, cite: (id: string) => string | null) {
  if (!h) return { state: "unknown", note: "no CRW product within reach: heat stress unknown, not zero" };
  const key = (p: string) => `reading:${h.station}:${p}:${ms(h.observedAt)}:satellite`;
  return {
    dhwCWeeks: h.dhw,
    baa: h.baa,
    baaLabel: baaLabel(h.baa),
    sstC: h.sst,
    anomalyC: h.anomaly,
    productDate: h.observedAt.slice(0, 10),
    dataAge: `${ageDays(now, h.observedAt)} days old`,
    station: h.station,
    cite: { dhw: cite(key("dhw")), baa: cite(key("baa")), sst: cite(key("sst")), anomaly: cite(key("sst_anomaly")) },
    credit: h.credit,
  };
}

function fieldWindowOut(f: GqlFieldWindow) {
  if (!f) return { state: "unknown" };
  return { state: lower(f.state), issuedAt: f.issuedAt, waveMaxM: f.waveMaxM, waveMinM: f.waveMinM, calmHours: f.calmHours, horizonHours: f.horizonHours, currentMaxMs: f.currentMaxMs, currentMaxKmh: f.currentMaxMs === null ? null : r2(f.currentMaxMs * 3.6), station: f.station, note: "planning context from Open-Meteo Marine, never part of the rank" };
}

/** Evidence rows a cell contributes: its hotspot id, its CRW readings (feed crw) and, when explained, its input records. */
function cellEvidence(app: AppConfig, species: string, at: string, cell: GqlCell, now: Date, evidenceRows: Evidence[], seen: Set<string>): { id: string; cite: (id: string) => string | null } {
  const add = (row: Evidence) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    evidenceRows.push(row);
  };
  const id = `hotspot:${hotspotKey(species, cell.cell, at)}`;
  add(evidence("hotspot", hotspotKey(species, cell.cell, at), `${species} cell ${cell.cell}${cell.regionId ? ` (${cell.regionId})` : ""} rankScore ${cell.rankScore ?? "none (thin)"}`));
  if (cell.heat) {
    for (const p of ["dhw", "baa", "sst", "sst_anomaly"]) {
      const value = p === "dhw" ? cell.heat.dhw : p === "baa" ? cell.heat.baa : p === "sst" ? cell.heat.sst : cell.heat.anomaly;
      add(evidence("reading", `${cell.heat.station}:${p}:${ms(cell.heat.observedAt)}:satellite`, `CRW ${p} ${value ?? "missing"} at ${cell.heat.station} · ${cell.heat.observedAt.slice(0, 10)}`, "crw"));
    }
  }
  for (const c of Object.values(cell.components ?? {})) {
    for (const e of c.evidence ?? []) {
      const kind = e.kind === "sighting" ? "sighting" : e.kind === "reading" ? "reading" : null;
      if (!kind) continue;
      const key = e.id.slice(kind.length + 1);
      add(evidence(kind, key, `${e.detail.slice(0, 80)} · ${e.observedAt?.slice(0, 10) ?? ""}`, feedOfDetail(e.detail, e.id)));
    }
  }
  const cite = (ref: string) => (seen.has(ref) ? `[e:${ref}]` : null);
  void app;
  void now;
  return { id, cite };
}

function cellOut(app: AppConfig, species: string, at: string, cell: GqlCell, now: Date, evidenceRows: Evidence[], seen: Set<string>) {
  const { id, cite } = cellEvidence(app, species, at, cell, now, evidenceRows, seen);
  const region = app.regions.find((r) => r.id === cell.regionId) ?? regionAt(app, cell.lat, cell.lon);
  const c = cell.components;
  return {
    evidenceId: id,
    cite: `[e:${id}]`,
    cell: cell.cell,
    area: region?.id ?? null,
    areaName: region?.name ?? null,
    lat: cell.lat,
    lon: cell.lon,
    rankScore: cell.rankScore,
    thin: cell.thin ?? region?.thin ?? false,
    ...(cell.thin || region?.thin ? { thinNote: "thin area: too few recent independent reports for a ranked score; recent reports unknown (not zero); heat stress and history still shown" } : {}),
    components: c
      ? {
          recentReports: componentOut(c.recentReports, cite),
          idQuality: componentOut(c.idQuality, cite),
          heatStress: componentOut(c.heatStress, cite),
          completeness: componentOut(c.completeness, cite),
        }
      : null,
    heat: heatOut(cell.heat, now, cite),
    fieldWindow: fieldWindowOut(cell.fieldWindow),
  };
}

const hotspotsInput = (species: z.ZodType<string>) =>
  z.object({
    species,
    area: areaInput,
    region: z.string().min(2).max(60).optional().describe("Same as area (region id)."),
    bbox: bboxSchema.optional(),
    at: timeSchema.optional().describe("Rank as of this time (default: the reference time); a past time replays what was known then."),
    top: z.number().int().min(1).max(50).optional().describe("How many cells (default 10)."),
    basis: basisInput,
    weights: weightsInput,
  });

export const lionfishHotspots = (species: z.ZodType<string>) => ({
  name: "hotspots",
  description:
    "Survey priority cells (L5 heuristic): top cells of one area or all four, each with the four components separately (recent reports, ID quality, heat stress, completeness; value, state, weight, rationale), the CRW heat values (DHW and alert level together), the 72 h field window and rankScore (orders cells only; thin areas have none). Never a single risk percent. Use explain_cell for a cell's records.",
  inputSchema: hotspotsInput(species),
  async execute(input: z.infer<ReturnType<typeof hotspotsInput>>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const named = given(input.area) ?? given(input.region);
    const area = named ? findArea(ctx.app, named) : null;
    if (named && !area) throw new Error(`"${named}" is not one of the four areas (${ctx.app.regions.map((r) => `${r.id} ${r.name}`).join("; ")}). ${ctx.app.agent.refusal}`);
    const bbox = resolveBbox(area?.bbox ?? input.bbox ?? appBBox(ctx.app), ctx);
    const at = atTime(input.at, ctx);
    const data = await gqlWithFeeds<{ hotspots: GqlGrid; feeds: GqlFeedState[] }>(
      "AgentHotspots",
      HOTSPOTS_QUERY,
      { species: input.species, at, bbox, top: input.top ?? 10, region: area?.id ?? null, weights: input.weights ?? null, basis: input.basis ? input.basis.toUpperCase() : null },
      ctx,
    );
    const grid = data.hotspots;
    const evidenceRows: Evidence[] = [];
    const seen = new Set<string>();
    const cells = grid.cells.map((cell) => cellOut(ctx.app, grid.species, grid.at, cell, ctx.now, evidenceRows, seen));
    const byArea = ctx.app.regions
      .filter((r) => !area || r.id === area.id)
      .map((r) => {
        const own = cells.filter((c) => c.area === r.id);
        const top = own[0];
        return { area: r.id, name: r.name, thin: r.thin || (own.length > 0 && own.every((c) => c.thin)), cells: own.length, topCell: top ? { cell: top.cell, rankScore: top.rankScore, cite: top.cite } : null, note: own.length === 0 ? "no scored cell in this area at this time" : r.thin || own.every((c) => c.thin) ? "thin area: no rankScore; recent reports unknown, heat stress and history shown" : null };
      });
    const feeds = feedsFor(data.feeds, ["inat", "gbif", "nas", "crw"], ["inat", "crw"]);
    const view: CellsView = {
      view: "cells",
      title: `Survey priority · ${area ? area.name : "four areas"} · heuristic`,
      species: grid.species,
      at: grid.at,
      cells: cells.map((c) => ({ cell: c.cell, lat: c.lat, lon: c.lon, score: c.rankScore ?? 0, evidenceId: c.evidenceId })),
    };
    return withView(
      output(
        {
          species: grid.species,
          at: grid.at,
          atLocal: localTime(ctx.app, grid.at),
          basis: lower(grid.basis ?? "submitted"),
          weights: grid.weights,
          heuristic: true,
          note: PRIORITY_NOTE,
          ...(area ? { area: area.id, areaName: area.name } : { scope: "all four areas; recent reports are normalised per area, so cells are comparable within an area, and the rank across areas is a heuristic order only" }),
          ...(cells[0]
            ? { topCell: { cell: cells[0].cell, area: cells[0].area, rankScore: cells[0].rankScore, cite: cells[0].cite, evidenceId: cells[0].evidenceId, next: `For the records and rationale behind it (how the score is built, which reports counted), call explain_cell with cell "${cells[0].cell}"; for its stored record, call evidence with id "${cells[0].evidenceId}".` } }
            : {}),
          byArea,
          cells,
        },
        evidenceRows,
        feeds,
        cells.length,
      ),
      { result: view, highlight: cells.slice(0, MAX_HIGHLIGHT).map((c) => c.evidenceId), bbox: extentOf(cells, 0.1) ?? bbox },
    );
  },
});

// ---------------------------------------------------------------- explain_cell (components)

const explainInput = (species: z.ZodType<string>) =>
  z
    .object({
      species,
      cell: z
        .string()
        .regex(/^(?:[a-z][a-z0-9-]*:)?\d+:\d+$/)
        .optional()
        .describe("Cell id as hotspots returned it ('<area>:<col>:<row>')."),
      lat: z.number().min(-90).max(90).optional(),
      lon: z.number().min(-180).max(180).optional(),
      area: areaInput.describe("An area instead of a cell: explains its top cell."),
      at: timeSchema.optional(),
      basis: basisInput,
      weights: weightsInput,
    })
    .refine((v) => v.cell !== undefined || (v.lat !== undefined && v.lon !== undefined) || v.area !== undefined, "give cell, lat and lon, or area");

/** Multi-region cell id for a point: `<region>:<col>:<row>` on that region's grid. */
export function componentCellFor(app: AppConfig, lat: number, lon: number): string | null {
  const region = regionAt(app, lat, lon);
  return region ? `${region.id}:${cellAt(region, lat, lon)}` : null;
}

export function componentCellCentre(app: AppConfig, cell: string): { lat: number; lon: number } | null {
  const m = /^(?:([a-z][a-z0-9-]*):)?(\d+:\d+)$/.exec(cell);
  if (!m) return null;
  const region = m[1] ? app.regions.find((r) => r.id === m[1]) : app.regions[0];
  return region ? cellCentre(region, m[2]!) : null;
}

export const lionfishExplainCell = (species: z.ZodType<string>) => ({
  name: "explain_cell",
  description:
    "Why one cell (or an area's top cell) ranks where it does: the four components with value, state, weight, rationale and every record behind them (sightings with observed and submitted dates, weights, duplicates not counted; the CRW pixel values with their product date), the field window, the caveats and the CRW credit. Cite the hotspot id, the sighting ids and the CRW reading ids it returns.",
  inputSchema: explainInput(species),
  async execute(input: z.infer<ReturnType<typeof explainInput>>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const at = atTime(input.at, ctx);
    let cell = given(input.cell);
    if (!cell && input.lat !== undefined && input.lon !== undefined) {
      cell = componentCellFor(ctx.app, input.lat, input.lon) ?? undefined;
      if (!cell) throw new Error(`${input.lat}, ${input.lon} is outside the four areas. ${ctx.app.agent.refusal}`);
    }
    if (!cell) {
      const area = findArea(ctx.app, input.area);
      if (!area) throw new Error(`"${input.area}" is not one of the four areas. ${ctx.app.agent.refusal}`);
      const grid = await gqlWithFeeds<{ hotspots: GqlGrid; feeds: GqlFeedState[] }>("AgentHotspots", HOTSPOTS_QUERY, { species: input.species, at, bbox: area.bbox, top: 1, region: area.id, weights: input.weights ?? null, basis: input.basis ? input.basis.toUpperCase() : null }, ctx);
      const top = grid.hotspots.cells[0];
      if (!top) throw new Error(`no scored cell in ${area.name} at ${at}: the area has no recent reports to rank (unknown is not zero).`);
      cell = top.cell;
    }
    const data = await gqlWithFeeds<{ explainCell: GqlExplain; feeds: GqlFeedState[] }>("AgentExplainCell", EXPLAIN_QUERY, { cell, species: input.species, at, weights: input.weights ?? null, basis: input.basis ? input.basis.toUpperCase() : null }, ctx);
    const explained = data.explainCell;
    const evidenceRows: Evidence[] = [];
    const seen = new Set<string>();
    const out = cellOut(ctx.app, explained.species, explained.at, explained, ctx.now, evidenceRows, seen);
    const centre = componentCellCentre(ctx.app, explained.cell);
    const feeds = feedsFor(data.feeds, ["inat", "gbif", "nas", "crw"], ["inat", "crw"]);
    const c = explained.components;
    const view: ExplainView = {
      view: "explain",
      title: `Why ${explained.species} cell ${explained.cell} ranks ${explained.rankScore ?? "unranked (thin)"}`,
      evidenceId: out.evidenceId,
      score: explained.rankScore ?? 0,
      terms: c
        ? [c.recentReports, c.idQuality, c.heatStress, c.completeness].map((t) => ({ name: t.id, value: t.value ?? 0, rationale: `${lower(t.state)} · weight ${t.weight} · ${t.rationale}` }))
        : [],
    };
    const bbox = centre ? extentOf([centre], 0.05) : null;
    return withView(
      output(
        {
          ...out,
          at: explained.at,
          atLocal: localTime(ctx.app, explained.at),
          basis: lower(explained.basis ?? "submitted"),
          weights: explained.weights,
          heuristic: true,
          note: PRIORITY_NOTE,
          ...(() => {
            const top = (explained.components?.recentReports.evidence ?? []).filter((e) => e.kind === "sighting" && e.weight !== null).sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0];
            return top ? { topReport: { id: top.id, cite: `[e:${top.id}]`, observedAt: top.observedAt, submittedAt: top.submittedAt, next: `To show where this report comes from (its page, dates and licence), call evidence with id "${top.id}".` } } : {};
          })(),
          caveats: explained.caveats,
          credit: explained.credit,
          centre,
        },
        evidenceRows,
        feeds,
        c ? 4 : 0,
      ),
      { result: view, highlight: evidenceRows.slice(0, MAX_HIGHLIGHT).map((e) => e.id), ...(bbox ? { bbox } : {}) },
    );
  },
});

// ---------------------------------------------------------------- set_view (component app)

/** Words for the app's layers: what the user says to what the config lists. */
const LAYER_WORDS: Record<string, string> = {
  heat: "heat",
  "heat stress": "heat",
  "reef heat": "heat",
  crw: "heat",
  dhw: "heat",
  bleaching: "heat",
  priority: "hotspots",
  hotspots: "hotspots",
  hotspot: "hotspots",
  "survey priority": "hotspots",
  score: "hotspots",
  ranking: "hotspots",
  marine: "marine",
  waves: "marine",
  wave: "marine",
  currents: "marine",
  "field window": "marine",
  fieldwindow: "marine",
  "field-window": "marine",
  "field conditions": "marine",
  sightings: "sightings",
  reports: "sightings",
  sighting: "sightings",
  sst: "sst",
  "sea surface temperature": "sst",
  satellite: "sst",
  stations: "stations",
  buoys: "stations",
  buoy: "stations",
  notes: "notes",
  "field notes": "notes",
  missions: "missions",
  peers: "peers",
  teammates: "peers",
};

const ALL_AREAS = "all-areas";

const setViewInput = z.object({
  area: areaInput.describe("Frame one of the four areas by id or name (fl-keys, mx-caribbean, belize, co-caribbean), or 'all' for the four together."),
  preset: z.string().min(2).max(60).optional().describe("Same as area: a camera preset is one area or 'all-areas'."),
  region: z.string().min(2).max(60).optional().describe("Same as area (region id)."),
  bbox: bboxSchema.optional().describe("Frame this box instead of an area."),
  layers: z.array(z.string().min(2).max(40)).max(10).optional().describe("Layers to show: heat (reef heat stress), priority (survey priority cells), marine (waves and currents, the field window), sightings, sst, stations, notes, missions. Omit to leave the layers as they are."),
  basis: basisInput.describe("Priority basis toggle: submitted (what the frame knew by submission date) or observed."),
  time: timeSchema.optional().describe("Timeline time to move to (a past date replays that day). Defaults to the reference time."),
  asOf: timeSchema.optional().describe("Knowledge time for replay: show what was known at this time (reports by submission date, the CRW product then). Sets the timeline and the replay flag."),
});

export const lionfishSetView = {
  name: "set_view",
  description:
    "Fly the globe to one of the four areas (or all of them) or a box, switch layers on (heat, priority, marine, sightings, sst, stations, notes), toggle the priority basis (submitted or observed), and move the timeline or set a knowledge time (asOf) for replay. Call it once when the answer is about a place, a layer, a past moment or a replay.",
  inputSchema: setViewInput,
  async execute(input: z.infer<typeof setViewInput>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const named = given(input.area) ?? given(input.preset) ?? given(input.region);
    const all = named !== undefined && /^(all|all[- ]areas|every area|four areas|everything)$/i.test(named);
    const area = named && !all ? findArea(ctx.app, named) : null;
    if (named && !all && !area) throw new Error(`"${named}" is not one of the four areas (${ctx.app.regions.map((r) => `${r.id} ${r.name}`).join("; ")}). ${ctx.app.agent.refusal}`);
    const bbox = resolveBbox(area ? area.bbox : all ? appBBox(ctx.app) : (input.bbox ?? appBBox(ctx.app)), ctx);
    const known = new Set(ctx.app.layers.map((l) => l.id));
    const unknown: string[] = [];
    const layers = [...new Set((input.layers ?? []).map((raw) => {
      const key = norm(raw);
      const id = LAYER_WORDS[key] ?? (known.has(key) ? key : null);
      if (!id || !known.has(id)) unknown.push(raw);
      return id && known.has(id) ? id : null;
    }).filter((l): l is string => l !== null))];
    const asOfText = givenTime(input.asOf);
    const asOf = asOfText ? ms(asOfText) : undefined;
    const time = asOf !== undefined ? iso(asOf) : atTime(input.time, ctx);
    const preset = area ? area.id : ALL_AREAS;
    const region = area?.id;
    const basis = input.basis;
    ctx.emit({
      type: "view",
      bbox,
      time,
      preset,
      ...(region ? { region, area: region } : {}),
      ...(layers.length ? { layers } : {}),
      ...(basis ? { basis } : {}),
      ...(asOf !== undefined ? { asOf, replay: true } : {}),
    });
    return output(
      {
        bbox,
        time,
        timeLocal: localTime(ctx.app, time),
        preset,
        ...(area ? { area: area.id, areaName: area.name, thin: area.thin } : { area: ALL_AREAS, areaName: "the four areas" }),
        ...(layers.length ? { layers } : {}),
        ...(unknown.length ? { unknownLayers: unknown, knownLayers: [...known] } : {}),
        ...(basis ? { basis } : {}),
        ...(asOf !== undefined ? { asOf: iso(asOf), replay: true } : {}),
        applied: true,
      },
      [],
      [],
      1,
    );
  },
};

export const lionfishTools = [reefHeat, marineForecast];
