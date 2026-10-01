/**
 * Every control on the ops page and what it does (T40, T41), plus the plain-language copy a newcomer reads first.
 * This is the one source for the "?" help sheet, the first-visit welcome, the About popover, the species bar's
 * descriptions and README's UI section: `tests/client/hud/help/content.test.ts` fails when README drifts from
 * this list. Plain data, no React, so docs tooling can import it too.
 */
import { copyText, taxonKey, type AppConfig } from "shared/apps";
import { SIGHTING_WINDOW_HOURS, windowLabel } from "shared/frames";
/** The default window in words ("7 days"); the selector can set 2, 7 or 30 days. */
export const DEFAULT_WINDOW = windowLabel(SIGHTING_WINDOW_HOURS);

export type HelpGroup = "Map" | "Timeline" | "Chat column";

export type HelpEntry = {
  /** Stable id, for tests and anchors. */
  id: string;
  group: HelpGroup;
  /** The control as it appears on screen. */
  control: string;
  /** What it does, one or two sentences. */
  what: string;
};

export const HELP_GROUPS: readonly HelpGroup[] = ["Map", "Timeline", "Chat column"];

export const HELP_ENTRIES: readonly HelpEntry[] = [
  {
    id: "species",
    group: "Map",
    control: "Species chips",
    what: `Top left. The app's focus species first, then the six animals seen most in the window (three on a phone), each with its kind's icon in its colour and its count. Click to show or hide one; Alt-click (or press and hold) to show only that one; All brings every animal back. Other opens every kind (snakes, lizards, turtles, frogs, birds, mammals, fish, snails, insects, spiders, plants, …) with a switch each and its most-seen species; insects, spiders and plants are off until you switch them on.`,
  },
  {
    id: "window",
    group: "Map",
    control: "Sightings window",
    what: `Next to the chips: last 2, 7 or 30 days (${DEFAULT_WINDOW} to start). Most people upload sightings a few days after they see them, so 7 days shows the most.`,
  },
  {
    id: "dots",
    group: "Map",
    control: "Sighting markers",
    what: `Each marker is one animal someone reported in the window: its kind's icon (a snake, a lizard, a bird, …) in its colour, brightest when newest. Hover for the species and how sure the ID is; click to open the record.`,
  },
  {
    id: "drawer",
    group: "Map",
    control: "Evidence card",
    what: "Opens on the right when you click a dot, a citation or a label: what was seen, where, when and how sure, the species' Latin name, a line about it and its iNaturalist page, with the photo when there is one. The raw record sits under Details for experts.",
  },
  {
    id: "about",
    group: "Map",
    control: "About (ⓘ)",
    what: "Top right. What this map is and how fresh its data is, Focus, this help, the data sources and their health, and More data (for experts): weather stations, alerts, hotspots and temperature layers.",
  },
  {
    id: "feeds",
    group: "Map",
    control: "Data sources",
    what: "Inside About. One row per source (iNaturalist, GBIF, USGS, NOAA, NWS, …) with its health: nominal, lagging, stale or down, push or poll, and how far behind it is.",
  },
  {
    id: "layers",
    group: "Map",
    control: "More data (for experts)",
    what: "Inside About. Shows or hides each layer, explains every colour, ramp and hatch, and counts what is drawn right now.",
  },
  {
    id: "focus",
    group: "Map",
    control: "Focus",
    what: "Inside About. Dims the globe outside a circle around the selection, so one record stands out.",
  },
  {
    id: "theme",
    group: "Map",
    control: "Theme (◐)",
    what: "Top right. Light, dark or tactical (green on black). Your choice is remembered.",
  },
  {
    id: "help",
    group: "Map",
    control: "Help",
    what: "Inside About. Opens this sheet.",
  },
  {
    id: "share",
    group: "Map",
    control: "Share links",
    what: "The address bar always holds the camera, time, visible layers, species and selection. Copy it to share the exact view.",
  },
  {
    id: "play",
    group: "Timeline",
    control: "Play / pause (Space)",
    what: "Plays time forward from the cursor at the chosen speed.",
  },
  {
    id: "speed",
    group: "Timeline",
    control: "Speed",
    what: "Playback speed in frames per second.",
  },
  {
    id: "live",
    group: "Timeline",
    control: "LIVE / REPLAY",
    what: "Says whether you are looking at now (LIVE) or the past (REPLAY). Click it while replaying to jump back to now.",
  },
  {
    id: "date",
    group: "Timeline",
    control: "Date jump",
    what: "Pick a UTC day. A day outside the loaded month loads that period (the cold snap of 2026-02-01, say).",
  },
  {
    id: "scrub",
    group: "Timeline",
    control: "Scrubber",
    what: "Drag through time, or focus it and use the arrow keys to step. The line is sightings over time; hatched stretches are gaps in the data (hover for which: no satellite data, cloud, or no sightings for 12 h or more).",
  },
  {
    id: "agent-tab",
    group: "Chat column",
    control: "Agent tab",
    what: "Ask the agent about what is on the map. Answers cite their evidence, show the tools they ran and their data, fly the globe to the answer and bracket what they found.",
  },
  {
    id: "missions-tab",
    group: "Chat column",
    control: "Notes tab",
    what: "The team board: write a note about what you saw (pick a spot on the globe, or start from a sighting's card), read everyone's notes live, chat with the team and see who is online. Crew missions fold out at the bottom. A dot on a tab means something new arrived there.",
  },
  {
    id: "mic",
    group: "Chat column",
    control: "Mic",
    what: "Talk to the agent instead of typing; press again to stop. Voice answers land in the same thread.",
  },
  {
    id: "citations",
    group: "Chat column",
    control: "Citations [1] [2] …",
    what: "Each number opens the record behind that claim in the evidence card (and flies to hotspot cells).",
  },
  {
    id: "panels",
    group: "Chat column",
    control: "Data panels and Expand",
    what: "Tables and charts behind an answer. Opening one frames its area on the globe; hovering a row pulses it; Expand opens them wide next to the column.",
  },
  {
    id: "resize",
    group: "Chat column",
    control: "Column edge",
    what: "Drag the column's right edge (or focus it and use the arrow keys) to make the chat wider or narrower. On phones the chat is a bottom sheet: drag or tap its handle.",
  },
];

/** The About popover's first line: what this app is, in one plain sentence (its config `copy.about`, else its question). */
export function aboutSentence(app: AppConfig): string {
  return copyText(app, "about", app.question);
}

/** Why the window defaults to a week; shown in About and on the window selector. */
export const WINDOW_NOTE = `Most people upload sightings a few days after they see them, so the last ${DEFAULT_WINDOW} shows the most.`;

/** First-visit welcome: two sentences at most. A species app talks about markers; a conditions app about gauges. */
export function welcome(app: AppConfig): string {
  const where = copyText(app, "region", app.regions.map((r) => r.name).join(", "));
  if (app.kind === "conditions") {
    return `Each marker is a river gauge or a weather alert in ${where}; click one to see its readings and forecast. Ask the agent below what changed and what needs review.`;
  }
  return (
    `Each marker is an invasive animal someone reported in ${where} in the last ${windowLabel(app.windows.default)}, drawn as its kind's icon; click one to see what it is. ` +
    "Filter by species at the top of the map, or ask the agent below."
  );
}

export type SpeciesGuideEntry = { id: string; name: string; full: string; line: string };

/** The "Other" chip's entry: every category (snakes, lizards, …, plants; `shared/species-categories.ts`). */
export const OTHER_GUIDE: SpeciesGuideEntry = {
  id: "other",
  name: "Other",
  full: "Every other introduced species",
  line: "every other non-native species people reported, by kind: snakes, lizards, frogs, birds, fish, plants and more, the most-seen animals as chips",
};

/** The species chips: short name, full name and one plain line each. The app's focus species, then "Other". */
export function speciesGuide(app: AppConfig): SpeciesGuideEntry[] {
  return [
    ...app.taxa.map((t) => ({ id: taxonKey(t), name: t.short ?? t.name, full: t.name, line: t.line ?? t.scientific ?? t.name })),
    OTHER_GUIDE,
  ];
}

/** Example questions for the welcome: the app's helper questions (C-A3). */
export function exampleQuestions(app: AppConfig): readonly string[] {
  return app.helperQuestions;
}
