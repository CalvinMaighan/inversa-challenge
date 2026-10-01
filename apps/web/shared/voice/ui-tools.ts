/**
 * Direct UI tools Grok can call without the DeepSeek hop (PLAN.md C8). The voice relay
 * forwards validated calls to the browser as `ui.command` events; the client applies
 * them through active-state keys.
 *
 * `toggle_layer` is per app (C-A5): its `layer` enum is the app's `layers[]` and its `species`
 * enum the app's focus species, so the model is never offered a layer or species the app lacks.
 */
import { z } from "zod";

import { appLayerIds, LAYER_IDS, speciesIds, type AppConfig, type LayerId } from "shared/apps";

export { LAYER_IDS };

const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);

function toggleLayer(layers: readonly LayerId[], species: readonly string[]) {
  const base = z.object({ layer: z.enum(layers as [LayerId, ...LayerId[]]), visible: z.boolean() });
  return species.length > 0 ? base.extend({ species: z.enum(species as [string, ...string[]]).optional() }) : base.extend({ species: z.never().optional() });
}

function schemas(layers: readonly LayerId[], species: readonly string[]) {
  return {
    fly_to: z
      .object({
        place: z.string().min(1).optional().describe("Place name resolved by the client gazetteer"),
        lat: lat.optional(),
        lon: lon.optional(),
        altitudeM: z.number().positive().max(20_000_000).optional(),
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
  } as const;
}

/** The whole vocabulary: every layer, any species string. Gives the command types; validation uses `uiToolSchemasFor`. */
const anySpecies = {
  ...schemas(LAYER_IDS, []),
  toggle_layer: z.object({ layer: z.enum(LAYER_IDS), visible: z.boolean(), species: z.string().optional() }),
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
    s = schemas(appLayerIds(app), speciesIds(app)) as unknown as UiToolSchemas;
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
