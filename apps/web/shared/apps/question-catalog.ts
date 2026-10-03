/**
 * What the agent is for, as questions a person can click or say: the Questions tab lists all of them by topic, the empty chat
 * shows the first of each topic. Everything here is answered from the app's own data or done on the map by the agent's tools
 * (sightings, species counts, river and sea conditions, alerts, hotspots, feed health, camera, timeline, filters and menus);
 * nothing outside the app's species and places belongs in this list.
 */
import type { AppConfig } from "./schema";

export type QuestionIcon = "species" | "pin" | "water" | "hotspot" | "source" | "clock" | "layers" | "voice";

export type QuestionGroup = {
  id: string;
  label: string;
  /** One line under the label. */
  hint: string;
  icon: QuestionIcon;
  questions: readonly string[];
};

const TIMELINE = (place: string, back: string): QuestionGroup => ({
  id: "timeline",
  label: "Timeline",
  hint: "Move through time and replay what was reported",
  icon: "clock",
  questions: ["Show the last 30 days", `Go back to ${back}`, "Play the last week", `What was reported near ${place} last month?`],
});

const MAP = (areaWord: string, extra: readonly string[]): QuestionGroup => ({
  id: "map",
  label: "Map and menus",
  hint: "Say it and the agent does it on the map",
  icon: "layers",
  questions: [`Zoom into ${areaWord}`, "Show only the last 90 days", "Open the layers menu", ...extra],
});

const CARP: readonly QuestionGroup[] = [
  {
    id: "reports",
    label: "Asian carp sightings",
    hint: "Silver, bighead, grass and black carp in the Mississippi River Basin",
    icon: "species",
    questions: [
      "How many silver carp sightings are on the map?",
      "Where were bighead carp reported most recently?",
      "Compare silver, bighead, grass and black carp",
      "Which species has the most reports this year?",
    ],
  },
  {
    id: "rivers",
    label: "River conditions",
    hint: "Gauges, forecasts and alerts on the Mississippi and its neighbours",
    icon: "water",
    questions: ["What is the Mississippi doing at Baton Rouge?", "Are there flood alerts on the Atchafalaya?", "Which river gauges need review today?"],
  },
  {
    id: "sources",
    label: "Data and sources",
    hint: "Where it comes from and how fresh it is",
    icon: "source",
    questions: ["How fresh is the newest sighting?", "Which data feeds are live right now?", "Where do the sightings come from?"],
  },
  TIMELINE("St. Louis", "the start of the year"),
  MAP("the Mississippi River Basin", ["Show only silver carp", "Select the newest sighting and read it out"]),
];

const LIONFISH: readonly QuestionGroup[] = [
  {
    id: "reports",
    label: "Lionfish reports",
    hint: "Reports around the Florida Keys, Mexican Caribbean, Belize and Colombia",
    icon: "species",
    questions: ["Where were lionfish reported in the last 30 days?", "How many reports are there in the Florida Keys this year?", "Show me the most recent lionfish report", "Which reports have the most reliable ID?"],
  },
  {
    id: "reef",
    label: "Reef heat and ocean",
    hint: "NOAA Coral Reef Watch heat stress, buoys, tides and waves",
    icon: "water",
    questions: ["How hot is the water around the Florida Keys?", "Where is reef heat stress highest?", "Turn on the reef heat map", "Where are the waves calmer this week?"],
  },
  {
    id: "priority",
    label: "Survey priority",
    hint: "Where to look first, with the reasons shown separately",
    icon: "hotspot",
    questions: ["Which areas should we survey first, and why?", "Why did you highlight this area?", "Compare this month with the previous month in the Mexican Caribbean"],
  },
  {
    id: "sources",
    label: "Data and sources",
    hint: "Where it comes from and how fresh it is",
    icon: "source",
    questions: ["Which data feeds are stale right now?", "Where does the heat map come from?", "Which reports arrived late?"],
  },
  TIMELINE("the Keys", "January 2026"),
  MAP("the Florida Keys", ["Go to the Mexican Caribbean", "Show only the Colombian Caribbean"]),
];

const PYTHON: readonly QuestionGroup[] = [
  {
    id: "reports",
    label: "Burmese python reports",
    hint: "Reports in South Florida and the Everglades",
    icon: "species",
    questions: ["Where were pythons reported in the last 7 days?", "How many python reports are there in the last year?", "Show me the most recent python report", "Which reports have the most reliable ID?"],
  },
  {
    id: "crews",
    label: "Where to send crews",
    hint: "A heuristic ranking of cells, with the reasons shown",
    icon: "hotspot",
    questions: ["Which cells rank highest for a removal crew tonight, and why?", "Where does this hotspot score come from?", "Did the cold snap change python activity?"],
  },
  {
    id: "conditions",
    label: "Weather and water",
    hint: "Alerts, tides, buoys and gauges around the Everglades",
    icon: "water",
    questions: ["Are there weather alerts for South Florida?", "What are the water levels near Flamingo?", "Which night this week looks best for road surveys?"],
  },
  {
    id: "sources",
    label: "Data and sources",
    hint: "Where it comes from and how fresh it is",
    icon: "source",
    questions: ["Which feeds are stale right now?", "Where do the python reports come from?", "What does EDDMapS add?"],
  },
  TIMELINE("Flamingo", "the January 2026 cold snap"),
  MAP("the Everglades", ["Turn on the hotspot layer", "Select the newest report and read it out"]),
];

const VOICE_GROUP: QuestionGroup = {
  id: "voice",
  label: "Hands-free",
  hint: "Tap the microphone and just talk",
  icon: "voice",
  questions: ["Open the period menu and pick 2 years", "Open the Live data menu", "Click the newest dot and tell me what it is"],
};

const CATALOGS: Record<AppConfig["id"], readonly QuestionGroup[]> = { carp: CARP, lionfish: LIONFISH, python: PYTHON };

/** Every topic with its questions, for the Questions tab. */
export function questionGroups(app: AppConfig): readonly QuestionGroup[] {
  return [...CATALOGS[app.id], VOICE_GROUP];
}

/** One question per topic, the ones the empty chat offers first. */
export function quickActions(app: AppConfig): readonly { group: QuestionGroup; question: string }[] {
  return CATALOGS[app.id]
    .filter((g) => g.id !== "map")
    .slice(0, 4)
    .map((group) => ({ group, question: group.questions[0]! }));
}
