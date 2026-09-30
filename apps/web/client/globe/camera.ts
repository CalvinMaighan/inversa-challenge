/**
 * VIEW ↔ camera sync, as pure decisions. VIEW drives `flyTo`; camera moves write VIEW back (debounced by the
 * caller). The loop is broken twice: the globe ignores the exact object it wrote, and a VIEW that matches
 * the camera within tolerance flies nowhere. A voice or agent `fly_to` bumps `seq`, which always flies, even
 * back to where the camera already is after the user panned away and returned.
 */
import type { ViewState } from "client/state/view";
import type { BBox } from "shared/agent/events";

export type CameraPose = { lon: number; lat: number; altitudeM: number; heading: number; pitch: number };

/** VIEW as T15 extends it: `seq` counts fly requests, `place` names the target. Absent before T15 lands. */
export type ViewValue = ViewState & { seq?: number; place?: string | null };

const round = (v: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** Normalise to (-180, 180]. */
export function wrapDegrees(deg: number): number {
  const d = ((((deg + 180) % 360) + 360) % 360) - 180;
  return d === -180 ? 180 : d;
}

/** Tolerances below which two poses count as the same view. */
const POSITION_EPS_DEG = 1e-4;
const ALTITUDE_EPS_RATIO = 0.01;
const ANGLE_EPS_DEG = 0.5;

export function posesDiffer(a: CameraPose, b: CameraPose): boolean {
  if (Math.abs(a.lon - b.lon) > POSITION_EPS_DEG || Math.abs(a.lat - b.lat) > POSITION_EPS_DEG) return true;
  if (Math.abs(a.altitudeM - b.altitudeM) > Math.max(1, ALTITUDE_EPS_RATIO * Math.max(a.altitudeM, b.altitudeM))) return true;
  if (Math.abs(wrapDegrees(a.heading - b.heading)) > ANGLE_EPS_DEG) return true;
  return Math.abs(a.pitch - b.pitch) > ANGLE_EPS_DEG;
}

export function poseOfView(view: ViewState): CameraPose {
  return { lon: view.lon, lat: view.lat, altitudeM: view.altitudeM, heading: view.heading, pitch: view.pitch };
}

/**
 * The VIEW value to write after the camera settled. Keeps `seq`, `place` and any other field it does not own;
 * rounds so float noise does not produce a new value; keeps the previous bbox when the camera sees no ground.
 */
export function viewFromPose(prev: ViewValue, pose: CameraPose, bbox: BBox | null): ViewValue {
  return {
    ...prev,
    lon: round(wrapDegrees(pose.lon), 5),
    lat: round(pose.lat, 5),
    altitudeM: Math.round(pose.altitudeM),
    heading: round(((pose.heading % 360) + 360) % 360, 1),
    pitch: round(pose.pitch, 1),
    bbox: bbox
      ? { west: round(bbox.west, 4), south: round(bbox.south, 4), east: round(bbox.east, 4), north: round(bbox.north, 4) }
      : prev.bbox,
  };
}

export type ViewSyncState = {
  /** The object the globe last wrote to VIEW. */
  lastWritten: ViewValue | null;
  /** The `seq` of the last VIEW the globe acted on. */
  handledSeq: number | undefined;
};

/** Whether a new VIEW value should move the camera. Updates `state.handledSeq`. */
export function shouldFly(view: ViewValue, camera: CameraPose, state: ViewSyncState): boolean {
  if (view === state.lastWritten) return false;
  const seqBumped = view.seq !== undefined && view.seq !== state.handledSeq;
  state.handledSeq = view.seq;
  return seqBumped || posesDiffer(poseOfView(view), camera);
}
