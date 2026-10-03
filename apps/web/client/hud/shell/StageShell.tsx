"use client";

import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { get, subscribe } from "@calvinjs/active-state";

import { SHEET_MEDIA, SHEET_PEEK_PX } from "client/agent/layout/geometry";
import { useActiveApp } from "client/hud/appselect/use-active-app";
import { blurOf, featherOf, SCOPE_BLUR, SCOPE_FEATHER, SCOPE_SHAPE, SCOPE_SIZE } from "client/state/look";
import Embers from "client/intro/Embers";
import styled from "client/styled";

import { DEFAULT_FEATHER, featherValue, GUTTER_PX, SCOPE_BLUR_MASK_CSS, SCOPE_MASK_CSS, STAGE_DIAMETER_CSS, STAGE_MEDIA, STAGE_QUERY } from "./geometry";
import { scopeBlurMaskCss, scopeClipCss, scopeMaskCss, scopeWindow } from "./scope";

/**
 * The page frame (docs/GODS_EYE.md GC1). From 768 px up: a black page, the globe in a centred window on the stage,
 * the chat card floating at the left, the HUD over the whole page (the sighting card at the right, the four icon
 * buttons top right, the timeline and the bottom bar). Under 768 px the phone docks of T40: a full-screen globe,
 * the chat as a bottom sheet, the evidence drawer as a bottom sheet.
 *
 * Spacing (GE9): one unit, `--gap-m` (12 px, `GUTTER_PX` in maths), between the viewport edges, the cards, the bars
 * and the buttons.
 *
 * - `side`: the chat card. On the stage layout it is a HUD obstacle inside the globe pane, so camera fits and
 *   label placement keep clear of it; the shell writes its right edge to `--chat-inset`, where the HUD chrome
 *   starts (each control then keeps one gutter from it).
 * - `globe`: fills the pane; on the stage layout its canvas is masked to the map window (shape, size and soft
 *   edge, client/hud/shell/scope.ts): fully visible inside the shape, fading out beyond it. With a hard edge (soft
 *   edge 0) the pointer is clipped there too, so the black margin takes no clicks.
 * - `hud`: fills the pane above the globe, a size container (`globe`) for the HUD's container queries. The
 *   layer lets the pointer through; its direct children take it back.
 *
 * `[data-stage]` marks the window's box (layout only, nothing drawn). It is the app's one scope (GE7, GE11): the
 * Look popover writes SCOPE_SHAPE, SCOPE_SIZE and SCOPE_FEATHER (client/state/look.ts), and the shell follows them
 * (`--scope-mask` and `--scope-clip` draw the window, `--scope-w`, `--scope-h` and `--scope-corner` size
 * `[data-stage]`). There is no on/off: the window is always there. Before hydration the CSS defaults draw the
 * default circle.
 */
export type StageShellSlots = {
  side?: ReactNode;
  globe?: ReactNode;
  hud?: ReactNode;
};

/** First-paint guess of the chat card's right edge (the 420 px default card after its gutter); measured after. */
const CHAT_INSET_GUESS_PX = GUTTER_PX + 420;

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

/** The map window's box: centred on the page. Nothing drawn. */
const Stage = styled.div`
  display: none;

  ${STAGE_MEDIA} {
    display: block;
    position: absolute;
    left: 50%;
    top: 50%;
    width: var(--scope-w, ${STAGE_DIAMETER_CSS});
    height: var(--scope-h, ${STAGE_DIAMETER_CSS});
    transform: translate(-50%, -50%);
    border-radius: var(--scope-corner, 50%);
    pointer-events: none;
  }
`;

/** The window mask and pointer clip on a page-sized element (the canvas, or a layer drawn in canvas pixels). */
const SCOPE_RULES = `
  mask-image: var(--scope-mask, ${SCOPE_MASK_CSS});
  mask-repeat: no-repeat;
  mask-position: 0 0;
  clip-path: var(--scope-clip, none);
`;

const GlobeLayer = styled.div`
  position: absolute;
  inset: 0;
  z-index: 0;

  ${STAGE_MEDIA} {
    /* Transparent, not black: the page behind is black already, and the embers drift on it around the window. */
    & [data-globe] {
      background: transparent;
    }
    [data-shell] & [data-globe] canvas {
      ${SCOPE_RULES}
    }
  }
`;

/**
 * For a layer drawn over the globe in canvas pixels (carp's site buttons, the lionfish overlay): the same window
 * mask and hit area as the canvas, so nothing of the map shows or takes clicks in the black margin.
 */
export const STAGE_SCOPE_CSS = `
  ${STAGE_MEDIA} {
    [data-shell] & {
      ${SCOPE_RULES}
    }
  }
`;

/**
 * The soft edge's progressive blur: a backdrop blur over the globe, masked by the inverse of the window's mask, so the
 * map is exactly as sharp as before inside the window and blurs more and more along the fade, outward. Stage layout
 * only; no blur at all when the soft edge is off (feather 100).
 */
const EdgeBlur = styled.div`
  display: none;

  ${STAGE_MEDIA} {
    display: block;
    position: absolute;
    inset: 0;
    z-index: 1;
    pointer-events: none;
    -webkit-backdrop-filter: blur(var(--scope-blur, 14px));
    backdrop-filter: blur(var(--scope-blur, 14px));
    mask-image: var(--scope-blur-mask, ${SCOPE_BLUR_MASK_CSS});
    mask-repeat: no-repeat;
    mask-position: 0 0;
    -webkit-mask-image: var(--scope-blur-mask, ${SCOPE_BLUR_MASK_CSS});
  }

  @media (prefers-reduced-transparency: reduce) {
    display: none;
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
    top: var(--gap-m);
    bottom: var(--gap-m);
    left: max(var(--gap-m), env(safe-area-inset-left));
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

/** The window's shape, size and soft edge for the shell's size, from the three keys. */
function applyScope(shell: HTMLElement): void {
  const vw = shell.clientWidth;
  const vh = shell.clientHeight;
  if (vw <= 0 || vh <= 0) return;
  const win = scopeWindow(vw, vh, { shape: get(SCOPE_SHAPE), size: get(SCOPE_SIZE), feather: get(SCOPE_FEATHER) });
  shell.dataset.shape = win.shape;
  const style = shell.style;
  style.setProperty("--scope-mask", scopeMaskCss(win, vw, vh));
  style.setProperty("--scope-blur", `${blurOf(get(SCOPE_BLUR))}px`);
  style.setProperty("--scope-blur-mask", scopeBlurMaskCss(win, vw, vh));
  style.setProperty("--scope-clip", scopeClipCss(win));
  style.setProperty("--scope-w", `${win.width}px`);
  style.setProperty("--scope-h", `${win.height}px`);
  style.setProperty("--scope-corner", win.shape === "oval" ? "50%" : `${win.corner}px`);
  // The soft edge as a share of the window's radius: the first-paint circle reads it.
  style.setProperty("--scope-feather", featherValue(featherOf(get(SCOPE_FEATHER)) / 100));
}

export default function StageShell({ side, globe, hud }: StageShellSlots) {
  // The page's heading names the active app (server HTML: the default app).
  const app = useActiveApp();
  const stage = useStageLayout();
  const mainRef = useRef<HTMLElement>(null);
  const sideRef = useRef<HTMLDivElement>(null);
  const hasSide = side !== undefined && side !== null;

  // The window follows the Look keys and the page size (after hydration, so the server HTML never disagrees with
  // the first paint).
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const sync = () => applyScope(main);
    sync();
    const offs = [SCOPE_SHAPE, SCOPE_SIZE, SCOPE_FEATHER, SCOPE_BLUR].map((k) => subscribe(k, sync));
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(sync) : null;
    observer?.observe(main);
    return () => {
      for (const off of offs) off();
      observer?.disconnect();
    };
  }, []);

  // The chat card's right edge, where the HUD chrome starts. It changes when the card is resized.
  useLayoutEffect(() => {
    const main = mainRef.current;
    const slot = sideRef.current;
    if (!main) return;
    if (!stage || !slot || typeof ResizeObserver !== "function") {
      main.style.removeProperty("--chat-inset");
      if (stage && !slot) main.style.setProperty("--chat-inset", "0px");
      return;
    }
    const apply = () => main.style.setProperty("--chat-inset", `${slot.getBoundingClientRect().right}px`);
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
      <Embers />
      <GlobePane data-slot="globe-pane" $sheet={hasSide}>
        <Stage data-stage="" aria-hidden="true" />
        <GlobeLayer data-slot="globe">{globe}</GlobeLayer>
        <EdgeBlur data-slot="edge-blur" aria-hidden="true" />
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
