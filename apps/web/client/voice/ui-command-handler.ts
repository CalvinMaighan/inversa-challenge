import { get, set } from "@calvinjs/active-state";

import { parseUiCommand, type UiCommand } from "shared/voice/ui-tools";

import { resolvePlace } from "./gazetteer";
import { LAYERS, SELECTION, TIME, VIEW, VOICE } from "./state";

/**
 * Applies a `ui.command` voice event to the active-state keys the globe and HUD read
 * (VIEW, TIME, LAYERS, SELECTION). The relay already validated it; the client validates again
 * because the event crossed the network. Returns false when the command was not applied.
 */

const DEFAULT_FLY_ALTITUDE_M = 25_000;

function isoOrNull(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === "now") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function apply(command: UiCommand): boolean {
  switch (command.name) {
    case "fly_to": {
      const { place, altitudeM } = command.args;
      let { lat, lon } = command.args;
      let placeName = place ?? null;
      let defaultAltitude = DEFAULT_FLY_ALTITUDE_M;
      if (lat === undefined || lon === undefined) {
        const hit = resolvePlace(place ?? "");
        if (!hit) return false;
        lat = hit.lat;
        lon = hit.lon;
        placeName = hit.name;
        defaultAltitude = hit.altitudeM;
      }
      const target = { lat, lon };
      set<typeof VIEW.defaults>(VIEW, (prev) => ({
        ...VIEW.defaults,
        ...prev,
        ...target,
        altitudeM: altitudeM ?? defaultAltitude,
        place: placeName,
        seq: (prev?.seq ?? 0) + 1,
      }));
      return true;
    }
    case "set_time": {
      const at = isoOrNull(command.args.time);
      if (at === undefined) return false;
      set<typeof TIME.defaults>(TIME, (prev) => ({ ...TIME.defaults, ...prev, at, playing: false }));
      return true;
    }
    case "play_timeline": {
      const from = isoOrNull(command.args.from);
      const to = isoOrNull(command.args.to);
      if ((command.args.from !== undefined && from === undefined) || (command.args.to !== undefined && to === undefined)) {
        return false;
      }
      set<typeof TIME.defaults>(TIME, (prev) => {
        const base = { ...TIME.defaults, ...prev };
        return {
          ...base,
          playing: command.args.playing,
          speed: command.args.speed,
          from: from === undefined ? base.from : from,
          to: to === undefined ? base.to : to,
          at: from === undefined ? base.at : from,
        };
      });
      return true;
    }
    case "toggle_layer": {
      const { layer, visible, species } = command.args;
      set<typeof LAYERS.defaults>(LAYERS, (prev) => {
        const base = { ...LAYERS.defaults, ...prev };
        const nextSpecies = { ...base.species };
        // A toggle without species means all species on that layer.
        if (species) nextSpecies[layer] = species;
        else delete nextSpecies[layer];
        return { visible: { ...base.visible, [layer]: visible }, species: nextSpecies };
      });
      return true;
    }
    case "select":
      set<typeof SELECTION.defaults>(SELECTION, (prev) => ({ ...SELECTION.defaults, ...prev, evidenceId: command.args.evidenceId }));
      return true;
    case "open_evidence":
      set(SELECTION, { evidenceId: command.args.evidenceId, drawerOpen: true });
      return true;
  }
}

export function applyUiCommand(event: { name: string; args: unknown }): boolean {
  const command = parseUiCommand(event.name, event.args);
  if (!command) return false;
  const applied = apply(command);
  if (applied) {
    const voice = get<typeof VOICE.defaults>(VOICE);
    set(VOICE, { ...VOICE.defaults, ...voice, lastCommand: command.name });
  }
  return applied;
}
