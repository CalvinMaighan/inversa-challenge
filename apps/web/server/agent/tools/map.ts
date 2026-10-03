/**
 * Map tools (GE7, docs/GODS_EYE.md GC4 to GC6): what the agent may put on the globe and the ships it can read.
 *
 * - `toggle_layer` and `set_look` are the voice's UI tools (shared/voice/ui-tools.ts, one vocabulary): validated
 *   against the app's own layers, emitted as the stream's `ui` event, applied by the browser to LAYERS or LOOK.
 * - `vessels` reads AIS ship tracks through GraphQL `vessels` (GC4, carp and lionfish) and cites each ship as
 *   `vessel:<mmsi>`, with the `aisstream` feed's state so a quiet socket is said, not hidden.
 */
import { z } from "zod";

import type { CapabilityContext, CapabilityOutput } from "@/server/agent/runtime/registry";
import { evidence } from "@/server/agent/tools/evidence";
import { inRegion, lookupGazetteer } from "@/server/agent/tools/gazetteer";
import { gqlWithFeeds, type GqlFeedState } from "@/server/agent/tools/gql";
import { findArea } from "@/server/agent/tools/lionfish";
import { ageWords, bboxSchema, feedsFor, given, givenTime, HOUR_MS, localTime, output, resolveBbox } from "@/server/agent/tools/shared";
import { findSite, siteBox } from "@/server/agent/tools/sites";
import { resolvePlace } from "client/voice/gazetteer";
import { getApp, LAYER_IDS, type AppConfig } from "@/shared/apps";
import { LOOK_IDS, LOOK_WORDS } from "@/shared/look";
import { parseUiCommand, uiToolSchemasFor } from "@/shared/voice/ui-tools";
import { VESSEL_LABELS, type GqlVesselTrack } from "@/shared/vessels";

/** The ships tool is named after the layer it fills. */
const VESSELS = LAYER_IDS[9];

/** The layers of an app the agent may switch, with what each shows (the config's own words). */
export function switchableLayers(app: AppConfig): string {
  return (app.layers ?? []).map((l) => `${l.id} (${l.label}${l.defaultOn ? ", on at first load" : ""})`).join(", ");
}

// ---------------------------------------------------------------- toggle_layer

/** One map layer on or off, from the app's `layers[]` only (C-A5): the stream carries it to the browser. */
export function toggleLayer(app: AppConfig) {
  return {
    name: "toggle_layer",
    description: `Show or hide one map layer of this app: ${switchableLayers(app)}. Call it when the user asks to see (or hide) something on the map, e.g. ships or rain radar; leave the novice defaults alone otherwise. Returns at once.`,
    // A config stub without layers (the registry's name listing) still gets a schema; a real app lists only its own.
    inputSchema: app.layers?.length ? uiToolSchemasFor(app).toggle_layer : z.object({ layer: z.string(), visible: z.boolean() }),
    async execute(input: unknown, ctx: CapabilityContext): Promise<CapabilityOutput> {
      const command = parseUiCommand("toggle_layer", input, ctx.app);
      if (!command || command.name !== "toggle_layer") throw new Error(`toggle_layer: unknown layer for this app (layers: ${ctx.app.layers.map((l) => l.id).join(", ")})`);
      ctx.emit({ type: "ui", name: command.name, args: command.args });
      const label = ctx.app.layers.find((l) => l.id === command.args.layer)?.label ?? command.args.layer;
      return output({ applied: true, layer: command.args.layer, label, visible: command.args.visible, note: `The ${label} layer is now ${command.args.visible ? "on" : "off"} on the map. Say so in a few words; a switch is no evidence of what the layer shows.` }, [], [], 1);
    },
  };
}

// ---------------------------------------------------------------- the rest of the controls

const CONTROL_DESCRIPTIONS = {
  open_menu: "Open or close one on-screen menu: layers, live_data (newest data per feed), look, theme, period (how far back the timeline goes) or developer. Returns at once.",
  set_period: "Set how far back the map and timeline reach: 30, 90, 180, 365 (1 year) or 730 (2 years) days; dots, counts and the timeline change together. Returns at once.",
  filter_species: "Show or hide one species on the map (the species chips); only=true shows just that one. Returns at once.",
  select_area: "Choose one of this app's own named areas (the area button above the timeline) and fly there: lionfish has the Florida Keys, Mexican Caribbean, Belize and Colombian Caribbean; the other apps have one. Not for towns or rivers: use fly_to for any other place. Returns at once.",
  zoom: "Zoom the globe in (half the height), out (twice the height) or fit (frame the whole area again), around where it is now. To go to a place, call fly_to instead (then zoom if needed). Returns at once.",
  switch_app: "Switch the whole app to another species: carp (Asian carp, Mississippi River Basin), lionfish (Caribbean reefs) or python (Burmese python, South Florida). Use it when the user asks to switch, select, open or go to another species or app. The map, timeline and chat move to it; their next question is answered for that species. Returns at once.",
  close_panel: "Close the open sighting card. Returns at once.",
  fly_to: "Move the globe camera to a place by name (a town, river town, reef town or area of this app) or to lat and lon; altitudeM is the camera height in metres (omit for a sensible default). Returns at once.",
  show_card: "Pin an info card in the chat with its sources: a short title, one to three plain sentences and up to four sources (id and label exactly as a data tool returned them). Use it when the user asks to keep or pin something. Returns at once.",
  open_evidence: "Open one sighting's card on the map and fly to it, by the evidence id exactly as a data tool returned it (sighting:<id>, fish:<id>). Returns at once.",
} as const;

/** The mouse-and-menu controls the voice has too (shared/voice/ui-tools.ts): validated for this app, applied by the browser. */
export function controlTools(app: AppConfig) {
  return (Object.keys(CONTROL_DESCRIPTIONS) as (keyof typeof CONTROL_DESCRIPTIONS)[]).map((name) => ({
    name,
    description: CONTROL_DESCRIPTIONS[name],
    inputSchema: app.layers?.length ? uiToolSchemasFor(app)[name] : z.object({}).passthrough(),
    async execute(input: unknown, ctx: CapabilityContext): Promise<CapabilityOutput> {
      const command = parseUiCommand(name, input, ctx.app);
      if (!command) throw new Error(`${name}: the arguments are not valid for this app`);
      if (command.name === "fly_to" && command.args.lat === undefined && command.args.place && !resolvePlace(command.args.place)) {
        throw new Error(`fly_to: no place named "${command.args.place}" is known; call it again with lat and lon`);
      }
      if (command.name === "switch_app" && command.args.app === ctx.app.id) {
        return output({ applied: false, control: name, note: `Already on ${ctx.app.name}. Say so in one sentence.` }, [], [], 1);
      }
      ctx.emit({ type: "ui", name: command.name, args: command.args });
      if (command.name === "switch_app") {
        return output({ applied: true, control: name, args: command.args, note: `The app is switching to ${getApp(command.args.app).name}. Tell the user in one sentence that you switched; they can ask about it next. Do not answer questions about the new species from this app's data.` }, [], [], 1);
      }
      return output({ applied: true, control: name, args: command.args, note: "Done on the map. Say what you did in a few words; a control is no evidence of what it shows." }, [], [], 1);
    },
  }));
}

// ---------------------------------------------------------------- set_look

const lookInput = z.object({ look: z.enum(LOOK_IDS).describe(LOOK_IDS.map((id) => `${id}: ${LOOK_WORDS[id]}`).join("; ")) });

/** The globe's visual preset (GC2), only when the user asks for a look. */
export const setLook = {
  name: "set_look",
  description: `Change how the globe looks: ${LOOK_IDS.map((id) => `${id} (${LOOK_WORDS[id]})`).join(", ")}. Only when the user asks for a look, a style or a mode such as night vision or thermal; normal brings the plain map back. Returns at once.`,
  inputSchema: lookInput,
  async execute(input: z.infer<typeof lookInput>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const command = parseUiCommand("set_look", input, ctx.app);
    if (!command || command.name !== "set_look") throw new Error(`set_look: look must be one of ${LOOK_IDS.join(", ")}`);
    ctx.emit({ type: "ui", name: command.name, args: command.args });
    return output({ applied: true, look: command.args.look, words: LOOK_WORDS[command.args.look] }, [], [], 1);
  },
};

// ---------------------------------------------------------------- vessels

/** Most ships listed to the model; the count says how many there were. */
const MAX_SHIPS = 25;
/** Default lookback: the last six hours of fixes. */
const DEFAULT_HOURS = 6;
/** The API answers at most seven days per call. */
const MAX_HOURS = 24 * 7;

const VESSELS_QUERY = `query AgentVessels($bbox: BBox!, $from: Time!, $to: Time!, $types: [String!], $limit: Int) {
  vessels(bbox: $bbox, from: $from, to: $to, types: $types, limit: $limit) { mmsi name type points { at lat lon sog cog heading } }
  feeds { ...FeedFields }
}
`;

const vesselsInput = z.object({
  place: z.string().min(2).max(120).optional().describe("A configured location, an area or a place name inside this app's regions. Replaces bbox."),
  bbox: bboxSchema.optional(),
  hours: z.number().int().min(1).max(MAX_HOURS).optional().describe(`Lookback in hours up to the reference time (default ${DEFAULT_HOURS}).`),
  at: z.string().optional().describe("Reference time (RFC 3339); default the current reference time."),
  types: z.array(z.enum(Object.keys(VESSEL_LABELS) as [string, ...string[]])).optional().describe("Ship types to keep: cargo, tanker, passenger, fishing, tug, pleasure, highspeed, service, other, unknown. Leave out for all."),
});

/** The box of a place: a configured location, an area, or the gazetteer inside the app's regions. */
function placeBox(app: AppConfig, name: string) {
  const site = app.locations.length > 0 ? findSite(app, name) : null;
  if (site) return siteBox(site);
  const area = findArea(app, name);
  if (area) return area.bbox;
  const hit = lookupGazetteer(name);
  return hit && inRegion(app, hit.lat, hit.lon) ? hit.bbox : null;
}

export const vessels = {
  name: VESSELS,
  description:
    "Ships broadcasting AIS (the Ships layer, AISStream.io): the vessels seen in an area over the last hours, each with its name, type, last position, speed and course and when it was last heard. Cite each ship you mention as [e:vessel:<mmsi>]. Not every boat carries AIS, so an empty result means no AIS ships, not no boats.",
  inputSchema: vesselsInput,
  async execute(input: z.infer<typeof vesselsInput>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const placeName = given(input.place);
    const place = placeName ? placeBox(ctx.app, placeName) : null;
    const bbox = resolveBbox(place ?? input.bbox, ctx);
    const toText = givenTime(input.at);
    const to = toText ? new Date(toText) : ctx.now;
    const hours = Math.min(input.hours ?? DEFAULT_HOURS, MAX_HOURS);
    const from = new Date(to.getTime() - hours * HOUR_MS);
    const data = await gqlWithFeeds<{ vessels: GqlVesselTrack[]; feeds: GqlFeedState[] }>(
      "AgentVessels",
      VESSELS_QUERY,
      { bbox, from: from.toISOString(), to: to.toISOString(), types: input.types?.length ? input.types : null, limit: 300 },
      ctx,
    );
    const ships = data.vessels
      .map((v) => ({ v, last: v.points.reduce((a, b) => (Date.parse(b.at) > Date.parse(a.at) ? b : a), v.points[0]!) }))
      .filter((s) => s.last)
      .sort((a, b) => Date.parse(b.last.at) - Date.parse(a.last.at));
    const listed = ships.slice(0, MAX_SHIPS);
    const evidenceRows = listed.map(({ v }) => evidence("vessel", String(v.mmsi), `${v.name?.trim() || `MMSI ${v.mmsi}`} (${VESSEL_LABELS[v.type as keyof typeof VESSEL_LABELS] ?? v.type})`, "aisstream"));
    const rows = listed.map(({ v, last }, i) => ({
      evidenceId: evidenceRows[i]!.id,
      mmsi: String(v.mmsi),
      name: v.name?.trim() || null,
      type: VESSEL_LABELS[v.type as keyof typeof VESSEL_LABELS] ?? v.type,
      lastSeen: localTime(ctx.app, last.at),
      lastSeenAge: `${ageWords(Math.max(0, (to.getTime() - Date.parse(last.at)) / 1000))} before the reference time`,
      lat: Math.round(last.lat * 1e4) / 1e4,
      lon: Math.round(last.lon * 1e4) / 1e4,
      speedKn: last.sog,
      courseDeg: last.cog,
      fixes: v.points.length,
    }));
    const feeds = feedsFor(data.feeds, ["aisstream"], ["aisstream"]);
    return output(
      {
        bbox,
        ...(placeName ? (place ? { place: placeName } : { placeIgnored: `"${placeName}" is not a place the app knows; the asked-for area was used` }) : {}),
        from: from.toISOString(),
        to: to.toISOString(),
        ships: ships.length,
        ...(ships.length > MAX_SHIPS ? { listed: MAX_SHIPS, note: `${ships.length} ships; the ${MAX_SHIPS} heard most recently are listed.` } : {}),
        attribution: "Vessel positions: AISStream.io",
        caveat: "AIS is what ships broadcast; small boats often carry none. Positions are as last reported, not live tracking.",
        rows,
      },
      evidenceRows,
      feeds,
      ships.length,
    );
  },
};
