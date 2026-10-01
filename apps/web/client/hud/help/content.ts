/**
 * Every control on the ops page and what it does (T40, T41), plus the plain-language copy a newcomer reads first.
 * This is the one source for the "?" help sheet, the first-visit welcome, the About popover, the species chip's
 * descriptions and README's UI section: `tests/client/hud/help/content.test.ts` fails when README drifts from
 * this list. Plain data, no React, so docs tooling can import it too.
 */
import { copyText, hasLayer, LAYER_IDS, taxonKey, type AppConfig, type LayerId } from "shared/apps";
import { SIGHTING_WINDOW_HOURS, windowLabel } from "shared/frames";
/** The default window in words ("7 days"). */
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
  /** Only in apps of this kind (species: sightings, conditions: carp's river locations); absent: every app. */
  kind?: AppConfig["kind"];
  /** Only in apps that list this layer (GE7: Ships, in carp and lionfish). */
  layer?: LayerId;
};

export const HELP_GROUPS: readonly HelpGroup[] = ["Map", "Timeline", "Chat column"];

export const HELP_ENTRIES: readonly HelpEntry[] = [
  {
    id: "species",
    kind: "species",
    group: "Map",
    control: "Species chip",
    what: "Top left. The app's one species with its icon, its colour and how many sightings are in the window. Click to show or hide its markers.",
  },
  {
    id: "dots",
    kind: "species",
    group: "Map",
    control: "Sighting markers",
    what: "Each marker is one animal someone reported in the window, drawn as the app's species icon in its colour, brightest when newest. Hover for how sure the ID is; click to open the record.",
  },
  {
    id: "drawer",
    kind: "species",
    group: "Map",
    control: "Evidence card",
    what: "Opens on the right when you click a dot, a citation or a label: what was seen, where, when and how sure, the species' Latin name, a line about it and its iNaturalist page, with the sighting's photo when there is one. The raw record sits under Details for experts.",
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
    id: "layers-bar",
    group: "Map",
    control: "Layers",
    what: "Bottom of the map, beside Look. What the map shows: the app's own markers and field notes are on at first; ships and the water and weather pictures (rain radar, clouds, lightning, storms, sea temperature) are one tap away. Each one follows the timeline.",
  },
  {
    id: "ships",
    group: "Map",
    control: "Ships",
    what: "Inside Layers. Ships that broadcast their position (AIS, from AISStream.io), coloured by type, moving with the timeline with a fading trail. Click one for its name, speed and course and its VesselFinder page (new tab). Small boats often do not broadcast.",
    layer: LAYER_IDS[9],
  },
  {
    id: "look",
    group: "Map",
    control: "Look",
    what: "Top right, the eye. Changes how the globe looks: Normal, CRT, NVG (night vision), FLIR (thermal), Noir, Anime or Snow. The map window switch shows the map through a window: pick its shape (circle, oval, rounded or the whole frame), its size, and how soft its edge is. A look changes no data.",
  },
  {
    id: "developer",
    group: "Map",
    control: "Developer (<>)",
    what: "Top right. Power up the globe: every API key the map can use, set or missing, what it unlocks and where to get it (new tab). A browser key you paste stays in this browser; server keys live in Doppler. No key's value is ever shown.",
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
    kind: "species",
    group: "Timeline",
    control: "Play / pause (Space)",
    what: "Plays time forward from the cursor at the chosen speed.",
  },
  {
    id: "speed",
    kind: "species",
    group: "Timeline",
    control: "Speed",
    what: "Playback speed in frames per second.",
  },
  {
    id: "live",
    kind: "species",
    group: "Timeline",
    control: "LIVE / REPLAY",
    what: "Says whether you are looking at now (LIVE) or the past (REPLAY). Click it while replaying to jump back to now.",
  },
  {
    id: "date",
    kind: "species",
    group: "Timeline",
    control: "Date jump",
    what: "Pick a UTC day. A day outside the loaded month loads that period (the cold snap of 2026-02-01, say).",
  },
  {
    id: "scrub",
    kind: "species",
    group: "Timeline",
    control: "Scrubber",
    what: "Drag through time, or focus it and use the arrow keys to step. The line is sightings over time; hatched stretches are gaps in the data (hover for which: no satellite data, cloud, or no sightings for 12 h or more).",
  },
  {
    id: "carp-markers",
    kind: "conditions",
    group: "Map",
    control: "Location markers",
    what: "One per demonstration river location: a diamond with ! needs review, a circle with a tick means no rule fired (not that a trip is safe), a dashed square with ? cannot be assessed. The ring is freshness: green within 2 h, amber within 6 h, dashed red older, dotted grey none. Click or press Enter to open its briefing.",
  },
  {
    id: "carp-board",
    kind: "conditions",
    group: "Map",
    control: "Review board",
    what: "Left: every location, those needing review first, each with its reasons in words, plus the camera presets (All sites, Atchafalaya Basin). Conditions only: nothing here estimates carp abundance, catch, access or trip safety.",
  },
  {
    id: "carp-briefing",
    kind: "conditions",
    group: "Map",
    control: "Location briefing",
    what: "Right: what changed, what is expected and what is missing, then the readings with units and times, the forecast's issuance and source, flood thresholds, NWS alerts and the source pages (new tab).",
  },
  {
    id: "carp-timeline",
    kind: "conditions",
    group: "Timeline",
    control: "Stage timeline",
    what: "USGS gauge height (its own datum), NWPS observed stage and the NWPS forecast with the spread of recent issuances, flood thresholds, NWS alerts and where replay coverage begins. A red chip says when two sources disagree, and why.",
  },
  {
    id: "carp-asof",
    kind: "conditions",
    group: "Timeline",
    control: "What we knew",
    what: "Drag the timeline (arrow keys: an hour, Page keys: a day) or press What we knew yesterday afternoon: the board, briefing and chart show only what was held then, with the forecast issued by then; later observations are drawn hollow and dashed. Play replays to now; LIVE returns.",
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

/** The help sheet's entries for an app: the shared ones and those of its kind. */
export function helpEntries(app: Pick<AppConfig, "kind" | "layers">): HelpEntry[] {
  return HELP_ENTRIES.filter((e) => (!e.kind || e.kind === app.kind) && (!e.layer || hasLayer(app as AppConfig, e.layer)));
}

/** The About popover's first line: what this app is, in one plain sentence (its config `copy.about`, else its question). */
export function aboutSentence(app: AppConfig): string {
  return copyText(app, "about", app.question);
}

/** Why the window defaults to a week; shown in About. */
export const WINDOW_NOTE = `Most people upload sightings a few days after they see them, so the last ${DEFAULT_WINDOW} shows the most.`;

/** First-visit welcome: two sentences at most. A species app talks about markers; a conditions app about gauges. */
export function welcome(app: AppConfig): string {
  const where = copyText(app, "region", app.regions.map((r) => r.name).join(", "));
  if (app.kind === "conditions") {
    return `Each marker is one of the ${where}, its shape and colour saying whether it needs review; click one for its briefing, readings and forecast. Ask the agent below what changed, or scrub the timeline to see what was known at an earlier hour.`;
  }
  const species = app.taxa[0]?.name ?? "invasive animal";
  return (
    `Each marker is a ${species} someone reported in ${where} in the last ${windowLabel(app.windows.defaultHours)}; click one to see the record. ` +
    "Switch its markers with the chip at the top of the map, or ask the agent below."
  );
}

export type SpeciesGuideEntry = { id: string; name: string; full: string; line: string };

/** The species chip: short name, full name and one plain line. The app's one species; none in a conditions app. */
export function speciesGuide(app: AppConfig): SpeciesGuideEntry[] {
  return app.taxa.map((t) => ({ id: taxonKey(t), name: t.short ?? t.name, full: t.name, line: t.line ?? t.scientificName }));
}

const WELCOME_QUESTIONS = 3;

/** Example questions for the welcome: the first three of the app's helper questions (C-A3); a newcomer reads three. */
export function exampleQuestions(app: AppConfig): readonly string[] {
  return app.helperQuestions.slice(0, WELCOME_QUESTIONS);
}
