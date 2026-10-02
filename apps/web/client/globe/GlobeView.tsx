"use client";

import { useEffect, useRef } from "react";
import { get } from "@calvinjs/active-state";

import { setDebugGlobe } from "client/debug";
import { TIME, type TimeState } from "client/state/time";
import styled from "client/styled";
import { getFrameGrid, publishFrameGrid, publishFrameSightings } from "client/threads/api";

import { CESIUM_BASE_URL, loadCesium } from "./cesium";
import { onCreditSlot } from "./credit-slot";
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
 * Attribution stays on screen (Esri, OSM, Google and ion require it). It shows in the chat card's header row
 * (GE9, `client/globe/credit-slot.ts`); this corner of the globe is its home only on a page without the chat card:
 * small, bottom-left.
 */
const CreditsHome = styled.div`
  position: absolute;
  z-index: 1;
  left: max(6px, env(safe-area-inset-left));
  bottom: calc(4px + env(safe-area-inset-bottom));
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

/**
 * Cesium writes credit markup (providers' logos, on-screen text) into the credit row and the lightbox. Two fixes after
 * each write: a provider's logo from another origin (Google's, served by assets.ion.cesium.com with CORS) is fetched
 * in CORS mode, or the page's cross-origin isolation (COEP require-corp) blocks it and the required logo shows as a
 * broken image; and the on-screen text, cut with an ellipsis in the one-line row, keeps its full words as a tooltip.
 */
function tidyCredits(...roots: HTMLElement[]): void {
  for (const root of roots) {
    for (const img of root.querySelectorAll<HTMLImageElement>("img:not([crossorigin])")) {
      if (new URL(img.src, location.href).origin !== location.origin) img.crossOrigin = "anonymous";
    }
    for (const el of root.querySelectorAll<HTMLElement>(".cesium-credit-textContainer *")) {
      if (el.children.length === 0 && /upgrade for commercial use/i.test(el.textContent ?? "")) {
        el.style.display = "none";
        const next = el.nextElementSibling;
        if (next?.classList.contains("cesium-credit-delimiter")) (next as HTMLElement).style.display = "none";
      }
    }
    for (const link of root.querySelectorAll<HTMLElement>(".cesium-credit-expand-link")) {
      link.title = "Data attribution";
      link.setAttribute("aria-label", "Data attribution");
    }
    const text = root.querySelector<HTMLElement>(".cesium-credit-textContainer");
    if (text) {
      // An emptied container (only the hidden upgrade notice) would still take a flex gap: drop it.
      text.style.display = "";
      if (!text.innerText.trim()) text.style.display = "none";
      const words = text.textContent?.replace(/\s+/g, " ").trim() ?? "";
      if (text.title !== words) text.title = words;
    }
  }
}

/** Client-only Cesium mount; `Globe` (index.tsx) loads it with `ssr: false`. */
export default function GlobeView({ onMount }: GlobeViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const home = useRef<HTMLDivElement>(null);
  const onMountRef = useRef(onMount);

  useEffect(() => {
    onMountRef.current = onMount;
  }, [onMount]);

  useEffect(() => {
    const hostEl = host.current;
    const homeEl = home.current;
    if (!hostEl || !homeEl) return;
    let cancelled = false;
    let handle: GlobeHandle | null = null;
    // The credit container is Cesium's, not React's: it moves between the chat card's header and this home.
    const creditsEl = document.createElement("div");
    creditsEl.dataset.globeCredits = "";
    const offSlot = onCreditSlot((slot) => (slot ?? homeEl).appendChild(creditsEl));
    // The "Data attribution" lightbox opens over the whole page, above the cards and bars (it would sit under the
    // HUD inside the globe pane), and lets the pointer through while it is closed.
    const lightboxEl = document.createElement("div");
    lightboxEl.dataset.globeCreditsLightbox = "";
    Object.assign(lightboxEl.style, { position: "fixed", inset: "0", zIndex: "1000", pointerEvents: "none" });
    document.body.appendChild(lightboxEl);
    const tidy = new MutationObserver(() => tidyCredits(creditsEl, lightboxEl));
    for (const el of [creditsEl, lightboxEl]) tidy.observe(el, { subtree: true, childList: true, characterData: true });

    loadCesium()
      .then(() => {
        if (cancelled) return;
        handle = mountGlobe(hostEl, creditsEl, lightboxEl);
        // Cesium's overlay (hidden until opened) takes the pointer back from its pass-through host.
        for (const child of lightboxEl.children) (child as HTMLElement).style.pointerEvents = "auto";
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
      offSlot();
      creditsEl.remove();
      tidy.disconnect();
      lightboxEl.remove();
    };
  }, []);

  return (
    <Frame data-globe="">
      <link rel="stylesheet" href={`${CESIUM_BASE_URL}/Widgets/CesiumWidget/CesiumWidget.css`} precedence="default" />
      <Host ref={host} />
      <CreditsHome ref={home} data-globe-credits-home="" />
    </Frame>
  );
}
