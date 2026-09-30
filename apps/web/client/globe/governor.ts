/**
 * Idle render governor (after God's Eye View `src/renderGovernor.js`). The scene runs in `requestRenderMode`
 * with `maximumRenderTimeChange = Infinity`, so a parked camera renders nothing (PRD §13: globe idle CPU ~0).
 * Cesium still renders on camera input and tile loads; every other mutation calls `request()` for one frame.
 *
 * Per-frame animators (camera flights, playback) take a hold keyed by owner id. While any hold exists the scene
 * renders continuously; the last release drops back to idle and renders one settling frame. Holds are a set,
 * not a counter, so a double hold or double release cannot wedge the mode.
 */

export type GovernedScene = {
  requestRenderMode: boolean;
  maximumRenderTimeChange: number;
  requestRender(): void;
};

export type GovernorDiagnostics = {
  mode: "continuous" | "idle";
  holds: string[];
  requests: number;
};

export type RenderGovernor = {
  hold(owner: string): void;
  release(owner: string): void;
  /** One frame for a discrete change. Safe after dispose. */
  request(): void;
  diagnostics(): GovernorDiagnostics;
  dispose(): void;
};

export function createRenderGovernor(scene: GovernedScene): RenderGovernor {
  const holds = new Set<string>();
  let live = true;
  let requests = 0;

  scene.maximumRenderTimeChange = Infinity;
  scene.requestRenderMode = true;

  const apply = () => {
    if (!live) return;
    const idle = holds.size === 0;
    if (scene.requestRenderMode === idle) return;
    scene.requestRenderMode = idle;
    // Entering idle: one frame so whatever the last continuous frame changed is on screen.
    if (idle) scene.requestRender();
  };

  return {
    hold(owner) {
      if (!owner) return;
      holds.add(owner);
      apply();
    },
    release(owner) {
      if (!holds.delete(owner)) return;
      apply();
    },
    request() {
      if (!live) return;
      requests += 1;
      scene.requestRender();
    },
    diagnostics() {
      return { mode: holds.size > 0 ? "continuous" : "idle", holds: [...holds].sort(), requests };
    },
    dispose() {
      holds.clear();
      live = false;
    },
  };
}
