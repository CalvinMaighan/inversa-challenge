"use client";

import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

import { SHEET_MEDIA, SHEET_PEEK_PX } from "client/agent/layout/geometry";
import { useActiveApp } from "client/hud/appselect/use-active-app";
import styled from "client/styled";

import { DEFAULT_FEATHER, featherValue, GUTTER_PX, SCOPE_CLIP_CSS, SCOPE_MASK_CSS, STAGE_DIAMETER_CSS, STAGE_MEDIA, STAGE_QUERY } from "./geometry";

/**
 * The page frame (docs/GODS_EYE.md GC1). From 768 px up: a black page, the globe in a centred circular stage,
 * the chat card floating at the left, the HUD over the whole page (the sighting card at the right, the three
 * icon buttons top right, the timeline and the bottom bar). Under 768 px the phone docks of T40: a full-screen
 * globe, the chat as a bottom sheet, the evidence drawer as a bottom sheet.
 *
 * - `side`: the chat card. On the stage layout it is a HUD obstacle inside the globe pane, so camera fits and
 *   label placement keep clear of it; the shell writes its right edge plus a gutter to `--chat-inset`, which
 *   the HUD chrome and the globe attribution start from.
 * - `globe`: fills the pane; on the stage layout its canvas is masked to the circle (feathered edge,
 *   `--scope-feather`) and clipped there for the pointer, so the black margin takes no clicks.
 * - `hud`: fills the pane above the globe, a size container (`globe`) for the HUD's container queries. The
 *   layer lets the pointer through; its direct children take it back.
 *
 * `[data-stage]` marks the circle (layout only, nothing drawn). `setStageScope` turns the circle off or sets its
 * feather (the Look control, GE2).
 */
export type StageShellSlots = {
  side?: ReactNode;
  globe?: ReactNode;
  hud?: ReactNode;
};

/** First-paint guess of the chat card's right edge plus a gutter (the 420 px default card); measured after. */
const CHAT_INSET_GUESS_PX = GUTTER_PX + 420 + GUTTER_PX;

const Main = styled.main`
  position: fixed;
  inset: 0;
  overflow: hidden;
  isolation: isolate;
  background: var(--bg);
  color: var(--text);
  --chat-inset: 0px;
  --scope-feather: ${DEFAULT_FEATHER};

  ${STAGE_MEDIA} {
    background: #000;
    --chat-inset: ${CHAT_INSET_GUESS_PX}px;
  }
`;

const GlobePane = styled.div<{ $sheet: boolean }>`
  position: absolute;
  inset: 0;
  overflow: hidden;
  isolation: isolate;

  ${SHEET_MEDIA} {
    inset: 0 0 ${({ $sheet }) => ($sheet ? `calc(${SHEET_PEEK_PX}px + env(safe-area-inset-bottom))` : "0")} 0;
  }
`;

/** The circle the globe shows through: centred on the page, as large as the cards allow. Nothing drawn. */
const Stage = styled.div`
  display: none;

  ${STAGE_MEDIA} {
    display: block;
    position: absolute;
    left: 50%;
    top: 50%;
    width: ${STAGE_DIAMETER_CSS};
    height: ${STAGE_DIAMETER_CSS};
    transform: translate(-50%, -50%);
    border-radius: 50%;
    pointer-events: none;
  }
`;

const GlobeLayer = styled.div`
  position: absolute;
  inset: 0;
  z-index: 0;

  ${STAGE_MEDIA} {
    & [data-globe] {
      background: #000;
    }
    /* The attribution stays readable on the black page, right of the chat card. */
    & [data-globe-credits] {
      left: calc(var(--chat-inset) + 6px);
    }
    [data-shell]:not([data-scope="off"]) & [data-globe] canvas {
      mask-image: ${SCOPE_MASK_CSS};
      clip-path: ${SCOPE_CLIP_CSS};
    }
  }
`;

const HudLayer = styled.div`
  position: absolute;
  inset: 0;
  z-index: 10;
  pointer-events: none;
  container: globe / size;

  & > * {
    pointer-events: auto;
  }
`;

const SideSlot = styled.div`
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 30;
  display: flex;

  ${STAGE_MEDIA} {
    position: absolute;
    top: ${GUTTER_PX}px;
    bottom: ${GUTTER_PX}px;
    left: max(${GUTTER_PX}px, env(safe-area-inset-left));
    right: auto;
    z-index: 20;
  }
`;

const Title = styled.h1`
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
`;

const subscribeStage = (cb: () => void) => {
  const mq = window.matchMedia(STAGE_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

/** Stage layout (true) or the phone docks; false on the server, where the CSS decides the first paint. */
export function useStageLayout(): boolean {
  return useSyncExternalStore(subscribeStage, () => window.matchMedia(STAGE_QUERY).matches, () => false);
}

/** The Look control's hook into the stage (GE2): the circle on or off, and its feather (0..1). */
export function setStageScope(scope: { on: boolean; feather?: number }): void {
  const shell = typeof document === "undefined" ? null : document.querySelector<HTMLElement>("[data-shell]");
  if (!shell) return;
  if (scope.on) delete shell.dataset.scope;
  else shell.dataset.scope = "off";
  if (scope.feather !== undefined) shell.style.setProperty("--scope-feather", featherValue(scope.feather));
}

export default function StageShell({ side, globe, hud }: StageShellSlots) {
  // The page's heading names the active app (server HTML: the default app).
  const app = useActiveApp();
  const stage = useStageLayout();
  const mainRef = useRef<HTMLElement>(null);
  const sideRef = useRef<HTMLDivElement>(null);
  const hasSide = side !== undefined && side !== null;

  // The chat card's right edge, for the HUD chrome and the attribution. It changes when the card is resized.
  useLayoutEffect(() => {
    const main = mainRef.current;
    const slot = sideRef.current;
    if (!main) return;
    if (!stage || !slot || typeof ResizeObserver !== "function") {
      main.style.removeProperty("--chat-inset");
      if (stage && !slot) main.style.setProperty("--chat-inset", "0px");
      return;
    }
    const apply = () => main.style.setProperty("--chat-inset", `${Math.ceil(slot.getBoundingClientRect().right + GUTTER_PX)}px`);
    const observer = new ResizeObserver(apply);
    observer.observe(slot);
    apply();
    return () => {
      observer.disconnect();
      main.style.removeProperty("--chat-inset");
    };
  }, [stage, hasSide]);

  return (
    <Main ref={mainRef} data-shell="" data-layout={stage ? "stage" : "dock"}>
      <Title>{app.name}</Title>
      <GlobePane data-slot="globe-pane" $sheet={hasSide}>
        <Stage data-stage="" aria-hidden="true" />
        <GlobeLayer data-slot="globe">{globe}</GlobeLayer>
        <HudLayer data-slot="hud">{hud}</HudLayer>
        {hasSide ? (
          <SideSlot ref={sideRef} data-slot="side" data-hud-obstacle={stage ? "" : undefined}>
            {side}
          </SideSlot>
        ) : null}
      </GlobePane>
    </Main>
  );
}
