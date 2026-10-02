/**
 * Zoom on the Cesium side (gates/leaf-GE8.md): one animated move for every way of zooming (the `+`/`-` steps, the
 * slider, the wheel, a double click, a pinch), the limits that follow the imagery under the camera, and the ground
 * guard. Ideas from God's Eye View (`src/cameraGroundGuard.js`), written fresh.
 *
 * A zoom scales the camera's offset from a pivot on the ground (the screen centre, the cursor or the pinch
 * midpoint), so the pivot stays under the pointer; over Google 3D it also rotates the camera about the pivot
 * (a rigid rotation, so the pivot still stays put) to the oblique pitch `autoPitchDeg` gives, unless the user has
 * tilted the view themselves. Cesium's own wheel and pinch zoom are off; its right-drag zoom, tilt (middle drag,
 * Ctrl+drag, two-finger drag) and collision detection stay on, with the same limits.
 *
 * Limits: 30 m above the ground over Google 3D (the tileset gets `enableCollision`, so Cesium's own moves stop at
 * its surface too), 400 m over flat imagery, 20,000 km at most. Every camera flight (`camera.flyTo`: VIEW, the
 * agent's `set_view`, share links, reset) has its destination clamped the same way, and after the camera stops
 * the guard measures the ground under it (3D tiles included) and lifts it if it is too low.
 *
 * Animations hold the render governor ("zoom") only while they run; a resting camera renders nothing.
 */
import type { Cartesian3 as Cartesian3T, CesiumWidget } from "cesium";

import type { BBox } from "shared/agent/events";

import { cesium } from "../cesium";
import { googleZoneActive, type LadderPlan } from "../ladder";
import type { ZoomApi, ZoomState } from "./api";
import {
  clampAltitude,
  easeInOutCubic,
  easeOutCubic,
  CENTRE_FROM_M,
  CENTRE_FULL_M,
  limitsFor,
  MIN_ALT_3D_M,
  MIN_ALT_FLAT_M,
  pinchAltitude,
  STEP_MS,
  stepAltitude,
  threeDActive,
  touchDistance,
  touchMidpoint,
  WHEEL_MS,
  wheelFactor,
  zoomPitchDeg,
  type TouchPoint,
  type ZoomLimits,
} from "./model";

/** The ground guard's lift and limit corrections. */
const LIFT_MS = 300;
const GUARD_DEBOUNCE_MS = 100;
/** Never plan a zoom from a pitch flatter than this (the pivot would be near the horizon). */
const MIN_PLAN_PITCH_DEG = 10;

export type ZoomDeps = {
  governor: { hold(owner: string): void; release(owner: string): void; request(): void };
  imagery: () => { plan: LadderPlan; google3d: string };
  /** Where Google 3D may show for the active app. */
  zones: () => readonly Readonly<BBox>[];
  /** The highest the camera may be for Google 3D to show for the active app. */
  maxAltitudeM?: () => number;
  reducedMotion: () => boolean;
  /** The element whose `data-imagery-route` / `data-google3d` the imagery writes (re-evaluates the limits). */
  container?: HTMLElement;
};

export type ZoomDiagnostics = ZoomState & {
  /** Ground height under the camera, metres above the ellipsoid. */
  groundM: number | null;
  animating: boolean;
  /** The last finished zoom animation: its target altitude and how long it ran, ms. */
  last: { kind: string; targetM: number; ms: number } | null;
  /** Ground guard corrections so far. */
  lifts: number;
};

export type ZoomController = ZoomApi & { diagnostics(): ZoomDiagnostics; destroy(): void };

type Tween = {
  kind: string;
  start: number;
  durationMs: number;
  ease: (t: number) => number;
  targetM: number;
  apply(e: number): void;
};

export function installZoom(widget: CesiumWidget, deps: ZoomDeps): ZoomController {
  const { Cartesian2, Cartesian3, Cartographic, CameraEventType, KeyboardEventModifier, Matrix3, Matrix4, Quaternion, Math: CesiumMath } = cesium();
  const { scene, camera } = widget;
  const canvas = scene.canvas;
  const ellipsoid = scene.globe.ellipsoid;
  const controller = scene.screenSpaceCameraController;
  const disposers: (() => void)[] = [];
  let destroyed = false;

  // ---- Cesium's controller: our wheel and pinch, its drag zoom, tilt and collision -----------------------------
  controller.enableCollisionDetection = true;
  controller.zoomEventTypes = [CameraEventType.RIGHT_DRAG];
  controller.tiltEventTypes = [
    CameraEventType.MIDDLE_DRAG,
    CameraEventType.PINCH,
    { eventType: CameraEventType.LEFT_DRAG, modifier: KeyboardEventModifier.CTRL },
    { eventType: CameraEventType.RIGHT_DRAG, modifier: KeyboardEventModifier.CTRL },
  ];

  // The 3D tileset stops Cesium's own camera moves at its surface.
  const collide = (p: unknown) => {
    if (p && typeof p === "object" && "enableCollision" in p) (p as { enableCollision: boolean }).enableCollision = true;
  };
  for (let i = 0; i < scene.primitives.length; i += 1) collide(scene.primitives.get(i));
  disposers.push(scene.primitives.primitiveAdded.addEventListener(collide));

  // ---- limits -----------------------------------------------------------------------------------------------
  const isThreeD = () => {
    const s = deps.imagery();
    return threeDActive(s.plan.route, s.google3d);
  };
  let limits: ZoomLimits = limitsFor(false);
  const applyLimits = () => {
    limits = limitsFor(isThreeD());
    controller.minimumZoomDistance = limits.minM;
    controller.maximumZoomDistance = limits.maxM;
  };
  applyLimits();

  const scratchCarto = new Cartographic();
  const groundAt = (lon: number, lat: number, threeD: boolean): number | null => {
    const at = Cartographic.fromRadians(lon, lat, 0, scratchCarto);
    let h: number | null = scene.globe.getHeight(at) ?? null;
    if (threeD && scene.sampleHeightSupported) {
      try {
        const s = scene.sampleHeight(at);
        if (s !== undefined && Number.isFinite(s)) h = Math.max(h ?? s, s);
      } catch {
        // The tiles under the camera are not loaded yet.
      }
    }
    return h;
  };

  const flatTo = () => {
    if (camera.transform && !Matrix4.equals(camera.transform, Matrix4.IDENTITY)) camera.lookAtTransform(Matrix4.IDENTITY);
  };

  // ---- the one animation ------------------------------------------------------------------------------------
  let tween: Tween | null = null;
  let last: ZoomDiagnostics["last"] = null;
  let lifts = 0;
  let autoTilts = 0;

  const finish = (completed: boolean) => {
    if (!tween) return;
    const t = tween;
    tween = null;
    if (completed) last = { kind: t.kind, targetM: Math.round(t.targetM), ms: Math.round(performance.now() - t.start) };
    deps.governor.release("zoom");
    emit();
  };

  const onPreUpdate = () => {
    if (!tween || destroyed) return;
    const t = Math.min(1, (performance.now() - tween.start) / tween.durationMs);
    tween.apply(tween.ease(t));
    emit();
    if (t >= 1) {
      finish(true);
      guardSoon();
    }
  };
  disposers.push(scene.preUpdate.addEventListener(onPreUpdate));

  const start = (kind: string, targetM: number, durationMs: number, ease: (t: number) => number, apply: (e: number) => void) => {
    if (destroyed) return;
    finish(false);
    camera.cancelFlight();
    if (durationMs <= 0 || deps.reducedMotion()) {
      apply(1);
      last = { kind, targetM: Math.round(targetM), ms: 0 };
      deps.governor.request();
      emit();
      guardSoon();
      return;
    }
    tween = { kind, start: performance.now(), durationMs, ease, targetM, apply };
    deps.governor.hold("zoom");
  };

  // ---- pivots and plans -------------------------------------------------------------------------------------
  const pickPivot = (x: number, y: number, threeD: boolean): Cartesian3T => {
    const at = new Cartesian2(x, y);
    if (threeD && scene.pickPositionSupported) {
      try {
        const p = scene.pickPosition(at);
        if (p && Number.isFinite(p.x)) return p;
      } catch {
        // No depth there (sky): fall through to the globe.
      }
    }
    const ray = camera.getPickRay(at);
    const onGlobe = ray ? scene.globe.pick(ray, scene) : undefined;
    if (onGlobe) return onGlobe;
    const onEllipsoid = camera.pickEllipsoid(at, ellipsoid);
    if (onEllipsoid) return onEllipsoid;
    // Off the globe: the point straight below the camera.
    return ellipsoid.scaleToGeodeticSurface(camera.positionWC, new Cartesian3()) ?? Cartesian3.ZERO;
  };

  const centre = () => ({ x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 });

  /**
   * Move toward `targetM` about the ground point under (x, y). `tilt`: let the pitch follow `autoPitchDeg` over
   * Google 3D (while the user has not tilted by hand); false keeps it (a pinch, whose second finger tilts).
   */
  const zoomAbout = (x: number, y: number, targetM: number, opts: { kind: string; durationMs: number; ease?: (t: number) => number; tilt?: boolean }) => {
    if (destroyed) return;
    finish(false);
    flatTo();
    applyLimits();
    const threeD = isThreeD();
    const pivot = pickPivot(x, y, threeD);
    const pivotCarto = ellipsoid.cartesianToCartographic(pivot) ?? new Cartographic();
    const position = Cartesian3.clone(camera.positionWC);
    const direction = Cartesian3.clone(camera.directionWC);
    const up = Cartesian3.clone(camera.upWC);
    const right = Cartesian3.clone(camera.rightWC);
    const altitude = camera.positionCartographic.height;
    const target = clampAltitude(targetM, limits);
    // Clearance above the pivot's ground, never below the minimum.
    const clearance = Math.max(limits.minM, target - pivotCarto.height);

    const pitch0 = CesiumMath.toDegrees(camera.pitch);
    const pitch1 = zoomPitchDeg(threeD, altitude, pitch0, target, opts.tilt !== false);
    const offset = Cartesian3.subtract(position, pivot, new Cartesian3());
    const normal = ellipsoid.geodeticSurfaceNormal(pivot, new Cartesian3());
    let angle = CesiumMath.toRadians(pitch1 - pitch0);
    const rotate = (a: number) => Matrix3.fromQuaternion(Quaternion.fromAxisAngle(right, a, new Quaternion()), new Matrix3());
    let height = Cartesian3.dot(Matrix3.multiplyByVector(rotate(angle), offset, new Cartesian3()), normal);
    if (!(height > 1) || Math.abs(pitch1) < MIN_PLAN_PITCH_DEG) {
      angle = 0;
      height = Cartesian3.dot(offset, normal);
    }
    if (!(height > 1)) height = Math.max(1, altitude - pivotCarto.height);
    const scale = clearance / height;
    if (angle !== 0 && pitch1 > -89.5 && pitch0 <= -89.5) autoTilts += 1;

    const scratch = new Cartesian3();
    start(opts.kind, pivotCarto.height + clearance, opts.durationMs, opts.ease ?? easeInOutCubic, (e) => {
      const r = rotate(angle * e);
      const f = scale ** e;
      Matrix3.multiplyByVector(r, offset, scratch);
      Cartesian3.multiplyByScalar(scratch, f, scratch);
      Cartesian3.add(pivot, scratch, camera.position);
      Matrix3.multiplyByVector(r, direction, camera.direction);
      Matrix3.multiplyByVector(r, up, camera.up);
      Matrix3.multiplyByVector(r, right, camera.right);
    });
  };

  /** Straight up or down (heading and pitch held) to `targetM` above the ellipsoid. */
  const moveVertically = (kind: string, targetM: number) => {
    flatTo();
    const from = Cartesian3.clone(camera.positionWC);
    const height = camera.positionCartographic.height;
    const normal = ellipsoid.geodeticSurfaceNormal(from, new Cartesian3());
    const delta = targetM - height;
    start(kind, targetM, LIFT_MS, easeOutCubic, (e) => {
      Cartesian3.add(from, Cartesian3.multiplyByScalar(normal, delta * e, new Cartesian3()), camera.position);
    });
  };

  // ---- ground guard -----------------------------------------------------------------------------------------
  let groundM: number | null = null;
  const measureGround = () => {
    const c = camera.positionCartographic;
    groundM = groundAt(c.longitude, c.latitude, isThreeD());
    return groundM;
  };

  const guard = () => {
    if (destroyed || tween || flying() || pinch) return;
    applyLimits();
    const c = camera.positionCartographic;
    const ground = measureGround() ?? 0;
    if (c.height - ground < limits.minM - 0.5) {
      lifts += 1;
      moveVertically("lift", ground + limits.minM);
    } else if (c.height > limits.maxM * 1.001) {
      lifts += 1;
      moveVertically("lift", limits.maxM);
    }
    emit();
  };
  // Debounced: a slider drag or a pinch moves the camera every event; the ground is measured once it rests.
  let guardTimer: ReturnType<typeof setTimeout> | null = null;
  const guardSoon = () => {
    if (guardTimer) clearTimeout(guardTimer);
    guardTimer = setTimeout(() => {
      guardTimer = null;
      guard();
    }, GUARD_DEBOUNCE_MS);
  };
  disposers.push(() => {
    if (guardTimer) clearTimeout(guardTimer);
  });
  disposers.push(camera.moveEnd.addEventListener(guardSoon));
  const onChanged = () => emit();
  disposers.push(camera.changed.addEventListener(onChanged));

  // The imagery changing under a resting camera (3D tiles shown, failed, a key added) moves the limits.
  if (deps.container && typeof MutationObserver === "function") {
    const observer = new MutationObserver(() => {
      applyLimits();
      guardSoon();
    });
    observer.observe(deps.container, { attributes: true, attributeFilter: ["data-google3d", "data-imagery-route"] });
    disposers.push(() => observer.disconnect());
  }

  // ---- every flight lands inside the limits -----------------------------------------------------------------
  let flights = 0;
  const flying = () => flights > 0;
  const originalFlyTo = camera.flyTo;
  const flyTo: typeof camera.flyTo = function (this: typeof camera, options) {
    finish(false);
    let next = options;
    const d = options?.destination;
    if (d instanceof Cartesian3) {
      const c = Cartographic.fromCartesian(d, ellipsoid);
      if (c) {
        const s = deps.imagery();
        const threeD = googleZoneActive(s.plan, { lon: CesiumMath.toDegrees(c.longitude), lat: CesiumMath.toDegrees(c.latitude), altitudeM: c.height }, deps.zones(), deps.maxAltitudeM?.()) && s.google3d !== "failed";
        const minM = threeD ? MIN_ALT_3D_M : MIN_ALT_FLAT_M;
        const ground = scene.globe.getHeight(c) ?? 0;
        const h = Math.min(limits.maxM, Math.max(ground + minM, c.height));
        if (h !== c.height) next = { ...options, destination: Cartesian3.fromRadians(c.longitude, c.latitude, h, ellipsoid) };
      }
    }
    flights += 1;
    const settle = (cb?: () => void) => () => {
      flights = Math.max(0, flights - 1);
      guardSoon();
      cb?.();
    };
    return originalFlyTo.call(this, { ...next, complete: settle(next.complete), cancel: settle(next.cancel) });
  };
  camera.flyTo = flyTo;
  disposers.push(() => {
    if (camera.flyTo === flyTo) camera.flyTo = originalFlyTo;
  });

  // ---- input: wheel, double click, pinch, and any other gesture stopping an animation ----------------------
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const factor = wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey);
    if (factor === 1) return;
    // A run of notches accumulates on the running target, so fast scrolling goes further, never jumps.
    const base = tween?.kind === "wheel" ? tween.targetM : camera.positionCartographic.height;
    const p = local(e);
    const target = clampAltitude(base * factor, limits);
    // Zooming out about the cursor swings the camera away from it; over a run of notches with a moving mouse that
    // drift piles up and the globe ends off-centre. Past a few thousand km the pivot slides to the screen centre,
    // wholly there once the whole globe shows.
    if (factor > 1) {
      const c = centre();
      const t = Math.min(1, Math.max(0, Math.log(target / CENTRE_FROM_M) / Math.log(CENTRE_FULL_M / CENTRE_FROM_M)));
      p.x = c.x + (p.x - c.x) * (1 - t);
      p.y = c.y + (p.y - c.y) * (1 - t);
    }
    zoomAbout(p.x, p.y, target, { kind: "wheel", durationMs: WHEEL_MS, ease: easeOutCubic });
  };
  const onDoubleClick = (e: MouseEvent) => {
    e.preventDefault();
    const p = local(e);
    zoomAbout(p.x, p.y, stepAltitude(camera.positionCartographic.height, 1, limits), { kind: "dblclick", durationMs: STEP_MS });
  };

  const touches = new Map<number, TouchPoint>();
  let pinch: { distance: number; altitudeM: number } | null = null;
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== "touch") {
      finish(false);
      return;
    }
    touches.set(e.pointerId, local(e));
    if (touches.size === 2) {
      const [a, b] = [...touches.values()] as [TouchPoint, TouchPoint];
      finish(false);
      pinch = { distance: touchDistance(a, b), altitudeM: camera.positionCartographic.height };
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, local(e));
    if (!pinch || touches.size !== 2) return;
    const [a, b] = [...touches.values()] as [TouchPoint, TouchPoint];
    const target = pinchAltitude(pinch.altitudeM, pinch.distance, touchDistance(a, b), limits);
    const mid = touchMidpoint(a, b);
    zoomAbout(mid.x, mid.y, target, { kind: "pinch", durationMs: 0, tilt: false });
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!touches.delete(e.pointerId)) return;
    if (touches.size < 2 && pinch) {
      pinch = null;
      guardSoon();
    }
  };
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", onDoubleClick);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  for (const type of ["pointerup", "pointercancel"] as const) canvas.addEventListener(type, onPointerUp);
  disposers.push(() => {
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("dblclick", onDoubleClick);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    for (const type of ["pointerup", "pointercancel"] as const) canvas.removeEventListener(type, onPointerUp);
  });

  // ---- state for the HUD ------------------------------------------------------------------------------------
  const state = (): ZoomState => {
    const s = deps.imagery();
    const altitudeM = camera.positionCartographic.height;
    return {
      ...limits,
      altitudeM,
      clearanceM: groundM === null ? null : altitudeM - groundM,
      route: s.plan.route,
      google3d: s.google3d,
      threeD: threeDActive(s.plan.route, s.google3d),
      pitchDeg: CesiumMath.toDegrees(camera.pitch),
      autoTilts,
    };
  };

  const listeners = new Set<(s: ZoomState) => void>();
  let emitFrame = 0;
  // At most once an animation frame, and only when someone listens; never asks Cesium for a frame.
  function emit() {
    if (destroyed || listeners.size === 0 || emitFrame) return;
    emitFrame = requestAnimationFrame(() => {
      emitFrame = 0;
      const s = state();
      for (const cb of listeners) cb(s);
    });
  }
  disposers.push(() => cancelAnimationFrame(emitFrame));

  guardSoon();

  return {
    state,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    step(presses) {
      const base = tween && tween.kind === "step" ? tween.targetM : camera.positionCartographic.height;
      const c = centre();
      zoomAbout(c.x, c.y, stepAltitude(base, presses, limits), { kind: "step", durationMs: STEP_MS });
    },
    setAltitude(altitudeM, opts) {
      const c = centre();
      zoomAbout(c.x, c.y, altitudeM, { kind: opts?.animate === false ? "drag" : "slider", durationMs: opts?.animate === false ? 0 : STEP_MS });
    },
    diagnostics: () => ({ ...state(), groundM, animating: tween !== null, last, lifts }),
    destroy() {
      if (destroyed) return;
      finish(false);
      destroyed = true;
      listeners.clear();
      for (const off of disposers.splice(0).reverse()) off();
    },
  };
}
