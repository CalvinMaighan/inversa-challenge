/**
 * Zoom model (gates/leaf-GE8.md), pure so the numbers are unit-tested: the altitude limits per imagery, the
 * log-scale slider, the step, wheel and pinch factors, the place-scale names and the readout, and the oblique
 * tilt over Google 3D. Altitudes are camera heights above the ellipsoid in metres, as VIEW and the share link use.
 */

/** Closest the camera may get to the surface over Google Photorealistic 3D Tiles (buildings carry the detail). */
export const MIN_ALT_3D_M = 30;
/** Closest over flat imagery: below about 400 m aerial tiles stretch into mush. */
export const MIN_ALT_FLAT_M = 400;
/** Farthest: the whole planet fits a 1440×900 canvas (Cesium's 60° field of view) with room to spare. */
export const MAX_ALT_M = 40_000_000;

/** One press of `+` halves the altitude, one press of `-` doubles it. */
export const STEP_IN = 0.5;
export const STEP_OUT = 2;
/** Animation of a button, key or double-click step. */
export const STEP_MS = 300;
/** Animation of a wheel notch; a run of notches retargets it, so it never queues up. */
export const WHEEL_MS = 180;
/** Zooming out, the wheel's pivot slides from the cursor to the screen centre between these altitudes (metres). */
export const CENTRE_FROM_M = 1_500_000;
export const CENTRE_FULL_M = 8_000_000;

/** One wheel notch (100 px of `deltaY`) zooms in to 80% of the altitude, or out to 125%. */
export const WHEEL_NOTCH_FACTOR = 1.25;
const WHEEL_NOTCH_PX = 100;
/** A burst larger than this (a fast flick, a coarse wheel) counts as three notches, so nothing jumps. */
const WHEEL_MAX_PX = 300;

/** Below this, over Google 3D, the view tilts so buildings read as 3D; fully tilted at TILT_FULL_M. */
export const TILT_START_M = 5_000;
export const TILT_FULL_M = 500;
/** Tilt at TILT_FULL_M and below, degrees away from straight down (pitch -45°). */
export const MAX_TILT_DEG = 45;

export type ZoomLimits = { minM: number; maxM: number };

/** The imagery route on the ladder (`data-imagery-route`) and the Google 3D tileset's state. */
export type ImageryRoute = "google-direct" | "ion" | "keyless";
export type Google3dState = "off" | "loading" | "shown" | "hidden" | "failed";

/** Google 3D is what the camera looks at: a keyed route and the tileset on screen (low over the app's zone). */
export function threeDActive(route: ImageryRoute | string, google3d: Google3dState | string): boolean {
  return route !== "keyless" && google3d === "shown";
}

/** Limits for the imagery under the camera. */
export function limitsFor(threeD: boolean): ZoomLimits {
  return { minM: threeD ? MIN_ALT_3D_M : MIN_ALT_FLAT_M, maxM: MAX_ALT_M };
}

export function clampAltitude(altitudeM: number, limits: ZoomLimits): number {
  if (!Number.isFinite(altitudeM)) return limits.maxM;
  return Math.min(limits.maxM, Math.max(limits.minM, altitudeM));
}

/** The altitude after `presses` steps (positive zooms in), clamped. */
export function stepAltitude(altitudeM: number, presses: number, limits: ZoomLimits): number {
  const factor = presses >= 0 ? STEP_IN ** presses : STEP_OUT ** -presses;
  return clampAltitude(altitudeM * factor, limits);
}

// ---- the slider -------------------------------------------------------------------------------------------

/** The slider's range: 0 is the whole planet (top of the range is the closest view). */
export const SLIDER_MIN = 0;
export const SLIDER_MAX = 100;

/** Slider value (0 far … 100 near) to altitude, logarithmic so every notch is the same zoom ratio. */
export function sliderToAltitude(value: number, limits: ZoomLimits): number {
  const t = Math.min(1, Math.max(0, value / SLIDER_MAX));
  return limits.maxM * (limits.minM / limits.maxM) ** t;
}

export function altitudeToSlider(altitudeM: number, limits: ZoomLimits): number {
  const a = clampAltitude(altitudeM, limits);
  return (SLIDER_MAX * Math.log(limits.maxM / a)) / Math.log(limits.maxM / limits.minM);
}

// ---- words -----------------------------------------------------------------------------------------------

/** Plain names for how much of the map is in view, with the lowest altitude each one covers. */
export const PLACE_SCALES = [
  { name: "World", fromM: 6_000_000 },
  { name: "Country", fromM: 1_500_000 },
  { name: "State or region", fromM: 300_000 },
  { name: "County", fromM: 60_000 },
  { name: "City", fromM: 8_000 },
  { name: "Neighbourhood", fromM: 1_500 },
  { name: "Street", fromM: 0 },
] as const;

export type PlaceScale = (typeof PLACE_SCALES)[number]["name"];

export function placeScale(altitudeM: number): PlaceScale {
  return (PLACE_SCALES.find((s) => altitudeM >= s.fromM) ?? PLACE_SCALES[PLACE_SCALES.length - 1]!).name;
}

const grouped = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

/** "30 m", "850 m", "4.5 km", "12 km", "1,200 km". */
export function formatAltitude(altitudeM: number): string {
  const a = Math.max(0, altitudeM);
  if (a < 100) return `${Math.round(a)} m`;
  if (a < 995) return `${Math.round(a / 10) * 10} m`;
  if (a < 9_950) {
    const km = Math.round(a / 100) / 10;
    return `${Number.isInteger(km) ? km : km.toFixed(1)} km`;
  }
  return `${grouped(Math.round(a / 1000))} km`;
}

/** What a screen reader says for the slider: "City, 12 km up". */
export function altitudeValueText(altitudeM: number): string {
  return `${placeScale(altitudeM)}, ${formatAltitude(altitudeM)} up`;
}

// ---- wheel and touch --------------------------------------------------------------------------------------

/**
 * Altitude ratio for one wheel event: 100 px of `deltaY` (one notch on a mouse) is ×0.8 in or ×1.25 out; line
 * and page modes are converted to pixels; a trackpad pinch (`ctrlKey`, small deltas) is scaled up to feel the same.
 */
export function wheelFactor(deltaY: number, deltaMode = 0, ctrlKey = false): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  const px = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 800 : deltaY;
  const scaled = Math.min(WHEEL_MAX_PX, Math.max(-WHEEL_MAX_PX, ctrlKey ? px * 4 : px));
  return WHEEL_NOTCH_FACTOR ** (scaled / WHEEL_NOTCH_PX);
}

export type TouchPoint = { x: number; y: number };

export function touchDistance(a: TouchPoint, b: TouchPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function touchMidpoint(a: TouchPoint, b: TouchPoint): TouchPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Fingers spread to `scale` times their starting distance: the altitude shrinks by the same ratio (clamped). */
export function pinchAltitude(startAltitudeM: number, startDistance: number, distance: number, limits: ZoomLimits): number {
  if (!(startDistance > 0) || !(distance > 0)) return clampAltitude(startAltitudeM, limits);
  return clampAltitude(startAltitudeM / (distance / startDistance), limits);
}

// ---- tilt -------------------------------------------------------------------------------------------------

/**
 * The pitch to look at the ground from `altitudeM`: straight down (-90°) above TILT_START_M, easing to
 * -(90 - MAX_TILT_DEG)° at TILT_FULL_M, logarithmic in between. Only applies over Google 3D.
 */
export function autoPitchDeg(altitudeM: number): number {
  const t = Math.log(TILT_START_M / Math.max(1, altitudeM)) / Math.log(TILT_START_M / TILT_FULL_M);
  return -90 + MAX_TILT_DEG * Math.min(1, Math.max(0, t));
}

/** Auto tilt follows only while the pitch is within this of the automatic one (the user has not tilted by hand). */
export const FOLLOW_TILT_DEG = 3;

/**
 * The pitch a zoom from `altitudeM` (at `pitchDeg`) to `targetM` ends at: over Google 3D it follows
 * `autoPitchDeg`, unless the user tilted by hand; over flat imagery, or with `tilt` off (a pinch), it is kept.
 */
export function zoomPitchDeg(threeD: boolean, altitudeM: number, pitchDeg: number, targetM: number, tilt = true): number {
  const follow = threeD && tilt && Math.abs(pitchDeg - autoPitchDeg(altitudeM)) <= FOLLOW_TILT_DEG;
  return follow ? autoPitchDeg(targetM) : pitchDeg;
}

/** Degrees away from straight down for a pitch (0 = top down). */
export const tiltOfPitch = (pitchDeg: number) => Math.round((90 + pitchDeg) * 10) / 10;

export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
