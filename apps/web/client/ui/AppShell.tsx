"use client";

import type { ReactNode } from "react";

import styled from "client/styled";

/**
 * The app frame (PRD §12 "Layout"): a full-bleed globe, the HUD over it, and the agent orb in the bottom-right
 * corner. Each slot is a stacking layer; the shell owns placement, the slot content owns everything inside.
 *
 * - `globe`: fills the viewport, receives every pointer event the HUD does not take.
 * - `hud`: fills the viewport above the globe. The layer itself ignores the pointer, so empty HUD space passes
 *   drags through to the globe; direct children take the pointer back.
 * - `orb`: anchored bottom-right inside the safe area, above the HUD.
 */
export type AppShellSlots = {
  globe?: ReactNode;
  hud?: ReactNode;
  orb?: ReactNode;
};

const Main = styled.main`
  position: fixed;
  inset: 0;
  overflow: hidden;
  isolation: isolate;
  background: var(--bg);
  color: var(--text);
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

const OrbLayer = styled.div`
  position: absolute;
  z-index: 20;
  right: max(var(--gap-l), env(safe-area-inset-right));
  bottom: max(var(--gap-l), env(safe-area-inset-bottom));
`;

const Title = styled.h1`
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
`;

export default function AppShell({ globe, hud, orb }: AppShellSlots) {
  return (
    <Main data-shell="">
      <Title>Everglades Ops</Title>
      <GlobeLayer data-slot="globe">{globe}</GlobeLayer>
      <HudLayer data-slot="hud">{hud}</HudLayer>
      <OrbLayer data-slot="orb">{orb}</OrbLayer>
    </Main>
  );
}
