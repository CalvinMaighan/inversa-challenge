"use client";

import styled from "client/styled";

import { SHEET_MEDIA, SHEET_PEEK_PX } from "./layout/geometry";

/**
 * The chat column (T40): a full-height column left of the globe on desktop, a bottom sheet over the globe on
 * phones. Width comes from `--column-w`; the sheet's height and transition are inline styles.
 */
export const Column = styled.aside`
  position: relative;
  display: flex;
  flex-direction: column;
  width: var(--column-w, 420px);
  height: 100%;
  min-height: 0;
  background: var(--surface);
  border-right: 1px solid var(--border);
  color: var(--text);
  font-family: var(--font-ui);

  ${SHEET_MEDIA} {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    width: auto;
    /* First paint (server HTML, before the snap height is set inline): the collapsed bar, composer showing. */
    height: ${SHEET_PEEK_PX}px;
    justify-content: flex-end;
    padding-bottom: env(safe-area-inset-bottom);
    border-right: 0;
    border-top: 1px solid var(--border);
    border-radius: var(--radius-l) var(--radius-l) 0 0;
    box-shadow: var(--shadow);
    overflow: hidden;
  }
`;

export const Tabs = styled.div`
  display: flex;
  align-items: stretch;
  gap: 2px;
  padding: 6px var(--gap-s) 0;
  border-bottom: 1px solid var(--border);
`;

export const Tab = styled.button`
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px var(--gap-m) 9px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--muted);
  font: 600 var(--font-xs) / 1 var(--font-mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  cursor: pointer;

  &:hover,
  &:focus-visible {
    color: var(--text);
  }

  &[aria-selected="true"] {
    border-bottom-color: var(--accent);
    color: var(--text);
  }
`;

/** New activity on a tab that is not showing. */
export const UnreadDot = styled.span`
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in oklab, var(--accent) 25%, transparent);
`;

export const TabPanel = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;

  &[hidden] {
    display: none;
  }
`;

/** Missions content scrolls inside the tab. */
export const MissionsScroll = styled.div`
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--gap-m);
  scrollbar-width: thin;
`;

/** Drag strip on the column's right edge (ARIA window splitter). */
export const ResizeHandle = styled.div`
  position: absolute;
  z-index: 2;
  top: 0;
  right: -4px;
  bottom: 0;
  width: 8px;
  cursor: col-resize;
  touch-action: none;

  &::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 3px;
    width: 2px;
    background: transparent;
    transition: background 120ms ease;
  }

  &:hover::after,
  &:focus-visible::after,
  &[data-dragging]::after {
    background: var(--accent);
  }

  /* The accent line alone is 2 px: keyboard focus also gets the standard ring, drawn inside the strip. */
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
`;

/** Phone sheet grab handle: drag to resize, tap (or Enter) to cycle collapsed, half and full. */
export const SheetHandle = styled.button`
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 100%;
  height: 18px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: grab;
  touch-action: none;

  &::before {
    content: "";
    width: 40px;
    height: 4px;
    border-radius: 2px;
    background: var(--border);
  }

  &:focus-visible::before {
    background: var(--accent);
  }
`;
