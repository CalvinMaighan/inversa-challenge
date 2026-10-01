/**
 * Sightings: a PointPrimitiveCollection dot per record, coloured by taxon and fading with age over the trailing
 * window (LAYERS.sightingHours: 2, 7 or 30 days, T44) ending at the time cursor, plus a BillboardCollection icon
 * for the four focus species once the camera is close enough to read it.
 *
 * Records are the decoded EVF2 sighting sections of the window's frames (C16 FrameSightings). Each carries its
 * `sightings.id`, so every primitive is stamped `sighting:<id>` for `pick()` with no request of its own.
 *
 * Every taxon has its own colour (`client/globe/species.ts`); the filter hides focus species by key, other taxa
 * by their group (animals, plants, others) or their own `t<id>` override. Taxon groups come from the TAXA store
 * through `ctx.taxa()`; a taxon not loaded yet draws as an animal.
 */
import type { FrameGrid } from "@calvinjs/active-state/threads";
import type { BillboardCollection, PointPrimitiveCollection } from "cesium";

import { sightingHoursOf } from "client/state/layers";
import type { TaxonInfo } from "client/state/taxa";
import { SIGHTING_FLAG, SIGHTING_WINDOW_HOURS, type SightingRecord } from "shared/frames";
import { LAYER_IDS, SPECIES_IDS } from "shared/voice/ui-tools";

import { cesium } from "../cesium";
import { sightingEvidenceId } from "../evidence";
import { stepMsOf } from "../frame-index";
import { colorOfTaxon, enabledSpecies, SPECIES_COLORS, speciesIndexOfTaxon, taxonShown } from "../species";
import { createCanvas } from "./raster-surface";
import type { GlobeLayer, GlobeViewer, LayerContext, LayerStats } from "./types";

const [SIGHTINGS] = LAYER_IDS;

/** The trail of the default window, ms. The layer reads the live value from LAYERS. */
export const SIGHTING_TRAIL_MS = SIGHTING_WINDOW_HOURS * 60 * 60_000;
export const trailMs = (hours: number) => hours * 60 * 60_000;
const OLDEST_ALPHA = 0.3;
/** Icons only when the camera is within this range; from the region overview the dots carry it. */
const ICON_MAX_DISTANCE_M = 250_000;
/** Depth test off within this camera distance so dots stay on top of terrain and 3D tiles. */
const NO_DEPTH_TEST_WITHIN_M = 200_000;
const CONFLICT_OUTLINE = "#ff3b3b";
/** QUALITY_CODES indices drawn at full strength (research grade, curated); needs_id and casual draw dimmer. */
const STRONG_QUALITY: ReadonlySet<number> = new Set([0, 3]);
const OUTLINE = "#0b0d12";
/** Dot sizes, px: big enough to hit with a mouse; the selected sighting larger still, ringed in white. */
const FOCUS_PX = 10;
const OTHER_PX = 8;
const SELECTED_PX = 15;

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

/**
 * Records the layer draws: duplicates hidden, the species filter applied (focus species by key, other taxa by
 * their group or their own override, `taxonShown`).
 */
export function visibleRecords(records: readonly TrailRecord[], filter: Readonly<Record<string, unknown>> | undefined, byId: Readonly<Record<string, TaxonInfo>> = {}): TrailRecord[] {
  const on = new Set(enabledSpecies(filter, SIGHTINGS));
  return distinctRecords(records).filter((r) => {
    const s = speciesIndexOfTaxon(r.taxon);
    return s < 0 ? taxonShown(filter, r.taxon, byId, SIGHTINGS) : on.has(s);
  });
}

/**
 * Records per taxon id (as a string key), for the species bar, the chips' counts and the legend. The four
 * focus species are always present (so a chip reads 0, not "—"). Counted before the species filter, so a
 * hidden species still shows what turning it back on would draw.
 */
export function sightingBreakdown(records: readonly Pick<SightingRecord, "taxon">[]): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(SPECIES_IDS.map((_, i) => [String(i + 1), 0]));
  for (const r of records) {
    const key = String(r.taxon);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export function trailAlpha(ageMs: number, trail: number = SIGHTING_TRAIL_MS): number {
  const t = Math.min(1, Math.max(0, ageMs / trail));
  return 1 - (1 - OLDEST_ALPHA) * t;
}

/** Round species badge with the species initial, drawn once per species. */
function speciesIcon(index: number): HTMLCanvasElement {
  const size = 22;
  const canvas = createCanvas(size, size);
  const g = canvas.getContext("2d");
  if (g) {
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2 - 1.5, 0, Math.PI * 2);
    g.fillStyle = SPECIES_COLORS[index]!;
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = OUTLINE;
    g.stroke();
    g.fillStyle = OUTLINE;
    g.font = "bold 12px ui-sans-serif, system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(SPECIES_IDS[index]!.charAt(0).toUpperCase(), size / 2, size / 2 + 0.5);
  }
  return canvas;
}

export function createSightingsLayer(ctx: LayerContext): GlobeLayer {
  let viewer: GlobeViewer | null = null;
  let points: PointPrimitiveCollection | null = null;
  let icons: BillboardCollection | null = null;
  const iconImages = new Map<number, HTMLCanvasElement>();
  let enabled = false;
  let drawnKey = "";
  const stats: LayerStats = { id: SIGHTINGS, enabled: false, count: 0, frame: -1, updatedAt: null, error: null };

  const iconFor = (species: number) => {
    let img = iconImages.get(species);
    if (!img) {
      img = speciesIcon(species);
      iconImages.set(species, img);
    }
    return img;
  };

  /** Drawn records by evidence id, for `describe`. */
  let drawnById = new Map<string, TrailRecord>();
  let windowIndex: SightingWindowIndex | null = null;
  let windowKey = "";

  const clear = () => {
    if (!points || !icons || drawnKey === "none") return;
    points.removeAll();
    icons.removeAll();
    drawnKey = "none";
    drawnById = new Map();
    stats.breakdown = sightingBreakdown([]);
    stats.count = 0;
    ctx.requestRender();
  };

  const draw = (frame: number, grid: FrameGrid | null) => {
    if (!points || !icons) return;
    const meta = ctx.meta();
    if (frame < 0 || !meta) {
      clear();
      return;
    }
    const layers = ctx.layers();
    const filter = layers.species;
    const hours = sightingHoursOf(layers);
    const taxa = ctx.taxa?.() ?? { byId: {}, version: 0 };
    const selected = ctx.selection?.() ?? null;
    const filterKey = Object.entries(filter)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(",");
    const key = `${frame}|${hours}|${filterKey}|${selected}|${grid?.version() ?? -1}|${ctx.revision()}|${taxa.version}`;
    if (key === drawnKey) return;
    drawnKey = key;

    const { Cartesian2, Cartesian3, Color, DistanceDisplayCondition, VerticalOrigin } = cesium();
    // The index follows the published sighting set (revision) and the grid's axis; a scrub step only slices it.
    const indexKey = `${ctx.revision()}|${meta.frame0UnixMs}|${meta.frameCount}|${meta.stepMinutes}`;
    if (indexKey !== windowKey) {
      windowKey = indexKey;
      windowIndex = sightingWindowIndex((f) => ctx.sightings(f), meta.frameCount, stepMsOf(meta));
    }
    const trail = distinctRecords(windowRecords(windowIndex!, frame, hours));
    const visible = visibleRecords(trail, filter, taxa.byId);
    const trailLength = trailMs(hours);
    points.removeAll();
    icons.removeAll();
    const iconRange = new DistanceDisplayCondition(0, ICON_MAX_DISTANCE_M);
    // The selected dot goes in last, so it draws over its neighbours.
    const selectedIndex = selected ? visible.findIndex((r) => sightingEvidenceId(r.id) === selected) : -1;
    const ordered = selectedIndex < 0 ? visible : [...visible.slice(0, selectedIndex), ...visible.slice(selectedIndex + 1), visible[selectedIndex]!];
    for (const r of ordered) {
      const position = Cartesian3.fromDegrees(r.lon, r.lat);
      const alpha = trailAlpha(r.ageMs, trailLength) * (STRONG_QUALITY.has(r.quality) ? 1 : 0.8);
      const s = speciesIndexOfTaxon(r.taxon);
      const conflict = (r.flags & SIGHTING_FLAG.conflict) !== 0;
      const id = sightingEvidenceId(r.id);
      const isSelected = id === selected;
      points.add({
        id,
        position,
        pixelSize: isSelected ? SELECTED_PX : s >= 0 ? FOCUS_PX : OTHER_PX,
        color: Color.fromCssColorString(colorOfTaxon(r.taxon)).withAlpha(isSelected ? 1 : alpha),
        outlineColor: isSelected ? Color.WHITE : Color.fromCssColorString(conflict ? CONFLICT_OUTLINE : OUTLINE).withAlpha(Math.max(alpha, 0.6)),
        outlineWidth: isSelected ? 3 : conflict ? 2 : 1.5,
        disableDepthTestDistance: NO_DEPTH_TEST_WITHIN_M,
      });
      if (s >= 0) {
        icons.add({
          id,
          position,
          image: iconFor(s),
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian2(0, -5),
          color: Color.WHITE.withAlpha(alpha),
          distanceDisplayCondition: iconRange,
          disableDepthTestDistance: NO_DEPTH_TEST_WITHIN_M,
        });
      }
    }
    drawnById = new Map(visible.map((r) => [sightingEvidenceId(r.id), r]));
    stats.breakdown = sightingBreakdown(trail);
    stats.count = visible.length;
    stats.frame = frame;
    stats.updatedAt = ctx.now();
    ctx.requestRender();
  };

  return {
    id: SIGHTINGS,
    init(v) {
      viewer = v;
      const C = cesium();
      points = v.scene.primitives.add(new C.PointPrimitiveCollection({ show: false }));
      icons = v.scene.primitives.add(new C.BillboardCollection({ show: false }));
    },
    enable() {
      enabled = stats.enabled = true;
      if (points && icons) points.show = icons.show = true;
      drawnKey = "";
    },
    disable() {
      enabled = stats.enabled = false;
      if (points && icons) {
        points.show = icons.show = false;
        ctx.requestRender();
      }
    },
    update(frameIndex, grid) {
      if (enabled) draw(frameIndex, grid);
    },
    stats: () => ({ ...stats, breakdown: stats.breakdown && { ...stats.breakdown } }),
    describe(id) {
      const r = enabled ? drawnById.get(id) : undefined;
      return r
        ? { kind: "sighting", id: r.id, taxon: r.taxon, quality: r.quality, ageMs: r.ageMs, conflict: (r.flags & SIGHTING_FLAG.conflict) !== 0, lon: r.lon, lat: r.lat }
        : null;
    },
    destroy() {
      drawnById = new Map();
      if (viewer) {
        if (points) viewer.scene.primitives.remove(points);
        if (icons) viewer.scene.primitives.remove(icons);
      }
      points = icons = null;
      viewer = null;
      enabled = stats.enabled = false;
    },
  };
}
