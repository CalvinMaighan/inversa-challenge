/**
 * Direct UI tools Grok can call without the DeepSeek hop (PLAN.md C8). The voice relay
 * forwards validated calls to the browser as `ui.command` events; the client applies
 * them through active-state keys. The text agent gets `toggle_layer` and `set_look` too (GE7,
 * server/agent/tools/map.ts): they reach the browser as the stream's `ui` event, validated here.
 *
 * `toggle_layer` is per app (C-A5): its `layer` enum is the app's `layers[]` and its `species`
 * enum the app's focus species, so the model is never offered a layer or species the app lacks.
 */
import { z } from "zod";

import { appLayerIds, LAYER_IDS, speciesIds, type AppConfig, type LayerId } from "shared/apps";
import { LOOK_IDS, LOOK_WORDS } from "shared/look";

export { LAYER_IDS };

/** The HUD menus the agent may open: each is a button's popover (client/hud). */
export const MENU_IDS = ["layers", "live_data", "look", "theme", "period", "developer"] as const;
export type MenuId = (typeof MENU_IDS)[number];
/** The periods of the period button, in days (client/state/range.ts keeps the labels). */
export const PERIOD_DAYS = [30, 90, 180, 365, 730] as const;
/** Carp's species filter keys, as the legend chips use them. */
export const CARP_SPECIES = ["silver", "bighead", "grass", "black"] as const;

const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);

function toggleLayer(layers: readonly LayerId[], species: readonly string[]) {
  const base = z.object({ layer: z.enum(layers as [LayerId, ...LayerId[]]), visible: z.boolean() });
  return species.length > 0 ? base.extend({ species: z.enum(species as [string, ...string[]]).optional() }) : base.extend({ species: z.never().optional() });
}

function schemas(layers: readonly LayerId[], species: readonly string[], filterable: readonly string[] = species) {
  return {
    fly_to: z
      .object({
        place: z.string().min(1).optional().describe("Place name resolved by the client gazetteer"),
        lat: lat.optional(),
        lon: lon.optional(),
        altitudeM: z.number().positive().max(40_000_000).optional(),
      })
      .refine((v) => v.place !== undefined || (v.lat !== undefined && v.lon !== undefined), {
        message: "place or lat+lon required",
      }),
    set_time: z.object({
      time: z.string().describe("RFC 3339 timestamp, or 'now'"),
    }),
    play_timeline: z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      speed: z.number().positive().max(64).default(8).describe("Frames per second"),
      playing: z.boolean().default(true),
    }),
    toggle_layer: toggleLayer(layers, species),
    select: z.object({
      evidenceId: z.string().min(3).describe("Evidence id `<kind>:<key>`"),
    }),
    open_evidence: z.object({
      evidenceId: z.string().min(3),
    }),
    open_menu: z.object({ menu: z.enum(MENU_IDS).describe("layers, live_data (newest data per feed), look, theme, period (how far back the timeline goes), developer (API keys and feeds)"), open: z.boolean().default(true) }),
    set_period: z.object({ days: z.union(PERIOD_DAYS.map((d) => z.literal(d)) as [z.ZodLiteral<30>, z.ZodLiteral<90>, ...z.ZodLiteral<number>[]]).describe("30, 90, 180, 365 or 730 days back from today") }),
    filter_species: filterable.length > 0 ? z.object({ species: z.enum(filterable as [string, ...string[]]), visible: z.boolean().default(true), only: z.boolean().optional().describe("true: show only this one and hide the others") }) : z.object({ species: z.never().optional(), visible: z.boolean().default(true), only: z.boolean().optional() }),
    select_area: z.object({ area: z.string().min(2).describe("An area of this app by id or name, e.g. the Florida Keys, the Mexican Caribbean, Belize, the Mississippi River Basin") }),
    zoom: z.object({ direction: z.enum(["in", "out", "fit"]).describe("in: halve the height, out: double it, fit: frame the whole area again") }),
    close_panel: z.object({}),
    show_card: z.object({
      title: z.string().min(2).max(80),
      text: z.string().min(2).max(600).describe("One to three plain sentences"),
      sources: z.array(z.object({ id: z.string().min(3).describe("Evidence id exactly as a result listed it, e.g. fish:inat:123"), label: z.string().min(1).max(100) })).max(6).default([]),
    }),
    // GE7: the globe's look (docs/GODS_EYE.md GC2), the same seven presets as the Look popover.
    set_look: z.object({
      look: z.enum(LOOK_IDS).describe(LOOK_IDS.map((id) => `${id} (${LOOK_WORDS[id]})`).join(", ")),
    }),
  } as const;
}

/** The whole vocabulary: every layer, any species string. Gives the command types; validation uses `uiToolSchemasFor`. */
const anySpecies = {
  ...schemas(LAYER_IDS, []),
  toggle_layer: z.object({ layer: z.enum(LAYER_IDS), visible: z.boolean(), species: z.string().optional() }),
  filter_species: z.object({ species: z.string(), visible: z.boolean().default(true), only: z.boolean().optional() }),
};

export type UiToolName = keyof typeof anySpecies;
export type UiToolArgs<N extends UiToolName> = z.infer<(typeof anySpecies)[N]>;

export type UiCommand = { [N in UiToolName]: { name: N; args: UiToolArgs<N> } }[UiToolName];

export type UiToolSchemas = { readonly [N in UiToolName]: z.ZodType<UiToolArgs<N>> };

export const UI_TOOL_NAMES = Object.keys(anySpecies) as UiToolName[];

const cache = new WeakMap<AppConfig, UiToolSchemas>();

/** The tool schemas for one app. */
export function uiToolSchemasFor(app: AppConfig): UiToolSchemas {
  let s = cache.get(app);
  if (!s) {
    s = schemas(appLayerIds(app), speciesIds(app), app.id === "carp" ? CARP_SPECIES : speciesIds(app)) as unknown as UiToolSchemas;
    cache.set(app, s);
  }
  return s;
}

/** Validate a raw tool call from the model against `app`'s tools. Null when the name is unknown or args fail. */
export function parseUiCommand(name: string, args: unknown, app: AppConfig): UiCommand | null {
  if (!(UI_TOOL_NAMES as string[]).includes(name)) return null;
  const parsed = uiToolSchemasFor(app)[name as UiToolName].safeParse(args);
  return parsed.success ? ({ name, args: parsed.data } as UiCommand) : null;
}
