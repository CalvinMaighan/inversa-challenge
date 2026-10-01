/**
 * Every control on the ops page and what it does (T40). This is the one source for the "?" help sheet, the
 * first-visit hint, and README's UI section: `tests/client/hud/help/content.test.ts` fails when README drifts
 * from this list. Plain data, no React, so docs tooling can import it too.
 */

export type HelpGroup = "Top bar" | "Globe" | "Timeline" | "Chat column";

export type HelpEntry = {
  /** Stable id, for tests and anchors. */
  id: string;
  group: HelpGroup;
  /** The control as it appears on screen. */
  control: string;
  /** What it does, one or two sentences. */
  what: string;
};

export const HELP_GROUPS: readonly HelpGroup[] = ["Top bar", "Globe", "Timeline", "Chat column"];

export const HELP_ENTRIES: readonly HelpEntry[] = [
  {
    id: "feeds",
    group: "Top bar",
    control: "Feed chips",
    what: "One chip per data source (GOES, NWS, iNat, USGS, NDBC, CO-OPS, …). Colour is health: green nominal, amber lagging, dashed amber stale, red down. The icon is push or poll, the number is the lag. Hover for the source's note.",
  },
  {
    id: "live",
    group: "Top bar",
    control: "LIVE / REPLAY",
    what: "LIVE when the time cursor is at the live edge; REPLAY when you are looking at the past (REPLAY ▸ while playing).",
  },
  {
    id: "clocks",
    group: "Top bar",
    control: "Clocks and CURSOR",
    what: "UTC and local time of the time cursor, and the latitude and longitude under the pointer.",
  },
  {
    id: "focus",
    group: "Top bar",
    control: "Focus",
    what: "Dims the globe outside a circle around the selection, so one record stands out.",
  },
  {
    id: "theme",
    group: "Top bar",
    control: "Theme: light / dark / tac",
    what: "Switches the colour mode. Tactical is the green-on-black field-ops look. Your choice is remembered.",
  },
  {
    id: "help",
    group: "Top bar",
    control: "?",
    what: "Opens this sheet.",
  },
  {
    id: "layers",
    group: "Globe",
    control: "Layers",
    what: "Top right of the globe. Shows or hides each layer and species, explains every colour, ramp and hatch, and counts what is drawn right now.",
  },
  {
    id: "hover",
    group: "Globe",
    control: "Hover a marker",
    what: "A tooltip names the marker and its key value: a gauge's latest reading, a sighting's species, grade and source, an alert's expiry, a hotspot's score.",
  },
  {
    id: "drawer",
    group: "Globe",
    control: "Evidence drawer",
    what: "Click any marker, citation or bracket label to open its record on the right: the normalized record, raw payload, source feed, linked records and revisions. Hotspot cells also explain their score.",
  },
  {
    id: "share",
    group: "Globe",
    control: "Share links",
    what: "The address bar always holds the camera, time, visible layers, species and selection. Copy it to share the exact view.",
  },
  {
    id: "play",
    group: "Timeline",
    control: "Play / pause (Space)",
    what: "Plays the frames forward from the cursor at the chosen speed.",
  },
  {
    id: "step",
    group: "Timeline",
    control: "Step ◂ ▸",
    what: "Moves the cursor back or forward one 15-minute frame.",
  },
  {
    id: "speed",
    group: "Timeline",
    control: "Speed",
    what: "Playback speed in frames per second.",
  },
  {
    id: "live-edge",
    group: "Timeline",
    control: "Live",
    what: "Jumps the cursor back to now.",
  },
  {
    id: "date",
    group: "Timeline",
    control: "Date jump",
    what: "Pick a UTC day. A day outside the loaded window loads that period (the cold snap of 2026-02-01, say).",
  },
  {
    id: "scrub",
    group: "Timeline",
    control: "Scrubber",
    what: "Drag through time. The line is sightings per frame, amber bands are alerts, and hatched stretches are gaps: red no data, amber cloud, grey quiet (no sightings for 12 h or more).",
  },
  {
    id: "agent-tab",
    group: "Chat column",
    control: "Agent tab",
    what: "Ask the field agent about what is in view. Answers cite their evidence, show the tools they ran and their data, fly the globe to the answer and bracket what they found.",
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
    what: "Each number opens the record behind that claim in the evidence drawer (and flies to hotspot cells).",
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

/** Example questions for the first-visit hint above the composer. Each works against the fixtures and live data. */
export const EXAMPLE_QUESTIONS: readonly string[] = [
  "Iguana sightings near Homestead and water levels",
  "Where should python crews go tonight?",
  "Any freeze or flood alerts in effect?",
];

/** One-line hint shown with the examples. */
export const FIRST_VISIT_HINT = "Ask about sightings, hotspots, conditions or alerts in view. Try:";
