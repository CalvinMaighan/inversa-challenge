"use client";

import type { ReactNode } from "react";

import styled from "client/styled";

import LayersBar from "../layers/LayersBar";
import PlaceSearch from "../search/PlaceSearch";

/**
 * The bottom-centre bar (docs/GODS_EYE.md GC1): centred under the stage, one gutter above the timeline. It holds the
 * map's search and layer controls, each a leaf's own component that brings its own button and popover:
 *
 *   Place search, GE6: client/hud/search
 *   Layers (sightings, notes, ships, water and weather), GE7: client/hud/layers
 *
 * Look moved to the top-right icon cluster (GE9, client/hud/topbar). Each leaf appends its one entry to `ITEMS` and
 * nothing else. The bar draws no surface of its own, so with no entries it shows nothing. Popovers opened from it
 * open upwards, one gutter above it. Spacing is the `--gap-m` unit: between the items, and to the timeline
 * (`--hud-bottom` is the timeline's top plus a gutter, measured by the timeline).
 */
const ITEMS: readonly ReactNode[] = [
  // GE6: place search (client/hud/search).
  <PlaceSearch key="search" />,
  // GE7: the Layers popover (ships, water and weather).
  <LayersBar key="layers" />,
];

const Bar = styled.div`
  position: absolute;
  z-index: 5;
  left: 50%;
  bottom: var(--hud-bottom);
  /* Centred under the stage, but never under the chat card (about 1100 px and narrower, where the card reaches
     close to the centre): its left edge stays a gutter right of --chat-inset (GE7). */
  transform: translateX(max(-50%, calc(var(--chat-inset, 0px) + var(--gap-m) - 50vw)));
  display: flex;
  align-items: center;
  gap: var(--gap-m);
  pointer-events: none;

  & > * {
    pointer-events: auto;
  }

  &:empty {
    display: none;
  }
`;

export default function BottomBar() {
  return (
    <Bar data-testid="bottom-bar" data-hud-obstacle="">
      {ITEMS}
    </Bar>
  );
}
