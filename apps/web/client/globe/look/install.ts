/**
 * Looks on the Cesium scene (docs/GODS_EYE.md GC2): one `PostProcessStage` per preset shader, driven by the LOOK
 * key. The map window (SCOPE_ON, SCOPE_SHAPE, SCOPE_SIZE, SCOPE_FEATHER) is no stage: the stage shell draws it once,
 * as the CSS mask over the canvas (client/hud/shell/StageShell.tsx); `state().scope` only reports the keys. Switching preset crossfades over `FADE_MS`: the
 * outgoing stage's `intensity` ramps down as the incoming one ramps up, their sum one on every frame, and a
 * stage is enabled only while its intensity is above zero. Animated presets ask for frames at a low rate while
 * active; `normal` costs nothing and keeps the idle governor idle.
 *
 * The layers never see this module (GC2): it reads the scene, not the layers, and the viewer wires it once.
 */
import { get, subscribe } from "@calvinjs/active-state";
import type { PostProcessStage, Scene } from "cesium";

import { DEBUG_HOOK } from "client/debug";
import { prefersReducedMotion } from "client/motion";
import { featherOf, LOOK, LOOK_IDS, lookOf, SCOPE_FEATHER, SCOPE_ON, SCOPE_SHAPE, SCOPE_SIZE, scopeOnOf, shapeOf, sizeOf, type LookId, type ScopeShape } from "client/state/look";

import { cesium } from "../cesium";
import { LOOK_PRESETS } from "./presets";

/** Crossfade length between presets. */
export const FADE_MS = 500;
/** Frame rate for animated presets at rest (the camera and data still render on their own). */
const ANIMATED_FPS = 12;

export type LookFade = {
  from: LookId;
  to: LookId;
  /** The look change, wall clock ms. */
  requestedAt: number;
  /** When the ramp began: after one warm-up frame with the incoming stage at intensity 0, or null until then. */
  startedAt: number | null;
  endedAt: number | null;
  /** Ticks of the fade. */
  frames: number;
  /** Wall clock of each tick, ms, for the e2e's frame intervals. */
  ticks: number[];
  /** The incoming intensity never fell, the outgoing never rose, and the two never summed above one. */
  monotonic: boolean;
};

export type LookDiagnostics = {
  /** The preset LOOK asks for. */
  target: LookId;
  /** The preset fully on screen, or null mid-fade. */
  shown: LookId | null;
  fading: boolean;
  /** Stage intensity per preset (normal has no stage: 1 when shown, else 0). */
  intensity: Record<LookId, number>;
  /** Presets whose stage rendered at least one frame with no render error so far (normal always). */
  compiled: LookId[];
  /** Render errors seen since install, oldest first. */
  errors: string[];
  /** The fade in progress, else the last one finished. */
  lastFade: LookFade | null;
  scope: { on: boolean; shape: ScopeShape; size: number; feather: number };
  /** Frames are being requested for an animated preset. */
  animating: boolean;
};

export type LookDebug = {
  state(): LookDiagnostics;
  /** Render `frames` synchronously, one after the other, and return each frame's milliseconds, for a median. */
  bench(frames: number): Promise<number[]>;
};

declare global {
  interface Window {
    /** Development and e2e builds: look diagnostics and a frame-time bench (client/globe/look). */
    __look?: LookDebug;
  }
}

export type LookHandle = {
  state(): LookDiagnostics;
  destroy(): void;
};

export type LookOptions = {
  /** One frame from the render governor. */
  requestRender(): void;
  /** Wall clock, ms. */
  now?(): number;
  reducedMotion?(): boolean;
};

const ease = (t: number) => t * t * (3 - 2 * t);

export function installLook(scene: Scene, opts: LookOptions): LookHandle {
  const { PostProcessStage: Stage } = cesium();
  const now = opts.now ?? (() => performance.now());
  const reduced = opts.reducedMotion ?? prefersReducedMotion;
  const t0 = now();
  const disposers: (() => void)[] = [];

  // ---- stages ----------------------------------------------------------------------------------------
  const stages = new Map<LookId, PostProcessStage>();
  const intensity = Object.fromEntries(LOOK_IDS.map((id) => [id, 0])) as Record<LookId, number>;
  for (const preset of LOOK_PRESETS) {
    if (!preset.fragmentShader) continue;
    const stage = new Stage({
      name: `inversa_look_${preset.id}`,
      fragmentShader: preset.fragmentShader,
      uniforms: { intensity: 0, time: () => (now() - t0) / 1000 },
    });
    stage.enabled = false;
    scene.postProcessStages.add(stage);
    stages.set(preset.id, stage);
  }

  const setIntensity = (id: LookId, value: number) => {
    intensity[id] = value;
    const stage = stages.get(id);
    if (!stage) return;
    stage.uniforms.intensity = value;
    stage.enabled = value > 0;
  };

  // ---- compile evidence ------------------------------------------------------------------------------
  const errors: string[] = [];
  const compiled = new Set<LookId>(["normal"]);
  disposers.push(
    scene.renderError.addEventListener((_scene: Scene, err: unknown) => {
      errors.push(err instanceof Error ? err.message : String(err));
    }),
  );
  disposers.push(
    scene.postRender.addEventListener(() => {
      if (errors.length) return;
      for (const [id, stage] of stages) if (stage.enabled && stage.ready) compiled.add(id);
    }),
  );

  // ---- crossfade -------------------------------------------------------------------------------------
  let target: LookId = lookOf(get(LOOK));
  let shown: LookId | null = target;
  let fade: LookFade | null = null;
  let lastFade: LookFade | null = null;
  /** The incoming stage has rendered once since the change (its framebuffer and program exist). */
  let warm = false;
  let raf = 0;
  setIntensity(target, 1);
  disposers.push(
    scene.postRender.addEventListener(() => {
      warm = true;
    }),
  );

  const finishFade = () => {
    if (!fade) return;
    setIntensity(fade.from, 0);
    setIntensity(fade.to, 1);
    fade.endedAt = now();
    shown = fade.to;
    lastFade = fade;
    fade = null;
    cancelAnimationFrame(raf);
    raf = 0;
    opts.requestRender();
  };

  const tick = () => {
    raf = 0;
    if (!fade) return;
    // The first frame with a newly enabled stage pays for its framebuffer and program; the ramp's clock starts
    // after it, so a slow renderer still shows the whole fade rather than a jump.
    if (fade.startedAt === null) {
      if (!warm) {
        opts.requestRender();
        raf = requestAnimationFrame(tick);
        return;
      }
      fade.startedAt = now();
    }
    const t = Math.min(1, (now() - fade.startedAt) / FADE_MS);
    const e = ease(t);
    const prevFrom = intensity[fade.from];
    const prevTo = intensity[fade.to];
    setIntensity(fade.from, 1 - e);
    setIntensity(fade.to, e);
    fade.frames += 1;
    fade.ticks.push(now());
    if (intensity[fade.from] > prevFrom + 1e-6 || intensity[fade.to] < prevTo - 1e-6 || intensity[fade.from] + intensity[fade.to] > 1 + 1e-6) fade.monotonic = false;
    opts.requestRender();
    if (t >= 1) finishFade();
    else raf = requestAnimationFrame(tick);
  };

  const applyLook = () => {
    const next = lookOf(get(LOOK));
    if (next === target) return;
    // A change mid-fade lands the fade in progress first, so at most two stages ever carry intensity.
    finishFade();
    const from = target;
    target = next;
    shown = null;
    fade = { from, to: next, requestedAt: now(), startedAt: null, endedAt: null, frames: 0, ticks: [], monotonic: true };
    if (reduced()) {
      finishFade();
      return;
    }
    // Warm the incoming stage: enabled at intensity 0 it draws the scene unchanged.
    const incoming = stages.get(next);
    warm = incoming === undefined;
    if (incoming) {
      incoming.uniforms.intensity = 0;
      incoming.enabled = true;
    }
    opts.requestRender();
    raf = requestAnimationFrame(tick);
  };

  // ---- animated presets ------------------------------------------------------------------------------
  let ticker: ReturnType<typeof setInterval> | null = null;
  const wantsFrames = () => !reduced() && document.visibilityState === "visible" && LOOK_PRESETS.some((p) => p.animated && intensity[p.id] > 0);
  const syncTicker = () => {
    const want = wantsFrames();
    if (want && ticker === null) ticker = setInterval(() => opts.requestRender(), 1000 / ANIMATED_FPS);
    if (!want && ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  };
  document.addEventListener("visibilitychange", syncTicker);
  disposers.push(() => document.removeEventListener("visibilitychange", syncTicker));
  disposers.push(scene.postRender.addEventListener(syncTicker));

  disposers.push(subscribe(LOOK, applyLook));
  syncTicker();

  const state = (): LookDiagnostics => ({
    target,
    shown,
    fading: fade !== null,
    intensity: { ...intensity },
    compiled: LOOK_IDS.filter((id) => compiled.has(id)),
    errors: [...errors],
    lastFade: fade ? { ...fade, ticks: [...fade.ticks] } : lastFade ? { ...lastFade, ticks: [...lastFade.ticks] } : null,
    scope: { on: scopeOnOf(get(SCOPE_ON)), shape: shapeOf(get(SCOPE_SHAPE)), size: sizeOf(get(SCOPE_SIZE)), feather: featherOf(get(SCOPE_FEATHER)) },
    animating: ticker !== null,
  });

  if (DEBUG_HOOK && typeof window !== "undefined") {
    const debug: LookDebug = {
      state,
      // Synchronous renders, each followed by a one-pixel read that waits for the GPU to finish the frame: the
      // cost of a frame, not the wait for the next vertical sync.
      bench: async (frames) => {
        const gl = scene.canvas.getContext("webgl2");
        const pixel = new Uint8Array(4);
        const times: number[] = [];
        for (let i = 0; i < frames; i++) {
          const t = now();
          scene.requestRender();
          scene.render();
          gl?.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          times.push(now() - t);
        }
        return times;
      },
    };
    window.__look = debug;
    disposers.push(() => {
      if (window.__look === debug) delete window.__look;
    });
  }

  return {
    state,
    destroy() {
      for (const off of disposers.splice(0).reverse()) off();
      cancelAnimationFrame(raf);
      if (ticker !== null) clearInterval(ticker);
      if (!scene.isDestroyed()) {
        for (const stage of stages.values()) scene.postProcessStages.remove(stage);
      }
    },
  };
}
