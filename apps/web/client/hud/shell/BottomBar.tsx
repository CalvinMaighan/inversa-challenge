"use client";

import type { ReactNode } from "react";

import styled from "client/styled";

import LayersBar from "../layers/LayersBar";
import { MOBILE } from "../primitives";
import PlaceSearch from "../search/PlaceSearch";
import { STRIP_HEIGHT_PX } from "../zoom/strip";
import { STAGE_MEDIA } from "./geometry";

/**
 * The bottom-right bar (docs/GODS_EYE.md GC1): at the right, one gutter above the zoom strip. It holds the
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
  /* Bottom right, one gutter above the zoom strip (which sits in the timeline's row, or just above the timeline in a
     narrow HUD). */
  right: max(var(--gap-m), env(safe-area-inset-right));
  bottom: calc(max(var(--gap-m), env(safe-area-inset-bottom)) + ${STRIP_HEIGHT_PX}px + var(--gap-m));
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

  ${STAGE_MEDIA} {
    @container globe (max-width: 559px) {
      bottom: calc(var(--hud-bottom) + ${STRIP_HEIGHT_PX}px + var(--gap-m));
    }
  }

  ${MOBILE} {
    right: 50%;
    transform: translateX(50%);
    bottom: var(--hud-bottom);
  }
`;

export default function BottomBar() {
  return (
    <Bar data-testid="bottom-bar" data-hud-obstacle="">
      {ITEMS}
    </Bar>
  );
}
