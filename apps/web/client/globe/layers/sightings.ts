/**
 * Sightings: a PointPrimitiveCollection dot per record, coloured by species and fading with age over a 24 h
 * trail, plus a BillboardCollection icon for the four focus species once the camera is close enough to read it.
 *
 * Records come from the EVF2 sighting sections of the trail's frames (via the published FrameTimeline). EVF2
 * records carry no `sightings.id`, so while the timeline is paused the layer asks GraphQL for the same window
 * and draws those rows instead: every primitive then carries `sighting:<id>` for `pick()`. During playback the
 * frame changes several times a second and the ids are not needed, so no request goes out.
 */
import type { FrameGrid } from "@calvinjs/active-state/threads";
import type { BillboardCollection, PointPrimitiveCollection } from "cesium";

import { REGION_BBOX } from "client/state/view";
import { QUALITY_CODES, SIGHTING_FLAG } from "shared/frames";
import { LAYER_IDS, SPECIES_IDS } from "shared/voice/ui-tools";

import type { SightingRecord } from "../api";
import { cesium } from "../cesium";
import { sightingEvidenceId } from "../evidence";
import { frameStartMs } from "../frame-index";
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
const ENRICH_DEBOUNCE_MS = 350;
const ENRICH_CACHE_SIZE = 32;
const CONFLICT_OUTLINE = "#ff3b3b";
/** QUALITY_CODES indices drawn at full strength (research grade, curated); needs_id and casual draw dimmer. */
const STRONG_QUALITY: ReadonlySet<number> = new Set([0, 3]);
const OUTLINE = "#0b0d12";

export const SIGHTINGS_QUERY = `query GlobeSightings($bbox: BBox!, $from: Time!, $to: Time!) {
  sightings(bbox: $bbox, from: $from, to: $to) { id lat lon observedAt quality canonicalId conflict taxon { id } }
}`;

type GqlSighting = {
  id: string;
  lat: number;
  lon: number;
  observedAt: string;
  quality: string;
  canonicalId: string | null;
  conflict: boolean;
  taxon: { id: string };
};

/** A record with its age in ms at the cursor. */
export type TrailRecord = SightingRecord & { ageMs: number };

/** GraphQL rows as EVF-shaped records with ids, aged against `endMs`. */
export function recordsFromGql(rows: readonly GqlSighting[], endMs: number): TrailRecord[] {
  return rows.map((row) => ({
    lon: row.lon,
    lat: row.lat,
    taxon: Number(row.taxon.id),
    quality: Math.max(0, (QUALITY_CODES as readonly string[]).indexOf(row.quality.toLowerCase())),
    flags: (row.canonicalId ? SIGHTING_FLAG.duplicate : 0) | (row.conflict ? SIGHTING_FLAG.conflict : 0),
    id: row.id,
    ageMs: Math.max(0, endMs - Date.parse(row.observedAt)),
  }));
}

/** EVF records of frames `frame - n + 1 .. frame` inside the trail, aged by whole frames. */
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
  const enriched = new Map<string, TrailRecord[]>();
  let pending: { key: string; timer: ReturnType<typeof setTimeout> | null; abort: AbortController | null } | null = null;
  let last: { frame: number; grid: FrameGrid | null } = { frame: -1, grid: null };
  const stats: LayerStats = { id: SIGHTINGS, enabled: false, count: 0, frame: -1, updatedAt: null, error: null };

  const cancelPending = () => {
    if (pending?.timer) clearTimeout(pending.timer);
    pending?.abort?.abort();
    pending = null;
  };

  const iconFor = (species: number) => {
    let img = iconImages.get(species);
    if (!img) {
      img = speciesIcon(species);
      iconImages.set(species, img);
    }
    return img;
  };

  /** Window `[fromMs, toMs)` the trail covers at this cursor. */
  const trailWindow = (frame: number): { fromMs: number; toMs: number } => {
    const timeline = ctx.timeline();
    const end = frame >= 0 && timeline ? frameStartMs(frame, timeline.frame0Ms, timeline.stepMs) + timeline.stepMs : ctx.timeMs();
    return { fromMs: end - SIGHTING_TRAIL_MS, toMs: end };
  };

  const enrich = (key: string, fromMs: number, toMs: number) => {
    if (pending?.key === key || enriched.has(key)) return;
    cancelPending();
    const job: NonNullable<typeof pending> = { key, timer: null, abort: null };
    pending = job;
    job.timer = setTimeout(() => {
      job.timer = null;
      job.abort = new AbortController();
      ctx
        .gql<{ sightings: GqlSighting[] }>(
          SIGHTINGS_QUERY,
          { bbox: { ...REGION_BBOX }, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
          job.abort.signal,
        )
        .then((data) => {
          if (pending !== job) return;
          pending = null;
          enriched.set(key, recordsFromGql(data.sightings, toMs));
          while (enriched.size > ENRICH_CACHE_SIZE) enriched.delete(enriched.keys().next().value!);
          stats.error = null;
          drawnKey = "";
          if (enabled) draw();
        })
        .catch((err: unknown) => {
          if (pending !== job || job.abort?.signal.aborted) return;
          pending = null;
          stats.error = err instanceof Error ? err.message : String(err);
        });
    }, ENRICH_DEBOUNCE_MS);
  };

  const draw = () => {
    if (!points || !icons) return;
    const { frame, grid } = last;
    const { fromMs, toMs } = trailWindow(frame);
    const windowKey = `${fromMs}-${toMs}`;
    const species = enabledSpecies(ctx.layers().species, SIGHTINGS);
    const timeline = ctx.timeline();
    const fromIds = enriched.get(windowKey);
    const source = fromIds ? "gql" : "evf";
    const key = `${windowKey}|${species.join(",")}|${source}|${grid?.version() ?? -1}|${timeline?.frame0Ms}`;
    if (!ctx.playing() && !fromIds) enrich(windowKey, fromMs, toMs);
    if (key === drawnKey) return;
    drawnKey = key;

    const records = fromIds ?? (frame >= 0 && timeline ? trailFromFrames((f) => timeline.sightings(f), frame, timeline.stepMs) : []);
    const visible = visibleRecords(records, species);
    points.removeAll();
    icons.removeAll();
    const { Cartesian2, Cartesian3, Color, DistanceDisplayCondition, VerticalOrigin } = cesium();
    const iconRange = new DistanceDisplayCondition(0, ICON_MAX_DISTANCE_M);
    for (const r of visible) {
      const position = Cartesian3.fromDegrees(r.lon, r.lat);
      const alpha = trailAlpha(r.ageMs) * (STRONG_QUALITY.has(r.quality) ? 1 : 0.8);
      const s = speciesIndexOfTaxon(r.taxon);
      const conflict = (r.flags & SIGHTING_FLAG.conflict) !== 0;
      const id = r.id === undefined ? undefined : sightingEvidenceId(r.id);
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
      cancelPending();
      if (points && icons) {
        points.show = icons.show = false;
        ctx.requestRender();
      }
    },
    update(frameIndex, grid) {
      last = { frame: frameIndex, grid };
      if (!enabled) return;
      if (ctx.playing()) cancelPending();
      draw();
    },
    stats: () => ({ ...stats }),
    destroy() {
      cancelPending();
      if (viewer) {
        if (points) viewer.scene.primitives.remove(points);
        if (icons) viewer.scene.primitives.remove(icons);
      }
      points = icons = null;
      viewer = null;
      enriched.clear();
      enabled = stats.enabled = false;
    },
  };
}
