/**
 * The two "way back" moves of the zoom controls (gates/leaf-GE8.md G2), through VIEW like every other camera move
 * (the share link and the agent see them): Reset view flies to the app's map preset, Fit sightings frames the
 * sightings the map shows right now (the trailing window at the time cursor, the species filter applied).
 */
import { get, set } from "@calvinjs/active-state";

import { boxOf, fitInPane } from "client/globe/fit";
import { frameForTime, stepMsOf } from "client/globe/frame-index";
import { sightingWindowIndex, visibleRecords, windowRecords } from "client/globe/layers/sightings";
import { activeApp } from "client/state/app";
import { LAYERS, sightingHoursOf, type LayersState } from "client/state/layers";
import { TIME, type TimeState } from "client/state/time";
import { altitudeToFit, VIEW, viewFor, type ViewState } from "client/state/view";
import { getFrameMeta, getFrameSightings } from "client/threads/api";
import type { BBox } from "shared/agent/events";
import { hasLayer, LAYER_IDS, type AppConfig } from "shared/apps";

const [SIGHTINGS] = LAYER_IDS;

/** A single sighting (or a tight cluster) is framed at least this wide, degrees (about 2 km). */
const MIN_SPAN_DEG = 0.02;
/** Room for a marker and its label at the frame's edge, px. */
const MARKER_INSET_PX = 36;

/** Whether the app draws sightings at all (carp shows river sites instead). */
export const appHasSightings = (app: AppConfig = activeApp()) => hasLayer(app, SIGHTINGS);

/** Positions of the sightings on the map now: the layer on, the window at the cursor, the species filter. */
export function visibleSightings(): { lat: number; lon: number }[] {
  const meta = getFrameMeta();
  const sightings = getFrameSightings();
  const layers = { ...LAYERS.defaults, ...get<LayersState>(LAYERS) };
  if (!meta || !sightings || layers.visible[SIGHTINGS] === false) return [];
  const time = { ...TIME.defaults, ...get<TimeState>(TIME) };
  const frame = frameForTime(Date.parse(time.at), meta);
  if (frame < 0) return [];
  const index = sightingWindowIndex((f) => (f < sightings.counts.length ? sightings.records(f) : []), meta.frameCount, stepMsOf(meta));
  return visibleRecords(windowRecords(index, frame, sightingHoursOf(layers)), layers.species).map((r) => ({ lat: r.lat, lon: r.lon }));
}

/** The box around points, at least MIN_SPAN_DEG on each side. */
export function sightingsBox(points: readonly { lat: number; lon: number }[]): BBox {
  const b = boxOf(points);
  const padLon = Math.max(0, MIN_SPAN_DEG - (b.east - b.west)) / 2;
  const padLat = Math.max(0, MIN_SPAN_DEG - (b.north - b.south)) / 2;
  return { west: b.west - padLon, east: b.east + padLon, south: b.south - padLat, north: b.north + padLat };
}

const fly = (to: Pick<ViewState, "lat" | "lon" | "altitudeM">) =>
  set<ViewState>(VIEW, (prev = VIEW.defaults) => ({ ...prev, ...to, heading: 0, pitch: -90, place: null, seq: prev.seq + 1 }));

/** Frame the visible sightings; false (and no move) when the map shows none. */
export function fitSightings(): boolean {
  const points = visibleSightings();
  if (points.length === 0) return false;
  const box = sightingsBox(points);
  const pose = fitInPane(box, MARKER_INSET_PX);
  fly(pose ?? { lat: (box.south + box.north) / 2, lon: (box.west + box.east) / 2, altitudeM: altitudeToFit(box) });
  return true;
}

/** Back to the app's map preset (its regions, its default altitude, straight down). */
export function resetView(): void {
  set<ViewState>(VIEW, (prev = VIEW.defaults) => viewFor(activeApp(), prev.seq + 1));
}
