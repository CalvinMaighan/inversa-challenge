/**
 * The first-run gate (docs/intro.md): pure pieces. Every page load opens behind a blurred full-screen gate that asks
 * for one of the three species; the choice switches the app, then one more click asks for the microphone, and the
 * gate dissolves into the app while the globe flies to the species' area.
 */
import type { BBox } from "shared/agent/events";
import { APP_IDS, getApp, type AppId } from "shared/apps";

import type { ViewState } from "client/state/view";
import { viewFor } from "client/state/view";
import { bboxAround } from "client/voice/hud-state";

export { INTRO_ATTR, LEAVE_MS } from "./constants";

/** Camera height of the first frame: the whole western hemisphere in view. */
export const OVERVIEW_ALTITUDE_M = 16_000_000;
/** Camera height the globe flies to when the experience opens: 5,000 km. */
export const ENTRY_ALTITUDE_M = 5_000_000;
const WORLD_BBOX: BBox = { west: -180, south: -85, east: 180, north: 85 };
const OVERVIEW = { lat: 24, lon: -88 };

export type IntroPhase = "pick" | "enter" | "leaving" | "done";

/** Whole-hemisphere camera, as a fly request (`seq` bumps so the globe acts on it). */
export function overviewView(prev: ViewState): ViewState {
  return { ...prev, ...OVERVIEW, altitudeM: OVERVIEW_ALTITUDE_M, bbox: WORLD_BBOX, heading: 0, pitch: -90, place: null, seq: prev.seq + 1 };
}

/** The app's area from 5,000 km up, as a fly request. */
export function entryView(app: AppId, prev: ViewState): ViewState {
  const preset = viewFor(getApp(app));
  return {
    ...prev,
    lat: preset.lat,
    lon: preset.lon,
    altitudeM: ENTRY_ALTITUDE_M,
    bbox: bboxAround(preset.lat, preset.lon, ENTRY_ALTITUDE_M),
    heading: 0,
    pitch: -90,
    place: null,
    seq: prev.seq + 1,
  };
}

const [CARP_ID, LIONFISH_ID, PYTHON_ID] = APP_IDS;

export type SpeciesCard = { id: AppId; title: string; area: string; blurb: string; stat: string };

/** What each gate card says. Order is APP_IDS order, the selector's. */
const CARDS: Record<AppId, Omit<SpeciesCard, "id">> = {
  [CARP_ID]: { title: "Asian carp", area: "Mississippi River Basin", blurb: "Silver, bighead, grass and black carp moving up the river, with the gauges that drive them.", stat: "Sightings and river conditions" },
  [LIONFISH_ID]: { title: "Lionfish", area: "Caribbean reefs", blurb: "Where to survey next across four reef regions, from sightings, heat stress and ocean conditions.", stat: "Survey priorities" },
  [PYTHON_ID]: { title: "Burmese python", area: "South Florida", blurb: "Where pythons are active in the Everglades and where removal crews should go next.", stat: "Hotspots and crew routes" },
};

export function speciesCards(): SpeciesCard[] {
  return APP_IDS.map((id) => ({ id, ...CARDS[id] }));
}

/** Download progress of the background preload, 0 to 1 (1 when there is nothing to fetch). */
export function progressOf(done: number, total: number): number {
  return total <= 0 ? 1 : Math.min(1, done / total);
}
