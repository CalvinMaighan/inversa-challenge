/**
 * Asian carp sightings for the carp app (`carp_sightings`): silver, bighead, grass and black carp in the Mississippi River
 * Basin, read from the API's stored list (`GET /v1/carp/sightings`: iNaturalist, GBIF and USGS NAS kept in SQLite and
 * refreshed every 30 minutes). Reports, not abundance. Each row is cited as `fish:<id>`; the browser opens that id as the
 * sighting's panel on the map.
 */
import { z } from "zod";

import { resolvePlace } from "client/voice/gazetteer";
import { apiOrigin } from "@/server/agent/config";
import type { CapabilityContext, CapabilityOutput } from "@/server/agent/runtime/registry";
import { evidence } from "@/server/agent/tools/evidence";
import { given, output } from "@/server/agent/tools/shared";
import type { BBox } from "@/shared/agent/events";
import { CARP_SPECIES } from "@/shared/voice/ui-tools";

type Fish = { id: string; source: "inat" | "gbif" | "nas"; species: string; scientificName: string; lat: number; lon: number; date: string | null; url: string; photo: string | null };
type Answer = { fetchedAt: string; sightings: Fish[]; sources: Record<string, number> };

const SOURCE_NAMES = { inat: "iNaturalist", gbif: "GBIF", nas: "USGS NAS" } as const;
const DAY_MS = 86_400_000;
const MAX_ROWS = 25;

const NAMES: Record<(typeof CARP_SPECIES)[number], string> = { silver: "Silver carp", bighead: "Bighead carp", grass: "Grass carp", black: "Black carp" };

const input = z.object({
  species: z.array(z.enum(CARP_SPECIES)).max(4).optional().describe("silver, bighead, grass and/or black. Omit for all four."),
  days: z.number().int().min(1).max(731).optional().describe("Look back this many days from today. Default 730: the two years the map shows. Leave it out unless the user names a period."),
  place: z.string().min(2).max(80).optional().describe("A town, river town or area (St. Louis, Memphis, Baton Rouge, the Atchafalaya): only reports within about 60 km of it. Leave it out for the whole basin."),
  newestFirst: z.boolean().optional().describe("List the newest reports first (default true)."),
});

const inBox = (b: BBox, f: Fish) => f.lat >= b.south && f.lat <= b.north && f.lon >= b.west && f.lon <= b.east;

export const carpSightings = {
  name: "carp_sightings",
  description:
    "Asian carp sightings on the map: silver, bighead, grass and black carp in the Mississippi River Basin, from iNaturalist, GBIF and USGS NAS (stored, refreshed every 30 minutes). Returns the counts per species and per source for the window, the date range, and the newest reports with their evidence ids (cite each as [e:fish:<id>]). Reports are not abundance: more reports can mean more observers. Not river conditions: use the river tools for gauges.",
  inputSchema: input,
  async execute(args: z.infer<typeof input>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const res = await fetch(`${apiOrigin()}/v1/carp/sightings`, { signal: ctx.signal ?? AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`carp sightings unavailable (HTTP ${res.status})`);
    const body = (await res.json()) as Answer;
    const wanted = new Set((args.species ?? CARP_SPECIES).map((s) => NAMES[s]));
    const since = ctx.now.getTime() - (args.days ?? 730) * DAY_MS;
    const hit = given(args.place) ? resolvePlace(given(args.place)!) : null;
    if (given(args.place) && !hit) throw new Error(`carp_sightings: no place named "${args.place}" is known; leave place out for the whole basin`);
    // A town is about 60 km across; an area (the basin, the Atchafalaya) is as wide as the camera that frames it.
    const half = hit ? Math.max(0.55, (hit.altitudeM / 111_000 / 2) * 1.2) : 0;
    const box = hit ? { west: hit.lon - half, east: hit.lon + half, south: hit.lat - half, north: hit.lat + half } : null;
    const rows = body.sightings
      .filter((f) => wanted.has(f.species) && f.date !== null && Date.parse(f.date) >= since && Date.parse(f.date) <= ctx.now.getTime() + DAY_MS && (!box || inBox(box, f)))
      .sort((a, b) => (args.newestFirst === false ? 1 : -1) * ((b.date ?? "").localeCompare(a.date ?? "")));
    const bySpecies: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    for (const f of rows) {
      bySpecies[f.species] = (bySpecies[f.species] ?? 0) + 1;
      bySource[SOURCE_NAMES[f.source]] = (bySource[SOURCE_NAMES[f.source]] ?? 0) + 1;
    }
    const listed = rows.slice(0, MAX_ROWS);
    const evidenceRows = listed.map((f) => evidence("fish", f.id, `${f.species} · ${f.date} · ${SOURCE_NAMES[f.source]}`, f.source));
    const dates = rows.map((f) => f.date!).sort();
    return output(
      {
        ...(hit ? { place: hit.name, placeBox: box } : {}),
        window: { days: args.days ?? 730, from: new Date(since).toISOString().slice(0, 10), to: ctx.now.toISOString().slice(0, 10) },
        total: rows.length,
        bySpecies,
        bySource,
        oldest: dates[0] ?? null,
        newest: dates.at(-1) ?? null,
        dataRefreshed: body.fetchedAt,
        ...(given(args.species?.join("")) ? { speciesAsked: args.species } : {}),
        caveat: "Sightings are reports, not abundance. The three sources overlap a little (the same fish can be reported twice), and USGS NAS and GBIF records arrive weeks late.",
        rows: listed.map((f, i) => ({ evidenceId: evidenceRows[i]!.id, species: f.species, scientificName: f.scientificName, date: f.date, source: SOURCE_NAMES[f.source], lat: Math.round(f.lat * 1e4) / 1e4, lon: Math.round(f.lon * 1e4) / 1e4, link: f.url })),
        ...(rows.length > MAX_ROWS ? { note: `${rows.length} reports; the ${MAX_ROWS} newest are listed.` } : {}),
      },
      evidenceRows,
      [],
      rows.length,
    );
  },
};
