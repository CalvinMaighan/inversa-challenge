"use client";

import type { ReactNode } from "react";

import { SHEET_MEDIA, SHEET_PEEK_PX } from "client/agent/layout/geometry";
import styled from "client/styled";

/**
 * The app frame (PRD §12 "Layout", T40): the chat column on the left, the globe pane filling the rest. The
 * shell owns placement; the slot content owns everything inside.
 *
 * - `side`: the chat column, full height, always open. Its own width (the column resizes itself). Under
 *   768 px it is a bottom sheet over the globe, and the globe pane stops above its collapsed bar.
 * - `globe`: fills the globe pane and receives every pointer event the HUD does not take.
 * - `hud`: fills the globe pane above the globe (top bar, legend, timeline, drawer). The layer ignores the
 *   pointer, so empty HUD space passes drags through to the globe; direct children take the pointer back.
 *
 * The globe pane is a size container (`globe`), so HUD pieces can adapt to the pane rather than the window.
 */
export type AppShellSlots = {
  side?: ReactNode;
  globe?: ReactNode;
  hud?: ReactNode;
};

const Main = styled.main`
  position: fixed;
  inset: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  overflow: hidden;
  isolation: isolate;
  background: var(--bg);
  color: var(--text);

  ${SHEET_MEDIA} {
    display: block;
  }
`;

const SideSlot = styled.div`
  position: relative;
  z-index: 20;
  display: flex;
  min-height: 0;
  height: 100%;

  ${SHEET_MEDIA} {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    height: auto;
    z-index: 30;
  }
`;

const GlobePane = styled.div<{ $sheet: boolean }>`
  position: relative;
  grid-column: 2;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  isolation: isolate;
  container: globe / size;

  ${SHEET_MEDIA} {
    position: absolute;
    inset: 0 0 ${({ $sheet }) => ($sheet ? `calc(${SHEET_PEEK_PX}px + env(safe-area-inset-bottom))` : "0")} 0;
  }
`;

const GlobeLayer = styled.div`
  position: absolute;
  inset: 0;
  z-index: 0;
`;

const HudLayer = styled.div`
  position: absolute;
  inset: 0;
  z-index: 10;
  pointer-events: none;

  & > * {
    pointer-events: auto;
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

export default function AppShell({ side, globe, hud }: AppShellSlots) {
  const hasSide = side !== undefined && side !== null;
  return (
    <Main data-shell="">
      <Title>Everglades Ops</Title>
      {hasSide ? <SideSlot data-slot="side">{side}</SideSlot> : null}
      <GlobePane data-slot="globe-pane" $sheet={hasSide} style={hasSide ? undefined : { gridColumn: "1 / -1" }}>
        <GlobeLayer data-slot="globe">{globe}</GlobeLayer>
        <HudLayer data-slot="hud">{hud}</HudLayer>
      </GlobePane>
    </Main>
  );
}
