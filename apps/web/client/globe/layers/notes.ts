/**
 * Field note pins (T43): an outlined map pin in the author's colour per live note on the team board, drawn from
 * NOTES.pins (the team session publishes them from the CRDT board, so the layer needs no request and shows
 * optimistic and offline notes too). Distinct from sighting dots: a pin stands on its point, tip down. Each
 * primitive carries the evidence id `note:<id>` (PLAN.md C14), so a click opens the note card and a hover shows
 * the author and the first line.
 */
import type { BillboardCollection } from "cesium";

import type { NotePin } from "client/state/notes";
import { LAYER_IDS } from "shared/voice/ui-tools";

import { cesium } from "../cesium";
import type { NoteFacts } from "../hover";
import { createCanvas } from "./raster-surface";
import type { GlobeLayer, GlobeViewer, LayerContext, LayerStats } from "./types";

const [, , , , , , , , NOTES_LAYER] = LAYER_IDS;

export const NOTE_ID_PREFIX = "note:";
export const noteEvidenceId = (id: string) => `${NOTE_ID_PREFIX}${id}`;

/** Depth test off within this camera distance so pins stay on top of terrain and 3D tiles. */
const NO_DEPTH_TEST_WITHIN_M = 200_000;
const PIN_W = 22;
const PIN_H = 30;
const OUTLINE = "#0b0d12";

/** Outlined teardrop, tip at the bottom centre, stroked in `color` with a matching centre dot. */
export function pinIcon(color: string): HTMLCanvasElement {
  const canvas = createCanvas(PIN_W, PIN_H);
  const g = canvas.getContext("2d");
  if (g) {
    const cx = PIN_W / 2;
    const r = PIN_W / 2 - 3;
    const cy = r + 2.5;
    g.beginPath();
    // Head: an arc around the top, then the two sides meet at the tip.
    g.arc(cx, cy, r, Math.PI * 0.8, Math.PI * 0.2, false);
    g.lineTo(cx, PIN_H - 1.5);
    g.closePath();
    g.fillStyle = "rgba(11, 13, 18, 0.72)";
    g.fill();
    g.lineWidth = 2.5;
    g.lineJoin = "round";
    g.strokeStyle = color;
    g.stroke();
    g.beginPath();
    g.arc(cx, cy, 3, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
    g.lineWidth = 1;
    g.strokeStyle = OUTLINE;
    g.stroke();
  }
  return canvas;
}

/** Redraw key: anything that changes a pin's place, colour or text (the tooltip reads the drawn note). */
export function pinsKey(pins: readonly NotePin[]): string {
  return pins.map((p) => `${p.id}|${p.color}|${p.lon},${p.lat}|${p.callsign}|${p.text.length}`).join(";");
}

export function createNotesLayer(ctx: LayerContext): GlobeLayer {
  let viewer: GlobeViewer | null = null;
  let marks: BillboardCollection | null = null;
  const icons = new Map<string, HTMLCanvasElement>();
  let enabled = false;
  let drawnKey = "";
  let lastFrame = -1;
  let drawnById = new Map<string, NotePin>();
  const stats: LayerStats = { id: NOTES_LAYER, enabled: false, count: 0, frame: -1, updatedAt: null, error: null };

  const iconFor = (color: string) => {
    let img = icons.get(color);
    if (!img) {
      img = pinIcon(color);
      icons.set(color, img);
    }
    return img;
  };

  const draw = () => {
    if (!marks) return;
    const pins = ctx.notes();
    const key = pinsKey(pins);
    if (key === drawnKey) return;
    const { Cartesian3, VerticalOrigin } = cesium();
    marks.removeAll();
    for (const p of pins) {
      marks.add({
        id: noteEvidenceId(p.id),
        position: Cartesian3.fromDegrees(p.lon, p.lat),
        image: iconFor(p.color),
        verticalOrigin: VerticalOrigin.BOTTOM,
        disableDepthTestDistance: NO_DEPTH_TEST_WITHIN_M,
      });
    }
    drawnById = new Map(pins.map((p) => [noteEvidenceId(p.id), p]));
    drawnKey = key;
    stats.count = pins.length;
    stats.frame = lastFrame;
    stats.updatedAt = ctx.now();
    ctx.requestRender();
  };

  return {
    id: NOTES_LAYER,
    init(v) {
      viewer = v;
      marks = v.scene.primitives.add(new (cesium().BillboardCollection)({ show: false }));
    },
    enable() {
      enabled = stats.enabled = true;
      if (marks) marks.show = true;
      drawnKey = "";
    },
    disable() {
      enabled = stats.enabled = false;
      if (marks) {
        marks.show = false;
        ctx.requestRender();
      }
    },
    update(frameIndex) {
      lastFrame = frameIndex;
      if (enabled) draw();
    },
    stats: () => ({ ...stats }),
    describe(id): NoteFacts | null {
      const p = enabled ? drawnById.get(id) : undefined;
      return p ? { kind: "note", id: p.id, callsign: p.callsign, text: p.text, lon: p.lon, lat: p.lat } : null;
    },
    destroy() {
      drawnById = new Map();
      if (viewer && marks) viewer.scene.primitives.remove(marks);
      marks = null;
      viewer = null;
      enabled = stats.enabled = false;
    },
  };
}
