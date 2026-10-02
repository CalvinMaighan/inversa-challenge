/**
 * Peer cursors: a ringed dot in the peer's colour with its callsign, for every live peer (PEERS, within the
 * heartbeat TTL) whose cursor is on the globe. A peer drops off when its TTL lapses even if no new PEERS value
 * arrives, via one timer set for the next expiry.
 */
import type { LabelCollection, PointPrimitiveCollection } from "cesium";

import { livePeers, PEER_TTL_MS, type Peer } from "client/state/peers";
import { LAYER_IDS } from "shared/voice/ui-tools";

import { cesium } from "../cesium";
import type { GlobeLayer, GlobeViewer, LayerContext, LayerStats } from "./types";

const [, , , , , , , PEERS_LAYER] = LAYER_IDS;

export const PEER_ID_PREFIX = "peer:";

/** Peers to draw: live and with a cursor. */
export function cursorPeers(peers: readonly Peer[], nowMs: number): Peer[] {
  return livePeers(peers, nowMs).filter((p) => p.cursor !== null);
}

/** Ms until the first drawn peer's heartbeat expires, or null when none is drawn. */
export function nextExpiryIn(peers: readonly Peer[], nowMs: number): number | null {
  let soonest: number | null = null;
  for (const p of peers) {
    const left = Date.parse(p.seenAt) + PEER_TTL_MS - nowMs;
    if (soonest === null || left < soonest) soonest = left;
  }
  return soonest === null ? null : Math.max(0, soonest) + 1;
}

export function createPeersLayer(ctx: LayerContext): GlobeLayer {
  let viewer: GlobeViewer | null = null;
  let dots: PointPrimitiveCollection | null = null;
  let labels: LabelCollection | null = null;
  let enabled = false;
  let drawnKey = "";
  let lastFrame = -1;
  let expiry: ReturnType<typeof setTimeout> | null = null;
  const stats: LayerStats = { id: PEERS_LAYER, enabled: false, count: 0, frame: -1, updatedAt: null, error: null };

  const clearExpiry = () => {
    if (expiry) clearTimeout(expiry);
    expiry = null;
  };

  const draw = () => {
    if (!dots || !labels) return;
    const now = ctx.now();
    const peers = cursorPeers(ctx.peers(), Date.now());
    const key = peers.map((p) => `${p.peerId}|${p.color}|${p.callsign}|${p.cursor!.lon},${p.cursor!.lat}`).join(";");
    clearExpiry();
    const wait = nextExpiryIn(peers, Date.now());
    if (wait !== null) expiry = setTimeout(draw, wait);
    if (key === drawnKey) return;
    const { Cartesian2, Cartesian3, Color, LabelStyle, VerticalOrigin } = cesium();
    dots.removeAll();
    labels.removeAll();
    for (const p of peers) {
      const id = `${PEER_ID_PREFIX}${p.peerId}`;
      const position = Cartesian3.fromDegrees(p.cursor!.lon, p.cursor!.lat);
      const color = Color.fromCssColorString(p.color);
      dots.add({ id, position, pixelSize: 9, color, outlineColor: Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY });
      labels.add({
        id,
        position,
        text: p.callsign,
        font: "600 11px ui-monospace, SFMono-Regular, Menlo, monospace",
        fillColor: color,
        outlineColor: Color.fromCssColorString("#0b0d12"),
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cartesian2(8, -8),
        verticalOrigin: VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    drawnKey = key;
    stats.count = peers.length;
    stats.frame = lastFrame;
    stats.updatedAt = now;
    ctx.requestRender();
  };

  return {
    id: PEERS_LAYER,
    init(v) {
      viewer = v;
      const C = cesium();
      dots = v.scene.primitives.add(new C.PointPrimitiveCollection({ show: false }));
      labels = v.scene.primitives.add(new C.LabelCollection({ show: false }));
    },
    enable() {
      enabled = stats.enabled = true;
      if (dots && labels) dots.show = labels.show = true;
    },
    disable() {
      enabled = stats.enabled = false;
      clearExpiry();
      if (dots && labels) {
        dots.show = labels.show = false;
        ctx.requestRender();
      }
    },
    update(frameIndex) {
      lastFrame = frameIndex;
      if (enabled) draw();
    },
    stats: () => ({ ...stats }),
    destroy() {
      clearExpiry();
      if (viewer) {
        if (dots) viewer.scene.primitives.remove(dots);
        if (labels) viewer.scene.primitives.remove(labels);
      }
      dots = labels = null;
      viewer = null;
      enabled = stats.enabled = false;
    },
  };
}
