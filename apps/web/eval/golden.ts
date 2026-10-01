/**
 * Golden questions for the live agent eval, asked against the fixture GraphQL
 * stub (eval/stub-server.ts). Each lists the tools a good analyst must call,
 * phrases the answer must contain, and how many verified citations it needs.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { supportedQuestions, type QuestionFile } from "@/shared/apps/questions";

export type Golden = {
  id: string;
  question: string;
  /** One of the 5 data-quality questions. */
  quality: boolean;
  /** Question category (spec/apps/questions/*.json); python's hand-written set has none. */
  category?: string;
  /** answer, caveat (answer plus a stated limit) or refuse. */
  mode?: "answer" | "caveat" | "refuse";
  /** `feed:<source>` and `kind:<evidence kind>` the citations must cover. */
  mustCite?: string[];
  /** Injected into the view: `selectedSite` (an NWPS lid), `asOf` (RFC 3339), `replay`. */
  context?: Record<string, string>;
  expect: {
    tools: string[];
    phrases: RegExp[];
    forbid?: RegExp[];
    minCitations: number;
    /** Citations of these evidence kinds the answer needs, e.g. `{ sighting: 2 }`: fetch-run citations alone do not answer a count. */
    cites?: Record<string, number>;
    view?: boolean;
    /** Every number in the answer must trace to a tool output (default true for file-loaded sets). */
    groundedNumbers?: boolean;
    /** The answer must say how fresh its data is. */
    feedState?: boolean;
  };
};

export const GOLDEN: Golden[] = [
  {
    id: "python-crews-tonight",
    question: "Where should python crews go tonight?",
    quality: false,
    expect: { tools: ["hotspots", "explain_cell", "conditions"], phrases: [/heuristic/i, /lagging|missing|cloud/i], minCitations: 3 },
  },
  {
    id: "iguana-cold-snap",
    question: "Is tonight's cold snap a good iguana capture window around Homestead?",
    quality: false,
    expect: { tools: ["geocode", "conditions", "alerts", "hotspots"], phrases: [/cold/i, /heuristic/i], minCitations: 4 },
  },
  {
    id: "biscayne-dive-conditions",
    question: "What are dive conditions at Biscayne for lionfish removal right now?",
    quality: false,
    expect: { tools: ["geocode", "conditions", "set_view"], phrases: [/stale/i], minCitations: 3, view: true },
  },
  {
    id: "tegu-sightings-homestead",
    question: "Show me recent tegu sightings around Homestead.",
    quality: false,
    expect: { tools: ["geocode", "sightings", "set_view"], phrases: [/research/i], minCitations: 3, cites: { sighting: 2 }, view: true },
  },
  {
    id: "florida-bay-alerts",
    question: "Any NWS alerts in effect for Florida Bay right now?",
    quality: false,
    expect: { tools: ["geocode", "alerts"], phrases: [/small craft/i], minCitations: 1, cites: { alert: 1 } },
  },
  {
    id: "python-backtest",
    question: "How well have the python hotspot scores held up over the last two weeks?",
    quality: false,
    expect: { tools: ["backtest"], phrases: [/baseline/i, /heuristic/i], minCitations: 1, cites: { backtest: 1 } },
  },
  {
    id: "explain-top-python-cell",
    question: "Why does the top python cell score so high tonight?",
    quality: false,
    expect: { tools: ["hotspots", "explain_cell"], phrases: [/heuristic/i, /density/i], minCitations: 1 },
  },
  {
    id: "lionfish-key-largo",
    question: "Where should lionfish divers work near Key Largo, and is the sea state OK?",
    quality: false,
    expect: { tools: ["geocode", "hotspots", "conditions"], phrases: [/stale/i, /heuristic/i], minCitations: 3 },
  },
  {
    id: "iguana-marathon-count",
    question: "How many iguanas were reported around Marathon this week?",
    quality: false,
    expect: { tools: ["geocode", "sightings"], phrases: [/duplicate/i], minCitations: 2, cites: { sighting: 2 } },
  },
  {
    id: "homestead-species-counts",
    question: "What invasive animals were seen near Homestead this week?",
    quality: false,
    // T44: species beyond the focus four, named with counts and a sighting citation per species.
    expect: { tools: ["geocode", "species_counts"], phrases: [/brown anole/i, /tegu/i, /iguana/i, /cuban tree ?frog/i, /\b3\b/], minCitations: 3, cites: { sighting: 3 } },
  },
  {
    id: "flamingo-view",
    question: "Take me to Flamingo.",
    quality: false,
    expect: { tools: ["geocode", "set_view"], phrases: [/flamingo/i], minCitations: 0, view: true },
  },
  {
    id: "quality-stale-feeds",
    question: "Which data feeds are stale or down right now?",
    quality: true,
    expect: { tools: ["feed_state"], phrases: [/stale/i, /ndbc/i, /down/i], minCitations: 3, cites: { fetch: 3 } },
  },
  {
    id: "quality-conflict-biscayne-sst",
    question: "Satellite says Biscayne water is warm but the buoy disagrees. Which is right?",
    quality: true,
    expect: {
      tools: ["geocode", "conditions"],
      phrases: [/conflict|disagree|differ/i, /measured|in-situ/i, /stale/i],
      minCitations: 2,
    },
  },
  {
    id: "quality-duplicates-shark-valley",
    question: "How many distinct pythons were reported around Shark Valley this week?",
    quality: true,
    // Duplicate and late in one: the NAS copy of an iNaturalist python arrived 2.2 days after the sighting.
    expect: { tools: ["geocode", "sightings"], phrases: [/duplicate/i, /\b(2|two) distinct/i, /\blate\b|arrived [^.]{0,40}\bafter\b/i], minCitations: 2, cites: { sighting: 2 } },
  },
  {
    id: "quality-missing-lst",
    question: "What is the land surface temperature at Shark Valley right now?",
    quality: true,
    expect: { tools: ["geocode", "conditions"], phrases: [/missing|cloud/i], minCitations: 2 },
  },
  {
    id: "quality-id-conflict-tegu",
    question: "Are there any tegu reports near Homestead I should double-check before sending a crew?",
    quality: true,
    expect: { tools: ["geocode", "sightings"], phrases: [/conflict/i, /casual/i], minCitations: 2, cites: { sighting: 2 } },
  },
];

export type { QuestionFile };

/** A question file as goldens: `pass` regexes compiled case-insensitively, `view` meaning a view event is required. */
export function goldenFromFile(file: QuestionFile): Golden[] {
  return file.questions.map((q) => ({
    id: q.id,
    question: q.question,
    quality: q.category === "quality",
    category: q.category,
    mode: q.pass.mode,
    mustCite: q.mustCite,
    context: q.context,
    expect: {
      tools: q.expectedTools,
      phrases: q.pass.phrases.map((p) => new RegExp(p, "i")),
      forbid: q.pass.forbid.map((p) => new RegExp(p, "i")),
      minCitations: q.pass.minCitations,
      cites: q.pass.cites,
      view: Boolean(q.view?.map) && q.expectedTools.includes("set_view"),
      groundedNumbers: q.pass.groundedNumbers,
      feedState: q.pass.feedState,
    },
  }));
}

/**
 * Golden sets by id (an app's `eval.goldenSet`, PLAN.md C-A3): each app's question file (the source of truth for
 * ids, categories, tools and pass criteria). The hand-written `GOLDEN` above is python's legacy set, kept so the
 * question checker can verify every legacy case was mapped (`py-legacy-<id>`).
 */
export const GOLDEN_SETS: Readonly<Record<string, readonly Golden[]>> = {
  python: goldenFromFile({ app: "python", questions: supportedQuestions("python") }),
  lionfish: goldenFromFile({ app: "lionfish", questions: supportedQuestions("lionfish") }),
  carp: goldenFromFile({ app: "carp", questions: supportedQuestions("carp") }),
};

/**
 * An app's held-out set (`spec/apps/questions/<app>.holdout.json`): paraphrases and new questions the prompts never
 * saw, in the question-file schema plus a `changelog`. Read at run time, never bundled, so it stays out of every
 * prompt and tool description.
 */
export function holdoutSet(app: string): Golden[] {
  const path = resolve(import.meta.dir, `../../../spec/apps/questions/${app}.holdout.json`);
  if (!existsSync(path)) return [];
  return goldenFromFile(JSON.parse(readFileSync(path, "utf8")) as QuestionFile);
}

/** The ten question categories, in the order the eval prints them. */
export const CATEGORIES = ["lookup", "change", "explain", "relevance", "quality", "planning", "sources", "replay", "boundary", "team"] as const;
