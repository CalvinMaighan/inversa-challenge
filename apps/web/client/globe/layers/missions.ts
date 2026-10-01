/**
 * Mission markers: a diamond per live mission on the team board, tinted by status, with its title once the
 * camera is close. MISSIONS names the board, its applied op seq (a refetch trigger) and the focused mission,
 * which draws larger. Mission fields come from the board query; the marker sits at `lon`/`lat` or, for a
 * mission made from a hotspot cell, at the cell centre.
 */
import type { BillboardCollection, LabelCollection } from "cesium";

import { activeApp } from "client/state/app";
import { cellCentre, primaryRegion } from "shared/apps";
import { LAYER_IDS } from "shared/voice/ui-tools";

import { cesium } from "../cesium";
import { createKeyedFetch } from "./keyed-fetch";
import { createCanvas } from "./raster-surface";
import type { GlobeLayer, GlobeViewer, LayerContext, LayerStats } from "./types";

const [, , , , , , MISSIONS_LAYER] = LAYER_IDS;

/** Mission primitives carry `mission:<id>`; not an evidence id, so `pick()` skips them and a click focuses. */
export const MISSION_ID_PREFIX = "mission:";

export const BOARD_QUERY = `query GlobeBoard($id: ID!) { board(id: $id) { id lastSeq missions { id fields } } }`;

export type GqlMission = { id: string; fields: unknown };

export type MissionMark = { id: string; lon: number; lat: number; title: string; status: string };

const STATUS_COLORS: Record<string, string> = {
  planned: "#f2c14e",
  open: "#f2c14e",
  active: "#ff8a4c",
  in_progress: "#ff8a4c",
  done: "#6fdc8c",
  closed: "#6fdc8c",
};
const DEFAULT_STATUS_COLOR = "#f2c14e";
const LABEL_MAX_DISTANCE_M = 300_000;

export function statusColor(status: string): string {
  return STATUS_COLORS[status.toLowerCase()] ?? DEFAULT_STATUS_COLOR;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Where a mission sits, or null when its fields carry no usable position. */
export function missionMark(m: GqlMission): MissionMark | null {
  const f = (typeof m.fields === "object" && m.fields !== null ? m.fields : {}) as Record<string, unknown>;
  if (f._deleted === true) return null;
  let lon = num(f.lon);
  let lat = num(f.lat);
  if ((lon === null || lat === null) && typeof f.cell === "string") {
    const centre = cellCentre(primaryRegion(activeApp()), f.cell);
    if (centre) {
      lon = centre.lon;
      lat = centre.lat;
    }
  }
  if (lon === null || lat === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    id: m.id,
    lon,
    lat,
    title: typeof f.title === "string" ? f.title : m.id,
    status: typeof f.status === "string" ? f.status : "",
  };
}

function diamondIcon(): HTMLCanvasElement {
  const size = 20;
  const canvas = createCanvas(size, size);
  const g = canvas.getContext("2d");
  if (g) {
    g.beginPath();
    g.moveTo(size / 2, 1);
    g.lineTo(size - 1, size / 2);
    g.lineTo(size / 2, size - 1);
    g.lineTo(1, size / 2);
    g.closePath();
    g.fillStyle = "#ffffff";
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = "#0b0d12";
    g.stroke();
  }
  return canvas;
}

export function createMissionsLayer(ctx: LayerContext): GlobeLayer {
  let viewer: GlobeViewer | null = null;
  let marks: BillboardCollection | null = null;
  let labels: LabelCollection | null = null;
  let icon: HTMLCanvasElement | null = null;
  let enabled = false;
  let drawnKey = "";
  let lastFrame = -1;
  let current: { key: string; missions: MissionMark[] } | null = null;
  const stats: LayerStats = { id: MISSIONS_LAYER, enabled: false, count: 0, frame: -1, updatedAt: null, error: null };

  const draw = () => {
    if (!marks || !labels || !current) return;
    const focused = ctx.missions().focusedMissionId;
    const key = `${current.key}|${focused}`;
    if (key === drawnKey) return;
    const { Cartesian2, Cartesian3, Color, DistanceDisplayCondition, LabelStyle, VerticalOrigin } = cesium();
    icon ??= diamondIcon();
    marks.removeAll();
    labels.removeAll();
    const near = new DistanceDisplayCondition(0, LABEL_MAX_DISTANCE_M);
    for (const m of current.missions) {
      const id = `${MISSION_ID_PREFIX}${m.id}`;
      const position = Cartesian3.fromDegrees(m.lon, m.lat);
      const isFocused = m.id === focused;
      marks.add({
        id,
        position,
        image: icon,
        color: Color.fromCssColorString(statusColor(m.status)),
        scale: isFocused ? 1.5 : 1,
        verticalOrigin: VerticalOrigin.CENTER,
        disableDepthTestDistance: 200_000,
      });
      labels.add({
        id,
        position,
        text: m.title,
        font: "600 12px ui-sans-serif, system-ui, sans-serif",
        fillColor: Color.WHITE,
        outlineColor: Color.fromCssColorString("#0b0d12"),
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cartesian2(0, isFocused ? -20 : -16),
        verticalOrigin: VerticalOrigin.BOTTOM,
        distanceDisplayCondition: isFocused ? undefined : near,
        disableDepthTestDistance: 200_000,
      });
    }
    drawnKey = key;
    stats.count = current.missions.length;
    stats.frame = lastFrame;
    stats.updatedAt = ctx.now();
    ctx.requestRender();
  };

  const fetcher = createKeyedFetch<MissionMark[]>({
    cacheSize: 4,
    load: (key, signal) =>
      ctx
        .gql<{ board: { missions: GqlMission[] } }>(BOARD_QUERY, { id: key.slice(0, key.lastIndexOf("@")) }, signal)
        .then((d) => d.board.missions.map(missionMark).filter((m): m is MissionMark => m !== null)),
    onData: (key, missions) => {
      stats.error = null;
      current = { key, missions };
      if (enabled) draw();
    },
    onError: (err) => {
      stats.error = err instanceof Error ? err.message : String(err);
    },
  });

  return {
    id: MISSIONS_LAYER,
    init(v) {
      viewer = v;
      const C = cesium();
      marks = v.scene.primitives.add(new C.BillboardCollection({ show: false }));
      labels = v.scene.primitives.add(new C.LabelCollection({ show: false }));
    },
    enable() {
      enabled = stats.enabled = true;
      if (marks && labels) marks.show = labels.show = true;
    },
    disable() {
      enabled = stats.enabled = false;
      fetcher.cancel();
      if (marks && labels) {
        marks.show = labels.show = false;
        ctx.requestRender();
      }
    },
    update(frameIndex) {
      lastFrame = frameIndex;
      if (!enabled) return;
      const { boardId, lastSeq } = ctx.missions();
      const key = `${boardId}@${lastSeq}`;
      const missions = fetcher.want(key);
      if (missions) current = { key, missions };
      draw();
    },
    stats: () => ({ ...stats }),
    destroy() {
      fetcher.cancel();
      if (viewer) {
        if (marks) viewer.scene.primitives.remove(marks);
        if (labels) viewer.scene.primitives.remove(labels);
      }
      marks = labels = null;
      viewer = null;
      enabled = stats.enabled = false;
    },
  };
}
