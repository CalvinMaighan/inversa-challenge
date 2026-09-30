import { get, set } from "@calvinjs/active-state";

import { LAYERS, SELECTION, TIME, VIEW, VOICE } from "client/state";
import { setLayerVisible, setSpeciesVisible } from "client/state/layers";
import { parseEvidenceId, type SelectionState } from "client/state/selection";
import { clampToWindow, timeWindow, type TimeState } from "client/state/time";
import type { ViewState } from "client/state/view";
import type { VoiceState } from "client/state/voice";
import { parseUiCommand, type UiCommand } from "shared/voice/ui-tools";

import { resolvePlace } from "./gazetteer";
import { bboxAround } from "./hud-state";

/**
 * Applies a `ui.command` voice event to the catalog keys the globe and HUD read (VIEW, TIME,
 * LAYERS, SELECTION). The relay already validated it; the client validates again because the
 * event crossed the network. Returns false when the command was not applied.
 */

const DEFAULT_FLY_ALTITUDE_M = 25_000;

/** `"now"` is the live edge of a fresh window; anything else must parse. */
function instantMs(value: string, nowMs: number): number | null {
  if (value === "now") return nowMs;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function flyTo(command: Extract<UiCommand, { name: "fly_to" }>): boolean {
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
  const target = { lat, lon, altitudeM: altitudeM ?? defaultAltitude };
  set<ViewState>(VIEW, (prev = VIEW.defaults) => ({
    ...prev,
    ...target,
    // The globe re-syncs bbox from the camera once it lands; this keeps it right meanwhile.
    bbox: bboxAround(target.lat, target.lon, target.altitudeM),
    place: placeName,
    seq: prev.seq + 1,
  }));
  return true;
}

/** Jump the cursor; the window is reset to the full 30 days ending now, then the cursor clamped into it. */
function setTime(time: string, nowMs: number): boolean {
  const ms = instantMs(time, nowMs);
  if (ms === null) return false;
  const full = timeWindow(nowMs);
  set<TimeState>(TIME, (prev = TIME.defaults) => ({ ...prev, ...full, at: clampToWindow(ms, full), playing: false }));
  return true;
}

/** from/to narrow the replay window (inside the full 30 days); the cursor starts at `from`. */
function playTimeline(command: Extract<UiCommand, { name: "play_timeline" }>, nowMs: number): boolean {
  const { from, to, speed, playing } = command.args;
  const fromMs = from === undefined ? undefined : instantMs(from, nowMs);
  const toMs = to === undefined ? undefined : instantMs(to, nowMs);
  if (fromMs === null || toMs === null) return false;
  const full = timeWindow(nowMs);
  const prev = { ...TIME.defaults, ...get<TimeState>(TIME) };
  const window = {
    from: fromMs === undefined ? prev.from : clampToWindow(fromMs, full),
    to: toMs === undefined ? prev.to : clampToWindow(toMs, full),
  };
  if (Date.parse(window.from) >= Date.parse(window.to)) return false;
  const at = fromMs === undefined ? clampToWindow(Date.parse(prev.at), window) : window.from;
  set<TimeState>(TIME, { ...prev, ...window, at, speed, playing });
  return true;
}

function apply(command: UiCommand, nowMs: number): boolean {
  switch (command.name) {
    case "fly_to":
      return flyTo(command);
    case "set_time":
      return setTime(command.args.time, nowMs);
    case "play_timeline":
      return playTimeline(command, nowMs);
    case "toggle_layer": {
      const { layer, visible, species } = command.args;
      if (species) {
        // "Hide tegus" filters the species; it does not hide the whole layer. Showing one turns the layer on.
        setSpeciesVisible(species, visible);
        if (visible) setLayerVisible(layer, true);
      } else {
        setLayerVisible(layer, visible);
      }
      return true;
    }
    case "select":
      if (!parseEvidenceId(command.args.evidenceId)) return false;
      set<SelectionState>(SELECTION, (prev = SELECTION.defaults) => ({ ...prev, evidenceId: command.args.evidenceId }));
      return true;
    case "open_evidence":
      if (!parseEvidenceId(command.args.evidenceId)) return false;
      set<SelectionState>(SELECTION, { evidenceId: command.args.evidenceId, drawerOpen: true });
      return true;
  }
}

export function applyUiCommand(event: { name: string; args: unknown }, nowMs = Date.now()): boolean {
  const command = parseUiCommand(event.name, event.args);
  if (!command) return false;
  const applied = apply(command, nowMs);
  if (applied) set<VoiceState>(VOICE, (prev = VOICE.defaults) => ({ ...prev, lastCommand: command.name }));
  return applied;
}
