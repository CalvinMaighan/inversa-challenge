/**
 * Ships (GE4, docs/GODS_EYE.md GC4): AIS vessels from GraphQL `vessels`, drawn where they were at the timeline
 * time and moving as the timeline plays. One arrow billboard per ship, coloured by type and turned to its course
 * (a dot when stopped), with a trail of the last three hours fading toward its tail (three polylines per ship, older
 * thirds fainter). Positions are interpolated between fixes (`shared/vessels.ts`); while the timeline plays, the
 * layer tweens from the last drawn time to the new one on animation frames, so ships glide instead of jumping a
 * whole step.
 *
 * Time: a species app follows TIME (the viewer calls `update` on every change); a conditions app (carp) follows
 * its "what we knew" time (CARP.asOf, live when absent) and its replay, which the layer subscribes to itself,
 * plus a 30 s tick for the live edge. Every primitive carries `vessel:<mmsi>`, so a click opens the vessel card.
 * Only apps that list the layer (carp, lionfish) fetch anything; it starts off (C-A3 `defaultOn: false`). While
 * it is on, the globe's credit line shows "Vessel positions: AISStream.io".
 */
import { subscribe } from "@calvinjs/active-state";
import type { Billboard, BillboardCollection, Material, Polyline, PolylineCollection } from "cesium";

import { activeApp } from "client/state/app";
import { CARP, carpState } from "client/state/carp";
import { appBBox, hasLayer, LAYER_IDS } from "shared/apps";
import {
  parseTracks,
  positionAt,
  trailAt,
  VESSEL_COLORS,
  VESSEL_CREDIT,
  VESSEL_TRAIL_MS,
  vesselEvidenceId,
  type GqlVesselTrack,
  type VesselCategory,
  type VesselTrack,
} from "shared/vessels";

import { cesium } from "../cesium";
import { bucketOfKey, createKeyedFetch, dataKey, type KeyedFetch } from "./keyed-fetch";
import { createCanvas } from "./raster-surface";
import type { GlobeLayer, GlobeViewer, LayerContext, LayerStats } from "./types";

const VESSELS = LAYER_IDS[9];

const HOUR_MS = 3_600_000;
/** One fetch covers a bucket of this length plus the trail and a step of tween lag before it. */
export const VESSEL_BUCKET_MS = 6 * HOUR_MS;
const LEAD_MS = VESSEL_TRAIL_MS + HOUR_MS;
/** Live-edge buckets refetch at most this often. */
const LIVE_REFRESH_MS = 60_000;
const TICK_MS = 30_000;
/** Longest tween; a slower timeline jumps instead of crawling. */
const MAX_TWEEN_MS = 1000;
const MIN_TWEEN_MS = 60;
/** A cursor move larger than this is a jump (scrub, preset), never a tween. */
const MAX_TWEEN_SPAN_MS = 6 * HOUR_MS;
const MAX_REPORTED_POSITIONS = 200;
/** Trail thirds, oldest first. */
const TRAIL_ALPHA = [0.2, 0.45, 0.8] as const;
const ICON_PX = 24;
const OUTLINE = "#0b0d12";
/** Depth test off within this camera distance so ships stay on top of terrain and 3D tiles. */
const NO_DEPTH_TEST_WITHIN_M = 200_000;

export const VESSELS_QUERY = `query GlobeVessels($bbox: BBox!, $from: Time!, $to: Time!) {
  vessels(bbox: $bbox, from: $from, to: $to, limit: 500) { mmsi name type points { at lat lon sog cog heading } }
}`;

/** The bucket holding `t`. */
export function vesselBucket(t: number): number {
  return Math.floor(t / VESSEL_BUCKET_MS) * VESSEL_BUCKET_MS;
}

/** The window one bucket's fetch asks for: the trail and a tween step before it, up to its end (capped at now). */
export function vesselWindow(bucketMs: number, nowMs: number): { from: number; to: number } {
  return { from: bucketMs - LEAD_MS, to: Math.min(bucketMs + VESSEL_BUCKET_MS, Math.max(nowMs, bucketMs)) };
}

/** The time ships are drawn at: TIME in a species app; CARP.asOf (live: now) in a conditions app. */
export function vesselTargetTime(ctx: Pick<LayerContext, "timeMs">, nowMs: number): number {
  if (activeApp().kind === "conditions") return carpState().asOf ?? nowMs;
  return ctx.timeMs();
}

export function vesselPlaying(ctx: Pick<LayerContext, "playing">): boolean {
  return activeApp().kind === "conditions" ? carpState().replay === true : ctx.playing();
}

/** Split a trail (oldest first) into its three age thirds; each run shares its end point with the next. */
export function trailThirds(trail: readonly { lat: number; lon: number; at: number }[], t: number, trailMs = VESSEL_TRAIL_MS): { lat: number; lon: number }[][] {
  const out: { lat: number; lon: number }[][] = [[], [], []];
  for (let i = 1; i < trail.length; i += 1) {
    const a = trail[i - 1]!;
    const b = trail[i]!;
    const age = t - b.at;
    const third = Math.min(2, Math.max(0, 2 - Math.floor((age / trailMs) * 3)));
    const run = out[third]!;
    if (run.length === 0) run.push(a);
    run.push(b);
  }
  return out;
}

/** Arrow (moving) or dot (stopped) in the type colour, outlined; pointing north (the billboard turns it). */
export function vesselIcon(color: string, moving: boolean): HTMLCanvasElement {
  const canvas = createCanvas(ICON_PX, ICON_PX);
  const g = canvas.getContext("2d");
  if (g) {
    g.beginPath();
    if (moving) {
      g.moveTo(12, 2);
      g.lineTo(19, 21);
      g.lineTo(12, 17);
      g.lineTo(5, 21);
      g.closePath();
    } else {
      g.arc(12, 12, 5.5, 0, Math.PI * 2);
    }
    g.fillStyle = color;
    g.fill();
    g.lineWidth = 2;
    g.lineJoin = "round";
    g.strokeStyle = OUTLINE;
    g.stroke();
  }
  return canvas;
}

type Drawn = { billboard: Billboard; trail: Polyline[]; type: VesselCategory; moving: boolean | null };
type CreditDisplay = { addStaticCredit(credit: unknown): void; removeStaticCredit(credit: unknown): void };

export function createVesselsLayer(ctx: LayerContext): GlobeLayer {
  let viewer: GlobeViewer | null = null;
  let ships: BillboardCollection | null = null;
  let trails: PolylineCollection | null = null;
  let enabled = false;
  let lastFrame = -1;
  let tracks: VesselTrack[] = [];
  let tracksKey = "";
  const drawn = new Map<string, Drawn>();
  const icons = new Map<string, HTMLCanvasElement>();
  const materials = new Map<string, Material>();
  let credit: unknown = null;
  let unsubscribe: (() => void) | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;
  /** Time the ships are drawn at, and the tween toward the newest target. */
  let shownAt = Number.NaN;
  let target = Number.NaN;
  let targetSetAt = 0;
  let tween: { from: number; to: number; start: number; ms: number } | null = null;
  let raf = 0;
  const stats: LayerStats = { id: VESSELS, enabled: false, count: 0, frame: -1, updatedAt: null, error: null };

  const wall = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  const iconFor = (type: VesselCategory, moving: boolean) => {
    const key = `${type}:${moving}`;
    let img = icons.get(key);
    if (!img) {
      img = vesselIcon(VESSEL_COLORS[type], moving);
      icons.set(key, img);
    }
    return img;
  };

  const materialFor = (type: VesselCategory, third: number): Material => {
    const key = `${type}:${third}`;
    let m = materials.get(key);
    if (!m) {
      const C = cesium();
      m = C.Material.fromType("Color", { color: C.Color.fromCssColorString(VESSEL_COLORS[type]).withAlpha(TRAIL_ALPHA[third]!) });
      materials.set(key, m);
    }
    return m;
  };

  const forget = (mmsi: string) => {
    const d = drawn.get(mmsi);
    if (!d) return;
    ships?.remove(d.billboard);
    for (const p of d.trail) trails?.remove(p);
    drawn.delete(mmsi);
  };

  const clearAll = () => {
    for (const mmsi of [...drawn.keys()]) forget(mmsi);
  };

  /** Place every ship and trail at `t`. */
  const draw = (t: number) => {
    if (!ships || !trails) return;
    const C = cesium();
    const id = (mmsi: string) => vesselEvidenceId(mmsi);
    const breakdown: Record<string, number> = {};
    const positions: Record<string, readonly [number, number]> = {};
    let count = 0;
    let trailCount = 0;
    for (const track of tracks) {
      const here = positionAt(track, t);
      let d = drawn.get(track.mmsi);
      if (!here) {
        if (d) {
          d.billboard.show = false;
          for (const p of d.trail) p.show = false;
        }
        continue;
      }
      const moving = here.course !== null;
      if (!d) {
        d = {
          billboard: ships.add({ id: id(track.mmsi), position: C.Cartesian3.fromDegrees(here.lon, here.lat), image: iconFor(track.type, moving), alignedAxis: C.Cartesian3.UNIT_Z, disableDepthTestDistance: NO_DEPTH_TEST_WITHIN_M }),
          trail: [0, 1, 2].map((third) => trails!.add({ id: id(track.mmsi), positions: [], width: 2.5, material: materialFor(track.type, third), show: false })),
          type: track.type,
          moving,
        };
        drawn.set(track.mmsi, d);
      }
      if (d.moving !== moving || d.type !== track.type) {
        d.billboard.image = iconFor(track.type, moving) as unknown as string;
        d.moving = moving;
        d.type = track.type;
      }
      d.billboard.position = C.Cartesian3.fromDegrees(here.lon, here.lat);
      d.billboard.rotation = here.course === null ? 0 : -C.Math.toRadians(here.course);
      d.billboard.show = true;
      const thirds = trailThirds(trailAt(track, t), t);
      let hasTrail = false;
      thirds.forEach((run, i) => {
        const p = d!.trail[i]!;
        if (run.length >= 2) {
          p.positions = run.map((q) => C.Cartesian3.fromDegrees(q.lon, q.lat));
          p.show = true;
          hasTrail = true;
        } else p.show = false;
      });
      if (hasTrail) trailCount += 1;
      count += 1;
      breakdown[track.type] = (breakdown[track.type] ?? 0) + 1;
      if (Object.keys(positions).length < MAX_REPORTED_POSITIONS) positions[track.mmsi] = [here.lon, here.lat];
    }
    stats.count = count;
    stats.breakdown = breakdown;
    stats.vessels = { atMs: t, trails: trailCount, positions };
    stats.frame = lastFrame;
    stats.updatedAt = ctx.now();
    ctx.requestRender();
  };

  const setTracks = (key: string, next: readonly GqlVesselTrack[]) => {
    if (key === tracksKey) return;
    tracksKey = key;
    tracks = parseTracks(next);
    const keep = new Set(tracks.map((t) => t.mmsi));
    for (const mmsi of [...drawn.keys()]) if (!keep.has(mmsi)) forget(mmsi);
  };

  /** Cache key of the bucket at `t`: the live bucket also moves every minute so new fixes show up. */
  const keyFor = (t: number, nowMs: number) => {
    const bucket = vesselBucket(t);
    const live = nowMs < bucket + VESSEL_BUCKET_MS ? `|${Math.floor(nowMs / LIVE_REFRESH_MS)}` : "";
    return `${dataKey(bucket, ctx)}${live}`;
  };

  const fetcher: KeyedFetch<GqlVesselTrack[]> = createKeyedFetch({
    cacheSize: 12,
    load: (key, signal) => {
      const { from, to } = vesselWindow(bucketOfKey(key), Date.now());
      return ctx
        .gql<{ vessels: GqlVesselTrack[] }>(VESSELS_QUERY, { bbox: appBBox(activeApp()), from: new Date(from).toISOString(), to: new Date(to).toISOString() }, signal)
        .then((d) => d.vessels);
    },
    onData: (key, value) => {
      stats.error = null;
      if (!enabled || key !== keyFor(target, Date.now())) return;
      setTracks(key, value);
      draw(Number.isFinite(shownAt) ? shownAt : target);
    },
    onError: (err) => {
      stats.error = err instanceof Error ? err.message : String(err);
    },
  });

  const step = () => {
    raf = 0;
    if (!enabled || !tween) return;
    const f = Math.min(1, (wall() - tween.start) / tween.ms);
    shownAt = tween.from + (tween.to - tween.from) * f;
    draw(shownAt);
    if (f < 1 && typeof requestAnimationFrame === "function") raf = requestAnimationFrame(step);
    else tween = null;
  };

  /** Bring the layer to the current target time: fetch its bucket, then jump or tween there. */
  const refresh = () => {
    if (!enabled || !ships) return;
    if (!hasLayer(activeApp(), VESSELS)) {
      tracks = [];
      clearAll();
      stats.count = 0;
      return;
    }
    const now = Date.now();
    const next = vesselTargetTime(ctx, now);
    const changed = next !== target;
    const since = wall() - targetSetAt;
    if (changed) {
      target = next;
      targetSetAt = wall();
    }
    const key = keyFor(target, now);
    const data = fetcher.want(key);
    if (data) setTracks(key, data);
    if (!changed) {
      if (!tween) draw(Number.isFinite(shownAt) ? shownAt : target);
      return;
    }
    const canTween = vesselPlaying(ctx) && Number.isFinite(shownAt) && Math.abs(target - shownAt) <= MAX_TWEEN_SPAN_MS && typeof requestAnimationFrame === "function";
    if (canTween) {
      tween = { from: shownAt, to: target, start: wall(), ms: Math.min(MAX_TWEEN_MS, Math.max(MIN_TWEEN_MS, since)) };
      if (!raf) raf = requestAnimationFrame(step);
    } else {
      tween = null;
      shownAt = target;
      draw(shownAt);
    }
  };

  const creditDisplay = (): CreditDisplay | null => (viewer as unknown as { creditDisplay?: CreditDisplay } | null)?.creditDisplay ?? null;

  return {
    id: VESSELS,
    init(v) {
      viewer = v;
      const C = cesium();
      trails = v.scene.primitives.add(new C.PolylineCollection({ show: false }));
      ships = v.scene.primitives.add(new C.BillboardCollection({ show: false }));
    },
    enable() {
      enabled = stats.enabled = true;
      if (ships) ships.show = true;
      if (trails) trails.show = true;
      const cd = creditDisplay();
      if (cd && !credit) {
        credit = new (cesium().Credit)(VESSEL_CREDIT, true);
        cd.addStaticCredit(credit);
      }
      unsubscribe = subscribe(CARP, refresh);
      tick = setInterval(refresh, TICK_MS);
      target = Number.NaN;
      refresh();
    },
    disable() {
      enabled = stats.enabled = false;
      fetcher.cancel();
      unsubscribe?.();
      unsubscribe = null;
      if (tick) clearInterval(tick);
      tick = null;
      if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
      raf = 0;
      tween = null;
      if (credit) creditDisplay()?.removeStaticCredit(credit);
      credit = null;
      if (ships) ships.show = false;
      if (trails) trails.show = false;
      ctx.requestRender();
    },
    update(frameIndex) {
      lastFrame = frameIndex;
      refresh();
    },
    stats: () => ({ ...stats }),
    destroy() {
      if (enabled) this.disable();
      clearAll();
      if (viewer) {
        if (ships) viewer.scene.primitives.remove(ships);
        if (trails) viewer.scene.primitives.remove(trails);
      }
      ships = trails = null;
      viewer = null;
      tracks = [];
    },
  };
}
