import { z } from "zod";

import { resolvePlace } from "client/voice/gazetteer";
import { parseUiCommand, uiToolSchemas, UI_TOOL_NAMES, type UiCommand, type UiToolName } from "shared/voice/ui-tools";

/**
 * Relay-side handling of the direct UI tools (PLAN.md C8). Schema validation is
 * `parseUiCommand`; this adds the checks a schema cannot express (parseable times, a
 * resolvable place) so a bad call becomes a tool error Grok can correct, never a silent no-op.
 */

export function isUiToolName(name: string): name is UiToolName {
  return (UI_TOOL_NAMES as string[]).includes(name);
}

export type UiToolResult = { ok: true; command: UiCommand } | { ok: false; error: string };

function validTime(value: string): boolean {
  return value === "now" || Number.isFinite(Date.parse(value));
}

function schemaError(name: UiToolName, args: unknown): string {
  const parsed = uiToolSchemas[name].safeParse(args);
  return parsed.success ? "invalid arguments" : z.prettifyError(parsed.error).replace(/\s+/g, " ").trim();
}

export function validateUiToolCall(name: string, args: unknown): UiToolResult {
  if (!isUiToolName(name)) return { ok: false, error: `Unknown UI tool ${name}` };
  const command = parseUiCommand(name, args);
  if (!command) return { ok: false, error: `Invalid ${name} arguments: ${schemaError(name, args)}` };

  switch (command.name) {
    case "fly_to": {
      const { place, lat, lon } = command.args;
      if (lat !== undefined && lon !== undefined) return { ok: true, command };
      const hit = resolvePlace(place ?? "");
      if (!hit) {
        return {
          ok: false,
          error: `Unknown place "${place}". Call fly_to again with lat and lon in decimal degrees.`,
        };
      }
      return {
        ok: true,
        command: {
          name: "fly_to",
          args: { ...command.args, place: hit.name, lat: hit.lat, lon: hit.lon, altitudeM: command.args.altitudeM ?? hit.altitudeM },
        },
      };
    }
    case "set_time":
      return validTime(command.args.time)
        ? { ok: true, command }
        : { ok: false, error: `Invalid set_time time "${command.args.time}": use RFC 3339 or "now".` };
    case "play_timeline": {
      const { from, to } = command.args;
      for (const [label, value] of [["from", from], ["to", to]] as const) {
        if (value !== undefined && !validTime(value)) {
          return { ok: false, error: `Invalid play_timeline ${label} "${value}": use RFC 3339 or "now".` };
        }
      }
      if (from && to && from !== "now" && to !== "now" && Date.parse(from) > Date.parse(to)) {
        return { ok: false, error: "play_timeline from must be before to." };
      }
      return { ok: true, command };
    }
    default:
      return { ok: true, command };
  }
}
