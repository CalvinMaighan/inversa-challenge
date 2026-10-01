"use client";

import { useEffect, useRef } from "react";
import { get } from "@calvinjs/active-state";

import { setDebugGlobe } from "client/debug";
import { TIME, type TimeState } from "client/state/time";
import styled from "client/styled";
import { getFrameGrid, publishFrameGrid, publishFrameSightings } from "client/threads/api";

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
 * Attribution stays on screen (Esri, OSM, Google and ion require it) but small, bottom-left.
 * The HUD can lift it above the timeline with `--globe-credits-bottom`.
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
        setDebugGlobe(handle);
        onMountRef.current?.(handle);
      })
      .catch((err: unknown) => {
        console.error("[globe] Cesium failed to load", err);
        hostEl.dataset.error = err instanceof Error ? err.message : String(err);
      });

    // Fixture frames for the dev scratch routes (or `?fixture`) in development builds. Never on the ops page by
    // default: there the db worker's real grid is the only source, and fake frames would flash before it lands.
    const fixture = new URLSearchParams(window.location.search).get("fixture");
    const wantsFixture = fixture !== null || window.location.pathname.startsWith("/dev/");
    if (process.env.NODE_ENV !== "production" && wantsFixture && !getFrameGrid() && typeof SharedArrayBuffer !== "undefined") {
      void import("./dev-fixture").then(async ({ loadDevFrames }) => {
        const to = Date.parse((get<TimeState>(TIME) ?? TIME.defaults).to);
        const force = fixture === "sample";
        const { grid, meta, sightings, source, note } = await loadDevFrames({ toMs: to, force });
        if (cancelled || getFrameGrid()) return;
        publishFrameSightings(sightings);
        publishFrameGrid(grid, meta);
        console.info(`[globe] dev frames: ${source}, ${meta.frameCount} × ${meta.stepMinutes} min (${note})`);
      });
    }

    return () => {
      cancelled = true;
      if (handle) {
        setDebugGlobe(null);
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
