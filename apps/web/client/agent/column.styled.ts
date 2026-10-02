"use client";

import styled from "client/styled";

import { CARD_MAX_WIDTH_CSS } from "client/hud/shell/geometry";

import { SHEET_MEDIA, SHEET_PEEK_PX } from "./layout/geometry";

/**
 * The chat card (T40, GODS_EYE GC1): a full-height card floating at the left of the black page on desktop, never
 * reaching the stage centre; a bottom sheet over the globe on phones. Width comes from `--column-w`; the sheet's
 * height and transition are inline styles.
 */
export const Column = styled.aside`
  position: relative;
  display: flex;
  flex-direction: column;
  width: var(--column-w, 420px);
  max-width: ${CARD_MAX_WIDTH_CSS};
  height: 100%;
  min-height: 0;
  background: color-mix(in oklch, var(--surface) 82%, transparent);
  backdrop-filter: blur(10px) saturate(1.2);
  -webkit-backdrop-filter: blur(10px) saturate(1.2);
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  box-shadow: var(--shadow);
  color: var(--text);
  font-family: var(--font-ui);
  container: chatcard / inline-size;

  ${SHEET_MEDIA} {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    width: auto;
    max-width: none;
    border: 0;
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

/**
 * The card's header row: the AGENT and NOTES tabs at the left, the globe's data attribution at the right on the same
 * baseline (GE9, `client/globe/credit-slot.ts`), one line, never wrapping.
 */
export const Header = styled.div`
  display: flex;
  align-items: baseline;
  gap: var(--gap-s);
  min-width: 0;
  padding: 6px var(--gap-m) 0 var(--gap-s);
  border-bottom: 1px solid var(--border);
`;

export const Tabs = styled.div`
  display: flex;
  flex: none;
  align-items: stretch;
  gap: 2px;
`;

/**
 * Where the globe's attribution shows: Cesium's credit container (the ion logo, any on-screen credits such as
 * Google's, and the "Data attribution" link that opens the full list) on one line, right-aligned. On a narrow card
 * the ion logo collapses to its mark and the link stays; on-screen credit text ellipsizes before anything wraps.
 */
export const CreditSlot = styled.div`
  display: flex;
  flex: 1 1 auto;
  justify-content: flex-end;
  min-width: 0;
  overflow: hidden;
  /* Room inside the clip for the links' focus rings (2 px offset, 2 px wide), taken back by the margin. */
  padding: 4px;
  margin: -4px;
  white-space: nowrap;
  color: var(--muted);
  font: 400 10px / 14px var(--font-ui);

  & [data-globe-credits],
  & [data-globe-credits] > div {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--gap-m);
    min-width: 0;
  }
  /* Cesium's own credit box sits absolutely at the bottom-left of the globe, in white with a shadow: here it is a
     plain row in the card's colours. */
  & .cesium-widget-credits {
    position: static;
    padding: 0;
    color: inherit;
    font: inherit;
    text-shadow: none;
  }
  & a {
    color: inherit;
  }
  & img {
    max-height: 14px;
  }
  & .cesium-credit-logoContainer {
    display: flex;
    flex: none;
    align-items: center;
    gap: 4px;
  }
  & .cesium-credit-logoContainer img {
    display: block;
  }
  /* On-screen credits (Google's logo and data providers with Google 3D): one line, cut with an ellipsis at the card's
     edge (the full text is the element's title); the logo first, never cut. */
  & .cesium-credit-textContainer {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  & .cesium-credit-textContainer > * {
    display: inline;
  }
  & .cesium-credit-textContainer img {
    display: inline;
    vertical-align: middle !important;
  }
  & .cesium-credit-delimiter {
    padding: 0 3px;
  }
  /* The ion logo is its mark only, the same size as the map icon. */
  & .cesium-credit-logoContainer img {
    width: 18px;
    height: 18px;
    max-height: 18px;
    object-fit: cover;
    object-position: left center;
  }
  /* "Data attribution" is a map icon button: the text is hidden, the icon is a mask in the text colour. */
  & .cesium-credit-expand-link {
    flex: none;
    order: -1;
    width: 18px;
    height: 18px;
    overflow: hidden;
    font-size: 0;
    text-decoration: none;
    cursor: pointer;
  }
  & .cesium-credit-expand-link::before {
    content: "";
    display: block;
    width: 18px;
    height: 18px;
    background: currentcolor;
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='m15 19l-6-2.11V5l6 2.11M20.5 3h-.16L15 5.1L9 3L3.36 4.9c-.21.07-.36.25-.36.48V20.5a.5.5 0 0 0 .5.5c.05 0 .11 0 .16-.03L9 18.9l6 2.1l5.64-1.9c.21-.1.36-.25.36-.48V3.5a.5.5 0 0 0-.5-.5'/%3E%3C/svg%3E") center / contain no-repeat;
  }
  & .cesium-credit-expand-link:hover,
  & .cesium-credit-expand-link:focus-visible {
    color: var(--text);
  }

  /* Phone dock: the top right of the dock, beside the grab handle, whatever the sheet's height. */
  ${SHEET_MEDIA} {
    position: absolute;
    z-index: 1;
    top: 0;
    right: calc(var(--gap-m) - 4px);
    margin: 0;
    max-width: calc(50% - 32px);
  }
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
