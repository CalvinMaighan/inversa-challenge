"use client";

import styled from "client/styled";

import { beat } from "./timing";

/** Above the HUD, drawer and missions panel, which all live inside the shell's own stacking context. */
export const MORPH_Z = 1000;

/**
 * The morphing surface (deedee `morph.styled.ts` `_panel`). Non-modal and without a backdrop: the globe
 * stays visible and clickable, and a click outside collapses the card.
 */
export const Panel = styled.div<{
  $animating: boolean;
  $fade: boolean;
  $visible: boolean;
  $fadeMs: number;
  $morphMs: number;
}>`
  position: fixed;
  z-index: ${MORPH_Z};
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid color-mix(in oklab, var(--hud-line) 60%, var(--border));
  border-radius: var(--radius-m);
  background: color-mix(in oklab, var(--surface) 90%, transparent);
  backdrop-filter: blur(14px) saturate(1.2);
  -webkit-backdrop-filter: blur(14px) saturate(1.2);
  box-shadow: var(--shadow);
  color: var(--text);
  opacity: ${({ $visible }) => ($visible ? 1 : 0)};
  transition: ${({ $animating, $fade, $fadeMs, $morphMs }) => {
    const parts: string[] = [];
    if ($animating) {
      for (const prop of ["top", "left", "width", "height", "border-radius"]) parts.push(`${prop} ${beat($morphMs)}`);
    }
    if ($fade) parts.push(`opacity ${beat($fadeMs)}`);
    return parts.length ? parts.join(", ") : "none";
  }};

  &[data-sheet] {
    border-bottom: 0;
    border-radius: var(--radius-m) var(--radius-m) 0 0;
    padding-bottom: env(safe-area-inset-bottom);
  }

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

export const Content = styled.div<{ $visible: boolean; $fade: boolean; $fadeMs: number }>`
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  opacity: ${({ $visible }) => ($visible ? 1 : 0)};
  pointer-events: ${({ $visible }) => ($visible ? "auto" : "none")};
  transition: ${({ $fade, $fadeMs }) => ($fade ? `opacity ${beat($fadeMs)}` : "none")};

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;
