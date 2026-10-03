/**
 * The Cesium side of the globe: a bare `CesiumWidget` (no Viewer, so no timeline, animation, geocoder,
 * base-layer picker or any other widget), the imagery ladder, the layers, the idle render governor, and the
 * wiring to active-state (TIME, VIEW, LAYERS, SELECTION, MISSIONS, PEERS) and the threads API.
 *
 * Browser only. `mountGlobe` registers the C16 `GlobeApi` once the scene is up and unregisters on destroy.
 */
import { get, set, subscribe } from "@calvinjs/active-state";
import type { FrameGrid } from "@calvinjs/active-state/threads";
import type { Cartesian2 as CartesianXY } from "cesium";

import { LAYERS, type LayersState } from "client/state/layers";
import { MISSIONS, type MissionsState } from "client/state/missions";
import { NOTES, setNotePick, type NotesState } from "client/state/notes";
import { PEERS, type Peer } from "client/state/peers";
import { parseEvidenceId, SELECTION, type SelectionState } from "client/state/selection";
import { TIME, type TimeState } from "client/state/time";
import { VIEW } from "client/state/view";
import { getFrameMeta, gqlRequest, onFrameGrid, onFrameSightings, type FrameMeta, type FrameSightings } from "client/threads/api";
import { prefersReducedMotion } from "client/motion";
import { activeAppId } from "client/state/app";
import { CARP } from "client/state/carp";
import { browserKey } from "client/keys";

import { registerGlobe, type GeoPoint, type GlobeApi } from "./api";
import { cesium } from "./cesium";
import { posesDiffer, shouldFly, viewFromPose, type CameraPose, type ViewSyncState, type ViewValue } from "./camera";
import { keepInView } from "./fit";
import { frameForTime } from "./frame-index";
import { createRenderGovernor, type GovernorDiagnostics } from "./governor";
import { installImagery, type ImageryState } from "./imagery";
import { AREA_3D_MAX_ALTITUDE_M, GOOGLE_3D_ZONES } from "./ladder";
import { installLook, type LookDiagnostics } from "./look/install";
import { createLayers, type GlobeLayer, type GlobeViewer, type LayerContext, type LayerStats } from "./layers";
import { layerClock } from "./layers/clock";
import { MISSION_ID_PREFIX } from "./layers/missions";
import { RASTER_PICK_PREFIX } from "./layers/types";
import { browserQuotaStore } from "./quota";
import { registerZoom } from "./zoom/api";
import { installZoom, type ZoomDiagnostics } from "./zoom/controller";

const VIEW_WRITE_DEBOUNCE_MS = 250;
/** Draped pictures (the reef heat tiles) are fetched this many at a time, and a failed one is asked for again. */
const DRAPE_CONCURRENCY = 3;
const DRAPE_ATTEMPTS = 5;
let drapeActive = 0;
const drapeWaiting: (() => void)[] = [];

async function fetchPicture(url: string, signal: AbortSignal): Promise<Blob | null> {
  if (drapeActive >= DRAPE_CONCURRENCY) await new Promise<void>((resolve) => drapeWaiting.push(resolve));
  drapeActive += 1;
  try {
    for (let attempt = 0; attempt < DRAPE_ATTEMPTS && !signal.aborted; attempt += 1) {
      try {
        const res = await fetch(url, { signal });
        if (res.ok) return await res.blob();
      } catch {
        if (signal.aborted) return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
    return null;
  } finally {
    drapeActive -= 1;
    drapeWaiting.shift()?.();
  }
}
const DEFAULT_FLIGHT_S = 1.6;
/** After a marker click: time for the sighting card to mount and slide in before the visible rect is measured. */
const CARD_SETTLE_MS = 350;
const BACKGROUND = "#07090d";
/** Side of the square `pick` searches, CSS px. */
const PICK_PX = 9;
const GLOBE_BASE = "#0d1b2a";

export type GlobeDiagnostics = {
  governor: GovernorDiagnostics;
  requestRenderMode: boolean;
  frame: number;
  layers: LayerStats[];
  imagery: ImageryState;
  /** Visual preset stages and the scope (GC2). */
  look: LookDiagnostics;
  /** Zoom limits, altitude, ground clearance and the last zoom animation (GE8). */
  zoom: ZoomDiagnostics;
};

export type GlobeHandle = {
  api: GlobeApi;
  diagnostics(): GlobeDiagnostics;
  destroy(): void;
};

const sameArray = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Mount on `container`, with attributions in `credits` and their "Data attribution" lightbox in `lightbox` (default:
 * over the globe). Cesium must be loaded (`loadCesium`).
 */
export function mountGlobe(container: HTMLElement, credits: HTMLElement, lightbox?: HTMLElement): GlobeHandle {
  const {
    BoundingSphere,
    Cartesian2,
    Cartesian3,
    CesiumWidget,
    Color,
    EllipsoidTerrainProvider,
    ImageryLayer,
    Rectangle,
    SingleTileImageryProvider,
    JulianDate,
    Math: CesiumMath,
    Occluder,
    SceneTransforms,
    ScreenSpaceEventHandler,
    ScreenSpaceEventType,
  } = cesium();

  const widget = new CesiumWidget(container, {
    baseLayer: false,
    terrainProvider: new EllipsoidTerrainProvider(),
    skyBox: false,
    scene3DOnly: true,
    shouldAnimate: false,
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
    creditContainer: credits,
    ...(lightbox ? { creditViewport: lightbox } : {}),
    blurActiveElementOnCanvasFocus: false,
    showRenderLoopErrors: false,
    contextOptions: { webgl: { alpha: false } },
  });
  const { scene, camera } = widget;
  scene.backgroundColor = Color.fromCssColorString(BACKGROUND);
  scene.globe.baseColor = Color.fromCssColorString(GLOBE_BASE);
  scene.globe.enableLighting = false;
  scene.globe.showGroundAtmosphere = false;
  scene.screenSpaceCameraController.minimumZoomDistance = 120;
  scene.screenSpaceCameraController.maximumZoomDistance = 25_000_000;

  const governor = createRenderGovernor(scene);
  const disposers: (() => void)[] = [];
  let destroyed = false;

  // ---- data -------------------------------------------------------------------------------------------
  let grid: FrameGrid | null = null;
  let frameSightings: FrameSightings | null = null;
  let revision = 0;
  let frame = -1;

  const time = () => ({ ...TIME.defaults, ...get<TimeState>(TIME) });
  /** Meta of the published grid; meaningless without one. */
  const meta = (): FrameMeta | null => (grid ? getFrameMeta() : null);

  // One cursor for every layer: TIME in a species app, CARP.asOf (live: now) in carp (client/globe/layers/clock.ts).
  const clock = layerClock();
  const ctx: LayerContext = {
    requestRender: () => governor.request(),
    now: () => performance.now(),
    timeMs: clock.timeMs,
    playing: clock.playing,
    meta,
    sightings: (i) => (frameSightings && i >= 0 && i < frameSightings.counts.length ? frameSightings.records(i) : []),
    revision: () => revision,
    layers: () => ({ ...LAYERS.defaults, ...get<LayersState>(LAYERS) }),
    selection: () => get<SelectionState>(SELECTION)?.evidenceId ?? null,
    missions: () => ({ ...MISSIONS.defaults, ...get<MissionsState>(MISSIONS) }),
    peers: () => get<Peer[]>(PEERS) ?? [],
    notes: () => get<NotesState>(NOTES)?.pins ?? [],
    gql: (query, variables, signal) => gqlRequest(query, variables, signal),
  };

  const layers: GlobeLayer[] = createLayers(ctx);
  const viewerSlice: GlobeViewer = widget;
  for (const layer of layers) layer.init(viewerSlice);

  const applyVisibility = () => {
    const visible = ctx.layers().visible;
    for (const layer of layers) {
      const on = visible[layer.id] !== false;
      if (on !== layer.stats().enabled) {
        if (on) layer.enable();
        else layer.disable();
      }
    }
  };

  const refresh = () => {
    if (destroyed) return;
    frame = frameForTime(ctx.timeMs(), meta());
    for (const layer of layers) if (layer.stats().enabled) layer.update(frame, grid);
  };

  // Coalesce bursts (a scrub fires TIME many times per frame) into one refresh per animation frame.
  let refreshQueued = 0;
  const scheduleRefresh = () => {
    if (refreshQueued || destroyed) return;
    refreshQueued = requestAnimationFrame(() => {
      refreshQueued = 0;
      refresh();
    });
  };
  disposers.push(() => cancelAnimationFrame(refreshQueued));

  // ---- clock: the Cesium clock follows TIME --------------------------------------------------------------
  const syncClock = () => {
    const at = Date.parse(time().at);
    if (Number.isFinite(at)) widget.clock.currentTime = JulianDate.fromDate(new Date(at));
  };
  widget.clock.shouldAnimate = false;
  syncClock();

  disposers.push(
    subscribe(TIME, () => {
      syncClock();
      scheduleRefresh();
    }),
  );
  let lastVisible: readonly unknown[] = [];
  disposers.push(
    subscribe(LAYERS, () => {
      const v = Object.values(ctx.layers().visible);
      if (!sameArray(v, lastVisible)) applyVisibility();
      lastVisible = v;
      scheduleRefresh();
    }),
  );
  // Carp's cursor ("what we knew", its replay) is the layers' time there, as TIME is in a species app.
  disposers.push(subscribe(CARP, scheduleRefresh));
  disposers.push(subscribe(MISSIONS, scheduleRefresh));
  disposers.push(subscribe(SELECTION, scheduleRefresh));
  disposers.push(subscribe(PEERS, scheduleRefresh));
  disposers.push(subscribe(NOTES, scheduleRefresh));

  // Grid version: Atomics.waitAsync where it exists; elsewhere a slow poll (the ring fallback polls every ms).
  let watchToken = 0;
  const watchGrid = (g: FrameGrid) => {
    const token = ++watchToken;
    let seen = g.version();
    if (typeof (Atomics as { waitAsync?: unknown }).waitAsync === "function") {
      const loop = () => {
        g.waitVersion(seen, 10_000).then((v) => {
          if (token !== watchToken || destroyed) return;
          if (v !== seen) {
            seen = v;
            scheduleRefresh();
          }
          loop();
        });
      };
      loop();
    } else {
      const timer = setInterval(() => {
        if (token !== watchToken || destroyed) return clearInterval(timer);
        const v = g.version();
        if (v !== seen) {
          seen = v;
          scheduleRefresh();
        }
      }, 250);
      disposers.push(() => clearInterval(timer));
    }
  };
  disposers.push(() => void (watchToken += 1));
  disposers.push(
    onFrameGrid((g) => {
      grid = g;
      revision += 1;
      watchGrid(g);
      scheduleRefresh();
    }),
  );
  disposers.push(
    onFrameSightings((s) => {
      frameSightings = s;
      revision += 1;
      scheduleRefresh();
    }),
  );

  // ---- imagery ------------------------------------------------------------------------------------------
  // Browser keys (shared/keys.ts): the Developer panel's localStorage value first, then the build env.
  const imagery = installImagery(widget, {
    ionToken: browserKey("cesium-ion"),
    googleKey: browserKey("google-maps"),
    zones: () => GOOGLE_3D_ZONES[activeAppId()],
    maxAltitudeM: () => AREA_3D_MAX_ALTITUDE_M[activeAppId()],
    quotaStore: browserQuotaStore(),
    requestRender: () => governor.request(),
    onChange: (s) => {
      container.dataset.imagery = s.base ?? "none";
      container.dataset.google3d = s.google3d;
      container.dataset.imageryRoute = s.plan.route;
    },
  });
  disposers.push(() => imagery.destroy());

  // ---- look: presets and the scope mask (GC2), post-process stages over the whole frame ----------------
  const look = installLook(scene, { requestRender: () => governor.request() });
  disposers.push(() => look.destroy());

  // ---- zoom (GE8): wheel, double click, pinch, steps, limits per imagery, ground guard -------------------------
  const zoom = installZoom(widget, { governor, imagery: () => imagery.state(), zones: () => GOOGLE_3D_ZONES[activeAppId()], maxAltitudeM: () => AREA_3D_MAX_ALTITUDE_M[activeAppId()], reducedMotion: prefersReducedMotion, container });
  registerZoom(zoom);
  disposers.push(() => {
    registerZoom(null);
    zoom.destroy();
  });

  // ---- camera ↔ VIEW -------------------------------------------------------------------------------------
  const pose = (): CameraPose => {
    const c = camera.positionCartographic;
    return {
      lon: CesiumMath.toDegrees(c.longitude),
      lat: CesiumMath.toDegrees(c.latitude),
      altitudeM: c.height,
      heading: CesiumMath.toDegrees(camera.heading),
      pitch: CesiumMath.toDegrees(camera.pitch),
    };
  };
  const view = (): ViewValue => ({ ...VIEW.defaults, ...get<ViewValue>(VIEW) });
  const sync: ViewSyncState = { lastWritten: null, handledSeq: view().seq };

  const flyTo = (target: { lon: number; lat: number; altitudeM?: number; heading?: number; pitch?: number; durationS?: number }) => {
    if (destroyed || !Number.isFinite(target.lon) || !Number.isFinite(target.lat)) return;
    governor.hold("flight");
    const done = () => governor.release("flight");
    camera.flyTo({
      destination: Cartesian3.fromDegrees(target.lon, target.lat, target.altitudeM ?? pose().altitudeM),
      orientation: { heading: CesiumMath.toRadians(target.heading ?? 0), pitch: CesiumMath.toRadians(target.pitch ?? -90), roll: 0 },
      // Reduced motion: jump, never fly (Cesium completes a 0 s flight synchronously).
      duration: prefersReducedMotion() ? 0 : (target.durationS ?? DEFAULT_FLIGHT_S),
      complete: done,
      cancel: done,
    });
  };

  const initial = view();
  camera.setView({
    destination: Cartesian3.fromDegrees(initial.lon, initial.lat, initial.altitudeM),
    orientation: { heading: CesiumMath.toRadians(initial.heading), pitch: CesiumMath.toRadians(initial.pitch), roll: 0 },
  });

  disposers.push(
    subscribe(VIEW, (value) => {
      // Identity check on the stored object: the globe's own write-back must never fly.
      if (!value || value === sync.lastWritten) return;
      const v = { ...VIEW.defaults, ...(value as ViewValue) };
      if (shouldFly(v, pose(), sync)) flyTo(v);
    }),
  );

  let viewTimer: ReturnType<typeof setTimeout> | null = null;
  const writeView = () => {
    viewTimer = null;
    if (destroyed) return;
    const rect = camera.computeViewRectangle(scene.globe.ellipsoid);
    const bbox = rect
      ? {
          west: CesiumMath.toDegrees(rect.west),
          south: CesiumMath.toDegrees(rect.south),
          east: CesiumMath.toDegrees(rect.east),
          north: CesiumMath.toDegrees(rect.north),
        }
      : null;
    const prev = view();
    const next = viewFromPose(prev, pose(), bbox);
    if (!posesDiffer(next, prev) && JSON.stringify(next.bbox) === JSON.stringify(prev.bbox)) return;
    sync.lastWritten = next;
    set(VIEW, next);
  };
  const onMoveEnd = () => {
    if (viewTimer) clearTimeout(viewTimer);
    viewTimer = setTimeout(writeView, VIEW_WRITE_DEBOUNCE_MS);
    imagery.update(pose());
  };
  camera.percentageChanged = 0.05;
  const onCameraChanged = () => imagery.update(pose());
  disposers.push(camera.moveEnd.addEventListener(onMoveEnd));
  disposers.push(camera.changed.addEventListener(onCameraChanged));
  disposers.push(() => {
    if (viewTimer) clearTimeout(viewTimer);
  });
  imagery.update(pose());

  // ---- picking, pointer --------------------------------------------------------------------------------
  const globePoint = (x: number, y: number): GeoPoint | null => {
    const hit = camera.pickEllipsoid(new Cartesian2(x, y), scene.globe.ellipsoid);
    if (!hit) return null;
    const c = scene.globe.ellipsoid.cartesianToCartographic(hit);
    return { lon: CesiumMath.toDegrees(c.longitude), lat: CesiumMath.toDegrees(c.latitude) };
  };

  /** Raw id under a point: a primitive's id, or a raster cell resolved through its layer. */
  const pickId = (x: number, y: number): string | null => {
    // A 9 px pick square (Cesium's default is 3) makes small dots easy to hit.
    const picked = scene.pick(new Cartesian2(x, y), PICK_PX, PICK_PX) as { id?: unknown; primitive?: { id?: unknown } } | undefined;
    const raw = typeof picked?.id === "string" ? picked.id : typeof picked?.primitive?.id === "string" ? picked.primitive.id : null;
    if (raw && !raw.startsWith(RASTER_PICK_PREFIX)) return raw;
    const at = globePoint(x, y);
    if (!at) return null;
    // Topmost raster first: hotspots over the temperature rasters.
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      const layer = layers[i]!;
      if (!layer.pickAt || !layer.stats().enabled) continue;
      const id = layer.pickAt(at.lon, at.lat);
      if (id) return id;
    }
    return null;
  };

  const pick = (x: number, y: number): string | null => {
    const id = pickId(x, y);
    return id && parseEvidenceId(id) ? id : null;
  };

  const cursorListeners = new Set<(at: GeoPoint | null) => void>();
  const handler = new ScreenSpaceEventHandler(scene.canvas);
  let cursorFrame = 0;
  let cursorAt: CartesianXY | null = null;
  handler.setInputAction((move: { endPosition: CartesianXY }) => {
    if (cursorListeners.size === 0) return;
    cursorAt = Cartesian2.clone(move.endPosition, cursorAt ?? new Cartesian2());
    if (cursorFrame) return;
    cursorFrame = requestAnimationFrame(() => {
      cursorFrame = 0;
      const at = cursorAt ? globePoint(cursorAt.x, cursorAt.y) : null;
      for (const cb of cursorListeners) cb(at);
    });
  }, ScreenSpaceEventType.MOUSE_MOVE);
  handler.setInputAction((click: { position: CartesianXY }) => {
    // "Pick on map" (T43): while the note composer is armed, a click is a place, not a selection.
    if (get<NotesState>(NOTES)?.picking) {
      const at = globePoint(click.position.x, click.position.y);
      if (at) setNotePick(at);
      return;
    }
    const id = pickId(click.position.x, click.position.y);
    if (id?.startsWith(MISSION_ID_PREFIX)) {
      const missionId = id.slice(MISSION_ID_PREFIX.length);
      set<MissionsState>(MISSIONS, (prev) => ({ ...MISSIONS.defaults, ...prev, focusedMissionId: missionId, panelOpen: true }));
      return;
    }
    // A marker opens its record in the evidence drawer; empty globe clears the selection.
    const evidenceId = id && parseEvidenceId(id) ? id : null;
    set<SelectionState>(SELECTION, (prev) => ({ ...SELECTION.defaults, ...prev, evidenceId, drawerOpen: evidenceId !== null }));
    // The card opens at the right and may cover the marker (or the marker sat at the circle's edge): once the card
    // is laid out, glide so the clicked place sits inside the visible circle, clear of every card (GE7).
    const at = evidenceId ? globePoint(click.position.x, click.position.y) : null;
    if (at) setTimeout(() => !destroyed && keepInView(at), CARD_SETTLE_MS);
  }, ScreenSpaceEventType.LEFT_CLICK);
  disposers.push(() => {
    cancelAnimationFrame(cursorFrame);
    handler.destroy();
  });

  // ---- API ----------------------------------------------------------------------------------------------
  const api: GlobeApi = {
    flyTo,
    project(lon, lat) {
      if (destroyed) return null;
      const point = Cartesian3.fromDegrees(lon, lat);
      const occluder = new Occluder(new BoundingSphere(Cartesian3.ZERO, scene.globe.ellipsoid.minimumRadius), camera.positionWC);
      if (!occluder.isPointVisible(point)) return null;
      const win = SceneTransforms.worldToWindowCoordinates(scene, point);
      if (!win) return null;
      const { clientWidth, clientHeight } = scene.canvas;
      if (win.x < 0 || win.y < 0 || win.x > clientWidth || win.y > clientHeight) return null;
      return { x: win.x, y: win.y };
    },
    pick,
    onPostRender(cb) {
      return scene.postRender.addEventListener(() => cb());
    },
    requestRender: () => governor.request(),
    onCursor(cb) {
      cursorListeners.add(cb);
      return () => cursorListeners.delete(cb);
    },
    stats: () => layers.map((l) => l.stats()),
    drape({ url, west, south, east, north, alpha }) {
      let removed = false;
      let layer: InstanceType<typeof ImageryLayer> | null = null;
      let blobUrl: string | null = null;
      let currentAlpha = alpha;
      const abort = new AbortController();
      // The picture is fetched here (a few at a time, asked again when the service is slow) and handed to Cesium as a
      // blob, so a busy public service shows up as a short wait, not as a flood of failed tile errors.
      const ready = fetchPicture(url, abort.signal).then(async (blob) => {
        if (!blob || removed || destroyed) return;
        blobUrl = URL.createObjectURL(blob);
        const provider = SingleTileImageryProvider.fromUrl(blobUrl, { rectangle: Rectangle.fromDegrees(west, south, east, north) });
        layer = ImageryLayer.fromProviderAsync(provider, { alpha: currentAlpha });
        scene.imageryLayers.add(layer);
        governor.request();
        await provider.then(() => undefined, () => undefined);
        governor.request();
      });
      return {
        ready,
        setAlpha(a) {
          currentAlpha = a;
          if (removed || !layer) return;
          layer.alpha = a;
          governor.request();
        },
        remove() {
          if (removed) return;
          removed = true;
          abort.abort();
          if (layer && !destroyed) scene.imageryLayers.remove(layer, true);
          if (blobUrl) URL.revokeObjectURL(blobUrl);
          governor.request();
        },
      };
    },
    describe(id) {
      if (destroyed) return null;
      for (const layer of layers) {
        const facts = layer.describe?.(id);
        if (facts) return facts;
      }
      return null;
    },
  };

  // A hidden tab may drop the last drawing buffer; idle mode would not redraw it on return.
  const onVisible = () => {
    if (document.visibilityState === "visible") governor.request();
  };
  document.addEventListener("visibilitychange", onVisible);
  disposers.push(() => document.removeEventListener("visibilitychange", onVisible));

  applyVisibility();
  lastVisible = Object.values(ctx.layers().visible);
  refresh();
  registerGlobe(api);
  governor.request();

  return {
    api,
    diagnostics: () => ({
      governor: governor.diagnostics(),
      requestRenderMode: scene.requestRenderMode,
      frame,
      layers: layers.map((l) => l.stats()),
      imagery: imagery.state(),
      look: look.state(),
      zoom: zoom.diagnostics(),
    }),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      registerGlobe(null);
      for (const off of disposers.splice(0).reverse()) off();
      for (const layer of layers) layer.destroy();
      governor.dispose();
      widget.destroy();
    },
  };
}
