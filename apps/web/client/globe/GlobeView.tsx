"use client";

import { useEffect, useRef } from "react";
import { get } from "@calvinjs/active-state";

import { TIME, TIME_STEP_MINUTES, type TimeState } from "client/state/time";
import styled from "client/styled";
import { getFrameGrid, publishFrameGrid } from "client/threads/api";

import { publishFrameTimeline } from "./api";
import { CESIUM_BASE_URL, loadCesium } from "./cesium";
import { mountGlobe, type GlobeHandle } from "./viewer";

export type GlobeViewProps = {
  /** Called with the mounted handle (diagnostics for dev and e2e pages), and with null on unmount. */
  onMount?: (handle: GlobeHandle | null) => void;
};

const Frame = styled.div`
  position: absolute;
  inset: 0;
  background: #07090d;
`;

const Host = styled.div`
  position: absolute;
  inset: 0;

  & canvas {
    display: block;
    outline: none;
  }
`;

/**
 * Attribution stays on screen (Esri, OSM, Google and ion require it) but small, bottom-left, clear of the orb
 * corner. The HUD can lift it above the timeline with `--globe-credits-bottom`.
 */
const Credits = styled.div`
  position: absolute;
  z-index: 1;
  left: max(6px, env(safe-area-inset-left));
  bottom: calc(var(--globe-credits-bottom, 4px) + env(safe-area-inset-bottom));
  max-width: min(60vw, 520px);
  font: 10px/1.3 var(--font-sans, sans-serif);
  color: rgb(255 255 255 / 72%);
  text-shadow: 0 0 2px rgb(0 0 0 / 90%);
  pointer-events: auto;

  & a {
    color: inherit;
  }
  & img {
    max-height: 14px;
    vertical-align: middle;
  }
  & .cesium-credit-expand-link {
    white-space: nowrap;
    text-decoration: underline;
    cursor: pointer;
  }
  & .cesium-credit-logoContainer {
    white-space: nowrap;
  }
`;

/** Client-only Cesium mount; `Globe` (index.tsx) loads it with `ssr: false`. */
export default function GlobeView({ onMount }: GlobeViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const credits = useRef<HTMLDivElement>(null);
  const onMountRef = useRef(onMount);

  useEffect(() => {
    onMountRef.current = onMount;
  }, [onMount]);

  useEffect(() => {
    const hostEl = host.current;
    const creditsEl = credits.current;
    if (!hostEl || !creditsEl) return;
    let cancelled = false;
    let handle: GlobeHandle | null = null;

    loadCesium()
      .then(() => {
        if (cancelled) return;
        handle = mountGlobe(hostEl, creditsEl);
        onMountRef.current?.(handle);
      })
      .catch((err: unknown) => {
        console.error("[globe] Cesium failed to load", err);
        hostEl.dataset.error = err instanceof Error ? err.message : String(err);
      });

    // Until the db worker (T19) publishes frames, development builds show fixture frames.
    if (process.env.NODE_ENV !== "production" && !getFrameGrid() && typeof SharedArrayBuffer !== "undefined") {
      void import("./dev-fixture").then(async ({ loadDevFrames }) => {
        const to = Date.parse((get<TimeState>(TIME) ?? TIME.defaults).to);
        const force = new URLSearchParams(window.location.search).get("fixture") === "sample";
        const { grid, timeline, source, note } = await loadDevFrames({ toMs: to, stepMs: TIME_STEP_MINUTES * 60_000, force });
        if (cancelled || getFrameGrid()) return;
        publishFrameTimeline(timeline);
        publishFrameGrid(grid);
        console.info(`[globe] dev frames: ${source}, ${timeline.frameCount} frames (${note})`);
      });
    }

    return () => {
      cancelled = true;
      if (handle) {
        onMountRef.current?.(null);
        handle.destroy();
      }
    };
  }, []);

  return (
    <Frame data-globe="">
      <link rel="stylesheet" href={`${CESIUM_BASE_URL}/Widgets/CesiumWidget/CesiumWidget.css`} precedence="default" />
      <Host ref={host} />
      <Credits ref={credits} data-globe-credits="" />
    </Frame>
  );
}
