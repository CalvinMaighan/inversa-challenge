"use client";

import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

import styled from "client/styled";

import { Icon, IconButton, MOBILE, Surface } from "./primitives";

type Side = "left" | "right";

/**
 * Edge panel: a column along the left or right edge between the top bar and the timeline on desktop, a bottom
 * sheet on phones (PRD §12). The HUD root sets `--hud-top` and `--hud-bottom` so panels never cover the bars.
 *
 * On the stage layout (docs/GODS_EYE.md GC1, from 768 px) the HUD starts right of the chat card, so a left panel
 * (carp's "Locations to review", the lionfish survey) opens at the left of the globe, next to the chat card, at the
 * bottom just above the timeline.
 */
const Frame = styled(Surface)<{ $side: Side; $width: number; $maxHeight?: number }>`
  position: absolute;
  /* One gutter below the top row and one above the timeline (both measured by the HUD, GE9). */
  top: var(--hud-top);
  bottom: var(--hud-bottom);
  ${(p) => (p.$maxHeight ? `bottom: auto; height: min(${p.$maxHeight}px, calc(100cqh - var(--hud-top) - var(--hud-bottom)));` : "")}
  /* A left panel sits at the bottom, just above the timeline, and stops under the top row. */
  ${(p) => (p.$side === "left" ? "top: auto; bottom: var(--hud-bottom); height: auto; max-height: calc(100cqh - var(--hud-top) - var(--hud-bottom));" : "")}
  ${(p) => p.$side}: max(var(--gap-m), env(safe-area-inset-${(p) => p.$side}));
  width: min(${(p) => p.$width}px, calc(100cqw - 2 * var(--gap-m)));
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-m);
  overflow: hidden;
  z-index: 3;

  &:focus-visible {
    outline-offset: -2px;
  }

  ${MOBILE} {
    top: auto;
    left: 0;
    right: 0;
    bottom: 0;
    width: auto;
    height: auto;
    max-height: 62dvh;
    border-radius: var(--radius-l) var(--radius-l) 0 0;
    padding-bottom: env(safe-area-inset-bottom);
    z-index: 6;
  }
`;

const Header = styled.header`
  display: flex;
  align-items: center;
  gap: var(--gap-s);
  padding: var(--gap-s) var(--gap-s) var(--gap-s) var(--gap-m);
  border-bottom: 1px solid var(--border);
  min-height: 44px;

  ${MOBILE} {
    position: relative;
    padding-top: 14px;
    &::before {
      content: "";
      position: absolute;
      top: 5px;
      left: 50%;
      width: 36px;
      height: 4px;
      transform: translateX(-50%);
      border-radius: 2px;
      background: var(--border);
    }
  }
`;

const Title = styled.h2`
  flex: 1;
  min-width: 0;
  margin: 0;
  font: 600 var(--font-xs) / 1.2 var(--font-mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Body = styled.div`
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: var(--gap-m);

  /* The orb keeps its corner over the sheet: the last rows scroll clear of it. */
  ${MOBILE} {
    padding-bottom: calc(var(--gap-m) + 96px);
  }
`;

/** Collapsed panel: a tab on the panel's edge (desktop), or a pill above the timeline (phone). */
const Tab = styled(Surface.withComponent("button"))<{ $side: Side }>`
  position: absolute;
  /* A left tab (carp's Sites) sits at the bottom, just above the timeline, like its panel. */
  ${(p) => (p.$side === "left" ? "bottom: var(--hud-bottom);" : "top: var(--hud-top);")}
  ${(p) => p.$side}: 0;
  display: flex;
  align-items: center;
  gap: var(--gap-xs);
  padding: var(--gap-m) 6px;
  border-radius: ${(p) => (p.$side === "left" ? "0 var(--radius-s) var(--radius-s) 0" : "var(--radius-s) 0 0 var(--radius-s)")};
  ${(p) => `border-${p.$side}: none;`}
  writing-mode: vertical-rl;
  font: 600 11px / 1 var(--font-mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  cursor: pointer;
  z-index: 3;
  svg {
    width: 12px;
    height: 12px;
    transform: ${(p) => (p.$side === "left" ? "none" : "rotate(180deg)")};
  }

  ${MOBILE} {
    top: auto;
    bottom: var(--hud-bottom);
    ${(p) => p.$side}: var(--gap-m);
    writing-mode: horizontal-tb;
    padding: 8px 12px;
    border-radius: var(--radius-round);
    ${(p) => `border-${p.$side}: 1px solid var(--border);`}
    svg {
      transform: rotate(-90deg);
    }
  }
`;

export type PanelProps = {
  side: Side;
  title: ReactNode;
  open: boolean;
  onClose: () => void;
  /** Collapsed panels show a tab that calls this; omit for panels that simply disappear (the drawer). */
  onOpen?: () => void;
  tabLabel?: string;
  width?: number;
  /** Desktop: stop at this height (px) instead of reaching the timeline, leaving the map below it in view. */
  maxHeight?: number;
  actions?: ReactNode;
  children: ReactNode;
  "data-testid"?: string;
};

/** A text field keeps its focus when a panel opens next to it (voice or the agent may open the drawer while typing). */
const isTextEntry = (el: Element) => el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["button", "range", "checkbox", "radio"].includes(el.type)) || (el as HTMLElement).isContentEditable;

/**
 * Focus follows the panel: opening it from a control (a citation, a bracket label, its tab) moves focus into
 * it, so the keyboard and screen readers land on what just appeared; closing it hands focus back to whatever
 * opened it, or to the panel's tab. Nothing is taken from an idle page (a share link or voice opening the
 * drawer) or from a text field, and the first render never moves focus.
 */
function usePanelFocus(open: boolean) {
  const frameRef = useRef<HTMLDivElement>(null);
  const tabRef = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  /** The collapsed tab was pressed: it unmounts before the effect runs, so focus is on <body> by then. */
  const fromTabRef = useRef(false);
  const wasOpen = useRef(open);
  useLayoutEffect(() => {
    if (open === wasOpen.current) return;
    wasOpen.current = open;
    const active = document.activeElement;
    const idle = !active || active === document.body;
    if (open) {
      const frame = frameRef.current;
      const byTab = fromTabRef.current;
      fromTabRef.current = false;
      if (!frame || (idle && !byTab) || (!idle && (frame.contains(active) || isTextEntry(active)))) return;
      returnTo.current = idle ? null : (active as HTMLElement);
      frame.focus({ preventScroll: true });
      return;
    }
    // Focus was inside the panel, which is gone now: hand it back.
    const back = returnTo.current;
    returnTo.current = null;
    if (!idle) return;
    (back?.isConnected ? back : tabRef.current)?.focus({ preventScroll: true });
  }, [open]);
  return { frameRef, tabRef, fromTabRef };
}

export default function Panel({ side, title, open, onClose, onOpen, tabLabel, width = 360, maxHeight, actions, children, ...rest }: PanelProps) {
  const { frameRef, tabRef, fromTabRef } = usePanelFocus(open);
  if (!open) {
    return onOpen ? (
      <Tab
        ref={tabRef}
        $side={side}
        type="button"
        data-hud-obstacle=""
        onClick={() => {
          fromTabRef.current = true;
          onOpen();
        }}
        aria-expanded={false}
        data-testid={rest["data-testid"] && `${rest["data-testid"]}-tab`}
      >
        <Icon name="chevron" />
        {tabLabel}
      </Tab>
    ) : null;
  }
  return (
    <Frame
      as="section"
      ref={frameRef}
      tabIndex={-1}
      data-hud-obstacle=""
      $side={side}
      $width={width}
      $maxHeight={maxHeight}
      data-height-capped={maxHeight ? "" : undefined}
      aria-label={typeof title === "string" ? title : tabLabel}
      data-testid={rest["data-testid"]}
      // Esc closes the panel the keyboard is in, and only that one (the agent card has its own Esc).
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <Header>
        <Title>{title}</Title>
        {actions}
        <IconButton type="button" onClick={onClose} aria-label="Close panel" aria-expanded={true}>
          <Icon name="close" />
        </IconButton>
      </Header>
      <Body>{children}</Body>
    </Frame>
  );
}
