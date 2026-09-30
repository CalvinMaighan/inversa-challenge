/**
 * Sightings: a PointPrimitiveCollection dot per record, coloured by species and fading with age over a 24 h
 * trail, plus a BillboardCollection icon for the four focus species once the camera is close enough to read it.
 *
 * Records are the decoded EVF2 sighting sections of the trail's frames (C16 FrameSightings). Each carries its
 * `sightings.id`, so every primitive is stamped `sighting:<id>` for `pick()` with no request of its own.
 */
import type { FrameGrid } from "@calvinjs/active-state/threads";
import type { BillboardCollection, PointPrimitiveCollection } from "cesium";

import { SIGHTING_FLAG, type SightingRecord } from "shared/frames";
import { LAYER_IDS, SPECIES_IDS } from "shared/voice/ui-tools";

import { cesium } from "../cesium";
import { sightingEvidenceId } from "../evidence";
import { stepMsOf } from "../frame-index";
import { colorOfTaxon, enabledSpecies, SPECIES_COLORS, speciesIndexOfTaxon } from "../species";
import { createCanvas } from "./raster-surface";
import type { GlobeLayer, GlobeViewer, LayerContext, LayerStats } from "./types";

const [SIGHTINGS] = LAYER_IDS;

/** How far back the trail reaches, and how faint the oldest dot gets. */
export const SIGHTING_TRAIL_MS = 24 * 60 * 60_000;
const OLDEST_ALPHA = 0.25;
/** Icons only when the camera is within this range; from the region overview the dots carry it. */
const ICON_MAX_DISTANCE_M = 250_000;
/** Depth test off within this camera distance so dots stay on top of terrain and 3D tiles. */
const NO_DEPTH_TEST_WITHIN_M = 200_000;
const CONFLICT_OUTLINE = "#ff3b3b";
/** QUALITY_CODES indices drawn at full strength (research grade, curated); needs_id and casual draw dimmer. */
const STRONG_QUALITY: ReadonlySet<number> = new Set([0, 3]);
const OUTLINE = "#0b0d12";

/** A record with its age in ms at the cursor. */
export type TrailRecord = SightingRecord & { ageMs: number };

/** Records of frames `frame - n + 1 .. frame` inside the trail, aged by whole frames. */
export function trailFromFrames(sightings: (frame: number) => readonly SightingRecord[], frame: number, stepMs: number): TrailRecord[] {
  const frames = Math.max(1, Math.ceil(SIGHTING_TRAIL_MS / stepMs));
  const out: TrailRecord[] = [];
  for (let back = 0; back < frames && frame - back >= 0; back += 1) {
    for (const r of sightings(frame - back)) out.push({ ...r, ageMs: back * stepMs });
  }
  return out;
}

/** Records the layer draws: duplicates hidden (their canonical row is drawn), species filter applied. */
export function visibleRecords(records: readonly TrailRecord[], species: readonly number[]): TrailRecord[] {
  const on = new Set(species);
  return records.filter((r) => {
    if (r.flags & SIGHTING_FLAG.duplicate) return false;
    const s = speciesIndexOfTaxon(r.taxon);
    return s < 0 || on.has(s);
  });
}

export function trailAlpha(ageMs: number): number {
  const t = Math.min(1, Math.max(0, ageMs / SIGHTING_TRAIL_MS));
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

  const clear = () => {
    if (!points || !icons || drawnKey === "none") return;
    points.removeAll();
    icons.removeAll();
    drawnKey = "none";
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
    const species = enabledSpecies(ctx.layers().species, SIGHTINGS);
    const key = `${frame}|${species.join(",")}|${grid?.version() ?? -1}|${ctx.revision()}`;
    if (key === drawnKey) return;
    drawnKey = key;

    const { Cartesian2, Cartesian3, Color, DistanceDisplayCondition, VerticalOrigin } = cesium();
    const visible = visibleRecords(trailFromFrames((f) => ctx.sightings(f), frame, stepMsOf(meta)), species);
    points.removeAll();
    icons.removeAll();
    const iconRange = new DistanceDisplayCondition(0, ICON_MAX_DISTANCE_M);
    for (const r of visible) {
      const position = Cartesian3.fromDegrees(r.lon, r.lat);
      const alpha = trailAlpha(r.ageMs) * (STRONG_QUALITY.has(r.quality) ? 1 : 0.8);
      const s = speciesIndexOfTaxon(r.taxon);
      const conflict = (r.flags & SIGHTING_FLAG.conflict) !== 0;
      const id = sightingEvidenceId(r.id);
      points.add({
        id,
        position,
        pixelSize: s >= 0 ? 7 : 5,
        color: Color.fromCssColorString(colorOfTaxon(r.taxon)).withAlpha(alpha),
        outlineColor: Color.fromCssColorString(conflict ? CONFLICT_OUTLINE : OUTLINE).withAlpha(Math.max(alpha, 0.6)),
        outlineWidth: conflict ? 2 : 1,
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
    stats: () => ({ ...stats }),
    destroy() {
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
