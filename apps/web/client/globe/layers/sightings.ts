/**
 * Sightings: one icon billboard per record of the app's species, the app's icon (a python is a snake) tinted in
 * the species colour, fading with age over the trailing window (LAYERS.sightingHours, the app's default window)
 * ending at the time cursor. A second BillboardCollection draws a ring behind the selected marker (white) and
 * behind markers whose IDs conflict (red).
 *
 * Images come from `client/globe/marker-icons.ts`: one canvas per icon and colour, registered with Cesium under a
 * stable id (`Billboard.setImage(id, image)`), so the texture atlas holds one region however many markers there
 * are, and nothing is drawn per marker.
 *
 * Records are the decoded EVF2 sighting sections of the window's frames (C16 FrameSightings). Each carries its
 * `sightings.id`, so every billboard is stamped `sighting:<id>` for `pick()` with no request of its own. The
 * species filter hides the focus species by key; a record of any other taxon is not drawn.
 */
import type { FrameGrid } from "@calvinjs/active-state/threads";
import type { BillboardCollection } from "cesium";

import { SIGHTING_FLAG, SIGHTING_WINDOW_HOURS, type SightingRecord } from "shared/frames";
import { isSurveyApp } from "client/lionfish/model";
import { activeApp } from "client/state/app";
import { LAYER_IDS } from "shared/voice/ui-tools";

import { cesium } from "../cesium";
import { sightingEvidenceId } from "../evidence";
import { stepMsOf } from "../frame-index";
import { markerImage, markerImageCount, pulseImage, ringImage } from "../marker-icons";
import { colorOfTaxon, recordShown } from "../species";
import type { GlobeLayer, GlobeViewer, LayerContext, LayerStats } from "./types";

const [SIGHTINGS] = LAYER_IDS;

/** The trail of the default window, ms. The layer reads the live value from LAYERS. */
export const SIGHTING_TRAIL_MS = SIGHTING_WINDOW_HOURS * 60 * 60_000;
export const trailMs = (hours: number) => hours * 60 * 60_000;
const OLDEST_ALPHA = 0.3;
/** Depth test off within this camera distance so markers stay on top of terrain and 3D tiles. */
const NO_DEPTH_TEST_WITHIN_M = 200_000;
const CONFLICT_RING = "#ff3b3b";
const SELECTED_RING = "#ffffff";
/** Marker scale; the selected one larger. A conflict ring sits a little inside the marker. */
const MARKER_SCALE = 1;
const RING_SCALE = 0.85;
const SELECTED_SCALE = 1.35;

/** A record with its age in ms at the cursor. */
export type TrailRecord = SightingRecord & { ageMs: number };

/**
 * Every record of the grid in frame order, with where each frame starts, built once per published sighting
 * set. The window at frame `f` is then one slice, `frame - n + 1 .. f`, so scrubbing never re-merges frames.
 */
export type SightingWindowIndex = { records: readonly SightingRecord[]; frameOf: Uint32Array; offsets: Uint32Array; stepMs: number };

export function sightingWindowIndex(sightings: (frame: number) => readonly SightingRecord[], frameCount: number, stepMs: number): SightingWindowIndex {
  const records: SightingRecord[] = [];
  const frameOfList: number[] = [];
  const offsets = new Uint32Array(Math.max(0, frameCount) + 1);
  for (let f = 0; f < frameCount; f += 1) {
    offsets[f] = records.length;
    for (const r of sightings(f)) {
      records.push(r);
      frameOfList.push(f);
    }
  }
  offsets[Math.max(0, frameCount)] = records.length;
  return { records, frameOf: Uint32Array.from(frameOfList), offsets, stepMs };
}

/** Frames in the window: those starting less than `hours` before the cursor's frame. */
export const windowFrames = (stepMs: number, hours: number = SIGHTING_WINDOW_HOURS) => Math.max(1, Math.ceil(trailMs(hours) / stepMs));

/**
 * Records of the trailing window ending at `frame`, oldest first (the newest draw on top), aged by whole
 * frames: a record `n` frames back is `n × step` old, and nothing `hours` old or older is in.
 */
export function windowRecords(index: SightingWindowIndex, frame: number, hours: number = SIGHTING_WINDOW_HOURS): TrailRecord[] {
  const last = Math.min(frame, index.offsets.length - 2);
  if (last < 0) return [];
  const first = Math.max(0, last - windowFrames(index.stepMs, hours) + 1);
  const out: TrailRecord[] = [];
  for (let i = index.offsets[first]!; i < index.offsets[last + 1]!; i += 1) out.push({ ...index.records[i]!, ageMs: (last - index.frameOf[i]!) * index.stepMs });
  return out;
}

/** Records with duplicates hidden (their canonical row stands for them). */
export function distinctRecords(records: readonly TrailRecord[]): TrailRecord[] {
  return records.filter((r) => !(r.flags & SIGHTING_FLAG.duplicate));
}

/** Records the layer draws: duplicates hidden, records of the focus species only, the species filter applied. */
export function visibleRecords(records: readonly TrailRecord[], filter: Readonly<Record<string, unknown>> | undefined): TrailRecord[] {
  return distinctRecords(records).filter((r) => recordShown(filter, r.taxon));
}

/**
 * Records of the focus species per taxon id (as a string key), for the species chip's count and the legend. The
 * focus species is always present (so the chip reads 0, not "—"). Counted before the species filter, so a hidden
 * species still shows what turning it back on would draw.
 */
export function sightingBreakdown(records: readonly Pick<SightingRecord, "taxon">[]): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(activeApp().taxa.map((t) => [String(t.dbId), 0]));
  for (const r of records) {
    const key = String(r.taxon);
    if (key in out) out[key]! += 1;
  }
  return out;
}

export function trailAlpha(ageMs: number, trail: number = SIGHTING_TRAIL_MS): number {
  const t = Math.min(1, Math.max(0, ageMs / trail));
  return 1 - (1 - OLDEST_ALPHA) * t;
}

export function createSightingsLayer(ctx: LayerContext): GlobeLayer {
  let viewer: GlobeViewer | null = null;
  let icons: BillboardCollection | null = null;
  let rings: BillboardCollection | null = null;
  let enabled = false;
  let drawnKey = "";
  const stats: LayerStats = { id: SIGHTINGS, enabled: false, count: 0, frame: -1, updatedAt: null, error: null };

  /** Drawn records by evidence id, for `describe`. */
  let drawnById = new Map<string, TrailRecord>();
  let windowIndex: SightingWindowIndex | null = null;
  let windowKey = "";

  /** The selected dot's pulse: a disc behind it that grows and fades, over and over, until the next draw. */
  let pulseFrame = 0;
  const stopPulse = () => {
    if (pulseFrame) cancelAnimationFrame(pulseFrame);
    pulseFrame = 0;
  };
  const PULSE_MS = 1600;
  const startPulse = (halo: { scale: number; color: unknown }) => {
    stopPulse();
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const { Color } = cesium();
    const t0 = performance.now();
    const step = (now: number) => {
      const phase = ((now - t0) % PULSE_MS) / PULSE_MS;
      halo.scale = 0.5 + phase * 1.9;
      halo.color = Color.WHITE.withAlpha(0.6 * (1 - phase));
      ctx.requestRender();
      pulseFrame = requestAnimationFrame(step);
    };
    pulseFrame = requestAnimationFrame(step);
  };

  const clear = () => {
    stopPulse();
    if (!icons || !rings || drawnKey === "none") return;
    icons.removeAll();
    rings.removeAll();
    drawnKey = "none";
    drawnById = new Map();
    stats.breakdown = sightingBreakdown([]);
    stats.count = 0;
    stats.marker = { kind: "billboard", dots: 0, images: markerImageCount() };
    ctx.requestRender();
  };

  const draw = (frame: number, grid: FrameGrid | null) => {
    if (!icons || !rings) return;
    const meta = ctx.meta();
    if (frame < 0 || !meta) {
      clear();
      return;
    }
    const layers = ctx.layers();
    const filter = layers.species;
    // Every sighting of the selected period (the timeline's start date to the cursor), not a trailing few days.
    const hours = Math.ceil((meta.frameCount * stepMsOf(meta)) / 3_600_000);
    const selected = ctx.selection?.() ?? null;
    const filterKey = Object.entries(filter)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(",");
    const key = `${frame}|${hours}|${filterKey}|${selected}|${grid?.version() ?? -1}|${ctx.revision()}`;
    if (key === drawnKey) return;
    drawnKey = key;

    const { Cartesian3, Color, VerticalOrigin } = cesium();
    // The index follows the published sighting set (revision) and the grid's axis; a scrub step only slices it.
    const indexKey = `${ctx.revision()}|${meta.frame0UnixMs}|${meta.frameCount}|${meta.stepMinutes}`;
    if (indexKey !== windowKey) {
      windowKey = indexKey;
      windowIndex = sightingWindowIndex((f) => ctx.sightings(f), meta.frameCount, stepMsOf(meta));
    }
    const trail = distinctRecords(windowRecords(windowIndex!, frame, hours));
    const visible = visibleRecords(trail, filter);
    const icon = activeApp().icon;
    stopPulse();
    icons.removeAll();
    rings.removeAll();
    // The selected marker goes in last, so it draws over its neighbours.
    const selectedIndex = selected ? visible.findIndex((r) => sightingEvidenceId(r.id) === selected) : -1;
    const ordered = selectedIndex < 0 ? visible : [...visible.slice(0, selectedIndex), ...visible.slice(selectedIndex + 1), visible[selectedIndex]!];
    for (const r of ordered) {
      const position = Cartesian3.fromDegrees(r.lon, r.lat);
      // Full opacity whatever the age or quality: colour, not fading, tells the species apart.
      const alpha = 1;
      const conflict = (r.flags & SIGHTING_FLAG.conflict) !== 0;
      const id = sightingEvidenceId(r.id);
      const isSelected = id === selected;
      // visibleRecords keeps focus taxa only, so the colour is always there.
      const image = markerImage(icon, colorOfTaxon(r.taxon)!);
      const marker = icons.add({
        id,
        position,
        scale: isSelected ? SELECTED_SCALE : MARKER_SCALE,
        color: Color.WHITE,
        verticalOrigin: VerticalOrigin.CENTER,
        disableDepthTestDistance: NO_DEPTH_TEST_WITHIN_M,
      });
      marker.setImage(image.id, image.image);
      if (isSelected) {
        // Behind the ring: a disc in the species' colour that pulses outward.
        const pulse = pulseImage(colorOfTaxon(r.taxon)!);
        const disc = rings.add({ id, position, scale: 0.5, color: Color.WHITE.withAlpha(0.6), verticalOrigin: VerticalOrigin.CENTER, disableDepthTestDistance: NO_DEPTH_TEST_WITHIN_M });
        disc.setImage(pulse.id, pulse.image);
        startPulse(disc);
      }
      if (isSelected || conflict) {
        const ring = ringImage(isSelected ? SELECTED_RING : CONFLICT_RING);
        const halo = rings.add({
          id,
          position,
          scale: isSelected ? SELECTED_SCALE : RING_SCALE,
          color: Color.WHITE.withAlpha(alpha),
          verticalOrigin: VerticalOrigin.CENTER,
          disableDepthTestDistance: NO_DEPTH_TEST_WITHIN_M,
        });
        halo.setImage(ring.id, ring.image);
      }
    }
    drawnById = new Map(visible.map((r) => [sightingEvidenceId(r.id), r]));
    stats.breakdown = sightingBreakdown(trail);
    stats.count = visible.length;
    stats.frame = frame;
    stats.updatedAt = ctx.now();
    stats.marker = { kind: "billboard", dots: 0, images: markerImageCount() };
    ctx.requestRender();
  };

  return {
    id: SIGHTINGS,
    init(v) {
      viewer = v;
      const C = cesium();
      rings = v.scene.primitives.add(new C.BillboardCollection({ show: false }));
      icons = v.scene.primitives.add(new C.BillboardCollection({ show: false }));
    },
    enable() {
      enabled = stats.enabled = true;
      if (icons && rings) icons.show = rings.show = true;
      drawnKey = "";
    },
    disable() {
      stopPulse();
      enabled = stats.enabled = false;
      if (icons && rings) {
        icons.show = rings.show = false;
        ctx.requestRender();
      }
    },
    update(frameIndex, grid) {
      if (!enabled) return;
      // A survey app (Lionfish Watch) draws its reports itself, by date basis and with GBIF copies marked.
      if (isSurveyApp(activeApp())) clear();
      else draw(frameIndex, grid);
    },
    stats: () => ({ ...stats, breakdown: stats.breakdown && { ...stats.breakdown }, marker: stats.marker && { ...stats.marker } }),
    describe(id) {
      const r = enabled ? drawnById.get(id) : undefined;
      return r
        ? { kind: "sighting", id: r.id, taxon: r.taxon, quality: r.quality, ageMs: r.ageMs, conflict: (r.flags & SIGHTING_FLAG.conflict) !== 0, lon: r.lon, lat: r.lat }
        : null;
    },
    destroy() {
      stopPulse();
      drawnById = new Map();
      if (viewer) {
        if (icons) viewer.scene.primitives.remove(icons);
        if (rings) viewer.scene.primitives.remove(rings);
      }
      icons = rings = null;
      viewer = null;
      enabled = stats.enabled = false;
    },
  };
}
