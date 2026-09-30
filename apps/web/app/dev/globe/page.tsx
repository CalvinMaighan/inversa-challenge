"use client";

import { set } from "@calvinjs/active-state";
import { useActiveState } from "@calvinjs/active-state/react";

import Globe from "client/globe";
import type { GlobeHandle } from "client/globe/viewer";
import { LAYERS, setLayerVisible, type LayersState } from "client/state/layers";
import { TIME, TIME_STEP_MINUTES, type TimeState } from "client/state/time";
import { VIEW, type ViewState } from "client/state/view";
import { LAYER_IDS } from "shared/voice/ui-tools";

declare global {
  interface Window {
    /** Scratch-route hook for e2e and manual gates: layer stats, governor mode, imagery rung. */
    __globe?: GlobeHandle | null;
  }
}

const expose = (handle: GlobeHandle | null) => {
  window.__globe = handle;
};

const STEP_MS = TIME_STEP_MINUTES * 60_000;
/** The dev fixture covers the last day; the scrubber spans it. */
const SCRUB_FRAMES = 96;

/** Scratch route: the globe alone, full screen, with layer toggles and a one-day scrubber for the T17 gates. */
export default function DevGlobePage() {
  const layers = useActiveState<LayersState>(LAYERS)[0] ?? LAYERS.defaults;
  const time = useActiveState<TimeState>(TIME)[0] ?? TIME.defaults;
  const view = useActiveState<ViewState>(VIEW)[0] ?? VIEW.defaults;
  const to = Date.parse(time.to);
  const back = Math.round((to - Date.parse(time.at)) / STEP_MS);

  return (
    <main style={{ position: "fixed", inset: 0 }}>
      <Globe onMount={expose} />
      <form
        style={{ position: "absolute", top: 8, left: 8, zIndex: 2, padding: 8, borderRadius: 8, background: "rgb(0 0 0 / 60%)", color: "#fff", font: "12px/1.6 ui-monospace, monospace" }}
        onSubmit={(e) => e.preventDefault()}
      >
        {LAYER_IDS.map((id) => (
          <label key={id} style={{ display: "block" }}>
            <input type="checkbox" checked={layers.visible[id] !== false} onChange={(e) => setLayerVisible(id, e.target.checked)} /> {id}
          </label>
        ))}
        <label style={{ display: "block", marginTop: 6 }}>
          <input
            type="range"
            min={0}
            max={SCRUB_FRAMES - 1}
            value={SCRUB_FRAMES - 1 - back}
            onChange={(e) =>
              set<TimeState>(TIME, (prev) => ({
                ...TIME.defaults,
                ...prev,
                at: new Date(to - (SCRUB_FRAMES - 1 - Number(e.target.value)) * STEP_MS).toISOString(),
              }))
            }
          />
          <br />
          {time.at.slice(0, 16)}Z
        </label>
        <div data-view="">
          view {view.lat.toFixed(3)}, {view.lon.toFixed(3)} @ {Math.round(view.altitudeM)} m, seq {view.seq}
        </div>
        <button
          type="button"
          onClick={() => set<ViewState>(VIEW, (prev) => ({ ...VIEW.defaults, ...prev, lon: -81.78, lat: 24.56, altitudeM: 20_000, place: "Key West", seq: (prev?.seq ?? 0) + 1 }))}
        >
          fly Key West
        </button>
      </form>
    </main>
  );
}
