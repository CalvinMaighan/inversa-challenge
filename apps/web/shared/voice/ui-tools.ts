/**
 * Direct UI tools Grok can call without the DeepSeek hop (PLAN.md C8). The voice relay
 * forwards validated calls to the browser as `ui.command` events; the client applies
 * them through active-state keys.
 */
import { z } from "zod";

const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);

export const LAYER_IDS = ["sightings", "hotspots", "lst", "sst", "stations", "alerts", "missions", "peers", "notes"] as const;
export const SPECIES_IDS = ["python", "tegu", "iguana", "lionfish"] as const;

export const uiToolSchemas = {
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
  toggle_layer: z.object({
    layer: z.enum(LAYER_IDS),
    visible: z.boolean(),
    species: z.enum(SPECIES_IDS).optional(),
  }),
  select: z.object({
    evidenceId: z.string().min(3).describe("Evidence id `<kind>:<key>`"),
  }),
  open_evidence: z.object({
    evidenceId: z.string().min(3),
  }),
} as const;

export type UiToolName = keyof typeof uiToolSchemas;
export type UiToolArgs<N extends UiToolName> = z.infer<(typeof uiToolSchemas)[N]>;

export type UiCommand = { [N in UiToolName]: { name: N; args: UiToolArgs<N> } }[UiToolName];

export const UI_TOOL_NAMES = Object.keys(uiToolSchemas) as UiToolName[];

/** Validate a raw tool call from the model. Returns null when the name is unknown or args fail. */
export function parseUiCommand(name: string, args: unknown): UiCommand | null {
  if (!(name in uiToolSchemas)) return null;
  const parsed = uiToolSchemas[name as UiToolName].safeParse(args);
  return parsed.success ? ({ name, args: parsed.data } as UiCommand) : null;
}
