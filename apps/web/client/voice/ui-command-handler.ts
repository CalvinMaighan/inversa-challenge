import { get, set } from "@calvinjs/active-state";

import { dispatchThread } from "client/agent/chat/store";
import { fishById, filterSpecies, selectFish, SPECIES_COLORS } from "client/carp/fish";
import { getGlobe } from "client/globe/api";
import { fitInPane } from "client/globe/fit";
import { switchApp } from "client/hud/appselect/switch";
import { applyRange } from "client/hud/range/apply";
import { clearSelection } from "client/hud/selection";
import { setView as setLionfishView } from "client/lionfish/store";
import { SELECTION, TIME, VIEW, VOICE } from "client/state";
import { activeApp } from "client/state/app";
import { LAYERS, setLayerVisible, setSpeciesVisible, type LayersState } from "client/state/layers";
import { LOOK, type LookId } from "client/state/look";
import { MENU } from "client/state/menu";
import { RANGE_DAYS } from "client/state/range";
import { canonicalEvidenceId, parseEvidenceId, type SelectionState } from "client/state/selection";
import { clampToWindow, TIME_STEP_MINUTES, TIME_WINDOW_DAYS, timeWindow, windowFor, type TimeState } from "client/state/time";
import type { ViewState } from "client/state/view";
import type { VoiceState } from "client/state/voice";
import { APP_IDS, speciesIds } from "shared/apps";
import type { EvidenceKind } from "shared/agent/events";
import { parseUiCommand, type UiCommand } from "shared/voice/ui-tools";
import { isVoiceLive, startVoice } from "./voice-runtime";

import { resolvePlace } from "./gazetteer";
import { bboxAround } from "./hud-state";

/**
 * Applies a `ui.command` voice event (or the text agent's `ui` stream event) to the catalog keys the globe
 * and HUD read (VIEW, TIME, LAYERS, SELECTION, LOOK). The relay already validated it; the client validates again because the
 * event crossed the network. Returns false when the command was not applied.
 */

const DEFAULT_FLY_ALTITUDE_M = 25_000;
/** A voice session switches apps after the assistant's few words of confirmation. */
const VOICE_SWITCH_DELAY_MS = 2_200;
const STEP_MS = TIME_STEP_MINUTES * 60_000;
const WINDOW_MS = TIME_WINDOW_DAYS * 86_400_000;

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

/**
 * Jump the cursor. Inside the last 30 days the window resets to the full 30 days ending now; an older time
 * recentres the window on it (`windowFor`), which makes the db worker fetch that window's frames.
 */
function setTime(time: string, nowMs: number): boolean {
  const ms = instantMs(time, nowMs);
  if (ms === null) return false;
  set<TimeState>(TIME, (prev = TIME.defaults) => ({ ...prev, ...windowFor(ms, nowMs), playing: false }));
  return true;
}

/**
 * from/to set the replay window, snapped to the frame grid, ending no later than now and spanning at most 30
 * days (a longer span keeps its end). One bound alone keeps the other from the current window when that
 * still makes a valid window, else takes the 30 days from `from` or up to `to`. The cursor starts at `from`.
 */
function playTimeline(command: Extract<UiCommand, { name: "play_timeline" }>, nowMs: number): boolean {
  const { from, to, speed, playing } = command.args;
  const fromMs = from === undefined ? undefined : instantMs(from, nowMs);
  const toMs = to === undefined ? undefined : instantMs(to, nowMs);
  if (fromMs === null || toMs === null) return false;
  const liveTo = Date.parse(timeWindow(nowMs).to);
  const prev = { ...TIME.defaults, ...get<TimeState>(TIME) };
  const snap = (ms: number) => Math.round(ms / STEP_MS) * STEP_MS;
  let end = Math.min(liveTo, snap(toMs ?? Date.parse(prev.to)));
  let start = snap(fromMs ?? Date.parse(prev.from));
  if (toMs === undefined && fromMs !== undefined && (end <= start || end - start > WINDOW_MS)) end = Math.min(liveTo, start + WINDOW_MS);
  if (fromMs === undefined && toMs !== undefined && (end <= start || end - start > WINDOW_MS)) start = end - WINDOW_MS;
  if (end - start > WINDOW_MS) start = end - WINDOW_MS;
  if (start >= end) return false;
  const window = { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
  const at = fromMs === undefined ? clampToWindow(Date.parse(prev.at), window) : window.from;
  set<TimeState>(TIME, { ...prev, ...window, at, speed, playing });
  return true;
}

/** The carp legend's species by filter key ("silver" is "Silver carp"). */
const carpSpeciesName = (key: string) => SPECIES_COLORS.find((s) => s.name.toLowerCase().startsWith(key.toLowerCase()))?.name ?? null;

/** An area of the active app by id or (part of) its name. */
function findArea(name: string) {
  const want = name.trim().toLowerCase();
  const app = activeApp();
  return (
    app.regions.find((r) => r.id.toLowerCase() === want) ??
    app.regions.find((r) => r.name.toLowerCase().includes(want) || want.includes(r.name.toLowerCase())) ??
    app.regions.find((r) => (r.code ?? "").toLowerCase() === want) ??
    // Python's and carp's one area answers to its own words ("Florida", "the basin").
    (app.regions.length === 1 ? app.regions[0] : undefined)
  );
}

function selectArea(name: string): boolean {
  const area = findArea(name);
  if (!area) return false;
  if (activeApp().id === APP_IDS[1]) setLionfishView({ area: area.id });
  const pose = fitInPane(area.bbox, 24) ?? { lat: area.camera.lat, lon: area.camera.lon, altitudeM: area.camera.heightM, heading: 0, pitch: -90 };
  const globe = getGlobe();
  if (globe) globe.flyTo({ ...pose, durationS: 1.2 });
  else set<ViewState>(VIEW, (prev = VIEW.defaults) => ({ ...prev, lat: pose.lat, lon: pose.lon, altitudeM: pose.altitudeM, seq: prev.seq + 1, place: area.name }));
  return true;
}

function zoom(direction: "in" | "out" | "fit"): boolean {
  if (direction === "fit") return selectArea(activeApp().regions[0]?.id ?? "");
  const view = { ...VIEW.defaults, ...get<ViewState>(VIEW) };
  const altitudeM = Math.min(40_000_000, Math.max(400, direction === "in" ? view.altitudeM * 0.5 : view.altitudeM * 2));
  const globe = getGlobe();
  if (globe) globe.flyTo({ lon: view.lon, lat: view.lat, altitudeM, heading: view.heading, pitch: view.pitch, durationS: 0.8 });
  else set<ViewState>(VIEW, (prev = VIEW.defaults) => ({ ...prev, altitudeM, seq: prev.seq + 1 }));
  return true;
}

/** A carp sighting by evidence id `fish:<id>`: its panel opens and the globe flies to it. */
function openFish(evidenceId: string): boolean {
  const id = evidenceId.slice("fish:".length);
  const fish = fishById(id);
  if (!fish) return false;
  selectFish(id);
  getGlobe()?.flyTo({ lon: fish.lon, lat: fish.lat, altitudeM: 150_000, durationS: 1.2 });
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
        // "Hide pythons" filters the species; it does not hide the whole layer. Showing one turns the layer on.
        setSpeciesVisible(species, visible);
        if (visible) setLayerVisible(layer, true);
      } else {
        setLayerVisible(layer, visible);
      }
      return true;
    }
    case "open_menu":
      set<string | null>(MENU, command.args.open ? command.args.menu : get<string | null>(MENU) === command.args.menu ? null : get<string | null>(MENU) ?? null);
      return true;
    case "set_period":
      set<number>(RANGE_DAYS, command.args.days);
      applyRange(command.args.days);
      return true;
    case "filter_species": {
      const { species, visible, only } = command.args;
      if (activeApp().id === APP_IDS[0]) {
        const name = carpSpeciesName(species);
        if (!name) return false;
        filterSpecies(name, visible, only);
        return true;
      }
      for (const id of speciesIds(activeApp())) setSpeciesVisible(id, only ? id === species : id === species ? visible : (get<LayersState>(LAYERS)?.species?.[id] ?? true));
      return true;
    }
    case "select_area":
      return selectArea(command.args.area);
    case "zoom":
      return zoom(command.args.direction);
    case "show_card": {
      const { title, text, sources } = command.args;
      // The sources are labelled records, each openable from the chat (a sighting's id opens its card on the map).
      dispatchThread({
        type: "card",
        id: `card-${nowMs}-${Math.round(Math.random() * 1e6)}`,
        nowMs,
        card: { title, text, sources: sources.map((s) => ({ id: s.id, kind: (s.id.split(":")[0] ?? "source") as EvidenceKind, label: s.label })) },
      });
      return true;
    }
    case "switch_app": {
      const target = command.args.app;
      if (target === activeApp().id) return true;
      // A live voice session belongs to the old app (switchApp closes it): it reconnects in the new one.
      if (isVoiceLive()) {
        // The assistant is saying it did it: let it finish, then move and reconnect.
        setTimeout(() => {
          switchApp(target);
          setTimeout(() => void startVoice(), 400);
        }, VOICE_SWITCH_DELAY_MS);
        return true;
      }
      switchApp(target);
      return true;
    }
    case "close_panel":
      selectFish(null);
      clearSelection();
      return true;
    case "select": {
      const evidenceId = canonicalEvidenceId(command.args.evidenceId);
      if (evidenceId.startsWith("fish:")) return openFish(evidenceId);
      if (!parseEvidenceId(evidenceId)) return false;
      set<SelectionState>(SELECTION, (prev = SELECTION.defaults) => ({ ...prev, evidenceId }));
      return true;
    }
    case "open_evidence": {
      const evidenceId = canonicalEvidenceId(command.args.evidenceId);
      if (evidenceId.startsWith("fish:")) return openFish(evidenceId);
      if (!parseEvidenceId(evidenceId)) return false;
      set<SelectionState>(SELECTION, { evidenceId, drawerOpen: true });
      return true;
    }
    case "set_look":
      set<LookId>(LOOK, command.args.look);
      return true;
  }
}

/**
 * Validate and apply one UI command against the active app, from the voice relay or the text agent's `ui` stream
 * event (GE7). Returns the command applied, or null.
 */
export function applyUiEvent(event: { name: string; args: unknown }, nowMs = Date.now()): UiCommand | null {
  const command = parseUiCommand(event.name, event.args, activeApp());
  return command && apply(command, nowMs) ? command : null;
}

export function applyUiCommand(event: { name: string; args: unknown }, nowMs = Date.now()): boolean {
  const command = applyUiEvent(event, nowMs);
  if (command) set<VoiceState>(VOICE, (prev = VOICE.defaults) => ({ ...prev, lastCommand: command.name }));
  return command !== null;
}
