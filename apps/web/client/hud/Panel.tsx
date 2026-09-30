"use client";

import type { KeyboardEvent, ReactNode } from "react";

import styled from "client/styled";

import { Icon, IconButton, MOBILE, Surface } from "./primitives";

type Side = "left" | "right";

/**
 * Edge panel: a column along the left or right edge between the top bar and the timeline on desktop, a bottom
 * sheet on phones (PRD §12). The HUD root sets `--hud-top` and `--hud-bottom` so panels never cover the bars.
 */
const Frame = styled(Surface)<{ $side: Side; $width: number }>`
  position: absolute;
  top: var(--hud-top);
  bottom: var(--hud-bottom);
  ${(p) => p.$side}: max(var(--gap-m), env(safe-area-inset-${(p) => p.$side}));
  width: min(${(p) => p.$width}px, calc(100vw - 2 * var(--gap-m)));
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-m);
  overflow: hidden;
  z-index: 3;

  ${MOBILE} {
    top: auto;
    left: 0;
    right: 0;
    bottom: 0;
    width: auto;
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
      margin-left: -18px;
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
`;

/** Collapsed panel: a tab on the panel's edge (desktop), or a pill above the timeline (phone). */
const Tab = styled(Surface.withComponent("button"))<{ $side: Side }>`
  position: absolute;
  top: calc(var(--hud-top) + var(--gap-s));
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
    bottom: calc(var(--hud-bottom) + var(--gap-s));
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
  actions?: ReactNode;
  children: ReactNode;
  "data-testid"?: string;
};

export default function Panel({ side, title, open, onClose, onOpen, tabLabel, width = 360, actions, children, ...rest }: PanelProps) {
  if (!open) {
    return onOpen ? (
      <Tab $side={side} type="button" data-hud-obstacle="" onClick={onOpen} aria-expanded={false} data-testid={rest["data-testid"] && `${rest["data-testid"]}-tab`}>
        <Icon name="chevron" />
        {tabLabel}
      </Tab>
    ) : null;
  }
  return (
    <Frame
      as="section"
      data-hud-obstacle=""
      $side={side}
      $width={width}
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
