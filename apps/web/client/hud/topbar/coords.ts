/**
 * Cursor coordinates. The globe API (PLAN.md C16) exposes `project(lon, lat) → screen` but no inverse, so the
 * HUD inverts it numerically: Newton's method on the 2×2 system `project(lon, lat) = (x, y)` with a
 * finite-difference Jacobian, seeded at the camera centre. Near the target the map is close to affine, so it
 * converges in two or three steps; each step costs three `project` calls.
 */
import type { ScreenPoint } from "client/globe/api";

export type Project = (lon: number, lat: number) => ScreenPoint | null;
export type LonLat = { lon: number; lat: number };

const MAX_ITER = 8;
/** Stop once the projected point is within this many CSS px of the cursor. */
const TOL_PX = 0.25;

/**
 * Screen point → lon/lat, or null when it is off the globe (sky, or the solve does not converge).
 * `guess` is where to start, usually the camera centre.
 */
export function unproject(project: Project, x: number, y: number, guess: LonLat): LonLat | null {
  let { lon, lat } = guess;
  for (let i = 0; i < MAX_ITER; i++) {
    const p = project(lon, lat);
    if (!p) return null;
    const ex = p.x - x;
    const ey = p.y - y;
    if (Math.hypot(ex, ey) < TOL_PX) return { lon, lat };
    // Step small enough to stay linear, large enough to beat float noise at city zoom.
    const h = 1e-4;
    const px = project(lon + h, lat);
    const py = project(lon, lat + h);
    if (!px || !py) return null;
    const a = (px.x - p.x) / h;
    const b = (py.x - p.x) / h;
    const c = (px.y - p.y) / h;
    const d = (py.y - p.y) / h;
    const det = a * d - b * c;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
    let dLon = (d * ex - b * ey) / det;
    let dLat = (-c * ex + a * ey) / det;
    // Damp long jumps: far from the solution the globe's curvature makes a full step overshoot.
    const len = Math.hypot(dLon, dLat);
    if (len > 10) {
      dLon *= 10 / len;
      dLat *= 10 / len;
    }
    lon -= dLon;
    lat -= dLat;
    if (lat > 90 || lat < -90) return null;
    lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  }
  const p = project(lon, lat);
  return p && Math.hypot(p.x - x, p.y - y) < 2 ? { lon, lat } : null;
}

/** `25.76170°N 80.19180°W`. */
export function formatLatLon({ lat, lon }: LonLat, decimals = 4): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(decimals)}°${ns} ${Math.abs(lon).toFixed(decimals)}°${ew}`;
}
