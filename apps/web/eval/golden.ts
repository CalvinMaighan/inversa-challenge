/**
 * Golden questions for the agent eval. Each has the checks the eval applies
 * in both modes, plus a replay plan: the tool calls a good analyst makes and
 * an answer written from the tool results it got back, so replay exercises
 * the real tools, fixture data, citation checks and stream bridge.
 */

import type { MockStep, MockStepInput, MockToolCall } from "@/server/agent/cordis/plugins/mock-llm";
import type { BBox } from "@/shared/agent/events";

type Json = Record<string, unknown>;
type Row = Json & { evidenceId: string };

/** Tool results so far in the turn, by tool name. */
export class Results {
  constructor(private readonly input: MockStepInput) {}

  last(name: string): Json {
    const found = [...this.input.toolResults].reverse().find((result) => result.name === name);
    if (!found || !found.json || typeof found.json !== "object") {
      throw new Error(`replay: no ${name} result (got: ${this.input.toolResults.map((r) => r.name).join(", ") || "none"})`);
    }
    return found.json as Json;
  }

  bbox(name = "geocode"): BBox {
    return this.last(name).bbox as BBox;
  }

  rows(name: string, key = "rows"): Row[] {
    return (this.last(name)[key] as Row[] | undefined) ?? [];
  }

  row(name: string, match: (row: Row) => boolean, key = "rows"): Row {
    const found = this.rows(name, key).find(match);
    if (!found) throw new Error(`replay: no matching ${name} row`);
    return found;
  }

  reading(station: string, param: string, origin?: string): Row {
    return this.row(
      "conditions",
      (row) => String(row.station).startsWith(station) && row.param === param && (!origin || row.origin === origin),
    );
  }

  feed(source: string): Json {
    const feeds = this.last("feed_state").feeds as Json[];
    const found = feeds.find((feed) => feed.source === source);
    if (!found) throw new Error(`replay: no feed ${source}`);
    return found;
  }

  /** Feeds a tool result reported as not nominal, e.g. "ndbc (stale)". */
  unhealthy(name: string): string {
    const feeds = (this.last(name).feeds as Json[]).filter((feed) => feed.state !== "nominal");
    return feeds.map((feed) => `${String(feed.source).toUpperCase()} is ${String(feed.state)}`).join("; ");
  }
}

export type Golden = {
  id: string;
  question: string;
  /** One of the 5 data-quality questions. */
  quality: boolean;
  expect: {
    tools: string[];
    phrases: RegExp[];
    minCitations: number;
    view?: boolean;
    debug?: RegExp;
  };
  steps: ((r: Results) => MockToolCall[])[];
  answer: (r: Results) => string;
};

const e = (row: { evidenceId: string } | Json) => `[e:${String((row as Json).evidenceId)}]`;
const around = (lat: number, lon: number, half = 0.1): BBox => ({
  west: lon - half,
  south: lat - half,
  east: lon + half,
  north: lat + half,
});

export const GOLDEN: Golden[] = [
  {
    id: "python-crews-tonight",
    question: "Where should python crews go tonight?",
    quality: false,
    expect: { tools: ["hotspots", "explain_cell", "conditions"], phrases: [/heuristic/i, /lagging|missing|cloud/i], minCitations: 3 },
    steps: [
      () => [{ name: "hotspots", args: { species: "python", top: 5 } }],
      (r) => {
        const top = r.rows("hotspots", "cells")[0]!;
        return [
          { name: "explain_cell", args: { species: "python", cell: top.cell } },
          {
            name: "conditions",
            args: { bbox: around(Number(top.lat), Number(top.lon)), params: ["lst_c", "air_c", "stage_m"] },
          },
        ];
      },
    ],
    answer(r) {
      const [top, second] = r.rows("hotspots", "cells");
      const terms = r.last("explain_cell").terms as { name: string; rationale: string }[];
      const air = r.reading("Open-Meteo Shark Valley", "air_c");
      const stage = r.reading("USGS NP-205", "stage_m");
      const lst = r.reading("GOES-19 cell Shark Valley", "lst_c");
      return [
        `Send crews to the Shark Valley levees along Tamiami Trail. The top python cell is ${String(top!.cell)} (heuristic score ${String(top!.score)}) ${e(top!)}, then ${String(second!.cell)} ${e(second!)}.`,
        `Why: ${terms.map((term) => `${term.name}: ${term.rationale}`).join("; ")} ${e(r.last("explain_cell"))}.`,
        `Stage at NP-205 is ${String(stage.value)} m (measured) ${e(stage)}; modeled air is ${String(air.value)} °C ${e(air)}.`,
        `Caveats: GOES land surface temperature is missing under cloud at ${String(lst.observedAt)} ${e(lst)}, and ${r.unhealthy("conditions")}. The hotspot score is a heuristic, not a prediction.`,
      ].join(" ");
    },
  },
  {
    id: "iguana-cold-snap",
    question: "Is tonight's cold snap a good iguana capture window around Homestead?",
    quality: false,
    expect: { tools: ["geocode", "conditions", "alerts", "hotspots"], phrases: [/cold/i, /heuristic/i], minCitations: 4 },
    steps: [
      () => [{ name: "geocode", args: { place: "Homestead" } }],
      (r) => [
        { name: "conditions", args: { bbox: r.bbox(), params: ["air_c"] } },
        { name: "alerts", args: { bbox: r.bbox() } },
        { name: "hotspots", args: { species: "iguana", bbox: r.bbox(), top: 3 } },
      ],
    ],
    answer(r) {
      const measured = r.reading("KHST", "air_c", "measured");
      const modeled = r.reading("Open-Meteo Homestead", "air_c", "modeled");
      const advisory = r.row("alerts", (row) => row.event === "Cold Weather Advisory");
      const [cell] = r.rows("hotspots", "cells");
      return [
        `Yes. Measured air at KHST Homestead ARB is ${String(measured.value)} °C ${e(measured)}, below the 10 °C cold-stun threshold, and Open-Meteo models ${String(modeled.value)} °C ${e(modeled)}.`,
        `A Cold Weather Advisory is in effect until ${String(advisory.expires)} ${e(advisory)}.`,
        `Start at cell ${String(cell!.cell)} (heuristic score ${String(cell!.score)}) ${e(cell!)}: canal banks where stunned iguanas drop.`,
      ].join(" ");
    },
  },
  {
    id: "biscayne-dive-conditions",
    question: "What are dive conditions at Biscayne for lionfish removal right now?",
    quality: false,
    expect: { tools: ["geocode", "conditions", "set_view"], phrases: [/stale/i], minCitations: 3, view: true },
    steps: [
      () => [{ name: "geocode", args: { place: "Biscayne" } }],
      (r) => [
        { name: "conditions", args: { bbox: r.bbox(), params: ["wave_m", "wind_ms", "water_c", "sst_c"] } },
        { name: "set_view", args: { bbox: r.bbox() } },
      ],
    ],
    answer(r) {
      const wave = r.reading("FWYF1", "wave_m", "measured");
      const wind = r.reading("FWYF1", "wind_ms", "measured");
      const waveModel = r.reading("Open-Meteo Biscayne", "wave_m", "modeled");
      return [
        `Diveable: waves ${String(wave.value)} m ${e(wave)} and wind ${String(wind.value)} m/s ${e(wind)} at Fowey Rocks, inside the 1.2 m / 8 m/s limits; the model agrees at ${String(waveModel.value)} m ${e(waveModel)}.`,
        `But the Fowey Rocks buoy reading is from ${String(wave.observedAt)}: ${r.unhealthy("conditions")}. Treat the measured values as stale and recheck before launch.`,
      ].join(" ");
    },
  },
  {
    id: "tegu-sightings-homestead",
    question: "Show me recent tegu sightings around Homestead.",
    quality: false,
    expect: { tools: ["geocode", "sightings", "set_view"], phrases: [/research/i], minCitations: 3, view: true },
    steps: [
      () => [{ name: "geocode", args: { place: "Homestead" } }],
      (r) => [
        { name: "sightings", args: { bbox: r.bbox(), species: ["tegu"] } },
        { name: "set_view", args: { bbox: r.bbox() } },
      ],
    ],
    answer(r) {
      const rows = r.rows("sightings");
      return `${rows.length} tegu reports in the last 7 days: ${rows
        .map((row) => `${String(row.quality)} (${String(row.source)}, ${String(row.observedAt)}) ${e(row)}`)
        .join("; ")}. Only the research-grade record is confirmed.`;
    },
  },
  {
    id: "florida-bay-alerts",
    question: "Any NWS alerts in effect for Florida Bay right now?",
    quality: false,
    expect: { tools: ["geocode", "alerts"], phrases: [/small craft/i], minCitations: 1 },
    steps: [() => [{ name: "geocode", args: { place: "Florida Bay" } }], (r) => [{ name: "alerts", args: { bbox: r.bbox() } }]],
    answer(r) {
      const rows = r.rows("alerts");
      return `${rows.map((row) => `${String(row.event)} until ${String(row.expires)} ${e(row)}`).join("; ")}. Alerts come from the NWS API poll: ${r.unhealthy("alerts")}.`;
    },
  },
  {
    id: "python-backtest",
    question: "How well have the python hotspot scores held up over the last two weeks?",
    quality: false,
    expect: { tools: ["backtest"], phrases: [/baseline/i, /heuristic/i], minCitations: 0 },
    steps: [() => [{ name: "backtest", args: { species: "python", days: 14 } }]],
    answer(r) {
      const result = r.last("backtest");
      return `Over ${String(result.days)} days, ${Math.round(Number(result.hitRate) * 100)}% of python sightings fell in the top 10% of cells, against a ${Math.round(Number(result.baseline) * 100)}% baseline (${String(result.lift)}× lift, ${String(result.sightingsScored)} sightings scored). Useful, but it is a heuristic and the sample is small.`;
    },
  },
  {
    id: "explain-top-python-cell",
    question: "Why does the top python cell score so high tonight?",
    quality: false,
    expect: { tools: ["hotspots", "explain_cell"], phrases: [/heuristic/i, /density/i], minCitations: 1 },
    steps: [
      () => [{ name: "hotspots", args: { species: "python", top: 1 } }],
      (r) => [{ name: "explain_cell", args: { species: "python", cell: r.rows("hotspots", "cells")[0]!.cell } }],
    ],
    answer(r) {
      const explained = r.last("explain_cell");
      const terms = explained.terms as { name: string; value: number; rationale: string }[];
      return `Cell ${String(explained.cell)} scores ${String(explained.score)} ${e(explained)} on the heuristic: ${terms
        .map((term) => `${term.name} ${term.value} (${term.rationale})`)
        .join("; ")}.`;
    },
  },
  {
    id: "lionfish-key-largo",
    question: "Where should lionfish divers work near Key Largo, and is the sea state OK?",
    quality: false,
    expect: { tools: ["geocode", "hotspots", "conditions"], phrases: [/stale/i, /heuristic/i], minCitations: 3 },
    steps: [
      () => [{ name: "geocode", args: { place: "Key Largo" } }],
      (r) => [
        { name: "hotspots", args: { species: "lionfish", bbox: r.bbox(), top: 3 } },
        { name: "conditions", args: { bbox: r.bbox(), params: ["wave_m", "wind_ms"] } },
      ],
    ],
    answer(r) {
      const [cell] = r.rows("hotspots", "cells");
      const wave = r.reading("MLRF1", "wave_m", "measured");
      const waveModel = r.reading("Open-Meteo Key Largo", "wave_m", "modeled");
      return [
        `Molasses Reef, cell ${String(cell!.cell)} (heuristic score ${String(cell!.score)}) ${e(cell!)}.`,
        `Sea state looks fine: ${String(wave.value)} m at MLRF1 ${e(wave)} and ${String(waveModel.value)} m modeled ${e(waveModel)}.`,
        `The buoy value is stale (from ${String(wave.observedAt)}; ${r.unhealthy("conditions")}), so the current number is the model's.`,
      ].join(" ");
    },
  },
  {
    id: "iguana-marathon-count",
    question: "How many iguanas were reported around Marathon this week?",
    quality: false,
    expect: {
      tools: ["geocode", "sightings"],
      phrases: [/duplicate/i],
      minCitations: 2,
      debug: /unverified citation removed: sighting:9999/,
    },
    steps: [
      () => [{ name: "geocode", args: { place: "Marathon" } }],
      (r) => [{ name: "sightings", args: { bbox: r.bbox(), species: ["iguana"] } }],
    ],
    answer(r) {
      const result = r.last("sightings");
      const rows = r.rows("sightings");
      const dup = rows.find((row) => row.duplicateOf);
      // The last marker cites a record no tool returned; the bridge must strip it.
      return `${String(result.total)} reports, ${String(result.distinctAnimals)} distinct iguanas: ${rows
        .filter((row) => !row.duplicateOf)
        .map((row) => e(row))
        .join(" ")}. ${String(result.duplicates)} is a duplicate: the GBIF copy ${e(dup!)} of ${String(dup!.duplicateOf)}. One more on Big Pine [e:sighting:9999].`;
    },
  },
  {
    id: "flamingo-view",
    question: "Take me to Flamingo.",
    quality: false,
    expect: { tools: ["geocode", "set_view"], phrases: [/flamingo/i], minCitations: 0, view: true },
    steps: [
      () => [{ name: "geocode", args: { place: "Flamingo" } }],
      (r) => [{ name: "set_view", args: { bbox: r.bbox() } }],
    ],
    answer(r) {
      const place = r.last("geocode");
      return `Flying to ${String(place.name)} (${Number(place.lat).toFixed(3)}, ${Number(place.lon).toFixed(3)}).`;
    },
  },
  // Data-quality questions.
  {
    id: "quality-stale-feeds",
    question: "Which data feeds are stale or down right now?",
    quality: true,
    expect: { tools: ["feed_state"], phrases: [/stale/i, /ndbc/i, /down/i], minCitations: 0 },
    steps: [() => [{ name: "feed_state" }]],
    answer(r) {
      const ndbc = r.feed("ndbc");
      const nwws = r.feed("nwws");
      return `NDBC is stale: newest observation ${String(ndbc.newestObservedAt)}, ${Math.round(Number(ndbc.lagSeconds) / 3600)} h behind (${String(ndbc.note)}). NWWS is down (${String(nwws.note)}). ${r.unhealthy("feed_state")}. Everything else is nominal.`;
    },
  },
  {
    id: "quality-conflict-biscayne-sst",
    question: "Satellite says Biscayne water is warm but the buoy disagrees. Which is right?",
    quality: true,
    expect: {
      tools: ["geocode", "conditions"],
      phrases: [/conflict|disagree/i, /measured|in-situ/i, /stale/i],
      minCitations: 2,
    },
    steps: [
      () => [{ name: "geocode", args: { place: "Biscayne" } }],
      (r) => [{ name: "conditions", args: { bbox: r.bbox(), params: ["water_c", "sst_c"] } }],
    ],
    answer(r) {
      const buoy = r.reading("FWYF1", "water_c", "measured");
      const sat = r.reading("GOES-19 cell Biscayne", "sst_c", "satellite");
      const conflict = (r.last("conditions").conflicts as Json[])[0]!;
      return `They conflict by ${String(conflict.delta)} °C: GOES SST is ${String(sat.value)} °C ${e(sat)}, Fowey Rocks measures ${String(buoy.value)} °C ${e(buoy)}. Trust the in-situ measured buoy value, but it is stale (from ${String(buoy.observedAt)}; ${r.unhealthy("conditions")}).`;
    },
  },
  {
    id: "quality-duplicates-shark-valley",
    question: "How many distinct pythons were reported around Shark Valley this week?",
    quality: true,
    expect: { tools: ["geocode", "sightings"], phrases: [/duplicate/i, /2 distinct/i], minCitations: 2 },
    steps: [
      () => [{ name: "geocode", args: { place: "Shark Valley" } }],
      (r) => [{ name: "sightings", args: { bbox: r.bbox(), species: ["python"] } }],
    ],
    answer(r) {
      const result = r.last("sightings");
      const rows = r.rows("sightings");
      const originals = rows.filter((row) => !row.duplicateOf);
      const dups = rows.filter((row) => row.duplicateOf);
      return `${String(result.distinctAnimals)} distinct pythons ${originals.map(e).join(" ")} from ${String(result.total)} reports. ${dups
        .map((row) => `${String(row.source).toUpperCase()} ${e(row)} is a duplicate of ${String(row.duplicateOf)}`)
        .join("; ")}.`;
    },
  },
  {
    id: "quality-missing-lst",
    question: "What is the land surface temperature at Shark Valley right now?",
    quality: true,
    expect: { tools: ["geocode", "conditions"], phrases: [/missing|cloud/i], minCitations: 2 },
    steps: [
      () => [{ name: "geocode", args: { place: "Shark Valley" } }],
      (r) => [{ name: "conditions", args: { bbox: r.bbox(), params: ["lst_c", "air_c"] } }],
    ],
    answer(r) {
      const lst = r.reading("GOES-19 cell Shark Valley", "lst_c");
      const air = r.reading("Open-Meteo Shark Valley", "air_c");
      return `Missing: the latest GOES land surface temperature (${String(lst.observedAt)}) is flagged ${String(lst.flag)} ${e(lst)}, so there is no value to report; ${r.unhealthy("conditions")}. The nearest substitute is modeled air temperature, ${String(air.value)} °C ${e(air)}.`;
    },
  },
  {
    id: "quality-id-conflict-tegu",
    question: "Are there any tegu reports near Homestead I should double-check before sending a crew?",
    quality: true,
    expect: { tools: ["geocode", "sightings"], phrases: [/conflict/i, /casual/i], minCitations: 2 },
    steps: [
      () => [{ name: "geocode", args: { place: "Homestead" } }],
      (r) => [{ name: "sightings", args: { bbox: r.bbox(), species: ["tegu"] } }],
    ],
    answer(r) {
      const conflict = r.row("sightings", (row) => row.idConflict === true);
      const casual = r.row("sightings", (row) => row.quality === "casual");
      const research = r.row("sightings", (row) => row.quality === "research");
      return `Double-check two: ${e(conflict)} has an ID conflict (the identification changed after ingest), and ${e(casual)} is casual grade. Only ${e(research)} is research grade.`;
    },
  },
];

/** Mock script that replays one golden plan. */
export function replayScript(golden: Golden): (input: MockStepInput) => MockStep {
  return (input) => {
    const results = new Results(input);
    const step = golden.steps[input.step];
    return step ? { toolCalls: step(results) } : { text: golden.answer(results) };
  };
}
