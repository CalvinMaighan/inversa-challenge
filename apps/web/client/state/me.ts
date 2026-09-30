import { get, key, set } from "@calvinjs/active-state";

/**
 * Peer colours: distinct hues at similar lightness, readable on the globe and in all three modes. Hex, because
 * Cesium's `Color.fromCssColorString` does not parse oklch().
 */
export const PEER_COLORS = ["#f2c14e", "#4fb3ff", "#e39aa8", "#6fdc8c", "#c89bff", "#ff8a4c", "#3fd6c6", "#f5f5f5"] as const;

export type MeState = {
  /** Stable node id for HLCs and signaling; never contains ":" (PLAN.md C5). Empty until assigned. */
  nodeId: string;
  callsign: string;
  color: string;
};

const defaults: MeState = { nodeId: "", callsign: "", color: PEER_COLORS[0] };

/** No auth (PRD §3): each viewer is a local identity that survives reloads. */
export const ME = key("ME", defaults, { persist: true });

/** Fill in a missing identity from a fresh UUID. Pure; `ensureIdentity` applies it. */
export function withIdentity(me: MeState, uuid: string): MeState {
  if (me.nodeId) return me;
  const nodeId = uuid.replace(/:/g, "");
  const hex = nodeId.replace(/-/g, "");
  return {
    nodeId,
    callsign: `Ranger-${hex.slice(0, 4).toUpperCase()}`,
    color: PEER_COLORS[parseInt(hex.slice(-2), 16) % PEER_COLORS.length],
  };
}

/**
 * Assign a node id, callsign and colour on first visit. Call after persisted state has hydrated (an effect
 * under `<ActiveState ssr />`), or a stored identity would be replaced.
 */
export function ensureIdentity(uuid: () => string = () => crypto.randomUUID()): MeState {
  const current = get<MeState>(ME) ?? defaults;
  if (current.nodeId) return current;
  const next = withIdentity(current, uuid());
  set<MeState>(ME, next);
  return next;
}
